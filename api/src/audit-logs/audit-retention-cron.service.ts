import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { S3Service } from '../storage/s3.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { LicenseService } from '../licensing/license.service';
import { AuditLogService } from './audit-log.service';
import { toJsonLine } from './audit-export';
import { getAuditSyslogQueue } from './audit-syslog-queue';

const TICK_MS = 6 * 60 * 60 * 1000; // 6 h
const BATCH = 5_000;

/**
 * Travaux quotidiens du journal d'audit, dans l'ordre :
 *  1. **Ancre d'intégrité** : hash chaîné des entrées de J-1, écrit comme
 *     entrée `audit.anchor` (et forwardé au SIEM) — utilise la colonne
 *     `prevHash` réservée en Phase 8. Détecte l'altération directe en base.
 *  2. **Archivage froid** (opt-in `audit.archive.enabled`) : les entrées plus
 *     vieilles que la rétention sont exportées en JSONL gzip vers Garage
 *     AVANT suppression. Échec d'archivage ⇒ purge SAUTÉE (fail-safe : on ne
 *     détruit jamais du non-archivé).
 *  3. **Purge de rétention** — le SEUL chemin de suppression (append-only).
 *
 * Pattern NotificationsCronService : cron natif setInterval + lock Redis
 * (une exécution par jour, cluster-wide — ce qui rend l'ancre single-writer)
 * + énumération des bases tenant en mode pooled.
 */
@Injectable()
export class AuditRetentionCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AuditRetentionCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly s3: S3Service,
    private readonly audit: AuditLogService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
    private readonly licenses: LicenseService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // Premier passage 5 min après le boot (laisse le rolling update converger).
    setTimeout(() => void this.tick(), 5 * 60_000).unref();
    this.log.log('Audit retention cron armé (interval 6h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposé pour test manuel. `force` saute le lock (debug uniquement). */
  async tick(force = false): Promise<void> {
    if (!force) {
      const queue = getAuditSyslogQueue();
      const client = await queue.client;
      // Une exécution par jour suffit (TTL 23 h → slot libéré le lendemain).
      const lockKey = `vaks:audit-purge:${new Date().toISOString().slice(0, 10)}`;
      const ok = await (client as unknown as {
        set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
      }).set(lockKey, '1', 'EX', 82_800, 'NX');
      if (ok !== 'OK') return;
    }

    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.runForCurrentDb(slug));
        } catch (err) {
          this.log.warn(`audit cron tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    // Base courante dans tous les cas (dedicated : la seule ; pooled : la base
    // de base héberge aussi des orgs — control-plane / legacy).
    await this.runForCurrentDb(null);
  }

  private async runForCurrentDb(slug: string | null): Promise<void> {
    const tag = slug ? ` tenant=${slug}` : '';
    try {
      const orgs = await this.prisma.organization.findMany({ select: { id: true } });
      for (const org of orgs) {
        await this.writeDailyAnchor(org.id, tag);
        await this.archiveAndPurge(org.id, tag);
      }
    } catch (err) {
      // Table absente (P2021, rollout en cours) ou base injoignable : on passe.
      this.log.warn(`audit cron${tag} skipped: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // Ancre d'intégrité quotidienne
  // ============================================================

  /** Bornes UTC du jour J-1. */
  private static yesterdayUtc(): { date: string; from: Date; to: Date } {
    const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const from = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    return { date: from.toISOString().slice(0, 10), from, to: todayStart };
  }

  /**
   * Hash incrémental des entrées de J-1 (ordre createdAt,id), chaîné sur
   * l'ancre précédente, écrit via `logCritical` (→ persistance + forward
   * syslog : l'empreinte SORT du serveur, hors de portée d'un attaquant DB).
   * Recalculable à la demande par `computeDayHash` (endpoint /verify).
   */
  private async writeDailyAnchor(orgId: string, tag: string): Promise<void> {
    try {
      // Ancre d'intégrité = feature premium `audit-advanced`. Sans licence, pas
      // d'ancre écrite (l'endpoint /verify est lui aussi gaté).
      if (!(await this.licenses.hasFeature('audit-advanced'))) return;
      const { date, from, to } = AuditRetentionCronService.yesterdayUtc();
      // Anti-doublon : une ancre par jour et par org.
      const existing = await this.prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          action: 'audit.anchor',
          createdAt: { gte: to },
        },
        select: { id: true },
      });
      if (existing) return;

      const { dayHash, count } = await this.computeDayHash(orgId, from, to);
      const prev = await this.prisma.auditLog.findFirst({
        where: { organizationId: orgId, action: 'audit.anchor' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { prevHash: true },
      });
      const anchor = createHash('sha256')
        .update((prev?.prevHash ?? 'genesis') + dayHash)
        .digest('hex');

      await this.audit.logCritical({
        organizationId: orgId,
        action: 'audit.anchor',
        actorType: 'SYSTEM',
        resourceType: 'auditLog',
        resourceLabel: `ancre ${date}`,
        prevHash: anchor,
        detail: { date, count, dayHash, anchor },
      });
      this.log.log(`anchor${tag} org=${orgId} ${date}: ${count} entrée(s), ${anchor.slice(0, 12)}…`);
    } catch (err) {
      this.log.warn(`anchor${tag} org=${orgId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Empreinte du jour : SHA-256 incrémental sur les champs immuables des
   * entrées (hors ancres elles-mêmes), lots keyset. Partagé cron / verify.
   */
  async computeDayHash(
    orgId: string,
    from: Date,
    to: Date,
  ): Promise<{ dayHash: string; count: number }> {
    const h = createHash('sha256');
    let count = 0;
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const rows: Array<{
        id: string;
        createdAt: Date;
        action: string;
        actorId: string | null;
        outcome: string;
        resourceId: string | null;
      }> = await this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          action: { not: 'audit.anchor' },
          createdAt: { gte: from, lt: to },
          ...(cursor
            ? {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
        select: {
          id: true,
          createdAt: true,
          action: true,
          actorId: true,
          outcome: true,
          resourceId: true,
        },
      });
      for (const r of rows) {
        h.update(
          `${r.id}|${r.createdAt.toISOString()}|${r.action}|${r.actorId ?? ''}|${r.outcome}|${r.resourceId ?? ''}\n`,
        );
        count++;
      }
      if (rows.length < BATCH) break;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return { dayHash: h.digest('hex'), count };
  }

  // ============================================================
  // Archivage froid + purge
  // ============================================================

  private async archiveAndPurge(orgId: string, tag: string): Promise<void> {
    const days = await this.settings.getAuditRetentionDays(orgId);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // 1. Archive opt-in AVANT purge. Échec ⇒ on saute la purge de cette org.
    //    Archivage froid = feature premium `audit-advanced` : sans licence on
    //    saute l'archive et on procède directement à la purge (core).
    const all = await this.settings.getAll(orgId);
    if (all['audit.archive.enabled'] === true && (await this.licenses.hasFeature('audit-advanced'))) {
      try {
        const archived = await this.archiveBefore(orgId, cutoff);
        if (archived > 0) {
          this.log.log(`archive${tag} org=${orgId}: ${archived} entrée(s) → Garage`);
        }
      } catch (err) {
        this.log.warn(
          `archive${tag} org=${orgId} FAILED — purge sautée (fail-safe): ${(err as Error).message}`,
        );
        return;
      }
    }

    // 2. Purge par lots (raw SQL : deleteMany n'a pas de LIMIT).
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRawUnsafe(
        `DELETE FROM "AuditLog" WHERE id IN (
           SELECT id FROM "AuditLog"
           WHERE "organizationId" = $1 AND "createdAt" < $2
           LIMIT ${BATCH})`,
        orgId,
        cutoff,
      );
      total += n;
      if (n < BATCH) break;
      await new Promise((r) => setTimeout(r, 250)); // souffle entre les lots
    }
    if (total > 0) {
      this.log.log(`purge${tag} org=${orgId}: ${total} entrée(s) > ${days}j supprimée(s)`);
    }
  }

  /** Exporte en JSONL gzip vers Garage tout ce qui va être purgé. */
  private async archiveBefore(orgId: string, cutoff: Date): Promise<number> {
    const lines: string[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      // Annotation explicite : l'inférence boucle sinon (rows → last → cursor → where → rows).
      const rows: Array<Parameters<typeof toJsonLine>[0] & { createdAt: Date; id: string }> =
        await this.prisma.auditLog.findMany({
        where: {
          organizationId: orgId,
          createdAt: { lt: cutoff },
          ...(cursor
            ? {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 1_000,
      });
      for (const r of rows) lines.push(toJsonLine(r));
      if (rows.length < 1_000) break;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    if (lines.length === 0) return 0;
    const gz = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
    const key = `${orgId}/${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
    await this.s3.putObject(this.s3.buckets.auditArchive, key, gz, 'application/gzip');
    return lines.length;
  }

  /** Slugs des tenants (mode pooled) : énumère les bases `<db>_<slug>`. */
  private async tenantSlugs(): Promise<string[]> {
    const base = process.env.DATABASE_URL;
    if (!base) return [];
    let dbName: string;
    try {
      dbName = new URL(base).pathname.replace(/^\//, '') || 'vakspm';
    } catch {
      return [];
    }
    const rows = await this.prisma.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${dbName}\\_%'`,
    );
    return rows.map((r) => r.datname.slice(dbName.length + 1)).filter(Boolean);
  }
}
