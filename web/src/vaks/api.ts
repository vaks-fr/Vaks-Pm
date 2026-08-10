/* ============================================================
   Vaks — adapter API
   Charge depuis l'API réelle (web/src/api/client.ts) et convertit
   vers les types Vaks (User, Project, Task, Comment, TimeEntry, ...).
   Les vues continuent de lire les exports de data.ts sans changement.
   ============================================================ */
import type {
  AttachmentDto,
  BoardColumnDto,
  BurndownReportDto,
  CommentDto,
  WatcherDto,
  WatchingEntryDto,
  RecurringTaskDto,
  UpsertRecurrenceDto,
  CustomFieldValueDto,
  CreateLabelDto,
  DeliverableDto,
  CreateDeliverableDto,
  ReviewDeliverableDto,
  AcceptanceCriterion,
  CreateTaskDto as ApiCreateTaskDto,
  DueAdherenceDto,
  ProjectByTeamDto,
  MyTasksDto,
  LabelDto,
  ProjectDto,
  ProjectStatsDto,
  TaskDto,
  TasksInWindowReportDto,
  TimeBreakdownDto,
  TimeEntryDto,
  TimesheetDto,
  DashboardDto,
  UpdateTaskDto as ApiUpdateTaskDto,
  UserDto,
} from '@vaks-pm/shared';
import { TaskStatus } from '@vaks-pm/shared';
import { statusColKey } from './taskStatus';
import { api } from '../api/client';

// Re-export shared DTOs used by vaks views.
export type {
  AttachmentDto,
  DeliverableDto,
  BurndownReportDto as BurndownReport,
  DueAdherenceDto as DueAdherence,
  ProjectStatsDto as ProjectStats,
  TimeBreakdownDto as TimeBreakdown,
  TimeBreakdownRowDto as TimeBreakdownRow,
  TasksInWindowReportDto,
  TaskInWindowDto,
  TimesheetDto,
  DashboardDto,
  DashboardTaskDto,
  DashboardActivityDto,
} from '@vaks-pm/shared';
import {
  setVaksData,
  projects as PROJECTS_STORE,
  type BoardSubStatus,
  type Column,
  type Comment as VComment,
  type Label as VLabel,
  type Priority,
  type Project as VProject,
  type Task as VTask,
  type TimeEntry as VTimeEntry,
  type User as VUser,
} from './data';

/** Snapshot par projet pour stale-while-revalidate. */
interface ProjectSnapshot {
  monday: Date;
  projectId: string;
  columns: Column[];
  labels: Record<string, VLabel>;
  tasks: VTask[];
  timeEntries: Record<string, VTimeEntry[]>;
  availableAssigneeIds: string[] | null;
  boardColumnsApi: BoardColumnDto[];
  apiTasks: TaskDto[];
}
const projectSnapshots = new Map<string, ProjectSnapshot>();

/** Cherche le `key` d'un projet dans le store en mémoire ; undefined si inconnu. */
function projectKeyOf(projectId: string | null | undefined): string | undefined {
  if (!projectId) return undefined;
  return PROJECTS_STORE.find((p) => p.id === projectId)?.key;
}

// ---------- Helpers ----------------------------------------------

/** Hash UUID -> 0..359 pour dériver une teinte stable. */
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/**
 * Teinte dérivée du *key* visible du projet (2-3 caractères), pour que la
 * pastille colorée soit identique partout : panneau Projects, dropdown du
 * workspace, breadcrumb, etc. **Doit rester identique** à `colorFromKey` de
 * `ProjectsPanel.tsx` — si tu changes la formule, change les deux.
 */
export function hueFromProjectKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

export function initialsOf(name: string | null | undefined): string {
  const safe = (name ?? '').trim();
  if (!safe) return '?';
  const parts = safe.split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function shortNameOf(name: string | null | undefined): string {
  const safe = (name ?? '').trim();
  if (!safe) return '—';
  return safe.split(/\s+/)[0] ?? safe;
}

/** Convertit `#rrggbb` en teinte HSL 0..359. */
function hueFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 200;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return Math.round(h);
}

const PRIO_MAP: Record<string, Priority> = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
};
const PRIO_MAP_REV: Record<Priority, string> = {
  low: 'LOW',
  normal: 'NORMAL',
  high: 'HIGH',
  urgent: 'URGENT',
};

/** Lundi 00:00 UTC de la semaine en cours. */
export function thisMondayUTC(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // 0=dimanche ; on veut lundi=0
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

function daysFromMonday(iso: string | null, monday: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - monday.getTime();
  return Math.round(ms / 86_400_000);
}

// ---------- Convertisseurs DTO -> Vaks ---------------------------

export function toVaksUser(u: Partial<UserDto> & { id: string; email?: string }): VUser {
  const name = u.name ?? u.email ?? u.id;
  return {
    id: u.id,
    name,
    short: shortNameOf(name),
    initials: initialsOf(name),
    role: u.kind === 'AGENT' ? 'Agent' : 'Membre',
    hue: hueFromId(u.id),
    online: true,
    countryCode: u.countryCode ?? null,
    kind: u.kind,
  };
}

export function toVaksProject(p: ProjectDto): VProject {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    // Dérivé du key (texte affiché sur la pastille) pour rester identique
    // au logo rendu par ProjectsPanel.
    color: hueFromProjectKey(p.key),
    active: p.status === 'ACTIVE',
    status: p.status,
    agentsEnabled: p.agentsEnabled ?? false,
  };
}

export function toVaksLabel(l: LabelDto): VLabel {
  return { id: l.id, name: l.name, hue: hueFromHex(l.color) };
}

export function toVaksColumn(c: BoardColumnDto): Column {
  return {
    id: c.id,
    name: c.name,
    // Fallback 'todo' si un statut inconnu apparaît (nouveau statut backend non
    // encore mappé) → la tâche reste visible sur le board au lieu de disparaître
    // silencieusement (audit frontend 2026-08-02 ; cf. piège status maps).
    status: statusColKey(c.status),
    wip: c.wipLimit,
  };
}

/**
 * `projectKey` est le trigramme du projet (`Project.key` côté API). Si
 * fourni et que la tâche a un `number > 0` (post-backfill), on affiche
 * `KEY-N` à la Jira. Sinon on retombe sur les 8 premiers chars de l'UUID
 * (tâches historiques avant migration).
 */
export function toVaksTask(t: TaskDto, monday: Date, projectKey?: string): VTask {
  const num = t.number ?? 0;
  const readableKey =
    projectKey && num > 0
      ? `${projectKey}-${num}`
      : t.id.slice(0, 8).toUpperCase();
  return {
    id: t.id,
    number: num,
    projectId: t.projectId,
    col: t.boardColumnId ?? '',
    status: t.status,
    title: t.title,
    key: readableKey,
    assignees: t.assignees.map((a) => a.userId),
    labels: t.labels.map((l) => l.id),
    priority: PRIO_MAP[t.priority] ?? 'normal',
    due: daysFromMonday(t.dueDate, monday),
    start: daysFromMonday(t.startDate, monday),
    estimate: t.estimateHours,
    progress: t.progressPct,
    comments: t.commentCount ?? 0,
    attachments: t.attachmentCount ?? 0,
    subtasks: null,
    desc: t.description ?? '',
    parentTaskId: t.parentTaskId,
    isMilestone: t.isMilestone,
    isBug: t.isBug,
    isGroup: t.isGroup,
    color: t.color,
    requiredSkillId: t.requiredSkillId ?? null,
    requiredSkillLevel: t.requiredSkillLevel ?? null,
    subStatusId: t.subStatusId ?? null,
    holdReason: t.holdReason ?? null,
    externalDependency: t.externalDependency ?? null,
    externalBlocked: t.externalBlocked ?? false,
  };
}

function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  // Fallback >7j : on délègue à la locale du navigateur (cette fonction est
  // appelée depuis des transforms purs, hors React ; pas d'accès direct au
  // setting org). Pour un format pleinement piloté par `orgSettings.locale`,
  // utiliser `useFormat()` côté composant.
  return new Date(iso).toLocaleDateString();
}

export function toVaksComment(c: CommentDto): VComment {
  return {
    id: c.id,
    user: c.author.id,
    userName: c.author.name,
    at: relativeTime(c.createdAt),
    body: c.body,
  };
}

export function toVaksTimeEntry(e: TimeEntryDto, monday: Date): VTimeEntry {
  return {
    id: e.id,
    user: e.userId,
    day: daysFromMonday(e.date, monday) ?? 0,
    hours: e.durationMinutes / 60,
    note: e.description ?? '',
  };
}

// ---------- Chargement initial -----------------------------------

export interface LoadResult {
  monday: Date;
  /** `null` when the user has no projects yet (empty workspace). */
  projectId: string | null;
  boardColumnsApi?: BoardColumnDto[];
  apiTasks?: TaskDto[];
}

/**
 * Charge la totalité des données nécessaires aux vues depuis l'API,
 * remplit data.ts via setVaksData, et retourne quelques refs utiles
 * (monday, projectId courant) pour les mutations ultérieures.
 *
 * On charge :
 *  - le user courant (currentUser)
 *  - les users de l'org (members of first project — pour Phase 2 on prend admin only,
 *    une vraie API "list org users" arrivera plus tard)
 *  - les projects
 *  - le board (colonnes) du premier projet actif
 *  - les labels du projet
 *  - les tasks du projet
 *  - les commentaires de chaque tâche (best-effort, parallèle)
 *  - les time entries du projet (this week + last week)
 */
/**
 * Cache léger en module pour les données indépendantes du projet
 * (me, liste projects, annuaire users). Permet à un switch de projet
 * d'éviter 3 RTT inutiles. Rafraîchi au prochain mount complet.
 */
let cachedMe: Awaited<ReturnType<typeof api.me>> | null = null;
let cachedProjectsApi: Awaited<ReturnType<typeof api.listProjects>> | null = null;
let cachedOrgUsers: Awaited<ReturnType<typeof api.listUsers>> | null = null;

/** Invalide le cache (à appeler après login/logout ou refresh complet). */
export function clearVaksApiCache(): void {
  cachedMe = null;
  cachedProjectsApi = null;
  cachedOrgUsers = null;
  projectSnapshots.clear();
}

/** Invalide le snapshot d'un projet (à appeler après une mutation structurelle). */
export function invalidateProjectSnapshot(projectId: string): void {
  projectSnapshots.delete(projectId);
}

/**
 * Si un snapshot existe pour ce projet, l'applique au store global et
 * retourne un LoadResult prêt à l'emploi (affichage instantané).
 * Le caller relancera ensuite `loadVaksFromApi` en tâche de fond pour
 * rafraîchir les données (stale-while-revalidate).
 */
export function tryApplyProjectSnapshot(projectId: string): LoadResult | null {
  const snap = projectSnapshots.get(projectId);
  if (!snap) return null;
  setVaksData({
    columns: snap.columns,
    labels: snap.labels,
    tasks: snap.tasks,
    comments: {},
    timeEntries: snap.timeEntries,
    availableAssigneeIds: snap.availableAssigneeIds,
  });
  return {
    monday: snap.monday,
    projectId: snap.projectId,
    boardColumnsApi: snap.boardColumnsApi,
    apiTasks: snap.apiTasks,
  };
}

export async function loadVaksFromApi(
  preferredProjectId?: string | null,
  opts: { skipGlobal?: boolean } = {},
): Promise<LoadResult> {
  const monday = thisMondayUTC();

  // 1) Données globales (indépendantes du projet) — cache + skip possible.
  let me = cachedMe;
  let projectsApi = cachedProjectsApi;
  if (!opts.skipGlobal || !me || !projectsApi) {
    [me, projectsApi] = await Promise.all([api.me(), api.listProjects()]);
    cachedMe = me;
    cachedProjectsApi = projectsApi;
  }

  if (projectsApi.length === 0) {
    setVaksData({
      users: [toVaksUser(me)],
      projects: [],
      columns: [],
      labels: {},
      tasks: [],
      comments: {},
      timeEntries: {},
      currentUser: me.id,
      availableAssigneeIds: null,
    });
    return { monday, projectId: null };
  }

  // Préférence explicite (sélection user) > premier ACTIVE > premier tout court.
  const preferred = preferredProjectId
    ? projectsApi.find((p) => p.id === preferredProjectId)
    : undefined;
  const proj =
    preferred ?? projectsApi.find((p) => p.status === 'ACTIVE') ?? projectsApi[0];

  const [boardApi, labelsApi, tasksApi, projectTeamsApi, projectMembersApi] = await Promise.all([
    api.getBoard(proj.id),
    api.listLabels(proj.id),
    api.listTasks(proj.id),
    api.listProjectTeams(proj.id).catch(() => []),
    api.listProjectMembers(proj.id).catch(() => []),
  ]);

  // Liste blanche des assignees autorisés sur ce projet.
  const allowedSet = new Set<string>();
  for (const pt of projectTeamsApi) {
    for (const m of pt.team.members) allowedSet.add(m.userId);
  }
  for (const pm of projectMembersApi) allowedSet.add(pm.userId);
  const availableAssigneeIds: string[] | null =
    allowedSet.size === 0 ? null : Array.from(allowedSet);

  // Time entries du projet, semaine en cours
  const fromIso = monday.toISOString().slice(0, 10);
  const to = new Date(monday);
  to.setUTCDate(to.getUTCDate() + 6);
  const toIso = to.toISOString().slice(0, 10);
  const allEntries = await api.listTimeEntries({ projectId: proj.id, from: fromIso, to: toIso });
  const entriesByTask: Record<string, VTimeEntry[]> = {};
  for (const e of allEntries) {
    const v = toVaksTimeEntry(e, monday);
    (entriesByTask[e.taskId] ??= []).push(v);
  }

  // Users : annuaire complet de l'org, AGENTS INCLUS — c'est la map
  // d'AFFICHAGE (auteurs de commentaires, avatars, libellés). Les pickers
  // d'assignation filtrent `kind==='AGENT'` de leur côté.
  let orgUsers = cachedOrgUsers;
  if (!opts.skipGlobal || !orgUsers) {
    try {
      orgUsers = await api.listUsers({ includeAgents: true });
      cachedOrgUsers = orgUsers;
    } catch {
      orgUsers = orgUsers ?? [];
    }
  }
  const userMap = new Map<string, VUser>();
  for (const u of orgUsers) userMap.set(u.id, toVaksUser(u));
  if (!userMap.has(me.id)) userMap.set(me.id, toVaksUser(me));
  // Filet de sécurité : complète avec les assignees vus dans les tâches.
  for (const t of tasksApi) {
    for (const a of t.assignees) {
      if (!userMap.has(a.userId)) {
        userMap.set(a.userId, toVaksUser({ id: a.userId, name: a.name, email: a.email, isAdmin: false, timezone: 'UTC' }));
      }
    }
  }

  // Labels en map id->VLabel
  const labelsMap: Record<string, VLabel> = {};
  for (const l of labelsApi) labelsMap[l.id] = toVaksLabel(l);

  // Map projectId → key, pour composer l'identifiant lisible KEY-N sur chaque tâche.
  const projectKeyById = new Map<string, string>();
  for (const p of projectsApi) projectKeyById.set(p.id, p.key);

  // Comments : plus de pré-chargement. TaskDetail fetch à la demande.
  // Les compteurs (badges Kanban) viennent de t.commentCount côté API.
  const columns = boardApi.columns.sort((a, b) => a.order - b.order).map(toVaksColumn);
  const tasks = tasksApi.map((t) => toVaksTask(t, monday, projectKeyById.get(t.projectId)));
  setVaksData({
    users: [...userMap.values()],
    projects: projectsApi.map(toVaksProject),
    columns,
    labels: labelsMap,
    tasks,
    comments: {},
    timeEntries: entriesByTask,
    currentUser: me.id,
    availableAssigneeIds,
  });

  // SWR : on persiste le snapshot pour qu'un retour ultérieur sur ce projet
  // soit instantané (puis rafraîchi en arrière-plan).
  projectSnapshots.set(proj.id, {
    monday,
    projectId: proj.id,
    columns,
    labels: labelsMap,
    tasks,
    timeEntries: entriesByTask,
    availableAssigneeIds,
    boardColumnsApi: boardApi.columns,
    apiTasks: tasksApi,
  });

  return { monday, projectId: proj.id, boardColumnsApi: boardApi.columns, apiTasks: tasksApi };
}

/**
 * Re-calcule la liste blanche des assignees autorisés (union des membres
 * des équipes assignées + ProjectMember directs) et la patch dans le
 * store global. À appeler après toute mutation côté UI qui modifie la
 * composition projet ↔ équipes ↔ membres, sinon TaskDetail continue
 * d'afficher l'ancienne liste tant qu'on ne change pas de projet ou de F5.
 */
export async function refreshProjectAssignees(projectId: string): Promise<void> {
  const [projectTeamsApi, projectMembersApi] = await Promise.all([
    api.listProjectTeams(projectId).catch(() => []),
    api.listProjectMembers(projectId).catch(() => []),
  ]);
  const allowed = new Set<string>();
  for (const pt of projectTeamsApi) {
    for (const m of pt.team.members) allowed.add(m.userId);
  }
  for (const pm of projectMembersApi) allowed.add(pm.userId);
  setVaksData({
    availableAssigneeIds: allowed.size === 0 ? null : Array.from(allowed),
  });
}

// ---------- Mutations (renvoient déjà du Vaks) -------------------

export async function apiCreateTask(
  projectId: string,
  payload: {
    title: string;
    columnId?: string;
    priority?: Priority;
    estimateHours?: number;
    due?: number | null;
    monday: Date;
    isGroup?: boolean;
    isMilestone?: boolean;
  },
): Promise<VTask> {
  const dto: ApiCreateTaskDto = {
    title: payload.title,
    boardColumnId: payload.columnId,
    priority: (PRIO_MAP_REV[payload.priority ?? 'normal'] as ApiCreateTaskDto['priority']),
    estimateHours: payload.estimateHours,
    dueDate:
      payload.due !== undefined && payload.due !== null
        ? new Date(payload.monday.getTime() + payload.due * 86_400_000).toISOString()
        : undefined,
    isGroup: payload.isGroup,
    isMilestone: payload.isMilestone,
  };
  const created = await api.createTask(projectId, dto);
  return toVaksTask(created, payload.monday, projectKeyOf(created.projectId));
}

export async function apiPatchTask(
  taskId: string,
  patch: Partial<VTask>,
  monday: Date,
): Promise<VTask> {
  const dto: ApiUpdateTaskDto = {};
  if (patch.title !== undefined) dto.title = patch.title;
  if (patch.desc !== undefined) dto.description = patch.desc;
  if (patch.priority !== undefined) dto.priority = PRIO_MAP_REV[patch.priority] as ApiUpdateTaskDto['priority'];
  if (patch.estimate !== undefined) dto.estimateHours = patch.estimate;
  if (patch.progress !== undefined) dto.progressPct = patch.progress;
  if (patch.due !== undefined) {
    dto.dueDate =
      patch.due === null
        ? null
        : new Date(monday.getTime() + patch.due * 86_400_000).toISOString();
  }
  if (patch.start !== undefined) {
    dto.startDate =
      patch.start === null
        ? null
        : new Date(monday.getTime() + patch.start * 86_400_000).toISOString();
  }
  if (patch.assignees !== undefined) dto.assigneeIds = patch.assignees;
  if (patch.labels !== undefined) dto.labelIds = patch.labels;
  if (patch.parentTaskId !== undefined) dto.parentTaskId = patch.parentTaskId;
  if (patch.isMilestone !== undefined) dto.isMilestone = patch.isMilestone;
  if (patch.isBug !== undefined) dto.isBug = patch.isBug;
  if (patch.isGroup !== undefined) dto.isGroup = patch.isGroup;
  if (patch.color !== undefined) dto.color = patch.color;
  if (patch.requiredSkillId !== undefined) dto.requiredSkillId = patch.requiredSkillId;
  if (patch.requiredSkillLevel !== undefined) dto.requiredSkillLevel = patch.requiredSkillLevel;
  if (patch.externalDependency !== undefined) dto.externalDependency = patch.externalDependency;
  if (patch.externalBlocked !== undefined) dto.externalBlocked = patch.externalBlocked;
  // Raison de mise en pause (édition/effacement) : portée par `statusReason`.
  if (patch.holdReason !== undefined) dto.statusReason = patch.holdReason;
  // Sous-statut : non-null → le serveur force `status` au parent ; null → efface.
  if (patch.subStatusId !== undefined) dto.subStatusId = patch.subStatusId;
  const updated = await api.updateTask(taskId, dto);
  return toVaksTask(updated, monday, projectKeyOf(updated.projectId));
}

export async function apiMoveTask(
  taskId: string,
  columnId: string,
  monday: Date,
  beforeTaskId?: string,
  afterTaskId?: string,
  opts?: { completePredecessors?: boolean; subStatusId?: string | null },
): Promise<VTask> {
  const updated = await api.moveTask(taskId, {
    boardColumnId: columnId,
    // undefined = intouché ; null = zone principale ; id = container ciblé.
    subStatusId: opts?.subStatusId,
    beforeTaskId,
    afterTaskId,
    completePredecessors: opts?.completePredecessors,
  });
  return toVaksTask(updated, monday, projectKeyOf(updated.projectId));
}

/** Sous-statuts applicables au projet, mappés vers le vocabulaire colonne du
 *  board (`BoardSubStatus.status` ∈ 'todo'|'progress'|'review'|'hold'|'done'). */
export async function apiLoadSubStatuses(projectId: string): Promise<BoardSubStatus[]> {
  const list = await api.listCustomStatuses(projectId);
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    status: statusColKey(s.parentStatus as TaskStatus),
  }));
}

// ---------- Board inter-projet « Mes tâches » --------------------

export interface MyTasksData {
  tasks: VTask[];
  projects: { id: string; key: string; name: string }[];
  /** Nom de projet indexé par id (badge sur les cartes). */
  projectName: Record<string, string>;
  /** projectId → (statut canonique → boardColumnId), pour mapper un drop de
   *  colonne vers la colonne réelle du board du projet (réutilise `move()`).
   *  Si un projet n'a pas de colonne pour un statut donné, l'entrée est absente
   *  → le drop est refusé côté UI. */
  statusColumn: Record<string, Partial<Record<TaskStatus, string>>>;
  /** Statut canonique courant de chaque tâche (clé de regroupement). */
  statusOf: Record<string, TaskStatus>;
}

/**
 * Charge le board inter-projet « Mes tâches » : toutes les tâches assignées à
 * l'utilisateur courant sur ses projets ACTIVE. Construit la table de mapping
 * statut → colonne par projet (pour le drag-drop) en privilégiant, quand un
 * statut apparaît sur plusieurs colonnes, celle d'`order` le plus bas.
 */
export async function apiLoadMyTasks(monday: Date): Promise<MyTasksData> {
  const data = await api.myTasks();
  const projectName: Record<string, string> = {};
  const keyById: Record<string, string> = {};
  for (const p of data.projects) {
    projectName[p.id] = p.name;
    keyById[p.id] = p.key;
  }

  const statusColumn: Record<string, Partial<Record<TaskStatus, string>>> = {};
  for (const [pid, cols] of Object.entries(data.columns)) {
    const byStatus: Partial<Record<TaskStatus, string>> = {};
    for (const c of [...cols].sort((a, b) => a.order - b.order)) {
      if (byStatus[c.status] === undefined) byStatus[c.status] = c.id;
    }
    statusColumn[pid] = byStatus;
  }

  const statusOf: Record<string, TaskStatus> = {};
  for (const t of data.tasks) statusOf[t.id] = t.status;

  return {
    tasks: data.tasks.map((t) => toVaksTask(t, monday, keyById[t.projectId])),
    projects: data.projects,
    projectName,
    statusColumn,
    statusOf,
  };
}

export async function apiDeleteTask(taskId: string): Promise<void> {
  await api.deleteTask(taskId);
}

// ---- Watchers (abonnement passif) : pas d'adaptation, les DTO servent tels quels ----

export async function apiListTaskWatchers(taskId: string): Promise<WatcherDto[]> {
  return api.listTaskWatchers(taskId);
}

export async function apiWatchTask(taskId: string): Promise<void> {
  await api.watchTask(taskId);
}

export async function apiUnwatchTask(taskId: string): Promise<void> {
  await api.unwatchTask(taskId);
}

export async function apiListMyWatching(): Promise<WatchingEntryDto[]> {
  return api.listMyWatching();
}

// ---- Récurrence de tâche (DTO utilisés tels quels) ----

export async function apiGetRecurrence(taskId: string): Promise<RecurringTaskDto | null> {
  return api.getRecurrence(taskId);
}

export async function apiUpsertRecurrence(
  taskId: string,
  dto: UpsertRecurrenceDto,
): Promise<RecurringTaskDto> {
  return api.upsertRecurrence(taskId, dto);
}

export async function apiDeleteRecurrence(taskId: string): Promise<void> {
  await api.deleteRecurrence(taskId);
}

// ---- Valeurs de champs personnalisés (DTO utilisés tels quels) ----

export async function apiGetTaskCustomFields(taskId: string): Promise<CustomFieldValueDto[]> {
  return api.getTaskCustomFields(taskId);
}

export async function apiSetTaskCustomFields(
  taskId: string,
  values: Array<{ fieldId: string; value: string }>,
): Promise<CustomFieldValueDto[]> {
  return api.setTaskCustomFields(taskId, { values });
}

export async function apiGetProjectCustomFields(projectId: string): Promise<CustomFieldValueDto[]> {
  return api.getProjectCustomFields(projectId);
}

export async function apiSetProjectCustomFields(
  projectId: string,
  values: Array<{ fieldId: string; value: string }>,
): Promise<CustomFieldValueDto[]> {
  return api.setProjectCustomFields(projectId, { values });
}

export async function apiListProjectWatchers(projectId: string): Promise<WatcherDto[]> {
  return api.listProjectWatchers(projectId);
}

export async function apiWatchProject(projectId: string): Promise<void> {
  await api.watchProject(projectId);
}

export async function apiUnwatchProject(projectId: string): Promise<void> {
  await api.unwatchProject(projectId);
}

export async function apiAddComment(taskId: string, body: string): Promise<VComment> {
  const c = await api.createComment(taskId, { body });
  return toVaksComment(c);
}

export async function apiAddTimeEntry(
  taskId: string,
  payload: { hours: number; note?: string; date: string },
  monday: Date,
): Promise<VTimeEntry> {
  const e = await api.createTimeEntry({
    taskId,
    date: payload.date,
    durationMinutes: Math.round(payload.hours * 60),
    description: payload.note,
  });
  return toVaksTimeEntry(e, monday);
}

export async function apiCreateLabel(projectId: string, dto: CreateLabelDto): Promise<VLabel> {
  const l = await api.createLabel(projectId, dto);
  return toVaksLabel(l);
}

// ---------- Fetch helpers (modules pas encore exposés dans client.ts) --

// ---------- Reports & Attachments — thin wrappers around client.ts ----

export const apiProjectStats = (projectId: string): Promise<ProjectStatsDto> =>
  api.projectStats(projectId);
export const apiBurndown = (projectId: string, from: string, to: string): Promise<BurndownReportDto> =>
  api.burndown(projectId, from, to);
export const apiDueAdherence = (projectId: string): Promise<DueAdherenceDto> =>
  api.dueAdherence(projectId);
export const apiProjectByTeam = (projectId: string): Promise<ProjectByTeamDto> =>
  api.projectByTeam(projectId);
export const apiTimeBreakdown = (params: {
  projectId?: string;
  userId?: string;
  from?: string;
  to?: string;
}): Promise<TimeBreakdownDto> => api.timeBreakdown(params);
export const apiTasksInWindow = (projectId: string, from: string, to: string): Promise<TasksInWindowReportDto> =>
  api.tasksInWindow(projectId, from, to);
export const apiGetTimesheet = (q: { from: string; to: string; userId?: string }): Promise<TimesheetDto> =>
  api.getTimesheet(q);

/** Dashboard personnel (agrégat d'accueil : tâches, stats, activité équipe). */
export const apiGetDashboard = (): Promise<DashboardDto> => api.dashboard();

export const apiListAttachments = (taskId: string): Promise<AttachmentDto[]> =>
  api.listAttachments(taskId);
export const apiUploadAttachment = (taskId: string, file: File): Promise<AttachmentDto> =>
  api.uploadAttachment(taskId, file);
export const apiDeleteAttachment = (id: string) => api.deleteAttachment(id);
export const apiDownloadAttachment = (att: AttachmentDto): Promise<void> =>
  api.downloadAttachment(att);

// ---- deliverables (chantier 2c) ----
export const apiListDeliverables = (taskId: string): Promise<DeliverableDto[]> =>
  api.listDeliverables(taskId);
export const apiSubmitDeliverable = (
  taskId: string,
  dto: CreateDeliverableDto,
): Promise<DeliverableDto> => api.submitDeliverable(taskId, dto);
export const apiSubmitForReview = (taskId: string): Promise<TaskDto> =>
  api.submitTaskForReview(taskId);
export const apiReviewDeliverable = (
  taskId: string,
  deliverableId: string,
  dto: ReviewDeliverableDto,
): Promise<{ deliverable: DeliverableDto; task: TaskDto }> =>
  api.reviewDeliverable(taskId, deliverableId, dto);
/** Télécharge la PJ S3 d'un livrable (réutilise le download d'attachment). */
export const apiDownloadDeliverable = (attachmentId: string, filename: string): Promise<void> =>
  apiDownloadAttachment({ id: attachmentId, filename } as unknown as AttachmentDto);

// ---- contexte de travail (chantier 2c.2) ----
/** Remplace la liste des critères d'acceptation d'une tâche. */
export const apiSetAcceptanceCriteria = (
  taskId: string,
  acceptanceCriteria: AcceptanceCriterion[],
): Promise<TaskDto> => api.updateTask(taskId, { acceptanceCriteria });
/** Pose/efface l'enveloppe de coût agent (€) d'une tâche (finance agents). */
export const apiSetTaskAgentBudget = (
  taskId: string,
  agentCostBudget: number | null,
): Promise<TaskDto> => api.updateTask(taskId, { agentCostBudget });
