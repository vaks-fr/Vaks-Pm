/**
 * Schéma typé des settings notifications & SMTP stockés dans `OrgSetting`.
 * Lecture/écriture passent par `AdminSettingsService.getAll/upsertMany`, mais
 * ce fichier centralise les clés, les défauts et la normalisation.
 *
 * Convention de clés :
 *   notif.* — préférences notification (kill switch, types d'event, digest, branding)
 *   smtp.*  — relais SMTP (host/port/encryption/authMode/user)
 *
 * Le mot de passe SMTP n'est JAMAIS stocké en DB. Il est lu côté worker depuis
 * la variable d'environnement `SMTP_PASSWORD` (Swarm secret). Voir
 * `worker/src/processors/email.processor.ts`.
 */

export type SmtpEncryption = 'none' | 'starttls' | 'ssl';
export type SmtpAuthMode = 'anonymous' | 'password';
export type DigestMode = 'off' | 'daily' | 'weekly';

export interface NotificationsSettings {
  enabled: boolean;
  onAssignment: boolean;
  onMention: boolean;
  onDueDate: boolean;
  onStatusChange: boolean;
  /** Quand le cumul d'heures loggées dépasse l'estimate d'une tâche,
   *  envoyer un mail aux PROJECT_MANAGER du projet. Déclenché une seule
   *  fois par franchissement (passe de ≤ estimate à > estimate). */
  onOverEstimate: boolean;
  /** Nombre de jours avant la due date pour le rappel. */
  dueLeadDays: number;
  digest: DigestMode;
  /** Heure (0-23, fuseau org) de livraison du digest. */
  digestHour: number;
  /** Plage horaire pendant laquelle aucun mail n'est envoyé. null = désactivé. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  accentColor: string;
  logoUrl: string | null;
}

export interface SmtpSettings {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  authMode: SmtpAuthMode;
  user: string | null;
}

export const DEFAULT_NOTIFICATIONS_SETTINGS: NotificationsSettings = {
  enabled: true,
  onAssignment: true,
  onMention: true,
  onDueDate: true,
  onStatusChange: false,
  onOverEstimate: false,
  dueLeadDays: 1,
  digest: 'off',
  digestHour: 8,
  quietHoursStart: null,
  quietHoursEnd: null,
  fromName: 'Vaks Notifications',
  fromAddress: 'no-reply@vaks-pm.local',
  replyTo: null,
  accentColor: '#6d5efc',
  logoUrl: null,
};

export const DEFAULT_SMTP_SETTINGS: SmtpSettings = {
  host: '',
  port: 587,
  encryption: 'starttls',
  authMode: 'anonymous',
  user: null,
};

const ALLOWED_DIGEST: DigestMode[] = ['off', 'daily', 'weekly'];
const ALLOWED_ENC: SmtpEncryption[] = ['none', 'starttls', 'ssl'];
const ALLOWED_AUTH: SmtpAuthMode[] = ['anonymous', 'password'];

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return def;
}
function asInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function asStr(v: unknown, def: string): string {
  return typeof v === 'string' && v.length > 0 ? v : def;
}
function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asHourOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return null;
  return Math.trunc(n);
}

/**
 * Lit les settings notifications depuis un dump `{key: value}` (sortie de
 * `AdminSettingsService.getAll`). Applique les défauts pour les clés absentes.
 */
export function readNotificationsSettings(
  raw: Record<string, unknown>,
): NotificationsSettings {
  return {
    enabled: asBool(raw['notif.enabled'], DEFAULT_NOTIFICATIONS_SETTINGS.enabled),
    onAssignment: asBool(raw['notif.onAssignment'], DEFAULT_NOTIFICATIONS_SETTINGS.onAssignment),
    onMention: asBool(raw['notif.onMention'], DEFAULT_NOTIFICATIONS_SETTINGS.onMention),
    onDueDate: asBool(raw['notif.onDueDate'], DEFAULT_NOTIFICATIONS_SETTINGS.onDueDate),
    onStatusChange: asBool(raw['notif.onStatusChange'], DEFAULT_NOTIFICATIONS_SETTINGS.onStatusChange),
    onOverEstimate: asBool(raw['notif.onOverEstimate'], DEFAULT_NOTIFICATIONS_SETTINGS.onOverEstimate),
    dueLeadDays: asInt(raw['notif.dueLeadDays'], DEFAULT_NOTIFICATIONS_SETTINGS.dueLeadDays, 0, 30),
    digest: ALLOWED_DIGEST.includes(raw['notif.digest'] as DigestMode)
      ? (raw['notif.digest'] as DigestMode)
      : DEFAULT_NOTIFICATIONS_SETTINGS.digest,
    digestHour: asInt(raw['notif.digestHour'], DEFAULT_NOTIFICATIONS_SETTINGS.digestHour, 0, 23),
    quietHoursStart: asHourOrNull(raw['notif.quietHoursStart']),
    quietHoursEnd: asHourOrNull(raw['notif.quietHoursEnd']),
    fromName: asStr(raw['notif.fromName'], DEFAULT_NOTIFICATIONS_SETTINGS.fromName),
    fromAddress: asStr(raw['notif.fromAddress'], DEFAULT_NOTIFICATIONS_SETTINGS.fromAddress),
    replyTo: asStrOrNull(raw['notif.replyTo']),
    accentColor: asStr(raw['notif.accentColor'], DEFAULT_NOTIFICATIONS_SETTINGS.accentColor),
    // Fallback chain : `notif.logoUrl` (override email) → `org.logoUrl` (logo
    // global de l'organisation). Si les deux sont vides, les templates
    // rabattent sur le From name affiché en texte (voir shell() côté template).
    logoUrl: asStrOrNull(raw['notif.logoUrl']) ?? asStrOrNull(raw['org.logoUrl']),
  };
}

export function readSmtpSettings(raw: Record<string, unknown>): SmtpSettings {
  return {
    host: asStr(raw['smtp.host'], DEFAULT_SMTP_SETTINGS.host),
    port: asInt(raw['smtp.port'], DEFAULT_SMTP_SETTINGS.port, 1, 65535),
    encryption: ALLOWED_ENC.includes(raw['smtp.encryption'] as SmtpEncryption)
      ? (raw['smtp.encryption'] as SmtpEncryption)
      : DEFAULT_SMTP_SETTINGS.encryption,
    authMode: ALLOWED_AUTH.includes(raw['smtp.authMode'] as SmtpAuthMode)
      ? (raw['smtp.authMode'] as SmtpAuthMode)
      : DEFAULT_SMTP_SETTINGS.authMode,
    user: asStrOrNull(raw['smtp.user']),
  };
}

/**
 * Renvoie true si l'instant `at` (heure locale de l'org) tombe dans la plage
 * `quietHoursStart`..`quietHoursEnd`. Gère le wrap minuit (ex 22→7).
 */
export function isQuietHour(
  hour: number,
  start: number | null,
  end: number | null,
): boolean {
  if (start === null || end === null || start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
