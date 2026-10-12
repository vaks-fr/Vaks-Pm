import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient, VaksApiError, withCallContext } from './api-client.js';
import { CONFIRM_TOOL_ACTIONS } from './confirm-tools.js';

/**
 * Tools MCP. Chacun n'est qu'un appel à un endpoint `@PublicApi` existant de
 * l'API, exécuté avec le jeton de l'utilisateur (donc borné à son périmètre
 * RBAC). Les tools d'écriture ne sont enregistrés que si le jeton porte des
 * scopes d'écriture (`allowWrite`, dérivé de `me/mcp-context`), et la surface
 * est filtrée par nature d'acteur (humain / agent).
 */

/**
 * Décode `input` avec `decodeURIComponent` de façon répétée jusqu'à point fixe
 * (gère l'encodage imbriqué type `%252e%252e` = `..` doublement encodé),
 * borné à 5 itérations pour ne jamais boucler sur une entrée pathologique.
 * Ne throw jamais : une séquence `%` malformée (ex. `100%`) renvoie la
 * dernière valeur décodable telle quelle plutôt que de faire échouer la
 * validation avec une erreur peu claire.
 */
export function decodeFully(input: string): string {
  let current = input;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * SÉCURITÉ — Empêche la traversée hors de l'arbre `@PublicApi` pour `vaks_read`.
 * Sans ça un `path` comme `../internal/...` ou `../admin/...` — y compris ses
 * formes **encodées** (`%2e%2e`, `.%2e`, `%2e.`, doublement encodées
 * `%252e%252e`, ou via un slash encodé `foo%2f..%2f..%2finternal`) — se
 * normalise une fois concaténé à la base et atteint des routes voisines : le
 * parseur WHATWG `URL` de Node décode et collapse ces dot-segments avant que
 * la requête ne parte. Le public-gate API bloque ces routes côté serveur,
 * mais on ne dépend pas que de lui : défense en profondeur, comme l'annonce
 * la description du tool.
 *
 * On compare des **segments de chemin** après décodage intégral (pas une
 * recherche de sous-chaîne '..' sur le texte brut) : plus strict sur les
 * formes encodées, et ça évite au passage un faux-positif sur un segment
 * légitime qui contiendrait '..' comme partie d'un nom plus large.
 */
export function assertSafeReadPath(rawPath: string): string {
  const clean = rawPath.replace(/^\/?(api\/v1\/)?/, '');
  const decoded = decodeFully(clean);
  const segments = decoded.split(/[/\\]+/);
  const hasTraversal = segments.some((s) => s === '..' || s === '.');
  if (hasTraversal || decoded.startsWith('/') || clean.startsWith('/')) {
    throw new Error('Invalid path (traversal not allowed).');
  }
  return clean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Résout un projet désigné par NOM ou CLÉ (pas un UUID) vers son id, via le
 * filtre `q` de `GET /projects?scope=all&q=`. Sert `vaks_project_status` :
 * l'appelant n'a jamais besoin de passer par `vaks_list_projects` pour un
 * simple nom. `scope=all` n'est honoré côté API que si l'appelant a le droit
 * de tout voir — sinon la recherche reste bornée à son périmètre RBAC, ce qui
 * est le comportement voulu (pas de fuite, juste moins de matches possibles).
 */
async function resolveProjectId(api: ApiClient, query: string): Promise<string> {
  const results = (await api.get('projects', { scope: 'all', q: query })) as Array<{
    id: string;
    key?: string;
    name?: string;
    client?: { name?: string } | null;
  }>;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(
      `No project matches "${query}". Check the spelling, or call \`vaks_list_projects\` to see the available ones.`,
    );
  }
  if (results.length === 1) return results[0].id;
  const candidates = results
    .map((p) => `- ${p.key ?? '?'} — ${p.name ?? '?'}${p.client?.name ? ` (${p.client.name})` : ''}`)
    .join('\n');
  throw new Error(
    `Several projects match "${query}", please be more specific (name, key, or client):\n${candidates}`,
  );
}

/** Enveloppe un appel API en réponse MCP, avec gestion d'erreur exploitable. */
async function run(fn: () => Promise<unknown>) {
  try {
    const data = await fn();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  } catch (e) {
    if (e instanceof VaksApiError) {
      const challenge = confirmationChallenge(e);
      if (challenge) return challenge;
    }
    const msg = e instanceof VaksApiError ? e.message : (e as Error).message;
    return {
      isError: true,
      content: [{ type: 'text' as const, text: msg }],
    };
  }
}

/**
 * Rend un défi de confirmation (409 `CONFIRMATION_REQUIRED`) comme un résultat
 * **normal**, et non comme une erreur.
 *
 * Ce n'est pas cosmétique : un agent qui reçoit `isError: true` s'excuse très
 * souvent et s'arrête là, alors qu'un résultat ordinaire énonçant l'étape
 * suivante est suivi. Le but du garde-fou est que l'action soit re-formulée,
 * pas qu'elle soit abandonnée.
 */
function confirmationChallenge(e: VaksApiError) {
  const body = e.body as
    | { code?: string; confirmToken?: string; impact?: Record<string, unknown>; expiresInSec?: number }
    | undefined;
  if (e.status !== 409 || body?.code !== 'CONFIRMATION_REQUIRED' || !body.confirmToken) return null;
  const t = body.impact?.target as { type?: string; id?: string; label?: string } | undefined;
  const cible = t?.label ?? (t?.type && t?.id ? `${t.type} ${t.id}` : 'the target resource');
  const lines = [
    `⚠️ This action requires explicit confirmation before it can be executed.`,
    ``,
    `Action  : ${String(body.impact?.tool ?? 'unknown')}`,
    `Target  : ${cible}`,
    `Validity: ${body.expiresInSec ?? 600} seconds`,
    ``,
    `Present this to the user. If they confirm, call the EXACT same tool`,
    `with the same arguments plus: confirmToken: "${body.confirmToken}"`,
    `(the arguments must be identical, otherwise the token is rejected).`,
  ];
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

/**
 * Tools an AUTONOMOUS agent (actorKind=AGENT) is allowed to SEE. A human driving
 * MCP (delegated OAuth, human PAT, or org key — anything with actorKind !== 'AGENT')
 * keeps the full surface, gated only by `allowWrite` exactly as before.
 *
 * This bounds an agent to its work loop (discover → understand → decompose →
 * produce → validate → collaborate) and hides the org/finance/team/client/settings
 * management it must never drive. It ALSO keeps an agent's tool count well under
 * client-side caps (e.g. Copilot Studio limits an agent to 70 tools).
 *
 * Note: this is a *visibility* allowlist. Actual authorization stays server-side
 * (RBAC ∩ scopes ∩ capabilities) — a tool listed here still 403s if the agent's
 * token doesn't permit it (e.g. validation tools without `deliverables:validate`).
 */
const AGENT_ELIGIBLE_TOOLS = new Set<string>([
  // discover & claim
  'vaks_next_task',
  'vaks_claim_next_task',
  'vaks_list_my_tasks',
  'vaks_claim_task',
  'vaks_list_projects',
  'vaks_list_project_tasks',
  'vaks_get_tasks_in_window',
  // understand the work
  'vaks_get_task',
  'vaks_get_work_context',
  'vaks_get_task_comments',
  'vaks_get_verification_requirements',
  'vaks_get_project_health',
  'vaks_project_status',
  'vaks_list_context_files',
  'vaks_get_context_file',
  'vaks_read',
  'vaks_list_readable_endpoints',
  // decompose
  'vaks_create_subtask',
  'vaks_get_subtasks_summary',
  // produce & submit for review
  'vaks_update_task',
  'vaks_submit_deliverable',
  'vaks_report_run',
  'vaks_submit_for_review',
  // validate (agent-as-validator)
  'vaks_claim_validation_task',
  'vaks_validation_heartbeat',
  'vaks_submit_validation',
  // collaborate & lifecycle
  'vaks_post_comment',
  'vaks_request_assistance',
  'vaks_execution_heartbeat',
  'vaks_release_task',
]);

/**
 * Miroir du filtre agent : tools de la BOUCLE MACHINE (pull, baux/heartbeats,
 * livrables, validation par agent) qu'un HUMAIN pilotant MCP n'appelle jamais —
 * il a l'app web pour ça. Les masquer réduit la surface humaine (~97 → ~50,
 * sous le cap de 70 de Copilot Studio) et surtout le bruit de sélection du
 * modèle. `claim_task` / `release_task` / `submit_for_review` restent visibles
 * humain (pilotage manuel plausible d'une tâche déléguée).
 *
 * Comme `AGENT_ELIGIBLE_TOOLS`, c'est de la *visibilité* : l'autorisation
 * réelle reste server-side.
 */
const AGENT_LOOP_ONLY_TOOLS = new Set<string>([
  'vaks_next_task',
  'vaks_claim_next_task',
  'vaks_execution_heartbeat',
  'vaks_get_work_context',
  'vaks_get_verification_requirements',
  'vaks_submit_deliverable',
  'vaks_report_run',
  'vaks_claim_validation_task',
  'vaks_validation_heartbeat',
  'vaks_submit_validation',
  'vaks_request_assistance',
]);

/**
 * Enregistre les tools sur le serveur. `allowWrite` (dérivé des scopes du jeton
 * via `GET /me/mcp-context`) pilote l'exposition des tools d'**écriture** : si
 * l'org n'a pas activé `mcp.allowWrites`, le jeton ne porte pas les scopes
 * correspondants → on **ne déclare même pas** ces tools (plutôt que de les
 * lister et qu'ils échouent en 403). Les tools de lecture sont toujours exposés.
 *
 * `actorKind` (aussi lu de `/me/mcp-context`) : un agent autonome (`AGENT`) ne
 * voit que `AGENT_ELIGIBLE_TOOLS` ; un humain voit tout SAUF la boucle machine
 * (`AGENT_LOOP_ONLY_TOOLS`).
 *
 * `allowFinance` (toggle org `mcp.allowFinance`, relayé par `/me/mcp-context`) :
 * quand OFF, les tools finance ne sont pas déclarés — même philosophie que
 * `allowWrite` (plutôt que de les lister et qu'ils échouent en 403 via
 * `FinanceApiGateGuard`, qui reste l'enforcement).
 */
export function registerTools(
  server: McpServer,
  api: ApiClient,
  allowWrite: boolean,
  actorKind?: string,
  allowFinance = false,
  billingUnit?: string,
): void {
  const isAgent = actorKind === 'AGENT';
  // Agents facturés en CRÉDITS (Copilot) : leur coût est MESURÉ côté serveur
  // (meter d'appels MCP), pas déclaré. On leur masque `vaks_report_run` — un
  // appel de déclaration serait 5 crédits gaspillés et une source de double
  // comptage. Les agents en tokens (API) le gardent : eux, on mesure vraiment.
  const isCreditsAgent = isAgent && billingUnit === 'credits';
  /**
   * Enregistrement uniforme (chantier agents 1) : chaque tool pose son **nom**
   * en contexte d'audit (`X-Vaks-Mcp-Tool`), et les tools d'ÉCRITURE
   * (`readOnlyHint: false`) reçoivent automatiquement un paramètre optionnel
   * `justification` — la raison en langage naturel de l'action, relayée à l'API
   * (`X-Vaks-Justification`) et conservée dans le journal d'audit. Les types
   * sont volontairement relâchés ici : la validation runtime reste le zod
   * schema de chaque tool.
   */
  const register = (
    name: string,
    def: {
      title: string;
      description: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema?: Record<string, any>;
      annotations?: Record<string, boolean>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra?: any) => Promise<any>,
  ): void => {
    // Autonomous agents see only the bounded work-loop surface; humans see
    // everything EXCEPT the machine loop (still gated by allowWrite below).
    if (isAgent && !AGENT_ELIGIBLE_TOOLS.has(name)) return;
    if (!isAgent && AGENT_LOOP_ONLY_TOOLS.has(name)) return;
    // Credit-billed agents don't self-declare cost — it's server-metered.
    if (isCreditsAgent && name === 'vaks_report_run') return;
    const isWrite = def.annotations?.readOnlyHint === false;
    const inputSchema = isWrite
      ? {
          ...(def.inputSchema ?? {}),
          justification: z
            .string()
            .max(1000)
            .optional()
            .describe(
              'Why this action is being performed (one sentence). Recorded in the audit log — strongly recommended for agents.',
            ),
          // Seulement sur les tools susceptibles d'être challengés : l'ajouter
          // partout coûterait ~2-3 k tokens de description à chaque tools/list.
          // Pour un tool fusionné, seules les ACTIONS destructrices déclenchent
          // le défi — le paramètre reste inoffensif sur les autres.
          ...(CONFIRM_TOOL_ACTIONS.has(name)
            ? {
                confirmToken: z
                  .string()
                  .max(200)
                  .optional()
                  .describe(
                    'DO NOT make this up. If a first call returns a confirmation request, ' +
                      'call this tool again with the SAME arguments plus the token provided. ' +
                      'Only ever needed on destructive actions.',
                  ),
              }
            : {}),
        }
      : def.inputSchema;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(
      name,
      { ...def, inputSchema },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any, extra: any) => {
        const { justification, confirmToken, ...rest } = (args ?? {}) as Record<string, unknown>;
        // Identifiant composite `tool:action` pour les tools fusionnés : seul
        // canal qui fait voyager l'action jusqu'à l'API (un DELETE HTTP n'a pas
        // de corps) — le garde-fou de confirmation, les quotas par tool et
        // l'audit sont keyés sur le header `X-Vaks-Mcp-Tool`.
        const action = typeof rest.action === 'string' && rest.action ? rest.action : undefined;
        // Contexte de COÛT (AGENT_MCP_CALL_METER.md §5) : la tâche — à défaut le
        // projet — sur laquelle porte l'appel, lue dans les arguments que le tool
        // déclare déjà. Sans ça, les appels de N tâches menées en parallèle par
        // le même agent tombent dans un compteur unique et la première tâche qui
        // se termine rafle tout le coût.
        const uuid = (v: unknown): string | undefined =>
          typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
        // `withCallContext` : un batch JSON-RPC fait tourner plusieurs
        // handlers en concurrence sur le même `api`, et un champ mutable
        // ferait attribuer la justification au mauvais tool dans le journal
        // d'audit (cf. `callContextStore` dans api-client.ts).
        return withCallContext(
          {
            tool: action ? `${name}:${action}` : name,
            justification:
              typeof justification === 'string' && justification.trim() ? justification : undefined,
            confirmToken:
              typeof confirmToken === 'string' && confirmToken.trim() ? confirmToken.trim() : undefined,
            taskId: uuid(rest.taskId),
            projectId: uuid(rest.projectId),
          },
          () => handler(rest, extra),
        );
      },
    );
  };

  /** Erreur de validation runtime d'un tool fusionné (rendue `isError` par `run`). */
  const need = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(msg);
  };

  register(
    'vaks_list_projects',
    {
      title: 'List projects',
      description:
        'Lists the projects visible to the current user (according to their RBAC scope). ' +
        'Use `scope=all` to attempt to include all projects in the organization ' +
        '(only honored if the user has permission to see everything).',
      inputSchema: {
        scope: z
          .enum(['mine', 'all'])
          .optional()
          .describe("Scope: 'mine' (default) = accessible projects; 'all' = whole portfolio."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scope }) => run(() => api.get('projects', { scope })),
  );

  register(
    'vaks_list_project_tasks',
    {
      title: 'List a project\'s tasks',
      description:
        'Lists the tasks of a given project. Optional filters by status and by assignee. ' +
        'First fetch the project id via `vaks_list_projects`.',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
        status: z
          .string()
          .optional()
          .describe('Status filter (e.g. TODO, IN_PROGRESS, DONE) — optional.'),
        assigneeId: z.string().uuid().optional().describe('Filter by assignee (UUID) — optional.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId, status, assigneeId }) =>
      run(() => api.get(`projects/${projectId}/tasks`, { status, assigneeId })),
  );

  register(
    'vaks_get_workload',
    {
      title: 'Workload (capacity vs allocated)',
      description:
        'Aggregates workload per person and per day over a date window ' +
        '(capacity vs allocated hours), to spot over/under-load. ' +
        'Dates in ISO format (YYYY-MM-DD).',
      inputSchema: {
        from: z.string().describe('Window start (YYYY-MM-DD).'),
        to: z.string().describe('Window end (YYYY-MM-DD).'),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe('Restrict to a project (UUID) — optional.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to, projectId }) =>
      run(() => api.get('workload', { from, to, projectId })),
  );

  // --- Palier 1 : diagnostic d'affectation (lecture seule) ---

  register(
    'vaks_get_skill_gap',
    {
      title: 'Skill coverage of a project',
      description:
        'For a project, assesses coverage of the required skills: who is qualified ' +
        'AND actually available (free capacity day by day = schedule × occupancy − time-off ' +
        '− holidays − allocations), the remaining effort to cover, and the "near-qualified" candidates ' +
        '(training). Use to answer "who can take this load?" before assigning.',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => run(() => api.get(`projects/${projectId}/skills/gap`)),
  );

  register(
    'vaks_suggest_assignees',
    {
      title: 'Suggest assignees for a task',
      description:
        'Proposes the best candidates for a task, cross-referencing required skills ' +
        'and actual availability over a date window. Returns a ranking (skill match + ' +
        'free capacity). Fetch the task id via `vaks_list_project_tasks`. Only a ' +
        'suggestion — assigns nothing.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
        from: z.string().optional().describe('Window start (YYYY-MM-DD) — optional.'),
        to: z.string().optional().describe('Window end (YYYY-MM-DD) — optional.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId, from, to }) =>
      run(() => api.get(`tasks/${taskId}/assignee-suggestions`, { from, to })),
  );

  register(
    'vaks_get_task',
    {
      title: 'Task detail',
      description:
        'Returns the full detail of a task (status, estimate, logged time, assignees, due dates, ' +
        'required skill, dependencies). Useful before suggesting an assignment or analyzing a delay.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}`)),
  );

  register(
    'vaks_get_work_context',
    {
      title: 'Full work context of a task',
      description:
        'EVERYTHING needed to properly carry out a task, in ONE call: the project brief ' +
        '(`project.brief`, composed markdown = role/mission, output conventions, where to deposit ' +
        'deliverables, out-of-scope, PLUS the facts the application already knows — reviewer, ' +
        'verification mode, stakes, language — and the PM\'s free-form notes last), the project ' +
        '`charter` (in/out scope, deliverables, constraints, success criteria), the ' +
        'guardrails (project AND task), the acceptance criteria (review checklist), the task ' +
        'detail, the log of previously APPROVED deliverables (continuity), the context ' +
        'documents (`projectDocuments`; `projectDocumentsMeta.truncated:true` = not everything is ' +
        'listed) and recent comments. ' +
        'ALSO carries `upstreamOutputs`: the key/value pairs produced by UPSTREAM tasks ' +
        '(predecessors and subtasks) whose deliverable was APPROVED — endpoint, version, ' +
        'identifiers. Read them from there rather than looking for them in the text of upstream deliverables. ' +
        'Two other decisive blocks: `reviewFeedback` (if a deliverable was rejected — the EXACT ' +
        'note from the validator and the version history: start there, it is your rework ' +
        'instruction) and `limits` (execution lease, number of rejections left before human escalation, ' +
        'remaining € budget envelopes — if `limits.budget.stop` is true, produce no more). ' +
        'Budget envelopes are always in €, whatever the provider bills in (tokens or credits); when ' +
        'you later declare consumption via `vaks_report_run`, credit-billed providers (Copilot) put ' +
        'the credit count in `tokensIn` with `tokensOut` = 0. ' +
        'CALL AFTER claiming a task, BEFORE producing anything. ' +
        'If a criterion is ambiguous or context is missing, ask a question via `vaks_post_comment` ' +
        'rather than guessing.',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the claimed task.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/work-context`)),
  );

  register(
    'vaks_list_context_files',
    {
      title: 'List documents from an external source (SharePoint…)',
      description:
        'Lists the files and folders of an external document source attached to the task\'s ' +
        'project — in v1 the SharePoint of the provisioned Microsoft Teams team. Live proxy ' +
        '(no copy). Paginated: pass `cursor` for the next page, `folderId` to enter ' +
        'a folder. Source availability is indicated in `vaks_get_work_context` ' +
        '(`contextSources`). Error codes: `FS_DISABLED`/`FS_GRANT_PENDING`/`FS_SOURCE_UNAVAILABLE` ' +
        '= the source is not usable on this project (do not retry).',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
        source: z.string().optional().describe("Source (default 'sharepoint')."),
        folderId: z.string().optional().describe('Folder to open (root if absent).'),
        cursor: z.string().optional().describe('Pagination cursor (next page).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId, source, folderId, cursor }) => {
      const qs = new URLSearchParams();
      if (source) qs.set('source', source);
      if (folderId) qs.set('folderId', folderId);
      if (cursor) qs.set('cursor', cursor);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return run(() => api.get(`tasks/${taskId}/context-files${suffix}`));
    },
  );

  register(
    'vaks_get_context_file',
    {
      title: 'Read the text of a document from an external source',
      description:
        'Returns the extracted TEXT of a file from an external source (SharePoint…), to use ' +
        'as context. Supported formats: text, Markdown, CSV/JSON, Word (.docx), ' +
        'Excel (.xlsx), PDF. The text is capped (~64 KB): `truncated:true` signals a cut. ' +
        '`FS_FILE_TOO_LARGE` (file > 10 MB) and `FS_UNSUPPORTED_FORMAT` (image, archive…) ' +
        'return the metadata without content. Fetch the `itemId` via `vaks_list_context_files`.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
        source: z.string().describe("Source (e.g. 'sharepoint')."),
        itemId: z.string().describe('Id of the item returned by the listing.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId, source, itemId }) =>
      run(() => api.get(`tasks/${taskId}/context-files/${encodeURIComponent(source)}/${encodeURIComponent(itemId)}`)),
  );

  // --- Radar de risque (lecture seule) ---

  register(
    'vaks_get_project_health',
    {
      title: 'Project health (stats + due-date adherence)',
      description:
        'Snapshot of a project\'s health: statistics (progress, overdue tasks, ' +
        'estimated vs actual) AND due-date adherence (rate of tasks delivered on time). Use ' +
        'to diagnose a project flagged as at-risk via `vaks_list_projects`.',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) =>
      run(async () => {
        const [stats, dueAdherence] = await Promise.all([
          api.get(`projects/${projectId}/stats`),
          api.get(`projects/${projectId}/due-adherence`),
        ]);
        return { stats, dueAdherence };
      }),
  );

  register(
    'vaks_project_status',
    {
      title: 'Project status (one-call digest)',
      description:
        'ONE-CALL project status digest: progress stats, due-date adherence, tasks within a ' +
        'date window, and team workload — everything `vaks_get_project_health` + ' +
        '`vaks_list_project_tasks` + `vaks_get_tasks_in_window` + `vaks_get_workload` would ' +
        'return together, gathered server-side into a SINGLE tool call. Accepts the project ' +
        'NAME, KEY, or UUID directly — no need to resolve the id first via `vaks_list_projects`. ' +
        'If the name matches several projects, the error message lists the candidates so you can ' +
        'ask which one. Prefer this tool over the individual reads whenever asked for a project\'s ' +
        'status/health/overview.',
      inputSchema: {
        project: z.string().describe('Project name, key, or UUID.'),
        from: z.string().optional().describe('Window start (YYYY-MM-DD) — optional, server default.'),
        to: z.string().optional().describe('Window end (YYYY-MM-DD) — optional, server default.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ project, from, to }) =>
      run(async () => {
        const projectId = UUID_RE.test(project) ? project : await resolveProjectId(api, project);
        return api.get(`projects/${projectId}/status`, { from, to });
      }),
  );

  register(
    'vaks_get_tasks_in_window',
    {
      title: 'Project tasks within a date window',
      description:
        'Lists the tasks of a project whose due date (or activity) falls within a window ' +
        '[from, to]. Ideal for spotting imminent or overdue deadlines. ISO dates (YYYY-MM-DD).',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
        from: z.string().describe('Window start (YYYY-MM-DD).'),
        to: z.string().describe('Window end (YYYY-MM-DD).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId, from, to }) =>
      run(() => api.get(`projects/${projectId}/tasks-in-window`, { from, to })),
  );

  // --- Collaboration & compétences (lecture) ---

  register(
    'vaks_get_task_comments',
    {
      title: 'Task comments',
      description:
        'Lists a task\'s comments (discussion thread, @mentions). Fetch the task id ' +
        'via `vaks_list_project_tasks` or `vaks_get_task`. Useful to understand the context, ' +
        'blockers or decisions of a task.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/comments`)),
  );

  register(
    'vaks_get_user_skills',
    {
      title: 'A user\'s skills',
      description:
        'Lists the skills (with level) assigned to a user. Fetch user ids ' +
        'via `vaks_suggest_assignees`, `vaks_get_task` (assignees) or `vaks_list_teams` ' +
        '(members). Useful to assess who masters what.',
      inputSchema: {
        userId: z.string().uuid().describe('User id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ userId }) => run(() => api.get(`users/${userId}/skills`)),
  );

  register(
    'vaks_list_teams',
    {
      title: 'List teams',
      description:
        'Lists the organization\'s teams (with their members and leads). Used in particular to ' +
        'find a team\'s `teamId` to address a skill request to its lead ' +
        'via `vaks_skill_requests`.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('teams')),
  );

  register(
    'vaks_list_skills',
    {
      title: 'Organization skill catalog',
      description:
        'Lists the org\'s full skill catalog (name, category, color). This is the ' +
        'reference: use it to know which skills exist, propose an existing skill ' +
        'in a request (`vaks_skill_requests`), or match a need to a known skill.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('skills')),
  );

  register(
    'vaks_list_labels',
    {
      title: 'Project labels',
      description:
        'Lists a project\'s labels, with their color. Used to know the existing labels ' +
        'before applying them to a task (via `vaks_update_task` / `vaks_create_tasks`, labelIds field) ' +
        'or creating a new one (`vaks_labels_manage`).',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => run(() => api.get(`projects/${projectId}/labels`)),
  );

  // Lecture finance : même gate d'exposition que les écritures finance — pas
  // déclaré quand l'org n'expose pas la finance à l'IA (le guard API refuse de
  // toute façon).
  if (allowFinance) {
    register(
      'vaks_list_expenses',
      {
        title: 'Non-labor costs of a project',
        description:
          'Lists a project\'s non-labor costs: licenses, hardware, cloud, ' +
          'subcontracting, other — with internal amount and re-billed amount. ⚠️ Requires that ' +
          'the admin has enabled "Expose finance to AI" (otherwise refused) AND that the user has the ' +
          'finance permission. Use to fetch the `expenseId` before a `vaks_expenses_manage` update/delete.',
        inputSchema: {
          projectId: z.string().uuid().describe('Project id (UUID).'),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ projectId }) => run(() => api.get(`projects/${projectId}/expenses`)),
    );
  }

  // --- Lecture générique : « tout ce que l'utilisateur peut voir dans l'app » ---
  // Le jeton de lecture porte le périmètre « view » complet du RBAC du user ;
  // ces deux tools permettent d'atteindre N'IMPORTE QUEL endpoint de lecture
  // (clients, contacts, Gantt, dépendances, timesheet, finance, rapports,
  // jours fériés, membres…), borné par le RBAC (403 si non autorisé) et limité
  // au GET (lecture seule). Les tools dédiés ci-dessus restent préférables pour
  // les usages courants — ceux-ci couvrent le reste.

  register(
    'vaks_export_status',
    {
      title: 'Status of an async export',
      description:
        'Queries an export started by `vaks_export_start`. Statuses: QUEUED, RUNNING, DONE, ' +
        'FAILED, STALE. When DONE, `downloadUrl` gives the download link — it remains ' +
        'subject to access control, it is not public. Re-query every few ' +
        'seconds rather than in a tight loop.',
      inputSchema: {
        jobId: z.string().describe('Id of the job returned by `vaks_export_start`.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId }) => run(() => api.get(`exports/${encodeURIComponent(jobId)}`)),
  );

  register(
    'vaks_list_readable_endpoints',
    {
      title: 'Discover available read endpoints',
      description:
        'Returns the list of GET endpoints of the public Vaks-PM API (path + summary + ' +
        'parameters), to know what to read via `vaks_read`. Actual visibility remains bounded ' +
        'by the user\'s permissions (a listed endpoint may return 403 depending on the role).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const spec = (await api.get('openapi.json')) as {
          paths?: Record<
            string,
            Record<string, { summary?: string; operationId?: string; parameters?: Array<{ name?: string }> }>
          >;
        };
        const endpoints: Array<{ path: string; summary: string; params: string[] }> = [];
        for (const [p, methods] of Object.entries(spec.paths ?? {})) {
          const g = methods?.['get'];
          if (!g) continue;
          endpoints.push({
            path: p.replace(/^\/api\/v1\//, ''),
            summary: g.summary || g.operationId || '',
            params: (g.parameters ?? []).map((x) => x.name).filter((n): n is string => !!n),
          });
        }
        return { count: endpoints.length, endpoints };
      }),
  );

  register(
    'vaks_read',
    {
      title: 'Generic API read (advanced)',
      description:
        'Performs a GET on any READ endpoint of the API (relative path under ' +
        '/api/v1, without the prefix). Bounded by the user\'s permissions (RBAC) → 403 if not ' +
        'authorized; read-only. Discover paths via `vaks_list_readable_endpoints`. ' +
        'Examples: "clients", "clients/<id>/contacts", "projects/<id>/gantt", ' +
        '"projects/<id>/dependencies", "timesheet" (from/to params), "users" (directory), ' +
        '"me/pending-reviews" (deliverables awaiting review), "projects/<id>/budget-summary" ' +
        'and "projects/<id>/evm" (finance — subject to the org toggle `mcp.allowFinance`, else 403). ' +
        '⚠️ "projects/<id>/budget" only exists for writes (PUT): for reads, use ' +
        '"budget-summary". Prefer the dedicated tools when they exist.',
      inputSchema: {
        path: z.string().min(1).describe('Relative path under /api/v1 (without prefix).'),
        query: z
          .record(z.string())
          .optional()
          .describe('Optional query parameters, e.g. { from: "2026-06-01", to: "2026-06-30" }.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, query }) => {
      const clean = assertSafeReadPath(path);
      return run(() => api.get(clean, query));
    },
  );

  register(
    'vaks_list_my_tasks',
    {
      title: 'My tasks',
      description:
        'Lists the tasks assigned to the current actor (agent or user) across their ' +
        'ACTIVE projects, excluding completed tasks. This is the starting point of a work loop: ' +
        'fetch a task to move forward (see `vaks_claim_task`, then `vaks_get_task`).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('me/tasks')),
  );

  register(
    'vaks_next_task',
    {
      title: 'My next task',
      description:
        'Returns the BEST claimable task for the current actor, with no side effect ' +
        '(pull model). The selection only keeps TODO tasks of active, agent-enabled projects ' +
        'you are a member of, whose prerequisites (FS) are done and whose required skills ' +
        'are covered, and discards those refused by a policy. Sorted by priority, ' +
        'due date, unblocked tasks and skill fit. Response: `{ task, reason, ' +
        'candidates }` (task=null if nothing — see `reason`). To get it AND claim it in one ' +
        'step, use `vaks_claim_next_task`.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('me/next-task')),
  );

  register(
    'vaks_get_verification_requirements',
    {
      title: 'Verification requirement of a task',
      description:
        'Returns the level of PROOF expected to get a deliverable approved on a task, from ' +
        'the current actor\'s point of view. Call BEFORE working: you will know whether it is enough ' +
        'to declare the result (`self_attest`), whether you must attach tool/test output ' +
        '(`tool_output`), a signed CI (`ci_signed`) or a human review. Response: ' +
        '`{ requiredFloor, requiredMethods[], baseFloor, escalatedToHuman, capabilitiesAvailable[], ' +
        'mode, stakes, trust }`. The requirement depends on the task\'s stakes, your ' +
        'trust level and the verification means available on the project.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/verification-requirements`)),
  );

  // --- Palier 2 : écriture (gated par le toggle org `mcp.allowWrites`) ---
  // Masqués côté serveur si le jeton ne porte pas les scopes d'écriture (org
  // sans `mcp.allowWrites`). Le RBAC du user borne aussi (un simple membre ne
  // peut pas créer de projet) → même un write tool exposé peut renvoyer 403.
  if (!allowWrite) return;

  register(
    'vaks_export_start',
    {
      title: 'Start an async export',
      description:
        'Starts a long export and returns IMMEDIATELY a job id — the file is ' +
        'not produced in this call. Track progress with `vaks_export_status`, which will give ' +
        'a download link once DONE. Use when a synchronous export risks ' +
        'being too long (large volume). Available type: `me_data_json` (all your ' +
        'personal data — GDPR portability).',
      inputSchema: {
        kind: z
          .enum(['me_data_json'])
          .describe('Export type. `me_data_json` = the user\'s personal data.'),
      },
      // Écriture au sens « consomme des ressources et crée un artefact », d'où
      // l'héritage automatique du paramètre `justification`.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ kind }) => run(() => api.post('exports', { kind })),
  );

  register(
    'vaks_claim_task',
    {
      title: 'Claim a task',
      description:
        'Claims a free task (status TODO): it moves to CLAIMED and is assigned to you. ' +
        'Atomic operation — if another actor claims it at the same time, one of the two receives ' +
        'a conflict error. Respects the agent\'s budgets (concurrent tasks, claims/day). ' +
        'Then follow with a status update to IN_PROGRESS, then the work. ' +
        '⚠️ Claiming opens a time-limited EXECUTION LEASE: call ' +
        '`vaks_execution_heartbeat` regularly during long work, otherwise the task is ' +
        'taken back from you and returned to the pool (`leaseExpiresAt` in the work context).',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the task to claim.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/claim`, {})),
  );

  register(
    'vaks_claim_next_task',
    {
      title: 'Pull and claim my next task',
      description:
        'Selects the best claimable task (like `vaks_next_task`) AND claims it ' +
        'atomically, trying the best candidates until the first claim that succeeds. This is ' +
        'the heart of the autonomous work loop: call this, then move the task to IN_PROGRESS, ' +
        'do the work, submit a deliverable (`vaks_submit_deliverable`) and request review ' +
        '(`vaks_submit_for_review`). Respects all guardrails (budgets, review backpressure, ' +
        'client model allowlist, policies). Response: `{ claimed, reason }` (claimed=null if ' +
        'no task could be claimed — see `reason`).',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => run(() => api.post('me/next-task/claim', {})),
  );

  register(
    'vaks_release_task',
    {
      title: 'Release a claimed task',
      description:
        'Releases a task you had claimed (CLAIMED → TODO): it becomes available again ' +
        'for another actor, and your claim assignment is removed.',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the task to release.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/release`, {})),
  );

  register(
    'vaks_request_assistance',
    {
      title: 'Request help on the current task',
      description:
        'Flags a blocker on the task you hold and **alerts someone specifically ' +
        'concerned**, unlike a plain comment. Three effects: your question is posted ' +
        'on the task, a skill request goes to the lead of the team that covers the ' +
        'missing skill (the team is chosen by the server — you designate no one), and ' +
        'if `pause` is true the task is paused with your question as the reason (it stays ' +
        'yours, no one takes it back, it awaits a human answer). ' +
        'Prefer this over guessing: a deliverable produced on a wrong assumption costs everyone a ' +
        'review cycle.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task you hold.'),
        question: z
          .string()
          .min(1)
          .describe('What is blocking you, precisely. Will be read by a human — be concrete.'),
        skillId: z
          .string()
          .uuid()
          .optional()
          .describe('Missing skill (see `vaks_list_skills`). Default: the one required by the task.'),
        proposedSkillName: z
          .string()
          .optional()
          .describe('Skill absent from the catalog, if none matches.'),
        pause: z
          .boolean()
          .optional()
          .describe('Pause the task while awaiting the answer (recommended if you are truly blocked).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, question, skillId, proposedSkillName, pause }) =>
      run(() =>
        api.post(`tasks/${taskId}/assistance`, { question, skillId, proposedSkillName, pause }),
      ),
  );

  register(
    'vaks_create_subtask',
    {
      title: 'Break the current task into subtasks',
      description:
        'Creates a SUBTASK of the task you hold, when the work turns out too large or ' +
        'requires a skill you do not have. Server constraints: the parent must be a ' +
        'task you have claimed (409/403 otherwise), the subtask lives in the same project, and ' +
        'you can only go down ONE level (a subtask is not re-split — flag the need in a ' +
        'comment). You cannot set a budget, stakes or acceptance criteria on it: ' +
        'these are human decisions. The subtask is born TODO and can be pulled by another ' +
        'actor (`vaks_next_task`) — specify `requiredSkillId` if it needs a particular ' +
        'skill. The parent\'s agent budget COVERS its subtasks: splitting does not open ' +
        'an additional envelope. ' +
        '⚠️ A subtask is a HAND-OFF: you know why you are splitting, whoever ' +
        'picks it up will not. The `description` is therefore mandatory and must be enough to work ' +
        'without you. Subtask deliverables count toward the parent: it cannot go ' +
        'to review unless ALL its subtasks are closed and proven at the required level.',
      inputSchema: {
        parentTaskId: z.string().uuid().describe('Task you hold and that is being split.'),
        title: z.string().min(1).describe('Subtask title.'),
        description: z
          .string()
          .min(60)
          .describe(
            'MANDATORY: precisely what is to be done, what is already known or decided, and what ' +
              'the expected result looks like. Write it for someone who does not have your context.',
          ),
        estimateHours: z.number().positive().optional().describe('Estimated effort in hours.'),
        requiredSkillId: z
          .string()
          .uuid()
          .optional()
          .describe('Required skill (see `vaks_list_skills`) — used for dispatch.'),
        requiredSkillLevel: z.number().int().min(1).optional().describe('Target level on this skill.'),
        dueDate: z.string().optional().describe('Due date (YYYY-MM-DD).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ parentTaskId, title, description, estimateHours, requiredSkillId, requiredSkillLevel, dueDate }) =>
      run(async () => {
        // Le projet n'est pas demandé à l'appelant : il est déduit du parent —
        // un agent ne choisit pas dans quel projet il ouvre du travail.
        const parent = (await api.get(`tasks/${parentTaskId}`)) as { projectId?: string };
        if (!parent?.projectId) throw new Error('Parent task not found.');
        return api.post(`projects/${parent.projectId}/tasks`, {
          parentTaskId,
          title,
          description,
          estimateHours,
          requiredSkillId,
          requiredSkillLevel,
          dueDate,
        });
      }),
  );

  register(
    'vaks_get_subtasks_summary',
    {
      title: 'Subtasks summary',
      description:
        'State of all subtasks of a task + the STRUCTURED OUTPUTS of their approved ' +
        'deliverables, in one call. Read BEFORE consolidating your final deliverable: `allDone` says whether ' +
        'everything is done, `pending` lists the numbers of the subtasks still missing. ' +
        'The `verification` block gives the parent\'s proof floor and the weakest link in ' +
        'the tree: `below` (subtasks under the floor) and `missing` (without an approved deliverable) ' +
        'will prevent submission for review. ' +
        'Consolidating too early is the surest way to be sent back for changes.',
      inputSchema: {
        taskId: z.string().uuid().describe('Parent task (the one you hold).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/subtasks`)),
  );

  register(
    'vaks_execution_heartbeat',
    {
      title: 'Extend the execution lease',
      description:
        'Extends the lease of the task you are executing — call periodically during long ' +
        'work (multi-minute processing, long reasoning chain). Without a heartbeat, the lease ' +
        'expires and the task is automatically returned to the pool (status TODO): another actor ' +
        'will take it and your work will be lost. Fails with `LEASE_LOST` if you no longer hold the ' +
        'task — in that case STOP this work instead of continuing. ' +
        'The response also returns your current LIMITS (`limits`): remaining budget per envelope and ' +
        'number of review rejections. If `limits.budget.stop` is true, stop producing and submit ' +
        'immediately what you have.',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the task in progress.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/heartbeat`, {})),
  );

  register(
    'vaks_submit_deliverable',
    {
      title: 'Submit a deliverable',
      description:
        'Records a deliverable for a task. Provide the produced artifact in one of these ways: ' +
        '`content` (the markdown/text document — vaks-pm stores it on S3 and attaches it, IDEAL for a ' +
        'docs agent), and/or `url` (link to an external repo / doc / PR), plus a natural-language ' +
        '`summary`. Human review is about this deliverable, never about a "it\'s done" declaration. ' +
        'Submit AT LEAST one deliverable before moving the task to review (see `vaks_submit_for_review`).',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
        title: z.string().min(1).describe('Short deliverable title.'),
        content: z
          .string()
          .optional()
          .describe(
            'Text/markdown content of the produced document. Persisted on S3 (Garage) and attached to the ' +
              'deliverable — the recommended way for an agent writing a document.',
          ),
        filename: z
          .string()
          .optional()
          .describe('Filename for `content` (default `<title>.md`).'),
        url: z
          .string()
          .url()
          .optional()
          .describe('URL of the external artifact (repo, doc, PR…). Optional if `content` is provided.'),
        summary: z
          .string()
          .optional()
          .describe('Natural-language summary: what was produced, how, the choices made.'),
        commitSha: z
          .string()
          .optional()
          .describe(
            'SHA of the commit associated with the deliverable (CI proof). Required for the ' +
              '`ci_signed` method: vaks-pm matches the SIGNED CI result received by webhook to this SHA — ' +
              'the `status` you declare for `ci_signed` is ignored in favor of the real CI verdict.',
          ),
        structuredOutputs: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe(
            'STRUCTURED outputs of the deliverable: a FLAT dictionary key → scalar value ' +
              '(e.g. {"api_endpoint":"https://dev.api/v1","artifact_version":"2.4.0"}). Tasks ' +
              'that depend on this one will read them as-is in their work context ' +
              '(`upstreamOutputs`) instead of looking for those values in your text — that is where ' +
              'errors are born. Put the reusable FACTS here (URL, version, schema name, ' +
              'identifier), never the document content. Propagated downstream only if the deliverable ' +
              'is APPROVED.',
          ),
        verification: z
          .object({
            method: z
              .enum(['self_attest', 'tool_output', 'agent_validator', 'ci_signed', 'human'])
              .describe(
                'Proof method (AGENTS_VERIFICATION.md). Call `vaks_get_verification_requirements` ' +
                  'to know the required floor BEFORE working. `ci_signed` = proof signed by the ' +
                  'CI (provide `commitSha`); `self_attest` = plain declaration.',
              ),
            status: z.string().optional().describe('Status (passed / failed / pending). Ignored for `ci_signed` (server-corroborated).'),
            evidence: z.string().optional().describe('Proof link or excerpt — optional.'),
          })
          .optional()
          .describe('Deliverable verification (AGENTS_VERIFICATION.md) — optional.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, title, content, filename, url, summary, commitSha, verification, structuredOutputs }) =>
      run(() =>
        api.post(`tasks/${taskId}/deliverables`, {
          title,
          content,
          filename,
          url,
          justification: summary,
          commitSha,
          verification,
          structuredOutputs,
        }),
      ),
  );

  register(
    'vaks_submit_for_review',
    {
      title: 'Submit a task for review',
      description:
        'Moves a task from IN_PROGRESS to IN_REVIEW for human validation. Requires having submitted ' +
        'at least one deliverable (via `vaks_submit_deliverable`). Depending on org governance, it may also ' +
        'require having declared the task\'s consumption (`vaks_report_run`: tokens/cost) — otherwise ' +
        'error `NO_RUN_DECLARED`. A human reviewer will approve or request ' +
        'changes; if changes are requested, resume the work and resubmit.',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the task to submit for review.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/submit-review`, {})),
  );

  register(
    'vaks_claim_validation_task',
    {
      title: 'Pull a validation task',
      description:
        'Reserved for VALIDATOR agents (`deliverables:validate` capability). Pulls a review task: ' +
        'the backend finds a deliverable submitted by ANOTHER agent, awaiting validation, on a project ' +
        'you are a member of, and leases it to you (30 min lease). Mirror of `vaks_next_task` on the review side. ' +
        'Returns `null` if there is nothing to validate. Then call `vaks_validation_heartbeat` during the ' +
        'review, then `vaks_submit_validation` to render your verdict. You NEVER validate your own work.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => run(() => api.post('me/next-validation/claim', {})),
  );

  register(
    'vaks_validation_heartbeat',
    {
      title: 'Validation heartbeat',
      description:
        'Extends the lease of a validation task you have pulled (keeps it assigned while you ' +
        'examine it). Call periodically during a long review. Fails if the lease has expired or was ' +
        'taken back — in that case pull a task again via `vaks_claim_validation_task`.',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the task of the deliverable under validation.'),
        deliverableId: z.string().uuid().describe('Id (UUID) of the deliverable (= reviewId) under validation.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, deliverableId }) =>
      run(() => api.post(`tasks/${taskId}/deliverables/${deliverableId}/validation-heartbeat`, {})),
  );

  register(
    'vaks_submit_validation',
    {
      title: 'Render a validation verdict',
      description:
        'Renders your validator-agent verdict on a deliverable: `approve` (the deliverable meets the criteria) ' +
        'or `changes_requested` (it needs correction). Your verdict is an independent PROOF (strength 2), not ' +
        'the final human approval. In `enforce` mode and if the required verification is exactly ' +
        '`agent_validator`, an `approve` may auto-approve the task (sometimes re-sampled to a human).',
      inputSchema: {
        taskId: z.string().uuid().describe('Id (UUID) of the deliverable\'s task.'),
        deliverableId: z.string().uuid().describe('Id (UUID) of the deliverable (= reviewId).'),
        verdict: z.enum(['approve', 'changes_requested']).describe('Your verdict.'),
        note: z.string().optional().describe('Justification of the verdict (what works / does not work).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, deliverableId, verdict, note }) =>
      run(() => api.post(`tasks/${taskId}/deliverables/${deliverableId}/validation`, { verdict, note })),
  );

  register(
    'vaks_report_run',
    {
      title: 'Declare the cost of a run',
      description:
        'Declares the consumption of a work run: tokens (input/output) and/or actual cost in €. ' +
        'Call after producing a deliverable — serves traceability and the agent\'s budgets ' +
        '(concurrency, daily/monthly budget, max cost per task). Attach to the `taskId` AND the ' +
        'produced `deliverableId` (required to submit the task for review if the org mandates declaration). ' +
        'The cost of a deliverable is declared ONCE: if you call this again for the same `deliverableId`, ' +
        'the server returns the existing run with `alreadyDeclared:true` and does NOT count the cost twice — ' +
        'do not retry to "make sure". A re-declaration only creates a new run once the deliverable has been ' +
        'rejected and you submit a NEW deliverable version. Providing an explicit `runKey` gives the same ' +
        'idempotency for runs not tied to a deliverable. You only declare your own runs. ' +
        'Billing unit: most providers bill in tokens (input/output). Providers billed in CREDITS ' +
        '(Microsoft Copilot, GitHub Copilot) have a single counter — put the credit count in `tokensIn` ' +
        'and leave `tokensOut` at 0. ' +
        'If your runtime routes model calls through the Vaks LLM gateway, your runs are ALREADY declared ' +
        'automatically (measured per call, idempotent via request-id) — do NOT report them again here, ' +
        'or you would double-count. ' +
        '⚠️ The response carries the state of the cost envelopes (`budget`): if `budget.stop` is true, an ' +
        'envelope is exhausted — stop producing, submit what you have and claim nothing ' +
        'more. If `taskReleased` is true, the task has been TAKEN back from you (human takeover): stop ' +
        'immediately. Declare your runs as you go rather than at the very end — that is what lets ' +
        'the server stop you before the bill spirals.',
      inputSchema: {
        taskId: z.string().uuid().optional().describe('Task worked on (optional).'),
        deliverableId: z.string().uuid().optional().describe('Produced deliverable (to attach).'),
        model: z.string().optional().describe('Model used, e.g. claude-sonnet-5.'),
        tokensIn: z.number().int().nonnegative().optional().describe('Input tokens (or the credit count for credit-billed providers).'),
        tokensOut: z.number().int().nonnegative().optional().describe('Output tokens (leave 0 for credit-billed providers).'),
        cost: z.number().nonnegative().optional().describe('Actual cost in euros (optional: derived from tokens otherwise).'),
        runKey: z.string().min(1).max(200).optional().describe('Stable idempotency key (avoids double-counting on retry).'),
        note: z.string().optional().describe('What the run did (optional).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, deliverableId, model, tokensIn, tokensOut, cost, runKey, note }) =>
      run(() =>
        api.post('agent-runs', { taskId, deliverableId, model, tokensIn, tokensOut, cost, runKey, note }),
      ),
  );

  register(
    'vaks_create_project',
    {
      title: 'Create a project',
      description:
        'Creates a new project. `key` = unique short code (e.g. "ACME"), `name` = label. ' +
        'Requires the org to have enabled AI writes AND the user to have permission to create ' +
        'a project (Admin / Portfolio / Team Manager). The project starts as a draft.',
      inputSchema: {
        key: z
          .string()
          .regex(/^[A-Z0-9]{2,3}$/)
          .describe('Unique short code: 2 to 3 UPPERCASE characters/digits (e.g. "ACM", "AZ").'),
        name: z.string().min(1).describe('Project name.'),
        description: z.string().optional().describe('Description — optional.'),
        billable: z.boolean().optional().describe('Billable project (default true) — optional.'),
        teamIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Teams to attach (UUID) — required for a Team Manager.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ key, name, description, billable, teamIds }) =>
      run(() => api.post('projects', { key, name, description, billable, teamIds })),
  );

  register(
    'vaks_time_entries',
    {
      title: 'Time entries (log / update / delete)',
      description:
        'Manages time entries for the current user. `action`: ' +
        "'log' = record time on a task (requires `taskId`, `date` YYYY-MM-DD, `durationMinutes`); " +
        "'update' = modify an existing entry (requires `id`, partial fields); " +
        "'delete' = remove an entry (requires `id`, destructive — confirmation required).",
      inputSchema: {
        action: z.enum(['log', 'update', 'delete']).describe('Operation to perform.'),
        taskId: z.string().uuid().optional().describe('Target task (UUID) — required for `log`.'),
        id: z.string().uuid().optional().describe('Target entry (UUID) — required for `update`/`delete`.'),
        date: z.string().optional().describe('Day of the entry (YYYY-MM-DD) — required for `log`.'),
        durationMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Duration in minutes — required for `log`.'),
        description: z.string().nullable().optional().describe('Comment — optional.'),
        overtimeMinutes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Declared overtime (minutes, ≤ duration) — `update` only.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, taskId, id, date, durationMinutes, description, overtimeMinutes }) =>
      run(() => {
        if (action === 'log') {
          need(taskId && date && durationMinutes, '`log` requires `taskId`, `date` and `durationMinutes`.');
          return api.post('time-entries', { taskId, date, durationMinutes, description });
        }
        need(id, `\`${action}\` requires \`id\`.`);
        if (action === 'update')
          return api.patch(`time-entries/${id}`, { date, durationMinutes, description, overtimeMinutes });
        return api.delete(`time-entries/${id}`);
      }),
  );

  // --- Staffing assisté : « l'IA orchestre, le MOTEUR calcule » ---
  // On ne fait PAS calculer le timing par l'IA : l'auto-plan connaît capacité,
  // chemin critique (CPM), compétences et priorités. L'IA déclenche, présente
  // l'aperçu à l'humain, puis applique.

  register(
    'vaks_plan_project_preview',
    {
      title: 'Plan a project — preview (applies nothing)',
      description:
        'Computes, via the auto-planning engine, an allocation plan for the WHOLE project ' +
        '(respects real capacity, dependencies/CPM, skills, priorities) **without persisting anything**. ' +
        'Returns the proposed allocations + warnings (deadline overrun, window too ' +
        'short). Present to the user BEFORE applying via `vaks_plan_project_apply`.',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
        preserve: z
          .enum(['manual_autosplit', 'manual', 'none'])
          .optional()
          .describe(
            'What the plan keeps (the past/today is always frozen). ' +
              "'manual_autosplit' (default) keeps manual + auto-split; 'manual' keeps manual; 'none' replans all of the future.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, preserve }) =>
      run(() => api.post('workload/autoplan', { scope: 'project', projectId, persist: false, preserve })),
  );

  register(
    'vaks_plan_project_apply',
    {
      title: 'Plan a project — apply',
      description:
        'Applies the auto-planning plan to the project: creates/replaces the FUTURE allocations ' +
        '(the past and today are frozen). Idempotent (re-applying yields the same plan). ' +
        'Ask the user for confirmation, ideally after `vaks_plan_project_preview`.',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
        preserve: z
          .enum(['manual_autosplit', 'manual', 'none'])
          .optional()
          .describe('Same as preview — default manual_autosplit.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, preserve }) =>
      run(() => api.post('workload/autoplan', { scope: 'project', projectId, persist: true, preserve })),
  );

  // --- Compétences : catalogue + demandes (écriture) ---
  // RBAC fin appliqué côté API : écrire le catalogue = policy `canWriteCatalog`
  // (défaut team_lead/admin) ; demander = policy `canRequestSkill` (PM) ;
  // résoudre = lead de l'équipe destinataire.

  register(
    'vaks_skills_catalog',
    {
      title: 'Skill catalog (create / update / delete / apply pack)',
      description:
        'Manages the organization\'s skill catalog. Reserved for roles authorized to write the ' +
        'catalog (team lead / admin depending on the org policy) — otherwise the API refuses. `action`: ' +
        "'create' = add a skill (requires `name`; idempotent on the name); " +
        "'update' = modify a skill (requires `skillId`, partial fields); " +
        "'delete' = soft-delete a skill (requires `skillId`, destructive — confirmation required); " +
        "'apply_pack' = install/update a skill pack (requires `packId`; list packs via `vaks_read` on `skills/packs`).",
      inputSchema: {
        action: z.enum(['create', 'update', 'delete', 'apply_pack']).describe('Operation to perform.'),
        skillId: z.string().uuid().optional().describe('Target skill (UUID) — required for `update`/`delete`.'),
        name: z.string().min(1).optional().describe('Skill name (e.g. "Kubernetes") — required for `create`.'),
        category: z.string().optional().describe('Family/category (e.g. "DevOps") — optional.'),
        description: z.string().optional().describe('Description — optional.'),
        color: z.string().optional().describe('Hex color (e.g. #3b82f6) — optional.'),
        aliases: z.array(z.string()).optional().describe('Aliases — `update` only.'),
        // Segment de chemin d'une ÉCRITURE : format strict (ids de packs =
        // noms de fichiers `api/prisma/skill-packs/*.json`), sinon `../` dans
        // l'argument réécrirait la cible du POST. (Les autres segments libres —
        // jobId, source/itemId — ne servent qu'à des GET, déjà bornés par le
        // jeton de l'utilisateur.)
        packId: z
          .string()
          .regex(/^[a-z0-9_-]{1,64}$/)
          .optional()
          .describe('Pack id (e.g. aws, backend, methodology…) — required for `apply_pack`.'),
        force: z
          .boolean()
          .optional()
          .describe('`apply_pack` only: re-sync even previously deleted skills.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ action, skillId, name, category, description, color, aliases, packId, force }) =>
      run(() => {
        if (action === 'create') {
          need(name, '`create` requires `name`.');
          return api.post('skills', { name, category, description, color });
        }
        if (action === 'apply_pack') {
          need(packId, '`apply_pack` requires `packId`.');
          return api.post(`skills/packs/${encodeURIComponent(String(packId))}/apply${force ? '?force=1' : ''}`, {});
        }
        need(skillId, `\`${action}\` requires \`skillId\`.`);
        if (action === 'update')
          return api.patch(`skills/${skillId}`, { name, description, color, category, aliases });
        return api.delete(`skills/${skillId}`);
      }),
  );

  register(
    'vaks_skill_requests',
    {
      title: 'Skill requests (request / resolve)',
      description:
        '`action`: ' +
        "'request' = address a skill request to a team's lead (the product notifies the lead by " +
        'email + webhook). Indicate an existing skill (`skillId`) OR propose a new one ' +
        '(`proposedName`). `type`: ASSIGN_SKILL (assign an already-skilled member), TRAINING ' +
        '(train someone), EXTERNAL (external reinforcement). Find the `teamId` via ' +
        "`vaks_list_teams`. Reserved for authorized roles (PM). " +
        "'resolve' = update the status of a request (requires `id` and `status` OPEN→ACK→RESOLVED, " +
        'or REJECTED — confirmation required) — team lead action.',
      inputSchema: {
        action: z.enum(['request', 'resolve']).describe('Operation to perform.'),
        teamId: z.string().uuid().optional().describe('Team whose lead receives the request (UUID) — required for `request`.'),
        type: z
          .enum(['ASSIGN_SKILL', 'TRAINING', 'EXTERNAL'])
          .optional()
          .describe('Nature of the request — required for `request`.'),
        skillId: z.string().uuid().optional().describe('Existing skill (UUID) — or proposedName.'),
        proposedName: z.string().optional().describe('Name of a skill to create — or skillId.'),
        desiredLevel: z.number().int().optional().describe('Desired level — optional.'),
        projectId: z.string().uuid().optional().describe('Project concerned (UUID) — optional.'),
        taskId: z.string().uuid().optional().describe('Task concerned (UUID) — optional.'),
        targetUserId: z.string().uuid().optional().describe('Targeted person (UUID) — optional.'),
        note: z.string().optional().describe('Free-form details / resolution note — optional.'),
        id: z.string().uuid().optional().describe('Request to resolve (UUID) — required for `resolve`.'),
        status: z
          .enum(['OPEN', 'ACK', 'RESOLVED', 'REJECTED'])
          .optional()
          .describe('New status — required for `resolve`.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, id, status, note, ...rest }) =>
      run(() => {
        if (action === 'resolve') {
          need(id && status, '`resolve` requires `id` and `status`.');
          return api.patch(`skill-requests/${id}/status`, { status, note });
        }
        need(rest.teamId && rest.type, '`request` requires `teamId` and `type`.');
        return api.post('skill-requests', { ...rest, note });
      }),
  );

  // --- Cycle de vie des tâches & collaboration (écriture) ---

  register(
    'vaks_update_task',
    {
      title: 'Update a task',
      description:
        'Modifies a task: status (move the work forward), title, description, priority, ' +
        'estimate, dates, labels, assignees — AND a task\'s agent configuration (guardrails, ' +
        'acceptance criteria, agent budget). Usual statuses: TODO, IN_PROGRESS, DONE, ON_HOLD (reason via ' +
        'statusReason). The server validates the allowed status transitions. To assign by ' +
        'skills + availability, first call `vaks_suggest_assignees`. ' +
        '⚠️ The governance fields (`agentGuardrails`, `acceptanceCriteria`, `agentCostBudget`) ' +
        'are refused to an AGENT token — an agent does not set the bar it is judged against. ' +
        'They are intended for a human preparing the task.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
        status: z
          .enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'ON_HOLD'])
          .optional()
          .describe('New status — optional (base statuses, as accepted by PATCH /tasks).'),
        statusReason: z.string().optional().describe('Reason (useful for ON_HOLD) — optional.'),
        title: z.string().optional().describe('New title — optional.'),
        description: z.string().optional().describe('New description — optional.'),
        priority: z
          .enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
          .optional()
          .describe('Priority — optional.'),
        estimateHours: z.number().positive().optional().describe('Estimated effort (h) — optional.'),
        dueDate: z.string().optional().describe('Due date (YYYY-MM-DD) — optional.'),
        startDate: z.string().optional().describe('Planned start (YYYY-MM-DD) — optional.'),
        assigneeIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Replaces the task\'s assignees (UUID). Empty list = unassign — optional.'),
        labelIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Replaces the task\'s labels (UUID, see `vaks_list_labels`) — optional.'),
        agentGuardrails: z
          .string()
          .nullable()
          .optional()
          .describe('Task-specific guardrails for an agent (complements the project\'s). Human only.'),
        acceptanceCriteria: z
          .array(
            z.object({
              text: z.string().min(1).max(500).describe('A "done" criterion.'),
              done: z.boolean().optional().describe('Checked or not (default false).'),
            }),
          )
          .optional()
          .describe(
            'Task review checklist (REPLACES the entire list). Serves as the reviewer\'s grid and ' +
              'frames the agent up front. Human only.',
          ),
        agentCostBudget: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe('Agent cost envelope (€) for this task. null = no cap. Human only.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, ...patch }) => run(() => api.patch(`tasks/${taskId}`, patch)),
  );

  register(
    'vaks_dependencies_manage',
    {
      title: 'Task dependencies (create / update / delete)',
      description:
        'Manages dependencies between tasks (Gantt / critical path). `action`: ' +
        "'create' = link two tasks (requires `predecessorId` and `successorId`; Finish-to-Start by " +
        'default, the server refuses cycles); ' +
        "'update' = change the type or offset of a link (requires `id`); " +
        "'delete' = remove a link (requires `id`, destructive — confirmation required).",
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']).describe('Operation to perform.'),
        id: z.string().uuid().optional().describe('Target dependency (UUID) — required for `update`/`delete`.'),
        predecessorId: z.string().uuid().optional().describe('Predecessor task (UUID) — required for `create`.'),
        successorId: z.string().uuid().optional().describe('Successor task (UUID) — required for `create`.'),
        type: z.enum(['FS', 'SS', 'FF', 'SF']).optional().describe('Link type — default FS.'),
        lagDays: z.number().int().optional().describe('Offset in days — optional.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, id, predecessorId, successorId, type, lagDays }) =>
      run(() => {
        if (action === 'create') {
          need(predecessorId && successorId, '`create` requires `predecessorId` and `successorId`.');
          return api.post('dependencies', { predecessorId, successorId, type, lagDays });
        }
        need(id, `\`${action}\` requires \`id\`.`);
        if (action === 'update') return api.patch(`dependencies/${id}`, { type, lagDays });
        return api.delete(`dependencies/${id}`);
      }),
  );

  register(
    'vaks_post_comment',
    {
      title: 'Post a comment on a task',
      description:
        'Adds a comment to a task\'s thread (@mentions by handle id ' +
        'trigger a notification). Useful to summarize, flag a blocker, ask for an opinion.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task id (UUID).'),
        body: z.string().min(1).describe('Comment content (light markdown, @mentions).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, body }) => run(() => api.post(`tasks/${taskId}/comments`, { body })),
  );

  register(
    'vaks_notify_stakeholders',
    {
      title: 'Notify the project stakeholders (announcement)',
      description:
        'Sends an ANNOUNCEMENT to a project\'s stakeholders: branded email + webhook (Teams card), ' +
        'with plain attribution ("Sent by <user> via the AI assistant"). The audience is ' +
        'resolved SERVER-SIDE by roles — never free-form email addresses. `audience`: \'pm\' (project ' +
        'managers), \'sponsors\' (members tagged as sponsor), \'members\' (all direct members), \'watchers\' ' +
        '(subscribers to the project / linked task). Use it when the user wants to inform of a ' +
        'change (scope, milestone shift, decision). Write a short `title` and a factual `body` ' +
        '(plain text — HTML/markdown is not interpreted, URLs will not be clickable). ' +
        'Anti-spam: at most one announcement per project every ~2 minutes.',
      inputSchema: {
        projectId: z.string().uuid().describe('Project concerned (UUID).'),
        title: z.string().min(1).max(200).describe('Announcement title (email subject, prefixed by org/project).'),
        body: z.string().min(1).max(4000).describe('Announcement body, plain text (max 4000 characters).'),
        audience: z
          .array(z.enum(['pm', 'members', 'watchers', 'sponsors']))
          .min(1)
          .describe("Audiences to notify (resolved server-side). E.g. ['pm','sponsors']."),
        taskId: z.string().uuid().optional().describe('Context task — optional.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, title, body, audience, taskId }) =>
      run(() => api.post(`projects/${projectId}/announcements`, { title, body, audience, taskId })),
  );

  register(
    'vaks_time_off_manage',
    {
      title: 'Time-offs (create / update / delete)',
      description:
        'Manages time-offs. A time-off sets the user\'s capacity to 0 over the period (the ' +
        'staffing engine accounts for it). `action`: ' +
        "'create' = declare a time-off (requires `userId`, `startDate`, `endDate`); " +
        "'update' = modify one (requires `id`, partial fields); " +
        "'delete' = remove one (requires `id`, destructive — confirmation required).",
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']).describe('Operation to perform.'),
        id: z.string().uuid().optional().describe('Target time-off (UUID) — required for `update`/`delete`.'),
        userId: z.string().uuid().optional().describe('User concerned (UUID) — required for `create`.'),
        startDate: z.string().optional().describe('Start (YYYY-MM-DD) — required for `create`.'),
        endDate: z.string().optional().describe('End (YYYY-MM-DD) — required for `create`.'),
        type: z
          .enum(['VACATION', 'SICK', 'PERSONAL', 'PARENTAL', 'OTHER'])
          .optional()
          .describe('Time-off type — optional.'),
        notes: z.string().nullable().optional().describe('Note — optional.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, id, userId, startDate, endDate, type, notes }) =>
      run(() => {
        if (action === 'create') {
          need(userId && startDate && endDate, '`create` requires `userId`, `startDate` and `endDate`.');
          return api.post('workload/time-offs', { userId, startDate, endDate, type, notes });
        }
        need(id, `\`${action}\` requires \`id\`.`);
        if (action === 'update') return api.patch(`time-offs/${id}`, { startDate, endDate, type, notes });
        return api.delete(`time-offs/${id}`);
      }),
  );

  register(
    'vaks_skills_assign',
    {
      title: 'Assign skills (user / project / team / task)',
      description:
        'Sets skills on any target. `action`: ' +
        "'set_user' = set/update the level of a skill for a user (requires `userId`, `skillId`, " +
        '`level`; reserved by the API to a lead of one of the person\'s teams / admin, or self-edit ' +
        'if the policy allows); ' +
        "'remove_user' = remove a skill from a user's profile (requires `userId`, `skillId`; " +
        'destructive — confirmation required); ' +
        "'set_project' = replace a project's required skills (requires `projectId`, `skillIds`); " +
        "'set_team' = replace the skills covered by a team (requires `teamId`, `skillIds`); " +
        "'set_task' = replace a task's required skills with optional levels (requires `taskId`, `items`).",
      inputSchema: {
        action: z
          .enum(['set_user', 'remove_user', 'set_project', 'set_team', 'set_task'])
          .describe('Operation to perform.'),
        userId: z.string().uuid().optional().describe('User (UUID) — `set_user`/`remove_user`.'),
        skillId: z.string().uuid().optional().describe('Skill (UUID) — `set_user`/`remove_user`.'),
        level: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Level (1..N per the org grid) — required for `set_user`.'),
        projectId: z.string().uuid().optional().describe('Project (UUID) — `set_project`.'),
        teamId: z.string().uuid().optional().describe('Team (UUID) — `set_team`.'),
        taskId: z.string().uuid().optional().describe('Task (UUID) — `set_task`.'),
        skillIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Complete skill list, replaces the existing set — `set_project`/`set_team`.'),
        items: z
          .array(z.object({ skillId: z.string().uuid(), level: z.number().int().min(1).max(5).optional() }))
          .optional()
          .describe('Complete list (replaces the existing set) — `set_task`.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ action, userId, skillId, level, projectId, teamId, taskId, skillIds, items }) =>
      run(() => {
        switch (action) {
          case 'set_user':
            need(userId && skillId && level != null, '`set_user` requires `userId`, `skillId` and `level`.');
            return api.put(`users/${userId}/skills/${skillId}`, { level });
          case 'remove_user':
            need(userId && skillId, '`remove_user` requires `userId` and `skillId`.');
            return api.delete(`users/${userId}/skills/${skillId}`);
          case 'set_project':
            need(projectId && skillIds, '`set_project` requires `projectId` and `skillIds`.');
            return api.put(`projects/${projectId}/skills`, { skillIds });
          case 'set_team':
            need(teamId && skillIds, '`set_team` requires `teamId` and `skillIds`.');
            return api.put(`teams/${teamId}/skills`, { skillIds });
          default:
            need(taskId && items, '`set_task` requires `taskId` and `items`.');
            return api.put(`tasks/${taskId}/required-skills`, { items });
        }
      }),
  );

  // --- Création en lot (bootstrap projet depuis un brief) ---

  register(
    'vaks_create_tasks',
    {
      title: 'Create one or several tasks',
      description:
        'Creates one task or a batch of tasks in a project — a single task is simply a batch of ' +
        'one. Materializes a whole breakdown in a single call (typically after ' +
        '`vaks_create_project` from a brief). Fetch the project id via `vaks_list_projects`, and ' +
        'choose assignees with `vaks_suggest_assignees` / `vaks_get_skill_gap` (skill ∩ availability). ' +
        'Tolerates partial failures: returns the result task by task (created id or error).',
      inputSchema: {
        projectId: z.string().uuid().describe('Project id (UUID).'),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).describe('Task title.'),
              description: z.string().optional(),
              estimateHours: z.number().positive().optional(),
              dueDate: z.string().optional().describe('Due date (YYYY-MM-DD).'),
              assigneeIds: z.array(z.string().uuid()).optional(),
              labelIds: z
                .array(z.string().uuid())
                .optional()
                .describe('Labels to apply (UUID, see `vaks_list_labels`).'),
              isMilestone: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(50)
          .describe('List of tasks to create (1 to 50).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, tasks }) =>
      run(async () => {
        const results: Array<Record<string, unknown>> = [];
        for (const t of tasks) {
          try {
            const created = await api.post(`projects/${projectId}/tasks`, t);
            results.push({ title: t.title, ok: true, task: created });
          } catch (e) {
            results.push({
              title: t.title,
              ok: false,
              error: e instanceof VaksApiError ? e.message : String((e as Error).message),
            });
          }
        }
        return { count: results.length, created: results.filter((r) => r.ok).length, results };
      }),
  );

  // --- Étiquettes (écriture) ---

  register(
    'vaks_labels_manage',
    {
      title: 'Project labels (create / update / delete)',
      description:
        'Manages a project\'s labels. Apply them to tasks via `labelIds` (`vaks_create_tasks` / ' +
        '`vaks_update_task`). `action`: ' +
        "'create' = add a label (requires `projectId`, `name`); " +
        "'update' = rename/recolor a label (requires `projectId`, `labelId`); " +
        "'delete' = remove a label (requires `projectId`, `labelId`, destructive — confirmation required).",
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']).describe('Operation to perform.'),
        projectId: z.string().uuid().describe('Project id (UUID).'),
        labelId: z.string().uuid().optional().describe('Target label (UUID) — required for `update`/`delete`.'),
        name: z.string().min(1).optional().describe('Label name — required for `create`.'),
        color: z.string().optional().describe('Hex color (e.g. #3b82f6) — optional.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, projectId, labelId, name, color }) =>
      run(() => {
        if (action === 'create') {
          need(name, '`create` requires `name`.');
          return api.post(`projects/${projectId}/labels`, { name, color });
        }
        need(labelId, `\`${action}\` requires \`labelId\`.`);
        if (action === 'update') return api.patch(`projects/${projectId}/labels/${labelId}`, { name, color });
        return api.delete(`projects/${projectId}/labels/${labelId}`);
      }),
  );

  // --- Coûts hors main-d'œuvre / finance (écriture) ---
  // Triple verrou : ce bloc n'est exposé que si l'écriture IA est ON **et** si
  // « finance exposée à l'IA » est ON (`allowFinance`, cf. /me/mcp-context) ;
  // l'API refuse de toute façon via FinanceApiGateGuard (fail-closed) ou si
  // l'utilisateur n'a pas `finance:manage` dans son RBAC.

  if (allowFinance) {
    register(
      'vaks_expenses_manage',
      {
        title: 'Non-labor costs (add / update / delete)',
        description:
          'Manages non-labor costs on a project: license, hardware, cloud, subcontracting, other. ' +
          '⚠️ Triple lock: AI writes enabled + finance exposed to AI + the user\'s `finance:manage` ' +
          'permission — otherwise refused. `action`: ' +
          "'add' = create a cost (requires `projectId`, `category`, `label`, `amount`); " +
          "'update' = modify one (requires `projectId`, `expenseId`, partial fields — fetch the " +
          '`expenseId` via `vaks_list_expenses`); ' +
          "'delete' = remove one (requires `projectId`, `expenseId`, destructive — confirmation required).",
        inputSchema: {
          action: z.enum(['add', 'update', 'delete']).describe('Operation to perform.'),
          projectId: z.string().uuid().describe('Project id (UUID).'),
          expenseId: z.string().uuid().optional().describe('Target cost (UUID) — required for `update`/`delete`.'),
          category: z
            .enum(['LICENSE', 'HARDWARE', 'CLOUD', 'SUBCONTRACTOR', 'OTHER'])
            .optional()
            .describe('Cost category — required for `add`.'),
          label: z.string().min(1).max(200).optional().describe('Short label — required for `add`.'),
          amount: z.number().min(0).optional().describe('Internal cost (per period if recurring) — required for `add`.'),
          billAmount: z.number().min(0).optional().describe('Amount re-billed to the client — optional.'),
          quantity: z.number().min(0).optional().describe('Quantity — optional.'),
          description: z.string().max(2000).optional().describe('Detail — optional.'),
          status: z.enum(['PLANNED', 'INCURRED']).optional().describe('Status (default PLANNED).'),
          recurrence: z
            .enum(['ONE_OFF', 'MONTHLY', 'ANNUAL'])
            .optional()
            .describe('Recurrence (default ONE_OFF).'),
          startDate: z.string().optional().describe('Start (YYYY-MM-DD) — optional.'),
          endDate: z.string().optional().describe('End (YYYY-MM-DD) — optional.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ action, projectId, expenseId, ...body }) =>
        run(() => {
          if (action === 'add') {
            need(body.category && body.label && body.amount != null, '`add` requires `category`, `label` and `amount`.');
            return api.post(`projects/${projectId}/expenses`, body);
          }
          need(expenseId, `\`${action}\` requires \`expenseId\`.`);
          if (action === 'update') return api.patch(`projects/${projectId}/expenses/${expenseId}`, body);
          return api.delete(`projects/${projectId}/expenses/${expenseId}`);
        }),
    );
  }

  // ============================================================
  // Clients & contacts (écriture) — scope client:manage
  // ============================================================
  register(
    'vaks_clients_manage',
    {
      title: 'Clients & contacts (create / update / delete)',
      description:
        'Manages the client portfolio (accounts and their contacts). `action`: ' +
        "'create_client' = create a client (requires `name`); " +
        "'update_client' = update a client (requires `clientId`, partial fields); " +
        "'delete_client' = delete a client (requires `clientId`, destructive — confirmation required); " +
        "'create_contact' = add a contact to a client (requires `clientId`, `name`); " +
        "'update_contact' = update a contact (requires `clientId`, `contactId`); " +
        "'delete_contact' = delete a contact (requires `clientId`, `contactId`, destructive — " +
        'confirmation required).',
      inputSchema: {
        action: z
          .enum([
            'create_client',
            'update_client',
            'delete_client',
            'create_contact',
            'update_contact',
            'delete_contact',
          ])
          .describe('Operation to perform.'),
        clientId: z
          .string()
          .uuid()
          .optional()
          .describe('Target client (UUID) — required for everything except `create_client`.'),
        contactId: z
          .string()
          .uuid()
          .optional()
          .describe('Target contact (UUID) — required for `update_contact`/`delete_contact`.'),
        name: z.string().min(1).optional().describe('Name — required for `create_client`/`create_contact`.'),
        company: z.string().nullable().optional().describe('Company — client only.'),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        address: z.string().nullable().optional().describe('Address — client only.'),
        notes: z.string().nullable().optional(),
        status: z
          .enum(['PROSPECT', 'ACTIVE', 'ARCHIVED'])
          .optional()
          .describe('Client status — client only.'),
        title: z.string().nullable().optional().describe('Job title — contact only.'),
        isPrimary: z.boolean().optional().describe('Primary contact — contact only.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, clientId, contactId, name, company, email, phone, address, notes, status, title, isPrimary }) =>
      run(() => {
        const clientBody = { name, company, email, phone, address, notes, status };
        const contactBody = { name, title, email, phone, notes, isPrimary };
        if (action === 'create_client') {
          need(name, '`create_client` requires `name`.');
          return api.post('clients', clientBody);
        }
        need(clientId, `\`${action}\` requires \`clientId\`.`);
        if (action === 'update_client') return api.patch(`clients/${clientId}`, clientBody);
        if (action === 'delete_client') return api.delete(`clients/${clientId}`);
        if (action === 'create_contact') {
          need(name, '`create_contact` requires `name`.');
          return api.post(`clients/${clientId}/contacts`, contactBody);
        }
        need(contactId, `\`${action}\` requires \`contactId\`.`);
        if (action === 'update_contact') return api.patch(`clients/${clientId}/contacts/${contactId}`, contactBody);
        return api.delete(`clients/${clientId}/contacts/${contactId}`);
      }),
  );

  // ============================================================
  // Équipes (écriture) — scopes team:create / team:manage_members
  // ============================================================
  register(
    'vaks_teams_manage',
    {
      title: 'Teams (create / update / members / project assignment)',
      description:
        'Manages teams, their members and their project assignments. `action`: ' +
        "'create' = create a team (requires `name`); " +
        "'update' = update a team (requires `teamId`); " +
        "'add_member' = add a user to a team, optionally as lead (requires `teamId`, `userId`); " +
        "'update_member' = change lead status and, for a lead/admin, default rates (requires `teamId`, `userId`); " +
        "'remove_member' = remove a user from a team (requires `teamId`, `userId`, destructive — " +
        'confirmation required); ' +
        "'assign_project' = attach the team to a project, members become assignable (requires `teamId`, `projectId`); " +
        "'unassign_project' = detach the team from a project (requires `teamId`, `projectId`).",
      inputSchema: {
        action: z
          .enum([
            'create',
            'update',
            'add_member',
            'update_member',
            'remove_member',
            'assign_project',
            'unassign_project',
          ])
          .describe('Operation to perform.'),
        teamId: z.string().uuid().optional().describe('Target team (UUID) — required for everything except `create`.'),
        userId: z.string().uuid().optional().describe('Member (UUID) — required for the `*_member` actions.'),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe('Project (UUID) — required for `assign_project`/`unassign_project`.'),
        name: z.string().min(1).optional().describe('Team name — required for `create`.'),
        displayName: z.string().nullable().optional().describe('Display name — `update` only.'),
        description: z.string().optional(),
        color: z.string().optional(),
        isLead: z.boolean().optional().describe('Lead status — `add_member`/`update_member`.'),
        canCreateNonBillableProject: z.boolean().nullable().optional().describe('`update_member` only.'),
        defaultCostRate: z.number().nullable().optional().describe('Default cost rate — `update_member`, lead/admin only.'),
        defaultBillRate: z.number().nullable().optional().describe('Default bill rate — `update_member`, lead/admin only.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({
      action,
      teamId,
      userId,
      projectId,
      name,
      displayName,
      description,
      color,
      isLead,
      canCreateNonBillableProject,
      defaultCostRate,
      defaultBillRate,
    }) =>
      run(() => {
        if (action === 'create') {
          need(name, '`create` requires `name`.');
          return api.post('teams', { name, description, color });
        }
        need(teamId, `\`${action}\` requires \`teamId\`.`);
        if (action === 'update') return api.patch(`teams/${teamId}`, { name, displayName, description, color });
        if (action === 'assign_project' || action === 'unassign_project') {
          need(projectId, `\`${action}\` requires \`projectId\`.`);
          return action === 'assign_project'
            ? api.post(`projects/${projectId}/teams`, { teamId })
            : api.delete(`projects/${projectId}/teams/${teamId}`);
        }
        need(userId, `\`${action}\` requires \`userId\`.`);
        if (action === 'add_member') return api.post(`teams/${teamId}/members`, { userId, isLead });
        if (action === 'update_member')
          return api.patch(`teams/${teamId}/members/${userId}`, {
            isLead,
            canCreateNonBillableProject,
            defaultCostRate,
            defaultBillRate,
          });
        return api.delete(`teams/${teamId}/members/${userId}`);
      }),
  );

  // ============================================================
  // Allocations manuelles & horaires de capacité — scope allocation:manage
  // ============================================================
  register(
    'vaks_allocations_manage',
    {
      title: 'Allocations (create / update / delete)',
      description:
        'Manages manual allocations (a user on a task over a date range, at N hours/day). ' +
        'Complements the auto-plan (`vaks_plan_project_*`) for manual adjustments. `action`: ' +
        "'create' = allocate (requires `userId`, `taskId`, `startDate`, `endDate`, `hoursPerDay`); " +
        "'update' = reassign / move dates / change hours (requires `id`); " +
        "'delete' = remove an allocation (requires `id`, destructive — confirmation required).",
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']).describe('Operation to perform.'),
        id: z.string().uuid().optional().describe('Target allocation (UUID) — required for `update`/`delete`.'),
        userId: z.string().uuid().optional().describe('User (UUID) — required for `create`.'),
        taskId: z.string().uuid().optional().describe('Task (UUID) — required for `create`.'),
        startDate: z.string().optional().describe('YYYY-MM-DD — required for `create`.'),
        endDate: z.string().optional().describe('YYYY-MM-DD — required for `create`.'),
        hoursPerDay: z.number().positive().optional().describe('Hours per day — required for `create`.'),
        notes: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, id, userId, taskId, startDate, endDate, hoursPerDay, notes }) =>
      run(() => {
        if (action === 'create') {
          need(
            userId && taskId && startDate && endDate && hoursPerDay,
            '`create` requires `userId`, `taskId`, `startDate`, `endDate` and `hoursPerDay`.',
          );
          return api.post('allocations', { userId, taskId, startDate, endDate, hoursPerDay, notes });
        }
        need(id, `\`${action}\` requires \`id\`.`);
        if (action === 'update')
          return api.patch(`allocations/${id}`, { userId, startDate, endDate, hoursPerDay, notes });
        return api.delete(`allocations/${id}`);
      }),
  );
  register(
    'vaks_set_work_schedule',
    {
      title: 'Set a user\'s capacity schedule',
      description:
        'Sets a user\'s weekly capacity (hours per day Mon→Sun) and occupancy rate.',
      inputSchema: {
        userId: z.string().uuid(),
        effectiveFrom: z.string().optional().describe('YYYY-MM-DD — optional.'),
        hoursMon: z.number().min(0).max(24).optional(),
        hoursTue: z.number().min(0).max(24).optional(),
        hoursWed: z.number().min(0).max(24).optional(),
        hoursThu: z.number().min(0).max(24).optional(),
        hoursFri: z.number().min(0).max(24).optional(),
        hoursSat: z.number().min(0).max(24).optional(),
        hoursSun: z.number().min(0).max(24).optional(),
        occupancyPct: z.number().min(0).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ userId, ...body }) => run(() => api.put(`users/${userId}/work-schedule`, body)),
  );
  // ============================================================
  // Finance — taux & budget (écriture) — scope finance:manage (mêmes verrous
  // que les dépenses, y compris le gate d'exposition `allowFinance`)
  // ============================================================
  if (allowFinance) {
    register(
      'vaks_project_finance',
      {
        title: 'Project finance (budget / rates)',
        description:
          'Manages a project\'s financial envelope and per-user rates. ⚠️ Same finance locks as ' +
          'expenses (AI writes + finance exposed to AI + `finance:manage`). `action`: ' +
          "'set_budget' = set the project's budget envelope and/or default cost/re-billing rates " +
          '(requires `projectId`); ' +
          "'set_rate' = set the cost (and re-billing) rate of a user on the project (requires " +
          '`projectId`, `userId`, `costRate`); ' +
          "'delete_rate' = remove the explicit rate, back to the user/project default (requires " +
          '`projectId`, `userId`, destructive — confirmation required).',
        inputSchema: {
          action: z.enum(['set_budget', 'set_rate', 'delete_rate']).describe('Operation to perform.'),
          projectId: z.string().uuid().describe('Project id (UUID).'),
          userId: z.string().uuid().optional().describe('User (UUID) — required for `set_rate`/`delete_rate`.'),
          costRate: z.number().min(0).optional().describe('Hourly cost rate — required for `set_rate`.'),
          billRate: z.number().min(0).nullable().optional().describe('Re-billed rate — `set_rate`, optional.'),
          budgetAmount: z.number().min(0).nullable().optional().describe('Budget envelope — `set_budget`.'),
          defaultCostRate: z.number().min(0).nullable().optional().describe('Project default cost rate — `set_budget`.'),
          defaultBillRate: z.number().min(0).nullable().optional().describe('Project default bill rate — `set_budget`.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ action, projectId, userId, costRate, billRate, budgetAmount, defaultCostRate, defaultBillRate }) =>
        run(() => {
          if (action === 'set_budget')
            return api.put(`projects/${projectId}/budget`, { budgetAmount, defaultCostRate, defaultBillRate });
          need(userId, `\`${action}\` requires \`userId\`.`);
          if (action === 'set_rate') {
            need(costRate != null, '`set_rate` requires `costRate`.');
            return api.put(`projects/${projectId}/rates/${userId}`, { costRate, billRate });
          }
          return api.delete(`projects/${projectId}/rates/${userId}`);
        }),
    );
  }
  register(
    'vaks_project_context',
    {
      title: 'AI-context notes on a project (add / update)',
      description:
        'Manages TEXT documents in the project\'s document space marked "AI context": readable by ' +
        'agents on all tasks of the project (report, architecture decisions, glossary, style ' +
        'guidelines…). Allowed extensions via the name: .md, .txt, .csv, .json, .yaml, .html — a ' +
        'binary CANNOT be created via this path. Cap 1 MB. `action`: ' +
        "'add' = deposit a note by NAME, no id needed (requires `projectId`, `name`, `content`); if " +
        'a text note of the same name already exists in the target folder, its content is REPLACED ' +
        '(the response carries `replaced:true`) — pass `onDuplicate:"create"` to force a second ' +
        'document. Without `folderId`, the note lands in the project\'s root "AI context" folder if ' +
        'there is exactly one, otherwise at the root. ' +
        "'update' = rewrite/move/detach an existing note by id (requires `projectId`, `docId`; " +
        'provide `content` to rewrite, `folderId` to file it — null = root, `aiContext: false` to ' +
        'detach without deleting; refuses non-text documents. Fetch the `docId` via `vaks_read` on ' +
        '`projects/<id>/documents`).',
      inputSchema: {
        action: z.enum(['add', 'update']).describe('Operation to perform.'),
        projectId: z.string().uuid(),
        docId: z.string().uuid().optional().describe('Target document (UUID) — required for `update`.'),
        name: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('File name, extension included (e.g. "decisions-archi.md") — required for `add`.'),
        content: z
          .string()
          .min(1)
          .optional()
          .describe('Text content (required for `add`; for `update`, replaces entirely).'),
        folderId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe('Target folder (`add`: default root "AI context" folder; `update`: null = root).'),
        aiContext: z
          .boolean()
          .optional()
          .describe('`add`: false to deposit without exposing to agents (default true). `update`: false to detach.'),
        onDuplicate: z
          .enum(['replace', 'create'])
          .optional()
          .describe('`add` only: "replace" (default) updates an existing namesake, "create" forces a second document.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ action, projectId, docId, name, content, folderId, aiContext, onDuplicate }) =>
      run(async () => {
        if (action === 'add') {
          need(name && content, '`add` requires `name` and `content`.');
          return api.post(`projects/${projectId}/documents/text`, {
            name,
            content,
            folderId: folderId ?? undefined,
            aiContext,
            onDuplicate,
          });
        }
        need(docId, '`update` requires `docId`.');
        // Deux mutations distinctes côté API : le contenu vit dans S3, les
        // métadonnées en base. On réécrit d'abord, on range ensuite — ainsi un
        // échec de rangement ne laisse pas un contenu périmé derrière lui.
        const meta = Object.fromEntries(
          Object.entries({ folderId, aiContext }).filter(([, v]) => v !== undefined),
        );
        if (content === undefined && !Object.keys(meta).length) {
          throw new Error('Nothing to update: provide `content`, `folderId` or `aiContext`.');
        }
        // Toujours renvoyer LE DOCUMENT, jamais la liste : les deux routes
        // sérialisent le document, on garde donc la dernière écriture faite.
        const afterText =
          content !== undefined
            ? await api.put(`projects/${projectId}/documents/${docId}/text`, { content })
            : null;
        return Object.keys(meta).length
          ? api.patch(`projects/${projectId}/documents/${docId}`, meta)
          : afterText;
      }),
  );
  // ============================================================
  // Projet (métadonnées) & tâches — scopes project:update / task:delete
  // ============================================================
  register(
    'vaks_update_project',
    {
      title: 'Update a project (metadata, lifecycle status, AI agents configuration)',
      description:
        'Updates a project: metadata (name, description, dates, client), lifecycle `status`, AND ' +
        'the entire AI agents configuration (activation, brief, guardrails, budget, verification ' +
        'requirement). Typically used to PREPARE a project for agents right after its ' +
        'creation. For the human financial budget, `vaks_project_finance`. ' +
        'Lifecycle: the allowed `status` transitions depend on the current state — read ' +
        '`allowedTransitions` via `vaks_list_projects`; the commercial-offer steps (OFFER_SENT / ' +
        'accept / reject) go through other actions and are not covered here. ' +
        '⚠️ Enabling agents (`agentsEnabled:true`) REQUIRES a non-empty brief (`agentContext` or ' +
        '`agentBrief`) — the server refuses otherwise. Reserved for humans: agent tokens do not have ' +
        'permission to modify a project.',
      inputSchema: {
        projectId: z.string().uuid(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        status: z
          .enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED'])
          .optional()
          .describe('Lifecycle status (must be in the project\'s allowedTransitions) — optional.'),
        startDate: z.string().nullable().optional().describe('YYYY-MM-DD or null to clear.'),
        dueDate: z.string().nullable().optional().describe('YYYY-MM-DD or null to clear.'),
        clientId: z.string().uuid().nullable().optional().describe('Attach to a client, or null to detach.'),
        agentsEnabled: z
          .boolean()
          .optional()
          .describe('Open the project to AI agents. Requires a non-empty brief (agentContext/agentBrief).'),
        agentContext: z
          .string()
          .nullable()
          .optional()
          .describe('Free-form brief (markdown): agents\' role, output conventions, where to deposit, out-of-scope.'),
        agentBrief: z
          .object({
            role: z.string().nullable().optional().describe('The agent\'s role and mission on this project.'),
            outputConventions: z.string().nullable().optional().describe('Expected format, style, language, structure.'),
            deliveryTarget: z.string().nullable().optional().describe('Where to deposit the deliverables.'),
            outOfScope: z.string().nullable().optional().describe('What the agent must absolutely not do.'),
          })
          .nullable()
          .optional()
          .describe('STRUCTURED brief (alternative to agentContext) — four short fields.'),
        agentGuardrails: z
          .string()
          .nullable()
          .optional()
          .describe('Project-level guardrails: what no agent must do here.'),
        agentAutoCloseOnApproval: z
          .boolean()
          .nullable()
          .optional()
          .describe('Automatically close a task on approval. null = inherit the org setting.'),
        agentCostBudget: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe('Total agent cost envelope (€) for the project. null = no cap.'),
        stakes: z
          .enum(['low', 'medium', 'high', 'critical'])
          .nullable()
          .optional()
          .describe('Project stakes: derives the proof level required of agent deliverables.'),
        verificationCapabilities: z
          .array(z.enum(['tool_output', 'agent_validator', 'ci_signed']))
          .nullable()
          .optional()
          .describe('Mechanical verification methods available on this project.'),
        verificationMode: z
          .enum(['report_only', 'enforce'])
          .nullable()
          .optional()
          .describe('report_only = logs; enforce = blocks below the floor. null = inherits from the org.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...body }) => run(() => api.patch(`projects/${projectId}`, body)),
  );
  register(
    'vaks_delete_task',
    {
      title: 'Delete a task',
      description: 'Deletes (soft-delete) a task. Destructive action.',
      inputSchema: { taskId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.delete(`tasks/${taskId}`)),
  );

}
