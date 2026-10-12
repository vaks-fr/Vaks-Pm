import { Queue } from 'bullmq';
import { URL } from 'url';

/**
 * Producteur BullMQ pour la file `agent-nudge` consommée par `worker/`.
 * Shape `AgentNudgeJobData` dupliqué côté worker (pas de dépendance partagée —
 * même convention que `WebhookJobData`).
 *
 * Un nudge est un **signal léger sans autorité** : le worker POST
 * `{ event, taskId, projectId, agentId }` (signé HMAC) vers l'URL de callback
 * du provider. L'agent, réveillé, tire et claim atomiquement via ses endpoints.
 */
export interface AgentNudgeJobData {
  /** ID de la ligne AgentNudgeDelivery à mettre à jour par le worker. */
  deliveryId: string;
  /** ID de la souscription pour relire la conf (callbackUrl, secret, active). */
  subscriptionId: string;
  organizationId: string;
  event: string;
  taskId: string | null;
  projectId: string | null;
  /** userId de l'agent destinataire (identité du nudge, sans autorité). */
  agentId: string;
  /** Email/nom de l'agent — pour le dispatch côté provider (Switch sur l'email). */
  agentEmail: string | null;
  agentName: string | null;
  /** CIDR internes approuvés (mode on-prem, gaté) → relâchent l'anti-SSRF côté
   *  worker. Vides = strict. */
  allowedInternalCidrs?: string[];
  /**
   * Slug du tenant (mode `pooled`) au moment de l'enqueue → header
   * `X-Tenant-Slug` sur les appels internes worker→API. `null`/absent en
   * `dedicated`.
   */
  tenantSlug?: string | null;
}

let queueSingleton: Queue<AgentNudgeJobData> | null = null;

export function getAgentNudgeQueue(): Queue<AgentNudgeJobData> {
  if (queueSingleton) return queueSingleton;
  const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
  queueSingleton = new Queue<AgentNudgeJobData>('agent-nudge', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      // 5 tentatives sur ~25 min (backoff exp 5s, 25s, 2m, 10m, 50m).
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  });
  return queueSingleton;
}
