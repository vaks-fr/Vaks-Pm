/**
 * Récupère la configuration SMTP depuis l'API (clés `smtp.*` dans OrgSetting).
 * Le mot de passe SMTP n'est PAS exposé par l'API : on le lit côté worker
 * dans la variable d'env `SMTP_PASSWORD` (montée comme Swarm secret).
 *
 * Cache mémoire 60 s — un changement de SMTP via l'UI prend au pire 1 minute
 * à se propager au worker. Suffisant pour du config admin ; aucune perte de
 * mail (les jobs en file sont rejoués si SMTP_HOST a changé entre temps).
 */
export type SmtpEncryption = 'none' | 'starttls' | 'ssl';
export type SmtpAuthMode = 'anonymous' | 'password';

export interface SmtpConfig {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  authMode: SmtpAuthMode;
  user: string | null;
  /** Lu depuis env SMTP_PASSWORD (jamais en DB). */
  password: string | null;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
}

interface CachedConfig {
  cfg: SmtpConfig;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
let cached: CachedConfig | null = null;

/**
 * Lit la conf SMTP. Tente l'API d'abord (URL `INTERNAL_API_URL`, défaut
 * `http://api:3000`), fallback sur les env vars classiques si l'API n'est pas
 * joignable (utile en dev local sans stack Swarm).
 */
export async function getSmtpConfig(force = false): Promise<SmtpConfig> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.cfg;
  }
  const cfg = await fetchFromApi().catch(() => fromEnv());
  cached = { cfg, fetchedAt: Date.now() };
  return cfg;
}

export function invalidateSmtpCache(): void {
  cached = null;
}

async function fetchFromApi(): Promise<SmtpConfig> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const token = process.env.WORKER_API_TOKEN;
  // Token optionnel tant que l'endpoint est sur l'overlay uniquement (durci en phase 8).
  const headers: Record<string, string> = {};
  if (token) headers['X-Worker-Token'] = token;
  const res = await fetch(`${base}/api/v1/internal/notifications/smtp`, { headers });
  if (!res.ok) throw new Error(`SMTP fetch failed: ${res.status}`);
  const json = (await res.json()) as {
    smtp: { host: string; port: number; encryption: SmtpEncryption; authMode: SmtpAuthMode; user: string | null } | null;
    notifications: { fromName: string; fromAddress: string; replyTo: string | null } | null;
  };
  if (!json.smtp || !json.notifications) throw new Error('No org SMTP config');
  return {
    host: json.smtp.host,
    port: json.smtp.port,
    encryption: json.smtp.encryption,
    authMode: json.smtp.authMode,
    user: json.smtp.user,
    password: process.env.SMTP_PASSWORD ?? null,
    fromName: json.notifications.fromName,
    fromAddress: json.notifications.fromAddress,
    replyTo: json.notifications.replyTo,
  };
}

/**
 * MAJ d'une ligne EmailDelivery via callback HTTP vers l'API (worker n'a pas
 * d'accès Prisma direct). Erreurs swallow — c'est best-effort observationnel.
 */
export async function reportDelivery(
  deliveryId: string,
  status: 'SENT' | 'FAILED',
  error?: string,
  tenantSlug?: string | null,
): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const token = process.env.WORKER_API_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-Worker-Token'] = token;
  // En pooled, sans ce header le PATCH résout sur la base de base et n'update
  // jamais la ligne du tenant (elle reste QUEUED). Cf. webhook/teams processors.
  if (tenantSlug) headers['X-Tenant-Slug'] = tenantSlug;
  try {
    await fetch(`${base}/api/v1/internal/notifications/deliveries/${deliveryId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status, error: error ?? null }),
    });
  } catch {
    /* best-effort */
  }
}

function fromEnv(): SmtpConfig {
  const authMode: SmtpAuthMode = process.env.SMTP_USER ? 'password' : 'anonymous';
  const enc = (process.env.SMTP_ENCRYPTION ?? 'starttls').toLowerCase();
  const encryption: SmtpEncryption =
    enc === 'none' || enc === 'ssl' ? (enc as SmtpEncryption) : 'starttls';
  return {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    encryption,
    authMode,
    user: process.env.SMTP_USER ?? null,
    password: process.env.SMTP_PASSWORD ?? null,
    fromName: process.env.SMTP_FROM_NAME ?? 'Vaks Notifications',
    fromAddress: process.env.SMTP_FROM ?? 'no-reply@vaks-pm.local',
    replyTo: process.env.SMTP_REPLY_TO ?? null,
  };
}
