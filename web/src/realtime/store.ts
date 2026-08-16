/* ============================================================
   Realtime store — gère le mode live/paused, le buffer d'events
   distants reçus pendant la pause, le set des mutations en cours
   pour la déduplication self, et la queue de notifications.
   ============================================================ */
import { useSyncExternalStore } from 'react';
import type { UserNotificationKind } from '@vaks-pm/shared';

export interface BufferedEvent {
  /** Nom de l'event WS (TASK_MOVED, comment.created, ...) */
  name: string;
  /** Payload brut tel qu'envoyé par le serveur */
  payload: Record<string, unknown>;
  /** Horodatage de réception (ms epoch) */
  receivedAt: number;
}

/**
 * Notification de la cloche, **adossée au serveur** (`Notification` Prisma) :
 * `id`/`read` viennent du serveur, `title`/`body` sont déjà rendus (par le
 * mapper `renderInboxItem`, via i18n pour les kinds « perso » ou tel quel pour
 * les kinds serveur). Persistée → survit au refresh et au hors-ligne.
 */
export interface Notification {
  /** Id serveur (`Notification.id`). */
  id: string;
  kind: UserNotificationKind;
  title: string;
  body?: string;
  /** ms epoch (dérivé de `createdAt`). */
  at: number;
  /** Cible cliquable (taskId + projectId pour rouvrir la tâche). */
  taskId?: string;
  projectId?: string;
  /** CTA (lien absolu) pour les kinds sans tâche cliquable. */
  url?: string;
  read: boolean;
}

export type Mode = 'live' | 'paused';

const STORAGE_KEY = 'vaks.realtime.mode';
const PENDING_TTL_MS = 30_000;

interface State {
  mode: Mode;
  buffered: BufferedEvent[];
  notifications: Notification[];
  /** Compteur de non-lues **faisant autorité côté serveur** (pastille) — peut
   *  dépasser `notifications.length` (liste paginée). */
  unread: number;
  /** La liste a-t-elle été hydratée depuis le serveur au moins une fois ? */
  hydrated: boolean;
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
  unread: 0,
  hydrated: false,
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

/**
 * Remplace la liste par la page serveur + fixe le compteur de non-lues faisant
 * autorité. Appelé au montage de la cloche (`GET /me/notifications`).
 */
export function hydrateNotifications(items: Notification[], unread: number): void {
  state = { ...state, notifications: items, unread, hydrated: true };
  emit();
}

/** Ajoute une page suivante (pagination « Charger plus »), en dédup par id. */
export function appendNotifications(items: Notification[]): void {
  const seen = new Set(state.notifications.map((n) => n.id));
  const fresh = items.filter((n) => !seen.has(n.id));
  if (fresh.length === 0) return;
  state = { ...state, notifications: [...state.notifications, ...fresh] };
  emit();
}

/**
 * Insère une notification reçue en temps réel (WS `user:<id>`). Dédup par id
 * (une hydratation concurrente a pu déjà la poser). Incrémente le compteur de
 * non-lues si elle est neuve et non lue.
 */
export function pushNotification(n: Notification): void {
  if (state.notifications.some((x) => x.id === n.id)) return;
  state = {
    ...state,
    notifications: [n, ...state.notifications].slice(0, 100),
    unread: n.read ? state.unread : state.unread + 1,
  };
  emit();
}

/** Marque tout lu localement (le serveur est notifié en parallèle par le panel). */
export function markAllNotificationsRead(): void {
  if (state.unread === 0 && state.notifications.every((n) => n.read)) return;
  state = {
    ...state,
    notifications: state.notifications.map((n) => ({ ...n, read: true })),
    unread: 0,
  };
  emit();
}

/** Retire une notification (dismiss) et ajuste le compteur si elle était non lue. */
export function dismissNotification(id: string): void {
  const target = state.notifications.find((n) => n.id === id);
  if (!target) return;
  state = {
    ...state,
    notifications: state.notifications.filter((n) => n.id !== id),
    unread: target.read ? state.unread : Math.max(0, state.unread - 1),
  };
  emit();
}
