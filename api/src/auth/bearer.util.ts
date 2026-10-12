import { createHash } from 'crypto';
import type { Request } from 'express';

/**
 * Extraction UNIQUE du jeton porteur d'une requête HTTP — partagée par
 * `JwtAuthGuard`, `ApiThrottlerGuard`, `ScimAuthGuard` et les intercepteurs
 * MCP. Une seule implémentation : le throttler par jeton, le gate `@PublicApi`
 * et l'auth SCIM voient exactement le même jeton, quel que soit le transport.
 *
 * Ordre : `Authorization: Bearer …` d'abord, repli `X-Api-Key` (brut ou
 * préfixé `Bearer `) — une passerelle comme Power Platform / Copilot Studio
 * strippe parfois `Authorization` (même repli que `mcp/src/main.ts`). Le
 * repli ne concerne QUE le transport : validation et RBAC restent inchangés.
 */
export function extractBearer(req: Pick<Request, 'headers'>): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const rawKey = req.headers['x-api-key'];
  const alt = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (typeof alt === 'string' && alt.trim()) {
    const v = alt.trim();
    return v.startsWith('Bearer ') ? v.slice(7).trim() || null : v;
  }
  return null;
}

/** Vrai si le jeton est un jeton d'API Vaks (`vaks_pat_…` / `vaks_org_…`). */
export function isApiToken(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && raw.startsWith('vaks_');
}

/**
 * Identité stable d'un jeton pour les clés Redis (rate-limit, quotas, confirm
 * MCP) : SHA-256 tronqué — jamais le secret en clair dans une clé.
 */
export function tokenIdentity(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
