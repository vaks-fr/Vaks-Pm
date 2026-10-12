import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { sanitizeDetail, truncate } from './audit-sanitize';
import {
  AuditSyslogConfig,
  AuditSyslogEntry,
  getAuditSyslogQueue,
} from './audit-syslog-queue';

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AuditOutcome = 'SUCCESS' | 'FAILURE';
export type AuditActorType = 'USER' | 'API_TOKEN' | 'AGENT' | 'SYSTEM' | 'ANONYMOUS';

export interface AuditListFilters {
  from?: string;
  to?: string;
  action?: string;
  actorId?: string;
  actorType?: AuditActorType;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
  resourceType?: string;
  resourceId?: string;
  q?: string;
}

export interface AuditEntryInput {
  organizationId: string;
  action: string;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
  actorType?: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabel?: string | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: unknown;
  /** Réservé à l'ancre d'intégrité quotidienne (cron) — null partout ailleurs. */
  prevHash?: string | null;
}

/** Ligne prête à insérer (id/createdAt fixés au moment du fait, pas du flush). */
interface AuditRow {
  id: string;
  organizationId: string;
  createdAt: Date;
  action: string;
  severity: AuditSeverity;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  route: string | null;
  method: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  detail?: unknown;
  prevHash: string | null;
}

interface BufferedEntry {
  /** Client de la base cible, capturé au moment du log() (le flush tourne
   *  hors contexte requête — en pooled, tenantCtx serait vide). */
  client: PrismaClient;
  slug: string | null;
  row: AuditRow;
}

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_THRESHOLD = 50;
const BUFFER_CAP = 5_000;
const SETTINGS_CACHE_MS = 60_000;
const SEVERITY_RANK: Record<AuditSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/**
 * Journal d'audit append-only (Phase 8).
 *
 * Deux chemins d'écriture :
 *  - `log()`       : bufferisé en mémoire, flush par `createMany` toutes les
 *                    2 s ou dès 50 entrées. Perte max ~2 s sur kill brutal.
 *  - `logCritical()`: écrit immédiatement (login, tokens, RBAC, settings…).
 *
 * Invariant absolu : l'audit ne casse JAMAIS l'opération métier — tout échec
 * d'écriture est loggé puis avalé. Pendant un rollout pooled où la table
 * n'existe pas encore sur une base tenant (P2021), on droppe en loggant une
 * seule fois par base.
 */
@Injectable()
export class AuditLogService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AuditLogService.name);
  private buffer: BufferedEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private droppedSinceLastReport = 0;
  private lastDropReport = 0;
  private readonly missingTableWarned = new Set<string>();
  private readonly syslogCache = new Map<
    string,
    { at: number; config: (AuditSyslogConfig & { minSeverity: AuditSeverity }) | null }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  // ============================================================
  // Enrichissement par requête (diff old→new posé par les services)
  // ============================================================

  /** Scope ALS posé par l'interceptor autour du handler HTTP. */
  private readonly reqScope = new AsyncLocalStorage<{ extra: Record<string, unknown> | null }>();

  /** (interceptor) Exécute le handler dans un scope d'enrichissement. */
  runWithRequestScope<T>(fn: () => T): T {
    return this.reqScope.run({ extra: null }, fn);
  }

  /**
   * (services métier) Attache un complément lisible — typiquement le diff
   * `auditDiff(before, after, fields)` — à l'entrée d'audit que l'interceptor
   * écrira pour la requête HTTP en cours. No-op hors requête (cron, WS).
   */
  enrichRequest(extra: Record<string, unknown>): void {
    const s = this.reqScope.getStore();
    if (s) s.extra = { ...(s.extra ?? {}), ...extra };
  }

  /** (interceptor) Récupère l'enrichissement déposé pendant le handler. */
  consumeRequestEnrichment(): Record<string, unknown> | null {
    return this.reqScope.getStore()?.extra ?? null;
  }

  /**
   * Entrée bufferisée (mutations courantes, INFO ; aussi les lectures
   * forensic `read.*` capturées via `audit.logReads`).
   *
   * Garde-fou d'intégrité sous pression : le buffer est PARTAGÉ entre
   * écritures et lectures — un flood de `read.*` (mode `all`) ne doit jamais
   * faire perdre une entrée d'écriture/conformité. Au plafond, une entrée de
   * LECTURE est droppée en priorité ; une entrée d'ÉCRITURE évince plutôt la
   * plus ancienne lecture bufferisée (et ne drope elle-même qu'en dernier
   * recours, si aucune lecture n'est évinçable).
   */
  log(input: AuditEntryInput): void {
    try {
      const entry = this.capture(input);
      const isReadEntry = entry.row.action.startsWith('read.');
      if (this.buffer.length >= BUFFER_CAP) {
        if (isReadEntry) {
          this.noteDrop();
          return;
        }
        const evictIdx = this.buffer.findIndex((e) => e.row.action.startsWith('read.'));
        if (evictIdx === -1) {
          // Aucune lecture à sacrifier : le buffer est saturé d'écritures
          // légitimes, on ne peut plus rien faire de mieux qu'avertir.
          this.noteDrop();
          return;
        }
        this.buffer.splice(evictIdx, 1);
      }
      this.buffer.push(entry);
      if (this.buffer.length >= FLUSH_THRESHOLD) void this.flush();
    } catch (err) {
      this.logger.error(`audit log() failed: ${(err as Error).message}`);
    }
  }

  /** Warn throttlé (1/min) sur les entrées perdues par saturation du buffer. */
  private noteDrop(): void {
    this.droppedSinceLastReport++;
    const now = Date.now();
    if (now - this.lastDropReport > 60_000) {
      this.logger.warn(`Audit buffer overflow: ${this.droppedSinceLastReport} entry(ies) dropped`);
      this.droppedSinceLastReport = 0;
      this.lastDropReport = now;
    }
  }

  /**
   * Écriture immédiate (non bufferisée) avec la sévérité fournie (défaut INFO).
   * À utiliser quand l'entrée doit être en base sans attendre le flush — p.ex.
   * un `auth.login.failure` relu aussitôt par la détection brute-force. Ne throw
   * jamais.
   */
  async logNow(input: AuditEntryInput): Promise<void> {
    try {
      const entry = this.capture(input);
      await this.persist(entry.client, entry.slug, [entry.row]);
    } catch (err) {
      this.logger.error(`audit logNow() failed: ${(err as Error).message}`);
    }
  }

  /** Écriture immédiate en CRITICAL (événements de sécurité). Ne throw jamais. */
  async logCritical(input: AuditEntryInput): Promise<void> {
    return this.logNow({ severity: 'CRITICAL', ...input });
  }

  /** Capture le client/slug du tenant courant + normalise la ligne. */
  private capture(input: AuditEntryInput): BufferedEntry {
    const client = this.tenantCtx.current() ?? (this.prisma as unknown as PrismaClient);
    const slug = this.tenantCtx.currentSlug();
    const row: AuditRow = {
      id: randomUUID(),
      organizationId: input.organizationId,
      createdAt: new Date(),
      action: input.action,
      severity: input.severity ?? 'INFO',
      outcome: input.outcome ?? 'SUCCESS',
      actorType: input.actorType ?? 'USER',
      actorId: input.actorId ?? null,
      actorLabel: truncate(input.actorLabel, 200) ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      resourceLabel: truncate(input.resourceLabel, 200) ?? null,
      route: truncate(input.route, 300) ?? null,
      method: input.method ?? null,
      statusCode: input.statusCode ?? null,
      ip: truncate(input.ip, 64) ?? null,
      userAgent: truncate(input.userAgent, 500) ?? null,
      detail: sanitizeDetail(input.detail),
      prevHash: input.prevHash ?? null,
    };
    return { client, slug, row };
  }

  /** Vide le buffer : un createMany par client cible. */
  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const byClient = new Map<PrismaClient, { slug: string | null; rows: AuditRow[] }>();
      for (const e of batch) {
        const g = byClient.get(e.client) ?? { slug: e.slug, rows: [] };
        g.rows.push(e.row);
        byClient.set(e.client, g);
      }
      for (const [client, g] of byClient) {
        await this.persist(client, g.slug, g.rows);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Insert + forward syslog. Avale toutes les erreurs (P2021 loggé une fois). */
  private async persist(client: PrismaClient, slug: string | null, rows: AuditRow[]): Promise<void> {
    try {
      await client.auditLog.createMany({
        data: rows.map((r) => ({ ...r, detail: (r.detail ?? undefined) as never })),
        skipDuplicates: true,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2021') {
        const key = slug ?? '__base__';
        if (!this.missingTableWarned.has(key)) {
          this.missingTableWarned.add(key);
          this.logger.warn(
            `Table AuditLog absente sur la base "${key}" — entrées droppées (db push à faire sur ce tenant)`,
          );
        }
      } else {
        this.logger.error(`audit persist failed (${rows.length} rows): ${(err as Error).message}`);
      }
      return; // pas de forward syslog si rien n'a été persisté
    }
    await this.forwardToSyslog(client, slug, rows);
  }

  /** Enqueue un job batch vers le worker si le SIEM est activé pour l'org. */
  private async forwardToSyslog(client: PrismaClient, slug: string | null, rows: AuditRow[]): Promise<void> {
    try {
      const byOrg = new Map<string, AuditRow[]>();
      for (const r of rows) {
        let arr = byOrg.get(r.organizationId);
        if (!arr) byOrg.set(r.organizationId, (arr = []));
        arr.push(r);
      }
      for (const [orgId, orgRows] of byOrg) {
        const cfg = await this.getSyslogConfig(client, slug, orgId);
        if (!cfg) continue;
        const min = SEVERITY_RANK[cfg.minSeverity];
        const entries = orgRows
          .filter((r) => SEVERITY_RANK[r.severity] >= min)
          .map((r): AuditSyslogEntry => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            action: r.action,
            severity: r.severity,
            outcome: r.outcome,
            actorType: r.actorType,
            actorId: r.actorId,
            actorLabel: r.actorLabel,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            resourceLabel: r.resourceLabel,
            route: r.route,
            method: r.method,
            statusCode: r.statusCode,
            ip: r.ip,
            detail: r.detail,
          }));
        if (!entries.length) continue;
        const { minSeverity: _min, ...config } = cfg;
        await getAuditSyslogQueue().add('forward', {
          organizationId: orgId,
          tenantSlug: slug,
          config,
          entries,
        });
      }
    } catch (err) {
      // Redis down ne doit pas impacter le chemin d'écriture DB (déjà fait).
      this.logger.error(`audit syslog enqueue failed: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // Lecture / export (admin)
  // ============================================================

  /** Filtres de listing (tous optionnels, cumulables). */
  buildWhere(orgId: string, q: AuditListFilters): Record<string, unknown> {
    const where: Record<string, unknown> = { organizationId: orgId };
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (q.action) where.action = { startsWith: q.action };
    if (q.actorId) where.actorId = q.actorId;
    if (q.actorType) where.actorType = q.actorType;
    if (q.severity) where.severity = q.severity;
    if (q.outcome) where.outcome = q.outcome;
    if (q.resourceType) where.resourceType = q.resourceType;
    if (q.resourceId) where.resourceId = q.resourceId;
    if (q.q) {
      where.OR = [
        { action: { contains: q.q, mode: 'insensitive' } },
        { actorLabel: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /**
   * Listing paginé **keyset** (cursor = `<createdAtMs>|<id>`, ordre
   * createdAt desc, id desc). Pas d'offset : la table est volumineuse.
   */
  async list(orgId: string, q: AuditListFilters & { cursor?: string; pageSize?: number }) {
    // Jusqu'à 1000 par lot pour l'export streamé ; l'API publique du listing
    // borne elle-même à 100 côté controller.
    const pageSize = Math.min(1_000, Math.max(1, q.pageSize ?? 50));
    const where = this.buildWhere(orgId, q);
    const cursor = this.decodeCursor(q.cursor);
    if (cursor) {
      const and: unknown[] = [
        {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        },
      ];
      // Cumule avec un éventuel filtre createdAt (from/to) sans le perdre.
      if (where.createdAt) and.push({ createdAt: where.createdAt });
      delete where.createdAt;
      where.AND = and;
    }
    const rows = await this.prisma.auditLog.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
    });
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? `${last.createdAt.getTime()}|${last.id}` : null,
    };
  }

  private decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    const [ms, id] = cursor.split('|');
    const t = Number(ms);
    if (!Number.isFinite(t) || !id) return null;
    return { createdAt: new Date(t), id };
  }

  /** Job de test du bouton admin (connecte + envoie un message audit.test). */
  async enqueueSyslogTest(orgId: string): Promise<void> {
    const client = this.tenantCtx.current() ?? (this.prisma as unknown as PrismaClient);
    const slug = this.tenantCtx.currentSlug();
    this.syslogCache.delete(`${slug ?? ''}:${orgId}`); // tester la conf fraîche
    const cfg = await this.getSyslogConfig(client, slug, orgId, /*ignoreEnabled*/ true);
    if (!cfg) throw new Error('Configuration syslog incomplète (host requis)');
    const { minSeverity: _min, ...config } = cfg;
    await getAuditSyslogQueue().add('test', {
      organizationId: orgId,
      tenantSlug: slug,
      config,
      test: true,
      entries: [],
    });
  }

  /**
   * Conf syslog de l'org (clés OrgSetting `audit.syslog.*`), cachée 60 s.
   * Retourne null si désactivé ou host manquant. `ignoreEnabled` = bouton test
   * (on veut pouvoir tester avant d'activer).
   */
  private async getSyslogConfig(
    client: PrismaClient,
    slug: string | null,
    orgId: string,
    ignoreEnabled = false,
  ): Promise<(AuditSyslogConfig & { minSeverity: AuditSeverity }) | null> {
    const cacheKey = `${slug ?? ''}:${orgId}`;
    const cached = this.syslogCache.get(cacheKey);
    if (!ignoreEnabled && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) {
      return cached.config;
    }
    const rows = await client.orgSetting.findMany({
      where: { organizationId: orgId, key: { startsWith: 'audit.syslog.' } },
    });
    const s: Record<string, unknown> = {};
    for (const r of rows) s[r.key] = r.value as unknown;
    const enabled = s['audit.syslog.enabled'] === true || s['audit.syslog.enabled'] === 'true';
    const host = typeof s['audit.syslog.host'] === 'string' ? (s['audit.syslog.host'] as string).trim() : '';
    let config: (AuditSyslogConfig & { minSeverity: AuditSeverity }) | null = null;
    if ((enabled || ignoreEnabled) && host) {
      const port = Number(s['audit.syslog.port']) || 6514;
      const protocol = s['audit.syslog.protocol'] === 'tcp' ? 'tcp' : 'tls';
      const minSeverity = (['INFO', 'WARNING', 'CRITICAL'] as const).includes(
        s['audit.syslog.minSeverity'] as AuditSeverity,
      )
        ? (s['audit.syslog.minSeverity'] as AuditSeverity)
        : 'INFO';
      config = {
        host,
        port,
        protocol,
        caPem: typeof s['audit.syslog.caPem'] === 'string' && (s['audit.syslog.caPem'] as string).trim()
          ? (s['audit.syslog.caPem'] as string)
          : undefined,
        clientCertPem:
          typeof s['audit.syslog.clientCertPem'] === 'string' &&
          (s['audit.syslog.clientCertPem'] as string).trim()
            ? (s['audit.syslog.clientCertPem'] as string)
            : undefined,
        rejectUnauthorized: s['audit.syslog.rejectUnauthorized'] !== false,
        appName:
          typeof s['audit.syslog.appName'] === 'string' && (s['audit.syslog.appName'] as string).trim()
            ? (s['audit.syslog.appName'] as string).trim()
            : 'vaks-pm',
        minSeverity,
      };
    }
    // Le cache ne mémorise que l'état "réel" (enabled) — pas le mode test.
    if (!ignoreEnabled || enabled) this.syslogCache.set(cacheKey, { at: Date.now(), config: enabled && host ? config : null });
    return config;
  }
}
