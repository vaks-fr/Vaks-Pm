import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AdminSettingsService } from './admin-settings.service';
import { RingBufferLogger } from '../common/ring-buffer-logger';
import { redactSensitive } from '../audit-logs/audit-sanitize';

interface Probe {
  status: 'up' | 'down' | 'unknown';
  latencyMs?: number;
  detail?: string;
}

/**
 * Construit le **bundle de diagnostic** in-app (snapshot JSON, pas de fichiers
 * de log — l'app ne logge que sur stdout). Tout est best-effort et redacté :
 * aucune valeur sensible (mots de passe, secrets, clés) n'en sort.
 *
 * Pour les logs d'INFRA (Docker, Traefik, Patroni/HAProxy/etcd, Garage) que
 * l'app ne peut pas atteindre, le bundle embarque la **liste exacte des
 * commandes** à exécuter côté hôtes (`hostLogsToCollect`) — voir aussi
 * `docs/{en,fr}/support-bundle.html`.
 */
@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly s3: S3Service,
    private readonly config: ConfigService,
  ) {}

  async buildBundle(ctx: {
    orgId: string;
    slug?: string;
    host?: string;
    requestedBy?: { id: string; email: string };
  }): Promise<Record<string, unknown>> {
    const [db, redisAndQueues, s3, settingsBlock, recentAudit, email] = await Promise.all([
      this.probeDb(),
      this.probeRedisAndQueues({ orgId: ctx.orgId, slug: ctx.slug }),
      this.probeS3(),
      this.collectSettings(ctx.orgId),
      this.recentCriticalAudit(),
      this.recentEmail(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      generatedBy: ctx.requestedBy ?? null,
      app: {
        version: process.env.npm_package_version || process.env.APP_VERSION || '0.1',
        commit: process.env.GIT_COMMIT || process.env.APP_COMMIT || null,
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        pid: process.pid,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        env: process.env.NODE_ENV || 'production',
        tenancyMode: this.config.get<string>('deployment.mode') ?? 'unknown',
      },
      tenant: { slug: ctx.slug ?? null, orgId: ctx.orgId, host: ctx.host ?? null },
      health: {
        db,
        redis: redisAndQueues.redis,
        s3,
        smtp: settingsBlock.smtp,
      },
      queues: redisAndQueues.queues,
      email,
      settings: settingsBlock.redacted,
      recentCriticalAudit: recentAudit,
      recentErrors: RingBufferLogger.snapshot(),
      hostLogsToCollect: HOST_LOGS_GUIDE,
    };
  }

  private async probeDb(): Promise<Probe> {
    const t0 = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - t0 };
    } catch (e) {
      return { status: 'down', latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  }

  private async probeS3(): Promise<Probe> {
    const t0 = Date.now();
    const r = await this.s3.ping();
    return r.ok
      ? { status: 'up', latencyMs: Date.now() - t0, detail: `bucket ${r.bucket}` }
      : { status: 'down', latencyMs: Date.now() - t0, detail: r.error };
  }

  /** Une seule connexion ioredis transitoire pour le ping ET les profondeurs de file. */
  private async probeRedisAndQueues(tenant: { orgId: string; slug?: string }): Promise<{
    redis: Probe;
    queues: Record<string, unknown>;
  }> {
    const url = this.config.get<string>('redisUrl') ?? 'redis://redis:6379';
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    const t0 = Date.now();
    try {
      await client.connect();
      await client.ping();
      const redis: Probe = { status: 'up', latencyMs: Date.now() - t0 };
      const queues = await this.queueDepths(client, tenant);
      return { redis, queues };
    } catch (e) {
      return {
        redis: { status: 'down', latencyMs: Date.now() - t0, detail: (e as Error).message },
        queues: { error: 'redis unavailable' },
      };
    } finally {
      client.disconnect();
    }
  }

  /**
   * Profondeurs des files BullMQ (préfixe `bull`) **scopées au tenant courant**.
   * Les files (`email`/`webhook`/`audit-syslog`) sont **partagées par tout le
   * cluster pooled** — un `ZCARD`/`LLEN` brut compterait les jobs de TOUS les
   * tenants. Chaque job porte `tenantSlug` + `organizationId` dans sa `data`
   * (cf. `EmailJobData`/`WebhookJobData`/`AuditSyslogJobData`) : on relit cette
   * donnée pour chaque id et on ne compte que les jobs du tenant appelant.
   * ⚠️ `organizationId` seul n'est PAS un identifiant fiable en pooled : les
   * tenants seedés depuis le même jeu de démo (demo/globex/…) réutilisent le
   * même id d'org dans leur base respective. `tenantSlug` (la vraie clé de
   * partition `<db>_<slug>`) prime dès qu'il est disponible.
   * Best-effort par file : une erreur sur une file la marque `unknown` sans
   * casser le reste.
   */
  private async queueDepths(
    client: Redis,
    tenant: { orgId: string; slug?: string },
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const name of ['email', 'webhook', 'audit-syslog']) {
      try {
        const [waitingIds, activeIds, failedIds, delayedIds] = await Promise.all([
          client.lrange(`bull:${name}:wait`, 0, -1),
          client.lrange(`bull:${name}:active`, 0, -1),
          client.zrange(`bull:${name}:failed`, 0, -1),
          client.zrange(`bull:${name}:delayed`, 0, -1),
        ]);
        const [waiting, active, failed, delayed] = await Promise.all([
          this.countJobsForTenant(client, name, waitingIds, tenant),
          this.countJobsForTenant(client, name, activeIds, tenant),
          this.countJobsForTenant(client, name, failedIds, tenant),
          this.countJobsForTenant(client, name, delayedIds, tenant),
        ]);
        out[name] = { waiting, active, failed, delayed };
      } catch {
        out[name] = { status: 'unknown' };
      }
    }
    return out;
  }

  /** Relit la `data` de chaque job (pipeline = 1 aller-retour) et ne garde que ceux du tenant appelant. */
  private async countJobsForTenant(
    client: Redis,
    queueName: string,
    jobIds: string[],
    tenant: { orgId: string; slug?: string },
  ): Promise<number> {
    if (jobIds.length === 0) return 0;
    const pipeline = client.pipeline();
    for (const id of jobIds) pipeline.hget(`bull:${queueName}:${id}`, 'data');
    const results = (await pipeline.exec()) ?? [];
    let count = 0;
    for (const [, raw] of results) {
      if (typeof raw !== 'string') continue;
      try {
        const data = JSON.parse(raw) as { organizationId?: string; tenantSlug?: string | null };
        if (tenant.slug) {
          // pooled : le slug est la clé de partition fiable — un job legacy
          // sans tenantSlug ne peut pas être attribué avec certitude, on
          // l'exclut plutôt que de fausser le compte d'un tenant au hasard.
          if (data.tenantSlug === tenant.slug) count++;
        } else if (data.organizationId === tenant.orgId) {
          count++;
        }
      } catch {
        // job data illisible — ignoré plutôt que de fausser le compte
      }
    }
    return count;
  }

  /** Settings effectifs, secrets masqués (getAllForAdmin) + re-redaction défensive. */
  private async collectSettings(
    orgId: string,
  ): Promise<{ redacted: unknown; smtp: Record<string, unknown> }> {
    try {
      const all = (await this.settings.getAllForAdmin(orgId)) as Record<string, unknown>;
      const smtp = {
        configured: Boolean(all['smtp.host']),
        host: all['smtp.host'] ?? null,
        port: all['smtp.port'] ?? null,
        encryption: all['smtp.encryption'] ?? null,
        authMode: all['smtp.authMode'] ?? null,
      };
      return { redacted: redactSensitive(all), smtp };
    } catch (e) {
      this.logger.warn(`diagnostics: settings unavailable — ${(e as Error).message}`);
      return { redacted: { error: 'settings unavailable' }, smtp: { configured: false } };
    }
  }

  /** Dernières entrées d'audit CRITICAL (sécurité), libellés snapshotés. */
  private async recentCriticalAudit(): Promise<unknown[]> {
    try {
      const rows = await this.prisma.auditLog.findMany({
        where: { severity: 'CRITICAL' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          createdAt: true,
          action: true,
          outcome: true,
          actorLabel: true,
          resourceLabel: true,
          ip: true,
        },
      });
      return rows;
    } catch (e) {
      this.logger.warn(`diagnostics: audit unavailable — ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Diagnostic email/SMTP : répartition des derniers envois par statut + les
   * dernières tentatives en ÉCHEC avec le **message d'erreur SMTP brut** (le
   * signal clé, ex. « 525 IP not authorized »). Destinataire masqué (PII) — le
   * domaine reste lisible car il importe pour le debug relais.
   */
  private async recentEmail(): Promise<Record<string, unknown>> {
    try {
      const recent = await this.prisma.emailDelivery.findMany({
        orderBy: { queuedAt: 'desc' },
        take: 200,
        select: {
          queuedAt: true,
          sentAt: true,
          template: true,
          status: true,
          error: true,
          toAddress: true,
        },
      });
      const counts: Record<string, number> = {};
      for (const r of recent) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const lastFailures = recent
        .filter((r) => r.status === 'FAILED')
        .slice(0, 20)
        .map((r) => ({
          at: r.queuedAt,
          template: r.template,
          to: maskEmail(r.toAddress),
          error: r.error ?? null,
        }));
      return { sampleSize: recent.length, counts, lastFailures };
    } catch (e) {
      this.logger.warn(`diagnostics: email deliveries unavailable — ${(e as Error).message}`);
      return { counts: {}, lastFailures: [] };
    }
  }
}

/** Masque la partie locale d'un email pour la sortie diagnostic : `j***@company.com`. */
function maskEmail(addr: string): string {
  const at = addr.indexOf('@');
  if (at <= 0) return '***';
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/**
 * Procédure exacte des logs côté HÔTES que l'app ne peut pas collecter
 * (intentionnellement : pas de socket Docker monté dans l'API). À exécuter en
 * SSH sur le manager Swarm (host1). Embarqué dans le bundle pour que le client
 * sache précisément quoi joindre selon le symptôme.
 */
const HOST_LOGS_GUIDE = {
  note:
    "L'application ne peut pas lire les logs d'infrastructure (Docker, reverse-proxy, base HA). " +
    'Pour un problème côté plateforme, joignez aussi la sortie des commandes ci-dessous, ' +
    'exécutées en SSH sur le nœud manager Swarm (host1). Voir docs/{en,fr}/support-bundle.html.',
  categories: [
    {
      area: 'Cluster / Swarm',
      why: 'État des services, réplicas tombés, redémarrages en boucle.',
      commands: [
        'docker service ls',
        'docker stack ps vaks-pm --no-trunc',
        'docker node ls',
      ],
    },
    {
      area: 'Application (API / Web / Worker)',
      why: "Erreurs applicatives, traces 500, jobs worker. Le bundle in-app ne tient qu'un réplica.",
      commands: [
        'docker service logs --since 2h --tail 2000 vaks-pm_api',
        'docker service logs --since 2h --tail 2000 vaks-pm_worker',
        'docker service logs --since 2h --tail 500 vaks-pm_web',
      ],
    },
    {
      area: 'Email / SMTP',
      why:
        "Emails non reçus, erreurs du relais (auth 535, IP non autorisée 525, TLS). " +
        "Le bloc `email` de ce bundle liste déjà les dernières erreurs SMTP brutes ; " +
        "complétez avec les logs du worker (qui réalise l'envoi) et l'écran Admin > Notifications > Livraisons.",
      commands: [
        "docker service logs --since 6h vaks-pm_worker 2>&1 | grep -iE 'smtp|mail|nodemailer|relay' | tail -200",
      ],
    },
    {
      area: 'Reverse-proxy / TLS (Traefik)',
      why: 'Erreurs 502/504, problèmes de certificat ACME, routage des hosts.',
      commands: [
        'docker service logs --since 2h --tail 2000 vaks-pm_traefik',
      ],
    },
    {
      area: 'Base de données HA (Patroni / PostgreSQL / etcd / HAProxy)',
      why: 'Bascule de primaire, lag de réplica, indisponibilité DB. Natifs sur les hôtes.',
      commands: [
        'sudo patronictl -c /etc/patroni.yml list',
        'sudo journalctl -u patroni --since "2 hours ago" --no-pager',
        'sudo journalctl -u etcd --since "2 hours ago" --no-pager',
        'sudo journalctl -u haproxy --since "2 hours ago" --no-pager',
      ],
    },
    {
      area: 'Cache / files (Redis) & stockage objet (Garage / S3)',
      why: 'Files de jobs bloquées, échecs de pièces jointes.',
      commands: [
        'docker service logs --since 2h --tail 500 vaks-pm_redis',
        'docker service logs --since 2h --tail 500 vaks-pm_garage',
      ],
    },
    {
      area: 'Ressources hôte',
      why: 'Disque plein, OOM, charge — causes fréquentes de pannes diffuses.',
      commands: [
        'df -h',
        'free -m',
        'docker system df',
        'uptime',
      ],
    },
  ],
} as const;
