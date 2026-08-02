/* ============================================================
   Vaks — shared UI primitives + icons
   ============================================================ */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MONTHS, labels as LABELS, userById, type Priority, type Task, type User } from './data';

/* ---------- Icons (clean line set, Lucide-ish) ---------- */
const ICONS: Record<string, string> = {
  board: 'M4 4h6v16H4zM14 4h6v10h-6z',
  list: 'M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  timeline: 'M3 6h10M3 12h16M3 18h7M17 4v4M21 10v4M9 16v4',
  gauge: 'M12 13l4-4M5.6 18a9 9 0 1 1 12.8 0',
  dash: 'M4 13h7V4H4zM13 9h7V4h-7zM13 20h7v-9h-7zM4 20h7v-5H4z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  bell: 'M6 9a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9M10.3 21a2 2 0 0 0 3.4 0',
  search: 'M21 21l-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.9H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  chevDown: 'M6 9l6 6 6-6',
  chevR: 'M9 6l6 6-6 6',
  chevL: 'M15 6l-6 6 6 6',
  chat: 'M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-4A8.4 8.4 0 1 1 21 11.5z',
  paperclip: 'M21 8l-9.2 9.2a4 4 0 0 1-5.7-5.7l9-9a2.7 2.7 0 0 1 3.8 3.8l-9 9a1.3 1.3 0 0 1-1.9-1.9l8.4-8.4',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  branch: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 6a9 9 0 0 1-9 9',
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  flag: 'M4 21V4M4 4h13l-2 4 2 4H4',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  sort: 'M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3',
  user: 'M20 21a8 8 0 1 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  dots: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  cal: 'M8 2v4M16 2v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  arrowR: 'M5 12h14M13 6l6 6-6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  zap: 'M13 2L4.5 13.5H11l-1 8.5L18.5 10.5H12z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  link: 'M10 14a5 5 0 0 1 0-7l3-3a5 5 0 0 1 7 7l-1.5 1.5M14 10a5 5 0 0 1 0 7l-3 3a5 5 0 0 1-7-7l1.5-1.5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  hourglass: 'M6 2h12M6 22h12M7 2v4a5 5 0 0 0 5 5 5 5 0 0 0 5-5V2M7 22v-4a5 5 0 0 1 5-5 5 5 0 0 1 5 5v4',
  coins: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  key: 'M8 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10.2 12.8L20 3M17 6l2 2M14 9l2 2',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.5-1.5',
  eye: 'M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  bot: 'M12 8V4H8M4 8h16v12H4zM2 14h2M20 14h2M9 13v2M15 13v2',
};

export function Icon({
  name,
  size = 18,
  sw = 1.7,
  style,
  className,
}: {
  name: string;
  size?: number;
  sw?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const d = ICONS[name];
  if (!d) {
    if (typeof console !== 'undefined') console.warn(`[Icon] unknown name "${name}"`);
    return null;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      className={className}
      aria-hidden="true"
    >
      {d
        .split('M')
        .filter(Boolean)
        .map((seg, i) => (
          <path key={i} d={'M' + seg} />
        ))}
    </svg>
  );
}

/* ---------- Brand mark ----------
   Logo officiel Vaks-PM : trois barres décalées (rang fractionnaire = clin
   d'œil au board). Rendu en `currentColor` pour s'adapter au thème : accent
   en clair, blanc en sombre (cf. `.brand-mark svg` dans views.css). */
export function BrandMark({ size = 20, style, className }: { size?: number; style?: React.CSSProperties; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      // viewBox cropped + centered on the three bars' bounding box (x14–84, y24–83)
      // with even padding, so the mark sits centered in its container instead of
      // rendering low-left in a mostly-empty 100×100 canvas.
      viewBox="9 14 80 80"
      fill="currentColor"
      style={{ flexShrink: 0, ...style }}
      className={className}
      role="img"
      aria-label="Vaks-PM"
    >
      <rect x="14" y="24" width="40" height="15" rx="7.5" />
      <rect x="34" y="46" width="50" height="15" rx="7.5" opacity="0.68" />
      <rect x="22" y="68" width="34" height="15" rx="7.5" opacity="0.42" />
    </svg>
  );
}

/* ---------- Avatar ---------- */
export function Avatar({
  user,
  size = 26,
  ring = false,
  title = true,
}: {
  user: User | undefined;
  size?: number;
  ring?: boolean;
  title?: boolean;
}) {
  if (!user) return null;
  const h = user.hue;
  return (
    <div
      title={title ? `${user.name} · ${user.role}` : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.4,
        fontWeight: 600,
        letterSpacing: '.02em',
        color: '#fff',
        background: `linear-gradient(140deg, oklch(0.62 0.16 ${h}), oklch(0.5 0.16 ${h + 25}))`,
        boxShadow: ring ? '0 0 0 2px var(--surface)' : 'none',
        userSelect: 'none',
      }}
    >
      {user.initials}
    </div>
  );
}

export function AvatarStack({ ids, max = 3, size = 24 }: { ids: string[]; max?: number; size?: number }) {
  const list = ids.map((id) => userById[id]).filter(Boolean);
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  return (
    <div className="row" style={{ paddingLeft: 4 }}>
      {shown.map((u, i) => (
        <div key={u.id} style={{ marginLeft: -6, zIndex: i }}>
          <Avatar user={u} size={size} ring />
        </div>
      ))}
      {extra > 0 && (
        <div
          style={{
            marginLeft: -6,
            width: size,
            height: size,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            fontSize: size * 0.36,
            fontWeight: 600,
            background: 'var(--surface-3)',
            color: 'var(--text-2)',
            boxShadow: '0 0 0 2px var(--surface)',
          }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}

/* ---------- Label tag ---------- */
export function Tag({ id, dot = false }: { id: string; dot?: boolean }) {
  const l = LABELS[id];
  if (!l) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: dot ? 0 : '2px 8px',
        borderRadius: 'var(--r-pill)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.01em',
        color: `oklch(0.45 0.12 ${l.hue})`,
        background: dot ? 'transparent' : `oklch(0.95 0.05 ${l.hue})`,
      }}
      className="tag-chip"
      data-hue={l.hue}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: `oklch(0.6 0.16 ${l.hue})` }} />
      {l.name}
    </span>
  );
}

/* ---------- Priority ---------- */
export const PRIO: Record<Priority, { c: string; label: string }> = {
  low: { c: 'var(--p-low)', label: 'Low' },
  normal: { c: 'var(--p-normal)', label: 'Normal' },
  high: { c: 'var(--p-high)', label: 'High' },
  urgent: { c: 'var(--p-urgent)', label: 'Urgent' },
};

export function PriorityDot({ level, withLabel = false }: { level: Priority; withLabel?: boolean }) {
  const { t } = useTranslation();
  const p = PRIO[level] || PRIO.normal;
  const label = t(`priority.${level}`, { defaultValue: p.label });
  const bars = ({ low: 1, normal: 2, high: 3, urgent: 4 } as Record<Priority, number>)[level] || 2;
  return (
    <span className="row" style={{ gap: 5 }} title={t('priority.label', { level: label })}>
      <span className="row" style={{ gap: 1.5, alignItems: 'flex-end', height: 12 }}>
        {[1, 2, 3, 4].map((n) => (
          <span
            key={n}
            style={{ width: 3, borderRadius: 1, height: 3 + n * 2.2, background: n <= bars ? p.c : 'var(--border-2)' }}
          />
        ))}
      </span>
      {withLabel && <span style={{ color: p.c, fontWeight: 600, fontSize: 12 }}>{label}</span>}
    </span>
  );
}

/* ---------- Progress ring ---------- */
export function ProgressRing({ value, size = 22, sw = 3 }: { value: number; size?: number; sw?: number }) {
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const done = value >= 100;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-2)" strokeWidth={sw} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={done ? 'var(--c-ok)' : 'var(--accent)'}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset .4s var(--ease)' }}
      />
    </svg>
  );
}

/* ---------- Number stepper (− input +) ----------
   Reusable numeric input with custom +/- buttons (native spinners hidden).
   Pass `null` / undefined value for "empty". Empty string clears via onChange(null).
*/
export function NumberStepper({
  value,
  onChange,
  step = 0.25,
  min = 0,
  max,
  width,
  placeholder = '0',
  ariaLabel,
  snap = false,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  width?: number;
  placeholder?: string;
  ariaLabel?: string;
  /** If true, snap to the nearest valid step (from `min`) on blur. */
  snap?: boolean;
}) {
  const { t } = useTranslation();
  const num = typeof value === 'number' ? value : null;
  const snapTo = (v: number): number => {
    if (!snap) return v;
    const base = typeof min === 'number' ? min : 0;
    const snapped = base + Math.round((v - base) / step) * step;
    // Avoid binary float artefacts (0.30000000000000004…).
    const decimals = (step.toString().split('.')[1] ?? '').length;
    return +snapped.toFixed(Math.max(decimals, 2));
  };
  const clamp = (v: number): number => {
    if (typeof min === 'number' && v < min) return min;
    if (typeof max === 'number' && v > max) return max;
    return v;
  };
  const bump = (dir: 1 | -1) => {
    const base = num ?? (typeof min === 'number' ? min : 0);
    onChange(clamp(snapTo(base + dir * step)));
  };
  const decDisabled = typeof min === 'number' && num != null && num <= min;
  const incDisabled = typeof max === 'number' && num != null && num >= max;
  return (
    <span className="stepper" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className="stepper-minus"
        onClick={() => bump(-1)}
        disabled={decDisabled}
        aria-label={t('stepper.decrease')}
        tabIndex={-1}
      >
        −
      </button>
      <input
        type="number"
        className="no-spin mono"
        step={step}
        min={min}
        max={max}
        value={num ?? ''}
        placeholder={placeholder}
        style={width ? { width } : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(null);
          const n = parseFloat(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={(e) => {
          if (!snap) return;
          const raw = e.target.value;
          if (raw === '') return;
          const n = parseFloat(raw);
          if (Number.isFinite(n)) onChange(clamp(snapTo(n)));
        }}
      />
      <button
        type="button"
        className="stepper-plus"
        onClick={() => bump(1)}
        disabled={incDisabled}
        aria-label={t('stepper.increase')}
        tabIndex={-1}
      >
        +
      </button>
    </span>
  );
}

/* ---------- Group color palette ----------
   10 design-friendly hex colors used as choices for the group color picker.
   Deliberately no pure red — reserved for critical-path / overdue cues.
*/
export interface GroupColor {
  name: string;
  hex: string;
}
export const GROUP_COLORS: GroupColor[] = [
  { name: 'Indigo',  hex: '#6366f1' },
  { name: 'Blue',    hex: '#3b82f6' },
  { name: 'Sky',     hex: '#0ea5e9' },
  { name: 'Teal',    hex: '#14b8a6' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Lime',    hex: '#84cc16' },
  { name: 'Amber',   hex: '#f59e0b' },
  { name: 'Orange',  hex: '#f97316' },
  { name: 'Pink',    hex: '#ec4899' },
  { name: 'Purple',  hex: '#a855f7' },
];

/**
 * Walks up the parent chain to find the first explicitly-set color.
 * Groups define a color ; tasks inherit from the nearest colored ancestor.
 * Returns `null` if no ancestor (or the task itself) has a color set.
 */
export function effectiveColor(
  task: Task,
  all: Task[],
): string | null {
  let cur: Task | undefined = task;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.color) return cur.color;
    if (!cur.parentTaskId) return null;
    cur = all.find((t) => t.id === cur!.parentTaskId);
  }
  return null;
}

/* ---------- date format ---------- */
export interface DueInfo {
  label: string;
  overdue: boolean;
  today: boolean;
  soon: boolean;
}
export const fmt = {
  due(offset: number | null, monday: Date): DueInfo | null {
    if (offset == null) return null;
    const d = new Date(monday);
    d.setDate(monday.getDate() + offset);
    return {
      label: `${MONTHS[d.getMonth()]} ${d.getDate()}`,
      overdue: offset < 0,
      today: offset === 0,
      soon: offset >= 0 && offset <= 1,
    };
  },
};

/* ---------- subtask count (checklist-aware) ---------- */
export function subOf(task: Task): { done: number; total: number } | null {
  if (task.checklist) return { done: task.checklist.filter((c) => c.done).length, total: task.checklist.length };
  return task.subtasks || null;
}
