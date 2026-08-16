import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';

const TICK_MS = 5 * 60 * 1000; // 5 min
/** Garde-fou : on ne traite qu'un lot par tick (un incident massif ne doit pas
 *  monopoliser la boucle d'événements ; le tick suivant reprend le reste). */
const BATCH = 500;

/**
 * Balayage des baux d'EXÉCUTION expirés (lot A §1) — pendant du sweeper de
 * validation, côté travail.
 *
 * Un agent qui revendique une tâche puis meurt (crash, perte de connectivité,
 * boucle infinie tuée par son runtime) la bloquait jusqu'à ce qu'un humain
 * remarque et fasse un takeover. Ici le bail échu **rend la tâche au vivier** :
 * retour en TODO, claim et assignation retirés, `retryCount` incrémenté (un
 * cycle a bien été consommé — et au bout de N, l'escalade « poison task »
 * sortira la tâche du circuit agent).
 *
 * Contrairement au sweeper de validation, ce balayage est **correctif** et non
 * seulement hygiénique : sans lui, la tâche ne redevient jamais disponible.
 * Chaque reprise est conditionnée (`updateMany` sur claimant + statut + bail
 * échu) → aucune course avec un heartbeat qui arriverait au même instant.
 *
 * Idempotent → pas de lock distribué ; énumère les bases tenant en pooled.
 */
@Injectable()
export class AgentExecutionLeaseCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AgentExecutionLeaseCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // Décalé du sweeper de validation (4 min) pour ne pas empiler deux
    // énumérations de tenants sur le même instant.
    setTimeout(() => void this.tick(), 2 * 60_000).unref();
    this.log.log('Agent execution lease sweeper armed (5min interval).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.sweepCurrent(slug));
        } catch (err) {
          this.log.warn(`execution lease sweep tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    await this.sweepCurrent(null);
  }

  private async sweepCurrent(slug: string | null): Promise<void> {
    const tag = slug ? ` tenant=${slug}` : '';
    try {
      const now = new Date();
      const expired = await this.prisma.task.findMany({
        where: {
          leaseExpiresAt: { lt: now },
          claimedById: { not: null },
          // Seuls les statuts où l'agent TIENT le travail. Une tâche passée en
          // IN_REVIEW attend un humain : son bail éventuel est inerte.
          status: { in: [TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS] },
          deletedAt: null,
        },
        select: {
          id: true, organizationId: true, projectId: true,
          claimedById: true, status: true, retryCount: true, leaseExpiresAt: true,
        },
        take: BATCH,
      });
      if (!expired.length) return;

      let reclaimed = 0;
      for (const t of expired) {
        const claimant = t.claimedById as string;
        try {
          const done = await this.prisma.$transaction(async (tx) => {
            // Colonne TODO du board pour réaligner la carte : au claim elle avait
            // été poussée vers la colonne foldée CLAIMED/IN_PROGRESS. Sans ça la
            // carte reste affichée en In progress alors que le statut est TODO.
            const todoCol = await tx.boardColumn.findFirst({
              where: { board: { projectId: t.projectId }, status: TaskStatus.TODO },
              orderBy: { order: 'asc' },
              select: { id: true },
            });
            // Reprise CONDITIONNÉE : si un heartbeat a repoussé le bail entre le
            // findMany et ici, count = 0 et on ne touche à rien.
            const res = await tx.task.updateMany({
              where: {
                id: t.id,
                claimedById: claimant,
                status: t.status,
                leaseExpiresAt: { lt: now },
                deletedAt: null,
              },
              data: {
                status: TaskStatus.TODO,
                ...(todoCol ? { boardColumnId: todoCol.id } : {}),
                claimedById: null,
                claimedAt: null,
                leaseExpiresAt: null,
                retryCount: { increment: 1 },
              },
            });
            if (res.count === 0) return false;
            await tx.taskStatusHistory.create({
              data: {
                organizationId: t.organizationId,
                projectId: t.projectId,
                taskId: t.id,
                fromStatus: t.status,
                toStatus: TaskStatus.TODO,
                // Reprise SYSTÈME : personne n'a « fait » cette transition.
                changedById: null,
                reason: 'execution lease expired',
              },
            });
            await tx.taskAssignee
              .deleteMany({ where: { taskId: t.id, userId: claimant } })
              .catch(() => undefined);
            return true;
          });
          if (!done) continue;
          reclaimed++;
          void this.audit.log({
            organizationId: t.organizationId,
            action: AUDIT_ACTIONS.AGENT_LEASE_EXPIRED,
            severity: 'WARNING',
            actorType: 'SYSTEM',
            resourceType: 'task',
            resourceId: t.id,
            detail: {
              projectId: t.projectId,
              previousClaimantId: claimant,
              fromStatus: t.status,
              leaseExpiredAt: t.leaseExpiresAt?.toISOString() ?? null,
              retryCount: t.retryCount + 1,
            },
          });
        } catch (err) {
          this.log.warn(`lease reclaim task=${t.id}${tag} failed: ${(err as Error).message}`);
        }
      }
      if (reclaimed) this.log.log(`execution lease sweep${tag}: ${reclaimed} task(s) returned to TODO`);
    } catch (err) {
      this.log.warn(`execution lease sweep${tag} skipped: ${(err as Error).message}`);
    }
  }

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
