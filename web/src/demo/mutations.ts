/* ============================================================
   Vaks — Démo statique : mutations CRUD (mutent le store + persist()).
   ----------------------------------------------------------------
   Chaque handler renvoie le DTO attendu par l'UI (souvent l'entité modifiée),
   comme le vrai backend. Les vues appliquent déjà des updates optimistes ;
   ces handlers rendent la mutation DURABLE (localStorage) et cohérente au
   rechargement.
   ============================================================ */
import {
  TaskStatus,
  TaskPriority,
  type TaskDto,
  type LabelDto,
  type CommentDto,
  type TimeEntryDto,
  type BoardColumnDto,
} from '@vaks-pm/shared';
import { getState, persist, nextId, currentUser } from './store';
import { DemoHttpError } from './routes-shared';

/* ---------- Helpers ---------- */
function iso(): string {
  return new Date().toISOString();
}
function findTask(id: string): TaskDto {
  const t = getState().tasks.find((x) => x.id === id);
  if (!t) throw new DemoHttpError(404, 'Tâche introuvable');
  return t;
}
function projectColumns(projectId: string): BoardColumnDto[] {
  const b = getState().boards.find((x) => x.projectId === projectId);
  return b?.columns ?? [];
}
function columnById(projectId: string, colId: string): BoardColumnDto | undefined {
  return projectColumns(projectId).find((c) => c.id === colId);
}
function columnForStatus(projectId: string, status: TaskStatus): BoardColumnDto | undefined {
  return projectColumns(projectId).find((c) => c.status === status);
}
function assigneesFromIds(ids: string[]): TaskDto['assignees'] {
  const users = getState().users;
  return ids
    .map((id) => users.find((u) => u.id === id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => ({ userId: u.id, name: u.name, email: u.email, countryCode: u.countryCode ?? null }));
}
function labelsFromIds(projectId: string, ids: string[]): TaskDto['labels'] {
  const all = getState().labels.filter((l) => l.projectId === projectId);
  return ids
    .map((id) => all.find((l) => l.id === id))
    .filter((l): l is LabelDto => !!l)
    .map((l) => ({ id: l.id, name: l.name, color: l.color }));
}
function refreshTaskCounts(projectId: string): void {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  if (!p) return;
  const own = s.tasks.filter((t) => t.projectId === projectId);
  p.taskCounts = { total: own.length, done: own.filter((t) => t.status === TaskStatus.DONE).length };
}

/* ---------- Tasks ---------- */
export function createTask(projectId: string, dto: Record<string, unknown>): TaskDto {
  const s = getState();
  if (!s.projects.some((p) => p.id === projectId)) throw new DemoHttpError(404, 'Projet introuvable');
  const cols = projectColumns(projectId);
  const status = (dto.status as TaskStatus) ?? TaskStatus.TODO;
  const col =
    (dto.boardColumnId ? columnById(projectId, dto.boardColumnId as string) : undefined) ??
    columnForStatus(projectId, status) ??
    cols[0];
  const maxNum = s.tasks.filter((t) => t.projectId === projectId).reduce((n, t) => Math.max(n, t.number), 0);
  const maxPos = s.tasks
    .filter((t) => t.boardColumnId === col?.id)
    .reduce((n, t) => Math.max(n, t.position), 0);
  const now = iso();
  const task: TaskDto = {
    id: nextId('task'),
    number: maxNum + 1,
    projectId,
    parentTaskId: (dto.parentTaskId as string) ?? null,
    boardColumnId: col?.id ?? null,
    title: (dto.title as string) ?? 'Nouvelle tâche',
    description: (dto.description as string) ?? null,
    status: col?.status ?? status,
    subStatusId: null,
    holdReason: null,
    priority: (dto.priority as TaskPriority) ?? TaskPriority.NORMAL,
    position: maxPos + 1000,
    estimateHours: (dto.estimateHours as number) ?? null,
    dueDate: (dto.dueDate as string) ?? null,
    startDate: (dto.startDate as string) ?? null,
    endDate: null,
    progressPct: 0,
    isMilestone: !!dto.isMilestone,
    isBug: !!dto.isBug,
    isGroup: !!dto.isGroup,
    color: (dto.color as string) ?? null,
    requiredSkillId: (dto.requiredSkillId as string) ?? null,
    requiredSkillLevel: (dto.requiredSkillLevel as number) ?? null,
    createdById: currentUser().id,
    createdAt: now,
    updatedAt: now,
    assignees: assigneesFromIds((dto.assigneeIds as string[]) ?? []),
    labels: labelsFromIds(projectId, (dto.labelIds as string[]) ?? []),
    externalDependency: null,
    externalBlocked: false,
    commentCount: 0,
    attachmentCount: 0,
  };
  s.tasks.push(task);
  refreshTaskCounts(projectId);
  persist();
  return task;
}

export function updateTask(taskId: string, dto: Record<string, unknown>): TaskDto {
  const t = findTask(taskId);
  if (dto.title !== undefined) t.title = dto.title as string;
  if (dto.description !== undefined) t.description = (dto.description as string) ?? null;
  if (dto.priority !== undefined) t.priority = dto.priority as TaskPriority;
  if (dto.estimateHours !== undefined) t.estimateHours = (dto.estimateHours as number) ?? null;
  if (dto.dueDate !== undefined) t.dueDate = (dto.dueDate as string) ?? null;
  if (dto.startDate !== undefined) t.startDate = (dto.startDate as string) ?? null;
  if (dto.endDate !== undefined) t.endDate = (dto.endDate as string) ?? null;
  if (dto.progressPct !== undefined) t.progressPct = dto.progressPct as number;
  if (dto.isMilestone !== undefined) t.isMilestone = !!dto.isMilestone;
  if (dto.isBug !== undefined) t.isBug = !!dto.isBug;
  if (dto.color !== undefined) t.color = (dto.color as string) ?? null;
  if (dto.assigneeIds !== undefined) t.assignees = assigneesFromIds(dto.assigneeIds as string[]);
  if (dto.labelIds !== undefined) t.labels = labelsFromIds(t.projectId, dto.labelIds as string[]);
  if (dto.requiredSkillId !== undefined) t.requiredSkillId = (dto.requiredSkillId as string) ?? null;
  if (dto.requiredSkillLevel !== undefined) t.requiredSkillLevel = (dto.requiredSkillLevel as number) ?? null;
  if (dto.externalDependency !== undefined) t.externalDependency = (dto.externalDependency as string) ?? null;
  if (dto.externalBlocked !== undefined) t.externalBlocked = !!dto.externalBlocked;
  // Changement de statut → recale la colonne Kanban correspondante.
  if (dto.status !== undefined && dto.status !== t.status) {
    t.status = dto.status as TaskStatus;
    const col = columnForStatus(t.projectId, t.status);
    if (col) t.boardColumnId = col.id;
    if (t.status === TaskStatus.DONE) t.progressPct = 100;
  }
  t.updatedAt = iso();
  refreshTaskCounts(t.projectId);
  persist();
  return t;
}

export function moveTask(taskId: string, dto: Record<string, unknown>): TaskDto {
  const t = findTask(taskId);
  const s = getState();
  const col = columnById(t.projectId, dto.boardColumnId as string);
  if (!col) throw new DemoHttpError(400, 'Colonne cible introuvable');
  t.boardColumnId = col.id;
  t.status = col.status;
  if (col.status === TaskStatus.DONE) t.progressPct = 100;
  // Position : entre deux cartes si fourni, sinon valeur donnée, sinon fin de colonne.
  const posOf = (id?: string) => s.tasks.find((x) => x.id === id)?.position;
  const before = posOf(dto.beforeTaskId as string | undefined);
  const after = posOf(dto.afterTaskId as string | undefined);
  if (before != null && after != null) t.position = (before + after) / 2;
  else if (before != null) t.position = before - 500;
  else if (after != null) t.position = after + 500;
  else if (typeof dto.position === 'number') t.position = dto.position;
  else {
    const maxPos = s.tasks.filter((x) => x.boardColumnId === col.id && x.id !== t.id).reduce((n, x) => Math.max(n, x.position), 0);
    t.position = maxPos + 1000;
  }
  t.updatedAt = iso();
  refreshTaskCounts(t.projectId);
  persist();
  return t;
}

export function deleteTask(taskId: string): undefined {
  const s = getState();
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new DemoHttpError(404, 'Tâche introuvable');
  s.tasks = s.tasks.filter((x) => x.id !== taskId);
  s.comments = s.comments.filter((c) => c.taskId !== taskId);
  s.timeEntries = s.timeEntries.filter((e) => e.taskId !== taskId);
  s.allocations = s.allocations.filter((a) => a.taskId !== taskId);
  refreshTaskCounts(t.projectId);
  persist();
  return undefined;
}

/* ---------- Comments ---------- */
export function createComment(taskId: string, dto: Record<string, unknown>): CommentDto {
  const t = findTask(taskId);
  const me = currentUser();
  const now = iso();
  const c: CommentDto = {
    id: nextId('comment'),
    taskId,
    author: { id: me.id, name: me.name, email: me.email },
    body: (dto.body as string) ?? '',
    createdAt: now,
    updatedAt: now,
  };
  getState().comments.push(c);
  t.commentCount = (t.commentCount ?? 0) + 1;
  persist();
  return c;
}

/* ---------- Labels ---------- */
export function createLabel(projectId: string, dto: Record<string, unknown>): LabelDto {
  const l: LabelDto = {
    id: nextId('label'),
    projectId,
    name: (dto.name as string) ?? 'Étiquette',
    color: (dto.color as string) ?? '#64748b',
  };
  getState().labels.push(l);
  persist();
  return l;
}
export function updateLabel(projectId: string, labelId: string, dto: Record<string, unknown>): LabelDto {
  const l = getState().labels.find((x) => x.id === labelId && x.projectId === projectId);
  if (!l) throw new DemoHttpError(404, 'Étiquette introuvable');
  if (dto.name !== undefined) l.name = dto.name as string;
  if (dto.color !== undefined) l.color = dto.color as string;
  // Propage aux tâches qui la portent.
  for (const t of getState().tasks) {
    const hit = t.labels.find((x) => x.id === labelId);
    if (hit) {
      hit.name = l.name;
      hit.color = l.color;
    }
  }
  persist();
  return l;
}
export function deleteLabel(projectId: string, labelId: string): undefined {
  const s = getState();
  s.labels = s.labels.filter((l) => !(l.id === labelId && l.projectId === projectId));
  for (const t of s.tasks) t.labels = t.labels.filter((x) => x.id !== labelId);
  persist();
  return undefined;
}

/* ---------- Time entries ---------- */
export function createTimeEntry(dto: Record<string, unknown>): TimeEntryDto {
  const me = currentUser();
  const now = iso();
  const e: TimeEntryDto = {
    id: nextId('te'),
    taskId: dto.taskId as string,
    userId: me.id,
    user: { id: me.id, name: me.name, email: me.email },
    date: dto.date as string,
    durationMinutes: (dto.durationMinutes as number) ?? 0,
    overtimeMinutes: (dto.overtimeMinutes as number) ?? 0,
    description: (dto.description as string) ?? null,
    createdAt: now,
    updatedAt: now,
  };
  getState().timeEntries.push(e);
  persist();
  return e;
}
export function updateTimeEntry(id: string, dto: Record<string, unknown>): TimeEntryDto {
  const e = getState().timeEntries.find((x) => x.id === id);
  if (!e) throw new DemoHttpError(404, 'Saisie introuvable');
  if (dto.date !== undefined) e.date = dto.date as string;
  if (dto.durationMinutes !== undefined) e.durationMinutes = dto.durationMinutes as number;
  if (dto.overtimeMinutes !== undefined) e.overtimeMinutes = dto.overtimeMinutes as number;
  if (dto.description !== undefined) e.description = (dto.description as string) ?? null;
  e.updatedAt = iso();
  persist();
  return e;
}
export function deleteTimeEntry(id: string): undefined {
  const s = getState();
  s.timeEntries = s.timeEntries.filter((e) => e.id !== id);
  persist();
  return undefined;
}

/* ---------- Watchers ---------- */
export function watchTask(taskId: string, on: boolean): { watching: boolean } {
  const s = getState();
  const t = s.tasks.find((x) => x.id === taskId);
  if (on && t) {
    if (!s.watching.some((w) => w.kind === 'task' && w.taskId === taskId)) {
      s.watching.push({
        id: nextId('watch'), kind: 'task', taskId, projectId: t.projectId,
        title: t.title, projectName: s.projects.find((p) => p.id === t.projectId)?.name ?? '',
        createdAt: iso(),
      });
    }
  } else {
    s.watching = s.watching.filter((w) => !(w.kind === 'task' && w.taskId === taskId));
  }
  persist();
  return { watching: on };
}
export function watchProject(projectId: string, on: boolean): { watching: boolean } {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  if (on && p) {
    if (!s.watching.some((w) => w.kind === 'project' && w.projectId === projectId)) {
      s.watching.push({
        id: nextId('watch'), kind: 'project', taskId: null, projectId,
        title: p.name, projectName: p.name, createdAt: iso(),
      });
    }
  } else {
    s.watching = s.watching.filter((w) => !(w.kind === 'project' && w.projectId === projectId));
  }
  persist();
  return { watching: on };
}
