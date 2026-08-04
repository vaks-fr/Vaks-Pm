import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient, VaksApiError, withCallContext } from './api-client.js';
import { CONFIRM_TOOLS } from './confirm-tools.js';

/**
 * Tools MCP de l'incrément 1 — **lecture seule**. Chacun n'est qu'un appel à un
 * endpoint `@PublicApi` existant de l'API, exécuté avec le jeton de l'utilisateur
 * (donc borné à son périmètre RBAC). Aucune écriture pour l'instant : l'IA
 * « observe et suggère », l'humain agit dans l'app.
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
    throw new Error('Chemin invalide (traversée interdite).');
  }
  return clean;
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
  const cible = t?.label ?? (t?.type && t?.id ? `${t.type} ${t.id}` : 'la ressource visée');
  const lines = [
    `⚠️ Cette action demande une confirmation explicite avant d'être exécutée.`,
    ``,
    `Action  : ${String(body.impact?.tool ?? 'inconnue')}`,
    `Cible   : ${cible}`,
    `Validité: ${body.expiresInSec ?? 600} secondes`,
    ``,
    `Présentez ceci à l'utilisateur. S'il confirme, rappelez EXACTEMENT le même`,
    `tool avec les mêmes arguments plus : confirmToken: "${body.confirmToken}"`,
    `(les arguments doivent être identiques, sinon le jeton est refusé).`,
  ];
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

/**
 * Enregistre les tools sur le serveur. `allowWrite` (dérivé des scopes du jeton
 * via `GET /me/mcp-context`) pilote l'exposition des tools d'**écriture** : si
 * l'org n'a pas activé `mcp.allowWrites`, le jeton ne porte pas les scopes
 * correspondants → on **ne déclare même pas** ces tools (plutôt que de les
 * lister et qu'ils échouent en 403). Les tools de lecture sont toujours exposés.
 */
export function registerTools(server: McpServer, api: ApiClient, allowWrite: boolean): void {
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
    const isWrite = def.annotations?.readOnlyHint === false;
    const inputSchema = isWrite
      ? {
          ...(def.inputSchema ?? {}),
          justification: z
            .string()
            .max(1000)
            .optional()
            .describe(
              "Pourquoi cette action est effectuée (une phrase). Tracé dans le journal d'audit — fortement recommandé pour les agents.",
            ),
          // Seulement sur les tools susceptibles d'être challengés : l'ajouter
          // partout coûterait ~2-3 k tokens de description à chaque tools/list.
          ...(CONFIRM_TOOLS.has(name)
            ? {
                confirmToken: z
                  .string()
                  .max(200)
                  .optional()
                  .describe(
                    "À NE PAS inventer. Si un premier appel renvoie une demande de confirmation, " +
                      "rappeler ce tool avec les MÊMES arguments plus le jeton fourni.",
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
        // `withCallContext` : un batch JSON-RPC fait tourner plusieurs
        // handlers en concurrence sur le même `api`, et un champ mutable
        // ferait attribuer la justification au mauvais tool dans le journal
        // d'audit (cf. `callContextStore` dans api-client.ts).
        return withCallContext(
          {
            tool: name,
            justification:
              typeof justification === 'string' && justification.trim() ? justification : undefined,
            confirmToken:
              typeof confirmToken === 'string' && confirmToken.trim() ? confirmToken.trim() : undefined,
          },
          () => handler(rest, extra),
        );
      },
    );
  };

  register(
    'vaks_list_projects',
    {
      title: 'Lister les projets',
      description:
        "Liste les projets visibles par l'utilisateur courant (selon son périmètre RBAC). " +
        "Utiliser `scope=all` pour tenter d'inclure tous les projets de l'organisation " +
        "(n'est honoré que si l'utilisateur a la permission de tout voir).",
      inputSchema: {
        scope: z
          .enum(['mine', 'all'])
          .optional()
          .describe("Périmètre : 'mine' (défaut) = projets accessibles ; 'all' = portefeuille."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scope }) => run(() => api.get('projects', { scope })),
  );

  register(
    'vaks_list_project_tasks',
    {
      title: "Lister les tâches d'un projet",
      description:
        "Liste les tâches d'un projet donné. Filtres optionnels par statut et par assigné. " +
        "Récupérer d'abord l'id du projet via `vaks_list_projects`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        status: z
          .string()
          .optional()
          .describe('Filtre statut (ex. TODO, IN_PROGRESS, DONE) — optionnel.'),
        assigneeId: z.string().uuid().optional().describe("Filtre par assigné (UUID) — optionnel."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId, status, assigneeId }) =>
      run(() => api.get(`projects/${projectId}/tasks`, { status, assigneeId })),
  );

  register(
    'vaks_get_workload',
    {
      title: 'Charge de travail (capacité vs allouée)',
      description:
        "Agrège la charge de travail par personne et par jour sur une fenêtre de dates " +
        "(capacité vs heures allouées), pour repérer les sur/sous-charges. " +
        "Dates au format ISO (YYYY-MM-DD).",
      inputSchema: {
        from: z.string().describe('Début de fenêtre (YYYY-MM-DD).'),
        to: z.string().describe('Fin de fenêtre (YYYY-MM-DD).'),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe('Restreindre à un projet (UUID) — optionnel.'),
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
      title: 'Couverture des compétences d\'un projet',
      description:
        "Pour un projet, évalue la couverture des compétences requises : qui est qualifié " +
        "ET réellement disponible (capacité libre jour par jour = horaires × occupation − congés " +
        "− fériés − allocations), l'effort restant à couvrir, et les candidats « presque qualifiés » " +
        "(formation). À utiliser pour répondre à « qui peut prendre cette charge ? » avant d'assigner.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => run(() => api.get(`projects/${projectId}/skills/gap`)),
  );

  register(
    'vaks_suggest_assignees',
    {
      title: 'Suggérer des assignés pour une tâche',
      description:
        "Propose les meilleurs candidats pour une tâche, en croisant les compétences requises " +
        "et la disponibilité réelle sur une fenêtre de dates. Renvoie un classement (skill match + " +
        "capacité libre). Récupérer l'id de tâche via `vaks_list_project_tasks`. Ne fait qu'une " +
        "suggestion — n'assigne rien.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        from: z.string().optional().describe('Début de fenêtre (YYYY-MM-DD) — optionnel.'),
        to: z.string().optional().describe('Fin de fenêtre (YYYY-MM-DD) — optionnel.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId, from, to }) =>
      run(() => api.get(`tasks/${taskId}/assignee-suggestions`, { from, to })),
  );

  register(
    'vaks_get_task',
    {
      title: 'Détail d\'une tâche',
      description:
        "Renvoie le détail complet d'une tâche (statut, estimé, temps loggé, assignés, échéances, " +
        "compétence requise, dépendances). Utile avant de suggérer une affectation ou d'analyser un retard.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}`)),
  );

  register(
    'vaks_get_work_context',
    {
      title: 'Contexte de travail complet d\'une tâche',
      description:
        "TOUT ce qu'il faut pour bien réaliser une tâche, en UN seul appel : le brief du projet " +
        "(`project.brief`, markdown composé = rôle/mission, conventions de sortie, où déposer les " +
        "livrables, hors-périmètre, PLUS les faits que l'application connaît déjà — reviewer, mode " +
        "de vérification, enjeu, langue — et les notes libres du PM en dernier), le `charter` du " +
        "projet (périmètre inclus/exclu, livrables, contraintes, critères de succès), les " +
        "garde-fous (projet ET tâche), les critères d'acceptation (checklist de revue), le détail " +
        "de la tâche, le journal des livrables APPROUVÉS précédents (continuité), les documents de " +
        "contexte (`projectDocuments` ; `projectDocumentsMeta.truncated:true` = tout n'est pas " +
        "listé) et les commentaires récents. " +
        "Porte AUSSI `upstreamOutputs` : les paires clé/valeur produites par les tâches AMONT " +
        "(prédécesseurs et sous-tâches) dont le livrable a été APPROUVÉ — endpoint, version, " +
        "identifiants. Les lire de là plutôt que de les chercher dans le texte des livrables amont. " +
        "Deux autres blocs décisifs : `reviewFeedback` (si un livrable a été rejeté — la note " +
        "EXACTE du valideur et l'historique des versions : commencez par là, c'est votre consigne de " +
        "reprise) et `limits` (bail d'exécution, nombre de rejets restants avant escalade humaine, " +
        "enveloppes de budget € restantes — si `limits.budget.stop` est vrai, ne produisez plus). " +
        "À APPELER APRÈS avoir revendiqué une tâche, AVANT de produire quoi que ce soit. " +
        "Si un critère est ambigu ou du contexte manque, poser une question via `vaks_post_comment` " +
        "plutôt que de deviner.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche revendiquée.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/work-context`)),
  );

  register(
    'vaks_list_context_files',
    {
      title: 'Lister les documents d\'une source externe (SharePoint…)',
      description:
        "Liste les fichiers et dossiers d'une source de documents externe rattachée au projet " +
        "de la tâche — en v1 le SharePoint de la team Microsoft Teams provisionnée. Proxy live " +
        "(pas de copie). Paginé : passer `cursor` pour la page suivante, `folderId` pour entrer " +
        "dans un dossier. La dispo des sources est indiquée dans `vaks_get_work_context` " +
        "(`contextSources`). Codes d'erreur : `FS_DISABLED`/`FS_GRANT_PENDING`/`FS_SOURCE_UNAVAILABLE` " +
        "= la source n'est pas exploitable sur ce projet (ne pas réessayer).",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        source: z.string().optional().describe("Source (défaut 'sharepoint')."),
        folderId: z.string().optional().describe('Dossier à ouvrir (racine si absent).'),
        cursor: z.string().optional().describe('Curseur de pagination (page suivante).'),
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
      title: 'Lire le texte d\'un document d\'une source externe',
      description:
        "Renvoie le TEXTE extrait d'un fichier d'une source externe (SharePoint…), pour s'en " +
        "servir de contexte. Formats supportés : texte, Markdown, CSV/JSON, Word (.docx), " +
        "Excel (.xlsx), PDF. Le texte est plafonné (~64 Ko) : `truncated:true` signale une coupe. " +
        "`FS_FILE_TOO_LARGE` (fichier > 10 Mo) et `FS_UNSUPPORTED_FORMAT` (image, archive…) " +
        "renvoient les métadonnées sans contenu. Récupérer l'`itemId` via `vaks_list_context_files`.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        source: z.string().describe("Source (ex. 'sharepoint')."),
        itemId: z.string().describe("Identifiant de l'item retourné par le listing."),
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
      title: 'Santé d\'un projet (stats + respect des échéances)',
      description:
        "Instantané de santé d'un projet : statistiques (avancement, tâches en retard, " +
        "estimé vs réel) ET respect des échéances (taux de tâches livrées à temps). À utiliser " +
        "pour diagnostiquer un projet repéré comme à risque via `vaks_list_projects`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
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
    'vaks_get_tasks_in_window',
    {
      title: 'Tâches d\'un projet dans une fenêtre de dates',
      description:
        "Liste les tâches d'un projet dont l'échéance (ou l'activité) tombe dans une fenêtre " +
        "[from, to]. Idéal pour repérer les deadlines imminentes ou en dépassement. Dates ISO (YYYY-MM-DD).",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        from: z.string().describe('Début de fenêtre (YYYY-MM-DD).'),
        to: z.string().describe('Fin de fenêtre (YYYY-MM-DD).'),
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
      title: 'Commentaires d\'une tâche',
      description:
        "Liste les commentaires d'une tâche (fil de discussion, @mentions). Récupérer l'id de " +
        "tâche via `vaks_list_project_tasks` ou `vaks_get_task`. Utile pour comprendre le contexte, " +
        "les blocages ou les décisions d'une tâche.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/comments`)),
  );

  register(
    'vaks_get_user_skills',
    {
      title: 'Compétences d\'un utilisateur',
      description:
        "Liste les compétences (avec niveau) attribuées à un utilisateur. Récupérer les ids " +
        "d'utilisateurs via `vaks_suggest_assignees`, `vaks_get_task` (assignés) ou `vaks_list_teams` " +
        "(membres). Utile pour évaluer qui maîtrise quoi.",
      inputSchema: {
        userId: z.string().uuid().describe("Identifiant (UUID) de l'utilisateur."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ userId }) => run(() => api.get(`users/${userId}/skills`)),
  );

  register(
    'vaks_list_teams',
    {
      title: 'Lister les équipes',
      description:
        "Liste les équipes de l'organisation (avec leurs membres et leads). Sert notamment à " +
        "trouver le `teamId` d'une équipe pour adresser une demande de compétence à son lead " +
        "via `vaks_request_skill`.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('teams')),
  );

  register(
    'vaks_list_skills',
    {
      title: 'Catalogue des compétences de l\'organisation',
      description:
        "Liste le catalogue complet des compétences de l'org (nom, catégorie, couleur). C'est le " +
        "référentiel : à utiliser pour savoir quelles compétences existent, proposer une compétence " +
        "existante dans une demande (`vaks_request_skill`), ou rapprocher un besoin d'une compétence connue.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('skills')),
  );

  register(
    'vaks_list_labels',
    {
      title: 'Étiquettes d\'un projet',
      description:
        "Liste les étiquettes (labels) d'un projet, avec leur couleur. Sert à connaître les labels " +
        "existants avant d'en poser sur une tâche (via `vaks_update_task` / `vaks_create_task`, champ labelIds) " +
        "ou d'en créer un nouveau (`vaks_create_label`).",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => run(() => api.get(`projects/${projectId}/labels`)),
  );

  register(
    'vaks_list_expenses',
    {
      title: 'Coûts hors main-d\'œuvre d\'un projet',
      description:
        "Liste les coûts hors main-d'œuvre (non-labor) d'un projet : licences, matériel, cloud, " +
        "sous-traitance, autres — avec montant interne et montant refacturé. ⚠️ Nécessite que " +
        "l'admin ait activé « Exposer la finance à l'IA » (sinon refus) ET que l'utilisateur ait le " +
        "droit finance. Utiliser pour récupérer les `expenseId` avant un `vaks_update_expense`/`vaks_delete_expense`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => run(() => api.get(`projects/${projectId}/expenses`)),
  );

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
      title: "État d'un export asynchrone",
      description:
        "Interroge un export lancé par `vaks_export_start`. Statuts : QUEUED, RUNNING, DONE, " +
        "FAILED, STALE. Quand DONE, `downloadUrl` donne le lien de téléchargement — il reste " +
        "soumis au contrôle d'accès, il n'est pas public. Réinterroger toutes les quelques " +
        "secondes plutôt qu'en boucle serrée.",
      inputSchema: {
        jobId: z.string().describe("Identifiant du job renvoyé par `vaks_export_start`."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId }) => run(() => api.get(`exports/${encodeURIComponent(jobId)}`)),
  );

  register(
    'vaks_list_readable_endpoints',
    {
      title: 'Découvrir les endpoints de lecture disponibles',
      description:
        "Renvoie la liste des endpoints GET de l'API publique Vaks-PM (chemin + résumé + " +
        "paramètres), pour savoir quoi lire via `vaks_read`. La visibilité réelle reste bornée " +
        "par les droits de l'utilisateur (un endpoint listé peut renvoyer 403 selon le rôle).",
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
      title: 'Lecture générique de l\'API (avancé)',
      description:
        "Effectue un GET sur n'importe quel endpoint de LECTURE de l'API (chemin relatif sous " +
        "/api/v1, sans le préfixe). Borné par les droits de l'utilisateur (RBAC) → 403 si non " +
        "autorisé ; lecture seule. Découvrir les chemins via `vaks_list_readable_endpoints`. " +
        "Exemples : « clients », « clients/<id>/contacts », « projects/<id>/gantt », " +
        "« projects/<id>/dependencies », « timesheet » (params from/to), « users » (annuaire), " +
        "« me/pending-reviews » (livrables en attente de revue), « projects/<id>/budget-summary » " +
        "et « projects/<id>/evm » (finance — soumis au toggle org `mcp.allowFinance`, sinon 403). " +
        "⚠️ « projects/<id>/budget » n'existe qu'en écriture (PUT) : en lecture, utiliser " +
        "« budget-summary ». Préférer les tools dédiés quand ils existent.",
      inputSchema: {
        path: z.string().min(1).describe('Chemin relatif sous /api/v1 (sans préfixe).'),
        query: z
          .record(z.string())
          .optional()
          .describe('Paramètres de requête optionnels, ex. { from: "2026-06-01", to: "2026-06-30" }.'),
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
      title: 'Mes tâches',
      description:
        "Liste les tâches assignées à l'acteur courant (agent ou utilisateur) à travers ses " +
        "projets ACTIVE, hors tâches terminées. C'est le point de départ d'une boucle de travail : " +
        "récupérer une tâche à faire avancer (voir `vaks_claim_task`, puis `vaks_get_task`).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('me/tasks')),
  );

  register(
    'vaks_next_task',
    {
      title: 'Ma prochaine tâche',
      description:
        "Renvoie la MEILLEURE tâche revendiquable pour l'acteur courant, sans effet de bord " +
        "(modèle pull). La sélection ne retient que des tâches TODO de projets actifs agent-activés " +
        "dont vous êtes membre, dont les prérequis (FS) sont terminés et dont les compétences " +
        "requises sont couvertes, et écarte celles refusées par une policy. Triées par priorité, " +
        "échéance, tâches débloquées et adéquation des compétences. Réponse : `{ task, reason, " +
        "candidates }` (task=null si rien — voir `reason`). Pour l'obtenir ET la revendiquer d'un " +
        "coup, utilisez `vaks_claim_next_task`.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => api.get('me/next-task')),
  );

  register(
    'vaks_get_verification_requirements',
    {
      title: 'Exigence de vérification d’une tâche',
      description:
        "Renvoie le niveau de PREUVE attendu pour faire approuver un livrable sur une tâche, du " +
        "point de vue de l'acteur courant. À appeler AVANT de travailler : vous saurez s'il suffit " +
        "de déclarer le résultat (`self_attest`), s'il faut joindre la sortie d'outils/tests " +
        "(`tool_output`), une CI signée (`ci_signed`) ou une revue humaine. Réponse : " +
        "`{ requiredFloor, requiredMethods[], baseFloor, escalatedToHuman, capabilitiesAvailable[], " +
        "mode, stakes, trust }`. L'exigence dépend de l'enjeu de la tâche, de votre niveau de " +
        "confiance et des moyens de vérification disponibles sur le projet.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
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
      title: 'Lancer un export asynchrone',
      description:
        "Lance un export long et renvoie IMMÉDIATEMENT un identifiant de job — le fichier n'est " +
        "pas produit dans cet appel. Suivre l'avancement avec `vaks_export_status`, qui donnera " +
        "un lien de téléchargement une fois DONE. À utiliser quand un export synchrone risque " +
        "d'être trop long (gros volume). Type disponible : `me_data_json` (toutes vos données " +
        "personnelles — portabilité RGPD).",
      inputSchema: {
        kind: z
          .enum(['me_data_json'])
          .describe("Type d'export. `me_data_json` = données personnelles de l'utilisateur."),
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
      title: 'Revendiquer une tâche',
      description:
        "Revendique une tâche libre (statut TODO) : elle passe en CLAIMED et vous est assignée. " +
        "Opération atomique — si un autre acteur la revendique en même temps, l'un des deux reçoit " +
        "une erreur de conflit. Respecte les budgets de l'agent (tâches simultanées, revendications/jour). " +
        "Enchaîner ensuite avec une mise à jour de statut vers IN_PROGRESS, puis le travail. " +
        "⚠️ La revendication ouvre un BAIL D'EXÉCUTION à durée limitée : appelez " +
        "`vaks_execution_heartbeat` régulièrement pendant un travail long, sinon la tâche vous est " +
        "reprise et remise dans le vivier (`leaseExpiresAt` dans le contexte de travail).",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche à revendiquer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/claim`, {})),
  );

  register(
    'vaks_claim_next_task',
    {
      title: 'Tirer et revendiquer ma prochaine tâche',
      description:
        "Sélectionne la meilleure tâche revendiquable (comme `vaks_next_task`) ET la revendique " +
        "atomiquement, en essayant les meilleurs candidats jusqu'au premier claim qui passe. C'est " +
        "le cœur de la boucle de travail autonome : appelez ceci, puis passez la tâche en IN_PROGRESS, " +
        "faites le travail, soumettez un livrable (`vaks_submit_deliverable`) et demandez la revue " +
        "(`vaks_submit_for_review`). Respecte tous les garde-fous (budgets, backpressure de revue, " +
        "allowlist de modèles du client, policies). Réponse : `{ claimed, reason }` (claimed=null si " +
        "aucune tâche n'a pu être revendiquée — voir `reason`).",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => run(() => api.post('me/next-task/claim', {})),
  );

  register(
    'vaks_release_task',
    {
      title: 'Libérer une tâche revendiquée',
      description:
        "Libère une tâche que vous aviez revendiquée (CLAIMED → TODO) : elle redevient disponible " +
        "pour un autre acteur, et votre assignation de revendication est retirée.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche à libérer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/release`, {})),
  );

  register(
    'vaks_request_assistance',
    {
      title: "Demander de l'aide sur la tâche en cours",
      description:
        "Signale un blocage sur la tâche que vous détenez et **alerte quelqu'un de nommément " +
        "concerné**, contrairement à un simple commentaire. Trois effets : votre question est postée " +
        "sur la tâche, une demande de compétence part vers le lead de l'équipe qui couvre la " +
        "compétence manquante (l'équipe est choisie par le serveur — vous ne désignez personne), et " +
        "si `pause` est vrai la tâche passe en pause avec votre question pour motif (elle reste à " +
        "vous, personne ne la reprend, elle attend une réponse humaine). " +
        "À préférer au fait de deviner : un livrable produit sur une hypothèse fausse coûte un cycle " +
        "de revue à tout le monde.",
      inputSchema: {
        taskId: z.string().uuid().describe('Tâche que vous détenez.'),
        question: z
          .string()
          .min(1)
          .describe('Ce qui vous bloque, précisément. Sera lu par un humain — soyez concret.'),
        skillId: z
          .string()
          .uuid()
          .optional()
          .describe('Compétence manquante (cf. `vaks_list_skills`). Défaut : celle requise par la tâche.'),
        proposedSkillName: z
          .string()
          .optional()
          .describe("Compétence absente du catalogue, si aucune ne correspond."),
        pause: z
          .boolean()
          .optional()
          .describe('Mettre la tâche en pause en attendant la réponse (recommandé si vous êtes vraiment bloqué).'),
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
      title: 'Découper la tâche en cours en sous-tâches',
      description:
        "Crée une SOUS-TÂCHE de la tâche que vous détenez, quand le travail s'avère trop vaste ou " +
        "demande une compétence que vous n'avez pas. Contraintes serveur : le parent doit être une " +
        "tâche que vous avez revendiquée (409/403 sinon), la sous-tâche vit dans le même projet, et " +
        "on ne descend que d'UN niveau (une sous-tâche ne se redécoupe pas — signalez le besoin en " +
        "commentaire). Vous ne pouvez pas lui fixer de budget, d'enjeu ni de critères d'acceptation : " +
        "ce sont des décisions humaines. La sous-tâche naît en TODO et peut être tirée par un autre " +
        "acteur (`vaks_next_task`) — précisez `requiredSkillId` si elle demande une compétence " +
        "particulière. Le budget agent du parent COUVRE ses sous-tâches : découper n'ouvre pas " +
        "d'enveloppe supplémentaire. " +
        "⚠️ Une sous-tâche est un PASSAGE DE RELAIS : vous savez pourquoi vous découpez, celui qui la " +
        "reprendra ne le saura pas. La `description` est donc obligatoire et doit suffire à travailler " +
        "sans vous. Les livrables des sous-tâches comptent pour le parent : celui-ci ne pourra passer " +
        "en revue que si TOUTES ses sous-tâches sont closes et prouvées au niveau exigé.",
      inputSchema: {
        parentTaskId: z.string().uuid().describe('Tâche que vous détenez et qui est découpée.'),
        title: z.string().min(1).describe('Titre de la sous-tâche.'),
        description: z
          .string()
          .min(60)
          .describe(
            "OBLIGATOIRE : ce qu'il y a précisément à faire, ce qui est déjà connu ou décidé, et à " +
              "quoi ressemble le résultat attendu. Écrivez-la pour quelqu'un qui n'a pas votre contexte.",
          ),
        estimateHours: z.number().positive().optional().describe('Charge estimée en heures.'),
        requiredSkillId: z
          .string()
          .uuid()
          .optional()
          .describe('Compétence requise (cf. `vaks_list_skills`) — sert au dispatch.'),
        requiredSkillLevel: z.number().int().min(1).optional().describe('Niveau visé sur cette compétence.'),
        dueDate: z.string().optional().describe('Échéance (YYYY-MM-DD).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ parentTaskId, title, description, estimateHours, requiredSkillId, requiredSkillLevel, dueDate }) =>
      run(async () => {
        // Le projet n'est pas demandé à l'appelant : il est déduit du parent —
        // un agent ne choisit pas dans quel projet il ouvre du travail.
        const parent = (await api.get(`tasks/${parentTaskId}`)) as { projectId?: string };
        if (!parent?.projectId) throw new Error('Tâche parente introuvable.');
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
      title: 'Synthèse des sous-tâches',
      description:
        "État de toutes les sous-tâches d'une tâche + les SORTIES STRUCTURÉES de leurs livrables " +
        "approuvés, en un appel. À lire AVANT de consolider votre livrable final : `allDone` dit si " +
        "tout est terminé, `pending` liste les numéros des sous-tâches qui manquent encore. " +
        "Le bloc `verification` donne le plancher de preuve du parent et le maillon le plus faible de " +
        "l'arbre : `below` (sous-tâches sous le plancher) et `missing` (sans livrable approuvé) " +
        "empêcheront la soumission en revue. " +
        "Consolider trop tôt est le meilleur moyen de se faire renvoyer en corrections.",
      inputSchema: {
        taskId: z.string().uuid().describe('Tâche parente (celle que vous détenez).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.get(`tasks/${taskId}/subtasks`)),
  );

  register(
    'vaks_execution_heartbeat',
    {
      title: "Prolonger le bail d'exécution",
      description:
        "Prolonge le bail de la tâche que vous exécutez — à appeler périodiquement pendant un travail " +
        "long (traitement de plusieurs minutes, longue chaîne de raisonnement). Sans battement, le bail " +
        "expire et la tâche est automatiquement rendue au vivier (statut TODO) : un autre acteur la " +
        "reprendra et votre travail sera perdu. Échoue avec `LEASE_LOST` si vous ne détenez plus la " +
        "tâche — dans ce cas ARRÊTEZ ce travail au lieu de continuer. " +
        "La réponse renvoie aussi vos LIMITES courantes (`limits`) : budget restant par enveloppe et " +
        "nombre de rejets de revue. Si `limits.budget.stop` est vrai, arrêtez de produire et soumettez " +
        "immédiatement ce que vous avez.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche en cours.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/heartbeat`, {})),
  );

  register(
    'vaks_submit_deliverable',
    {
      title: 'Soumettre un livrable',
      description:
        "Enregistre un livrable pour une tâche. Fournir l'artefact produit de l'une de ces façons : " +
        "`content` (le document markdown/texte — vaks-pm le stocke sur S3 et l'attache, IDÉAL pour un " +
        "agent docs), et/ou `url` (lien vers un dépôt / doc / PR externe), plus un `summary` en langage " +
        "naturel. La revue humaine porte sur ce livrable, jamais sur une déclaration « c'est fait ». " +
        "Soumettre AU MOINS un livrable avant de passer la tâche en revue (voir `vaks_submit_for_review`).",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        title: z.string().min(1).describe('Titre court du livrable.'),
        content: z
          .string()
          .optional()
          .describe(
            'Contenu texte/markdown du document produit. Persisté sur S3 (Garage) et rattaché au ' +
              'livrable — la façon recommandée pour un agent qui rédige un document.',
          ),
        filename: z
          .string()
          .optional()
          .describe('Nom de fichier pour `content` (défaut `<titre>.md`).'),
        url: z
          .string()
          .url()
          .optional()
          .describe("URL de l'artefact externe (dépôt, doc, PR…). Optionnel si `content` fourni."),
        summary: z
          .string()
          .optional()
          .describe('Résumé en langage naturel : ce qui a été produit, comment, les choix faits.'),
        commitSha: z
          .string()
          .optional()
          .describe(
            'SHA du commit associé au livrable (preuve CI). Requis pour la méthode ' +
              '`ci_signed` : vaks-pm apparie le résultat CI SIGNÉ reçu par webhook à ce SHA — ' +
              "le `status` que vous déclarez pour `ci_signed` est ignoré au profit du verdict CI réel.",
          ),
        structuredOutputs: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe(
            "Sorties STRUCTURÉES du livrable : dictionnaire PLAT clé → valeur scalaire " +
              '(ex. {"api_endpoint":"https://dev.api/v1","artifact_version":"2.4.0"}). Les tâches ' +
              "qui dépendent de celle-ci les reliront telles quelles dans leur contexte de travail " +
              "(`upstreamOutputs`) au lieu de chercher ces valeurs dans votre texte — c'est là que " +
              "naissent les erreurs. Y mettre les FAITS réutilisables (URL, version, nom de schéma, " +
              "identifiant), jamais le contenu du document. Propagé en aval seulement si le livrable " +
              'est APPROUVÉ.',
          ),
        verification: z
          .object({
            method: z
              .enum(['self_attest', 'tool_output', 'agent_validator', 'ci_signed', 'human'])
              .describe(
                'Méthode de preuve (AGENTS_VERIFICATION.md). Appelez `vaks_get_verification_requirements` ' +
                  'pour connaître le plancher requis AVANT de travailler. `ci_signed` = preuve signée par la ' +
                  'CI (fournir `commitSha`) ; `self_attest` = simple déclaration.',
              ),
            status: z.string().optional().describe('Statut (passed / failed / pending). Ignoré pour `ci_signed` (corroboré serveur).'),
            evidence: z.string().optional().describe('Lien ou extrait de preuve — optionnel.'),
          })
          .optional()
          .describe('Vérification du livrable (AGENTS_VERIFICATION.md) — optionnel.'),
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
      title: 'Soumettre une tâche en revue',
      description:
        "Passe une tâche de IN_PROGRESS à IN_REVIEW pour validation humaine. Requiert d'avoir soumis " +
        "au moins un livrable (via `vaks_submit_deliverable`). Selon la gouvernance de l'org, peut aussi " +
        "exiger d'avoir déclaré la consommation de la tâche (`vaks_report_run` : tokens/coût) — sinon " +
        "erreur `NO_RUN_DECLARED`. Un reviewer humain approuvera ou demandera " +
        "des changements ; en cas de changements demandés, reprenez le travail et resoumettez.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche à soumettre en revue.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.post(`tasks/${taskId}/submit-review`, {})),
  );

  register(
    'vaks_claim_validation_task',
    {
      title: 'Tirer une tâche de validation',
      description:
        "Réservé aux agents VALIDATEURS (capacité `deliverables:validate`). Tire une tâche de revue : " +
        "le backend trouve un livrable soumis par un AUTRE agent, en attente de validation, sur un projet " +
        "dont vous êtes membre, et vous le baille (bail de 30 min). Symétrie de `vaks_next_task` côté revue. " +
        "Renvoie `null` s'il n'y a rien à valider. Appelez ensuite `vaks_validation_heartbeat` pendant la " +
        "revue puis `vaks_submit_validation` pour rendre votre verdict. Vous ne validez JAMAIS votre propre travail.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => run(() => api.post('me/next-validation/claim', {})),
  );

  register(
    'vaks_validation_heartbeat',
    {
      title: 'Heartbeat de validation',
      description:
        "Prolonge le bail d'une tâche de validation que vous avez tirée (garde-la assignée pendant que vous " +
        "l'examinez). À appeler périodiquement pendant une revue longue. Échoue si le bail a expiré ou a été " +
        "repris — reprenez alors une tâche via `vaks_claim_validation_task`.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche du livrable en validation.'),
        deliverableId: z.string().uuid().describe('Identifiant (UUID) du livrable (= reviewId) en validation.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, deliverableId }) =>
      run(() => api.post(`tasks/${taskId}/deliverables/${deliverableId}/validation-heartbeat`, {})),
  );

  register(
    'vaks_submit_validation',
    {
      title: 'Rendre un verdict de validation',
      description:
        "Rend votre verdict d'agent validateur sur un livrable : `approve` (le livrable satisfait les critères) " +
        "ou `changes_requested` (il faut corriger). Votre verdict est une PREUVE indépendante (force 2), pas " +
        "l'approbation humaine finale. En mode `enforce` et si la vérification requise est exactement " +
        "`agent_validator`, un `approve` peut auto-approuver la tâche (parfois ré-échantillonnée vers un humain).",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche du livrable.'),
        deliverableId: z.string().uuid().describe('Identifiant (UUID) du livrable (= reviewId).'),
        verdict: z.enum(['approve', 'changes_requested']).describe('Votre verdict.'),
        note: z.string().optional().describe('Justification du verdict (ce qui va / ne va pas).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, deliverableId, verdict, note }) =>
      run(() => api.post(`tasks/${taskId}/deliverables/${deliverableId}/validation`, { verdict, note })),
  );

  register(
    'vaks_report_run',
    {
      title: 'Déclarer le coût d\'un run',
      description:
        "Déclare la consommation d'un run de travail : tokens (entrée/sortie) et/ou coût réel en €. " +
        "À appeler après avoir produit un livrable — sert la traçabilité et les budgets de l'agent " +
        "(concurrence, budget jour/mois, coût max par tâche). Rattacher au `taskId` ET au " +
        "`deliverableId` produit (requis pour passer la tâche en revue si l'org exige la déclaration). " +
        "Fournir un `runKey` stable rend l'appel idempotent : un réessai avec la même clé met à jour le " +
        "run au lieu de compter le coût deux fois. Vous ne déclarez que vos propres runs. " +
        "⚠️ La réponse porte l'état des enveloppes de coût (`budget`) : si `budget.stop` est vrai, une " +
        "enveloppe est épuisée — arrêtez de produire, soumettez ce que vous avez et ne revendiquez plus " +
        "rien. Si `taskReleased` est vrai, la tâche vous a été RETIRÉE (reprise humaine) : cessez " +
        "immédiatement. Déclarez vos runs au fil de l'eau plutôt qu'à la toute fin — c'est ce qui permet " +
        "au serveur de vous arrêter avant que la facture ne dérape.",
      inputSchema: {
        taskId: z.string().uuid().optional().describe('Tâche travaillée (optionnel).'),
        deliverableId: z.string().uuid().optional().describe('Livrable produit (à rattacher).'),
        model: z.string().optional().describe('Modèle utilisé, ex. claude-sonnet-5.'),
        tokensIn: z.number().int().nonnegative().optional().describe('Tokens en entrée.'),
        tokensOut: z.number().int().nonnegative().optional().describe('Tokens en sortie.'),
        cost: z.number().nonnegative().optional().describe('Coût réel en euros (optionnel : dérivé des tokens sinon).'),
        runKey: z.string().min(1).max(200).optional().describe("Clé d'idempotence stable (évite le double comptage sur réessai)."),
        note: z.string().optional().describe("Ce que le run a fait (optionnel)."),
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
      title: 'Créer un projet',
      description:
        "Crée un nouveau projet. `key` = code court unique (ex. « ACME »), `name` = libellé. " +
        "Nécessite que l'org ait activé l'écriture IA ET que l'utilisateur ait le droit de créer " +
        "un projet (Admin / Portfolio / Team Manager). Le projet démarre en brouillon.",
      inputSchema: {
        key: z
          .string()
          .regex(/^[A-Z0-9]{2,3}$/)
          .describe('Code court unique : 2 à 3 caractères MAJUSCULES/chiffres (ex. « ACM », « AZ »).'),
        name: z.string().min(1).describe('Nom du projet.'),
        description: z.string().optional().describe('Description — optionnel.'),
        billable: z.boolean().optional().describe('Projet facturable (défaut true) — optionnel.'),
        teamIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Équipes à rattacher (UUID) — requis pour un Team Manager.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ key, name, description, billable, teamIds }) =>
      run(() => api.post('projects', { key, name, description, billable, teamIds })),
  );

  register(
    'vaks_create_task',
    {
      title: 'Créer une tâche dans un projet',
      description:
        "Crée une tâche dans un projet. Peut directement pré-assigner via `assigneeIds`. " +
        "Récupérer l'id projet via `vaks_list_projects`, et choisir les assignés avec " +
        "`vaks_suggest_assignees` / `vaks_get_skill_gap` (skill ∩ dispo).",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        title: z.string().min(1).describe('Titre de la tâche.'),
        description: z.string().optional().describe('Description — optionnel.'),
        estimateHours: z.number().positive().optional().describe('Charge estimée en heures — optionnel.'),
        dueDate: z.string().optional().describe('Échéance (YYYY-MM-DD) — optionnel.'),
        assigneeIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Assignés à la création (UUID) — optionnel.'),
        labelIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Étiquettes à poser (UUID, cf. `vaks_list_labels`) — optionnel.'),
        isMilestone: z.boolean().optional().describe('Jalon — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, title, description, estimateHours, dueDate, assigneeIds, labelIds, isMilestone }) =>
      run(() =>
        api.post(`projects/${projectId}/tasks`, {
          title,
          description,
          estimateHours,
          dueDate,
          assigneeIds,
          labelIds,
          isMilestone,
        }),
      ),
  );

  register(
    'vaks_assign_task',
    {
      title: 'Assigner une tâche à des personnes',
      description:
        "Définit la liste des assignés d'une tâche (remplace les assignés existants). " +
        "Pour assigner selon compétences + disponibilité, appeler d'abord `vaks_suggest_assignees`.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        assigneeIds: z
          .array(z.string().uuid())
          .describe('Liste complète des assignés (UUID). Liste vide = désassigner.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, assigneeIds }) => run(() => api.patch(`tasks/${taskId}`, { assigneeIds })),
  );

  register(
    'vaks_log_time',
    {
      title: 'Saisir du temps sur une tâche',
      description:
        "Enregistre une saisie de temps sur une tâche pour l'utilisateur courant. " +
        "`durationMinutes` en minutes, `date` au format YYYY-MM-DD.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        date: z.string().describe('Jour de la saisie (YYYY-MM-DD).'),
        durationMinutes: z.number().int().positive().describe('Durée en minutes.'),
        description: z.string().optional().describe('Commentaire — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, date, durationMinutes, description }) =>
      run(() => api.post('time-entries', { taskId, date, durationMinutes, description })),
  );

  // --- Staffing assisté : « l'IA orchestre, le MOTEUR calcule » ---
  // On ne fait PAS calculer le timing par l'IA : l'auto-plan connaît capacité,
  // chemin critique (CPM), compétences et priorités. L'IA déclenche, présente
  // l'aperçu à l'humain, puis applique.

  register(
    'vaks_plan_project_preview',
    {
      title: "Planifier un projet — aperçu (n'applique rien)",
      description:
        "Calcule, via le moteur d'auto-planification, un plan d'allocation pour TOUT le projet " +
        "(respecte capacité réelle, dépendances/CPM, compétences, priorités) **sans rien persister**. " +
        "Retourne les allocations proposées + avertissements (dépassement d'échéance, fenêtre trop " +
        "courte). À présenter à l'utilisateur AVANT d'appliquer via `vaks_plan_project_apply`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        preserve: z
          .enum(['manual_autosplit', 'manual', 'none'])
          .optional()
          .describe(
            "Ce que le plan conserve (le passé/aujourd'hui est toujours gelé). " +
              "'manual_autosplit' (défaut) garde le manuel + auto-split ; 'manual' garde le manuel ; 'none' replanifie tout le futur.",
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
      title: 'Planifier un projet — appliquer',
      description:
        "Applique le plan d'auto-planification au projet : crée/remplace les allocations FUTURES " +
        "(le passé et aujourd'hui sont gelés). Idempotent (ré-appliquer redonne le même plan). " +
        "Demander confirmation à l'utilisateur, idéalement après `vaks_plan_project_preview`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        preserve: z
          .enum(['manual_autosplit', 'manual', 'none'])
          .optional()
          .describe('Idem aperçu — défaut manual_autosplit.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, preserve }) =>
      run(() => api.post('workload/autoplan', { scope: 'project', projectId, persist: true, preserve })),
  );

  // --- Compétences : création / demande (écriture) ---
  // RBAC fin appliqué côté API : créer un skill = policy `canWriteCatalog`
  // (défaut team_lead/admin) ; demander = policy `canRequestSkill` (PM).

  register(
    'vaks_create_skill',
    {
      title: 'Créer une compétence au catalogue',
      description:
        "Ajoute une compétence au catalogue de l'organisation. Réservé aux rôles autorisés à " +
        "écrire le catalogue (lead d'équipe / admin selon la policy org) — sinon l'API refuse. " +
        "Idempotent sur le nom (ne crée pas de doublon).",
      inputSchema: {
        name: z.string().min(1).describe('Nom de la compétence (ex. « Kubernetes »).'),
        category: z.string().optional().describe('Famille/catégorie (ex. « DevOps ») — optionnel.'),
        description: z.string().optional().describe('Description — optionnel.'),
        color: z.string().optional().describe('Couleur hex (ex. #3b82f6) — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, category, description, color }) =>
      run(() => api.post('skills', { name, category, description, color })),
  );

  register(
    'vaks_request_skill',
    {
      title: 'Demander une compétence au lead d\'une équipe',
      description:
        "Adresse une demande de compétence au lead d'une équipe (le produit notifie le lead par " +
        "email + webhook). Indiquer une compétence existante (`skillId`) OU en proposer une " +
        "nouvelle (`proposedName`). `type` : ASSIGN_SKILL (assigner un membre déjà compétent), " +
        "TRAINING (former quelqu'un), EXTERNAL (renfort externe). Trouver le `teamId` via " +
        "`vaks_list_teams`. Réservé aux rôles autorisés (PM) — sinon l'API refuse.",
      inputSchema: {
        teamId: z.string().uuid().describe("Équipe dont le lead reçoit la demande (UUID)."),
        type: z
          .enum(['ASSIGN_SKILL', 'TRAINING', 'EXTERNAL'])
          .describe('Nature de la demande.'),
        skillId: z.string().uuid().optional().describe('Compétence existante (UUID) — ou proposedName.'),
        proposedName: z.string().optional().describe('Nom d\'une compétence à créer — ou skillId.'),
        desiredLevel: z.number().int().optional().describe('Niveau souhaité — optionnel.'),
        projectId: z.string().uuid().optional().describe('Projet concerné (UUID) — optionnel.'),
        taskId: z.string().uuid().optional().describe('Tâche concernée (UUID) — optionnel.'),
        targetUserId: z.string().uuid().optional().describe('Personne visée (UUID) — optionnel.'),
        note: z.string().optional().describe('Précisions libres — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(() => api.post('skill-requests', args)),
  );

  // --- Cycle de vie des tâches & collaboration (écriture) ---

  register(
    'vaks_update_task',
    {
      title: 'Mettre à jour une tâche',
      description:
        "Modifie une tâche : statut (faire avancer le travail), titre, description, priorité, " +
        "estimé, dates, étiquettes — ET la configuration agent d'une tâche (garde-fous, critères " +
        "d'acceptation, budget agent). Statuts usuels : TODO, IN_PROGRESS, DONE, ON_HOLD (motif via " +
        "statusReason). Le serveur valide les transitions de statut autorisées. " +
        "⚠️ Les champs de gouvernance (`agentGuardrails`, `acceptanceCriteria`, `agentCostBudget`) " +
        "sont refusés à un jeton d'AGENT — un agent ne fixe pas la barre sur laquelle il est jugé. " +
        "Ils sont destinés à un humain qui prépare la tâche.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        status: z
          .enum(['TODO', 'IN_PROGRESS', 'DONE', 'ON_HOLD'])
          .optional()
          .describe('Nouveau statut — optionnel.'),
        statusReason: z.string().optional().describe('Motif (utile pour ON_HOLD) — optionnel.'),
        title: z.string().optional().describe('Nouveau titre — optionnel.'),
        description: z.string().optional().describe('Nouvelle description — optionnel.'),
        priority: z
          .enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
          .optional()
          .describe('Priorité — optionnel.'),
        estimateHours: z.number().positive().optional().describe('Charge estimée (h) — optionnel.'),
        dueDate: z.string().optional().describe('Échéance (YYYY-MM-DD) — optionnel.'),
        startDate: z.string().optional().describe('Début prévu (YYYY-MM-DD) — optionnel.'),
        labelIds: z
          .array(z.string().uuid())
          .optional()
          .describe('Remplace les étiquettes de la tâche (UUID, cf. `vaks_list_labels`) — optionnel.'),
        agentGuardrails: z
          .string()
          .nullable()
          .optional()
          .describe("Garde-fous spécifiques à la tâche pour un agent (complète ceux du projet). Humain seulement."),
        acceptanceCriteria: z
          .array(
            z.object({
              text: z.string().min(1).max(500).describe("Un critère de « fait »."),
              done: z.boolean().optional().describe('Coché ou non (défaut false).'),
            }),
          )
          .optional()
          .describe(
            'Checklist de revue de la tâche (REMPLACE la liste entière). Sert de grille au reviewer et ' +
              "cadre l'agent en entrée. Humain seulement.",
          ),
        agentCostBudget: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe('Enveloppe de coût agent (€) de cette tâche. null = pas de plafond. Humain seulement.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, ...patch }) => run(() => api.patch(`tasks/${taskId}`, patch)),
  );

  register(
    'vaks_create_dependency',
    {
      title: 'Créer une dépendance entre tâches (Gantt)',
      description:
        "Lie deux tâches par une dépendance (par défaut Finish-to-Start). `type` : FS, SS, FF, SF. " +
        "`lagDays` = décalage optionnel. Sert à construire le planning / chemin critique. Le serveur " +
        "refuse les cycles.",
      inputSchema: {
        predecessorId: z.string().uuid().describe('Tâche prédécesseur (UUID).'),
        successorId: z.string().uuid().describe('Tâche successeur (UUID).'),
        type: z.enum(['FS', 'SS', 'FF', 'SF']).optional().describe('Type de lien — défaut FS.'),
        lagDays: z.number().int().optional().describe('Décalage en jours — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ predecessorId, successorId, type, lagDays }) =>
      run(() => api.post('dependencies', { predecessorId, successorId, type, lagDays })),
  );

  register(
    'vaks_post_comment',
    {
      title: 'Poster un commentaire sur une tâche',
      description:
        "Ajoute un commentaire au fil d'une tâche (les @mentions par identifiant de handle " +
        "déclenchent une notification). Utile pour résumer, signaler un blocage, demander un avis.",
      inputSchema: {
        taskId: z.string().uuid().describe('Identifiant (UUID) de la tâche.'),
        body: z.string().min(1).describe('Contenu du commentaire (markdown léger, @mentions).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, body }) => run(() => api.post(`tasks/${taskId}/comments`, { body })),
  );

  register(
    'vaks_notify_stakeholders',
    {
      title: 'Prévenir les parties prenantes du projet (annonce)',
      description:
        "Envoie une ANNONCE aux parties prenantes d'un projet : email brandé + webhook (carte Teams), " +
        "avec attribution en clair (« Envoyé par <utilisateur> via l'assistant IA »). L'audience est " +
        "résolue CÔTÉ SERVEUR par rôles — jamais d'adresses email libres. `audience` : 'pm' (chefs de " +
        "projet), 'sponsors' (membres tagués sponsor), 'members' (tous les membres directs), 'watchers' " +
        "(abonnés au projet / à la tâche liée). Utilise-le quand l'utilisateur veut informer d'un " +
        "changement (périmètre, décalage de jalon, décision). Rédige `title` court et `body` factuel " +
        "(texte brut — le HTML/markdown n'est pas interprété, les URLs ne seront pas cliquables). " +
        "Anti-spam : une annonce max par projet toutes les ~2 minutes.",
      inputSchema: {
        projectId: z.string().uuid().describe('Projet concerné (UUID).'),
        title: z.string().min(1).max(200).describe("Titre de l'annonce (sujet de l'email, préfixé par org/projet)."),
        body: z.string().min(1).max(4000).describe("Corps de l'annonce, texte brut (max 4000 caractères)."),
        audience: z
          .array(z.enum(['pm', 'members', 'watchers', 'sponsors']))
          .min(1)
          .describe("Audiences à prévenir (résolues serveur). Ex. ['pm','sponsors']."),
        taskId: z.string().uuid().optional().describe('Tâche de contexte — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, title, body, audience, taskId }) =>
      run(() => api.post(`projects/${projectId}/announcements`, { title, body, audience, taskId })),
  );

  register(
    'vaks_create_time_off',
    {
      title: 'Déclarer une absence (time-off)',
      description:
        "Enregistre une absence pour un utilisateur sur une plage de dates → met sa capacité à 0 " +
        "sur la période (le moteur de staffing en tient compte). `type` ex. VACATION, SICK, OTHER.",
      inputSchema: {
        userId: z.string().uuid().describe("Utilisateur concerné (UUID)."),
        startDate: z.string().describe('Début (YYYY-MM-DD).'),
        endDate: z.string().describe('Fin (YYYY-MM-DD).'),
        type: z.string().optional().describe('Type d\'absence — optionnel.'),
        notes: z.string().optional().describe('Note — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ userId, startDate, endDate, type, notes }) =>
      run(() => api.post('workload/time-offs', { userId, startDate, endDate, type, notes })),
  );

  register(
    'vaks_set_user_skill',
    {
      title: 'Définir le niveau de compétence d\'un utilisateur',
      description:
        "Fixe (ou met à jour) le niveau d'une compétence pour un utilisateur. Réservé par l'API au " +
        "lead d'une équipe de la personne / admin (ou self-edit si la policy l'autorise) — sinon 403. " +
        "Utile après une formation pour refléter la montée en compétence.",
      inputSchema: {
        userId: z.string().uuid().describe("Utilisateur (UUID)."),
        skillId: z.string().uuid().describe('Compétence (UUID).'),
        level: z.number().int().min(1).max(100).describe('Niveau (1..N selon la grille org).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ userId, skillId, level }) =>
      run(() => api.put(`users/${userId}/skills/${skillId}`, { level })),
  );

  // --- Création en lot (bootstrap projet depuis un brief) ---

  register(
    'vaks_create_tasks',
    {
      title: 'Créer plusieurs tâches d\'un coup',
      description:
        "Crée un lot de tâches dans un projet — pour matérialiser tout un découpage en un seul appel " +
        "(typiquement après `vaks_create_project` à partir d'un brief). Tolère les échecs partiels : " +
        "renvoie le résultat tâche par tâche (id créé ou erreur).",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).describe('Titre de la tâche.'),
              description: z.string().optional(),
              estimateHours: z.number().positive().optional(),
              dueDate: z.string().optional().describe('Échéance (YYYY-MM-DD).'),
              assigneeIds: z.array(z.string().uuid()).optional(),
              isMilestone: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(50)
          .describe('Liste des tâches à créer (1 à 50).'),
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

  // --- Étiquettes & cycle de vie projet (écriture) ---

  register(
    'vaks_create_label',
    {
      title: 'Créer une étiquette de projet',
      description:
        "Ajoute une étiquette (label) à un projet. À poser ensuite sur des tâches via `labelIds` " +
        "(`vaks_create_task` / `vaks_update_task`).",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        name: z.string().min(1).describe('Nom de l\'étiquette.'),
        color: z.string().optional().describe('Couleur hex (ex. #3b82f6) — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, name, color }) =>
      run(() => api.post(`projects/${projectId}/labels`, { name, color })),
  );

  register(
    'vaks_set_project_status',
    {
      title: 'Changer le statut d\'un projet (cycle de vie)',
      description:
        "Fait avancer un projet dans son cycle de vie : ex. activer (→ ACTIVE), clôturer (→ COMPLETED), " +
        "archiver (→ ARCHIVED), remettre en brouillon (→ DRAFT). Les transitions autorisées dépendent " +
        "de l'état courant — lire `allowedTransitions` via `vaks_list_projects`. NB : les étapes d'offre " +
        "commerciale (OFFER_SENT / accept / refus) passent par d'autres actions et ne sont pas couvertes ici.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        status: z
          .enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED'])
          .describe('Statut cible (doit être dans allowedTransitions du projet).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, status }) => run(() => api.patch(`projects/${projectId}`, { status })),
  );

  // --- Coûts hors main-d'œuvre / finance (écriture) ---
  // Triple verrou : ce bloc n'est exposé que si l'écriture IA est ON ; l'API
  // refuse en plus si « finance exposée à l'IA » est OFF (FinanceApiGateGuard)
  // ou si l'utilisateur n'a pas `finance:manage` dans son RBAC.

  register(
    'vaks_add_expense',
    {
      title: 'Ajouter un coût hors main-d\'œuvre',
      description:
        "Crée un coût hors main-d'œuvre (non-labor) sur un projet : licence, matériel, cloud, " +
        "sous-traitance, autre. ⚠️ Triple verrou : écriture IA activée + finance exposée à l'IA + " +
        "droit `finance:manage` de l'utilisateur — sinon refus.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        category: z
          .enum(['LICENSE', 'HARDWARE', 'CLOUD', 'SUBCONTRACTOR', 'OTHER'])
          .describe('Catégorie du coût.'),
        label: z.string().min(1).max(200).describe('Libellé court.'),
        amount: z.number().min(0).describe('Coût interne (par période si récurrent).'),
        billAmount: z.number().min(0).optional().describe('Montant refacturé au client — optionnel.'),
        quantity: z.number().min(0).optional().describe('Quantité — optionnel.'),
        description: z.string().max(2000).optional().describe('Détail — optionnel.'),
        status: z.enum(['PLANNED', 'INCURRED']).optional().describe('Statut (défaut PLANNED).'),
        recurrence: z
          .enum(['ONE_OFF', 'MONTHLY', 'ANNUAL'])
          .optional()
          .describe('Récurrence (défaut ONE_OFF).'),
        startDate: z.string().optional().describe('Début (YYYY-MM-DD) — optionnel.'),
        endDate: z.string().optional().describe('Fin (YYYY-MM-DD) — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ projectId, ...body }) => run(() => api.post(`projects/${projectId}/expenses`, body)),
  );

  register(
    'vaks_update_expense',
    {
      title: 'Modifier un coût hors main-d\'œuvre',
      description:
        "Met à jour un coût hors main-d'œuvre existant (champs partiels). Récupérer l'`expenseId` via " +
        "`vaks_list_expenses`. ⚠️ Mêmes verrous finance que `vaks_add_expense`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        expenseId: z.string().uuid().describe('Identifiant (UUID) du coût.'),
        category: z.enum(['LICENSE', 'HARDWARE', 'CLOUD', 'SUBCONTRACTOR', 'OTHER']).optional(),
        label: z.string().min(1).max(200).optional(),
        amount: z.number().min(0).optional(),
        billAmount: z.number().min(0).optional(),
        quantity: z.number().min(0).optional(),
        description: z.string().max(2000).optional(),
        status: z.enum(['PLANNED', 'INCURRED']).optional(),
        recurrence: z.enum(['ONE_OFF', 'MONTHLY', 'ANNUAL']).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, expenseId, ...patch }) =>
      run(() => api.patch(`projects/${projectId}/expenses/${expenseId}`, patch)),
  );

  register(
    'vaks_delete_expense',
    {
      title: 'Supprimer un coût hors main-d\'œuvre',
      description:
        "Supprime un coût hors main-d'œuvre. Récupérer l'`expenseId` via `vaks_list_expenses`. " +
        "⚠️ Mêmes verrous finance que `vaks_add_expense`.",
      inputSchema: {
        projectId: z.string().uuid().describe('Identifiant (UUID) du projet.'),
        expenseId: z.string().uuid().describe('Identifiant (UUID) du coût à supprimer.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, expenseId }) =>
      run(() => api.delete(`projects/${projectId}/expenses/${expenseId}`)),
  );

  // ============================================================
  // Clients & contacts (écriture) — scope client:manage
  // ============================================================
  register(
    'vaks_create_client',
    {
      title: 'Créer un client',
      description: 'Crée un client (compte) dans le portefeuille.',
      inputSchema: {
        name: z.string().min(1).describe('Nom du client.'),
        company: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
        status: z.enum(['PROSPECT', 'ACTIVE', 'ARCHIVED']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (body) => run(() => api.post('clients', body)),
  );
  register(
    'vaks_update_client',
    {
      title: 'Modifier un client',
      description: 'Met à jour un client (champs partiels).',
      inputSchema: {
        clientId: z.string().uuid(),
        name: z.string().min(1).optional(),
        company: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        address: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        status: z.enum(['PROSPECT', 'ACTIVE', 'ARCHIVED']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ clientId, ...body }) => run(() => api.patch(`clients/${clientId}`, body)),
  );
  register(
    'vaks_delete_client',
    {
      title: 'Supprimer un client',
      description: 'Supprime un client. Action destructive.',
      inputSchema: { clientId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ clientId }) => run(() => api.delete(`clients/${clientId}`)),
  );
  register(
    'vaks_create_contact',
    {
      title: 'Ajouter un contact à un client',
      description: 'Crée un contact rattaché à un client.',
      inputSchema: {
        clientId: z.string().uuid(),
        name: z.string().min(1),
        title: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        notes: z.string().optional(),
        isPrimary: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ clientId, ...body }) => run(() => api.post(`clients/${clientId}/contacts`, body)),
  );
  register(
    'vaks_update_contact',
    {
      title: 'Modifier un contact',
      description: 'Met à jour un contact (champs partiels).',
      inputSchema: {
        clientId: z.string().uuid(),
        contactId: z.string().uuid(),
        name: z.string().min(1).optional(),
        title: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        isPrimary: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ clientId, contactId, ...body }) =>
      run(() => api.patch(`clients/${clientId}/contacts/${contactId}`, body)),
  );
  register(
    'vaks_delete_contact',
    {
      title: 'Supprimer un contact',
      description: 'Supprime un contact. Action destructive.',
      inputSchema: { clientId: z.string().uuid(), contactId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ clientId, contactId }) => run(() => api.delete(`clients/${clientId}/contacts/${contactId}`)),
  );

  // ============================================================
  // Équipes (écriture) — scopes team:create / team:manage_members
  // ============================================================
  register(
    'vaks_create_team',
    {
      title: 'Créer une équipe',
      description: 'Crée une équipe (groupe de travail).',
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (body) => run(() => api.post('teams', body)),
  );
  register(
    'vaks_update_team',
    {
      title: 'Modifier une équipe',
      description: 'Met à jour une équipe (nom, description, couleur…).',
      inputSchema: {
        teamId: z.string().uuid(),
        name: z.string().min(1).optional(),
        displayName: z.string().nullable().optional(),
        description: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ teamId, ...body }) => run(() => api.patch(`teams/${teamId}`, body)),
  );
  register(
    'vaks_add_team_member',
    {
      title: 'Ajouter un membre à une équipe',
      description: 'Ajoute un utilisateur à une équipe (optionnellement comme lead).',
      inputSchema: {
        teamId: z.string().uuid(),
        userId: z.string().uuid(),
        isLead: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ teamId, ...body }) => run(() => api.post(`teams/${teamId}/members`, body)),
  );
  register(
    'vaks_update_team_member',
    {
      title: 'Modifier un membre d\'équipe',
      description: 'Change le statut de lead (et, pour un lead/admin, les taux par défaut) d\'un membre.',
      inputSchema: {
        teamId: z.string().uuid(),
        userId: z.string().uuid(),
        isLead: z.boolean().optional(),
        canCreateNonBillableProject: z.boolean().nullable().optional(),
        defaultCostRate: z.number().nullable().optional(),
        defaultBillRate: z.number().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ teamId, userId, ...body }) => run(() => api.patch(`teams/${teamId}/members/${userId}`, body)),
  );
  register(
    'vaks_remove_team_member',
    {
      title: 'Retirer un membre d\'équipe',
      description: 'Retire un utilisateur d\'une équipe.',
      inputSchema: { teamId: z.string().uuid(), userId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ teamId, userId }) => run(() => api.delete(`teams/${teamId}/members/${userId}`)),
  );
  register(
    'vaks_assign_team_to_project',
    {
      title: 'Affecter une équipe à un projet',
      description: 'Rattache une équipe à un projet (les membres deviennent affectables).',
      inputSchema: { projectId: z.string().uuid(), teamId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, teamId }) => run(() => api.post(`projects/${projectId}/teams`, { teamId })),
  );
  register(
    'vaks_unassign_team_from_project',
    {
      title: 'Détacher une équipe d\'un projet',
      description: 'Retire une équipe d\'un projet.',
      inputSchema: { projectId: z.string().uuid(), teamId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, teamId }) => run(() => api.delete(`projects/${projectId}/teams/${teamId}`)),
  );

  // ============================================================
  // Allocations manuelles & horaires de capacité — scope allocation:manage
  // ============================================================
  register(
    'vaks_create_allocation',
    {
      title: 'Créer une allocation (manuelle)',
      description:
        'Alloue un utilisateur à une tâche sur une plage de dates, à N heures/jour. Complète l\'auto-plan ' +
        '(`vaks_plan_project_*`) pour des réglages à la main.',
      inputSchema: {
        userId: z.string().uuid(),
        taskId: z.string().uuid(),
        startDate: z.string().describe('YYYY-MM-DD.'),
        endDate: z.string().describe('YYYY-MM-DD.'),
        hoursPerDay: z.number().positive(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (body) => run(() => api.post('allocations', body)),
  );
  register(
    'vaks_update_allocation',
    {
      title: 'Modifier une allocation',
      description: 'Met à jour une allocation (réassigner, déplacer les dates, changer les heures/jour).',
      inputSchema: {
        id: z.string().uuid(),
        userId: z.string().uuid().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        hoursPerDay: z.number().positive().optional(),
        notes: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...body }) => run(() => api.patch(`allocations/${id}`, body)),
  );
  register(
    'vaks_delete_allocation',
    {
      title: 'Supprimer une allocation',
      description: 'Supprime une allocation.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => run(() => api.delete(`allocations/${id}`)),
  );
  register(
    'vaks_set_work_schedule',
    {
      title: 'Définir l\'horaire de capacité d\'un utilisateur',
      description:
        'Définit la capacité hebdomadaire (heures par jour Mon→Sun) et le taux d\'occupation d\'un utilisateur.',
      inputSchema: {
        userId: z.string().uuid(),
        effectiveFrom: z.string().optional().describe('YYYY-MM-DD — optionnel.'),
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
  register(
    'vaks_update_time_off',
    {
      title: 'Modifier une absence',
      description: 'Met à jour une absence / un congé.',
      inputSchema: {
        id: z.string().uuid(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        type: z.enum(['VACATION', 'SICK', 'PERSONAL', 'PARENTAL', 'OTHER']).optional(),
        notes: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...body }) => run(() => api.patch(`time-offs/${id}`, body)),
  );
  register(
    'vaks_delete_time_off',
    {
      title: 'Supprimer une absence',
      description: 'Supprime une absence / un congé.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => run(() => api.delete(`time-offs/${id}`)),
  );

  // ============================================================
  // Finance — taux & budget (écriture) — scope finance:manage (mêmes verrous que les dépenses)
  // ============================================================
  register(
    'vaks_set_project_rate',
    {
      title: 'Définir le taux d\'un utilisateur sur un projet',
      description:
        'Fixe le taux coût (et refacturation) d\'un utilisateur sur un projet. ⚠️ Mêmes verrous finance que les dépenses.',
      inputSchema: {
        projectId: z.string().uuid(),
        userId: z.string().uuid(),
        costRate: z.number().min(0).describe('Taux coût horaire.'),
        billRate: z.number().min(0).nullable().optional().describe('Taux refacturé — optionnel.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, userId, ...body }) =>
      run(() => api.put(`projects/${projectId}/rates/${userId}`, body)),
  );
  register(
    'vaks_delete_project_rate',
    {
      title: 'Supprimer le taux d\'un utilisateur sur un projet',
      description: 'Retire le taux explicite (retour au défaut user/projet). ⚠️ Mêmes verrous finance.',
      inputSchema: { projectId: z.string().uuid(), userId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, userId }) => run(() => api.delete(`projects/${projectId}/rates/${userId}`)),
  );
  register(
    'vaks_add_project_context',
    {
      title: 'Créer ou mettre à jour une note de contexte IA sur un projet',
      description:
        "Dépose un document TEXTE dans l'espace documents du projet et le marque « contexte IA » : il " +
        "devient lisible par les agents sur toutes les tâches du projet (compte rendu, décisions " +
        "d'architecture, glossaire, consignes de style…). Le contenu est passé en clair et le fichier " +
        "est fabriqué côté serveur. Extensions autorisées via le nom : .md, .txt, .csv, .json, .yaml, " +
        ".html — un binaire ne peut PAS être créé par ce chemin. Plafond 1 Mo.\n\n" +
        "**Écriture par NOM, sans identifiant** : si une note textuelle du même nom existe déjà dans " +
        "le dossier cible, son contenu est REMPLACÉ (la réponse porte `replaced:true`). Plus besoin " +
        "de récupérer un `docId` au préalable : réappeler ce tool avec le même nom met simplement la " +
        "note à jour, sans empiler d'homonyme. Pour forcer un second document, passer " +
        "`onDuplicate:\"create\"`.\n\n" +
        "Sans `folderId`, la note atterrit dans le dossier « contexte IA » racine du projet s'il en " +
        "existe un seul, sinon à la racine.",
      inputSchema: {
        projectId: z.string().uuid(),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('Nom du fichier, extension comprise (ex. « decisions-archi.md »).'),
        content: z.string().min(1).describe('Contenu texte de la note de contexte.'),
        folderId: z
          .string()
          .uuid()
          .optional()
          .describe('Dossier cible (défaut : dossier « contexte IA » racine, sinon racine).'),
        aiContext: z
          .boolean()
          .optional()
          .describe('false pour déposer sans exposer aux agents (défaut : true).'),
        onDuplicate: z
          .enum(['replace', 'create'])
          .optional()
          .describe(
            "Homonyme dans le dossier cible : « replace » (défaut) met à jour la note existante, " +
              '« create » force un second document.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...body }) =>
      run(() => api.post(`projects/${projectId}/documents/text`, body)),
  );
  register(
    'vaks_update_project_context',
    {
      title: 'Mettre à jour une note de contexte IA',
      description:
        "Remplace le CONTENU d'une note de contexte existante (même document, même id — les agents " +
        "voient la version à jour), et/ou la déplace, et/ou l'exclut du contexte IA. Refuse les " +
        "documents non textuels : on ne remplace pas un PDF par du texte. Fournir `content` pour " +
        "réécrire, `folderId` pour ranger (null = racine), `aiContext: false` pour détacher sans " +
        "supprimer. Récupérer le `docId` via `vaks_read` sur `projects/<id>/documents`.",
      inputSchema: {
        projectId: z.string().uuid(),
        docId: z.string().uuid(),
        content: z.string().min(1).optional().describe('Nouveau contenu texte (remplace intégralement).'),
        folderId: z.string().uuid().nullable().optional(),
        aiContext: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, docId, content, ...rest }) =>
      run(async () => {
        // Deux mutations distinctes côté API : le contenu vit dans S3, les
        // métadonnées en base. On réécrit d'abord, on range ensuite — ainsi un
        // échec de rangement ne laisse pas un contenu périmé derrière lui.
        const meta = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        if (content === undefined && !Object.keys(meta).length) {
          throw new Error('Rien à mettre à jour : fournir `content`, `folderId` ou `aiContext`.');
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
  register(
    'vaks_set_project_budget',
    {
      title: 'Définir le budget / taux par défaut d\'un projet',
      description:
        'Fixe l\'enveloppe budgétaire et/ou les taux coût/refacturation par défaut du projet. ⚠️ Mêmes verrous finance.',
      inputSchema: {
        projectId: z.string().uuid(),
        budgetAmount: z.number().min(0).nullable().optional(),
        defaultCostRate: z.number().min(0).nullable().optional(),
        defaultBillRate: z.number().min(0).nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...body }) => run(() => api.put(`projects/${projectId}/budget`, body)),
  );

  // ============================================================
  // Projet (métadonnées) & tâches — scopes project:update / task:delete
  // ============================================================
  register(
    'vaks_update_project',
    {
      title: 'Modifier un projet (métadonnées + configuration agents IA)',
      description:
        'Met à jour un projet : métadonnées (nom, description, dates, client) ET toute la ' +
        "configuration des agents IA (activation, brief, garde-fous, budget, exigence de " +
        "vérification). Sert typiquement à PRÉPARER un projet pour les agents dans la foulée de sa " +
        "création. Pour le STATUT (cycle de vie), utiliser `vaks_set_project_status` ; pour le budget " +
        "financier humain, `vaks_set_project_budget`. " +
        "⚠️ Activer les agents (`agentsEnabled:true`) EXIGE un brief non vide (`agentContext` ou " +
        "`agentBrief`) — le serveur refuse sinon. Réservé aux humains : les jetons d'agent n'ont pas " +
        "la permission de modifier un projet.",
      inputSchema: {
        projectId: z.string().uuid(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        startDate: z.string().nullable().optional().describe('YYYY-MM-DD ou null pour effacer.'),
        dueDate: z.string().nullable().optional().describe('YYYY-MM-DD ou null pour effacer.'),
        clientId: z.string().uuid().nullable().optional().describe('Rattacher à un client, ou null pour détacher.'),
        agentsEnabled: z
          .boolean()
          .optional()
          .describe('Ouvrir le projet aux agents IA. Exige un brief (agentContext/agentBrief) non vide.'),
        agentContext: z
          .string()
          .nullable()
          .optional()
          .describe('Brief libre (markdown) : rôle des agents, conventions de sortie, où déposer, hors-périmètre.'),
        agentBrief: z
          .object({
            role: z.string().nullable().optional().describe("Rôle et mission de l'agent sur ce projet."),
            outputConventions: z.string().nullable().optional().describe('Format, style, langue, structure attendue.'),
            deliveryTarget: z.string().nullable().optional().describe('Où déposer les livrables.'),
            outOfScope: z.string().nullable().optional().describe("Ce que l'agent ne doit surtout pas faire."),
          })
          .nullable()
          .optional()
          .describe('Brief STRUCTURÉ (alternative à agentContext) — quatre champs courts.'),
        agentGuardrails: z
          .string()
          .nullable()
          .optional()
          .describe("Garde-fous au niveau projet : ce qu'aucun agent ne doit faire ici."),
        agentAutoCloseOnApproval: z
          .boolean()
          .nullable()
          .optional()
          .describe('Clôturer automatiquement une tâche à l\'approbation. null = hériter du réglage org.'),
        agentCostBudget: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe('Enveloppe totale de coût agent (€) du projet. null = pas de plafond.'),
        stakes: z
          .enum(['low', 'medium', 'high', 'critical'])
          .nullable()
          .optional()
          .describe("Enjeu du projet : dérive le niveau de preuve exigé des livrables d'agents."),
        verificationCapabilities: z
          .array(z.enum(['tool_output', 'agent_validator', 'ci_signed']))
          .nullable()
          .optional()
          .describe('Méthodes de vérification mécaniques disponibles sur ce projet.'),
        verificationMode: z
          .enum(['report_only', 'enforce'])
          .nullable()
          .optional()
          .describe('report_only = journalise ; enforce = bloque sous le plancher. null = hérite de l\'org.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, ...body }) => run(() => api.patch(`projects/${projectId}`, body)),
  );
  register(
    'vaks_delete_task',
    {
      title: 'Supprimer une tâche',
      description: 'Supprime (soft-delete) une tâche. Action destructive.',
      inputSchema: { taskId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }) => run(() => api.delete(`tasks/${taskId}`)),
  );

  // ============================================================
  // Labels (modif/suppr) — scope project:update
  // ============================================================
  register(
    'vaks_update_label',
    {
      title: 'Modifier une étiquette',
      description: 'Renomme / recolore une étiquette de projet.',
      inputSchema: {
        projectId: z.string().uuid(),
        labelId: z.string().uuid(),
        name: z.string().min(1).optional(),
        color: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, labelId, ...body }) =>
      run(() => api.patch(`projects/${projectId}/labels/${labelId}`, body)),
  );
  register(
    'vaks_delete_label',
    {
      title: 'Supprimer une étiquette',
      description: 'Supprime une étiquette de projet.',
      inputSchema: { projectId: z.string().uuid(), labelId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, labelId }) => run(() => api.delete(`projects/${projectId}/labels/${labelId}`)),
  );

  // ============================================================
  // Dépendances (modif/suppr) — scope task:update
  // ============================================================
  register(
    'vaks_update_dependency',
    {
      title: 'Modifier une dépendance',
      description: 'Change le type (FS/SS/FF/SF) ou le décalage (lagDays) d\'une dépendance.',
      inputSchema: {
        id: z.string().uuid(),
        type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(),
        lagDays: z.number().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...body }) => run(() => api.patch(`dependencies/${id}`, body)),
  );
  register(
    'vaks_delete_dependency',
    {
      title: 'Supprimer une dépendance',
      description: 'Supprime un lien de dépendance entre deux tâches.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => run(() => api.delete(`dependencies/${id}`)),
  );

  // ============================================================
  // Saisies de temps (modif/suppr) — scope time:log
  // ============================================================
  register(
    'vaks_update_time_entry',
    {
      title: 'Modifier une saisie de temps',
      description: 'Met à jour une saisie de temps existante.',
      inputSchema: {
        id: z.string().uuid(),
        date: z.string().optional().describe('YYYY-MM-DD.'),
        durationMinutes: z.number().int().positive().optional(),
        description: z.string().nullable().optional(),
        overtimeMinutes: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...body }) => run(() => api.patch(`time-entries/${id}`, body)),
  );
  register(
    'vaks_delete_time_entry',
    {
      title: 'Supprimer une saisie de temps',
      description: 'Supprime une saisie de temps.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => run(() => api.delete(`time-entries/${id}`)),
  );

  // ============================================================
  // Compétences (écriture avancée) — scopes project:view / project:update / task:update
  // ============================================================
  register(
    'vaks_resolve_skill_request',
    {
      title: 'Traiter une demande de compétence',
      description:
        'Met à jour le statut d\'une demande de compétence (OPEN→ACK→RESOLVED, ou REJECTED) — action du lead d\'équipe.',
      inputSchema: {
        id: z.string().uuid(),
        status: z.enum(['OPEN', 'ACK', 'RESOLVED', 'REJECTED']),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...body }) => run(() => api.patch(`skill-requests/${id}/status`, body)),
  );
  register(
    'vaks_update_skill',
    {
      title: 'Modifier une compétence du catalogue',
      description: 'Met à jour une compétence (nom, description, couleur, catégorie, alias).',
      inputSchema: {
        skillId: z.string().uuid(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        color: z.string().optional(),
        category: z.string().optional(),
        aliases: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ skillId, ...body }) => run(() => api.patch(`skills/${skillId}`, body)),
  );
  register(
    'vaks_delete_skill',
    {
      title: 'Supprimer une compétence du catalogue',
      description: 'Supprime (soft-delete) une compétence du catalogue.',
      inputSchema: { skillId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ skillId }) => run(() => api.delete(`skills/${skillId}`)),
  );
  register(
    'vaks_remove_user_skill',
    {
      title: 'Retirer une compétence d\'un utilisateur',
      description: 'Retire une compétence du profil d\'un utilisateur. (Pour l\'ajouter/ajuster : `vaks_set_user_skill`.)',
      inputSchema: { userId: z.string().uuid(), skillId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ userId, skillId }) => run(() => api.delete(`users/${userId}/skills/${skillId}`)),
  );
  register(
    'vaks_set_project_skills',
    {
      title: 'Définir les compétences requises d\'un projet',
      description: 'Remplace l\'ensemble des compétences requises d\'un projet par la liste fournie.',
      inputSchema: {
        projectId: z.string().uuid(),
        skillIds: z.array(z.string().uuid()).describe('Liste complète des compétences requises (remplace l\'existant).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectId, skillIds }) => run(() => api.put(`projects/${projectId}/skills`, { skillIds })),
  );
  register(
    'vaks_set_team_skills',
    {
      title: 'Définir les compétences couvertes par une équipe',
      description: 'Remplace l\'ensemble des compétences couvertes par une équipe par la liste fournie.',
      inputSchema: {
        teamId: z.string().uuid(),
        skillIds: z.array(z.string().uuid()).describe('Liste complète (remplace l\'existant).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ teamId, skillIds }) => run(() => api.put(`teams/${teamId}/skills`, { skillIds })),
  );
  register(
    'vaks_set_task_required_skills',
    {
      title: 'Définir les compétences requises d\'une tâche',
      description: 'Remplace les compétences requises d\'une tâche (avec niveau optionnel par compétence).',
      inputSchema: {
        taskId: z.string().uuid(),
        items: z
          .array(z.object({ skillId: z.string().uuid(), level: z.number().int().min(1).max(5).optional() }))
          .describe('Liste complète (remplace l\'existant).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId, items }) => run(() => api.put(`tasks/${taskId}/required-skills`, { items })),
  );
  register(
    'vaks_apply_skill_pack',
    {
      title: 'Appliquer un pack de compétences',
      description:
        'Installe / met à jour un pack de compétences au catalogue (crée les manquantes). Lister les packs via `vaks_read` sur `skills/packs`.',
      inputSchema: {
        packId: z.string().describe('Identifiant du pack (ex. aws, backend, methodology…).'),
        force: z.boolean().optional().describe('Re-synchroniser même les compétences précédemment supprimées.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ packId, force }) =>
      run(() => api.post(`skills/packs/${packId}/apply${force ? '?force=1' : ''}`, {})),
  );
}
