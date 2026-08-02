/**
 * Tools qui reçoivent le paramètre optionnel `confirmToken`.
 *
 * ⚠️ **Miroir de `DESTRUCTIVE_TOOLS`** (`api/src/mcp/mcp-confirm-scope.ts`),
 * qui reste la source de vérité — c'est l'API qui décide, le serveur MCP ne
 * fait qu'exposer le paramètre. Le précédent est assumé : `MCP_WRITE_SCOPES`
 * dans `mcp-context.controller.ts` est documenté comme un miroir de la même
 * façon.
 *
 * Pourquoi ne pas l'ajouter à tous les tools d'écriture, ce qui supprimerait la
 * duplication : ce paramètre coûterait alors ~2-3 k tokens de description à
 * **chaque** `tools/list`, sur une soixantaine de tools dont l'immense majorité
 * ne sera jamais challengée.
 *
 * Un décalage n'est pas dangereux : si un tool manque ici, l'agent reçoit le
 * défi mais n'a pas le paramètre pour y répondre — visible immédiatement, et
 * jamais une action qui passe sans confirmation.
 */
export const CONFIRM_TOOLS: ReadonlySet<string> = new Set([
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
  'vaks_notify_stakeholders',
  'vaks_plan_project_apply',
  'vaks_resolve_skill_request',
]);
