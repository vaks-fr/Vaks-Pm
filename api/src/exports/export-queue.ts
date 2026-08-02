import { Queue } from 'bullmq';
import { URL } from 'url';

/**
 * Producteur BullMQ pour la file `export`, consommée par `worker/`. Shape
 * dupliqué côté worker (convention du projet : pas de dépendance partagée entre
 * l'API et le worker, comme pour email/webhook/teams).
 */
export interface ExportJobData {
  jobId: string;
  organizationId: string;
  /** Slug tenant (pooled) — le worker le renvoie en `X-Tenant-Slug`. */
  tenantSlug?: string | null;
}

let queueSingleton: Queue<ExportJobData> | null = null;

export function getExportQueue(): Queue<ExportJobData> {
  if (queueSingleton) return queueSingleton;
  const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
  queueSingleton = new Queue<ExportJobData>('export', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      username: url.username || undefined,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      // 3 tentatives seulement : un rendu qui échoue trois fois échoue pour une
      // raison de fond (données, mémoire), pas pour un aléa réseau.
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  return queueSingleton;
}
