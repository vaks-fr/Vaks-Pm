import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LicenseService } from '../licensing/license.service';
import { OpenMetricsBuilder } from './prometheus-format';

interface CacheEntry {
  expiresAt: number;
  body: string;
}

/**
 * Export de métriques applicatives au format Prometheus text exposition —
 * scope `monitoring:read` (voir `metrics.controller.ts`).
 *
 * **Aucune topologie d'infra** (hostname, IP, nœud Swarm, état
 * Postgres/Redis/Garage) : c'est précisément ce qui a fait retirer le panneau
 * Monitoring de l'admin (mémoire `project_monitoring_admin_removed`). Ici,
 * uniquement des compteurs **métier**, agrégés côté Prisma et **strictement
 * bornés à `organizationId`** (mode pooled : un cache partagé entre tenants
 * serait une fuite cross-tenant — d'où la clé de cache par org ci-dessous).
 *
 * Cache mémoire **process-local** (pas Redis) : un scrape Prometheus tape
 * toutes les 15-30s, borner le TTL suffit à absorber la cadence sans
 * recompter à chaque appel ; pas besoin de cohérence inter-réplica pour de la
 * télémétrie approximative.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = Number(process.env.METRICS_CACHE_TTL_MS) || 20_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
  ) {}

  /** Rend le corps OpenMetrics pour l'org, depuis le cache si frais. */
  async render(orgId: string): Promise<string> {
    const cached = this.cache.get(orgId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.body;

    const body = await this.collect(orgId).catch((err: Error) => {
      // Fail-open partiel : un scrape ne doit jamais planter sur une erreur
      // d'agrégation ponctuelle — on rend au moins `vakspm_up`.
      this.logger.error(`collect(${orgId}) failed: ${err.message}`);
      return new OpenMetricsBuilder()
        .gauge('vakspm_up', "1 si l'export de métriques répond pour cette organisation", { value: 1 })
        .toString();
    });

    this.cache.set(orgId, { expiresAt: now + this.ttlMs, body });
    return body;
  }

  private async collect(orgId: string): Promise<string> {
    const [
      seatsUsed,
      seatLimit,
      projectCount,
      tasksByStatus,
      deliverablesByStatus,
      loginFailures1h,
      lastScimSync,
    ] = await Promise.all([
      this.licenses.seatsUsed(orgId),
      this.licenses.seatLimit(),
      this.prisma.project.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.task.groupBy({
        by: ['status'],
        where: { organizationId: orgId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.deliverable.groupBy({
        by: ['reviewStatus'],
        where: { organizationId: orgId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.auditLog.count({
        where: {
          organizationId: orgId,
          action: 'auth.login.failure',
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      }),
      // Pas de champ dédié « dernière sync SCIM » en base (le provisioning est
      // poussé par l'IdP, pas un pull planifié) : dérivé du dernier fait d'audit
      // SCIM de l'org. ⚠️ Deux familles d'actions (cf. `scim.service.ts`) :
      //  - GROUPES : actions préfixées `scim.group.*` (`scim.group.provisioned/updated/deleted`) ;
      //  - UTILISATEURS : loggés sous les actions `user.*` GÉNÉRIQUES (partagées
      //    avec le SSO JIT interactif) → on ne peut PAS se fier au préfixe, il faut
      //    discriminer sur `detail.via === 'scim'` sinon (a) on rate les tenants qui
      //    ne syncent que des users (faux « jamais synchronisé »), (b) on prendrait
      //    un simple login SSO pour une sync SCIM.
      this.prisma.auditLog.findFirst({
        where: {
          organizationId: orgId,
          OR: [
            { action: { startsWith: 'scim.' } },
            {
              action: { in: ['user.provisioned.sso', 'user.suspended', 'user.reactivated', 'user.deleted'] },
              detail: { path: ['via'], equals: 'scim' },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const taskCountByStatus = new Map(tasksByStatus.map((r) => [r.status, r._count._all]));
    const deliverableCountByStatus = new Map(
      deliverablesByStatus.map((r) => [r.reviewStatus, r._count._all]),
    );

    const m = new OpenMetricsBuilder();

    m.gauge('vakspm_up', "1 si l'export de métriques répond pour cette organisation", {
      value: 1,
    });

    m.gauge('vakspm_seats_used', 'Sièges utilisateur occupés (User.licensed=true, non supprimés)', {
      value: seatsUsed,
    });
    // seatLimit == null = licence sans plafond (illimité) : pas de valeur
    // numérique honnête à exposer, on omet l'échantillon plutôt que mentir
    // avec -1 (un scrape le lirait comme une régression, pas comme "illimité").
    if (seatLimit != null) {
      m.gauge('vakspm_seat_limit', "Plafond de sièges de la licence active (absent = illimité)", {
        value: seatLimit,
      });
    }

    m.gauge('vakspm_projects_total', 'Projets actifs (non archivés/supprimés)', {
      value: projectCount,
    });

    m.gauge(
      'vakspm_tasks_by_status',
      'Tâches non supprimées, par statut',
      TASK_STATUSES.map((status) => ({
        labels: { status },
        value: taskCountByStatus.get(status) ?? 0,
      })),
    );

    m.gauge(
      'vakspm_deliverables_by_review_status',
      'Livrables non supprimés, par statut de revue',
      DELIVERABLE_REVIEW_STATUSES.map((reviewStatus) => ({
        labels: { review_status: reviewStatus },
        value: deliverableCountByStatus.get(reviewStatus) ?? 0,
      })),
    );

    m.gauge(
      'vakspm_login_failures_recent',
      'Échecs de connexion récents (fenêtre glissante fixe)',
      { labels: { window: '1h' }, value: loginFailures1h },
    );

    m.gauge(
      'vakspm_scim_last_sync_timestamp_seconds',
      'Horodatage Unix (secondes) du dernier événement de provisioning SCIM (absent = jamais)',
      { value: lastScimSync ? Math.floor(lastScimSync.createdAt.getTime() / 1000) : null },
    );

    return m.toString();
  }
}

// Labels à cardinalité BORNÉE uniquement (énumérations fixes du schéma) —
// jamais un id/email/nom libre en label (explosion de cardinalité Prometheus).
const TASK_STATUSES = [
  'TODO',
  'CLAIMED',
  'IN_PROGRESS',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'ON_HOLD',
  'DONE',
] as const;

const DELIVERABLE_REVIEW_STATUSES = ['PENDING', 'APPROVED', 'CHANGES_REQUESTED'] as const;
