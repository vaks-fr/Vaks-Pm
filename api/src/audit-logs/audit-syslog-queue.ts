import { Queue } from 'bullmq';
import { URL } from 'url';

/**
 * Producteur BullMQ pour la file `audit-syslog` consommée par `worker/`.
 * Shape dupliquée côté worker (`worker/src/queues.ts`) — pas de dépendance
 * partagée, comme pour les files email/webhook.
 */
export interface AuditSyslogConfig {
  host: string;
  port: number;
  protocol: 'tcp' | 'tls';
  caPem?: string;
  /** Certificat client mTLS (public). La clé privée vit côté worker (secret
   *  Swarm `syslog_client_key`) — jamais transportée dans le job. */
  clientCertPem?: string;
  rejectUnauthorized: boolean;
  appName: string;
}

export interface AuditSyslogEntry {
  id: string;
  createdAt: string;
  action: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  outcome: 'SUCCESS' | 'FAILURE';
  actorType: string;
  actorId?: string | null;
  actorLabel?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabel?: string | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  detail?: unknown;
}

export interface AuditSyslogJobData {
  organizationId: string;
  tenantSlug?: string | null;
  config: AuditSyslogConfig;
  entries: AuditSyslogEntry[];
  test?: boolean;
}

let queueSingleton: Queue<AuditSyslogJobData> | null = null;

export function getAuditSyslogQueue(): Queue<AuditSyslogJobData> {
  if (queueSingleton) return queueSingleton;
  const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
  queueSingleton = new Queue<AuditSyslogJobData>('audit-syslog', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      username: url.username || undefined,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      // Mêmes retries que webhooks : 5 tentatives, backoff exponentiel.
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  });
  return queueSingleton;
}
