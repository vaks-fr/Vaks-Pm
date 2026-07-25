import { Queue } from 'bullmq';
import { URL } from 'url';

/**
 * Producteur BullMQ pour la file `teams` (provisioning Microsoft Teams),
 * consommée par `worker/`. Shape dupliqué côté worker (pas de dépendance
 * partagée — convention identique aux files email/webhook).
 */
export interface TeamsJobData {
  action: 'provision' | 'archive' | 'unarchive' | 'reconcile';
  projectId: string;
  organizationId: string;
  /** Slug tenant (pooled) — renvoyé au worker pour router ses appels internes. */
  tenantSlug?: string | null;
}

let queueSingleton: Queue<TeamsJobData> | null = null;

export function getTeamsQueue(): Queue<TeamsJobData> {
  if (queueSingleton) return queueSingleton;
  const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
  queueSingleton = new Queue<TeamsJobData>('teams', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      username: url.username || undefined,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      // 5 tentatives, backoff exp. — Graph est asynchrone et throttlé (429).
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  });
  return queueSingleton;
}
