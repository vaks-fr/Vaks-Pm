import { createHash } from 'crypto';

/** Politique de confirmation d'une organisation. */
export type ConfirmPolicy = 'off' | 'destructive' | 'all_writes';

/**
 * Tools exigeant une confirmation explicite en politique `destructive`.
 *
 * La liste porte sur des **noms de tools**, pas sur des routes, et c'est
 * structurant : plusieurs de ces tools partagent leur route avec un frère
 * bénin. `vaks_plan_project_apply` et `vaks_plan_project_preview` sont le même
 * `POST workload/autoplan` au `persist` près ; `vaks_resolve_skill_request`
 * n'est destructif qu'en `REJECTED`. Router sur la route imposerait soit de
 * sur-challenger, soit de renifler le corps route par route.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'vaks_delete_allocation',
  'vaks_delete_client',
  'vaks_delete_contact',
  'vaks_delete_dependency',
  'vaks_delete_expense',
  'vaks_delete_label',
  'vaks_delete_project_rate',
  'vaks_delete_skill',
  'vaks_delete_task',
  'vaks_delete_time_entry',
  'vaks_delete_time_off',
  'vaks_remove_team_member',
  'vaks_remove_user_skill',
  // Sortant : le seul dont le rayon d'action quitte le système.
  'vaks_notify_stakeholders',
  // Écrit en masse des allocations.
  'vaks_plan_project_apply',
  'vaks_resolve_skill_request',
]);

/** Ce tool doit-il être confirmé sous cette politique ? */
export function requiresConfirmation(policy: ConfirmPolicy, tool: string, isWrite: boolean): boolean {
  if (policy === 'off') return false;
  if (policy === 'all_writes') return isWrite;
  return DESTRUCTIVE_TOOLS.has(tool);
}

/**
 * Empreinte de l'action exacte, pour qu'un jeton obtenu sur une action anodine
 * ne puisse pas en exécuter une autre.
 *
 * `originalUrl` couvre les paramètres de route et la query, donc un jeton émis
 * pour `DELETE tasks/A` ne vaut pas pour `DELETE tasks/B`.
 *
 * `justification` est **exclue volontairement** : un agent la reformule
 * légitimement d'un tour à l'autre, et les deux formulations sont de toute façon
 * auditées séparément. L'exiger identique ferait échouer des confirmations
 * parfaitement valides.
 */
export function argsHash(method: string, originalUrl: string, body: unknown): string {
  const scrubbed = stripVolatile(body);
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${originalUrl}\n${canonicalJson(scrubbed)}`)
    .digest('hex');
}

function stripVolatile(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k === 'justification' || k === 'confirmToken') continue;
    out[k] = v;
  }
  return out;
}

/** JSON à clés triées récursivement : deux corps équivalents donnent le même hash. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
