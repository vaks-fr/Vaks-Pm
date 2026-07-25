/**
 * Fonctions PURES de dérivation utilisées par l'interceptor d'audit —
 * extraites pour être testables sans contexte Nest (cf. __tests__/).
 */

export const VERB_BY_METHOD: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/**
 * Dérive un nom d'action depuis le **pattern de route** (`req.route.path`,
 * ex. `/api/v1/tasks/:id/move`) plutôt que de l'URL brute : on distingue
 * ainsi les segments statiques des `:params` / IDs, et on capture la
 * sous-action (`/move`, `/rotate-secret`, …) au lieu de tout réduire à
 * `<resource>.create`. Pour les routes sémantiquement importantes, préférer
 * `@Audited('action.curée')` — cette dérivation reste le filet par défaut.
 */
export function deriveAction(
  routePattern: string,
  method: string,
): { action: string; resource: string } {
  const segs = routePattern.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);
  // Un segment est un "param" s'il est `:x`, un UUID/hex long, ou un nombre.
  const isParam = (s: string) =>
    s.startsWith(':') || /^[0-9a-f-]{8,}$/i.test(s) || /^\d+$/.test(s);
  const statics = segs.filter((s) => !isParam(s));
  let base: string;
  let consumed: number;
  if (statics[0] === 'admin' && statics[1]) {
    base = `admin.${statics[1]}`;
    consumed = 2;
  } else {
    base = statics[0] ?? 'unknown';
    consumed = 1;
  }
  const verb = VERB_BY_METHOD[method] ?? method.toLowerCase();
  const trailing = statics.slice(consumed);
  let action: string;
  if (trailing.length > 0) {
    // Sous-action / sous-ressource (ex. `tasks.move`, `webhooks.rotate-secret`,
    // `projects.teams`). On garde le verbe HTTP pour les non-POST afin de ne
    // pas perdre la nature de l'opération (ex. `projects.teams.delete`).
    const sub = trailing[trailing.length - 1];
    action = method === 'POST' ? `${base}.${sub}` : `${base}.${sub}.${verb}`;
  } else {
    action = `${base}.${verb}`;
  }
  return { action, resource: base };
}

/** Valeur du DERNIER `:param` du pattern de route (l'entité la plus spécifique). */
export function lastParamValue(
  routePattern: string,
  params: Record<string, string>,
): string | null {
  const names = routePattern.split('/').filter((s) => s.startsWith(':'));
  const last = names[names.length - 1]?.slice(1);
  return last && params[last] ? params[last] : null;
}

/**
 * Extrait `{ id?, label? }` lisibles depuis un corps JSON (requête ou réponse)
 * — uniquement au premier niveau, valeurs string, liste blanche de champs
 * d'identité. Ne dump jamais l'objet entier ; ignore tableaux / non-objets
 * (listes, blobs, flux de fichiers).
 */
export function identityFrom(body: unknown): { id: string | null; label: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { id: null, label: null };
  }
  const o = body as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  let label: string | null = null;
  for (const k of ['name', 'title', 'label', 'key', 'displayName', 'email', 'filename', 'slug']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      label = v.trim().slice(0, 200);
      break;
    }
  }
  return { id, label };
}
