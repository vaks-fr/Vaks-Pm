import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { EVENTS } from '@vaks-pm/shared';
import { getAccessToken } from './client';
import { DEMO } from '../demo/config';
import {
  drainBuffered,
  getMode,
  isSelfMutation,
  pushBufferedEvent,
} from '../realtime/store';

type EventName = (typeof EVENTS)[keyof typeof EVENTS];
/**
 * Noms d'events custom (string libres) émis par certains modules backend qui
 * n'ont pas encore d'entrée dans EVENTS (comments, time entries, attachments).
 */
const CUSTOM_EVENTS = [
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'time_entry.created',
  'time_entry.updated',
  'time_entry.deleted',
  'attachment.created',
  'attachment.deleted',
] as const;

type AnyEventName = EventName | (typeof CUSTOM_EVENTS)[number];
// Payload reste typé `unknown` côté handler pour compatibilité avec les
// callers historiques qui le castent eux-mêmes (`p as TaskDto`). Les nouveaux
// handlers peuvent caster vers `Record<string, unknown>` pour lire les meta
// `clientMutationId` / `actorUserId` ajoutées par le gateway.
type Handlers = Partial<Record<AnyEventName, (payload: unknown) => void>>;

let socket: Socket | null = null;

/** Stub socket.io no-op pour la démo statique : ne se connecte jamais, avale
 *  tous les `on`/`off`/`emit`. Les mutations restent visibles via l'optimistic
 *  UI déjà en place — aucun event distant n'est nécessaire. */
function makeFakeSocket(): Socket {
  const noop = () => fake;
  const fake = {
    on: noop,
    off: noop,
    emit: noop,
    once: noop,
    connect: noop,
    disconnect: noop,
    removeListener: noop,
    removeAllListeners: noop,
    connected: false,
  };
  return fake as unknown as Socket;
}

function getSocket(): Socket {
  if (!socket) {
    if (DEMO) {
      socket = makeFakeSocket();
      return socket;
    }
    socket = io('/ws', {
      transports: ['websocket'],
      auth: (cb) => cb({ token: getAccessToken() ?? '' }),
    });
  }
  return socket;
}

/**
 * Registre des handlers du projet courant, partagé module-scope. Permet à
 * `flushBufferedToHandlers()` (appelé depuis le panneau de notifs) de
 * redispatcher les events buffés vers les bons callbacks sans devoir re-render
 * le Workspace.
 */
const currentHandlers: { ref: Handlers | null } = { ref: null };

function dispatchEvent(name: string, payload: unknown) {
  const h = currentHandlers.ref;
  if (!h) return;
  const fn = (h as Record<string, ((p: unknown) => void) | undefined>)[name];
  fn?.(payload);
}

/** Vide le buffer et redispatch chaque event vers les handlers courants. */
export function flushBufferedToHandlers(): void {
  const items = drainBuffered();
  for (const ev of items) dispatchEvent(ev.name, ev.payload);
}

const ALL_EVENT_NAMES: string[] = [...Object.values(EVENTS), ...CUSTOM_EVENTS];

/**
 * Rejoint la room d'un projet et branche les handlers d'événements.
 *
 * - Filtre les events causés par CE client (clientMutationId présent dans
 *   `pendingMutations`) — pas la peine de patcher, l'optimistic UI l'a fait.
 * - En mode `paused`, les events distants vont dans un buffer (panel
 *   notifications, bouton "Tout appliquer") au lieu d'être dispatchés.
 *
 * Désabonne automatiquement au démontage.
 */
export function useProjectEvents(projectId: string | undefined, handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  // Expose au module-level pour permettre le flush externe.
  currentHandlers.ref = handlers;

  useEffect(() => {
    if (!projectId) return;
    const s = getSocket();
    s.emit('project:join', projectId);
    // En cas de reconnexion (perte réseau, redéploiement de l'API), socket.io
    // recrée la session ⇒ les rooms sont reset. Sans ce hook, le client ne
    // reçoit plus aucun event après une coupure.
    const onConnect = () => s.emit('project:join', projectId);
    s.on('connect', onConnect);

    const makeListener = (name: string) => (payload: unknown) => {
      const obj = (payload && typeof payload === 'object' ? payload : { data: payload }) as Record<
        string,
        unknown
      >;
      const cmid = (obj.clientMutationId as string | undefined) ?? undefined;
      if (isSelfMutation(cmid)) return; // event causé par moi -> déjà appliqué
      if (getMode() === 'paused') {
        pushBufferedEvent(name, obj);
        return;
      }
      const fn = (ref.current as Record<string, ((p: unknown) => void) | undefined>)[name];
      fn?.(obj);
    };

    const subscribed: Array<[string, (p: unknown) => void]> = [];
    for (const name of ALL_EVENT_NAMES) {
      const fn = makeListener(name);
      s.on(name, fn);
      subscribed.push([name, fn]);
    }

    return () => {
      s.off('connect', onConnect);
      s.emit('project:leave', projectId);
      for (const [name, fn] of subscribed) s.off(name, fn);
    };
  }, [projectId]);
}

/**
 * Events « méta » diffusés à toute l'org (room `org:<id>`, rejointe
 * automatiquement à la connexion — pas de join explicite). Payload minimal
 * (`{ id }`) : le consommateur refetch la liste, qui ré-applique la
 * visibilité par user côté serveur.
 */
const ORG_PROJECT_EVENTS = ['project.created', 'project.updated', 'project.deleted'] as const;

/**
 * Abonne aux changements de la liste projets de l'org. Contrairement à
 * `useProjectEvents`, pas de filtre self-mutation ni de mode paused : le
 * handler est typiquement un refresh idempotent et silencieux.
 */
export function useOrgProjectEvents(handler: (event: string, payload: unknown) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    const subscribed = ORG_PROJECT_EVENTS.map((name) => {
      const fn = (payload: unknown) => ref.current(name, payload);
      s.on(name, fn);
      return [name, fn] as const;
    });
    return () => {
      for (const [name, fn] of subscribed) s.off(name, fn);
    };
  }, []);
}
