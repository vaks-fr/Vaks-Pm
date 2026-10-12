import { Queue } from 'bullmq';
import { URL } from 'url';

/**
 * Producteur BullMQ pour la file `email` consommée par `worker/`.
 * Le shape `EmailJob` est dupliqué (volontairement) entre API et worker : pas de
 * dépendance partagée à imposer pour éviter de coupler les builds.
 */
export interface EmailJobData {
  /** Org pour audit/EmailDelivery — pas utilisé par le transport SMTP. */
  organizationId: string;
  /** Slug tenant (pooled) → header `X-Tenant-Slug` sur le callback worker→API
   *  qui met à jour le statut EmailDelivery dans la BONNE base. */
  tenantSlug?: string | null;
  /** ID de la ligne EmailDelivery — le worker met à jour status/error/sentAt. */
  deliveryId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Override du From standard si fourni (sinon worker fallback sur SMTP_FROM env var). */
  fromName?: string;
  fromAddress?: string;
  replyTo?: string;
  /**
   * Configuration SMTP de transport résolue **par tenant** au moment de
   * l'enqueue (host/port/encryption/authMode/user + mot de passe déchiffré).
   * Quand fourni (host non vide), le worker l'utilise tel quel — indispensable
   * en mode pooled où le worker ne peut pas deviner le tenant d'un job. Absent
   * = le worker retombe sur sa conf globale + env `SMTP_PASSWORD` (legacy/dev).
   * `password` est toujours `null` côté API (jamais de secret dans Redis) : le
   * worker le lit via la route interne `/internal/notifications/smtp`.
   */
  smtp?: {
    host: string;
    port: number;
    encryption: 'none' | 'starttls' | 'ssl';
    authMode: 'anonymous' | 'password';
    user: string | null;
    password: string | null;
  };
  /**
   * Images embarquées inline (CID attachments). Le HTML doit déjà référencer
   * chacune via `<img src="cid:<cid>">`. Pour le logo org, l'API lit le blob
   * MinIO à l'enqueue et le passe en base64 ici — le destinataire voit l'image
   * sans dépendre de la résolvabilité d'`APP_URL`.
   */
  inlineImages?: Array<{
    cid: string;
    base64: string;
    contentType: string;
    filename?: string;
  }>;
  /**
   * Pièces jointes « fichier » (non inline) — ex. l'offre commerciale envoyée
   * au client. Le contenu est lu à l'enqueue (blob S3) et passé en base64 ;
   * le worker le remappe en attachment nodemailer (`content` Buffer).
   */
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType: string;
  }>;
}

let queueSingleton: Queue<EmailJobData> | null = null;

export function getEmailQueue(): Queue<EmailJobData> {
  if (queueSingleton) return queueSingleton;
  const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
  queueSingleton = new Queue<EmailJobData>('email', {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  });
  return queueSingleton;
}
