import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { ApiClient } from './api-client.js';
import { personCompleter, projectCompleter } from './completions.js';
import { answerInLanguage, t, type Lang } from './i18n.js';

/**
 * Prompts MCP = workflows pré-construits, exposés au client IA comme des
 * « slash-commands » invocables en un clic. Un prompt n'est rien d'autre qu'un
 * **message pré-rédigé injecté dans la conversation**, arguments interpolés :
 * aucune exécution côté serveur. Tout le levier est donc dans ce texte.
 *
 * Quatre propriétés à préserver :
 *
 *  - **Arguments complétés** : `project` / `person` sont enveloppés dans
 *    `completable()` → un client qui implémente `completion/complete` propose
 *    les vrais projets et personnes du tenant (cf. `completions.ts`).
 *  - **Sélection en conversation** : ces mêmes arguments sont **optionnels**.
 *    Laissé vide, le prompt demande à l'IA de lister les projets/personnes et
 *    d'attendre le choix de l'utilisateur. C'est le seul menu portable : le
 *    protocole MCP ne permet pas au serveur d'afficher quoi que ce soit, et les
 *    clients n'implémentent pas tous les complétions (le dialogue de Claude est
 *    un formulaire nu, il n'affiche même pas la description de l'argument).
 *  - **Alignés sur `allowWrite`** : les prompts qui aboutissent à une écriture
 *    ne sont exposés QUE si le jeton porte un scope d'écriture — même règle que
 *    les tools. Sans ça l'utilisateur clique « Staffer un projet » et se prend
 *    un 403 en fin de parcours, après avoir laissé l'IA travailler pour rien.
 *  - **Regroupés par famille** : le protocole MCP n'a AUCUNE notion de groupe
 *    (un prompt n'expose que `name`/`title`/`description`/`arguments`, et
 *    `prompts/list` renvoie une liste plate). Le regroupement est donc une pure
 *    convention : préfixe sur `name` ET sur `title` (certains clients affichent
 *    l'identifiant technique), + enregistrement dans l'ordre des familles
 *    (certains clients préservent l'ordre serveur, d'autres trient).
 *
 * ⚠️ `time:log` est délibérément exclu de `MCP_WRITE_SCOPES` côté API (il sert
 * aussi de scope de lecture) : un jeton `time:log` seul arrive donc ici avec
 * `allowWrite = false`. Ne pas conditionner une lecture à `allowWrite`.
 */
function userMsg(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/**
 * Prompt en **deux messages** : la demande, puis un message `assistant` qui
 * amorce la réponse avec le squelette exact attendu.
 *
 * Un prompt MCP peut renvoyer plusieurs messages avec les rôles `user` et
 * `assistant` — pas seulement un `user`. Mettre le gabarit dans la bouche de
 * l'assistant est nettement plus contraignant que le décrire en prose : le
 * modèle continue une réponse déjà commencée au lieu d'inventer sa mise en
 * forme. On le réserve aux livrables **comparables d'une semaine à l'autre**
 * (rapports, radars) ; les prompts conversationnels restent en un seul message,
 * où un gabarit brimerait le dialogue.
 */
function scriptedMsg(text: string, skeleton: string) {
  return {
    messages: [
      { role: 'user' as const, content: { type: 'text' as const, text } },
      { role: 'assistant' as const, content: { type: 'text' as const, text: skeleton } },
    ],
  };
}

/**
 * Active la capability `completions` + le handler `completion/complete`.
 *
 * ⚠️ Contournement d'une **incohérence du SDK** (1.30) : ses deux chemins de
 * code traitent `ZodOptional` à l'inverse l'un de l'autre.
 *   - `completable(x).optional()` → l'enregistrement déballe le ZodOptional et
 *     active bien la capability, mais `handlePromptCompletion` teste
 *     `isCompletable()` SANS déballer : il ne trouve aucun completer et renvoie
 *     systématiquement une liste vide.
 *   - `completable(x.optional())` → exactement l'inverse : la complétion répond
 *     correctement, mais l'enregistrement automatique ne se déclenche jamais.
 *
 * On retient donc la seconde forme (celle qui RÉPOND) et on déclenche
 * l'enregistrement à la main. La méthode est `private` dans les typings, d'où
 * le cast ; l'appel est **gardé** pour que sa disparition dans une version
 * future dégrade la complétion en silence (elle redevient dormante) au lieu de
 * faire planter le serveur. Idempotent côté SDK.
 */
function enableCompletions(server: McpServer): void {
  const s = server as unknown as { setCompletionRequestHandler?: () => void };
  if (typeof s.setCompletionRequestHandler === 'function') {
    s.setCompletionRequestHandler();
  }
}


export function registerPrompts(
  server: McpServer,
  api: ApiClient,
  allowWrite: boolean,
  lang: Lang = 'en',
): void {
  const tr = t(lang);
  /** Consigne de langue de sortie, ajoutée à CHAQUE corps de prompt. */
  const OUT = ` ${answerInLanguage(lang)}`;
  /** Corps de prompt + consigne de langue — tous les prompts passent par là. */
  const say = (text: string) => userMsg(text + OUT);
  const script = (text: string, skeleton: string) => scriptedMsg(text + OUT, skeleton);
  /**
   * Argument « projet » : complété si le client sait le faire, et **optionnel**
   * pour permettre la sélection en conversation.
   *
   * ⚠️ Le `.describe()` va sur le schéma **interne**, jamais sur le retour de
   * `completable()`. `completable()` ne construit pas une enveloppe : il recopie
   * le `_def` du schéma et y pose son marqueur. Appeler `.describe()` APRÈS
   * reconstruit un `ZodString` nu → le marqueur saute, `isCompletable()` devient
   * faux, et le SDK n'enregistre alors NI la capability `completions` NI le
   * handler `completion/complete` (le client reçoit « Method not found »).
   * Décrire l'intérieur conserve les deux : la description remonte quand même
   * dans `prompts/list`.
   *
   * Le `.optional()` va lui aussi **à l'intérieur**, pour la raison expliquée
   * sur `enableCompletions` : c'est la seule forme où la complétion répond
   * réellement.
   */
  const projectArg = completable(
    z
      .string()
      .describe(tr('arg.project'))
      .optional(),
    projectCompleter(api),
  );

  const personArg = completable(
    z
      .string()
      .describe(tr('arg.person'))
      .optional(),
    personCompleter(api),
  );

  // Doit être appelé indépendamment de `allowWrite` : les prompts de lecture ont
  // droit à leur complétion eux aussi.
  enableCompletions(server);

  // ══════════════════════════ Famille « Pilotage » ══════════════════════════

  server.registerPrompt(
    'pilot_risk_radar',
    {
      title: tr('pilot_risk_radar.title'),
      description: tr('pilot_risk_radar.desc'),
    },
    () =>
      script(tr('pilot_risk_radar.body'), tr('pilot_risk_radar.skel')),
  );

  server.registerPrompt(
    'pilot_pending_reviews',
    {
      title: tr('pilot_pending_reviews.title'),
      description: tr('pilot_pending_reviews.desc'),
    },
    () =>
      say(tr('pilot_pending_reviews.body')),
  );

  // ═══════════════════════════ Famille « Projet » ═══════════════════════════

  server.registerPrompt(
    'project_status_report',
    {
      title: tr('project_status_report.title'),
      description: tr('project_status_report.desc'),
      argsSchema: { project: projectArg },
    },
    ({ project }) =>
      project
        ? script(
            `${tr('project_status_report.lead', { project })} ${tr('project_status_report.body')}`,
            tr('project_status_report.skel'),
          )
        : // Sans projet, on doit d'abord poser la question : amorcer la réponse
          // avec le gabarit ferait sauter l'étape de choix.
          say(
            `${tr('pick.project')} ${tr('project_status_report.leadPick')} ${tr('project_status_report.body')}`,
          ),
  );

  if (allowWrite) {
    server.registerPrompt(
      'project_bootstrap',
      {
        title: tr('project_bootstrap.title'),
        description: tr('project_bootstrap.desc'),
        argsSchema: { brief: z.string().describe(tr('arg.brief')) },
      },
      ({ brief }) =>
        say(tr('project_bootstrap.body', { brief })),
    );

    server.registerPrompt(
      'project_close',
      {
        title: tr('project_close.title'),
        description: tr('project_close.desc'),
        argsSchema: { project: projectArg },
      },
      ({ project }) =>
        say(
          project
            ? `${tr('project_close.lead', { project })} ${tr('project_close.body')}`
            : `${tr('pick.project')} ${tr('project_close.leadPick')} ${tr('project_close.body')}`,
        ),
    );


    server.registerPrompt(
      'project_announce',
      {
        title: tr('project_announce.title'),
        description: tr('project_announce.desc'),
        argsSchema: {
          project: projectArg,
          change: z.string().describe(tr('arg.change')),
        },
      },
      ({ project, change }) =>
        say(
          project
            ? `${tr('project_announce.lead', { project, change })} ${tr('project_announce.body')}`
            : `${tr('project_announce.leadPick', { change })}${tr('pick.project')} ${tr('project_announce.body')}`,
        ),
    );
  }

  // ═══════════════════════════ Famille « Équipe » ════════════════════════════

  server.registerPrompt(
    'team_find_work',
    {
      title: tr('team_find_work.title'),
      description: tr('team_find_work.desc'),
      argsSchema: { person: personArg },
    },
    ({ person }) =>
      say(
        person
          ? `${tr('team_find_work.lead', { person })} ${tr('team_find_work.body')}`
          : `${tr('pick.person')} ${tr('team_find_work.leadPick')} ${tr('team_find_work.body')}`,
      ),
  );

  if (allowWrite) {
    server.registerPrompt(
      'team_staff_project',
      {
        title: tr('team_staff_project.title'),
        description: tr('team_staff_project.desc'),
        argsSchema: { project: projectArg },
      },
      ({ project }) =>
        say(
          project
            ? `${tr('team_staff_project.lead', { project })} ${tr('team_staff_project.body')}`
            : `${tr('pick.project')} ${tr('team_staff_project.leadPick')} ${tr('team_staff_project.body')}`,
        ),
    );


    server.registerPrompt(
      'team_onboard',
      {
        title: tr('team_onboard.title'),
        description: tr('team_onboard.desc'),
        argsSchema: {
          person: personArg,
          team: z.string().describe(tr('arg.team')).optional(),
        },
      },
      ({ person, team }) => {
        // Le fragment « équipe visée » est une phrase complète : il va en FIN
        // de message. Inséré après l'accroche, il coupait la phrase en deux et
        // le corps repartait en minuscule après un point.
        const teamPart = team ? tr('team_onboard.team', { team }) : '';
        return say(
          person
            ? `${tr('team_onboard.lead', { person, team: '' })} ${tr('team_onboard.body')}${teamPart}`
            : `${tr('pick.person')} ${tr('team_onboard.leadPick', { team: '' })} ${tr('team_onboard.body')}${teamPart}`,
        );
      },
    );
  }

  // ═══════════════════════════ Famille « Finance » ═══════════════════════════

  server.registerPrompt(
    'finance_budget_audit',
    {
      title: tr('finance_budget_audit.title'),
      description: tr('finance_budget_audit.desc'),
      argsSchema: { project: projectArg },
    },
    ({ project }) =>
      say(
        project
          ? `${tr('finance_budget_audit.lead', { project })} ${tr('finance_budget_audit.body')}`
          : `${tr('pick.project')} ${tr('finance_budget_audit.leadPick')} ${tr('finance_budget_audit.body')}`,
      ),
  );

  // ════════════════════════════ Famille « Temps » ════════════════════════════

  if (allowWrite) {
    server.registerPrompt(
      'time_timesheet_catchup',
      {
        title: tr('time_timesheet_catchup.title'),
        description: tr('time_timesheet_catchup.desc'),
        argsSchema: {
          week: z
            .string()
            .describe(tr('arg.week'))
            .optional(),
        },
      },
      ({ week }) =>
        say(
          tr('time_timesheet_catchup.body', {
            week: week
              ? tr('time_timesheet_catchup.week', { week })
              : tr('time_timesheet_catchup.weekDefault'),
          }),
        ),
    );
  }
}
