/**
 * Pure scheduling primitives (CPM/topo helpers) — no Prisma, no Nest,
 * testable en isolation. Utilisé par AutoplanService et potentiellement
 * d'autres modules de planning à venir.
 */

/** Types de dépendance — purement structurel pour découpler de Prisma. */
export type SchedulingDepType = 'FS' | 'SS' | 'FF' | 'SF';

/** Vue minimale d'une tâche pour le calcul de planning. */
export interface SchedulingTask {
  id: string;
  estimateHours: number | null;
  /** Date de début planifiée de la tâche. Si fournie et postérieure à `from`,
   *  elle sert de plancher : aucune allocation n'est posée avant. */
  startDate?: Date | null;
}

/** Vue minimale d'une dépendance pour le calcul de planning. */
export interface SchedulingDependency {
  predecessorId: string;
  successorId: string;
  type: SchedulingDepType;
  lagDays: number;
}

const MS_PER_DAY = 86_400_000;
/** Tolérance pour comparer des heures/jour (split flottant éventuel). */
const HOURS_EPS_LOCAL = 0.01;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- Date helpers (UTC, jour calendaire) -------------------------------

export function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export function dateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 0 = lundi, 6 = dimanche. */
export function weekdayMonFirst(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

// ---- Calendrier de jours ouvrés (Lot 1c.1) ------------------------------

/**
 * Seam minimal pour brancher un calendrier de jours ouvrés (schedule org par
 * défaut × fériés) dans le CPM/placement, sans coupler `scheduling.ts` à
 * Prisma/AdminSettings/Holidays. `undefined` partout où ce paramètre est
 * optionnel = comportement historique (fallback lun-ven ci-dessous).
 */
export interface WorkCalendar {
  isWorkday(d: Date): boolean;
}

/** Fallback lun-ven utilisé quand aucun `WorkCalendar` n'est fourni — c'est
 *  ce fallback qui garantit la rétro-compatibilité stricte des call-sites
 *  existants (tests actuels : aucun ne franchit de week-end). */
function defaultIsWorkday(d: Date): boolean {
  return weekdayMonFirst(d) < 5;
}

/**
 * Avance (`n >= 0`) ou recule (`n < 0`) de `n` jours OUVRÉS depuis `start`
 * (le jour de `start` lui-même n'est jamais compté), en sautant les jours
 * non ouvrés selon `calendar` (fallback lun-ven si absent). `n === 0` renvoie
 * `start` normalisé au début de journée UTC. Pure, déterministe.
 *
 * Sans `calendar`, produit EXACTEMENT le même résultat que `addDays(start,
 * n)` tant qu'aucun jour non ouvré n'est traversé — c'est le cas de tous les
 * tests actuels (ils démarrent un lundi, sur des spans courts), d'où la
 * rétro-compatibilité.
 */
export function addWorkdays(start: Date, n: number, calendar?: WorkCalendar): Date {
  const isWorkday = calendar ? (d: Date) => calendar.isWorkday(d) : defaultIsWorkday;
  let cur = startOfUtcDay(start);
  if (n === 0) return cur;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    cur = addDays(cur, step);
    if (isWorkday(cur)) remaining--;
  }
  return cur;
}

// ---- Durée par défaut --------------------------------------------------

/** Durée d'une tâche en jours-effort, plancher à 1. La base h/jour est celle
 *  de l'organisation (`hoursPerDay`, défaut 8 si non fourni) — cohérent avec le
 *  reste du système qui consomme `orgSettings.hoursPerDay`, et non plus un 8
 *  codé en dur qui dériverait sur une org à 7h/7.5h par jour. */
export function durationDays(
  estimateHours: number | null | undefined,
  hoursPerDay = 8,
): number {
  const hpd = hoursPerDay > 0 ? hoursPerDay : 8;
  return Math.max(1, Math.ceil((estimateHours ?? hpd) / hpd));
}

/**
 * Ordre topologique des tâches d'après les dépendances. Les tâches sans
 * dépendances sortent en premier ; les cycles éventuels sont ignorés (on
 * sort tout de même les tâches non placées dans l'ordre stable d'entrée).
 */
export function computeTopoOrder(
  tasks: SchedulingTask[],
  deps: SchedulingDependency[],
): string[] {
  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const t of tasks) {
    out.set(t.id, []);
    inDeg.set(t.id, 0);
  }
  for (const d of deps) {
    if (!out.has(d.predecessorId) || !out.has(d.successorId)) continue;
    out.get(d.predecessorId)!.push(d.successorId);
    inDeg.set(d.successorId, (inDeg.get(d.successorId) ?? 0) + 1);
  }
  const order: string[] = [];
  const queue: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) queue.push(id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of out.get(id) ?? []) {
      const d = (inDeg.get(s) ?? 0) - 1;
      inDeg.set(s, d);
      if (d === 0) queue.push(s);
    }
  }
  // Cycle fallback : ajoute les tâches restantes (rang min stable).
  if (order.length < tasks.length) {
    const placed = new Set(order);
    for (const t of tasks) if (!placed.has(t.id)) order.push(t.id);
  }
  return order;
}

// ---- CPM ---------------------------------------------------------------

/**
 * Date au plus tôt par tâche, à partir de `from` et des dépendances.
 * Formules exactes par type (Lot 1c.2) :
 *  - FS : start_B ≥ fin_A + lag
 *  - SS : start_B ≥ start_A + lag
 *  - FF : start_B ≥ (fin_A + lag) − durée_B
 *  - SF : start_B ≥ (start_A + lag) − durée_B
 * FF/SF restent une APPROXIMATION « bon à un jour près » (la durée de B est
 * son estimate en jours-effort théoriques, pas sa durée de placement réelle
 * — cf. `placeTasks` pour le raffinement dynamique). Le clamp au plancher
 * (`from`/`startDate` de la tâche) est implicite : on ne relève `result.get
 * (e.to)` que si la candidate est postérieure à la valeur courante, donc une
 * candidate antérieure (soustraction de durée) est naturellement ignorée.
 * Renvoie `Map<taskId, Date>`.
 */
export function computeEarliestStart(
  tasks: SchedulingTask[],
  deps: SchedulingDependency[],
  from: Date,
  hoursPerDay = 8,
  calendar?: WorkCalendar,
): Map<string, Date> {
  const result = new Map<string, Date>();
  // Plancher par tâche : `from`, ou la `startDate` de la tâche si elle est
  // postérieure (on ne planifie pas une tâche avant sa date de début prévue).
  for (const t of tasks) {
    const floor =
      t.startDate && +startOfUtcDay(t.startDate) > +from
        ? startOfUtcDay(t.startDate)
        : from;
    result.set(t.id, floor);
  }

  const out = new Map<string, { to: string; type: SchedulingDepType; lagDays: number }[]>();
  const inDeg = new Map<string, number>();
  for (const t of tasks) {
    out.set(t.id, []);
    inDeg.set(t.id, 0);
  }
  for (const d of deps) {
    if (!out.has(d.predecessorId) || !out.has(d.successorId)) continue;
    out.get(d.predecessorId)!.push({ to: d.successorId, type: d.type, lagDays: d.lagDays });
    inDeg.set(d.successorId, (inDeg.get(d.successorId) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDeg) if (deg === 0) queue.push(id);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  while (queue.length) {
    const id = queue.shift()!;
    const t = taskById.get(id)!;
    const myStart = result.get(id)!;
    const myEnd = addWorkdays(myStart, durationDays(t.estimateHours, hoursPerDay), calendar);
    for (const e of out.get(id) ?? []) {
      let earliest: Date;
      if (e.type === 'FS') {
        earliest = addDays(myEnd, e.lagDays);
      } else if (e.type === 'SS') {
        earliest = addDays(myStart, e.lagDays);
      } else {
        // FF/SF : on contraint la FIN de B, convertie en plancher de START via
        // sa propre durée (approximation — cf. docstring).
        const succTask = taskById.get(e.to);
        const durB = durationDays(succTask?.estimateHours, hoursPerDay);
        const base = e.type === 'FF' ? myEnd : myStart; // FF: fin_A · SF: start_A
        earliest = addWorkdays(addDays(base, e.lagDays), -durB, calendar);
      }
      const cur = result.get(e.to)!;
      if (+earliest > +cur) result.set(e.to, earliest);
      const d = (inDeg.get(e.to) ?? 0) - 1;
      inDeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return result;
}

/** Nombre de descendants transitifs par tâche (succession directe ∪ indirecte). */
export function computeTransitiveDependents(
  tasks: SchedulingTask[],
  deps: SchedulingDependency[],
): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const t of tasks) out.set(t.id, []);
  for (const d of deps) {
    if (!out.has(d.predecessorId) || !out.has(d.successorId)) continue;
    out.get(d.predecessorId)!.push(d.successorId);
  }
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack = new Set<string>()): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return new Set();
    stack.add(id);
    const acc = new Set<string>();
    for (const s of out.get(id) ?? []) {
      acc.add(s);
      for (const x of visit(s, stack)) acc.add(x);
    }
    stack.delete(id);
    memo.set(id, acc);
    return acc;
  };
  const result = new Map<string, number>();
  for (const t of tasks) result.set(t.id, visit(t.id).size);
  return result;
}

// ---- CPM complet (forward + backward + slack) --------------------------

/** Planning calculé d'une tâche : dates au plus tôt / au plus tard + mou. */
export interface TaskSchedule {
  earlyStart: Date;
  earlyFinish: Date;
  lateStart: Date;
  lateFinish: Date;
  /** Mou total en jours calendaires (`lateStart − earlyStart`), borné à 0. */
  totalSlack: number;
  /** Tâche sur le chemin critique (mou nul). */
  critical: boolean;
}

/**
 * CPM complet sur le même modèle de jours que `computeEarliestStart` et que le
 * placement de l'auto-plan (jours calendaires, durée = `ceil(estimate /
 * hoursPerDay)`, FS précis + SS/FF/SF approximés sur le start). Contrairement à
 * l'ancienne heuristique « plus longue chaîne » (dead code retiré), ce calcul fait un
 * **vrai backward-pass** : `lateStart`/`lateFinish` par tâche, d'où un
 * `totalSlack` exact et un flag `critical` fiable (mou nul) — base du
 * resource-leveling (les tâches à fort mou peuvent céder la capacité précoce
 * aux tâches critiques).
 *
 * NB : ce CPM sert à **ordonner/prioriser** dans l'auto-plan, pas à figer des
 * dates de fin ; les deadlines restent gérées par les warnings de placement.
 */
export function computeSchedule(
  tasks: SchedulingTask[],
  deps: SchedulingDependency[],
  from: Date,
  hoursPerDay = 8,
  calendar?: WorkCalendar,
): Map<string, TaskSchedule> {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const dur = (id: string) =>
    durationDays(taskById.get(id)?.estimateHours ?? null, hoursPerDay);

  // ---- Forward pass (réutilise computeEarliestStart) ----
  const earlyStart = computeEarliestStart(tasks, deps, from, hoursPerDay, calendar);
  const earlyFinish = new Map<string, Date>();
  let projectFinish = from;
  for (const t of tasks) {
    const es = earlyStart.get(t.id)!;
    const ef = addWorkdays(es, dur(t.id), calendar);
    earlyFinish.set(t.id, ef);
    if (+ef > +projectFinish) projectFinish = ef;
  }

  // Adjacence sortante (pred → successeurs).
  const outEdges = new Map<
    string,
    { to: string; type: SchedulingDepType; lagDays: number }[]
  >();
  for (const t of tasks) outEdges.set(t.id, []);
  for (const d of deps) {
    if (!outEdges.has(d.predecessorId) || !outEdges.has(d.successorId)) continue;
    outEdges
      .get(d.predecessorId)!
      .push({ to: d.successorId, type: d.type, lagDays: d.lagDays });
  }

  // ---- Backward pass (ordre topo inverse) ----
  const topo = computeTopoOrder(tasks, deps);
  const lateStart = new Map<string, Date>();
  const lateFinish = new Map<string, Date>();
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    if (!taskById.has(id)) continue;
    const d = dur(id);
    let lf: Date | null = null;
    for (const e of outEdges.get(id) ?? []) {
      // Dual exact du forward pass (id = prédécesseur de cette arête) :
      //  - FS : LF_pred ≤ LS_succ − lag
      //  - SS : LF_pred ≤ (LS_succ − lag) + durée_pred (LS_pred ≤ LS_succ − lag)
      //  - FF : LF_pred ≤ LF_succ − lag
      //  - SF : LF_pred ≤ (LF_succ − lag) + durée_pred (LS_pred ≤ LF_succ − lag)
      // FS/SS se réfèrent au LS du successeur, FF/SF à son LF — les deux sont
      // déjà connus ici (topo inverse : le successeur est traité avant son
      // prédécesseur).
      const succLs = lateStart.get(e.to);
      const succLf = lateFinish.get(e.to);
      if (!succLs || !succLf) continue;
      let cand: Date;
      if (e.type === 'FS') {
        cand = addDays(succLs, -e.lagDays);
      } else if (e.type === 'SS') {
        cand = addWorkdays(addDays(succLs, -e.lagDays), d, calendar);
      } else if (e.type === 'FF') {
        cand = addDays(succLf, -e.lagDays);
      } else {
        // SF
        cand = addWorkdays(addDays(succLf, -e.lagDays), d, calendar);
      }
      if (lf === null || +cand < +lf) lf = cand;
    }
    const myLf = lf ?? projectFinish;
    lateFinish.set(id, myLf);
    lateStart.set(id, addWorkdays(myLf, -d, calendar));
  }

  const result = new Map<string, TaskSchedule>();
  for (const t of tasks) {
    const es = earlyStart.get(t.id)!;
    const ef = earlyFinish.get(t.id)!;
    const ls = lateStart.get(t.id) ?? es;
    const lf = lateFinish.get(t.id) ?? ef;
    const totalSlack = Math.max(0, Math.round((+ls - +es) / MS_PER_DAY));
    result.set(t.id, {
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalSlack,
      critical: +ls <= +es,
    });
  }
  return result;
}

// ---- Placement (list scheduling) ----------------------------------------

/** Segment d'allocation proposé par le placement (avant enrichissement UI). */
export interface PlacedSegment {
  userId: string;
  taskId: string;
  projectId: string;
  startDate: string; // ISO date
  endDate: string;
  hoursPerDay: number;
}

/**
 * Avertissement structurel émis par le placement — le libellé (i18n, phrase
 * FR) est reconstruit par l'appelant à partir de `type`/`missingHours`/
 * `plannedEnd`, cette fonction restant pure (pas de string métier ici).
 */
export interface PlacementWarning {
  taskId: string;
  type: 'user_saturated' | 'deadline_overflow' | 'dependency_cycle';
  /** Heures non planifiées sur la fenêtre (`user_saturated`). */
  missingHours?: number;
  /** Fin planifiée effective, quand elle déborde la deadline (`deadline_overflow`). */
  plannedEnd?: string;
}

/** Segment (index-based) produit par `placeOn` — converti en dates par l'appelant. */
export interface PlaceOnSegment {
  startIdx: number;
  endIdx: number;
  hoursPerDay: number;
}

/**
 * Remplit `hours` sur la capacité (h/jour) d'UN user, à partir de `fromOffset`
 * et jusqu'au bout de l'horizon (`capacity.length`) — c'est cette extension
 * jusqu'au bout de l'horizon (pas seulement jusqu'à la deadline) qui incarne
 * la règle « on étire d'abord dans le temps avant de disperser » (Lot 1b.3) :
 * un `remaining > 0` en sortie signifie que MÊME en allant jusqu'au bout de
 * l'horizon de planification, ce seul user ne peut pas absorber ses heures —
 * un rééquilibrage vers un co-assigné est alors légitime, jamais avant.
 *
 * Fonction PURE : `capacity` est MUTÉE en place (consommée au fil du
 * remplissage), comme le fait `placeTasks`.
 */
export function placeOn(
  capacity: Float64Array,
  hours: number,
  fromOffset: number,
): { segments: PlaceOnSegment[]; remaining: number; lastEndIdx: number } {
  const dayCount = capacity.length;
  let remaining = hours;
  let lastEndIdx = -1;
  let segStart = -1;
  let segHours = 0;
  const segments: PlaceOnSegment[] = [];
  const flush = () => {
    if (segStart < 0) return;
    segments.push({ startIdx: segStart, endIdx: lastEndIdx, hoursPerDay: round(segHours) });
    segStart = -1;
    segHours = 0;
  };
  for (let i = Math.max(0, fromOffset); i < dayCount && remaining > HOURS_EPS_LOCAL; i++) {
    const free = capacity[i];
    if (free <= HOURS_EPS_LOCAL) {
      if (segStart >= 0) flush();
      continue;
    }
    const put = Math.min(free, remaining);
    if (segStart >= 0 && Math.abs(put - segHours) > HOURS_EPS_LOCAL) flush();
    if (segStart < 0) {
      segStart = i;
      segHours = put;
    }
    lastEndIdx = i;
    capacity[i] -= put;
    remaining -= put;
  }
  if (segStart >= 0) flush();
  return { segments, remaining, lastEndIdx };
}

/**
 * *Serial schedule generation scheme* (list scheduling) : traite les tâches
 * dans l'ordre du **score décroissant parmi les tâches prêtes** (tous
 * prédécesseurs déjà traités), pas dans un ordre topologique figé — l'ordre
 * topologique reste la contrainte DURE (un prérequis est toujours traité
 * avant son successeur, via `pendingPreds`/`ready`), le score ne départage
 * QUE les tâches effectivement comparables (aucune dépendance entre elles).
 *
 * Itère sur `taskIds` en ENTIER (pas seulement les tâches ayant un node) :
 * une tâche sans assigné/estimate ne consomme aucune capacité mais doit
 * quand même débloquer ses successeurs (sinon des sous-graphes entiers
 * restent hors du `ready` set). Si un cycle laisse des tâches non traitées
 * à la fin de la boucle principale, elles sont placées par score décroissant
 * et chacune émet un warning `dependency_cycle`.
 *
 * Fonction PURE et déterministe : `capacity` est mutée en place (le caller
 * doit fournir des `Float64Array` fraîches à chaque run pour préserver
 * l'idempotence), le tie-break de l'argmax est l'id de tâche (ordre stable
 * indépendant de l'ordre d'itération des Map/Set).
 */
export function placeTasks(input: {
  graph: {
    preds: Map<string, { predId: string; type: SchedulingDepType; lagDays: number }[]>;
    succs: Map<string, string[]>;
  };
  taskIds: string[];
  scoreOf: (taskId: string) => number;
  /** Répartition des heures restantes d'une tâche par assignee humain in-scope. */
  nodes: Map<string, { userId: string; hours: number }[]>;
  projectByTask: Map<string, string>;
  /** Capacité (h/jour) par user, indexée sur `dayCount` jours depuis `from`. MUTÉE en place. */
  capacity: Map<string, Float64Array>;
  earliestStartByTask: Map<string, Date>;
  dueByTask: Map<string, Date>;
  /** Fin estimée à propager pour les tâches SANS node (ex. confiées à un
   *  agent IA) : pose une contrainte FS sur leurs successeurs sans jamais
   *  leur allouer d'heures. */
  estimatedEndByTask?: Map<string, Date>;
  /** Durée (jours-effort) par tâche, utilisée pour convertir une contrainte
   *  FF/SF (posée sur une FIN) en plancher de START — cf. `place()`. Absente
   *  ou tâche manquante ⇒ fallback à 1 jour (comportement dégradé, pas de
   *  crash). Optionnel : sans cette map, FF/SF ne peuvent pas se raffiner
   *  dynamiquement (le plancher CPM statique de `earliestStartByTask` reste
   *  seul en jeu). */
  durationDaysByTask?: Map<string, number>;
  /** Calendrier de jours ouvrés (Lot 1c.1) pour les conversions de durée
   *  FF/SF. `undefined` = fallback lun-ven (cf. `addWorkdays`). */
  calendar?: WorkCalendar;
  dayCount: number;
  from: Date;
}): { proposed: PlacedSegment[]; warnings: PlacementWarning[] } {
  const {
    graph,
    taskIds,
    scoreOf,
    nodes,
    projectByTask,
    capacity,
    earliestStartByTask,
    dueByTask,
    estimatedEndByTask,
    durationDaysByTask,
    calendar,
    dayCount,
    from,
  } = input;

  const proposed: PlacedSegment[] = [];
  const warnings: PlacementWarning[] = [];
  const placedEndByTask = new Map<string, Date>();
  const placedStartByTask = new Map<string, Date>();
  const processed = new Set<string>();
  const taskIdSet = new Set(taskIds);

  const place = (taskId: string): void => {
    processed.add(taskId);

    // Earliest start dynamique : max sur les prédécesseurs de leur
    // contrainte réelle (start/fin déjà placés + lag), borné par
    // earliestStartByTask (plancher CPM statique) et par `from` (clamp
    // implicite via `Math.max(0, …)` sur l'offset ci-dessous — une
    // candidate antérieure au plancher est simplement ignorée puisqu'elle
    // ne peut jamais dépasser `dynStart`, déjà initialisé au plancher CPM).
    // FS/SS s'appuient sur le start/fin réel du prédécesseur ; FF/SF les
    // convertissent via la durée de CETTE tâche (`durationDaysByTask`) —
    // approximation « bon à un jour près » (cf. computeEarliestStart).
    //
    // Convention à concilier : `placedEndByTask` stocke le DERNIER jour
    // travaillé INCLUS (FS l'utilise avec un `+1` pour obtenir le lendemain),
    // alors que le `myEnd` du CPM (computeEarliestStart) est le lendemain de
    // ce dernier jour. FF doit donc partir de `predEnd + 1 jour` (et pas
    // `predEnd`) pour rester cohérent avec la même formule CPM — sinon la fin
    // du successeur est décalée d'un jour en trop tôt. `predStart` (premier
    // jour travaillé) correspond en revanche directement au `myStart` du CPM,
    // aucun décalage nécessaire pour SF.
    let dynStart = earliestStartByTask.get(taskId) ?? from;
    for (const p of graph.preds.get(taskId) ?? []) {
      const predEnd = placedEndByTask.get(p.predId);
      const predStart = placedStartByTask.get(p.predId);
      if (p.type === 'FS') {
        if (!predEnd) continue;
        const start = addDays(predEnd, 1 + p.lagDays);
        if (+start > +dynStart) dynStart = start;
      } else if (p.type === 'SS') {
        if (!predStart) continue;
        const start = addDays(predStart, p.lagDays);
        if (+start > +dynStart) dynStart = start;
      } else if (p.type === 'FF' || p.type === 'SF') {
        const base = p.type === 'FF' ? (predEnd ? addDays(predEnd, 1) : undefined) : predStart;
        if (!base) continue;
        const durB = durationDaysByTask?.get(taskId) ?? 1;
        const start = addWorkdays(addDays(base, p.lagDays), -durB, calendar);
        if (+start > +dynStart) dynStart = start;
      }
    }
    const dynStartOffset = Math.max(0, Math.round((+dynStart - +from) / MS_PER_DAY));

    const taskNodes = nodes.get(taskId) ?? [];
    if (taskNodes.length === 0) {
      // Aucun assignee humain in-scope (agent, sans estimate, sans assigné…) :
      // rien à placer, mais on propage une fin estimée si fournie (agent) pour
      // que la contrainte FS s'applique quand même à un successeur humain.
      const est = estimatedEndByTask?.get(taskId);
      if (est) placedEndByTask.set(taskId, est);
      return;
    }

    let taskMaxEndDate: Date | null = null;
    let taskMinStartDate: Date | null = null;
    const pushSegments = (userId: string, segs: PlaceOnSegment[]): void => {
      for (const seg of segs) {
        proposed.push({
          userId,
          taskId,
          projectId: projectByTask.get(taskId) ?? '',
          startDate: dateIso(addDays(from, seg.startIdx)),
          endDate: dateIso(addDays(from, seg.endIdx)),
          hoursPerDay: seg.hoursPerDay,
        });
        const startDate = addDays(from, seg.startIdx);
        if (!taskMinStartDate || +startDate < +taskMinStartDate) taskMinStartDate = startDate;
        const endDate = addDays(from, seg.endIdx);
        if (!taskMaxEndDate || +endDate > +taskMaxEndDate) taskMaxEndDate = endDate;
      }
    };

    // Placement initial : chaque assignee sur SA PROPRE capacité, étirée
    // jusqu'au bout de l'horizon (`placeOn`) — « on étire d'abord dans le
    // temps » (Lot 1b.3). Un `remaining > 0` en sortie prouve que ce user
    // seul ne peut pas absorber ses heures MÊME en allant jusqu'au bout de
    // l'horizon : le rééquilibrage vers un co-assigné ci-dessous est alors
    // légitime, jamais avant.
    let shortfalls: { userId: string; remaining: number }[] = [];
    for (const { userId, hours } of taskNodes) {
      const cap = capacity.get(userId);
      if (!cap) continue;
      const r = placeOn(cap, hours, dynStartOffset);
      pushSegments(userId, r.segments);
      if (r.remaining > HOURS_EPS_LOCAL) shortfalls.push({ userId, remaining: r.remaining });
    }

    // 1b.3 — Rééquilibrage CONSERVATEUR entre co-assignés : redistribue le
    // reliquat d'un user saturé vers les co-assignés de LA MÊME tâche ayant
    // encore de la capacité, par capacité libre décroissante. Boucle bornée
    // à `taskNodes.length` passes (une par co-assigné potentiel).
    const assigneeIds = taskNodes.map((n) => n.userId);
    let pass = 0;
    while (shortfalls.length && pass < assigneeIds.length) {
      pass++;
      const stillShort: typeof shortfalls = [];
      for (const sf of shortfalls) {
        let remaining = sf.remaining;
        const others = assigneeIds.filter((uid) => uid !== sf.userId);
        const withFreeCap = others
          .map((uid) => {
            const cap = capacity.get(uid);
            let free = 0;
            if (cap) for (let i = dynStartOffset; i < cap.length; i++) free += cap[i];
            return { userId: uid, free };
          })
          .filter((o) => o.free > HOURS_EPS_LOCAL)
          .sort((a, b) => b.free - a.free || (a.userId < b.userId ? -1 : 1));
        for (const o of withFreeCap) {
          if (remaining <= HOURS_EPS_LOCAL) break;
          const cap = capacity.get(o.userId)!;
          const r = placeOn(cap, remaining, dynStartOffset);
          pushSegments(o.userId, r.segments);
          remaining = r.remaining;
        }
        if (remaining > HOURS_EPS_LOCAL) stillShort.push({ userId: sf.userId, remaining });
      }
      shortfalls = stillShort;
    }

    // `user_saturated` n'est émis qu'UNE fois par tâche, sur ce qui survit
    // au rééquilibrage (avant : une fois par assignee).
    const totalRemaining = shortfalls.reduce((s, x) => s + x.remaining, 0);
    if (totalRemaining > HOURS_EPS_LOCAL) {
      warnings.push({ taskId, type: 'user_saturated', missingHours: round(totalRemaining) });
    } else {
      const due = dueByTask.get(taskId);
      if (due && taskMaxEndDate && +taskMaxEndDate > +due) {
        warnings.push({ taskId, type: 'deadline_overflow', plannedEnd: dateIso(taskMaxEndDate) });
      }
    }
    if (taskMaxEndDate) placedEndByTask.set(taskId, taskMaxEndDate);
    if (taskMinStartDate) placedStartByTask.set(taskId, taskMinStartDate);
  };

  // pendingPreds ne compte que les prédécesseurs présents dans `taskIds`
  // (in-scope) — un prédécesseur hors scope ne bloque jamais.
  const pendingPreds = new Map<string, number>();
  for (const id of taskIds) {
    const preds = (graph.preds.get(id) ?? []).filter((p) => taskIdSet.has(p.predId));
    pendingPreds.set(id, preds.length);
  }
  const ready: string[] = [];
  for (const id of taskIds) if ((pendingPreds.get(id) ?? 0) === 0) ready.push(id);

  while (ready.length) {
    // argmax(ready, scoreOf) — tie-break déterministe par taskId croissant.
    let bestIdx = 0;
    let bestScore = scoreOf(ready[0]);
    for (let i = 1; i < ready.length; i++) {
      const s = scoreOf(ready[i]);
      if (s > bestScore || (s === bestScore && ready[i] < ready[bestIdx])) {
        bestScore = s;
        bestIdx = i;
      }
    }
    const taskId = ready[bestIdx];
    ready.splice(bestIdx, 1);
    place(taskId);
    for (const s of graph.succs.get(taskId) ?? []) {
      if (!taskIdSet.has(s) || processed.has(s)) continue;
      const remaining = (pendingPreds.get(s) ?? 0) - 1;
      pendingPreds.set(s, remaining);
      if (remaining === 0) ready.push(s);
    }
  }

  // Cycle : des tâches restent non traitées (jamais tombées à pendingPreds
  // === 0). On les place quand même, par score décroissant, et on signale
  // chacune — sinon des tâches entières disparaîtraient silencieusement du
  // plan (comportement de `computeTopoOrder`, qui absorbe les cycles).
  const remaining = taskIds.filter((id) => !processed.has(id));
  if (remaining.length) {
    remaining.sort((a, b) => scoreOf(b) - scoreOf(a) || (a < b ? -1 : 1));
    for (const taskId of remaining) {
      place(taskId);
      warnings.push({ taskId, type: 'dependency_cycle' });
    }
  }

  return { proposed, warnings };
}

// ---- Lot 2.1 — placement deadline-aware (seconde passe corrective) -----

/** Clone profond d'une carte de capacité (`Float64Array` par user) — permet
 *  de rejouer `placeTasks` (qui MUTE sa capacité en place) plusieurs fois
 *  depuis le même état pristine, sans jamais retoucher l'original. */
export function cloneCapacityMap(
  capacity: Map<string, Float64Array>,
): Map<string, Float64Array> {
  const out = new Map<string, Float64Array>();
  for (const [uid, arr] of capacity) out.set(uid, Float64Array.from(arr));
  return out;
}

/** Extrait les `deadline_overflow` d'une liste de warnings, ne gardant que
 *  ceux porteurs d'une `plannedEnd` exploitable (toujours le cas en pratique
 *  — `placeTasks` la pose systématiquement pour ce type). */
export function overflowsOf(
  warnings: PlacementWarning[],
): { taskId: string; plannedEnd: string }[] {
  const out: { taskId: string; plannedEnd: string }[] = [];
  for (const w of warnings) {
    if (w.type === 'deadline_overflow' && w.plannedEnd) {
      out.push({ taskId: w.taskId, plannedEnd: w.plannedEnd });
    }
  }
  return out;
}

/**
 * Fonction objectif du Lot 2.1 : Σ (jours de retard × poids de priorité) sur
 * les tâches en `deadline_overflow`. Les tâches à l'heure ne contribuent rien
 * (absentes de `overflows`) — équivalent à sommer sur TOUTES les tâches du
 * scope avec un retard nul pour celles qui tiennent leur deadline. Pure,
 * déterministe.
 */
export function latenessObjective(
  overflows: { taskId: string; plannedEnd: string }[],
  dueByTask: Map<string, Date>,
  weightByTask: Map<string, number>,
): number {
  let sum = 0;
  for (const o of overflows) {
    const due = dueByTask.get(o.taskId);
    if (!due) continue;
    const plannedEnd = new Date(o.plannedEnd + 'T00:00:00.000Z');
    const daysLate = Math.max(0, Math.round((+plannedEnd - +due) / MS_PER_DAY));
    const weight = weightByTask.get(o.taskId) ?? 1;
    sum += daysLate * weight;
  }
  return sum;
}

/** Un essai de la passe deadline-aware : le plan produit + son objectif. */
export interface DeadlineAwareAttempt {
  proposed: PlacedSegment[];
  warnings: PlacementWarning[];
  objective: number;
}

/**
 * Seconde passe corrective (Lot 2.1, AUTOPLAN_IMPROVEMENTS.md §2.1) : rejoue
 * `placeTasks` (pur, inchangé) jusqu'à `maxIterations` fois, sur un CLONE
 * FRAIS de la capacité à chaque itération (jamais l'original mutable
 * `input.capacity`, ni le clone d'une itération précédente) — l'ordre
 * topologique reste donc la SEULE contrainte dure, exactement comme le
 * placement `asap` : cette passe ne fait rien d'autre que changer l'ordre
 * d'arbitrage du score, elle est sûre par construction.
 *
 * À chaque itération, les tâches encore en `deadline_overflow` reçoivent un
 * boost de score cumulatif (elles passent donc devant des tâches à moindre
 * priorité/score — en particulier celles à fort `totalSlack`, déjà pénalisées
 * par `SCORE_WEIGHTS.critical` côté appelant) puis on rejoue le placement
 * complet. On garde le MEILLEUR essai rencontré (objectif le plus bas) ; le
 * caller compare ensuite ce meilleur essai à son propre plan `asap` et ne le
 * retient QUE s'il l'améliore strictement (cf. `AutoplanService.run`).
 *
 * Renvoie `null` si `maxIterations <= 0` (rien à essayer).
 */
export function deadlineAwarePass(
  input: Parameters<typeof placeTasks>[0],
  weightByTask: Map<string, number>,
  maxIterations = 3,
): DeadlineAwareAttempt | null {
  if (maxIterations <= 0) return null;
  const boosts = new Map<string, number>();
  let best: DeadlineAwareAttempt | null = null;
  for (let iter = 0; iter < maxIterations; iter++) {
    const freshCapacity = cloneCapacityMap(input.capacity);
    const boostedScoreOf = (taskId: string): number =>
      input.scoreOf(taskId) + (boosts.get(taskId) ?? 0);
    const { proposed, warnings } = placeTasks({
      ...input,
      capacity: freshCapacity,
      scoreOf: boostedScoreOf,
    });
    const overflows = overflowsOf(warnings);
    const objective = latenessObjective(overflows, input.dueByTask, weightByTask);
    if (!best || objective < best.objective) best = { proposed, warnings, objective };
    if (overflows.length === 0) break; // rien de plus à corriger
    for (const o of overflows) {
      boosts.set(o.taskId, (boosts.get(o.taskId) ?? 0) + 1_000_000);
    }
  }
  return best;
}

// ---- Lot 2.5 — application partielle (filtre persist) ------------------

/** Filtre `applyOnly` (Lot 2.5, AUTOPLAN_IMPROVEMENTS.md §2.5) : userIds/
 *  taskIds absents ou vides = pas de filtre sur ce critère. Générique — sert
 *  aussi bien sur les allocations REMPLAÇABLES (à supprimer) que sur le plan
 *  PROPOSÉ (à créer), pour que le modèle delete+recreate de `persist()` reste
 *  cohérent : on ne supprime que ce qu'on va effectivement remplacer. Pure.
 */
export function filterByApplyOnly<T extends { userId: string; taskId: string }>(
  items: T[],
  filter?: { userIds?: string[]; taskIds?: string[] },
): T[] {
  if (!filter) return items;
  const userIds = filter.userIds && filter.userIds.length ? filter.userIds : null;
  const taskIds = filter.taskIds && filter.taskIds.length ? filter.taskIds : null;
  if (!userIds && !taskIds) return items;
  const userSet = userIds ? new Set(userIds) : null;
  const taskSet = taskIds ? new Set(taskIds) : null;
  return items.filter((it) => {
    if (userSet && !userSet.has(it.userId)) return false;
    if (taskSet && !taskSet.has(it.taskId)) return false;
    return true;
  });
}

// ---- Affectation assistée (sélection d'assignees) ----------------------

/** Candidat à l'affectation d'une tâche : niveau de skill + capacité libre,
 *  agrégés en un `score` (le skill domine, la dispo départage). */
export interface AssigneeCandidate {
  userId: string;
  name: string;
  /** Niveau sur le skill requis (null si la tâche n'exige aucun skill). */
  level: number | null;
  /** Atteint le niveau requis (toujours vrai si aucun skill requis). */
  meetsRequired: boolean;
  /** Heures réellement libres sur la fenêtre de la tâche. */
  freeHours: number;
  score: number;
  /** Écarté du noyau par le filtre d'absence (Lot 1b.1) — sans capacité ou en
   *  absence longue durée sur la fenêtre. Reste en `alternatives` (swap UI),
   *  jamais dans `chosen` sauf fallback `all_candidates_unavailable`. */
  unavailable?: boolean;
  /** Vrai si ce candidat est un agent IA (Lot 5, §5.2) — `freeHours` n'a alors
   *  aucun sens (la capacité d'un agent n'est jamais des heures) ; l'UI
   *  affiche un badge « Agent IA » + `trustLevel` à la place. */
  isAgent?: boolean;
  /** Niveau de confiance de l'agent (candidats agent uniquement). */
  trustLevel?: 'DRAFT_ONLY' | 'SUPERVISED' | 'AUTONOMOUS' | null;
}

export interface AssigneeSelection {
  chosen: AssigneeCandidate[];
  alternatives: AssigneeCandidate[];
  source: 'auto' | 'override';
  warning?: 'no_candidates' | 'no_qualified' | 'capacity_short';
}

/**
 * Choisit le(s) assignee(s) d'une tâche sans assigné, à partir des candidats
 * (pré-scorés skill+capacité). Pur et déterministe :
 *  - tri par score décroissant, puis capacité libre, puis nom (stable) ;
 *  - **override** PM (`overrideUserIds`) : on retient exactement ces users
 *    parmi les candidats (le PM swappe depuis les alternatives) ;
 *  - sinon **auto** : couverture *greedy* — on prend le meilleur, puis on
 *    ajoute le suivant tant que Σ capacité libre < heures restantes (préférer
 *    le moins de personnes). `capacity_short` si même tous ensemble ne
 *    couvrent pas ; `no_qualified`/`no_candidates` si rien d'éligible.
 *  Les `alternatives` = candidats qualifiés non retenus (pool de swap UI).
 */
export function selectAssignees(
  candidates: AssigneeCandidate[],
  remainingHours: number,
  overrideUserIds?: string[],
): AssigneeSelection {
  if (candidates.length === 0) {
    return { chosen: [], alternatives: [], source: 'auto', warning: 'no_candidates' };
  }
  const byRank = (a: AssigneeCandidate, b: AssigneeCandidate) =>
    b.score - a.score || b.freeHours - a.freeHours || a.name.localeCompare(b.name);
  const qualified = candidates.filter((c) => c.meetsRequired).sort(byRank);
  const sortedAll = [...candidates].sort(byRank);
  // Pool d'alternatives (swap UI) = TOUT le pool sauf les choisis, qualifiés en
  // tête puis non qualifiés (marqués ⚠ côté UI). On expose le pool complet pour
  // que le PM puisse TOUJOURS re-choisir quelqu'un d'autre — y compris quand le
  // seul candidat qualifié est déjà choisi (sinon le select disparaissait).
  const altSorted = [...candidates].sort(
    (a, b) => Number(b.meetsRequired) - Number(a.meetsRequired) || byRank(a, b),
  );
  const altsExcept = (chosenIds: Set<string>) =>
    altSorted.filter((c) => !chosenIds.has(c.userId));

  // Override PM : on retient les users demandés présents dans le pool.
  if (overrideUserIds && overrideUserIds.length) {
    const wanted = new Set(overrideUserIds);
    const chosen = sortedAll.filter((c) => wanted.has(c.userId));
    if (chosen.length) {
      const chosenIds = new Set(chosen.map((c) => c.userId));
      const coverage = chosen.reduce((s, c) => s + c.freeHours, 0);
      return {
        chosen,
        alternatives: altsExcept(chosenIds),
        source: 'override',
        warning: coverage + 1e-6 < remainingHours ? 'capacity_short' : undefined,
      };
    }
    // Override invalide (aucun user demandé dans le pool) → on retombe en auto.
  }

  if (qualified.length === 0) {
    // Personne ne tient le niveau requis : on n'affecte pas, mais on expose le
    // pool comme alternatives pour un override manuel éventuel.
    return { chosen: [], alternatives: sortedAll, source: 'auto', warning: 'no_qualified' };
  }

  const chosen: AssigneeCandidate[] = [qualified[0]];
  let coverage = qualified[0].freeHours;
  let i = 1;
  while (coverage + 1e-6 < remainingHours && i < qualified.length) {
    chosen.push(qualified[i]);
    coverage += qualified[i].freeHours;
    i++;
  }
  const chosenIds = new Set(chosen.map((c) => c.userId));
  return {
    chosen,
    alternatives: altsExcept(chosenIds),
    source: 'auto',
    warning: coverage + 1e-6 < remainingHours ? 'capacity_short' : undefined,
  };
}

// ---- Lot 4.1 — capacité consciente du temps réel (TimeEntry) ------------

/**
 * Excédent de temps loggé au-delà de ce qui était alloué ce jour-là : SEULE la
 * part EN PLUS compte comme consommation de capacité (Lot 4.1,
 * AUTOPLAN_IMPROVEMENTS.md §4.1) — le temps loggé qui correspond à une
 * allocation posée ce jour est le travail PRÉVU qui se réalise, pas une charge
 * supplémentaire. Pure, clampée à 0 (un jour sous-loggé ne libère jamais de
 * capacité en plus — ce n'est pas le sujet de cette règle).
 */
export function excessLoggedHours(logged: number, allocated: number): number {
  return Math.max(0, logged - allocated);
}

// ---- Lot 4.2 — levée ciblée du gel (« Libérer cette journée ») ----------

/** Périmètre de la levée de gel : UN user, UN jour (jamais plus large). */
export interface UnfreezeUserDay {
  userId: string;
  /** Début de journée UTC (ms) du jour à libérer. */
  dayMs: number;
}

/**
 * Une allocation devient-elle REMPLAÇABLE grâce à la levée ciblée du gel
 * (Lot 4.2, AUTOPLAN_IMPROVEMENTS.md §4.2) ? Vrai ssi TOUTES ces conditions :
 *  - `unfreeze` est posé (sinon aucune levée n'est en jeu) ;
 *  - l'allocation appartient au MÊME user que celui visé par la levée ;
 *  - elle COMMENCE exactement le jour visé (`startDate`) ;
 *  - ce jour est strictement AVANT `cutoffMs` (J+1) — la levée ne sert qu'à
 *    élargir le gel du PASSÉ/AUJOURD'HUI, jamais le futur (déjà remplaçable).
 *
 * Pure et bornée par construction : ne peut JAMAIS rendre remplaçable une
 * allocation d'un autre user ou d'un autre jour — un seul user, un seul jour,
 * exactement le périmètre demandé.
 */
export function isUnfrozenAllocation(
  alloc: { userId: string; startDate: Date },
  unfreeze: UnfreezeUserDay | null | undefined,
  cutoffMs: number,
): boolean {
  if (!unfreeze) return false;
  if (alloc.userId !== unfreeze.userId) return false;
  if (unfreeze.dayMs >= cutoffMs) return false;
  return +startOfUtcDay(alloc.startDate) === unfreeze.dayMs;
}

// ---- Badge « plan obsolète » (Lot 3.3, AUTOPLAN_IMPROVEMENTS.md §3.3) ----

/**
 * Le plan auto-plan appliqué sur un projet est-il obsolète ? Compare le
 * dernier mouvement de tâche (`max(Task.updatedAt)`) à la dernière
 * application de l'auto-plan (`max(Allocation.createdAt)` parmi les
 * allocations `isAutoPlan`). Pure — aucun accès Prisma, les deux dates sont
 * déjà agrégées côté service.
 *
 * - Pas d'auto-plan appliqué (`maxAutoAllocCreatedAt` null) → jamais stale,
 *   il n'y a rien à comparer.
 * - Projet sans tâche (`maxTaskUpdatedAt` null) → jamais stale.
 * - Sinon : stale ssi une tâche a bougé APRÈS la dernière application.
 */
export function isPlanStale(
  maxTaskUpdatedAt: Date | null,
  maxAutoAllocCreatedAt: Date | null,
): boolean {
  if (!maxAutoAllocCreatedAt) return false;
  if (!maxTaskUpdatedAt) return false;
  return maxTaskUpdatedAt.getTime() > maxAutoAllocCreatedAt.getTime();
}

// ---- Agents IA dans l'auto-plan (Lot 5, AUTOPLAN_IMPROVEMENTS.md §5) ------
//
// PRINCIPE INTANGIBLE (AGENTS_ARCHITECTURE.md) : la capacité d'un agent n'est
// JAMAIS des heures — concurrence + budgets runs/€ seulement — et un agent ne
// reçoit JAMAIS d'Allocation. Les fonctions ci-dessous ne décident QUE de
// l'ÉLIGIBILITÉ (§5.2, suggestion) et de la dégradation du chiffré (§5.1,
// visibilité) ; elles n'écrivent rien, aucune n'a d'effet de bord.

export type AgentTaskStakes = 'low' | 'medium' | 'high' | 'critical';
export type AgentTrust = 'DRAFT_ONLY' | 'SUPERVISED' | 'AUTONOMOUS';

const STAKES_ORDER: readonly AgentTaskStakes[] = ['low', 'medium', 'high', 'critical'];

/** Plafond d'enjeu qu'un niveau de confiance peut couvrir — matrice MONOTONE
 *  (§5.2) : un agent `DRAFT_ONLY` n'est jamais proposé sur une tâche à enjeu
 *  `high`/`critical`, quelle que soit la force de ses preuves. Volontairement
 *  plus simple que `deriveVerificationFloor` (deliverables/verification.ts) —
 *  celle-ci gouverne la PREUVE exigée à la revue d'un livrable déjà produit ;
 *  ici on décide si l'agent doit seulement se VOIR PROPOSER la tâche. */
const TRUST_MAX_STAKES: Record<AgentTrust, AgentTaskStakes> = {
  DRAFT_ONLY: 'medium',
  SUPERVISED: 'high',
  AUTONOMOUS: 'critical',
};

/**
 * Le niveau de confiance de l'agent couvre-t-il l'enjeu de la tâche (dérivé
 * de `Project.stakes`) ? `stakes` absent ⇒ `low` (le plus permissif) ;
 * `trust` absent ⇒ `DRAFT_ONLY` (le plus restrictif) — un agent sans niveau
 * de confiance connu n'est jamais présumé digne de confiance.
 */
export function agentTrustAllowsStakes(
  stakes: AgentTaskStakes | null | undefined,
  trust: AgentTrust | null | undefined,
): boolean {
  const st: AgentTaskStakes = stakes && STAKES_ORDER.includes(stakes) ? stakes : 'low';
  const tr: AgentTrust = trust && trust in TRUST_MAX_STAKES ? trust : 'DRAFT_ONLY';
  return STAKES_ORDER.indexOf(st) <= STAKES_ORDER.indexOf(TRUST_MAX_STAKES[tr]);
}

/** Raison du rejet (la PREMIÈRE condition qui échoue, dans l'ordre de la
 *  liste — permet à l'appelant d'afficher un motif utile côté audit/UI). */
export type AgentEligibilityReason = 'capability' | 'skill' | 'budget' | 'concurrency' | 'trust';

export interface AgentEligibilityInput {
  /** Les capabilities de l'agent couvrent l'action à produire (ex. `tasks:execute`). */
  capabilitiesCoverAction: boolean;
  /** L'agent atteint le niveau requis sur TOUS les skills requis de la tâche
   *  (conjonction multi-skill, comme pour un candidat humain). */
  meetsRequiredSkills: boolean;
  /** `true` = au moins une des 4 enveloppes de coût (agent×jour, agent×mois,
   *  projet, tâche) est déjà consommée — même verdict que le 409 au claim. */
  budgetStop: boolean;
  /** `true` = l'agent est déjà à sa limite de tâches simultanées
   *  (CLAIMED/IN_PROGRESS/CHANGES_REQUESTED), comme au claim. */
  concurrencyFull: boolean;
  /** `agentTrustAllowsStakes(project.stakes, agent.trustLevel)`. */
  trustAllowsStakes: boolean;
}

export interface AgentEligibilityResult {
  eligible: boolean;
  reason?: AgentEligibilityReason;
}

/**
 * Un agent est-il éligible à se voir PROPOSER une tâche (§5.2) ? Conjonction
 * DURE — toutes les conditions doivent tenir, dans l'ordre où elles sont
 * évaluées ci-dessous (la première qui échoue devient `reason`). Pure et
 * déterministe : aucun accès DB, l'appelant a déjà résolu chaque booléen.
 */
export function isAgentEligible(input: AgentEligibilityInput): AgentEligibilityResult {
  if (!input.capabilitiesCoverAction) return { eligible: false, reason: 'capability' };
  if (!input.meetsRequiredSkills) return { eligible: false, reason: 'skill' };
  if (input.budgetStop) return { eligible: false, reason: 'budget' };
  if (input.concurrencyFull) return { eligible: false, reason: 'concurrency' };
  if (!input.trustAllowsStakes) return { eligible: false, reason: 'trust' };
  return { eligible: true };
}

// ---- Lot 5.1 — dégradation propre du chiffré (visibilité workload agents) --

/** Forme minimale d'une ligne « workload agent » portant un bloc `budget`
 *  optionnel (montants €). Générique pour rester réutilisable côté DTO. */
export interface AgentFinanceBearing {
  budget?: unknown;
}

/**
 * Retire le bloc `budget` (montants €) des éléments quand l'appelant n'a pas
 * `finance:view` — jamais un placeholder, jamais une erreur : le champ est
 * simplement ABSENT (même discipline que les paliers budget sponsors
 * qualitatifs). Pure : ne modifie jamais les objets en entrée (copie
 * superficielle par élément).
 */
export function stripAgentFinanceFields<T extends AgentFinanceBearing>(
  items: readonly T[],
  canViewFinance: boolean,
): T[] {
  if (canViewFinance) return items.slice();
  return items.map((it) => {
    const { budget: _budget, ...rest } = it;
    return rest as T;
  });
}

// ---- Lot 5.2 — passe agent AVANT le pool humain (séparation stricte) -------

/**
 * Partitionne des tâches candidates en deux ensembles DISJOINTS selon un
 * prédicat d'éligibilité agent : celles qu'un agent éligible peut couvrir
 * (`agentTaskIds`, à traiter par la passe agent, JAMAIS par le greedy humain)
 * et le reste (`humanTaskIds`, pool humain inchangé). Pure — l'appelant a déjà
 * résolu, pour chaque tâche, s'il existe au moins un agent éligible.
 * Garantit par construction que les deux ensembles ne se recouvrent jamais et
 * que leur union est exactement `taskIds` (aucune tâche perdue).
 */
export function partitionAgentVsHumanTasks(
  taskIds: readonly string[],
  hasEligibleAgent: (taskId: string) => boolean,
): { agentTaskIds: string[]; humanTaskIds: string[] } {
  const agentTaskIds: string[] = [];
  const humanTaskIds: string[] = [];
  for (const id of taskIds) {
    if (hasEligibleAgent(id)) agentTaskIds.push(id);
    else humanTaskIds.push(id);
  }
  return { agentTaskIds, humanTaskIds };
}
