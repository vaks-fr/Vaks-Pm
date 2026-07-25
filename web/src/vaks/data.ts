/* ============================================================
   Vaks — runtime data store
   No seed content: the app starts empty and is populated by
   user actions (and later by API calls via setVaksData()).
   Only structural defaults (kanban columns, label palette) are
   pre-defined so the UI has scaffolding to render.
   ============================================================ */

export interface User {
  id: string;
  name: string;
  short: string;
  initials: string;
  role: string;
  hue: number;
  online: boolean;
  /** ISO 3166-1 alpha-2 ; null = hérite du défaut org. */
  countryCode?: string | null;
  /** 'AGENT' pour un agent IA — présent dans la map d'AFFICHAGE (auteurs de
   *  commentaires, avatars…) mais exclu des pickers d'assignation. */
  kind?: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  color: number;
  active?: boolean;
  /** Statut métier brut (DRAFT/CHARTER_REVIEW/ACTIVE/…) pour les gardes UI. */
  status?: string;
  /** True si le projet autorise les agents IA (Project.agentsEnabled). Gate
   *  l'affichage des sections agent (livrables, critères d'acceptation, budget IA). */
  agentsEnabled?: boolean;
}

export interface Label {
  id: string;
  name: string;
  hue: number;
}

export interface Column {
  id: string;
  name: string;
  status: string;
  wip: number | null;
}

/** Sous-statut (Custom Status) prêt pour le board : `status` est déjà mappé
 *  vers le vocabulaire colonne ('todo'|'progress'|'review'|'hold'|'done'…). */
export interface BoardSubStatus {
  id: string;
  name: string;
  color: string | null;
  status: string;
}

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  col: string;
  title: string;
  /** Numéro séquentiel par projet (1, 2, ...). Source de vérité côté API. */
  number?: number;
  /** Id projet auquel la tâche appartient — nécessaire pour résoudre `proj.key`. */
  projectId?: string;
  /** Identifiant affichable, ex. `LIFE-12`. Composé à partir de `projectId` + `number`. */
  key?: string;
  assignees: string[];
  labels: string[];
  priority: Priority;
  due: number | null;
  start: number | null;
  estimate: number | null;
  progress: number;
  comments: number;
  attachments: number;
  subtasks: { done: number; total: number } | null;
  desc: string;
  parentTaskId?: string | null;
  isMilestone?: boolean;
  isBug?: boolean;
  isGroup?: boolean;
  /** Hex color (#rrggbb) on a group; null on a regular task. Inherited at render time. */
  color?: string | null;
  /** Skill principal requis pour la tâche (uuid, ou null). Pilote le tri des
   *  suggestions d'assignees et le bonus de score de l'autoplan. */
  requiredSkillId?: string | null;
  /** Niveau souhaité sur le skill requis (1..org.skills.maxLevel). */
  requiredSkillLevel?: number | null;
  /** Sous-statut (Custom Status) porté par la tâche. null = statut seul.
   *  Rendu board : container dans la colonne parente ; ignoré si le sous-statut
   *  n'existe plus ou n'appartient pas au statut courant (fallback). */
  subStatusId?: string | null;
  /** Raison courante de mise en pause (status ON_HOLD). null sinon. */
  holdReason?: string | null;
  /** Dépendance prestataire externe (note libre). null/vide = aucune. */
  externalDependency?: string | null;
  /** true = tâche bloquée par sa dépendance externe. */
  externalBlocked?: boolean;
  checklist?: ChecklistItem[];
}

export interface Comment {
  id: string;
  user: string;
  at: string;
  body: string;
  /** Nom de l'auteur snapshoté depuis l'API — fallback d'affichage quand
   *  l'auteur n'est pas (plus) dans l'annuaire (compte supprimé, agent…). */
  userName?: string;
}

export interface TimeEntry {
  id: string;
  user: string;
  day: number;
  hours: number;
  note: string;
}

export interface TimeOff {
  user: string;
  day: number;
  type: string;
}

export interface AllocPart {
  task: string;
  h: number;
}

// ---- Users ----------------------------------------------------
export let users: User[] = [];
export let userById: Record<string, User> = {};

// ---- Work schedules (contracted hours / weekday, Mon..Fri) ----
export const schedules: Record<string, number[]> = {};

// ---- Time off (this week) ----
export const timeOff: TimeOff[] = [];

// ---- Projects ----
export let projects: Project[] = [];

// ---- Labels (default palette; projects can override later) ----
export let labels: Record<string, Label> = {
  design: { id: 'design', name: 'Design', hue: 280 },
  frontend: { id: 'frontend', name: 'Frontend', hue: 215 },
  backend: { id: 'backend', name: 'Backend', hue: 155 },
  bug: { id: 'bug', name: 'Bug', hue: 25 },
  research: { id: 'research', name: 'Research', hue: 60 },
  a11y: { id: 'a11y', name: 'A11y', hue: 330 },
};

// ---- Columns (Kanban defaults) ----
export let columns: Column[] = [
  { id: 'c_backlog', name: 'Backlog', status: 'backlog', wip: null },
  { id: 'c_todo', name: 'To Do', status: 'todo', wip: 5 },
  { id: 'c_prog', name: 'In Progress', status: 'progress', wip: 3 },
  { id: 'c_review', name: 'In Review', status: 'review', wip: 3 },
  { id: 'c_done', name: 'Done', status: 'done', wip: null },
];

// ---- Tasks ----
export let tasks: Task[] = [];

// ---- Allocations (workload) ----
export const allocations: Record<string, number[]> = {};
export const allocTasks: Record<string, AllocPart[]> = {};

// ---- Comments / time entries ----
export let comments: Record<string, Comment[]> = {};
export let timeEntries: Record<string, TimeEntry[]> = {};

// signed-in user id — set at runtime via setVaksData() after login
export let currentUser = '';

/**
 * Ensemble des userIds assignables aux tâches du projet courant.
 * Union (membres des équipes assignées) ∪ (ProjectMember directs).
 * `null` ⇒ pas de restriction (fallback annuaire complet, p.ex. au boot).
 */
export let availableAssigneeIds: Set<string> | null = null;

// ---- helpers ----
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekDates(monday: Date): Date[] {
  return WEEKDAYS.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export const VAKS = {
  users, userById, schedules, timeOff, projects, labels, columns, tasks,
  allocations, allocTasks, comments, timeEntries, currentUser,
  WEEKDAYS, MONTHS, weekDates,
};

/**
 * Remplace les données au démarrage de l'app (après login) par les
 * données réelles chargées depuis l'API. Les exports étant des
 * `export let`, les importateurs voient les nouvelles valeurs grâce
 * aux ESM live bindings.
 */
export interface VaksDataPatch {
  users?: User[];
  projects?: Project[];
  labels?: Record<string, Label>;
  columns?: Column[];
  tasks?: Task[];
  comments?: Record<string, Comment[]>;
  timeEntries?: Record<string, TimeEntry[]>;
  currentUser?: string;
  /** `null` désactive la restriction, sinon liste blanche des assignees. */
  availableAssigneeIds?: string[] | null;
}

export function setVaksData(patch: VaksDataPatch): void {
  if (patch.users) {
    users = patch.users;
    userById = Object.fromEntries(users.map((u) => [u.id, u]));
  }
  if (patch.projects) projects = patch.projects;
  if (patch.labels) labels = patch.labels;
  if (patch.columns) columns = patch.columns;
  if (patch.tasks) tasks = patch.tasks;
  if (patch.comments) comments = patch.comments;
  if (patch.timeEntries) timeEntries = patch.timeEntries;
  if (patch.currentUser) currentUser = patch.currentUser;
  if (patch.availableAssigneeIds !== undefined) {
    availableAssigneeIds =
      patch.availableAssigneeIds === null ? null : new Set(patch.availableAssigneeIds);
  }
}
