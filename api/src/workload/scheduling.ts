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

// ---- Durée par défaut --------------------------------------------------

/** Durée d'une tâche en jours-effort, plancher à 1. La base h/jour est celle
 *  de l'organisation (`hoursPerDay`, défaut 8 si non fourni) — cohérent avec le
 *  reste du système qui consomme `orgSettings.hoursPerDay`, et non plus un 8
 *  codé en dur qui dériverait sur une org à 7h/7.5h par jour. */
function durationDays(
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
 * Date au plus tôt par tâche, à partir de `from` et des dépendances
 * (FS + lag, MVP). Renvoie `Map<taskId, Date>`. Pour SS/FF/SF on aligne
 * sur le start du prédécesseur (approx MVP).
 */
export function computeEarliestStart(
  tasks: SchedulingTask[],
  deps: SchedulingDependency[],
  from: Date,
  hoursPerDay = 8,
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
    const myEnd = addDays(myStart, durationDays(t.estimateHours, hoursPerDay));
    for (const e of out.get(id) ?? []) {
      let earliest = myEnd;
      if (e.type === 'SS') earliest = myStart;
      else if (e.type === 'FF' || e.type === 'SF') earliest = myStart;
      earliest = addDays(earliest, e.lagDays);
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

/**
 * Heuristique chemin critique : plus longue chaîne (jours-effort) racine→feuille.
 * MVP, pas un vrai backward-pass.
 */
export function estimateCriticalPath(
  tasks: SchedulingTask[],
  deps: SchedulingDependency[],
  hoursPerDay = 8,
): Set<string> {
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
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const dur = (id: string) =>
    durationDays(taskById.get(id)?.estimateHours ?? null, hoursPerDay);

  const order: string[] = [];
  const queue: string[] = [];
  const inDegCopy = new Map(inDeg);
  for (const [id, d] of inDegCopy) if (d === 0) queue.push(id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of out.get(id) ?? []) {
      const d = (inDegCopy.get(s) ?? 0) - 1;
      inDegCopy.set(s, d);
      if (d === 0) queue.push(s);
    }
  }
  const dist = new Map<string, number>();
  const pred = new Map<string, string | null>();
  for (const id of order) {
    dist.set(id, dur(id));
    pred.set(id, null);
  }
  for (const id of order) {
    const base = dist.get(id)!;
    for (const s of out.get(id) ?? []) {
      const cand = base + dur(s);
      if (cand > (dist.get(s) ?? 0)) {
        dist.set(s, cand);
        pred.set(s, id);
      }
    }
  }
  let endId: string | null = null;
  let max = -1;
  for (const [id, d] of dist) if (d > max) {
    max = d;
    endId = id;
  }
  const crit = new Set<string>();
  let cur = endId;
  while (cur) {
    crit.add(cur);
    cur = pred.get(cur) ?? null;
  }
  return crit;
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
 * `estimateCriticalPath` (heuristique « plus longue chaîne »), ce calcul fait un
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
): Map<string, TaskSchedule> {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const dur = (id: string) =>
    durationDays(taskById.get(id)?.estimateHours ?? null, hoursPerDay);

  // ---- Forward pass (réutilise computeEarliestStart) ----
  const earlyStart = computeEarliestStart(tasks, deps, from, hoursPerDay);
  const earlyFinish = new Map<string, Date>();
  let projectFinish = from;
  for (const t of tasks) {
    const es = earlyStart.get(t.id)!;
    const ef = addDays(es, dur(t.id));
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
      const succLs = lateStart.get(e.to);
      if (!succLs) continue;
      // Miroir du forward : FS contraint la FIN du prédécesseur sur le start du
      // successeur ; SS/FF/SF (approximés sur le start dans le forward) →
      // contraignent le START du prédécesseur, d'où une fin = start + durée.
      const cand =
        e.type === 'FS'
          ? addDays(succLs, -e.lagDays)
          : addDays(addDays(succLs, -e.lagDays), d);
      if (lf === null || +cand < +lf) lf = cand;
    }
    const myLf = lf ?? projectFinish;
    lateFinish.set(id, myLf);
    lateStart.set(id, addDays(myLf, -d));
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
