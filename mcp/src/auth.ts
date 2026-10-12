import type { IncomingHttpHeaders } from 'node:http';
import { VaksApiError } from './api-client.js';

/**
 * Extrait le jeton porteur. Chemin nominal : `Authorization: Bearer vaks_…`.
 *
 * Repli sur l'en-tête NON RÉSERVÉ `X-Api-Key` : certains clients — notamment les
 * **custom connectors Power Platform / Copilot Studio** — RÉSERVENT l'en-tête
 * `Authorization` et le strippent silencieusement, si bien qu'un jeton d'agent
 * (PAT) n'arrivait jamais. `X-Api-Key` contourne ce mur. On accepte la valeur
 * telle quelle (PAT brut) OU préfixée `Bearer ` — le champ de connexion côté
 * Copilot laisse souvent l'un ou l'autre. Le repli ne concerne QUE le transport
 * du jeton : la validation (API) et le RBAC sont inchangés.
 */
export function extractBearer(headers: IncomingHttpHeaders): string | null {
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const raw = headers['x-api-key'];
  const alt = Array.isArray(raw) ? raw[0] : raw;
  if (typeof alt === 'string' && alt.trim()) {
    const v = alt.trim();
    return (v.startsWith('Bearer ') ? v.slice(7).trim() : v) || null;
  }
  return null;
}

/**
 * Seuls les jetons d'API Vaks (`vaks_pat_`, `vaks_org_`, jetons d'agent) sont
 * acceptés par le MCP. Toute la gouvernance IA côté API (public-gate, kill
 * switch, quotas, confirmation, gate finance) est conditionnée à
 * `viaApiToken` : relayer un JWT de session la contournerait entièrement.
 * Tout jeton émis par la façade OAuth ou la fédération est un `vaks_…`, donc
 * ce filtre ne coupe aucun client légitime. Refusé ICI, sans appel API : un
 * jeton au mauvais format ne doit rien coûter à l'API (DoS).
 */
export function isVaksToken(bearer: string): boolean {
  return bearer.startsWith('vaks_');
}

/** Issue du handshake `GET me/mcp-context` en échec. */
export type HandshakeFailure =
  | { kind: 'unauthorized' }
  | { kind: 'forbidden'; reason: string | null }
  | { kind: 'unavailable' };

/**
 * Classe une erreur du handshake. **Fail-closed** : tout ce qui n'est ni 401 ni
 * 403 (429, 5xx, timeout, API injoignable) est `unavailable` → 503 retryable.
 * On ne construit JAMAIS de serveur dégradé : sans contexte, l'`actorKind` est
 * inconnu (un agent verrait la surface humaine) et le kill switch `mcp.enabled`
 * n'aurait pas été relu.
 */
export function classifyHandshakeError(e: unknown): HandshakeFailure {
  if (e instanceof VaksApiError && e.status === 401) return { kind: 'unauthorized' };
  if (e instanceof VaksApiError && e.status === 403) {
    // Message BRUT de l'API (`body.message`), pas `e.message` qu'`explain()`
    // habille d'un « périmètre de l'utilisateur » — faux pour le kill switch.
    const body = e.body as { message?: unknown } | null | undefined;
    return { kind: 'forbidden', reason: typeof body?.message === 'string' ? body.message : null };
  }
  return { kind: 'unavailable' };
}
