/**
 * Prédicats PURS du moteur d'automatisations (aucune I/O, aucune dépendance
 * Nest) — c'est la surface testée en vitest. Les requêtes Prisma vivent dans
 * `automations-evaluator.service.ts` ; ici on ne fait que décider.
 *
 * Chaque règle a un `AutomationKind` stable : il sert de clé de cooldown
 * Redis (`vaks:auto:<kind>:<org>:<entityId>`), de discriminant dans le
 * payload webhook `automation.alert`, et de clé i18n (emails + carte Teams).
 */

export type AutomationKind =
  // Hygiène des tâches (lot 1)
  | 'on_hold_dormant'
  | 'overdue'
  | 'in_progress_inactive'
  | 'unassigned_stale'
  | 'external_blocked_stale'
  // Échéances & planning (lot 2)
  | 'due_soon'
  | 'milestone_at_risk'
  // Workload (lot 2)
  | 'overload'
  | 'underload'
  | 'low_utilization'
  // Timesheet (lot 2, hebdo)
  | 'timesheet_incomplete'
  | 'overtime_high'
  // Finance (lot 2)
  | 'budget_threshold'
  | 'forecast_overrun'
  // Projets (lot 2)
  | 'project_inactive'
  | 'project_end_soon'
  // Skills (lot 3, événementiel)
  | 'skill_gap'
  // Hiérarchie (lot 5, événementiel)
  | 'parent_ready'
  // Récurrence (lot 5)
  | 'recurrence'
  | 'recurrence_orphaned'
  // Agents IA (lot 3). NB : pas de règle « re-travail agent » — le **poison
  // task** (`TasksService.maybeEscalatePoisonTask`, seuil
  // `agents.verification.poisonRetryThreshold`) couvre déjà le sujet, et mieux :
  // il retire l'agent de la tâche au lieu de se contenter d'alerter.
  | 'agent_budget'
  | 'deliverable_stale'
  // Anti-triche coût agent (batch 1, 2026-07-26, événementiel) — un run déclaré
  // paraît sous-déclaré (livrable sans tokens, coût nul malgré un tarif, ou coût
  // implausiblement sous le coût de référence recalculé serveur). Alerte l'owner
  // de l'agent. Gaté par le kill switch automations seulement.
  | 'agent_run_anomaly'
  // Agent bloqué (lot B) — l'agent a demandé de l'aide sur la tâche qu'il tient
  // (`vaks_request_assistance`). Un commentaire ne prévient personne en soi :
  // cette alerte vise le PM du projet, l'owner de l'agent et les co-assignés.
  | 'agent_blocked'
  // File de revue du projet saturée (AGENT_NUDGE_CAPACITY.md §6) — des réveils
  // d'agents sont SUPPRIMÉS faute de place en revue. Keyé sur le **projet** et
  // pas sur l'agent : deux agents bloqués par la même file, c'est un seul
  // problème (relire, ou relever `agents.backpressure.maxPendingReviews`) et une
  // seule alerte, adressée aux PM. La saturation par simple concurrence, elle,
  // n'alerte jamais — elle se résout d'elle-même à la tâche suivante.
  | 'review_queue_full'
  // Planning (lot 3, événementiel)
  | 'timeoff_conflict'
  | 'autoplan_overflow'
  // Absorber l'imprévu (Lot 4.3, AUTOPLAN_IMPROVEMENTS.md §4.3, quotidien) —
  // signal fondé sur le STATUT (fiable sans aucune saisie), jamais le
  // pointage : « aucun temps loggé » serait mort à la livraison (le cas
  // nominal sans saisie quotidienne). Une tâche ALLOUÉE dont la fenêtre est
  // passée et qui n'a JAMAIS quitté TODO signale un détournement ou un oubli.
  | 'allocation_window_missed'
  // Sous-statuts (Custom Status, événementiel) — notification configurée SUR le
  // sous-statut (notifyUserIds/notifyTeamIds), déclenchée à l'ENTRÉE d'une
  // tâche dans le sous-statut. Feature par sous-statut, pas une règle du moteur
  // (pas gatée par le kill switch automations — le chokepoint emit garde
  // cooldown / quiet hours / kill switch email).
  | 'sub_status_entered'
  // Feed sponsor (2026-07-18, événementiel + miroir règle 14) — audience =
  // membres `isSponsor` du projet, gaté par `Project.sponsorNotify`.
  | 'milestone_reached'
  | 'project_status_changed'
  | 'sponsor_budget';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * TTL (secondes) du cooldown Redis par règle = période de ré-alerte tant que
 * la condition persiste. Hygiène : re-nudge hebdo.
 */
export const COOLDOWN_TTL_S: Record<AutomationKind, number> = {
  on_hold_dormant: 7 * 24 * 3600,
  overdue: 7 * 24 * 3600,
  in_progress_inactive: 7 * 24 * 3600,
  unassigned_stale: 7 * 24 * 3600,
  external_blocked_stale: 7 * 24 * 3600,
  // Le rappel d'échéance est déjà dédupliqué par le cron notifications (une
  // fois par tâche) — TTL court, il ne sert que de garde anti-doublon webhook.
  due_soon: 24 * 3600,
  milestone_at_risk: 7 * 24 * 3600,
  overload: 7 * 24 * 3600,
  underload: 7 * 24 * 3600,
  low_utilization: 8 * 24 * 3600,
  // Hebdo : la clé est qualifiée par la semaine ISO → TTL 8 j (couvre la
  // semaine sans jamais bloquer la suivante).
  timesheet_incomplete: 8 * 24 * 3600,
  overtime_high: 8 * 24 * 3600,
  // Paliers : la clé est qualifiée par le palier franchi → une alerte par
  // palier et par mois (un budget qui oscille autour de 80 % n'en émet qu'une).
  budget_threshold: 30 * 24 * 3600,
  forecast_overrun: 7 * 24 * 3600,
  project_inactive: 7 * 24 * 3600,
  project_end_soon: 7 * 24 * 3600,
  // Événementiel : une alerte par tâche, une seule fois (la condition ne se
  // répète pas d'elle-même — c'est la création/transition qui la produit).
  skill_gap: 7 * 24 * 3600,
  // Le parent ne devient « prêt » qu'une fois : TTL long, la condition ne se
  // reproduit pas (rouvrir une sous-tâche puis la refermer est un cas rare).
  parent_ready: 7 * 24 * 3600,
  // `recurrence` ne passe jamais par `emit` (c'est une mutation tracée, pas une
  // alerte) — l'entrée existe pour la complétude du type.
  recurrence: 3600,
  recurrence_orphaned: 30 * 24 * 3600,
  // Paliers de budget agent : clé qualifiée par périmètre+palier.
  agent_budget: 24 * 3600,
  deliverable_stale: 24 * 3600,
  // Anti-triche : clé qualifiée par motif+jour → une alerte par agent×jour×motif.
  agent_run_anomaly: 24 * 3600,
  // Un blocage par tâche et par jour : l'agent peut relancer, on ne spamme pas.
  agent_blocked: 24 * 3600,
  // Clé qualifiée par jour : une alerte par projet et par jour tant que la file
  // reste pleine (la condition persiste, mais ce n'est pas une raison de répéter).
  review_queue_full: 24 * 3600,
  timeoff_conflict: 24 * 3600,
  autoplan_overflow: 24 * 3600,
  // Re-nudge hebdo : tant que la tâche n'a pas bougé, ça reste à signaler,
  // mais pas une fois par jour.
  allocation_window_missed: 7 * 24 * 3600,
  // Événementiel : un jalon n'est atteint qu'une fois (re-clôture rapprochée
  // après réouverture = bruit → filtrée par le TTL).
  milestone_reached: 24 * 3600,
  // Clé qualifiée par le statut d'arrivée : deux transitions différentes le
  // même jour passent, une oscillation A→B→A→B est filtrée.
  project_status_changed: 3600,
  // Miroir sponsor de la règle 14 : clé qualifiée par palier, même cadence.
  sponsor_budget: 30 * 24 * 3600,
  // Entrée dans un sous-statut : clé qualifiée par tâche×sous-statut. TTL court
  // — une carte qui fait des allers-retours dans l'heure ne spamme pas, mais
  // une vraie re-entrée le lendemain re-notifie (nouvelle demande).
  sub_status_entered: 3600,
};

/**
 * Nombre max d'alertes émises par org, par règle et par tick — évite de
 * noyer une org qui découvre la feature avec 500 tâches en retard. Les
 * éléments au-delà du cap sont loggés (jamais silencieux) et repêchés aux
 * ticks suivants à mesure que le backlog se résorbe.
 */
export const MAX_ALERTS_PER_RULE_PER_TICK = 50;

/** `date` est-elle vieille d'au moins `days` jours révolus à `now` ? */
export function olderThanDays(date: Date, now: Date, days: number): boolean {
  return now.getTime() - date.getTime() >= days * DAY_MS;
}

/**
 * Tâche en retard : la due date (+ délai de grâce) est dépassée. Le filtre de
 * statut (≠ DONE, non supprimée) est fait dans la requête, pas ici.
 */
export function isOverdue(dueDate: Date, now: Date, graceDays: number): boolean {
  return now.getTime() > dueDate.getTime() + graceDays * DAY_MS;
}

/** Jours entiers de retard (pour le message « en retard de N jours »). */
export function daysLate(dueDate: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS));
}

/**
 * Lot 4.3 (AUTOPLAN_IMPROVEMENTS.md §4.3) — une tâche ALLOUÉE dont la fenêtre
 * (fin de la dernière allocation posée dessus) est révolue depuis au moins
 * `graceDays` jours et qui n'a JAMAIS quitté TODO. Signal fondé sur le
 * STATUT, jamais le pointage (une timesheet vide est le cas nominal sans
 * saisie quotidienne — une règle « aucun temps loggé » serait morte à la
 * livraison). Pure : le caller résout `allocWindowEnd` = MAX(endDate) des
 * allocations de la tâche, et ne fournit `taskStatus` que pour ce garde —
 * la requête SQL a déjà filtré sur `status='TODO'` en amont dans le cas
 * courant, ce paramètre protège les appels qui ne l'auraient pas fait.
 */
export function isAllocationWindowMissed(
  allocWindowEnd: Date,
  now: Date,
  taskStatus: string,
  graceDays: number,
): boolean {
  if (taskStatus !== 'TODO') return false;
  return now.getTime() - allocWindowEnd.getTime() >= graceDays * DAY_MS;
}

/** Jours entiers restants avant `date` (0 si déjà passée). */
export function daysUntil(date: Date, now: Date): number {
  return Math.max(0, Math.floor((date.getTime() - now.getTime()) / DAY_MS));
}

/**
 * Échéance dans la fenêtre d'alerte : à venir (ou aujourd'hui) et à moins de
 * `days` jours. Une date déjà passée n'est PAS « proche » — c'est le domaine
 * de la règle `overdue`, on ne veut pas deux alertes pour le même fait.
 */
export function isDueWithin(date: Date, now: Date, days: number): boolean {
  const delta = date.getTime() - now.getTime();
  return delta >= 0 && delta <= days * DAY_MS;
}

/**
 * Plus haut palier franchi par `pct` parmi `tiers`, ou null si aucun.
 * Les paliers sont supposés triés croissants (garanti par `parseTiers`).
 * On alerte sur LE plus haut atteint : à 105 % avec [80, 100], une seule
 * alerte « 100 % » — le cooldown par palier laisse « 80 » émettre plus tard
 * seulement s'il n'a pas déjà été notifié.
 */
export function highestTierCrossed(pct: number, tiers: number[]): number | null {
  let hit: number | null = null;
  for (const t of tiers) {
    if (pct >= t) hit = t;
  }
  return hit;
}

/** Pourcentage entier borné (évite les 3 chiffres après la virgule dans les messages). */
export function pct(part: number, whole: number): number {
  if (!Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Clé de semaine ISO (`2026-W29`) — qualifie les cooldowns des règles hebdo.
 * Implémentation ISO-8601 standard (semaine du jeudi), en UTC.
 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Jour ISO : lundi = 1 … dimanche = 7.
  const dayNum = t.getUTCDay() || 7;
  // On se cale sur le jeudi de la semaine courante (définit l'année ISO).
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export type Frequency = 'daily' | 'weekly' | 'monthly';

/**
 * Prochaine occurrence **strictement après** `after`, en UTC.
 *
 * - `daily`   : le lendemain, même heure de référence (00:00 UTC).
 * - `weekly`  : le prochain `weekday` (ISO 1=lundi … 7=dimanche).
 * - `monthly` : le prochain `monthDay` — **clampé à 28** par le validateur, de
 *   sorte qu'aucune occurrence ne saute en février (un « 31 » deviendrait
 *   erratique : présent en janvier, absent en avril).
 *
 * Fonction pure, tout en UTC : pas de dérive DST, et le même calcul côté test
 * et côté cron.
 */
export function nextOccurrence(
  freq: Frequency,
  after: Date,
  opts: { weekday?: number | null; monthDay?: number | null } = {},
): Date {
  const base = new Date(
    Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()),
  );
  if (freq === 'daily') {
    return new Date(base.getTime() + DAY_MS);
  }
  if (freq === 'weekly') {
    const target = clampInt(opts.weekday ?? 1, 1, 7);
    const cur = base.getUTCDay() || 7; // ISO : dimanche = 7
    // Toujours au moins 1 jour plus loin : une occurrence « aujourd'hui » vient
    // d'être servie, la suivante est la semaine prochaine.
    const delta = ((target - cur + 7) % 7) || 7;
    return new Date(base.getTime() + delta * DAY_MS);
  }
  // monthly
  const day = clampInt(opts.monthDay ?? 1, 1, 28);
  const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day));
  if (candidate.getTime() > base.getTime()) return candidate;
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, day));
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Bornes [lundi 00:00 UTC, dimanche 23:59:59.999 UTC] de la semaine contenant `d`. */
export function isoWeekRange(d: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - (dayNum - 1));
  const end = new Date(start.getTime() + 7 * DAY_MS - 1);
  return { start, end };
}
