/**
 * Localisation des libellés MCP.
 *
 * **Ligne de partage assumée** : on traduit ce que l'HUMAIN lit, pas ce que le
 * MODÈLE lit.
 *
 *  - Les `title` / `description` des prompts s'affichent dans le menu du client
 *    → traduits dans les 4 langues du produit.
 *  - Les corps de prompts et les descriptions de tools sont des instructions
 *    adressées au modèle → **source unique**. Les traduire quadruplerait la
 *    maintenance d'un texte qu'on retouche souvent, pour aucun bénéfice
 *    visible, et ferait diverger les versions entre elles.
 *
 * Ce que l'utilisateur perçoit dans sa langue, c'est le menu et surtout **la
 * réponse** : cette dernière est pilotée par une consigne explicite de langue de
 * sortie (`answerInLanguage`), pas en traduisant les instructions.
 */

import { P, fmt } from './i18n-prompts.js';

export type Lang = 'en' | 'fr' | 'it' | 'de';

const LANGS: Lang[] = ['en', 'fr', 'it', 'de'];

/** Fallback : anglais. Une locale inconnue ne doit jamais casser l'affichage. */
const DEFAULT_LANG: Lang = 'en';

/**
 * Normalise ce que renvoie l'API (`preferredLanguage`, potentiellement `null`,
 * ou une étiquette régionale type `fr-BE`).
 */
export function pickLang(raw?: string | null): Lang {
  const v = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (LANGS as string[]).includes(v) ? (v as Lang) : DEFAULT_LANG;
}

/** Étiquette IETF à poser dans l'en-tête `Accept-Language` des appels sortants. */
export const ACCEPT_LANGUAGE: Record<Lang, string> = {
  en: 'en',
  fr: 'fr',
  it: 'it',
  de: 'de',
};

/**
 * Consigne de langue de sortie, ajoutée au corps (anglais) de chaque prompt.
 * C'est elle qui fait qu'un utilisateur allemand obtient une réponse allemande
 * sans qu'on ait traduit une seule instruction.
 */
const ANSWER_IN: Record<Lang, string> = {
  en: 'Write your entire answer in English.',
  fr: 'Rédige toute ta réponse en français.',
  it: 'Scrivi tutta la tua risposta in italiano.',
  de: 'Verfasse deine gesamte Antwort auf Deutsch.',
};

export function answerInLanguage(lang: Lang): string {
  return ANSWER_IN[lang];
}

/** Une entrée de dictionnaire : [en, fr, it, de]. */
type Entry = [string, string, string, string];

const D: Record<string, Entry> = {
  // ── Titres (menu du client) ──────────────────────────────────────────────
  'pilot_risk_radar.title': [
    'Portfolio · Risk radar',
    'Pilotage · Radar de risque portefeuille',
    'Portfolio · Radar dei rischi',
    'Steuerung · Risiko-Radar Portfolio',
  ],
  'pilot_pending_reviews.title': [
    'Portfolio · Deliverables awaiting review',
    'Pilotage · Livrables en attente de revue',
    'Portfolio · Deliverable in attesa di revisione',
    'Steuerung · Ergebnisse zur Prüfung',
  ],
  'project_status_report.title': [
    'Project · Status report',
    'Projet · Rapport de statut',
    'Progetto · Rapporto di stato',
    'Projekt · Statusbericht',
  ],
  'project_bootstrap.title': [
    'Project · Start from a brief',
    'Projet · Lancer depuis un brief',
    'Progetto · Avvia da un brief',
    'Projekt · Aus einem Briefing starten',
  ],
  'project_close.title': [
    'Project · Close out',
    'Projet · Clôturer',
    'Progetto · Chiudere',
    'Projekt · Abschließen',
  ],
  'project_announce.title': [
    'Project · Announce a change',
    'Projet · Annoncer un changement',
    'Progetto · Annunciare un cambiamento',
    'Projekt · Änderung ankündigen',
  ],
  'team_find_work.title': [
    'Team · Find work for someone',
    'Équipe · Trouver du travail pour une personne',
    'Team · Trovare lavoro per una persona',
    'Team · Arbeit für eine Person finden',
  ],
  'team_staff_project.title': [
    'Team · Staff a project',
    'Équipe · Staffer un projet',
    'Team · Assegnare risorse a un progetto',
    'Team · Projekt besetzen',
  ],
  'team_onboard.title': [
    'Team · Onboard someone',
    'Équipe · Onboarder une personne',
    'Team · Inserire una persona',
    'Team · Person einarbeiten',
  ],
  'finance_budget_audit.title': [
    'Finance · Budget audit',
    'Finance · Audit de budget',
    'Finanza · Audit del budget',
    'Finanzen · Budget-Audit',
  ],
  'time_timesheet_catchup.title': [
    'Time · Timesheet catch-up',
    'Temps · Rattrapage de timesheet',
    'Tempo · Recupero del timesheet',
    'Zeit · Zeiterfassung nachtragen',
  ],

  // ── Descriptions (sous-titre dans le menu) ───────────────────────────────
  'pilot_risk_radar.desc': [
    'Reviews every project and produces a prioritised list of risks.',
    'Analyse tous les projets et dresse une liste priorisée des risques.',
    'Analizza tutti i progetti e stila un elenco di rischi in ordine di priorità.',
    'Analysiert alle Projekte und erstellt eine priorisierte Risikoliste.',
  ],
  'pilot_pending_reviews.desc': [
    'Prioritises what is waiting for my review and prepares it.',
    'Priorise ce qui attend ma revue et prépare le passage en revue.',
    'Dà priorità a ciò che attende la mia revisione e la prepara.',
    'Priorisiert, was auf meine Prüfung wartet, und bereitet sie vor.',
  ],
  'project_status_report.desc': [
    'Writes a shareable progress update for a project.',
    "Rédige un point d'avancement prêt à partager pour un projet.",
    'Redige un aggiornamento di avanzamento pronto da condividere.',
    'Erstellt ein teilbares Fortschritts-Update für ein Projekt.',
  ],
  'project_bootstrap.desc': [
    'Turns a brief into a project: tasks, dependencies, staffing (with validation).',
    'Transforme un brief en projet : tâches, dépendances, staffing (avec validation).',
    'Trasforma un brief in progetto: attività, dipendenze, risorse (con validazione).',
    'Wandelt ein Briefing in ein Projekt: Aufgaben, Abhängigkeiten, Besetzung (mit Freigabe).',
  ],
  'project_close.desc': [
    'Close-out checklist (tasks, deliverables, skills) then mark as completed.',
    'Checklist de clôture (tâches, livrables, compétences) puis passage en terminé.',
    'Checklist di chiusura (attività, deliverable, competenze) poi stato completato.',
    'Abschluss-Checkliste (Aufgaben, Ergebnisse, Fähigkeiten), dann auf erledigt setzen.',
  ],
  'project_announce.desc': [
    'Drafts and sends a project announcement (PM / sponsors / members / watchers).',
    'Rédige et envoie une annonce projet (PM / sponsors / membres / watchers).',
    'Redige e invia un annuncio di progetto (PM / sponsor / membri / follower).',
    'Verfasst und sendet eine Projektankündigung (PM / Sponsoren / Mitglieder / Beobachter).',
  ],
  'team_find_work.desc': [
    "Projects and tasks matching someone's skills and real availability.",
    "Projets/tâches adaptés aux compétences et à la disponibilité d'une personne.",
    'Progetti e attività adatti alle competenze e alla disponibilità reale.',
    'Projekte und Aufgaben passend zu Fähigkeiten und tatsächlicher Verfügbarkeit.',
  ],
  'team_staff_project.desc': [
    'Proposes an optimal assignment (skills + real availability).',
    'Propose une affectation optimale (compétences + disponibilité réelle).',
    'Propone un’assegnazione ottimale (competenze + disponibilità reale).',
    'Schlägt eine optimale Besetzung vor (Fähigkeiten + echte Verfügbarkeit).',
  ],
  'team_onboard.desc': [
    'Team assignment, declared skills and a first mission.',
    'Rattachement à une équipe, compétences déclarées et première mission.',
    'Assegnazione a un team, competenze dichiarate e prima missione.',
    'Team-Zuordnung, erfasste Fähigkeiten und erste Aufgabe.',
  ],
  'finance_budget_audit.desc': [
    'Budget, spend, forecast and variance — with corrective levers.',
    'Budget, consommé, prévisionnel et écarts — avec leviers de correction.',
    'Budget, speso, previsione e scostamenti — con leve correttive.',
    'Budget, Verbrauch, Prognose und Abweichungen — mit Korrekturhebeln.',
  ],
  'time_timesheet_catchup.desc': [
    'Spots the gaps in my week and proposes the missing time entries.',
    'Repère les jours creux de la semaine et propose les imputations manquantes.',
    'Individua i giorni scoperti della settimana e propone le imputazioni mancanti.',
    'Findet Lücken in meiner Woche und schlägt fehlende Buchungen vor.',
  ],

  // ── Argument des prompts (affiché par les clients qui le rendent) ────────
  'arg.project': [
    'Project name, key or id. Leave empty to pick from a list.',
    'Nom, clé ou id du projet. Laisser vide pour choisir dans la liste.',
    'Nome, chiave o id del progetto. Lasciare vuoto per scegliere da un elenco.',
    'Projektname, -schlüssel oder -id. Leer lassen, um aus einer Liste zu wählen.',
  ],
  'arg.person': [
    'Person name or id. Leave empty to pick from a list.',
    'Nom ou id de la personne. Laisser vide pour choisir dans la liste.',
    'Nome o id della persona. Lasciare vuoto per scegliere da un elenco.',
    'Name oder id der Person. Leer lassen, um aus einer Liste zu wählen.',
  ],
  'arg.brief': [
    'The project brief / objective, free text.',
    'Le brief / objectif du projet, en texte libre.',
    'Il brief / obiettivo del progetto, testo libero.',
    'Das Briefing / Ziel des Projekts, Freitext.',
  ],
  'arg.change': [
    'The change to announce, free text.',
    'Le changement à annoncer, en texte libre.',
    'Il cambiamento da annunciare, testo libero.',
    'Die anzukündigende Änderung, Freitext.',
  ],
  'arg.team': [
    'Target team (optional — proposed otherwise).',
    'Équipe visée (optionnel — sinon proposée).',
    'Team di destinazione (facoltativo — altrimenti proposto).',
    'Ziel-Team (optional — sonst vorgeschlagen).',
  ],
  'arg.week': [
    'Target week (e.g. "2026-07-20"). Defaults to the current week.',
    'Semaine visée (ex. « 2026-07-20 »). Défaut : la semaine en cours.',
    'Settimana di riferimento (es. « 2026-07-20 »). Predefinita: settimana corrente.',
    'Zielwoche (z. B. „2026-07-20"). Standard: laufende Woche.',
  ],
};

/**
 * Traducteur lié à une langue.
 *
 * Cherche dans les libellés courts (`D`, ici) puis dans les corps de prompts
 * (`P`, dans `i18n-prompts.ts` — séparé parce que ce sont des textes longs).
 * Clé inconnue → la clé elle-même : un oubli se voit à l'écran plutôt que de
 * produire une chaîne vide silencieuse.
 *
 * `vars` alimente les jetons `{project}`, `{person}`, `{brief}`… du texte.
 */
export function t(lang: Lang): (key: string, vars?: Record<string, string | undefined>) => string {
  const idx = LANGS.indexOf(lang);
  return (key, vars) => {
    const entry = D[key] ?? P[key];
    const raw = entry?.[idx] ?? entry?.[0] ?? key;
    return vars ? fmt(raw, vars) : raw;
  };
}
