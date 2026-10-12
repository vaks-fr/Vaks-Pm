/* ============================================================
   Vaks — helpers purs sans dépendance, extraits de `api.ts` pour être
   testables sans tirer le graphe api.ts (client HTTP + socket.io).
   `api.ts` réexporte ces mêmes noms : les vues qui importent depuis
   '../vaks/api' ne changent pas.
   ============================================================ */

/** Hash UUID -> 0..359 pour dériver une teinte stable. */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/**
 * Teinte dérivée du *key* visible du projet (2-3 caractères), pour que la
 * pastille colorée soit identique partout : panneau Projects, dropdown du
 * workspace, breadcrumb, etc. **Doit rester identique** à `colorFromKey` de
 * `ProjectsPanel.tsx` — si tu changes la formule, change les deux.
 */
export function hueFromProjectKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

export function initialsOf(name: string | null | undefined): string {
  const safe = (name ?? '').trim();
  if (!safe) return '?';
  const parts = safe.split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** Lundi 00:00 UTC de la semaine en cours. */
export function thisMondayUTC(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // 0=dimanche ; on veut lundi=0
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}
