/**
 * Headers communs aux appels internes worker → API (`X-Worker-Token` +
 * `X-Tenant-Slug`). Partagé par les processors qui appellent des routes
 * `/internal/*` (webhook, teams, export, audit-syslog) — évite la même
 * fonction dupliquée quatre fois.
 *
 * N'inclut PAS `Content-Type` : les call sites GET n'en veulent pas, et ceux
 * qui POSTent du JSON l'ajoutent eux-mêmes via spread
 * (`{ 'Content-Type': 'application/json', ...internalHeaders(tenantSlug) }`).
 */
export function internalHeaders(tenantSlug?: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.WORKER_API_TOKEN;
  if (token) headers['X-Worker-Token'] = token;
  // Route la requête interne vers la base du tenant (mode pooled). Sans ce
  // header, l'API retombe sur la base de base et ne trouve pas la ressource.
  if (tenantSlug) headers['X-Tenant-Slug'] = tenantSlug;
  return headers;
}
