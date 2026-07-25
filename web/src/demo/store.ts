/* ============================================================
   Vaks — Démo statique : store en mémoire + persistance localStorage.
   ----------------------------------------------------------------
   State aux formes DTO EXACTES de `@vaks-pm/shared` (le faux backend renvoie
   ces objets tels quels, les converters `web/src/vaks/api.ts` marchent sans
   modification). Hydraté du seed au 1er run, persisté en localStorage
   (versionné). `resetDemo()` purge et re-seed.
   ============================================================ */
import type {
  UserDto,
  ProjectDto,
  BoardDto,
  TaskDto,
  LabelDto,
  TimeEntryDto,
  CommentDto,
  TeamDto,
  ClientDto,
  ContactDto,
  SkillDto,
  AllocationDto,
  WatchingEntryDto,
  WorkspaceAgentDto,
  DependencyDto,
} from '@vaks-pm/shared';
import { DEMO_STATE_KEY, DEMO_STATE_VERSION } from './config';
import { buildSeed } from './seed';

/** State complet de la sandbox. Chaque tableau = une « table » DTO. */
export interface DemoState {
  version: number;
  /** Id de l'utilisateur « visiteur » (le PM connecté). */
  meId: string;
  /** Compteur d'ids pour les entités créées à l'exécution. */
  seq: number;
  users: UserDto[];
  projects: ProjectDto[];
  /** Un board par projet (avec ses colonnes). */
  boards: BoardDto[];
  tasks: TaskDto[];
  labels: LabelDto[];
  timeEntries: TimeEntryDto[];
  comments: CommentDto[];
  allocations: AllocationDto[];
  teams: TeamDto[];
  clients: ClientDto[];
  contacts: ContactDto[];
  skills: SkillDto[];
  watching: WatchingEntryDto[];
  agents: WorkspaceAgentDto[];
  dependencies: DependencyDto[];
}

let state: DemoState | null = null;

function loadPersisted(): DemoState | null {
  try {
    const raw = localStorage.getItem(DEMO_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    if (!parsed || parsed.version !== DEMO_STATE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persiste le state courant (best-effort — silencieux en mode privé). */
export function persist(): void {
  if (!state) return;
  try {
    localStorage.setItem(DEMO_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore (quota / private mode)
  }
}

/** Renvoie le state, en l'hydratant du cache ou du seed au premier accès. */
export function getState(): DemoState {
  if (!state) {
    state = loadPersisted() ?? buildSeed();
    persist();
  }
  return state;
}

/** Réinitialise la démo au jeu de données seed puis persiste. */
export function resetDemo(): void {
  state = buildSeed();
  persist();
}

/** Id unique pour une entité créée à l'exécution (`task_42`, `label_7`…). */
export function nextId(prefix: string): string {
  const s = getState();
  s.seq += 1;
  return `${prefix}_${s.seq}`;
}

/** Utilisateur « visiteur » courant (PM connecté). */
export function currentUser(): UserDto {
  const s = getState();
  return s.users.find((u) => u.id === s.meId) ?? s.users[0];
}
