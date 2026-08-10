/**
 * Sanitization des payloads d'audit : redaction récursive des clés sensibles
 * + plafond de taille. Aucune valeur secrète ne doit JAMAIS atteindre la table
 * AuditLog ni le SIEM — la redaction se fait AVANT bufferisation.
 */

const SENSITIVE_KEY = /password|passwd|secret|token|authorization|(?:api|admin)[-_]?key|mfa|otp|totp|cookie|credential|caPem/i;

/** Taille max du JSON `detail` après redaction (8 KB). */
export const DETAIL_MAX_BYTES = 8 * 1024;

const MAX_DEPTH = 8;

/** Copie profonde avec valeurs des clés sensibles remplacées par [REDACTED]. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value == null || depth > MAX_DEPTH) return value == null ? value : '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redact + cap : si le JSON dépasse 8 KB on ne garde que la liste des clés
 * de premier niveau (le contenu intégral n'a pas sa place dans un journal).
 */
export function sanitizeDetail(value: unknown): unknown {
  if (value == null) return undefined;
  const redacted = redactSensitive(value);
  try {
    const json = JSON.stringify(redacted);
    if (json === undefined) return undefined;
    if (Buffer.byteLength(json, 'utf8') <= DETAIL_MAX_BYTES) return redacted;
    const keys =
      redacted && typeof redacted === 'object' && !Array.isArray(redacted)
        ? Object.keys(redacted as object).slice(0, 50)
        : [];
    return { truncated: true, keys };
  } catch {
    return { unserializable: true };
  }
}

/**
 * Diff explicite before/after limité à `fields` — utilisé par les hooks de
 * sécurité (settings, rôles, users) pour tracer ce qui a changé sans dumper
 * les objets entiers. Les valeurs passent par la redaction.
 */
export function auditDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields?: string[],
): Record<string, { old: unknown; new: unknown }> | undefined {
  const keys = fields ?? [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ];
  const out: Record<string, { old: unknown; new: unknown }> = {};
  for (const k of keys) {
    const o = before?.[k];
    const n = after?.[k];
    if (JSON.stringify(o) === JSON.stringify(n)) continue;
    out[k] = {
      old: SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactSensitive(o),
      new: SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactSensitive(n),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function truncate(v: string | null | undefined, max: number): string | undefined {
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}
