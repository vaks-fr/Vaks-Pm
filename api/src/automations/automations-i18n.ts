import { Lang } from '../notifications/email-templates';
import { AutomationKind } from './automation-rules';

/**
 * Textes des alertes d'automatisation, par règle × langue (en/fr/it/de).
 * Un SEUL template email générique (`renderAutomationAlert`) consomme ces
 * messages — on n'ajoute pas 22 templates à `email-templates.ts`.
 *
 * `params` : valeurs déjà formatées (titres, jours, dates) injectées dans les
 * phrases. L'échappement HTML est fait ICI (les phrases retournées partent
 * telles quelles dans le HTML du mail).
 */

export interface AutomationMessageParams {
  taskTitle?: string;
  projectName?: string;
  userName?: string;
  /** Nom du sous-statut (kind `sub_status_entered`). */
  subStatusName?: string;
  /** Nom de compétence (règle skill gap). */
  skillName?: string;
  /** Niveau requis sur la compétence. */
  level?: number;
  /** Périmètre d'un budget agent : 'agent' | 'project' | 'task' (déjà localisé). */
  scope?: string;
  days?: number;
  dueDate?: string;
  /** Pourcentage entier (charge, budget, ratio, complétude…). */
  pct?: number;
  /** Palier franchi (règle budget). */
  tier?: number;
  /** Nombre d'éléments concernés (tâches ouvertes, prédécesseurs non finis…). */
  count?: number;
  /** Texte libre cité tel quel dans le message (question d'un agent bloqué). */
  note?: string;
  /** `'yes'`/`'no'` — la tâche a-t-elle été mise en pause (kind `agent_blocked`). */
  paused?: string;
  /** Heures (heures sup, écart de capacité…). */
  hours?: number;
  /** Montants déjà formatés avec la devise de l'org. */
  amount?: string;
  budget?: string;
  /** Statuts avant/après (feed sponsor, règle statut projet) — clés d'enum. */
  from?: string;
  to?: string;
  /** Motif d'anomalie de coût agent : 'no_tokens' | 'zero_cost' | 'below_reference'. */
  reason?: string;
}

/** Libellés localisés des statuts projet (feed sponsor). Fallback = clé brute. */
const PROJECT_STATUS_LABELS: Record<Lang, Record<string, string>> = {
  en: { DRAFT: 'Draft', OFFER_SENT: 'Offer sent', CHARTER_REVIEW: 'Charter review', ACTIVE: 'Active', COMPLETED: 'Completed', ARCHIVED: 'Archived' },
  fr: { DRAFT: 'Brouillon', OFFER_SENT: 'Offre envoyée', CHARTER_REVIEW: 'Charte en revue', ACTIVE: 'Actif', COMPLETED: 'Terminé', ARCHIVED: 'Archivé' },
  it: { DRAFT: 'Bozza', OFFER_SENT: 'Offerta inviata', CHARTER_REVIEW: 'Charter in revisione', ACTIVE: 'Attivo', COMPLETED: 'Completato', ARCHIVED: 'Archiviato' },
  de: { DRAFT: 'Entwurf', OFFER_SENT: 'Angebot gesendet', CHARTER_REVIEW: 'Charter-Prüfung', ACTIVE: 'Aktiv', COMPLETED: 'Abgeschlossen', ARCHIVED: 'Archiviert' },
};

function statusLabel(lang: Lang, key: string | undefined): string {
  if (!key) return '';
  return PROJECT_STATUS_LABELS[lang]?.[key] ?? PROJECT_STATUS_LABELS.en[key] ?? key;
}

export interface AutomationMessage {
  subject: string;
  heading: string;
  /** Corps HTML (échappé) inséré dans le shell brandé. */
  bodyHtml: string;
  /** Version texte brut. */
  text: string;
  ctaLabel: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type MessageBuilder = (p: AutomationMessageParams) => AutomationMessage;

const M: Record<AutomationKind, Record<Lang, MessageBuilder>> = {
  on_hold_dormant: {
    en: (p) => ({
      subject: `[On hold] "${p.taskTitle}" has been paused for ${p.days} days`,
      heading: 'A task has been on hold for a while',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> has been on hold for <strong>${p.days} days</strong>. Resume it, reschedule it, or close it.`,
      text: `"${p.taskTitle}" (${p.projectName}) has been on hold for ${p.days} days.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[En pause] « ${p.taskTitle} » est en pause depuis ${p.days} jours`,
      heading: 'Une tâche est en pause depuis un moment',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> est en pause depuis <strong>${p.days} jours</strong>. Reprenez-la, replanifiez-la ou clôturez-la.`,
      text: `« ${p.taskTitle} » (${p.projectName}) est en pause depuis ${p.days} jours.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[In pausa] "${p.taskTitle}" è in pausa da ${p.days} giorni`,
      heading: "Un'attività è in pausa da tempo",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> è in pausa da <strong>${p.days} giorni</strong>. Riprendila, ripianificala o chiudila.`,
      text: `"${p.taskTitle}" (${p.projectName}) è in pausa da ${p.days} giorni.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Pausiert] „${p.taskTitle}" ist seit ${p.days} Tagen pausiert`,
      heading: 'Eine Aufgabe ist seit längerem pausiert',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> ist seit <strong>${p.days} Tagen</strong> pausiert. Nehmen Sie sie wieder auf, planen Sie sie neu oder schließen Sie sie.`,
      text: `„${p.taskTitle}" (${p.projectName}) ist seit ${p.days} Tagen pausiert.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  overdue: {
    en: (p) => ({
      subject: `[Overdue] "${p.taskTitle}" was due ${p.dueDate}`,
      heading: 'A task is overdue',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> was due <strong>${esc(p.dueDate ?? '')}</strong> and is <strong>${p.days} days late</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) was due ${p.dueDate} — ${p.days} days late.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[En retard] « ${p.taskTitle} » devait finir le ${p.dueDate}`,
      heading: 'Une tâche est en retard',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> devait se terminer le <strong>${esc(p.dueDate ?? '')}</strong> et accuse <strong>${p.days} jours de retard</strong>.`,
      text: `« ${p.taskTitle} » (${p.projectName}) devait finir le ${p.dueDate} — ${p.days} jours de retard.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[In ritardo] "${p.taskTitle}" doveva concludersi il ${p.dueDate}`,
      heading: "Un'attività è in ritardo",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> doveva concludersi il <strong>${esc(p.dueDate ?? '')}</strong> ed è in ritardo di <strong>${p.days} giorni</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) doveva concludersi il ${p.dueDate} — ${p.days} giorni di ritardo.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Überfällig] „${p.taskTitle}" war am ${p.dueDate} fällig`,
      heading: 'Eine Aufgabe ist überfällig',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> war am <strong>${esc(p.dueDate ?? '')}</strong> fällig und ist <strong>${p.days} Tage überfällig</strong>.`,
      text: `„${p.taskTitle}" (${p.projectName}) war am ${p.dueDate} fällig — ${p.days} Tage überfällig.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  in_progress_inactive: {
    en: (p) => ({
      subject: `[Stalled] "${p.taskTitle}" has had no activity for ${p.days} days`,
      heading: 'An in-progress task looks stalled',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> is in progress but has had <strong>no activity for ${p.days} days</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) is in progress with no activity for ${p.days} days.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[Au point mort] « ${p.taskTitle} » sans activité depuis ${p.days} jours`,
      heading: 'Une tâche en cours semble au point mort',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> est en cours mais <strong>sans activité depuis ${p.days} jours</strong>.`,
      text: `« ${p.taskTitle} » (${p.projectName}) est en cours, sans activité depuis ${p.days} jours.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[Ferma] "${p.taskTitle}" senza attività da ${p.days} giorni`,
      heading: "Un'attività in corso sembra ferma",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> è in corso ma <strong>senza attività da ${p.days} giorni</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) è in corso, senza attività da ${p.days} giorni.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Stockt] „${p.taskTitle}" seit ${p.days} Tagen ohne Aktivität`,
      heading: 'Eine laufende Aufgabe scheint zu stocken',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> ist in Bearbeitung, aber <strong>seit ${p.days} Tagen ohne Aktivität</strong>.`,
      text: `„${p.taskTitle}" (${p.projectName}) ist in Bearbeitung, seit ${p.days} Tagen ohne Aktivität.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  unassigned_stale: {
    en: (p) => ({
      subject: `[Unassigned] "${p.taskTitle}" has been waiting ${p.days} days for an assignee`,
      heading: 'A task is waiting for an assignee',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> was created <strong>${p.days} days ago</strong> and still has no assignee.`,
      text: `"${p.taskTitle}" (${p.projectName}) has been unassigned for ${p.days} days.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[Non assignée] « ${p.taskTitle} » attend un assigné depuis ${p.days} jours`,
      heading: 'Une tâche attend un assigné',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> a été créée il y a <strong>${p.days} jours</strong> et n'a toujours pas d'assigné.`,
      text: `« ${p.taskTitle} » (${p.projectName}) est sans assigné depuis ${p.days} jours.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[Non assegnata] "${p.taskTitle}" attende un assegnatario da ${p.days} giorni`,
      heading: "Un'attività attende un assegnatario",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> è stata creata <strong>${p.days} giorni fa</strong> e non ha ancora un assegnatario.`,
      text: `"${p.taskTitle}" (${p.projectName}) è senza assegnatario da ${p.days} giorni.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Nicht zugewiesen] „${p.taskTitle}" wartet seit ${p.days} Tagen auf eine Zuweisung`,
      heading: 'Eine Aufgabe wartet auf eine Zuweisung',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> wurde vor <strong>${p.days} Tagen</strong> erstellt und hat noch keine Zuweisung.`,
      text: `„${p.taskTitle}" (${p.projectName}) ist seit ${p.days} Tagen nicht zugewiesen.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  external_blocked_stale: {
    en: (p) => ({
      subject: `[Blocked] "${p.taskTitle}" has been blocked by an external provider for ${p.days} days`,
      heading: 'A task is stuck on an external provider',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> has been marked <strong>blocked by an external provider for ${p.days} days</strong>. Chase the provider or re-plan around it.`,
      text: `"${p.taskTitle}" (${p.projectName}) has been blocked by an external provider for ${p.days} days.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[Bloquée] « ${p.taskTitle} » est bloquée par un prestataire externe depuis ${p.days} jours`,
      heading: 'Une tâche est bloquée par un prestataire externe',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> est marquée <strong>bloquée par un prestataire externe depuis ${p.days} jours</strong>. Relancez le prestataire ou replanifiez autour.`,
      text: `« ${p.taskTitle} » (${p.projectName}) est bloquée par un prestataire externe depuis ${p.days} jours.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[Bloccata] "${p.taskTitle}" è bloccata da un fornitore esterno da ${p.days} giorni`,
      heading: "Un'attività è bloccata da un fornitore esterno",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> è contrassegnata come <strong>bloccata da un fornitore esterno da ${p.days} giorni</strong>. Sollecita il fornitore o ripianifica.`,
      text: `"${p.taskTitle}" (${p.projectName}) è bloccata da un fornitore esterno da ${p.days} giorni.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Blockiert] „${p.taskTitle}" ist seit ${p.days} Tagen von einem externen Dienstleister blockiert`,
      heading: 'Eine Aufgabe hängt an einem externen Dienstleister',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> ist seit <strong>${p.days} Tagen von einem externen Dienstleister blockiert</strong>. Haken Sie beim Dienstleister nach oder planen Sie neu.`,
      text: `„${p.taskTitle}" (${p.projectName}) ist seit ${p.days} Tagen von einem externen Dienstleister blockiert.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  due_soon: {
    en: (p) => ({
      subject: `[Due soon] "${p.taskTitle}" is due ${p.dueDate}`,
      heading: 'A task is due soon',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> is due <strong>${esc(p.dueDate ?? '')}</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) is due ${p.dueDate}.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[Échéance proche] « ${p.taskTitle} » est due le ${p.dueDate}`,
      heading: 'Une tâche arrive à échéance',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> arrive à échéance le <strong>${esc(p.dueDate ?? '')}</strong>.`,
      text: `« ${p.taskTitle} » (${p.projectName}) arrive à échéance le ${p.dueDate}.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[In scadenza] "${p.taskTitle}" scade il ${p.dueDate}`,
      heading: "Un'attività è in scadenza",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> scade il <strong>${esc(p.dueDate ?? '')}</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) scade il ${p.dueDate}.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Bald fällig] „${p.taskTitle}" ist am ${p.dueDate} fällig`,
      heading: 'Eine Aufgabe wird bald fällig',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> ist am <strong>${esc(p.dueDate ?? '')}</strong> fällig.`,
      text: `„${p.taskTitle}" (${p.projectName}) ist am ${p.dueDate} fällig.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  milestone_at_risk: {
    en: (p) => ({
      subject: `[At risk] Milestone "${p.taskTitle}" is due in ${p.days} days`,
      heading: 'A milestone is at risk',
      bodyHtml: `Milestone <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> is due in <strong>${p.days} days</strong> (${esc(p.dueDate ?? '')}) but still has <strong>${p.count} unfinished predecessor${p.count === 1 ? '' : 's'}</strong>.`,
      text: `Milestone "${p.taskTitle}" (${p.projectName}) is due in ${p.days} days with ${p.count} unfinished predecessor(s).`,
      ctaLabel: 'Open milestone',
    }),
    fr: (p) => ({
      subject: `[À risque] Le jalon « ${p.taskTitle} » tombe dans ${p.days} jours`,
      heading: 'Un jalon est à risque',
      bodyHtml: `Le jalon <strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> tombe dans <strong>${p.days} jours</strong> (${esc(p.dueDate ?? '')}) mais compte encore <strong>${p.count} prérequis non terminé${p.count === 1 ? '' : 's'}</strong>.`,
      text: `Le jalon « ${p.taskTitle} » (${p.projectName}) tombe dans ${p.days} jours avec ${p.count} prérequis non terminé(s).`,
      ctaLabel: 'Ouvrir le jalon',
    }),
    it: (p) => ({
      subject: `[A rischio] La milestone "${p.taskTitle}" scade tra ${p.days} giorni`,
      heading: 'Una milestone è a rischio',
      bodyHtml: `La milestone <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> scade tra <strong>${p.days} giorni</strong> (${esc(p.dueDate ?? '')}) ma ha ancora <strong>${p.count} prerequisit${p.count === 1 ? 'o' : 'i'} non completat${p.count === 1 ? 'o' : 'i'}</strong>.`,
      text: `La milestone "${p.taskTitle}" (${p.projectName}) scade tra ${p.days} giorni con ${p.count} prerequisiti non completati.`,
      ctaLabel: 'Apri la milestone',
    }),
    de: (p) => ({
      subject: `[Gefährdet] Meilenstein „${p.taskTitle}" ist in ${p.days} Tagen fällig`,
      heading: 'Ein Meilenstein ist gefährdet',
      bodyHtml: `Meilenstein <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> ist in <strong>${p.days} Tagen</strong> fällig (${esc(p.dueDate ?? '')}), hat aber noch <strong>${p.count} unerledigte Vorgänger</strong>.`,
      text: `Meilenstein „${p.taskTitle}" (${p.projectName}) ist in ${p.days} Tagen fällig, mit ${p.count} unerledigten Vorgängern.`,
      ctaLabel: 'Meilenstein öffnen',
    }),
  },
  overload: {
    en: (p) => ({
      subject: `[Overloaded] ${p.userName} is at ${p.pct}% capacity next week`,
      heading: 'A team member is overloaded',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> is allocated <strong>${p.hours} h</strong> next week — <strong>${p.pct}%</strong> of available capacity. Rebalance the plan or push work out.`,
      text: `${p.userName} is at ${p.pct}% capacity next week (${p.hours} h allocated).`,
      ctaLabel: 'Open workload',
    }),
    fr: (p) => ({
      subject: `[Surcharge] ${p.userName} est à ${p.pct} % de capacité la semaine prochaine`,
      heading: 'Un membre de l\'équipe est en surcharge',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> a <strong>${p.hours} h</strong> allouées la semaine prochaine, soit <strong>${p.pct} %</strong> de sa capacité disponible. Rééquilibrez le plan ou décalez du travail.`,
      text: `${p.userName} est à ${p.pct} % de capacité la semaine prochaine (${p.hours} h allouées).`,
      ctaLabel: 'Ouvrir le plan de charge',
    }),
    it: (p) => ({
      subject: `[Sovraccarico] ${p.userName} è al ${p.pct}% di capacità la prossima settimana`,
      heading: 'Un membro del team è sovraccarico',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ha <strong>${p.hours} h</strong> allocate la prossima settimana, pari al <strong>${p.pct}%</strong> della capacità disponibile.`,
      text: `${p.userName} è al ${p.pct}% di capacità la prossima settimana (${p.hours} h allocate).`,
      ctaLabel: 'Apri il carico di lavoro',
    }),
    de: (p) => ({
      subject: `[Überlastet] ${p.userName} ist nächste Woche bei ${p.pct} % Auslastung`,
      heading: 'Ein Teammitglied ist überlastet',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> hat nächste Woche <strong>${p.hours} h</strong> verplant — <strong>${p.pct} %</strong> der verfügbaren Kapazität.`,
      text: `${p.userName} ist nächste Woche bei ${p.pct} % Auslastung (${p.hours} h verplant).`,
      ctaLabel: 'Auslastung öffnen',
    }),
  },
  underload: {
    en: (p) => ({
      subject: `[Available] ${p.userName} is only at ${p.pct}% capacity`,
      heading: 'A team member has spare capacity',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> is allocated only <strong>${p.pct}%</strong> of available capacity over the next ${p.days} days (<strong>${p.hours} h</strong> free). Good candidate for upcoming work.`,
      text: `${p.userName} is at ${p.pct}% capacity over the next ${p.days} days (${p.hours} h free).`,
      ctaLabel: 'Open workload',
    }),
    fr: (p) => ({
      subject: `[Disponible] ${p.userName} n'est qu'à ${p.pct} % de capacité`,
      heading: 'Un membre de l\'équipe a de la capacité libre',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> n'est alloué qu'à <strong>${p.pct} %</strong> de sa capacité sur les ${p.days} prochains jours (<strong>${p.hours} h</strong> libres). Bon candidat pour du travail à venir.`,
      text: `${p.userName} est à ${p.pct} % de capacité sur les ${p.days} prochains jours (${p.hours} h libres).`,
      ctaLabel: 'Ouvrir le plan de charge',
    }),
    it: (p) => ({
      subject: `[Disponibile] ${p.userName} è solo al ${p.pct}% di capacità`,
      heading: 'Un membro del team ha capacità libera',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> è allocato solo al <strong>${p.pct}%</strong> della capacità nei prossimi ${p.days} giorni (<strong>${p.hours} h</strong> libere).`,
      text: `${p.userName} è al ${p.pct}% di capacità nei prossimi ${p.days} giorni (${p.hours} h libere).`,
      ctaLabel: 'Apri il carico di lavoro',
    }),
    de: (p) => ({
      subject: `[Verfügbar] ${p.userName} ist nur bei ${p.pct} % Auslastung`,
      heading: 'Ein Teammitglied hat freie Kapazität',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ist in den nächsten ${p.days} Tagen nur zu <strong>${p.pct} %</strong> verplant (<strong>${p.hours} h</strong> frei).`,
      text: `${p.userName} ist in den nächsten ${p.days} Tagen bei ${p.pct} % Auslastung (${p.hours} h frei).`,
      ctaLabel: 'Auslastung öffnen',
    }),
  },
  low_utilization: {
    en: (p) => ({
      subject: `[Utilization] ${p.userName} logged ${p.pct}% billable last week`,
      heading: 'Billable utilization below target',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> logged <strong>${p.pct}%</strong> of their time on billable projects last week (<strong>${p.hours} h</strong> total). Target is ${p.count}%.`,
      text: `${p.userName} logged ${p.pct}% billable last week (${p.hours} h total, target ${p.count}%).`,
      ctaLabel: 'Open reports',
    }),
    fr: (p) => ({
      subject: `[Occupation] ${p.userName} a logué ${p.pct} % de facturable la semaine dernière`,
      heading: 'Taux d\'occupation facturable sous la cible',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> a passé <strong>${p.pct} %</strong> de son temps sur des projets facturables la semaine dernière (<strong>${p.hours} h</strong> au total). La cible est de ${p.count} %.`,
      text: `${p.userName} a logué ${p.pct} % de facturable la semaine dernière (${p.hours} h au total, cible ${p.count} %).`,
      ctaLabel: 'Ouvrir les rapports',
    }),
    it: (p) => ({
      subject: `[Utilizzo] ${p.userName} ha registrato il ${p.pct}% fatturabile la scorsa settimana`,
      heading: 'Utilizzo fatturabile sotto il target',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ha registrato il <strong>${p.pct}%</strong> del tempo su progetti fatturabili la scorsa settimana (<strong>${p.hours} h</strong> in totale). Il target è ${p.count}%.`,
      text: `${p.userName} ha registrato il ${p.pct}% fatturabile la scorsa settimana (${p.hours} h totali, target ${p.count}%).`,
      ctaLabel: 'Apri i report',
    }),
    de: (p) => ({
      subject: `[Auslastung] ${p.userName} hat letzte Woche ${p.pct} % abrechenbar erfasst`,
      heading: 'Abrechenbare Auslastung unter Ziel',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> hat letzte Woche <strong>${p.pct} %</strong> der Zeit auf abrechenbare Projekte gebucht (<strong>${p.hours} h</strong> gesamt). Ziel sind ${p.count} %.`,
      text: `${p.userName} hat letzte Woche ${p.pct} % abrechenbar erfasst (${p.hours} h gesamt, Ziel ${p.count} %).`,
      ctaLabel: 'Berichte öffnen',
    }),
  },
  timesheet_incomplete: {
    en: (p) => ({
      subject: `[Timesheet] Last week is only ${p.pct}% filled`,
      heading: 'Your timesheet looks incomplete',
      bodyHtml: `You logged <strong>${p.hours} h</strong> last week — <strong>${p.pct}%</strong> of your expected capacity. Fill in the gaps while it's fresh.`,
      text: `Your timesheet for last week is ${p.pct}% filled (${p.hours} h logged).`,
      ctaLabel: 'Open timesheet',
    }),
    fr: (p) => ({
      subject: `[Timesheet] La semaine dernière n'est remplie qu'à ${p.pct} %`,
      heading: 'Votre timesheet semble incomplète',
      bodyHtml: `Vous avez logué <strong>${p.hours} h</strong> la semaine dernière, soit <strong>${p.pct} %</strong> de votre capacité attendue. Complétez pendant que c'est frais.`,
      text: `Votre timesheet de la semaine dernière est remplie à ${p.pct} % (${p.hours} h loguées).`,
      ctaLabel: 'Ouvrir la timesheet',
    }),
    it: (p) => ({
      subject: `[Timesheet] La scorsa settimana è compilata solo al ${p.pct}%`,
      heading: 'Il tuo timesheet sembra incompleto',
      bodyHtml: `Hai registrato <strong>${p.hours} h</strong> la scorsa settimana, pari al <strong>${p.pct}%</strong> della capacità attesa. Completa finché è fresco.`,
      text: `Il tuo timesheet della scorsa settimana è compilato al ${p.pct}% (${p.hours} h registrate).`,
      ctaLabel: 'Apri il timesheet',
    }),
    de: (p) => ({
      subject: `[Zeiterfassung] Letzte Woche ist nur zu ${p.pct} % ausgefüllt`,
      heading: 'Ihre Zeiterfassung scheint unvollständig',
      bodyHtml: `Sie haben letzte Woche <strong>${p.hours} h</strong> erfasst — <strong>${p.pct} %</strong> Ihrer erwarteten Kapazität. Ergänzen Sie die Lücken, solange es frisch ist.`,
      text: `Ihre Zeiterfassung der letzten Woche ist zu ${p.pct} % ausgefüllt (${p.hours} h erfasst).`,
      ctaLabel: 'Zeiterfassung öffnen',
    }),
  },
  overtime_high: {
    en: (p) => ({
      subject: `[Overtime] ${p.userName} declared ${p.hours} h of overtime last week`,
      heading: 'High overtime declared',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> declared <strong>${p.hours} h</strong> of overtime last week (threshold: ${p.count} h). Worth a check-in.`,
      text: `${p.userName} declared ${p.hours} h of overtime last week (threshold ${p.count} h).`,
      ctaLabel: 'Open reports',
    }),
    fr: (p) => ({
      subject: `[Heures sup] ${p.userName} a déclaré ${p.hours} h supplémentaires la semaine dernière`,
      heading: 'Volume d\'heures supplémentaires élevé',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> a déclaré <strong>${p.hours} h</strong> supplémentaires la semaine dernière (seuil : ${p.count} h). Un point s'impose peut-être.`,
      text: `${p.userName} a déclaré ${p.hours} h supplémentaires la semaine dernière (seuil ${p.count} h).`,
      ctaLabel: 'Ouvrir les rapports',
    }),
    it: (p) => ({
      subject: `[Straordinari] ${p.userName} ha dichiarato ${p.hours} h di straordinari la scorsa settimana`,
      heading: 'Volume di straordinari elevato',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ha dichiarato <strong>${p.hours} h</strong> di straordinari la scorsa settimana (soglia: ${p.count} h).`,
      text: `${p.userName} ha dichiarato ${p.hours} h di straordinari la scorsa settimana (soglia ${p.count} h).`,
      ctaLabel: 'Apri i report',
    }),
    de: (p) => ({
      subject: `[Überstunden] ${p.userName} hat letzte Woche ${p.hours} h Überstunden angegeben`,
      heading: 'Hohes Überstundenvolumen',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> hat letzte Woche <strong>${p.hours} h</strong> Überstunden angegeben (Schwelle: ${p.count} h).`,
      text: `${p.userName} hat letzte Woche ${p.hours} h Überstunden angegeben (Schwelle ${p.count} h).`,
      ctaLabel: 'Berichte öffnen',
    }),
  },
  budget_threshold: {
    en: (p) => ({
      subject: `[Budget ${p.tier}%] "${p.projectName}" has spent ${p.pct}% of budget`,
      heading: `Project budget crossed ${p.tier}%`,
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> has spent <strong>${esc(p.amount ?? '')}</strong> of a <strong>${esc(p.budget ?? '')}</strong> budget — <strong>${p.pct}%</strong>.`,
      text: `"${p.projectName}" has spent ${p.amount} of ${p.budget} (${p.pct}%).`,
      ctaLabel: 'Open finances',
    }),
    fr: (p) => ({
      subject: `[Budget ${p.tier} %] « ${p.projectName} » a consommé ${p.pct} % du budget`,
      heading: `Budget projet : palier ${p.tier} % franchi`,
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> a consommé <strong>${esc(p.amount ?? '')}</strong> sur un budget de <strong>${esc(p.budget ?? '')}</strong>, soit <strong>${p.pct} %</strong>.`,
      text: `« ${p.projectName} » a consommé ${p.amount} sur ${p.budget} (${p.pct} %).`,
      ctaLabel: 'Ouvrir les finances',
    }),
    it: (p) => ({
      subject: `[Budget ${p.tier}%] "${p.projectName}" ha consumato il ${p.pct}% del budget`,
      heading: `Budget di progetto: soglia ${p.tier}% superata`,
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> ha consumato <strong>${esc(p.amount ?? '')}</strong> su un budget di <strong>${esc(p.budget ?? '')}</strong>, pari al <strong>${p.pct}%</strong>.`,
      text: `"${p.projectName}" ha consumato ${p.amount} su ${p.budget} (${p.pct}%).`,
      ctaLabel: 'Apri le finanze',
    }),
    de: (p) => ({
      subject: `[Budget ${p.tier} %] „${p.projectName}" hat ${p.pct} % des Budgets verbraucht`,
      heading: `Projektbudget: Schwelle ${p.tier} % überschritten`,
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> hat <strong>${esc(p.amount ?? '')}</strong> von einem Budget von <strong>${esc(p.budget ?? '')}</strong> verbraucht — <strong>${p.pct} %</strong>.`,
      text: `„${p.projectName}" hat ${p.amount} von ${p.budget} verbraucht (${p.pct} %).`,
      ctaLabel: 'Finanzen öffnen',
    }),
  },
  forecast_overrun: {
    en: (p) => ({
      subject: `[Forecast] "${p.projectName}" is projected to exceed its budget`,
      heading: 'Forecast exceeds budget',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> is forecast to cost <strong>${esc(p.amount ?? '')}</strong> against a <strong>${esc(p.budget ?? '')}</strong> budget (<strong>${p.pct}%</strong>). The spend to date is still within budget — this is the projection at completion.`,
      text: `"${p.projectName}" forecast ${p.amount} vs budget ${p.budget} (${p.pct}%).`,
      ctaLabel: 'Open finances',
    }),
    fr: (p) => ({
      subject: `[Prévisionnel] « ${p.projectName} » devrait dépasser son budget`,
      heading: 'Le prévisionnel dépasse le budget',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> est projeté à <strong>${esc(p.amount ?? '')}</strong> pour un budget de <strong>${esc(p.budget ?? '')}</strong> (<strong>${p.pct} %</strong>). Le réel dépensé tient encore dans le budget — c'est la projection à terminaison.`,
      text: `« ${p.projectName} » prévisionnel ${p.amount} vs budget ${p.budget} (${p.pct} %).`,
      ctaLabel: 'Ouvrir les finances',
    }),
    it: (p) => ({
      subject: `[Previsione] "${p.projectName}" dovrebbe superare il budget`,
      heading: 'La previsione supera il budget',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> è previsto a <strong>${esc(p.amount ?? '')}</strong> per un budget di <strong>${esc(p.budget ?? '')}</strong> (<strong>${p.pct}%</strong>). La spesa effettiva rientra ancora nel budget — questa è la proiezione a finire.`,
      text: `"${p.projectName}" previsione ${p.amount} vs budget ${p.budget} (${p.pct}%).`,
      ctaLabel: 'Apri le finanze',
    }),
    de: (p) => ({
      subject: `[Prognose] „${p.projectName}" wird das Budget voraussichtlich überschreiten`,
      heading: 'Prognose überschreitet Budget',
      bodyHtml: `Für <strong>${esc(p.projectName ?? '')}</strong> werden <strong>${esc(p.amount ?? '')}</strong> bei einem Budget von <strong>${esc(p.budget ?? '')}</strong> prognostiziert (<strong>${p.pct} %</strong>). Die bisherigen Ausgaben liegen noch im Budget — dies ist die Prognose bis Fertigstellung.`,
      text: `„${p.projectName}" Prognose ${p.amount} vs. Budget ${p.budget} (${p.pct} %).`,
      ctaLabel: 'Finanzen öffnen',
    }),
  },
  project_inactive: {
    en: (p) => ({
      subject: `[Inactive] "${p.projectName}" has had no activity for ${p.days} days`,
      heading: 'An active project looks idle',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> is marked active but has had <strong>no activity for ${p.days} days</strong> — no task update, no logged time, no comment. Close it, put it on hold, or get it moving.`,
      text: `"${p.projectName}" has had no activity for ${p.days} days.`,
      ctaLabel: 'Open project',
    }),
    fr: (p) => ({
      subject: `[Inactif] « ${p.projectName} » sans activité depuis ${p.days} jours`,
      heading: 'Un projet actif semble à l\'arrêt',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> est marqué actif mais n'a <strong>aucune activité depuis ${p.days} jours</strong> — aucune tâche modifiée, aucun temps loggé, aucun commentaire. Clôturez-le, mettez-le en pause, ou relancez-le.`,
      text: `« ${p.projectName} » est sans activité depuis ${p.days} jours.`,
      ctaLabel: 'Ouvrir le projet',
    }),
    it: (p) => ({
      subject: `[Inattivo] "${p.projectName}" senza attività da ${p.days} giorni`,
      heading: 'Un progetto attivo sembra fermo',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> è contrassegnato come attivo ma non ha <strong>alcuna attività da ${p.days} giorni</strong> — nessuna attività modificata, nessun tempo registrato, nessun commento.`,
      text: `"${p.projectName}" è senza attività da ${p.days} giorni.`,
      ctaLabel: 'Apri il progetto',
    }),
    de: (p) => ({
      subject: `[Inaktiv] „${p.projectName}" seit ${p.days} Tagen ohne Aktivität`,
      heading: 'Ein aktives Projekt scheint zu ruhen',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> ist als aktiv markiert, hatte aber <strong>seit ${p.days} Tagen keine Aktivität</strong> — keine Aufgabenänderung, keine erfasste Zeit, kein Kommentar.`,
      text: `„${p.projectName}" hatte seit ${p.days} Tagen keine Aktivität.`,
      ctaLabel: 'Projekt öffnen',
    }),
  },
  project_end_soon: {
    en: (p) => ({
      subject: `[Ending soon] "${p.projectName}" ends in ${p.days} days with ${p.count} open tasks`,
      heading: 'A project is ending with work still open',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> is due to end in <strong>${p.days} days</strong> (${esc(p.dueDate ?? '')}) but still has <strong>${p.count} open task${p.count === 1 ? '' : 's'}</strong>.`,
      text: `"${p.projectName}" ends in ${p.days} days with ${p.count} open task(s).`,
      ctaLabel: 'Open project',
    }),
    fr: (p) => ({
      subject: `[Fin proche] « ${p.projectName} » se termine dans ${p.days} jours avec ${p.count} tâches ouvertes`,
      heading: 'Un projet se termine avec du travail en cours',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> doit se terminer dans <strong>${p.days} jours</strong> (${esc(p.dueDate ?? '')}) mais compte encore <strong>${p.count} tâche${p.count === 1 ? '' : 's'} ouverte${p.count === 1 ? '' : 's'}</strong>.`,
      text: `« ${p.projectName} » se termine dans ${p.days} jours avec ${p.count} tâche(s) ouverte(s).`,
      ctaLabel: 'Ouvrir le projet',
    }),
    it: (p) => ({
      subject: `[In chiusura] "${p.projectName}" termina tra ${p.days} giorni con ${p.count} attività aperte`,
      heading: 'Un progetto si chiude con lavoro ancora aperto',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> deve terminare tra <strong>${p.days} giorni</strong> (${esc(p.dueDate ?? '')}) ma ha ancora <strong>${p.count} attività apert${p.count === 1 ? 'a' : 'e'}</strong>.`,
      text: `"${p.projectName}" termina tra ${p.days} giorni con ${p.count} attività aperte.`,
      ctaLabel: 'Apri il progetto',
    }),
    de: (p) => ({
      subject: `[Endet bald] „${p.projectName}" endet in ${p.days} Tagen mit ${p.count} offenen Aufgaben`,
      heading: 'Ein Projekt endet mit offener Arbeit',
      bodyHtml: `<strong>${esc(p.projectName ?? '')}</strong> soll in <strong>${p.days} Tagen</strong> enden (${esc(p.dueDate ?? '')}), hat aber noch <strong>${p.count} offene Aufgabe${p.count === 1 ? '' : 'n'}</strong>.`,
      text: `„${p.projectName}" endet in ${p.days} Tagen mit ${p.count} offenen Aufgaben.`,
      ctaLabel: 'Projekt öffnen',
    }),
  },
  skill_gap: {
    en: (p) => ({
      subject: `[Skill gap] "${p.taskTitle}" needs ${p.skillName} and nobody on the project has it`,
      heading: 'A task needs a skill nobody on the project has',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> requires <strong>${esc(p.skillName ?? '')}</strong>${p.level ? ` at level ${p.level}` : ''}, but no active project member covers it. Add a team, staff someone, or raise a skill request.`,
      text: `"${p.taskTitle}" (${p.projectName}) requires ${p.skillName}${p.level ? ` level ${p.level}` : ''} — no project member covers it.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[Compétence manquante] « ${p.taskTitle} » requiert ${p.skillName}, personne sur le projet ne l'a`,
      heading: 'Une tâche requiert une compétence absente du projet',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> requiert <strong>${esc(p.skillName ?? '')}</strong>${p.level ? ` au niveau ${p.level}` : ''}, mais aucun membre actif du projet ne la couvre. Ajoutez une équipe, staffez quelqu'un, ou faites une demande de compétence.`,
      text: `« ${p.taskTitle} » (${p.projectName}) requiert ${p.skillName}${p.level ? ` niveau ${p.level}` : ''} — aucun membre du projet ne la couvre.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[Competenza mancante] "${p.taskTitle}" richiede ${p.skillName}, nessuno nel progetto la possiede`,
      heading: "Un'attività richiede una competenza assente dal progetto",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> richiede <strong>${esc(p.skillName ?? '')}</strong>${p.level ? ` al livello ${p.level}` : ''}, ma nessun membro attivo del progetto la copre.`,
      text: `"${p.taskTitle}" (${p.projectName}) richiede ${p.skillName}${p.level ? ` livello ${p.level}` : ''} — nessun membro del progetto la copre.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Fehlende Kompetenz] „${p.taskTitle}" braucht ${p.skillName}, niemand im Projekt hat sie`,
      heading: 'Eine Aufgabe braucht eine im Projekt fehlende Kompetenz',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> erfordert <strong>${esc(p.skillName ?? '')}</strong>${p.level ? ` auf Stufe ${p.level}` : ''}, aber kein aktives Projektmitglied deckt sie ab.`,
      text: `„${p.taskTitle}" (${p.projectName}) erfordert ${p.skillName}${p.level ? ` Stufe ${p.level}` : ''} — kein Projektmitglied deckt sie ab.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  parent_ready: {
    // `scope` = 'advanced' (le moteur a fait basculer le parent) ou 'ready'
    // (mode notify : on signale seulement).
    en: (p) => ({
      subject:
        p.scope === 'advanced'
          ? `[Ready for review] "${p.taskTitle}" moved to review`
          : `[Ready for review] All subtasks of "${p.taskTitle}" are done`,
      heading: 'A parent task is ready for review',
      bodyHtml:
        p.scope === 'advanced'
          ? `Every subtask of <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> is done, so it was moved to <strong>review</strong>.`
          : `Every subtask of <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> is done. The parent is still open — move it on when you're ready.`,
      text: `All subtasks of "${p.taskTitle}" (${p.projectName}) are done.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject:
        p.scope === 'advanced'
          ? `[Prête à revoir] « ${p.taskTitle} » est passée en revue`
          : `[Prête à revoir] Toutes les sous-tâches de « ${p.taskTitle} » sont terminées`,
      heading: 'Une tâche parente est prête à être revue',
      bodyHtml:
        p.scope === 'advanced'
          ? `Toutes les sous-tâches de <strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> sont terminées : elle est passée <strong>en revue</strong>.`
          : `Toutes les sous-tâches de <strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> sont terminées. La tâche parente reste ouverte — faites-la avancer quand vous voulez.`,
      text: `Toutes les sous-tâches de « ${p.taskTitle} » (${p.projectName}) sont terminées.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject:
        p.scope === 'advanced'
          ? `[Pronta per la revisione] "${p.taskTitle}" è passata in revisione`
          : `[Pronta per la revisione] Tutte le sotto-attività di "${p.taskTitle}" sono completate`,
      heading: "Un'attività padre è pronta per la revisione",
      bodyHtml:
        p.scope === 'advanced'
          ? `Tutte le sotto-attività di <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> sono completate: è passata <strong>in revisione</strong>.`
          : `Tutte le sotto-attività di <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> sono completate. L'attività padre resta aperta.`,
      text: `Tutte le sotto-attività di "${p.taskTitle}" (${p.projectName}) sono completate.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject:
        p.scope === 'advanced'
          ? `[Bereit zur Prüfung] „${p.taskTitle}" wurde zur Prüfung verschoben`
          : `[Bereit zur Prüfung] Alle Teilaufgaben von „${p.taskTitle}" sind erledigt`,
      heading: 'Eine übergeordnete Aufgabe ist bereit zur Prüfung',
      bodyHtml:
        p.scope === 'advanced'
          ? `Alle Teilaufgaben von <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> sind erledigt — sie wurde <strong>zur Prüfung</strong> verschoben.`
          : `Alle Teilaufgaben von <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> sind erledigt. Die übergeordnete Aufgabe bleibt offen.`,
      text: `Alle Teilaufgaben von „${p.taskTitle}" (${p.projectName}) sind erledigt.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  // `recurrence` est une mutation tracée à l'audit, jamais un email — l'entrée
  // existe pour satisfaire le type (aucun `emit` ne la porte).
  recurrence: {
    en: () => ({ subject: '', heading: '', bodyHtml: '', text: '', ctaLabel: '' }),
    fr: () => ({ subject: '', heading: '', bodyHtml: '', text: '', ctaLabel: '' }),
    it: () => ({ subject: '', heading: '', bodyHtml: '', text: '', ctaLabel: '' }),
    de: () => ({ subject: '', heading: '', bodyHtml: '', text: '', ctaLabel: '' }),
  },
  recurrence_orphaned: {
    en: (p) => ({
      subject: `[Recurrence stopped] A recurring task in "${p.projectName}" lost its template`,
      heading: 'A recurring task was switched off',
      bodyHtml: `A recurring task in <strong>${esc(p.projectName ?? '')}</strong> pointed at a template task that no longer exists, so the recurrence was <strong>switched off</strong>. Recreate it from a live task if you still need it.`,
      text: `A recurring task in "${p.projectName}" lost its template and was switched off.`,
      ctaLabel: 'Open project',
    }),
    fr: (p) => ({
      subject: `[Récurrence arrêtée] Une tâche récurrente de « ${p.projectName} » a perdu son modèle`,
      heading: 'Une tâche récurrente a été désactivée',
      bodyHtml: `Une tâche récurrente de <strong>${esc(p.projectName ?? '')}</strong> pointait vers une tâche modèle qui n'existe plus : la récurrence a été <strong>désactivée</strong>. Recréez-la depuis une tâche vivante si vous en avez encore besoin.`,
      text: `Une tâche récurrente de « ${p.projectName} » a perdu son modèle et a été désactivée.`,
      ctaLabel: 'Ouvrir le projet',
    }),
    it: (p) => ({
      subject: `[Ricorrenza interrotta] Un'attività ricorrente di "${p.projectName}" ha perso il modello`,
      heading: "Un'attività ricorrente è stata disattivata",
      bodyHtml: `Un'attività ricorrente di <strong>${esc(p.projectName ?? '')}</strong> puntava a un'attività modello che non esiste più: la ricorrenza è stata <strong>disattivata</strong>.`,
      text: `Un'attività ricorrente di "${p.projectName}" ha perso il modello ed è stata disattivata.`,
      ctaLabel: 'Apri il progetto',
    }),
    de: (p) => ({
      subject: `[Wiederholung gestoppt] Eine wiederkehrende Aufgabe in „${p.projectName}" hat ihre Vorlage verloren`,
      heading: 'Eine wiederkehrende Aufgabe wurde deaktiviert',
      bodyHtml: `Eine wiederkehrende Aufgabe in <strong>${esc(p.projectName ?? '')}</strong> verwies auf eine Vorlagenaufgabe, die nicht mehr existiert — die Wiederholung wurde <strong>deaktiviert</strong>.`,
      text: `Eine wiederkehrende Aufgabe in „${p.projectName}" hat ihre Vorlage verloren und wurde deaktiviert.`,
      ctaLabel: 'Projekt öffnen',
    }),
  },
  agent_budget: {
    en: (p) => ({
      subject: `[Agent budget] ${p.scope} budget is at ${p.pct}%`,
      heading: 'AI agent budget is running out',
      bodyHtml: `The ${esc(p.scope ?? '')} agent budget is at <strong>${p.pct}%</strong> — <strong>${esc(p.amount ?? '')}</strong> of <strong>${esc(p.budget ?? '')}</strong>${p.projectName ? ` (${esc(p.projectName)})` : ''}. Agents are blocked at claim once the cap is reached.`,
      text: `${p.scope} agent budget at ${p.pct}% (${p.amount} of ${p.budget}).`,
      ctaLabel: 'Open agents',
    }),
    fr: (p) => ({
      subject: `[Budget agent] Le budget ${p.scope} est à ${p.pct} %`,
      heading: "Le budget d'agent IA s'épuise",
      bodyHtml: `Le budget agent ${esc(p.scope ?? '')} est à <strong>${p.pct} %</strong> — <strong>${esc(p.amount ?? '')}</strong> sur <strong>${esc(p.budget ?? '')}</strong>${p.projectName ? ` (${esc(p.projectName)})` : ''}. Les agents sont bloqués au claim une fois le plafond atteint.`,
      text: `Budget agent ${p.scope} à ${p.pct} % (${p.amount} sur ${p.budget}).`,
      ctaLabel: 'Ouvrir les agents',
    }),
    it: (p) => ({
      subject: `[Budget agente] Il budget ${p.scope} è al ${p.pct}%`,
      heading: "Il budget dell'agente IA si sta esaurendo",
      bodyHtml: `Il budget agente ${esc(p.scope ?? '')} è al <strong>${p.pct}%</strong> — <strong>${esc(p.amount ?? '')}</strong> su <strong>${esc(p.budget ?? '')}</strong>${p.projectName ? ` (${esc(p.projectName)})` : ''}. Gli agenti vengono bloccati al claim una volta raggiunto il tetto.`,
      text: `Budget agente ${p.scope} al ${p.pct}% (${p.amount} su ${p.budget}).`,
      ctaLabel: 'Apri gli agenti',
    }),
    de: (p) => ({
      subject: `[Agent-Budget] Das ${p.scope}-Budget liegt bei ${p.pct} %`,
      heading: 'Das KI-Agent-Budget geht zur Neige',
      bodyHtml: `Das ${esc(p.scope ?? '')}-Agent-Budget liegt bei <strong>${p.pct} %</strong> — <strong>${esc(p.amount ?? '')}</strong> von <strong>${esc(p.budget ?? '')}</strong>${p.projectName ? ` (${esc(p.projectName)})` : ''}. Agenten werden beim Claim blockiert, sobald die Grenze erreicht ist.`,
      text: `${p.scope}-Agent-Budget bei ${p.pct} % (${p.amount} von ${p.budget}).`,
      ctaLabel: 'Agenten öffnen',
    }),
  },
  agent_blocked: {
    en: (p) => ({
      subject: `[AI agent] Blocked on ${p.taskTitle}`,
      heading: 'An AI agent is asking for help',
      bodyHtml:
        `<strong>${esc(p.userName ?? 'An agent')}</strong> is blocked on <strong>${esc(p.taskTitle ?? '')}</strong>` +
        `${p.projectName ? ` (${esc(p.projectName)})` : ''} and asked a question rather than guessing:` +
        `<blockquote>${esc(p.note ?? '')}</blockquote>` +
        `${p.paused === 'yes' ? 'The task is paused until someone answers.' : 'The task is still running.'}`,
      text: `${p.userName} is blocked on ${p.taskTitle}: ${p.note}`,
      ctaLabel: 'Open the task',
    }),
    fr: (p) => ({
      subject: `[Agent IA] Blocage sur ${p.taskTitle}`,
      heading: "Un agent IA demande de l'aide",
      bodyHtml:
        `<strong>${esc(p.userName ?? 'Un agent')}</strong> est bloqué sur <strong>${esc(p.taskTitle ?? '')}</strong>` +
        `${p.projectName ? ` (${esc(p.projectName)})` : ''} et pose une question plutôt que de deviner :` +
        `<blockquote>${esc(p.note ?? '')}</blockquote>` +
        `${p.paused === 'yes' ? "La tâche est en pause en attendant une réponse." : 'La tâche continue de tourner.'}`,
      text: `${p.userName} est bloqué sur ${p.taskTitle} : ${p.note}`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[Agente IA] Blocco su ${p.taskTitle}`,
      heading: "Un agente IA chiede aiuto",
      bodyHtml:
        `<strong>${esc(p.userName ?? 'Un agente')}</strong> è bloccato su <strong>${esc(p.taskTitle ?? '')}</strong>` +
        `${p.projectName ? ` (${esc(p.projectName)})` : ''} e pone una domanda invece di tirare a indovinare:` +
        `<blockquote>${esc(p.note ?? '')}</blockquote>` +
        `${p.paused === 'yes' ? "L'attività è in pausa in attesa di una risposta." : "L'attività prosegue."}`,
      text: `${p.userName} è bloccato su ${p.taskTitle}: ${p.note}`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[KI-Agent] Blockiert bei ${p.taskTitle}`,
      heading: 'Ein KI-Agent bittet um Hilfe',
      bodyHtml:
        `<strong>${esc(p.userName ?? 'Ein Agent')}</strong> ist bei <strong>${esc(p.taskTitle ?? '')}</strong> blockiert` +
        `${p.projectName ? ` (${esc(p.projectName)})` : ''} und stellt eine Frage, statt zu raten:` +
        `<blockquote>${esc(p.note ?? '')}</blockquote>` +
        `${p.paused === 'yes' ? 'Die Aufgabe pausiert, bis jemand antwortet.' : 'Die Aufgabe läuft weiter.'}`,
      text: `${p.userName} ist bei ${p.taskTitle} blockiert: ${p.note}`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  agent_run_anomaly: {
    en: (p) => {
      const why =
        p.reason === 'no_tokens'
          ? 'produced a deliverable but declared no token usage'
          : p.reason === 'zero_cost'
            ? `declared a zero cost even though a rate is configured (reference ${p.budget})`
            : `declared ${p.amount}, well below the server-computed reference of ${p.budget}`;
      return {
        subject: `[Agent cost] ${p.userName} — suspicious cost declaration`,
        heading: 'An AI agent cost declaration looks off',
        bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ${esc(why)}. Billing keeps the declared figure — please review whether the reported usage is accurate.`,
        text: `${p.userName}: ${why}.`,
        ctaLabel: 'Open agents',
      };
    },
    fr: (p) => {
      const why =
        p.reason === 'no_tokens'
          ? 'a produit un livrable sans déclarer de tokens'
          : p.reason === 'zero_cost'
            ? `a déclaré un coût nul alors qu'un tarif est configuré (référence ${p.budget})`
            : `a déclaré ${p.amount}, bien en dessous du coût de référence recalculé ${p.budget}`;
      return {
        subject: `[Coût agent] ${p.userName} — déclaration de coût suspecte`,
        heading: 'Une déclaration de coût d\'agent IA paraît anormale',
        bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ${esc(why)}. La facturation conserve le montant déclaré — vérifiez si la consommation rapportée est exacte.`,
        text: `${p.userName} ${why}.`,
        ctaLabel: 'Ouvrir les agents',
      };
    },
    it: (p) => {
      const why =
        p.reason === 'no_tokens'
          ? 'ha prodotto un deliverable senza dichiarare token'
          : p.reason === 'zero_cost'
            ? `ha dichiarato un costo nullo pur avendo una tariffa configurata (riferimento ${p.budget})`
            : `ha dichiarato ${p.amount}, ben al di sotto del costo di riferimento ${p.budget}`;
      return {
        subject: `[Costo agente] ${p.userName} — dichiarazione di costo sospetta`,
        heading: 'Una dichiarazione di costo di un agente IA sembra anomala',
        bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ${esc(why)}. La fatturazione mantiene l'importo dichiarato — verifica se il consumo riportato è corretto.`,
        text: `${p.userName} ${why}.`,
        ctaLabel: 'Apri gli agenti',
      };
    },
    de: (p) => {
      const why =
        p.reason === 'no_tokens'
          ? 'hat ein Ergebnis erstellt, aber keine Token-Nutzung angegeben'
          : p.reason === 'zero_cost'
            ? `hat trotz konfigurierter Rate Kosten von null angegeben (Referenz ${p.budget})`
            : `hat ${p.amount} angegeben, deutlich unter der server-berechneten Referenz ${p.budget}`;
      return {
        subject: `[Agent-Kosten] ${p.userName} — verdächtige Kostenangabe`,
        heading: 'Eine KI-Agent-Kostenangabe wirkt auffällig',
        bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ${esc(why)}. Die Abrechnung behält den angegebenen Betrag — bitte prüfen Sie, ob die gemeldete Nutzung korrekt ist.`,
        text: `${p.userName} ${why}.`,
        ctaLabel: 'Agenten öffnen',
      };
    },
  },
  deliverable_stale: {
    en: (p) => ({
      subject: `[Review waiting] "${p.taskTitle}" has been awaiting review for ${p.hours} h`,
      heading: 'A deliverable is waiting for review',
      bodyHtml: `The deliverable on <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> has been pending review for <strong>${p.hours} hours</strong>. The work is blocked until someone reviews it.`,
      text: `Deliverable on "${p.taskTitle}" (${p.projectName}) has been pending review for ${p.hours} h.`,
      ctaLabel: 'Review it',
    }),
    fr: (p) => ({
      subject: `[Revue en attente] « ${p.taskTitle} » attend une revue depuis ${p.hours} h`,
      heading: 'Un livrable attend sa revue',
      bodyHtml: `Le livrable de <strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> attend une revue depuis <strong>${p.hours} heures</strong>. Le travail est bloqué tant que personne ne le relit.`,
      text: `Le livrable de « ${p.taskTitle} » (${p.projectName}) attend une revue depuis ${p.hours} h.`,
      ctaLabel: 'Faire la revue',
    }),
    it: (p) => ({
      subject: `[Revisione in attesa] "${p.taskTitle}" attende una revisione da ${p.hours} h`,
      heading: 'Un deliverable attende la revisione',
      bodyHtml: `Il deliverable di <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> attende la revisione da <strong>${p.hours} ore</strong>. Il lavoro è bloccato finché nessuno lo revisiona.`,
      text: `Il deliverable di "${p.taskTitle}" (${p.projectName}) attende la revisione da ${p.hours} h.`,
      ctaLabel: 'Revisiona',
    }),
    de: (p) => ({
      subject: `[Review offen] „${p.taskTitle}" wartet seit ${p.hours} h auf Review`,
      heading: 'Ein Liefergegenstand wartet auf Review',
      bodyHtml: `Der Liefergegenstand zu <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> wartet seit <strong>${p.hours} Stunden</strong> auf Review. Die Arbeit ist blockiert, bis jemand sie prüft.`,
      text: `Liefergegenstand zu „${p.taskTitle}" (${p.projectName}) wartet seit ${p.hours} h auf Review.`,
      ctaLabel: 'Review durchführen',
    }),
  },
  timeoff_conflict: {
    en: (p) => ({
      subject: `[Time off] ${p.userName}'s leave overlaps ${p.count} allocation(s)`,
      heading: 'Approved time off conflicts with the plan',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> is away and the leave overlaps <strong>${p.count} allocation${p.count === 1 ? '' : 's'}</strong> on <strong>${esc(p.projectName ?? '')}</strong>. Rebalance or reschedule the work.`,
      text: `${p.userName}'s time off overlaps ${p.count} allocation(s) on ${p.projectName}.`,
      ctaLabel: 'Open workload',
    }),
    fr: (p) => ({
      subject: `[Congé] L'absence de ${p.userName} chevauche ${p.count} allocation(s)`,
      heading: 'Un congé entre en conflit avec le plan',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> est absent et son congé chevauche <strong>${p.count} allocation${p.count === 1 ? '' : 's'}</strong> sur <strong>${esc(p.projectName ?? '')}</strong>. Rééquilibrez ou replanifiez le travail.`,
      text: `Le congé de ${p.userName} chevauche ${p.count} allocation(s) sur ${p.projectName}.`,
      ctaLabel: 'Ouvrir le plan de charge',
    }),
    it: (p) => ({
      subject: `[Ferie] L'assenza di ${p.userName} si sovrappone a ${p.count} allocazioni`,
      heading: 'Le ferie entrano in conflitto con il piano',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> è assente e le ferie si sovrappongono a <strong>${p.count} allocazion${p.count === 1 ? 'e' : 'i'}</strong> su <strong>${esc(p.projectName ?? '')}</strong>.`,
      text: `Le ferie di ${p.userName} si sovrappongono a ${p.count} allocazioni su ${p.projectName}.`,
      ctaLabel: 'Apri il carico di lavoro',
    }),
    de: (p) => ({
      subject: `[Abwesenheit] Die Abwesenheit von ${p.userName} überschneidet ${p.count} Verplanung(en)`,
      heading: 'Eine Abwesenheit kollidiert mit der Planung',
      bodyHtml: `<strong>${esc(p.userName ?? '')}</strong> ist abwesend und die Abwesenheit überschneidet <strong>${p.count} Verplanung${p.count === 1 ? '' : 'en'}</strong> in <strong>${esc(p.projectName ?? '')}</strong>.`,
      text: `Die Abwesenheit von ${p.userName} überschneidet ${p.count} Verplanung(en) in ${p.projectName}.`,
      ctaLabel: 'Auslastung öffnen',
    }),
  },
  autoplan_overflow: {
    en: (p) => ({
      subject: `[Plan] "${p.projectName}" cannot fit ${p.count} task(s) before their deadline`,
      heading: 'The auto-plan does not fit the deadlines',
      bodyHtml: `The last auto-plan on <strong>${esc(p.projectName ?? '')}</strong> could not place <strong>${p.count} task${p.count === 1 ? '' : 's'}</strong> before ${p.count === 1 ? 'its' : 'their'} due date. Add capacity, extend the dates, or cut scope.`,
      text: `Auto-plan on "${p.projectName}" overflows the deadline for ${p.count} task(s).`,
      ctaLabel: 'Open workload',
    }),
    fr: (p) => ({
      subject: `[Plan] « ${p.projectName} » ne peut pas tenir ${p.count} tâche(s) avant leur échéance`,
      heading: "L'auto-plan ne tient pas dans les échéances",
      bodyHtml: `Le dernier auto-plan sur <strong>${esc(p.projectName ?? '')}</strong> n'a pas pu placer <strong>${p.count} tâche${p.count === 1 ? '' : 's'}</strong> avant son échéance. Ajoutez de la capacité, décalez les dates, ou réduisez le périmètre.`,
      text: `L'auto-plan sur « ${p.projectName} » dépasse l'échéance pour ${p.count} tâche(s).`,
      ctaLabel: 'Ouvrir le plan de charge',
    }),
    it: (p) => ({
      subject: `[Piano] "${p.projectName}" non riesce a contenere ${p.count} attività entro la scadenza`,
      heading: 'Il piano automatico non rientra nelle scadenze',
      bodyHtml: `L'ultimo piano automatico su <strong>${esc(p.projectName ?? '')}</strong> non è riuscito a collocare <strong>${p.count} attività</strong> entro la scadenza. Aggiungi capacità, sposta le date o riduci il perimetro.`,
      text: `Il piano automatico su "${p.projectName}" supera la scadenza per ${p.count} attività.`,
      ctaLabel: 'Apri il carico di lavoro',
    }),
    de: (p) => ({
      subject: `[Plan] „${p.projectName}" kann ${p.count} Aufgabe(n) nicht vor der Frist unterbringen`,
      heading: 'Die Auto-Planung passt nicht in die Fristen',
      bodyHtml: `Die letzte Auto-Planung in <strong>${esc(p.projectName ?? '')}</strong> konnte <strong>${p.count} Aufgabe${p.count === 1 ? '' : 'n'}</strong> nicht vor der Frist platzieren. Kapazität ergänzen, Termine verschieben oder Umfang reduzieren.`,
      text: `Auto-Planung in „${p.projectName}" überschreitet die Frist für ${p.count} Aufgabe(n).`,
      ctaLabel: 'Auslastung öffnen',
    }),
  },
  // ============================================================
  // Absorber l'imprévu (Lot 4.3, AUTOPLAN_IMPROVEMENTS.md §4.3) — signal
  // fondé sur le statut : tâche allouée dont la fenêtre est passée sans
  // jamais avoir quitté TODO.
  // ============================================================
  allocation_window_missed: {
    en: (p) => ({
      subject: `[Not started] "${p.taskTitle}" was allocated but is still To do`,
      heading: 'An allocated task never started',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> had time allocated for it, but the planned window closed <strong>${p.days} day${p.days === 1 ? '' : 's'} ago</strong> and the task is still <strong>To do</strong>. Reschedule it or check what's blocking it.`,
      text: `"${p.taskTitle}" (${p.projectName}) was allocated but its window closed ${p.days} day(s) ago and it is still To do.`,
      ctaLabel: 'Open task',
    }),
    fr: (p) => ({
      subject: `[Non démarrée] « ${p.taskTitle} » était allouée mais reste à faire`,
      heading: 'Une tâche allouée n\'a jamais démarré',
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> dans <strong>${esc(p.projectName ?? '')}</strong> avait du temps alloué, mais la fenêtre prévue s'est refermée il y a <strong>${p.days} jour${p.days === 1 ? '' : 's'}</strong> et la tâche est toujours <strong>à faire</strong>. Replanifiez-la ou vérifiez ce qui bloque.`,
      text: `« ${p.taskTitle} » (${p.projectName}) était allouée mais sa fenêtre s'est refermée il y a ${p.days} jour(s) et elle est toujours à faire.`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[Non iniziata] "${p.taskTitle}" era allocata ma è ancora da fare`,
      heading: "Un'attività allocata non è mai partita",
      bodyHtml: `<strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> aveva tempo allocato, ma la finestra prevista si è chiusa <strong>${p.days} giorn${p.days === 1 ? 'o' : 'i'} fa</strong> e l'attività è ancora <strong>da fare</strong>.`,
      text: `"${p.taskTitle}" (${p.projectName}) era allocata ma la sua finestra si è chiusa ${p.days} giorni fa ed è ancora da fare.`,
      ctaLabel: "Apri l'attività",
    }),
    de: (p) => ({
      subject: `[Nicht gestartet] „${p.taskTitle}" war verplant, ist aber noch zu erledigen`,
      heading: 'Eine verplante Aufgabe wurde nie begonnen',
      bodyHtml: `Für <strong>${esc(p.taskTitle ?? '')}</strong> in <strong>${esc(p.projectName ?? '')}</strong> war Zeit verplant, aber das vorgesehene Zeitfenster endete vor <strong>${p.days} Tag${p.days === 1 ? '' : 'en'}</strong> und die Aufgabe ist weiterhin <strong>zu erledigen</strong>.`,
      text: `„${p.taskTitle}" (${p.projectName}) war verplant, das Zeitfenster endete vor ${p.days} Tag(en) und sie ist weiterhin zu erledigen.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  // ============================================================
  // Feed sponsor (2026-07-18) — communications en altitude, destinées aux
  // membres `isSponsor`. `sponsor_budget` est volontairement QUALITATIF :
  // palier franchi, jamais de montants (le chiffré reste sous finance:view).
  // ============================================================
  sub_status_entered: {
    en: (p) => ({
      subject: `[${p.subStatusName}] "${p.taskTitle}" needs your attention — ${p.projectName}`,
      heading: 'A task entered a status you watch',
      bodyHtml: `The task <strong>${esc(p.taskTitle ?? '')}</strong> on <strong>${esc(p.projectName ?? '')}</strong> just moved to <strong>${esc(p.subStatusName ?? '')}</strong>.`,
      text: `Task "${p.taskTitle}" on ${p.projectName} just moved to "${p.subStatusName}".`,
      ctaLabel: 'Open the task',
    }),
    fr: (p) => ({
      subject: `[${p.subStatusName}] « ${p.taskTitle} » attend votre action — ${p.projectName}`,
      heading: 'Une tâche est entrée dans un statut que vous suivez',
      bodyHtml: `La tâche <strong>${esc(p.taskTitle ?? '')}</strong> du projet <strong>${esc(p.projectName ?? '')}</strong> vient de passer en <strong>${esc(p.subStatusName ?? '')}</strong>.`,
      text: `La tâche « ${p.taskTitle} » du projet ${p.projectName} vient de passer en « ${p.subStatusName} ».`,
      ctaLabel: 'Ouvrir la tâche',
    }),
    it: (p) => ({
      subject: `[${p.subStatusName}] "${p.taskTitle}" richiede la vostra attenzione — ${p.projectName}`,
      heading: 'Un\'attività è entrata in uno stato che seguite',
      bodyHtml: `L'attività <strong>${esc(p.taskTitle ?? '')}</strong> del progetto <strong>${esc(p.projectName ?? '')}</strong> è appena passata a <strong>${esc(p.subStatusName ?? '')}</strong>.`,
      text: `L'attività "${p.taskTitle}" del progetto ${p.projectName} è appena passata a "${p.subStatusName}".`,
      ctaLabel: 'Apri l\'attività',
    }),
    de: (p) => ({
      subject: `[${p.subStatusName}] „${p.taskTitle}" braucht Ihre Aufmerksamkeit — ${p.projectName}`,
      heading: 'Eine Aufgabe ist in einen von Ihnen beobachteten Status gewechselt',
      bodyHtml: `Die Aufgabe <strong>${esc(p.taskTitle ?? '')}</strong> im Projekt <strong>${esc(p.projectName ?? '')}</strong> ist soeben in <strong>${esc(p.subStatusName ?? '')}</strong> gewechselt.`,
      text: `Die Aufgabe „${p.taskTitle}" im Projekt ${p.projectName} ist soeben in „${p.subStatusName}" gewechselt.`,
      ctaLabel: 'Aufgabe öffnen',
    }),
  },
  milestone_reached: {
    en: (p) => ({
      subject: `[Milestone] "${p.taskTitle}" is done — ${p.projectName}`,
      heading: 'A milestone has been reached',
      bodyHtml: `The milestone <strong>${esc(p.taskTitle ?? '')}</strong> on <strong>${esc(p.projectName ?? '')}</strong> has been completed.`,
      text: `Milestone "${p.taskTitle}" on ${p.projectName} has been completed.`,
      ctaLabel: 'Open the milestone',
    }),
    fr: (p) => ({
      subject: `[Jalon] « ${p.taskTitle} » est atteint — ${p.projectName}`,
      heading: 'Un jalon est atteint',
      bodyHtml: `Le jalon <strong>${esc(p.taskTitle ?? '')}</strong> du projet <strong>${esc(p.projectName ?? '')}</strong> est terminé.`,
      text: `Le jalon « ${p.taskTitle} » du projet ${p.projectName} est terminé.`,
      ctaLabel: 'Ouvrir le jalon',
    }),
    it: (p) => ({
      subject: `[Traguardo] "${p.taskTitle}" è raggiunto — ${p.projectName}`,
      heading: 'Un traguardo è stato raggiunto',
      bodyHtml: `Il traguardo <strong>${esc(p.taskTitle ?? '')}</strong> del progetto <strong>${esc(p.projectName ?? '')}</strong> è stato completato.`,
      text: `Il traguardo "${p.taskTitle}" del progetto ${p.projectName} è stato completato.`,
      ctaLabel: 'Apri il traguardo',
    }),
    de: (p) => ({
      subject: `[Meilenstein] „${p.taskTitle}" ist erreicht — ${p.projectName}`,
      heading: 'Ein Meilenstein wurde erreicht',
      bodyHtml: `Der Meilenstein <strong>${esc(p.taskTitle ?? '')}</strong> im Projekt <strong>${esc(p.projectName ?? '')}</strong> wurde abgeschlossen.`,
      text: `Meilenstein „${p.taskTitle}" im Projekt ${p.projectName} wurde abgeschlossen.`,
      ctaLabel: 'Meilenstein öffnen',
    }),
  },
  project_status_changed: {
    en: (p) => ({
      subject: `[Project] "${p.projectName}" is now ${statusLabel('en', p.to)}`,
      heading: 'Project status changed',
      bodyHtml: `The project <strong>${esc(p.projectName ?? '')}</strong> moved from <strong>${esc(statusLabel('en', p.from))}</strong> to <strong>${esc(statusLabel('en', p.to))}</strong>.`,
      text: `Project "${p.projectName}" moved from ${statusLabel('en', p.from)} to ${statusLabel('en', p.to)}.`,
      ctaLabel: 'Open the project',
    }),
    fr: (p) => ({
      subject: `[Projet] « ${p.projectName} » est passé à ${statusLabel('fr', p.to)}`,
      heading: 'Le statut du projet a changé',
      bodyHtml: `Le projet <strong>${esc(p.projectName ?? '')}</strong> est passé de <strong>${esc(statusLabel('fr', p.from))}</strong> à <strong>${esc(statusLabel('fr', p.to))}</strong>.`,
      text: `Le projet « ${p.projectName} » est passé de ${statusLabel('fr', p.from)} à ${statusLabel('fr', p.to)}.`,
      ctaLabel: 'Ouvrir le projet',
    }),
    it: (p) => ({
      subject: `[Progetto] "${p.projectName}" è ora ${statusLabel('it', p.to)}`,
      heading: 'Lo stato del progetto è cambiato',
      bodyHtml: `Il progetto <strong>${esc(p.projectName ?? '')}</strong> è passato da <strong>${esc(statusLabel('it', p.from))}</strong> a <strong>${esc(statusLabel('it', p.to))}</strong>.`,
      text: `Il progetto "${p.projectName}" è passato da ${statusLabel('it', p.from)} a ${statusLabel('it', p.to)}.`,
      ctaLabel: 'Apri il progetto',
    }),
    de: (p) => ({
      subject: `[Projekt] „${p.projectName}" ist jetzt ${statusLabel('de', p.to)}`,
      heading: 'Projektstatus geändert',
      bodyHtml: `Das Projekt <strong>${esc(p.projectName ?? '')}</strong> wechselte von <strong>${esc(statusLabel('de', p.from))}</strong> zu <strong>${esc(statusLabel('de', p.to))}</strong>.`,
      text: `Projekt „${p.projectName}" wechselte von ${statusLabel('de', p.from)} zu ${statusLabel('de', p.to)}.`,
      ctaLabel: 'Projekt öffnen',
    }),
  },
  sponsor_budget: {
    en: (p) => ({
      subject: `[Budget] "${p.projectName}" crossed the ${p.tier}% budget mark`,
      heading: 'Budget milestone crossed',
      bodyHtml: `The project <strong>${esc(p.projectName ?? '')}</strong> has crossed <strong>${p.tier}%</strong> of its budget envelope. Reach out to the project manager for details.`,
      text: `Project "${p.projectName}" has crossed ${p.tier}% of its budget.`,
      ctaLabel: 'Open the project',
    }),
    fr: (p) => ({
      subject: `[Budget] « ${p.projectName} » a franchi le palier de ${p.tier} % du budget`,
      heading: 'Palier budgétaire franchi',
      bodyHtml: `Le projet <strong>${esc(p.projectName ?? '')}</strong> a franchi <strong>${p.tier} %</strong> de son enveloppe budgétaire. Rapprochez-vous du chef de projet pour le détail.`,
      text: `Le projet « ${p.projectName} » a franchi ${p.tier} % de son budget.`,
      ctaLabel: 'Ouvrir le projet',
    }),
    it: (p) => ({
      subject: `[Budget] "${p.projectName}" ha superato la soglia del ${p.tier}% del budget`,
      heading: 'Soglia di budget superata',
      bodyHtml: `Il progetto <strong>${esc(p.projectName ?? '')}</strong> ha superato il <strong>${p.tier}%</strong> del suo budget. Contatta il project manager per i dettagli.`,
      text: `Il progetto "${p.projectName}" ha superato il ${p.tier}% del budget.`,
      ctaLabel: 'Apri il progetto',
    }),
    de: (p) => ({
      subject: `[Budget] „${p.projectName}" hat die ${p.tier}%-Budgetmarke überschritten`,
      heading: 'Budgetschwelle überschritten',
      bodyHtml: `Das Projekt <strong>${esc(p.projectName ?? '')}</strong> hat <strong>${p.tier}%</strong> seines Budgets überschritten. Wenden Sie sich für Details an die Projektleitung.`,
      text: `Projekt „${p.projectName}" hat ${p.tier}% seines Budgets überschritten.`,
      ctaLabel: 'Projekt öffnen',
    }),
  },
};

/** Message rendu pour une règle dans une langue (fallback en). */
export function automationMessage(
  kind: AutomationKind,
  lang: Lang,
  params: AutomationMessageParams,
): AutomationMessage {
  const table = M[kind];
  return (table[lang] ?? table.en)(params);
}
