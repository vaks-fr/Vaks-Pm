/* ============================================================
   NotificationsPanel — popover top-right.
   - Affiche le mode realtime (Live / Paused).
   - En mode Paused, liste le nombre d'updates en attente et propose
     un bouton "Tout appliquer" qui flush le buffer vers les handlers
     enregistrés par useProjectEvents.
   - Liste les notifications (mentions, assignations, commentaires
     reçus quand l'user n'était pas sur la tâche).
   ============================================================ */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Icon } from '../vaks/primitives';
import { flushBufferedToHandlers } from '../api/realtime';
import {
  clearBuffered,
  dismissNotification,
  markAllNotificationsRead,
  useRealtime,
} from './store';

function formatRelative(t: TFunction, ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return t('relative.justNow');
  if (s < 3600) return t('relative.minutesAgo', { count: Math.floor(s / 60) });
  if (s < 86400) return t('relative.hoursAgo', { count: Math.floor(s / 3600) });
  return t('relative.daysAgo', { count: Math.floor(s / 86400) });
}

function eventLabel(t: TFunction, name: string): string {
  switch (name) {
    case 'task.created':
      return t('event.taskCreated');
    case 'task.updated':
      return t('event.taskUpdated');
    case 'task.moved':
      return t('event.taskMoved');
    case 'task.deleted':
      return t('event.taskDeleted');
    case 'task.status_changed':
      return t('event.taskStatusChanged');
    case 'column.created':
    case 'column.updated':
    case 'column.deleted':
    case 'columns.reordered':
      return t('event.column');
    case 'comment.created':
      return t('event.commentCreated');
    case 'comment.updated':
      return t('event.commentUpdated');
    case 'comment.deleted':
      return t('event.commentDeleted');
    case 'time_entry.created':
      return t('event.timeLogged');
    case 'time_entry.updated':
    case 'time_entry.deleted':
      return t('event.timeUpdated');
    case 'attachment.created':
      return t('event.attachmentAdded');
    case 'attachment.deleted':
      return t('event.attachmentDeleted');
    case 'dependency.created':
    case 'dependency.deleted':
      return t('event.dependency');
    default:
      return name;
  }
}

export function NotificationsPanel() {
  const { t } = useTranslation();
  const { buffered, notifications, mode } = useRealtime();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const unreadNotifs = notifications.filter((n) => !n.read).length;
  const totalDot = unreadNotifs + buffered.length;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  const handleApply = () => {
    flushBufferedToHandlers();
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        className="icon-btn only-wide"
        aria-label={t('notif.title')}
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) markAllNotificationsRead();
        }}
      >
        <Icon name="bell" size={18} />
        {totalDot > 0 && <span className="notif-dot" />}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 8,
            width: 340,
            maxHeight: 480,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 10px 30px oklch(0 0 0 / 0.35)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t('notif.title')}</div>
            <div style={{ flex: 1 }} />
            <span
              style={{
                fontSize: 11,
                color: mode === 'live' ? 'var(--text-2)' : 'var(--text-3)',
              }}
            >
              {mode === 'live' ? t('live.live') : t('live.paused')}
            </span>
          </div>

          {/* Section : changements bufferisés (mode paused) */}
          {buffered.length > 0 && (
            <div
              style={{
                padding: '10px 12px',
                borderBottom: '1px solid var(--border)',
                background: 'oklch(from var(--accent) l c h / 0.06)',
              }}
            >
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <Trans
                  i18nKey="notif.pendingChanges"
                  count={buffered.length}
                  values={{ count: buffered.length }}
                  components={[<strong />]}
                />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-accent"
                  style={{ fontSize: 12, padding: '5px 10px' }}
                  onClick={handleApply}
                >
                  {t('notif.applyAll')}
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '5px 10px' }}
                  onClick={() => clearBuffered()}
                >
                  {t('notif.ignore')}
                </button>
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {notifications.length === 0 && buffered.length === 0 && (
              <div
                style={{
                  padding: '24px 12px',
                  textAlign: 'center',
                  fontSize: 12,
                  color: 'var(--text-3)',
                }}
              >
                {t('notif.empty')}
              </div>
            )}
            {notifications.map((n) => (
              <div
                key={n.id}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                }}
              >
                <Icon
                  name={
                    n.kind === 'mention'
                      ? 'chat'
                      : n.kind === 'assignment'
                      ? 'user'
                      : n.kind === 'comment'
                      ? 'chat'
                      : 'bell'
                  }
                  size={14}
                  style={{ color: 'var(--text-3)', marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{n.title}</div>
                  {n.body && (
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                      {n.body}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    {formatRelative(t, n.at)}
                  </div>
                </div>
                <button
                  className="icon-btn"
                  onClick={() => dismissNotification(n.id)}
                  aria-label={t('dismiss')}
                  style={{ padding: 2 }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {/* Mode paused : liste compacte des events buffés pour info */}
            {buffered.length > 0 && (
              <div style={{ padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
                  {t('notif.details')}
                </div>
                {buffered.slice(-8).reverse().map((b, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 11.5,
                      color: 'var(--text-2)',
                      padding: '4px 0',
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{eventLabel(t, b.name)}</span>
                    <span style={{ color: 'var(--text-3)' }}>{formatRelative(t, b.receivedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
