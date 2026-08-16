/**
 * Concentration de l'affectation assistée (Lot 1b — AUTOPLAN_IMPROVEMENTS.md
 * §« Lot 1b — Concentration : décider par grappe, pas par tâche »).
 *
 * Pure, sans Prisma ni Nest : groupe des tâches sans assigné en « grappes »
 * cohérentes (même compétence(s) requise(s), à défaut même parent, à défaut
 * même board), fusionne les grappes qu'une seule personne peut couvrir
 * (set cover glouton — même pattern que `selectAssignees`), puis répartit les
 * tâches d'une grappe sur le noyau retenu (une tâche entière par personne
 * tant que possible). Testé en isolation dans `__tests__/clustering.spec.ts`.
 */

const MS_PER_DAY = 86_400_000;
/** Tolérance pour comparer des heures/jour (cohérente avec scheduling.ts/autoplan.service.ts). */
const HOURS_EPS = 0.01;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------
// 1b.1 — Groupage en grappes atomiques
// ---------------------------------------------------------------

/** Vue minimale d'une tâche pour le groupage (skills DÉJÀ résolus en cible
 *  numérique par l'appelant — `target` = niveau demandé ou le max du
 *  catalogue en fallback). */
export interface ClusterInputTask {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  /** Clé de board (ex. `boardId`) — dernier niveau du fallback en cascade. */
  boardKey: string | null;
  skillReqs: { skillId: string; target: number }[];
  startDate: Date | null;
  dueDate: Date | null;
}

/** Clé de grappe en cascade : (1) compétences requises, (2) parent, (3) board. */
export function clusterKey(
  projectId: string,
  skillIds: string[],
  parentTaskId: string | null,
  boardKey: string | null,
): string {
  if (skillIds.length > 0) {
    return `${projectId}|skills|${Array.from(new Set(skillIds)).sort().join(',')}`;
  }
  if (parentTaskId) return `${projectId}|parent|${parentTaskId}`;
  return `${projectId}|board|${boardKey ?? 'none'}`;
}

export interface AtomicCluster {
  key: string;
  projectId: string;
  /** Union des skills requis par les tâches de la grappe, niveau = MAX demandé. */
  skillReqs: { skillId: string; target: number }[];
  taskIds: string[];
}

/** Groupe les tâches en grappes atomiques (avant fusion set-cover). Sortie
 *  triée par clé (déterministe, indépendante de l'ordre d'entrée). */
export function buildAtomicClusters(tasks: ClusterInputTask[]): AtomicCluster[] {
  // Skills agrégés dans une Map<skillId, target> (lookup O(1) au lieu d'un
  // `.find` linéaire dans la double boucle). L'ordre d'insertion de la Map =
  // ordre de première apparition = ordre de l'ancien `push`, et `Math.max` est
  // commutatif → `skillReqs` reste identique (même contenu, même ordre).
  const byKey = new Map<
    string,
    { key: string; projectId: string; taskIds: string[]; skills: Map<string, number> }
  >();
  for (const t of tasks) {
    const skillIds = t.skillReqs.map((r) => r.skillId);
    const key = clusterKey(t.projectId, skillIds, t.parentTaskId, t.boardKey);
    let c = byKey.get(key);
    if (!c) {
      c = { key, projectId: t.projectId, taskIds: [], skills: new Map() };
      byKey.set(key, c);
    }
    c.taskIds.push(t.id);
    for (const r of t.skillReqs) {
      const cur = c.skills.get(r.skillId);
      c.skills.set(r.skillId, cur === undefined ? r.target : Math.max(cur, r.target));
    }
  }
  return Array.from(byKey.values())
    .map((c) => ({
      key: c.key,
      projectId: c.projectId,
      skillReqs: Array.from(c.skills, ([skillId, target]) => ({ skillId, target })),
      taskIds: c.taskIds,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------
// Fenêtre & effort d'une grappe
// ---------------------------------------------------------------

/** Somme des heures restantes (déjà calculées par l'appelant : estimate − logged). */
export function clusterEffort(taskIds: string[], effortByTask: Map<string, number>): number {
  let sum = 0;
  for (const id of taskIds) sum += Math.max(0, effortByTask.get(id) ?? 0);
  return sum;
}

/**
 * Fenêtre de planification d'une grappe : `[max(cutoff, min startDate), min
 * dueDate]`. Si AUCUNE tâche de la grappe n'a de dueDate, retombe sur
 * l'heuristique existante (7–60 j proportionnels à l'effort), bornée à `to`.
 */
export function clusterWindow(
  taskIds: string[],
  tasksById: Map<string, { startDate: Date | null; dueDate: Date | null }>,
  effort: number,
  cutoff: Date,
  hoursPerDay: number,
  to: Date,
): { start: Date; end: Date } {
  let minStart: Date | null = null;
  let minDue: Date | null = null;
  for (const id of taskIds) {
    const t = tasksById.get(id);
    if (!t) continue;
    if (t.startDate && (!minStart || +t.startDate < +minStart)) minStart = t.startDate;
    if (t.dueDate && (!minDue || +t.dueDate < +minDue)) minDue = t.dueDate;
  }
  const start = minStart && +minStart > +cutoff ? minStart : cutoff;
  let end: Date;
  if (minDue) {
    end = +minDue < +start ? start : minDue;
  } else {
    const days = Math.min(60, Math.max(7, Math.ceil((effort / Math.max(1, hoursPerDay)) * 1.5)));
    end = new Date(+start + days * MS_PER_DAY);
  }
  if (+end > +to) end = to;
  if (+end < +start) end = start;
  return { start, end };
}

// ---------------------------------------------------------------
// 1b.1 — Fusion par couverture (set cover glouton)
// ---------------------------------------------------------------

export interface WindowedCluster extends AtomicCluster {
  effort: number;
  windowStart: Date;
  windowEnd: Date;
}

/** Conjonction : le candidat doit atteindre la cible sur CHAQUE skill requis. */
export function meetsAllRequired(
  skillReqs: { skillId: string; target: number }[],
  levelFor: (skillId: string) => number,
): boolean {
  return skillReqs.every((r) => levelFor(r.skillId) >= r.target);
}

function mergeSkillReqs(
  a: { skillId: string; target: number }[],
  b: { skillId: string; target: number }[],
): { skillId: string; target: number }[] {
  const map = new Map<string, number>(a.map((r) => [r.skillId, r.target]));
  for (const r of b) map.set(r.skillId, Math.max(map.get(r.skillId) ?? 0, r.target));
  return Array.from(map, ([skillId, target]) => ({ skillId, target }));
}

function byEffortDesc(a: WindowedCluster, b: WindowedCluster): number {
  return b.effort - a.effort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Fusionne gloutonnement deux grappes dès qu'un candidat est qualifié pour
 * les deux ET dispose de la capacité pour l'effort cumulé sur la fenêtre
 * commune (intersection des fenêtres, somme des efforts) — sinon les grappes
 * restent séparées. Pattern set-cover, même esprit que `selectAssignees`.
 * Déterministe : tri stable par effort décroissant, tie-break par clé.
 */
export function mergeClustersBySetCover(
  clusters: WindowedCluster[],
  candidateIds: string[],
  levelFor: (userId: string, skillId: string) => number,
  freeHoursFor: (userId: string, start: Date, end: Date) => number,
): WindowedCluster[] {
  let working = [...clusters].sort(byEffortDesc);
  let mergedOnce = true;
  while (mergedOnce) {
    mergedOnce = false;
    for (let i = 0; i < working.length && !mergedOnce; i++) {
      for (let j = i + 1; j < working.length; j++) {
        const A = working[i];
        const B = working[j];
        const wsMs = Math.max(+A.windowStart, +B.windowStart);
        const weMs = Math.min(+A.windowEnd, +B.windowEnd);
        if (wsMs > weMs) continue; // pas d'intersection de fenêtre → jamais fusionnable
        const ws = new Date(wsMs);
        const we = new Date(weMs);
        const mergedSkillReqs = mergeSkillReqs(A.skillReqs, B.skillReqs);
        const mergedEffort = A.effort + B.effort;
        const canMerge = candidateIds.some(
          (uid) =>
            meetsAllRequired(mergedSkillReqs, (sid) => levelFor(uid, sid)) &&
            freeHoursFor(uid, ws, we) + HOURS_EPS >= mergedEffort,
        );
        if (!canMerge) continue;
        const merged: WindowedCluster = {
          key: `${A.key}+${B.key}`,
          projectId: A.projectId,
          skillReqs: mergedSkillReqs,
          taskIds: [...A.taskIds, ...B.taskIds],
          effort: mergedEffort,
          windowStart: ws,
          windowEnd: we,
        };
        const rest = working.filter((_, idx) => idx !== i && idx !== j);
        working = [merged, ...rest].sort(byEffortDesc);
        mergedOnce = true;
        break;
      }
    }
  }
  return working;
}

// ---------------------------------------------------------------
// Bonus de continuité
// ---------------------------------------------------------------

/** 1 si déjà assigné à un skill de la grappe dans ce projet (base ou décidé
 *  plus tôt dans ce run) ; 0.5 si membre actif du projet sur d'autres tâches ;
 *  sinon 0. */
export function continuityScore(
  clusterSkillIds: string[],
  priorSkillsForUser: Set<string> | undefined,
  isActiveProjectMember: boolean,
): number {
  if (priorSkillsForUser && clusterSkillIds.some((sid) => priorSkillsForUser.has(sid))) return 1;
  if (isActiveProjectMember) return 0.5;
  return 0;
}

// ---------------------------------------------------------------
// Écarter les absents (filtre dur + fallback)
// ---------------------------------------------------------------

/** Seuil par défaut d'absence longue durée (part de la fenêtre couverte par
 *  un time-off) au-delà duquel un candidat est écarté du noyau même s'il
 *  reste de la capacité résiduelle en bord de fenêtre. Constante nommée,
 *  à réviser au premier retour terrain (cf. AUTOPLAN_IMPROVEMENTS.md risque #4). */
export const LONG_ABSENCE_PCT = 0.6;

/**
 * Écarte du noyau les candidats sans capacité (freeHours ≤ 0) ou en absence
 * longue durée (time-off couvrant > `longAbsencePct` de la fenêtre) — filtre
 * DUR indépendant du score (skill+dispo à eux seuls ne suffisent pas à
 * écarter un absent, cf. AUTOPLAN_IMPROVEMENTS.md §1b.1). Le fallback (« si le
 * filtre vide le pool alors que des qualifiés existaient ») est de la
 * responsabilité de l'appelant (nécessite de connaître `meetsRequired`).
 */
export function filterAbsentCandidates<C extends { userId: string; freeHours: number }>(
  candidates: C[],
  timeOffsByUser: Map<string, { startDate: Date; endDate: Date }[]>,
  windowStart: Date,
  windowEnd: Date,
  longAbsencePct = LONG_ABSENCE_PCT,
): { core: C[]; excluded: C[] } {
  const windowDays = Math.max(1, Math.round((+windowEnd - +windowStart) / MS_PER_DAY) + 1);
  const core: C[] = [];
  const excluded: C[] = [];
  for (const c of candidates) {
    if (c.freeHours <= HOURS_EPS) {
      excluded.push(c);
      continue;
    }
    const offs = timeOffsByUser.get(c.userId) ?? [];
    let offDays = 0;
    for (const o of offs) {
      const s = Math.max(+windowStart, +o.startDate);
      const e = Math.min(+windowEnd, +o.endDate);
      if (e >= s) offDays += Math.round((e - s) / MS_PER_DAY) + 1;
    }
    if (offDays / windowDays > longAbsencePct) {
      excluded.push(c);
      continue;
    }
    core.push(c);
  }
  return { core, excluded };
}

// ---------------------------------------------------------------
// Répartition des tâches de la grappe sur le noyau
// ---------------------------------------------------------------

export interface DistributableTask {
  id: string;
  effort: number;
}

export interface CoreMember {
  userId: string;
  residualHours: number;
}

export interface TaskDistribution {
  taskId: string;
  /** 1 user si un membre seul peut couvrir l'effort ; plusieurs sinon
   *  (co-assignation par nécessité uniquement) ; vide si aucun membre. */
  assigneeIds: string[];
}

/**
 * Répartit les tâches d'une grappe sur son noyau : chaque tâche à UN membre
 * (remplissage par capacité résiduelle décroissante, une tâche entière par
 * personne tant que possible) ; co-assignation seulement si l'effort de la
 * tâche dépasse la capacité restante de TOUT membre seul (couverture
 * glouton par résiduel décroissant, comme `selectAssignees`). Pur et
 * déterministe (tie-break userId).
 */
export function distributeClusterTasks(
  tasks: DistributableTask[],
  core: CoreMember[],
): { distributions: TaskDistribution[]; residualByUser: Map<string, number> } {
  const residual = new Map(core.map((c) => [c.userId, c.residualHours]));
  const order = [...tasks].sort((a, b) => b.effort - a.effort || (a.id < b.id ? -1 : 1));
  const distributions: TaskDistribution[] = [];
  for (const t of order) {
    const ranked = Array.from(residual, ([userId, r]) => ({ userId, r })).sort(
      (a, b) => b.r - a.r || (a.userId < b.userId ? -1 : 1),
    );
    if (ranked.length === 0) {
      distributions.push({ taskId: t.id, assigneeIds: [] });
      continue;
    }
    const soloCandidates = ranked.filter((c) => c.r + HOURS_EPS >= t.effort);
    if (soloCandidates.length > 0) {
      const winner = soloCandidates[0]; // déjà trié desc → résiduel le plus grand parmi les solo-capables
      residual.set(winner.userId, round(winner.r - t.effort));
      distributions.push({ taskId: t.id, assigneeIds: [winner.userId] });
    } else {
      const assigneeIds: string[] = [];
      let remaining = t.effort;
      for (const c of ranked) {
        if (remaining <= HOURS_EPS) break;
        assigneeIds.push(c.userId);
        const take = Math.min(c.r, remaining);
        residual.set(c.userId, round(c.r - take));
        remaining -= take;
      }
      distributions.push({ taskId: t.id, assigneeIds });
    }
  }
  return { distributions, residualByUser: residual };
}
