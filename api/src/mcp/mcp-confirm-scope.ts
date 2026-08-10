import { createHash } from 'crypto';

/** Politique de confirmation d'une organisation. */
export type ConfirmPolicy = 'off' | 'destructive' | 'all_writes';

/**
 * Tools exigeant une confirmation explicite en politique `destructive`.
 *
 * La liste porte sur des **identifiants de tools**, pas sur des routes, et
 * c'est structurant : plusieurs de ces tools partagent leur route avec un
 * frère bénin. `vaks_plan_project_apply` et `vaks_plan_project_preview` sont
 * le même `POST workload/autoplan` au `persist` près ;
 * `vaks_skill_requests:resolve` n'est destructif qu'en `REJECTED`. Router sur
 * la route imposerait soit de sur-challenger, soit de renifler le corps route
 * par route.
 *
 * Depuis la fusion CRUD des tools MCP, un tool groupé transmet son action dans
 * le header `X-Vaks-Mcp-Tool` sous forme composite `tool:action`
 * (ex. `vaks_clients_manage:delete_client`) — seule façon de faire voyager
 * l'action jusqu'ici, un `DELETE` HTTP n'ayant pas de corps. Les entrées
 * composites ne challengent donc que les actions destructrices du tool.
 * Miroir côté serveur MCP : `mcp/src/confirm-tools.ts` (CONFIRM_TOOL_ACTIONS).
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  // Tools dédiés (nom simple).
  'vaks_delete_task',
  // Sortant : le seul dont le rayon d'action quitte le système.
  'vaks_notify_stakeholders',
  // Écrit en masse des allocations.
  'vaks_plan_project_apply',
  // Actions destructrices des tools fusionnés (composite `tool:action`).
  'vaks_time_entries:delete',
  'vaks_time_off_manage:delete',
  'vaks_allocations_manage:delete',
  'vaks_labels_manage:delete',
  'vaks_dependencies_manage:delete',
  'vaks_clients_manage:delete_client',
  'vaks_clients_manage:delete_contact',
  'vaks_teams_manage:remove_member',
  'vaks_skills_catalog:delete',
  'vaks_skills_assign:remove_user',
  'vaks_expenses_manage:delete',
  'vaks_project_finance:delete_rate',
  'vaks_skill_requests:resolve',
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
