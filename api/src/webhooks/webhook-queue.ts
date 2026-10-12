import { Queue } from 'bullmq';
import { URL } from 'url';

/**
 * Producteur BullMQ pour la file `webhook` consommée par `worker/`.
 * Shape `WebhookJobData` dupliqué intentionnellement côté worker pour ne pas
 * créer de dépendance partagée — comme pour la file email.
 */
export interface WebhookJobData {
  /** ID de la ligne WebhookDelivery à mettre à jour par le worker. */
  deliveryId: string;
  /** ID Webhook pour relire la conf (secret, url, active) au moment de l'envoi. */
  webhookId: string;
  organizationId: string;
  event: string;
  /** Payload JSON sérialisable — envoyé tel quel dans le body POST. */
  payload: unknown;
  /**
   * Slug du tenant (mode `pooled`) au moment de l'enqueue. Renvoyé par le worker
   * en header `X-Tenant-Slug` sur ses appels internes pour router la lecture
   * conf / MAJ delivery vers la base du tenant. `null`/absent en `dedicated`.
   */
  tenantSlug?: string | null;
}

let queueSingleton: Queue<WebhookJobData> | null = null;

export function getWebhookQueue(): Queue<WebhookJobData> {
  if (queueSingleton) return queueSingleton;
  const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
  queueSingleton = new Queue<WebhookJobData>('webhook', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      // 5 tentatives sur 25 min env. (5s, 25s, 2m, 10m, 50m de backoff exp.)
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  });
  return queueSingleton;
}
