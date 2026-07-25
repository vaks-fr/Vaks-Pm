/* ============================================================
   Vaks — Projects panel : helpers & primitives partagés
   (dates, statuts, couleurs, dialogue de confirmation, Escape)
   ============================================================ */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Icon } from '../primitives';
import { ProjectStatus } from '@vaks-pm/shared';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAY_MS = 86_400_000;

export function isoToParts(iso: string | null) {
  if (!iso) return null;
  const d = iso.slice(0, 10).split('-').map(Number);
  return { y: d[0], m: d[1] - 1, d: d[2] };
}
export function shortDate(iso: string | null) {
  const p = isoToParts(iso);
  return p ? `${MONTHS[p.m]} ${p.d}` : '—';
}
export function dateOf(iso: string | null) {
  const p = isoToParts(iso);
  return p ? new Date(p.y, p.m, p.d) : null;
}
export function daysLeft(iso: string | null) {
  const d = dateOf(iso);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / DAY_MS);
}

export const STATUS_META: Record<ProjectStatus, { labelKey: string; hue: number }> = {
  [ProjectStatus.DRAFT]: { labelKey: 'DRAFT', hue: 280 },
  [ProjectStatus.OFFER_SENT]: { labelKey: 'OFFER_SENT', hue: 35 },
  [ProjectStatus.CHARTER_REVIEW]: { labelKey: 'CHARTER_REVIEW', hue: 50 },
  [ProjectStatus.ACTIVE]: { labelKey: 'ACTIVE', hue: 155 },
  [ProjectStatus.COMPLETED]: { labelKey: 'COMPLETED', hue: 215 },
  [ProjectStatus.ARCHIVED]: { labelKey: 'ARCHIVED', hue: 25 },
};

/** Libellé traduit d'un statut projet. `t` doit être lié au namespace `projects`. */
export function statusLabel(t: TFunction, status: ProjectStatus): string {
  return t('status.' + STATUS_META[status].labelKey);
}

/** Tous les statuts, dans l'ordre du cycle de vie (filtre + toggle Manage). */
export const ALL_STATUSES: ProjectStatus[] = [
  ProjectStatus.DRAFT,
  ProjectStatus.OFFER_SENT,
  ProjectStatus.CHARTER_REVIEW,
  ProjectStatus.ACTIVE,
  ProjectStatus.COMPLETED,
  ProjectStatus.ARCHIVED,
];

export function StatusPill({ status }: { status: ProjectStatus }) {
  const { t } = useTranslation('projects');
  const s = STATUS_META[status];
  return (
    <span
      className="pj-status"
      data-hue={s.hue}
      style={{ color: `oklch(0.5 0.13 ${s.hue})`, background: `oklch(0.95 0.05 ${s.hue})` }}
    >
      <span className="pj-status-dot" style={{ background: `oklch(0.62 0.16 ${s.hue})` }} />
      {statusLabel(t, status)}
    </span>
  );
}

export function colorFromKey(key: string) {
  // stable hue from key bytes (0..360) — réservé aux *clés projet* (courtes).
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

// Teinte stable d'un *id utilisateur* (UUID). Mod à la fin sur 32 bits — doit
// rester identique à `hueFromId` de `api.ts`/`AdminPanel` pour que l'avatar
// d'un user soit de la même couleur partout (admin panel inclus).
export function hueFromId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/** Construit l'objet `user` attendu par <Avatar> depuis un {id, name}. */
export function avatarUser(u: { id: string; name: string }) {
  return {
    id: u.id,
    name: u.name,
    short: u.name.split(' ')[0],
    initials: u.name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    role: '',
    hue: hueFromId(u.id),
    online: false,
  };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * Pile module-scope des handlers Escape actifs : seul le dialogue le plus
 * récemment monté (= le plus haut visuellement) réagit à Escape. Évite qu'un
 * Escape sur un sous-dialogue de confirmation ferme aussi le modal parent.
 */
const escStack: Array<() => void> = [];
let escListenerInstalled = false;
function ensureEscListener() {
  if (escListenerInstalled) return;
  escListenerInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || escStack.length === 0) return;
    escStack[escStack.length - 1]();
  });
}

/** Ferme au clavier (Escape). `active=false` pour suspendre (état busy…). */
export function useEscapeKey(onEscape: () => void, active = true) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    ensureEscListener();
    const entry = () => ref.current();
    escStack.push(entry);
    return () => {
      const i = escStack.indexOf(entry);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [active]);
}

/* ============================ Confirm dialog ============================ */

interface ConfirmDialogProps {
  eyebrow: string;
  title: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  footMeta?: React.ReactNode;
  children: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** Icône d'en-tête (défaut `warn`). Ex. `shield` pour une action RGPD. */
  icon?: string;
  /** Teinte de l'action principale : `danger` (rouge, défaut) ou `accent`. */
  tone?: 'danger' | 'accent';
}

/**
 * Dialogue de confirmation maison (remplace les `window.confirm`) : overlay
 * au-dessus des modals existants, fermeture par clic extérieur / Escape /
 * bouton. `tone='danger'` (défaut) → action rouge ; `tone='accent'` → action
 * colorée (ex. anonymisation RGPD).
 */
export function ConfirmDialog({
  eyebrow,
  title,
  confirmLabel,
  busyLabel,
  busy = false,
  footMeta,
  children,
  onConfirm,
  onCancel,
  icon = 'warn',
  tone = 'danger',
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEscapeKey(onCancel, !busy);
  useEffect(() => {
    cardRef.current?.focus();
  }, []);
  const accent = tone === 'accent';
  const markStyle = accent
    ? { background: 'color-mix(in oklch, var(--accent) 16%, transparent)', color: 'var(--accent)' }
    : { background: 'var(--c-over-bg)', color: 'var(--c-over)' };
  return (
    <div className="md-overlay" onMouseDown={() => !busy && onCancel()} style={{ zIndex: 8000 }}>
      <div
        ref={cardRef}
        tabIndex={-1}
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(460px, 100%)', outline: 'none' }}
      >
        <div className="md-head">
          <div className="anav-mark" style={{ width: 38, height: 38, ...markStyle }}>
            <Icon name={icon} size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{eyebrow}</div>
            <div className="md-title truncate">{title}</div>
          </div>
          <button className="icon-btn" onClick={onCancel} disabled={busy} aria-label={t('close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">{children}</div>
        <div className="md-foot">
          <div className="md-foot-meta">{footMeta}</div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              {t('cancel')}
            </button>
            <button
              className={'btn ' + (accent ? 'btn-accent' : 'btn-danger')}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? busyLabel ?? confirmLabel : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
