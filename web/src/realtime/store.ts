/* ============================================================
   Realtime store — gère le mode live/paused, le buffer d'events
   distants reçus pendant la pause, le set des mutations en cours
   pour la déduplication self, et la queue de notifications.
   ============================================================ */
import { useSyncExternalStore } from 'react';

export interface BufferedEvent {
  /** Nom de l'event WS (TASK_MOVED, comment.created, ...) */
  name: string;
  /** Payload brut tel qu'envoyé par le serveur */
  payload: Record<string, unknown>;
  /** Horodatage de réception (ms epoch) */
  receivedAt: number;
}

export interface Notification {
  id: string;
  /** Type sémantique (mention, assignment, comment, system) */
  kind: 'mention' | 'assignment' | 'comment' | 'system';
  title: string;
  body?: string;
  /** ms epoch */
  at: number;
  /** Cible cliquable (taskId, projectId) */
  taskId?: string;
  read: boolean;
}

export type Mode = 'live' | 'paused';

const STORAGE_KEY = 'vaks.realtime.mode';
const PENDING_TTL_MS = 30_000;

interface State {
  mode: Mode;
  buffered: BufferedEvent[];
  notifications: Notification[];
}

const initialMode = (): Mode => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'paused' ? 'paused' : 'live';
  } catch {
    return 'live';
  }
};

let state: State = {
  mode: initialMode(),
  buffered: [],
  notifications: [],
};

const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const getSnapshot = () => state;

export function useRealtime(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---- mode ------------------------------------------------------

export function setMode(mode: Mode) {
  if (state.mode === mode) return;
  state = { ...state, mode };
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore (private mode)
  }
  emit();
}

export function getMode(): Mode {
  return state.mode;
}

// ---- self-mutation dedup ---------------------------------------

/**
 * UUIDs des mutations émises par CE client. Les events WS qui les portent
 * sont ignorés par le hook (le caller a déjà patché en optimistic).
 */
const pendingMutations = new Map<string, number>();

export function trackPendingMutation(id: string): void {
  pendingMutations.set(id, Date.now() + PENDING_TTL_MS);
}

export function isSelfMutation(id: string | undefined | null): boolean {
  if (!id) return false;
  const exp = pendingMutations.get(id);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    pendingMutations.delete(id);
    return false;
  }
  return true;
}

// Nettoyage paresseux : à chaque check on purge les expirés. Pour éviter une
// fuite si aucun event ne tombe jamais, un timer périodique.
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of pendingMutations) {
    if (exp < now) pendingMutations.delete(id);
  }
}, 60_000);

export function newMutationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // fallback (vieux navigateurs / contextes non sécurisés)
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ---- buffer (mode paused) --------------------------------------

export function pushBufferedEvent(name: string, payload: Record<string, unknown>): void {
  state = {
    ...state,
    buffered: [...state.buffered, { name, payload, receivedAt: Date.now() }],
  };
  emit();
}

/** Récupère et vide le buffer. Utilisé au "Tout appliquer". */
export function drainBuffered(): BufferedEvent[] {
  const out = state.buffered;
  if (out.length === 0) return out;
  state = { ...state, buffered: [] };
  emit();
  return out;
}

export function clearBuffered(): void {
  if (state.buffered.length === 0) return;
  state = { ...state, buffered: [] };
  emit();
}

// ---- notifications --------------------------------------------

export function pushNotification(n: Omit<Notification, 'id' | 'at' | 'read'>): void {
  const id = newMutationId();
  state = {
    ...state,
    notifications: [{ ...n, id, at: Date.now(), read: false }, ...state.notifications].slice(0, 50),
  };
  emit();
}

export function markAllNotificationsRead(): void {
  if (state.notifications.every((n) => n.read)) return;
  state = {
    ...state,
    notifications: state.notifications.map((n) => ({ ...n, read: true })),
  };
  emit();
}

export function dismissNotification(id: string): void {
  state = { ...state, notifications: state.notifications.filter((n) => n.id !== id) };
  emit();
}
