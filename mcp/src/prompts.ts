import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Prompts MCP = workflows pré-construits, exposés au client IA comme des
 * « slash-commands » invocables en un clic. Ils ne font qu'orienter l'IA vers la
 * bonne séquence de tools (lecture) — aucune action directe. Toujours exposés
 * (lecture), indépendamment de `allowWrite`.
 */
function userMsg(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'portfolio_risk_radar',
    {
      title: 'Radar de risque portefeuille',
      description: "Analyse tous les projets et dresse une liste priorisée des risques.",
    },
    () =>
      userMsg(
        "Analyse mon portefeuille de projets et dresse une liste PRIORISÉE des risques. " +
          "Méthode : `vaks_list_projects` (scope all) pour repérer les projets chauds (en retard, " +
          "échéances proches, statut bloqué), puis pour chacun approfondis avec `vaks_get_project_health`, " +
          "`vaks_get_workload` (surcharge) et `vaks_get_skill_gap` (couverture). Pour chaque risque : " +
          "projet, nature (retard / charge / compétence / échéance), gravité, action recommandée.",
      ),
  );

  server.registerPrompt(
    'project_status_report',
    {
      title: 'Rapport de statut projet',
      description: "Rédige un point d'avancement prêt à partager pour un projet.",
      argsSchema: { project: z.string().describe('Nom, clé ou id du projet.') },
    },
    ({ project }) =>
      userMsg(
        `Rédige un rapport de statut clair pour le projet « ${project} ». Récupère son id via ` +
          "`vaks_list_projects`, puis combine `vaks_get_project_health`, `vaks_list_project_tasks`, " +
          "`vaks_get_tasks_in_window` (échéances) et `vaks_get_workload`. Structure : avancement global, " +
          "jalons & échéances, risques & blocages, prochaines étapes. Ton factuel, prêt à partager.",
      ),
  );

  server.registerPrompt(
    'staff_project',
    {
      title: 'Staffer un projet',
      description: "Propose une affectation optimale (compétences + disponibilité réelle).",
      argsSchema: { project: z.string().describe('Nom, clé ou id du projet.') },
    },
    ({ project }) =>
      userMsg(
        `Propose un staffing pour le projet « ${project} ». Étapes : id via \`vaks_list_projects\`, ` +
          "couverture via `vaks_get_skill_gap`, candidats par tâche via `vaks_suggest_assignees`, et un " +
          "aperçu de plan via `vaks_plan_project_preview` (n'applique RIEN). Présente le plan (qui fait " +
          "quoi, charge, fenêtre, alertes) et demande ma validation AVANT d'appliquer via `vaks_plan_project_apply`.",
      ),
  );

  server.registerPrompt(
    'bootstrap_project',
    {
      title: 'Lancer un projet depuis un brief',
      description: "Transforme un brief en projet : tâches, dépendances, staffing (avec validation).",
      argsSchema: { brief: z.string().describe('Le brief / objectif du projet, en texte libre.') },
    },
    ({ brief }) =>
      userMsg(
        `Voici un brief de projet :\n\n${brief}\n\nAide-moi à le lancer dans Vaks-PM, étape par étape, ` +
          "en me montrant chaque proposition AVANT d'écrire :\n" +
          "1. Propose une clé courte (2-3 majuscules) + un nom, puis crée le projet via `vaks_create_project`.\n" +
          "2. Décompose le brief en tâches concrètes (titre, estimé en heures, jalons éventuels) et crée-les " +
          "en lot via `vaks_create_tasks`.\n" +
          "3. Propose les dépendances clés entre tâches via `vaks_create_dependency`.\n" +
          "4. Propose un staffing (compétences + disponibilité réelle) via `vaks_get_skill_gap` / " +
          "`vaks_suggest_assignees` puis un aperçu `vaks_plan_project_preview` — SANS appliquer.\n" +
          "Demande ma validation avant les écritures importantes.",
      ),
  );

  server.registerPrompt(
    'find_work_for_person',
    {
      title: 'Trouver du travail pour une personne',
      description: "Projets/tâches adaptés aux compétences et à la disponibilité d'une personne.",
      argsSchema: { person: z.string().describe('Nom ou id de la personne.') },
    },
    ({ person }) =>
      userMsg(
        `Trouve des projets et tâches adaptés à « ${person} ». Récupère ses compétences via ` +
          "`vaks_get_user_skills` (son id depuis `vaks_list_teams` ou les assignés d'une tâche), sa charge " +
          "via `vaks_get_workload`, puis croise avec `vaks_get_skill_gap` des projets actifs pour proposer " +
          "où elle apporterait le plus de valeur sans être surchargée.",
      ),
  );

  server.registerPrompt(
    'announce_change',
    {
      title: 'Annoncer un changement aux parties prenantes',
      description: "Rédige et envoie une annonce projet (PM / sponsors / membres / watchers) avec validation.",
      argsSchema: {
        project: z.string().describe('Nom, clé ou id du projet.'),
        change: z.string().describe('Le changement à annoncer, en texte libre.'),
      },
    },
    ({ project, change }) =>
      userMsg(
        `Je veux prévenir les parties prenantes du projet « ${project} » de ce changement :\n\n${change}\n\n` +
          "Étapes : retrouve l'id du projet via `vaks_list_projects`, puis rédige une annonce COURTE et " +
          "factuelle — un titre (≤ 200 caractères) et un corps en texte brut : le changement, son impact, " +
          "la prochaine étape. Propose-moi le texte ET l'audience (`pm`, `sponsors`, `members`, `watchers` " +
          "— par défaut pm + sponsors) et attends ma validation AVANT d'envoyer via " +
          "`vaks_notify_stakeholders`. L'email partira avec mon nom en attribution.",
      ),
  );
}
