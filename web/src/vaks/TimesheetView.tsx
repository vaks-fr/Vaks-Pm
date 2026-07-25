/* ============================================================
   Vaks — Timesheet (Phase 3 — extension, design Vaks)
   Vue "mon temps", semaine ouvrée (Lun-Ven). Strictement personnelle.
   - cellules éditables 0.25h précision (Enter pour commit, blur idem)
   - capacité projetée par jour (schedule × occupancy, 0 si férié/timeOff)
   - remplissage auto : tâches assignées + tâches allouées (heures planifiées
     affichées en placeholder grisé tant qu'aucune saisie réelle)
   - "Add a task to your week" : pick parmi les tâches restantes
   - bouton "Submit week" client-only (workflow approbation à venir)
   Backend : GET /timesheet?from=&to=  (POST/PATCH/DELETE /time-entries)
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { apiGetTimesheet } from './api';
import type {
  TimesheetDto,
  TimesheetCellDto,
  TimesheetDayDto,
  TimesheetAddableTaskDto,
  TimesheetTaskDto,
  TimesheetTimeOffRowDto,
} from '@vaks-pm/shared';
import { Icon } from './primitives';
import { useIsMobile } from './useIsMobile';

interface Props {
  /** Lundi de la semaine en cours, sert d'ancre pour calculer chaque vue. */
  monday: Date;
}

/* ---------- Helpers ---------- */
// dayOfWeek index : 0=Mon, 1=Tue, ..., 5=Sat, 6=Sun (convention monday-first du backend).
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const q = (n: number) => Math.round(n * 4) / 4;
const fmtH = (n: number): string => {
  if (n <= 0) return '0h';
  // entier → "8h" ; sinon TOUJOURS 2 décimales pour cohérence (1.50h, 0.25h)
  return Number.isInteger(n) ? `${n}h` : `${n.toFixed(2)}h`;
};

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function shiftDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Hash projectKey → hue (à garder identique au reste de l'UI). */
function hueFromKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/** Initiales pour l'avatar du toolbar. */
function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/);
  if (!parts.length) return '?';
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/* ---------- Cellule éditable ---------- */

function TimeCell({
  value,
  plannedHours,
  overtimeHours,
  today,
  disabled,
  blockedHint,
  dayState,
  onCommit,
}: {
  value: number; // en heures
  /** Heures planifiées (allocations) ce jour pour cette tâche — affichées en
   *  pré-remplissage grisé tant qu'aucune saisie réelle n'existe. */
  plannedHours: number;
  /** Sous-portion d'overtime déjà déclarée pour cette cellule (en heures). */
  overtimeHours: number;
  today: boolean;
  disabled: boolean;
  blockedHint?: string;
  /** État spécial du jour : nuance de fond pour weekend/férié/time-off. */
  dayState?: 'weekend' | 'holiday' | 'timeoff' | null;
  onCommit: (hours: number) => void;
}) {
  const { t } = useTranslation('workload');
  const [v, setV] = useState(value ? String(value) : '');
  useEffect(() => {
    setV(value ? String(value) : '');
  }, [value]);

  const commit = () => {
    const n = parseFloat(v.replace(',', '.'));
    onCommit(!n || n < 0 ? 0 : q(n));
  };

  const planned = !disabled && plannedHours > 0 ? String(q(plannedHours)) : null;

  return (
    <div
      className={
        'ts-cell' +
        (value > 0 ? ' ts-cell-filled' : '') +
        (planned && value === 0 ? ' ts-cell-planned' : '') +
        (today ? ' ts-cell-today' : '') +
        (dayState === 'holiday' ? ' ts-cell-holiday' : '') +
        (dayState === 'timeoff' ? ' ts-cell-timeoff' : '') +
        (dayState === 'weekend' ? ' ts-cell-weekend' : '')
      }
      title={
        disabled
          ? blockedHint
          : planned
            ? t('timesheet.cell.plannedTitle', { hours: plannedHours.toFixed(2) })
            : undefined
      }
    >
      <input
        className="ts-cell-in mono"
        value={v}
        placeholder={planned ?? '·'}
        inputMode="decimal"
        disabled={disabled}
        onChange={(e) => setV(e.target.value.replace(/[^\d.,]/g, ''))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(value ? String(value) : '');
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {/* Pour effacer, on vide simplement l'input et on commit (Enter / blur). */}
      {overtimeHours > 0 && (
        <span className="ts-cell-ot-tag" title={t('timesheet.cell.overtimeTitle', { hours: overtimeHours.toFixed(2) })}>
          {t('timesheet.cell.overtimeTag', { hours: overtimeHours.toFixed(2) })}
        </span>
      )}
    </div>
  );
}

/* ---------- Bouton "Add a task to your week" ---------- */

function AddRow({
  options,
  onAdd,
}: {
  options: TimesheetAddableTaskDto[];
  onAdd: (id: string) => void;
}) {
  const { t } = useTranslation('workload');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Position calculée pour le menu rendu via portal (sinon il est clippé
  // par le conteneur scrollable .ts-scroll qui a overflow:auto).
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const keyOf = useCallback(
    (o: TimesheetAddableTaskDto) =>
      o.externalKey ?? `${o.projectKey}${o.number > 0 ? `-${o.number}` : ''}`,
    [],
  );

  // Filtre par recherche : clé (HRS-7), titre, nom de projet.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${keyOf(o)} ${o.title} ${o.projectName}`.toLowerCase().includes(q),
    );
  }, [options, query, keyOf]);

  // Calcule la position d'ouverture du menu (juste au-dessus du bouton).
  // Hauteur stable (basée sur le nb total d'options, pas le filtre) pour que
  // le menu ne saute pas pendant la frappe : champ de recherche + max 5 lignes.
  const updatePos = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const rows = Math.min(5, Math.max(1, options.length));
    const menuH = 48 /* search */ + rows * 40 + 12;
    const menuW = 360;
    // ouvre vers le haut (au-dessus du bouton)
    let top = r.top - menuH - 4;
    if (top < 8) top = r.bottom + 4; // fallback : ouvre vers le bas si pas la place
    let left = r.left;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    setMenuPos({ left, top });
  }, [options.length]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    updatePos();
    // Focus le champ de recherche à l'ouverture.
    const focusTimer = setTimeout(() => searchRef.current?.focus(), 0);
    const onDoc = (e: PointerEvent) => {
      const inMenu = menuRef.current?.contains(e.target as Node);
      const inBtn = btnRef.current?.contains(e.target as Node);
      if (!inMenu && !inBtn) setOpen(false);
    };
    const onScroll = () => updatePos();
    const onResize = () => updatePos();
    document.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', onDoc, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, updatePos]);

  const disabled = options.length === 0;

  return (
    <div className="ts-addrow">
      <button
        ref={btnRef}
        className="ts-add-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? t('timesheet.addRow.disabled') : t('timesheet.addRow.enabled')}
      >
        <Icon name="plus" size={15} /> {t('timesheet.addRow.button')}
      </button>
      {open &&
        options.length > 0 &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="ts-add-menu"
            style={{
              position: 'fixed',
              left: menuPos.left,
              top: menuPos.top,
              bottom: 'auto',
            }}
          >
            <div className="ts-add-search">
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder={t('timesheet.addRow.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                  // Entrée : ajoute le 1er résultat filtré.
                  if (e.key === 'Enter' && filtered.length > 0) {
                    onAdd(filtered[0].id);
                    setOpen(false);
                  }
                }}
              />
            </div>
            <div className="ts-add-list">
              {filtered.length === 0 ? (
                <div className="ts-add-empty">{t('timesheet.addRow.noResults')}</div>
              ) : (
                filtered.map((opt) => (
                  <button
                    key={opt.id}
                    className="ts-add-item"
                    onClick={() => {
                      onAdd(opt.id);
                      setOpen(false);
                    }}
                  >
                    <span
                      className="ts-add-key"
                      style={{ color: `oklch(0.62 0.15 ${hueFromKey(opt.projectKey)})` }}
                    >
                      {keyOf(opt)}
                    </span>
                    <span className="ts-add-title">{opt.title}</span>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ---------- Dialog "Log time on a ticket" (outil de ticketing externe) ----------
   Recherche en deux couches :
   1. DB locale (GET /external-tasks?q=) — toujours disponible, tickets déjà upsertés.
   2. Connecteur live (GET /ticketing/search) — uniquement si un connecteur est activé.
   Les deux sources sont interrogées en parallèle et fusionnées (dédoublonnage par clé).
   L'upsert final (POST /external-tasks) est idempotent. */

type TicketResult = { key: string; title: string; url?: string; source: string; fromDb?: boolean; clientHint?: string };
type ClientOption = { id: string; name: string };

function TicketDialog({
  onCreated,
  onClose,
}: {
  onCreated: (taskId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('workload');

  // Connecteurs live disponibles (chargés une fois, optionnels)
  const [liveConnectors, setLiveConnectors] = useState<Array<{ source: string; label: string }>>([]);
  const [selectedSource, setSelectedSource] = useState('');

  // Clients de l'appli (chargés une fois)
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientId, setClientId] = useState('');

  // Mode : 'search' ou 'manual'
  const [mode, setMode] = useState<'search' | 'manual'>('search');

  // Recherche
  const [searchQ, setSearchQ] = useState('');
  const [results, setResults] = useState<TicketResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<TicketResult | null>(null);

  // Champs mode manual
  const [source, setSource] = useState('');
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Charger connecteurs + clients au montage
  useEffect(() => {
    api.listTicketingSources()
      .then((s) => {
        setLiveConnectors(s);
        if (s.length > 0) setSelectedSource(s[0].source);
      })
      .catch(() => {});
    api.listClients({ pageSize: 200 })
      .then((res) => setClients((res.items ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
  }, []);

  // Recherche avec debounce 300 ms — DB toujours + live si connecteur sélectionné
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'search' || searchQ.trim().length < 2) {
      setResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const q = searchQ.trim();
        // Toujours : recherche dans les tickets déjà en DB
        const dbPromise = api.searchExternalTasks({ q, limit: 20 })
          .then((rows) => rows.map((r) => ({
            key: r.externalKey ?? '',
            title: r.title,
            url: r.externalUrl ?? undefined,
            source: r.externalSource ?? '',
            fromDb: true,
          } as TicketResult)))
          .catch(() => [] as TicketResult[]);

        // Optionnel : recherche live via connecteur
        const livePromise = selectedSource
          ? api.searchTicketsLive({ source: selectedSource, q, limit: 20 })
              .then((rows) => rows.map((r) => ({
                key: r.key,
                title: r.title,
                url: r.url,
                source: selectedSource,
                fromDb: false,
                clientHint: (r.meta as Record<string, string> | undefined)?.clientHint,
              } as TicketResult)))
              .catch(() => [] as TicketResult[])
          : Promise.resolve([] as TicketResult[]);

        const [dbRes, liveRes] = await Promise.all([dbPromise, livePromise]);

        // Fusionner : DB en premier, live en complément (dédoublonnage par clé+source)
        const seen = new Set<string>();
        const merged: TicketResult[] = [];
        for (const r of [...dbRes, ...liveRes]) {
          const dedup = `${r.source}|${r.key}`;
          if (r.key && !seen.has(dedup)) { seen.add(dedup); merged.push(r); }
        }
        setResults(merged);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [mode, selectedSource, searchQ]);

  const pickResult = (r: TicketResult) => {
    setPicked(r);
    setKey(r.key);
    setTitle(r.title);
    setUrl(r.url ?? '');
    setSource(r.source);
    setResults([]);
    // Auto-match client depuis le hint du connecteur (ex: company ServiceNow)
    if (r.clientHint) {
      const hint = r.clientHint.toLowerCase();
      const match = clients.find((c) => c.name.toLowerCase().includes(hint) || hint.includes(c.name.toLowerCase()));
      if (match) setClientId(match.id);
    }
  };

  const clearPick = () => { setPicked(null); setKey(''); setTitle(''); setUrl(''); setClientId(''); };

  const slug = mode === 'search' ? (picked?.source ?? source).trim().toLowerCase() : source.trim().toLowerCase();
  const keyVal = key.trim();
  const valid = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(slug) && keyVal.length > 0;

  const canSubmit = mode === 'manual' ? valid : (picked != null && valid);

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.upsertExternalTask({
        source: slug,
        key: keyVal,
        title: title.trim() || undefined,
        url: url.trim() || undefined,
        clientId: clientId || undefined,
      });
      onCreated(created.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="ts-ot-modal-bg" onClick={onClose}>
      <div className="ts-ot-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h2>{t('timesheet.ticketDialog.title')}</h2>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {t('timesheet.ticketDialog.intro')}
        </div>

        {/* ---- Mode recherche ---- */}
        {mode === 'search' && !picked && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Sélecteur de source live (uniquement si connecteurs configurés) */}
            {liveConnectors.length > 0 && (
              <label className="ts-ticket-field">
                <span>{t('timesheet.ticketDialog.source')}</span>
                <select
                  value={selectedSource}
                  onChange={(e) => { setSelectedSource(e.target.value); setSearchQ(''); setResults([]); }}
                >
                  <option value="">{t('timesheet.ticketDialog.sourceAll')}</option>
                  {liveConnectors.map((s) => (
                    <option key={s.source} value={s.source}>{s.label}</option>
                  ))}
                </select>
              </label>
            )}
            {/* Champ de recherche */}
            <label className="ts-ticket-field">
              <span>{t('timesheet.ticketDialog.searchLabel')}</span>
              <input
                autoFocus
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder={t('timesheet.ticketDialog.searchPlaceholder')}
              />
            </label>
            {/* Résultats */}
            {searching && (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '4px 0' }}>
                {t('timesheet.ticketDialog.searching')}
              </div>
            )}
            {!searching && results.length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', maxHeight: 220, overflowY: 'auto' }}>
                {results.map((r) => (
                  <button
                    key={`${r.source}|${r.key}`}
                    className="ts-search-result"
                    onClick={() => pickResult(r)}
                    title={r.title}
                  >
                    <span className="ts-search-result-key mono">{r.key}</span>
                    <span className="ts-search-result-title">{r.title}</span>
                    <span className="ts-search-result-status">{r.source}</span>
                  </button>
                ))}
              </div>
            )}
            {!searching && searchQ.trim().length >= 2 && results.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                {t('timesheet.ticketDialog.noResults')}
              </div>
            )}
            <button
              className="btn btn-link btn-xs"
              style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--text-3)' }}
              onClick={() => setMode('manual')}
            >
              {t('timesheet.ticketDialog.switchManual')}
            </button>
          </div>
        )}

        {/* ---- Confirmation après pick ---- */}
        {mode === 'search' && picked && (
          <div style={{ background: 'var(--surface-2,#f4f4f5)', borderRadius: 6, padding: '10px 14px', fontSize: 13, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>{picked.key}</span>
            <span style={{ flex: 1 }}>{picked.title}</span>
            <button className="btn btn-link btn-xs" style={{ fontSize: 11, flexShrink: 0 }} onClick={clearPick}>
              {t('timesheet.ticketDialog.changePick')}
            </button>
          </div>
        )}

        {/* ---- Sélecteur client (toujours visible après pick ou en manual) ---- */}
        {(picked != null || mode === 'manual') && clients.length > 0 && (
          <label className="ts-ticket-field">
            <span>{t('timesheet.ticketDialog.client')}</span>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">{t('timesheet.ticketDialog.clientNone')}</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}

        {/* ---- Mode saisie manuelle ---- */}
        {mode === 'manual' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="ts-ticket-field">
              <span>{t('timesheet.ticketDialog.source')}</span>
              <input className="mono" autoFocus value={source} onChange={(e) => setSource(e.target.value)}
                placeholder={t('timesheet.ticketDialog.sourcePlaceholder')} />
            </label>
            <label className="ts-ticket-field">
              <span>{t('timesheet.ticketDialog.key')}</span>
              <input className="mono" value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={t('timesheet.ticketDialog.keyPlaceholder')}
                onKeyDown={(e) => e.key === 'Enter' && submit()} />
            </label>
            <label className="ts-ticket-field">
              <span>{t('timesheet.ticketDialog.ticketTitle')}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder={t('timesheet.ticketDialog.ticketTitlePlaceholder')} />
            </label>
            <label className="ts-ticket-field">
              <span>{t('timesheet.ticketDialog.link')}</span>
              <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder={t('timesheet.ticketDialog.linkPlaceholder')} />
            </label>
            <button
              className="btn btn-link btn-xs"
              style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--text-3)' }}
              onClick={() => { setMode('search'); setSource(''); setKey(''); setTitle(''); setUrl(''); }}
            >
              {t('timesheet.ticketDialog.switchSearch')}
            </button>
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--c-warn, #dc2626)', fontSize: 12.5 }}>
            {t('timesheet.ticketDialog.error', { message: error })}
          </div>
        )}

        <div className="ts-ot-modal-foot">
          <div className="ts-ot-modal-summary" />
          <div className="ts-ot-modal-actions">
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            <button className="btn btn-accent btn-sm" onClick={submit} disabled={!canSubmit || saving}>
              <Icon name="plus" size={15} /> {t('timesheet.ticketDialog.addToWeek')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Modal "Define overtime" pour un jour ---------- */

function OvertimeModal({
  date,
  capacityHours,
  rows,
  onSave,
  onClose,
}: {
  date: string;
  capacityHours: number;
  /** Lignes éditables : 1 par tâche du jour, avec hours totales et overtime actuel. */
  rows: Array<{
    taskId: string;
    taskLabel: string;
    taskSub: string;
    totalMinutes: number;
    overtimeMinutes: number;
  }>;
  /** Map de mises à jour par taskId → minutes d'overtime à appliquer. */
  onSave: (updates: Map<string, number>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('workload');
  const totalMin = rows.reduce((s, r) => s + r.totalMinutes, 0);
  const capMin = Math.round(capacityHours * 60);
  const overMin = Math.max(0, totalMin - capMin);

  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const r of rows) o[r.taskId] = (r.overtimeMinutes / 60).toFixed(2);
    return o;
  });

  const declared = rows.reduce((s, r) => {
    const n = parseFloat((draft[r.taskId] ?? '0').replace(',', '.'));
    return s + (Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0);
  }, 0);

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const upd = new Map<string, number>();
      for (const r of rows) {
        const n = parseFloat((draft[r.taskId] ?? '0').replace(',', '.'));
        const minutes = Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
        const clamped = Math.max(0, Math.min(minutes, r.totalMinutes));
        if (clamped !== r.overtimeMinutes) upd.set(r.taskId, clamped);
      }
      await onSave(upd);
      onClose();
    } catch (e) {
      alert(t('timesheet.overtimeModal.error', { message: (e as Error).message }));
      setSaving(false);
    }
  };

  return (
    <div className="ts-ot-modal-bg" onClick={onClose}>
      <div className="ts-ot-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('timesheet.overtimeModal.title', { date })}</h2>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {t('timesheet.overtimeModal.dayCapacity', { capacity: capacityHours.toFixed(2) })}{' '}
          {t('timesheet.overtimeModal.logged')}{' '}
          <span className="mono" style={{ color: 'var(--text)' }}>{(totalMin / 60).toFixed(2)}h</span>
          {overMin > 0 && (
            <>
              {' '}{t('timesheet.overtimeModal.beyondCapacity')}{' '}
              <span className="mono" style={{ color: 'var(--c-over)', fontWeight: 700 }}>
                +{(overMin / 60).toFixed(2)}h
              </span>
            </>
          )}
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {rows.map((r) => (
            <div key={r.taskId} className="ts-ot-row">
              <div className="ts-ot-name">
                {r.taskLabel}
                <span className="ts-ot-sub">{r.taskSub}</span>
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('timesheet.overtimeModal.totalSuffix', { total: (r.totalMinutes / 60).toFixed(2) })}
              </div>
              <input
                className="ts-ot-input mono"
                type="text"
                inputMode="decimal"
                value={draft[r.taskId] ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [r.taskId]: e.target.value.replace(/[^\d.,]/g, '') }))
                }
                onFocus={(e) => e.currentTarget.select()}
                placeholder="0.00"
              />
            </div>
          ))}
        </div>
        <div className="ts-ot-modal-foot">
          <div className="ts-ot-modal-summary">
            {t('timesheet.overtimeModal.declared')} <span className="num">{(declared / 60).toFixed(2)}h</span>
            {overMin > 0 && (
              <>
                {' '}{t('timesheet.overtimeModal.overBy', { over: (overMin / 60).toFixed(2) })}
                {declared < overMin && (
                  <span style={{ color: 'var(--c-warn, #dc2626)', marginLeft: 6 }}>
                    {t('timesheet.overtimeModal.remaining', { hours: ((overMin - declared) / 60).toFixed(2) })}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="ts-ot-modal-actions">
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            <button className="btn btn-accent btn-sm" onClick={handleSave} disabled={saving}>
              {t('common:save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Vue principale ---------- */

export function TimesheetView({ monday }: Props) {
  const { t } = useTranslation('workload');
  // Ancre = premier jour de la semaine selon le réglage admin (Mon ou Sun).
  // L'offset déplace par tranche de 7j.
  const [weekOffset, setWeekOffset] = useState(0);
  const [extraTaskIds, setExtraTaskIds] = useState<string[]>([]);
  const [weekStartPref, setWeekStartPref] = useState<'monday' | 'sunday'>('monday');
  // Date du jour pour lequel le modal "Define overtime" est ouvert (null = fermé).
  const [overtimeDayOpen, setOvertimeDayOpen] = useState<string | null>(null);
  // Dialog "Log time on a ticket" (tickets d'outils externes).
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
  // Bascule vers une mise en page téléphone (jour-par-jour) quand l'écran est étroit.
  const isMobile = useIsMobile();
  useEffect(() => {
    setExtraTaskIds([]);
  }, [weekOffset]);

  // Charge la préférence org (premier jour de la semaine) — défault monday.
  useEffect(() => {
    api
      .getPublicSettings()
      .then((s) => setWeekStartPref(s.weekStart))
      .catch(() => {
        /* silencieux, on garde monday */
      });
  }, []);

  // Si la préférence est 'sunday', on shift de -1 jour pour ancrer le dimanche
  // (la prop `monday` est toujours le lundi de la semaine courante).
  const weekAnchor = useMemo(() => {
    const m = new Date(monday);
    if (weekStartPref === 'sunday') m.setUTCDate(m.getUTCDate() - 1);
    return shiftDays(m, weekOffset * 7);
  }, [monday, weekStartPref, weekOffset]);
  const weekStart = isoOf(weekAnchor);
  const weekEnd = isoOf(shiftDays(weekAnchor, 6));

  const [data, setData] = useState<TimesheetDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const ts = await apiGetTimesheet({ from: weekStart, to: weekEnd });
      setData(ts);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [weekStart, weekEnd]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  // Vue 7 jours complète — l'ordre suit `data.days` (qui suit from→to envoyé
  // au backend) donc respecte le weekStart choisi en admin.
  const weekdays: TimesheetDayDto[] = useMemo(() => {
    if (!data) return [];
    return data.days;
  }, [data]);

  // Index cells par (taskId × date).
  const cellIndex = useMemo(() => {
    const m = new Map<string, TimesheetCellDto>();
    if (!data) return m;
    for (const c of data.cells) m.set(`${c.taskId}|${c.date}`, c);
    return m;
  }, [data]);

  // Rows = remplissage de la grille :
  //  1. tâches avec une saisie réelle OU une allocation (heures planifiées)
  //     sur la semaine affichée — l'allocation seule crée une ligne, avec les
  //     heures planifiées en pré-remplissage grisé ;
  //  2. extras ajoutés manuellement via « Add a task to your week ».
  // Les tâches simplement assignées (sans saisie ni allocation cette semaine)
  // n'apparaissent PAS d'office — elles restent dans le menu « Add a task to
  // your week » pour un ajout explicite par l'utilisateur.
  const rows: TimesheetTaskDto[] = useMemo(() => {
    if (!data) return [];
    const weekDates = new Set(weekdays.map((d) => d.date));
    const active = new Set<string>();
    for (const c of data.cells) {
      if (weekDates.has(c.date) && (c.actualMinutes > 0 || c.allocatedHours > 0)) {
        active.add(c.taskId);
      }
    }
    const byId = new Map(data.tasks.map((t) => [t.id, t] as const));
    const ordered: TimesheetTaskDto[] = [];
    const pushed = new Set<string>();
    for (const t of data.tasks) {
      if (active.has(t.id)) {
        ordered.push(t);
        pushed.add(t.id);
      }
    }
    for (const id of extraTaskIds) {
      if (pushed.has(id)) continue;
      // L'extra peut venir de addableTasks, donc pas forcément dans data.tasks
      const known = byId.get(id);
      if (known) {
        ordered.push(known);
        pushed.add(id);
        continue;
      }
      const add = data.addableTasks.find((a) => a.id === id);
      if (add) {
        ordered.push({
          id: add.id,
          title: add.title,
          status: 'TODO',
          number: add.number,
          estimateHours: add.estimateHours,
          projectId: add.projectId,
          projectKey: add.projectKey,
          projectName: add.projectName,
          externalSource: add.externalSource,
          externalKey: add.externalKey,
          externalUrl: add.externalUrl,
        });
        pushed.add(id);
      }
    }
    return ordered;
  }, [data, weekdays, extraTaskIds]);

  // Addable = tâches assignées (renvoyées par le backend) MOINS celles déjà en row.
  const addable = useMemo(() => {
    if (!data) return [];
    const inRows = new Set(rows.map((r) => r.id));
    return data.addableTasks.filter((t) => !inRows.has(t.id));
  }, [data, rows]);

  // ---- Helpers totaux ----
  const cellHours = useCallback(
    (taskId: string, dateIso: string) => {
      const c = cellIndex.get(`${taskId}|${dateIso}`);
      return c ? c.actualMinutes / 60 : 0;
    },
    [cellIndex],
  );
  const cellPlanned = useCallback(
    (taskId: string, dateIso: string) => {
      const c = cellIndex.get(`${taskId}|${dateIso}`);
      return c ? c.allocatedHours : 0;
    },
    [cellIndex],
  );
  const rowPlanned = useCallback(
    (taskId: string) => weekdays.reduce((s, d) => s + cellPlanned(taskId, d.date), 0),
    [weekdays, cellPlanned],
  );
  const rowTotal = useCallback(
    (taskId: string) => weekdays.reduce((s, d) => s + cellHours(taskId, d.date), 0),
    [weekdays, cellHours],
  );
  const dayTotal = useCallback(
    (dateIso: string) => rows.reduce((s, t) => s + cellHours(t.id, dateIso), 0),
    [rows, cellHours],
  );
  const weekTotal = useMemo(() => rows.reduce((s, t) => s + rowTotal(t.id), 0), [rows, rowTotal]);
  const weekCap = useMemo(() => weekdays.reduce((s, d) => s + d.capacityHours, 0), [weekdays]);

  // ---- "Logged this week" : on inclut aussi les saisies sur tâches non-row
  //      (par sécurité, si une ancienne entry traîne sur Sam/Dim) — on retient
  //      uniquement les jours ouvrés affichés.
  const loggedAllRows = useMemo(() => {
    let s = 0;
    for (const c of cellIndex.values()) {
      if (weekdays.some((d) => d.date === c.date)) s += c.actualMinutes / 60;
    }
    return s;
  }, [cellIndex, weekdays]);

  // Édition toujours active : le verrou hebdomadaire dépend d'un workflow
  // d'approbation manager (persistance + validation) non encore implémenté.
  // Tant qu'il n'existe pas, on n'affiche pas de bouton « soumettre » factice.
  const locked = false;

  // ---- Sauvegarde des overtime pour un jour ----
  // En pratique, après une édition via la grille, chaque (task, day) n'a
  // qu'une seule TimeEntry — la logique saveCell collapse les éventuels
  // doublons. On pose donc tout l'overtime sur la première entry, capé par
  // sa durée totale (le backend clampe de toute façon).
  const saveOvertime = useCallback(
    async (dateIso: string, updates: Map<string, number>) => {
      if (locked || !data) return;
      for (const [taskId, targetOt] of updates.entries()) {
        const cell = data.cells.find((c) => c.taskId === taskId && c.date === dateIso);
        if (!cell || cell.entryIds.length === 0) continue;
        const clamped = Math.max(0, Math.min(targetOt, cell.actualMinutes));
        await api.updateTimeEntry(cell.entryIds[0], { overtimeMinutes: clamped });
        // Les éventuelles entries supplémentaires de la cellule sont remises à 0
        // pour éviter d'avoir une somme incohérente.
        for (let i = 1; i < cell.entryIds.length; i++) {
          await api.updateTimeEntry(cell.entryIds[i], { overtimeMinutes: 0 });
        }
      }
      setRefreshKey((k) => k + 1);
    },
    [locked, data],
  );

  // ---- Mutation cellule ----
  const saveCell = useCallback(
    async (taskId: string, dateIso: string, hours: number) => {
      if (locked) return;
      const cell = cellIndex.get(`${taskId}|${dateIso}`);
      const entryIds = cell?.entryIds ?? [];
      const minutes = Math.round(hours * 60);
      try {
        if (entryIds.length === 0) {
          if (minutes <= 0) return;
          await api.createTimeEntry({ taskId, date: dateIso, durationMinutes: minutes });
        } else if (entryIds.length === 1) {
          if (minutes <= 0) await api.deleteTimeEntry(entryIds[0]);
          else await api.updateTimeEntry(entryIds[0], { durationMinutes: minutes });
        } else {
          for (const id of entryIds) await api.deleteTimeEntry(id);
          if (minutes > 0)
            await api.createTimeEntry({ taskId, date: dateIso, durationMinutes: minutes });
        }
        setRefreshKey((k) => k + 1);
      } catch (e) {
        alert(t('timesheet.error', { message: (e as Error).message }));
      }
    },
    [locked, cellIndex, t],
  );

  // ---- Labels ----
  const relLabel =
    weekOffset === 0
      ? t('timesheet.thisWeek')
      : weekOffset === -1
        ? t('timesheet.lastWeek')
        : weekOffset === 1
          ? t('timesheet.nextWeekLabel')
          : weekOffset < 0
            ? t('timesheet.weeksAgo', { count: -weekOffset })
            : t('timesheet.inWeeks', { count: weekOffset });
  const rangeLabel = useMemo(() => {
    if (weekdays.length === 0) return '';
    const first = new Date(weekdays[0].date + 'T00:00:00Z');
    const last = new Date(weekdays[weekdays.length - 1].date + 'T00:00:00Z');
    const sameMonth = first.getUTCMonth() === last.getUTCMonth();
    return `${MONTHS[first.getUTCMonth()]} ${first.getUTCDate()} – ${
      sameMonth ? '' : MONTHS[last.getUTCMonth()] + ' '
    }${last.getUTCDate()}`;
  }, [weekdays]);

  if (loading && !data) {
    return (
      <div className="ts-wrap">
        <div style={{ opacity: 0.6, padding: 24 }}>{t('timesheet.loading')}</div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="ts-wrap">
        <div style={{ color: 'var(--c-warn, #dc2626)', padding: 24 }}>{t('timesheet.error', { message: err })}</div>
      </div>
    );
  }
  if (!data) return null;

  const today = todayIso();

  // ---- Mise en page téléphone : la grille tâches×7j ne tient pas en portrait.
  //      On réutilise toute la logique (données, saveCell, modals) et on ne
  //      remplace que le rendu par une vue jour-par-jour. Desktop intouché. ----
  if (isMobile) {
    return (
      <TimesheetMobile
        data={data}
        weekdays={weekdays}
        rows={rows}
        addable={addable}
        today={today}
        locked={locked}
        weekOffset={weekOffset}
        setWeekOffset={setWeekOffset}
        relLabel={relLabel}
        rangeLabel={rangeLabel}
        loggedAllRows={loggedAllRows}
        weekCap={weekCap}
        weekTotal={weekTotal}
        cellIndex={cellIndex}
        cellHours={cellHours}
        cellPlanned={cellPlanned}
        dayTotal={dayTotal}
        saveCell={saveCell}
        saveOvertime={saveOvertime}
        setExtraTaskIds={setExtraTaskIds}
        setRefreshKey={setRefreshKey}
        overtimeDayOpen={overtimeDayOpen}
        setOvertimeDayOpen={setOvertimeDayOpen}
        ticketDialogOpen={ticketDialogOpen}
        setTicketDialogOpen={setTicketDialogOpen}
      />
    );
  }

  return (
    <div className="ts-wrap">
      {/* ---- Toolbar ---- */}
      <div className="ts-toolbar">
        <div className="row gap3" style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
          <h1>{t('timesheet.title')}</h1>
          <span className="ts-user-tag" title={t('timesheet.personalView')}>
            <span className="ts-user-avatar">{initialsOf(data.user.name)}</span>
            <span className="ts-user-name">{data.user.name}</span>
          </span>
        </div>
        <div className="ts-weeknav">
          <button className="ts-week-step" onClick={() => setWeekOffset((w) => w - 1)} aria-label={t('timesheet.prevWeek')}>
            <Icon name="chevL" size={18} />
          </button>
          <span className="ts-weeknav-label">
            {rangeLabel}
            <br />
            <span className="ts-weeknav-sub">{relLabel}</span>
          </span>
          <button className="ts-week-step" onClick={() => setWeekOffset((w) => w + 1)} aria-label={t('timesheet.nextWeek')}>
            <Icon name="chevR" size={18} />
          </button>
          {weekOffset !== 0 && (
            <button className="ts-today-btn" onClick={() => setWeekOffset(0)}>
              {t('timesheet.today')}
            </button>
          )}
        </div>
      </div>

      {/* ---- Summary strip ---- */}
      <div className="ts-summary">
        <div className="ts-stat" style={{ gridColumn: 'span 1' }}>
          <div className="ts-stat-cap">{t('timesheet.loggedThisWeek')}</div>
          <div className="ts-stat-big mono">
            {fmtH(loggedAllRows)}
            <span className="ts-stat-of">{t('timesheet.capacitySuffix', { capacity: fmtH(weekCap) })}</span>
          </div>
          <div className="ts-capbar">
            <div
              className={'ts-capbar-fill' + (loggedAllRows > weekCap ? ' over' : '')}
              style={{ width: (weekCap > 0 ? Math.min(loggedAllRows / weekCap, 1) * 100 : 0) + '%' }}
            />
          </div>
        </div>

        <div className="ts-stat">
          <div className="ts-stat-cap">{t('timesheet.overtime')}</div>
          <div
            className="ts-stat-num mono"
            style={{
              color: loggedAllRows > weekCap ? 'var(--c-over)' : undefined,
            }}
          >
            {fmtH(Math.max(0, loggedAllRows - weekCap))}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600 }}>
            {loggedAllRows > weekCap
              ? t('timesheet.overBeyond', { capacity: fmtH(weekCap) })
              : t('timesheet.noOvertime')}
          </div>
        </div>

      </div>

      {/* ---- Grid ---- */}
      <div className="ts-scroll">
        <div className={'ts-grid' + (locked ? ' ts-locked' : '')}>
          {/* Header */}
          <div className="ts-corner">{t('timesheet.colTask')}</div>
          {weekdays.map((d) => {
            const isTodayCol = d.date === today;
            const offLabel = d.isHoliday
              ? d.holidayName ?? t('timesheet.holiday')
              : d.isTimeOff
                ? (d.timeOffType
                    ? t('timeOffType.' + d.timeOffType, { defaultValue: d.timeOffType })
                    : t('timesheet.off')
                  ).slice(0, 8)
                : null;
            const [, mm, dd] = d.date.split('-');
            const cls =
              'ts-dhead' +
              (isTodayCol ? ' ts-dhead-today' : '') +
              (d.isHoliday ? ' ts-dhead-holiday' : '') +
              (d.isTimeOff ? ' ts-dhead-timeoff' : '') +
              (d.isWeekend && !d.isHoliday && !d.isTimeOff ? ' ts-dhead-weekend' : '');
            return (
              <div
                className={cls}
                key={d.date}
                title={
                  d.isHoliday
                    ? t('timesheet.holidayTooltip', { name: d.holidayName ?? '' })
                    : d.isTimeOff
                      ? d.timeOffNotes
                        ? t('timesheet.timeOffTooltipNotes', { type: d.timeOffType ?? '', notes: d.timeOffNotes })
                        : t('timesheet.timeOffTooltip', { type: d.timeOffType ?? '' })
                      : d.isWeekend
                        ? t('timesheet.weekend')
                        : undefined
                }
              >
                <span className="ts-dname">
                  {DAY_LABELS[d.dayOfWeek]}
                  {isTodayCol && <span className="ts-today-tag">{t('timesheet.todayTag')}</span>}
                </span>
                <span className="ts-ddate mono">
                  {MONTHS[Number(mm) - 1]} {Number(dd)}
                </span>
                <span className="ts-dcap mono">{offLabel ?? fmtH(d.capacityHours)}</span>
              </div>
            );
          })}
          <div className="ts-thead">{t('timesheet.colTotal')}</div>

          {/* Rows */}
          {rows.map((task) => {
            const logged = rowTotal(task.id);
            const planned = rowPlanned(task.id);
            const est = task.estimateHours;
            const estPct = est ? Math.min(logged / est, 1) * 100 : 0;
            const over = est != null && logged > est;
            const hue = hueFromKey(task.projectKey);
            return (
              <div key={task.id} style={{ display: 'contents' }}>
                <div className="ts-rlabel">
                  <div className="grow" style={{ flex: 1, minWidth: 0 }}>
                    <div className="ts-rtop">
                      {task.externalKey ? (
                        task.externalUrl ? (
                          <a
                            className="ts-rkey mono"
                            style={{ color: `oklch(0.6 0.15 ${hue})` }}
                            href={task.externalUrl}
                            target="_blank"
                            rel="noreferrer"
                            title={t('timesheet.openExternal', {
                              key: task.externalKey,
                              source: task.externalSource ?? t('timesheet.externalSourceFallback'),
                            })}
                          >
                            {task.externalKey} ↗
                          </a>
                        ) : (
                          <span
                            className="ts-rkey mono"
                            style={{ color: `oklch(0.6 0.15 ${hue})` }}
                            title={t('timesheet.externalTicket', { source: task.externalSource ?? '?' })}
                          >
                            {task.externalKey}
                          </span>
                        )
                      ) : (
                        <span className="ts-rkey mono" style={{ color: `oklch(0.6 0.15 ${hue})` }}>
                          {task.projectKey}
                          {task.number > 0 ? `-${task.number}` : ''}
                        </span>
                      )}
                      <span className="ts-rtitle truncate" title={task.title}>
                        {task.title}
                      </span>
                    </div>
                    {est != null ? (
                      <div className="ts-est">
                        <span className="ts-est-bar">
                          <span className={'ts-est-fill' + (over ? ' over' : '')} style={{ width: estPct + '%' }} />
                        </span>
                        <span className={'ts-est-meta mono' + (over ? ' over' : '')}>
                          {fmtH(logged)} / {fmtH(est)}
                        </span>
                        {planned > 0 && (
                          <span className="ts-est-meta ts-est-planned mono" title={t('timesheet.plannedTitle')}>
                            {t('timesheet.plannedSuffix', { hours: fmtH(planned) })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="ts-est">
                        <span className="ts-est-meta mono">
                          {t('timesheet.loggedSuffix', { hours: fmtH(logged) })}
                          {planned > 0
                            ? ` ${t('timesheet.plannedSuffix', { hours: fmtH(planned) })}`
                            : ` ${t('timesheet.noEstimate')}`}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                {weekdays.map((d) => {
                  const isTodayCol = d.date === today;
                  const off = d.isHoliday || d.isTimeOff;
                  const h = cellHours(task.id, d.date);
                  const dayState: 'weekend' | 'holiday' | 'timeoff' | null = d.isHoliday
                    ? 'holiday'
                    : d.isTimeOff
                      ? 'timeoff'
                      : d.isWeekend
                        ? 'weekend'
                        : null;
                  const cell = cellIndex.get(`${task.id}|${d.date}`);
                  const otHours = cell ? cell.overtimeMinutes / 60 : 0;
                  return (
                    <TimeCell
                      key={d.date}
                      value={h}
                      plannedHours={cellPlanned(task.id, d.date)}
                      overtimeHours={otHours}
                      today={isTodayCol}
                      disabled={off && h === 0}
                      blockedHint={
                        d.isHoliday
                          ? t('timesheet.blockedHoliday', { name: d.holidayName ?? '' })
                          : d.isTimeOff
                            ? t('timesheet.blockedTimeOff', { type: d.timeOffType ?? '' })
                            : undefined
                      }
                      dayState={dayState}
                      onCommit={(hh) => saveCell(task.id, d.date, hh)}
                    />
                  );
                })}
                <div className={'ts-rtotal mono' + (rowTotal(task.id) > 0 ? ' has' : '')}>
                  {rowTotal(task.id) > 0 ? fmtH(rowTotal(task.id)) : '—'}
                </div>
              </div>
            );
          })}

          {/* Time-off virtual rows : auto-générées depuis les TimeOff */}
          {data.timeOffRows.map((tor) => {
            const total = weekdays.reduce((s, d) => s + (tor.hoursByDate[d.date] ?? 0), 0);
            return (
              <div key={tor.id} style={{ display: 'contents' }}>
                <div className="ts-to-label">
                  <span className="ts-to-icon" title={t('timesheet.timeOffRow.autoGenerated')}>
                    <Icon name="cal" size={13} />
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                    <span className="ts-to-title">{tor.label}</span>
                    <span className="ts-to-sub">{t('timesheet.timeOffRow.readOnly')}</span>
                  </div>
                </div>
                {weekdays.map((d) => {
                  const h = tor.hoursByDate[d.date];
                  return (
                    <div key={d.date} className={'ts-to-cell' + (h ? '' : ' empty')}>
                      {h ? h.toFixed(2).replace(/0$/, '').replace(/\.$/, '') : '·'}
                    </div>
                  );
                })}
                <div className="ts-to-rtotal">{total > 0 ? fmtH(total) : '—'}</div>
              </div>
            );
          })}

          {/* Add row */}
          {!locked && (
            <div className="ts-addspan">
              <AddRow options={addable} onAdd={(id) => setExtraTaskIds((e) => [...e, id])} />
              <button
                className="ts-add-btn"
                onClick={() => setTicketDialogOpen(true)}
                title={t('timesheet.logTicketButtonTitle')}
              >
                <Icon name="plus" size={15} /> {t('timesheet.logTicketButton')}
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="ts-foot-label">{t('timesheet.dailyTotal')}</div>
          {weekdays.map((d) => {
            const tot = dayTotal(d.date);
            const cap = d.capacityHours;
            const over = cap > 0 && tot > cap;
            // overtime ne peut être déclaré que sur les jours où il y a une saisie.
            const canDefineOT = tot > 0 && !locked;
            const isTodayCol = d.date === today;
            const cls =
              'ts-foot-cell' +
              (isTodayCol ? ' ts-foot-today' : '') +
              (d.isHoliday ? ' ts-foot-holiday' : '') +
              (d.isTimeOff ? ' ts-foot-timeoff' : '') +
              (d.isWeekend && !d.isHoliday && !d.isTimeOff ? ' ts-foot-weekend' : '');
            return (
              <div className={cls} key={d.date}>
                <span className={'ts-foot-num mono' + (over ? ' over' : '')}>{tot > 0 ? fmtH(tot) : '—'}</span>
                {d.allocatedHours > 0 && (
                  <span className="ts-foot-plan mono" title={t('timesheet.planTitle')}>
                    {t('timesheet.planLabel', { hours: fmtH(d.allocatedHours) })}
                  </span>
                )}
                {cap > 0 && (
                  <span className="ts-foot-bar">
                    <span
                      className={'ts-foot-fill' + (over ? ' over' : '')}
                      style={{ width: Math.min(tot / cap, 1) * 100 + '%' }}
                    />
                  </span>
                )}
                {canDefineOT && (over || d.overtimeMinutes > 0) && (
                  <button
                    className="ts-foot-ot-btn"
                    onClick={() => setOvertimeDayOpen(d.date)}
                    title={t('timesheet.defineOtTitle')}
                  >
                    OT {d.overtimeMinutes > 0 ? fmtH(d.overtimeMinutes / 60) : t('timesheet.otSet')}
                  </button>
                )}
              </div>
            );
          })}
          <div className="ts-foot-total mono">{fmtH(weekTotal)}</div>
        </div>
      </div>

      {/* Dialog "Log time on a ticket" */}
      {ticketDialogOpen && (
        <TicketDialog
          onCreated={(taskId) => {
            // L'upsert assigne l'appelant → le ticket revient dans addableTasks
            // au refetch ; l'extra garantit la ligne immédiatement.
            setExtraTaskIds((e) => (e.includes(taskId) ? e : [...e, taskId]));
            setRefreshKey((k) => k + 1);
          }}
          onClose={() => setTicketDialogOpen(false)}
        />
      )}

      {/* Modal "Define overtime" */}
      {overtimeDayOpen && (() => {
        const day = data.days.find((d) => d.date === overtimeDayOpen);
        if (!day) return null;
        const rowsForDay = rows
          .map((t) => {
            const cell = cellIndex.get(`${t.id}|${day.date}`);
            if (!cell || cell.actualMinutes === 0) return null;
            return {
              taskId: t.id,
              taskLabel: t.title,
              taskSub: `${t.projectKey}${t.number > 0 ? `-${t.number}` : ''} · ${t.projectName}`,
              totalMinutes: cell.actualMinutes,
              overtimeMinutes: cell.overtimeMinutes,
            };
          })
          .filter((x): x is NonNullable<typeof x> => !!x);
        return (
          <OvertimeModal
            date={day.date}
            capacityHours={day.capacityHours}
            rows={rowsForDay}
            onSave={(upd) => saveOvertime(day.date, upd)}
            onClose={() => setOvertimeDayOpen(null)}
          />
        );
      })()}
    </div>
  );
}

/* ============================================================
   Mise en page TÉLÉPHONE (≤620px) — vue "jour par jour".
   La grille tâches × 7 jours ne tient pas en portrait. On réutilise toute la
   logique du parent (données, saveCell, saveOvertime, modals) et on remplace
   uniquement le rendu : un sélecteur de jour + une liste verticale de cartes
   tâche, une saisie d'heures par tâche pour le jour choisi.
   ============================================================ */

/** Saisie d'heures d'une carte tâche (téléphone). Même logique de commit que
 *  TimeCell, rendu adapté à une carte (input 16px, pas de zoom iOS). */
function MobileCell({
  value,
  plannedHours,
  disabled,
  blockedHint,
  onCommit,
}: {
  value: number;
  plannedHours: number;
  disabled: boolean;
  blockedHint?: string;
  onCommit: (hours: number) => void;
}) {
  const [v, setV] = useState(value ? String(value) : '');
  useEffect(() => {
    setV(value ? String(value) : '');
  }, [value]);
  const commit = () => {
    const n = parseFloat(v.replace(',', '.'));
    onCommit(!n || n < 0 ? 0 : q(n));
  };
  const planned = !disabled && plannedHours > 0 ? String(q(plannedHours)) : null;
  return (
    <input
      className="tsm-cell-in mono"
      value={v}
      placeholder={planned ?? '·'}
      inputMode="decimal"
      disabled={disabled}
      title={disabled ? blockedHint : undefined}
      onChange={(e) => setV(e.target.value.replace(/[^\d.,]/g, ''))}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value ? String(value) : '');
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function TimesheetMobile({
  data,
  weekdays,
  rows,
  addable,
  today,
  locked,
  weekOffset,
  setWeekOffset,
  relLabel,
  rangeLabel,
  loggedAllRows,
  weekCap,
  weekTotal,
  cellIndex,
  cellHours,
  cellPlanned,
  dayTotal,
  saveCell,
  saveOvertime,
  setExtraTaskIds,
  setRefreshKey,
  overtimeDayOpen,
  setOvertimeDayOpen,
  ticketDialogOpen,
  setTicketDialogOpen,
}: {
  data: TimesheetDto;
  weekdays: TimesheetDayDto[];
  rows: TimesheetTaskDto[];
  addable: TimesheetAddableTaskDto[];
  today: string;
  locked: boolean;
  weekOffset: number;
  setWeekOffset: Dispatch<SetStateAction<number>>;
  relLabel: string;
  rangeLabel: string;
  loggedAllRows: number;
  weekCap: number;
  weekTotal: number;
  cellIndex: Map<string, TimesheetCellDto>;
  cellHours: (taskId: string, dateIso: string) => number;
  cellPlanned: (taskId: string, dateIso: string) => number;
  dayTotal: (dateIso: string) => number;
  saveCell: (taskId: string, dateIso: string, hours: number) => void | Promise<void>;
  saveOvertime: (dateIso: string, updates: Map<string, number>) => Promise<void>;
  setExtraTaskIds: Dispatch<SetStateAction<string[]>>;
  setRefreshKey: Dispatch<SetStateAction<number>>;
  overtimeDayOpen: string | null;
  setOvertimeDayOpen: Dispatch<SetStateAction<string | null>>;
  ticketDialogOpen: boolean;
  setTicketDialogOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const { t } = useTranslation('workload');

  // Jour sélectionné : aujourd'hui s'il est dans la semaine, sinon le 1er jour.
  const defaultDate = weekdays.some((d) => d.date === today)
    ? today
    : weekdays[0]?.date ?? today;
  const [selDate, setSelDate] = useState(defaultDate);
  // Resélectionne un jour valide quand on change de semaine.
  useEffect(() => {
    if (!weekdays.some((d) => d.date === selDate)) setSelDate(defaultDate);
  }, [weekdays, selDate, defaultDate]);

  const selDay = weekdays.find((d) => d.date === selDate) ?? weekdays[0];
  if (!selDay) return null;

  const dayOff = selDay.isHoliday || selDay.isTimeOff;
  const dayTot = dayTotal(selDay.date);
  const dayCap = selDay.capacityHours;
  const dayOver = dayCap > 0 && dayTot > dayCap;
  const canDefineOT = dayTot > 0 && !locked && (dayOver || selDay.overtimeMinutes > 0);

  const offLabel = selDay.isHoliday
    ? selDay.holidayName ?? t('timesheet.holiday')
    : selDay.isTimeOff
      ? selDay.timeOffType
        ? t('timeOffType.' + selDay.timeOffType, { defaultValue: selDay.timeOffType })
        : t('timesheet.off')
      : null;

  // Pastille de charge d'une puce de jour.
  const dotClass = (d: TimesheetDayDto) => {
    if (d.isHoliday) return 'holiday';
    if (d.isTimeOff) return 'off';
    const tot = dayTotal(d.date);
    if (tot === 0) return 'empty';
    if (d.capacityHours > 0 && tot > d.capacityHours + 1e-6) return 'over';
    if (d.capacityHours > 0 && tot >= d.capacityHours * 0.999) return 'full';
    return 'partial';
  };

  const offRows = data.timeOffRows.filter((tor) => (tor.hoursByDate[selDate] ?? 0) > 0);

  return (
    <div className="tsm-wrap">
      {/* En-tête : navigation semaine + résumé */}
      <div className="tsm-head">
        <div className="tsm-weeknav">
          <button className="ts-week-step" onClick={() => setWeekOffset((w) => w - 1)} aria-label={t('timesheet.prevWeek')}>
            <Icon name="chevL" size={18} />
          </button>
          <div className="tsm-weeknav-label">
            <span>{rangeLabel}</span>
            <span className="tsm-weeknav-sub">{relLabel}</span>
          </div>
          <button className="ts-week-step" onClick={() => setWeekOffset((w) => w + 1)} aria-label={t('timesheet.nextWeek')}>
            <Icon name="chevR" size={18} />
          </button>
          {weekOffset !== 0 && (
            <button className="ts-today-btn" onClick={() => setWeekOffset(0)}>
              {t('timesheet.today')}
            </button>
          )}
        </div>

        <div className="tsm-summary">
          <div className="tsm-sum-main">
            <div className="tsm-sum-line">
              <span className="tsm-sum-cap">{t('timesheet.loggedThisWeek')}</span>
              <span className="mono tsm-sum-val">
                {fmtH(loggedAllRows)}
                <span className="tsm-sum-of">{t('timesheet.capacitySuffix', { capacity: fmtH(weekCap) })}</span>
              </span>
            </div>
            <div className="ts-capbar">
              <div
                className={'ts-capbar-fill' + (loggedAllRows > weekCap ? ' over' : '')}
                style={{ width: (weekCap > 0 ? Math.min(loggedAllRows / weekCap, 1) * 100 : 0) + '%' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Sélecteur de jour */}
      <div className="tsm-days">
        {weekdays.map((d) => {
          const dd = d.date.split('-')[2];
          const sel = d.date === selDate;
          return (
            <button
              key={d.date}
              className={
                'tsm-day-chip' +
                (sel ? ' is-sel' : '') +
                (d.date === today ? ' is-today' : '') +
                (d.isHoliday ? ' is-holiday' : d.isTimeOff ? ' is-off' : d.isWeekend ? ' is-weekend' : '')
              }
              onClick={() => setSelDate(d.date)}
            >
              <span className="tsm-day-dow">{DAY_LABELS[d.dayOfWeek]}</span>
              <span className="tsm-day-num">{Number(dd)}</span>
              <span className={'tsm-day-dot ' + dotClass(d)} />
            </button>
          );
        })}
      </div>

      {/* Jour sélectionné */}
      <div className="tsm-day">
        <div className="tsm-day-head">
          <div className="tsm-day-date">
            {DAY_LABELS[selDay.dayOfWeek]} {MONTHS[Number(selDate.split('-')[1]) - 1]} {Number(selDate.split('-')[2])}
            <span className={'tsm-day-cap mono' + (selDay.isHoliday ? ' is-holiday' : '')}>
              {offLabel ?? fmtH(dayCap)}
            </span>
          </div>
          <div className="tsm-day-tot">
            <span className={'mono' + (dayOver ? ' tsm-over' : '')}>{fmtH(dayTot)}</span>
            {canDefineOT && (
              <button className="ts-foot-ot-btn" onClick={() => setOvertimeDayOpen(selDate)} title={t('timesheet.defineOtTitle')}>
                OT {selDay.overtimeMinutes > 0 ? fmtH(selDay.overtimeMinutes / 60) : t('timesheet.otSet')}
              </button>
            )}
          </div>
        </div>

        {/* Bandeau jour férié — bien visible */}
        {selDay.isHoliday && (
          <div className="tsm-holiday-banner">
            <Icon name="cal" size={14} />
            <span>{selDay.holidayName ?? t('timesheet.holiday')}</span>
          </div>
        )}

        {/* Cartes tâche */}
        {rows.map((task) => {
          const h = cellHours(task.id, selDate);
          const planned = cellPlanned(task.id, selDate);
          const cell = cellIndex.get(`${task.id}|${selDate}`);
          const ot = cell ? cell.overtimeMinutes / 60 : 0;
          const hue = hueFromKey(task.projectKey);
          const keyLabel = task.externalKey ?? `${task.projectKey}${task.number > 0 ? `-${task.number}` : ''}`;
          return (
            <div key={task.id} className={'tsm-task' + (h > 0 ? ' is-filled' : '')}>
              <div className="tsm-task-info">
                <div className="tsm-task-top">
                  {task.externalKey && task.externalUrl ? (
                    <a
                      className="tsm-task-key mono"
                      style={{ color: `oklch(0.6 0.15 ${hue})` }}
                      href={task.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {keyLabel} ↗
                    </a>
                  ) : (
                    <span className="tsm-task-key mono" style={{ color: `oklch(0.6 0.15 ${hue})` }}>
                      {keyLabel}
                    </span>
                  )}
                  {ot > 0 && (
                    <span className="tsm-task-ot">{t('timesheet.cell.overtimeTag', { hours: ot.toFixed(2) })}</span>
                  )}
                </div>
                <div className="tsm-task-title">{task.title}</div>
                {planned > 0 && h === 0 && (
                  <div className="tsm-task-plan mono">{t('timesheet.plannedSuffix', { hours: fmtH(planned) })}</div>
                )}
              </div>
              <div className="tsm-task-cell">
                <MobileCell
                  value={h}
                  plannedHours={planned}
                  disabled={dayOff && h === 0}
                  blockedHint={
                    selDay.isHoliday
                      ? t('timesheet.blockedHoliday', { name: selDay.holidayName ?? '' })
                      : selDay.isTimeOff
                        ? t('timesheet.blockedTimeOff', { type: selDay.timeOffType ?? '' })
                        : undefined
                  }
                  onCommit={(hh) => saveCell(task.id, selDate, hh)}
                />
                <span className="tsm-task-h">h</span>
              </div>
            </div>
          );
        })}

        {/* Lignes d'absence (lecture seule) */}
        {offRows.map((tor) => (
          <div key={tor.id} className="tsm-task tsm-task-off">
            <div className="tsm-task-info">
              <div className="tsm-task-top">
                <span className="ts-to-icon">
                  <Icon name="cal" size={13} />
                </span>
                <span className="tsm-task-key">{tor.label}</span>
              </div>
              <div className="tsm-task-plan">{t('timesheet.timeOffRow.readOnly')}</div>
            </div>
            <div className="tsm-task-cell">
              <span className="mono tsm-task-offh">{fmtH(tor.hoursByDate[selDate] ?? 0)}</span>
            </div>
          </div>
        ))}

        {rows.length === 0 && offRows.length === 0 && (
          <div className="tsm-empty">{t('timesheet.addRow.enabled')}</div>
        )}

        {/* Ajouter une tâche / logger un ticket */}
        {!locked && (
          <div className="tsm-actions">
            <AddRow options={addable} onAdd={(id) => setExtraTaskIds((e) => [...e, id])} />
            <button
              className="ts-add-btn"
              onClick={() => setTicketDialogOpen(true)}
              title={t('timesheet.logTicketButtonTitle')}
            >
              <Icon name="plus" size={15} /> {t('timesheet.logTicketButton')}
            </button>
          </div>
        )}
      </div>

      {/* Modals (réutilisés tels quels) */}
      {ticketDialogOpen && (
        <TicketDialog
          onCreated={(taskId) => {
            setExtraTaskIds((e) => (e.includes(taskId) ? e : [...e, taskId]));
            setRefreshKey((k) => k + 1);
          }}
          onClose={() => setTicketDialogOpen(false)}
        />
      )}
      {overtimeDayOpen &&
        (() => {
          const day = data.days.find((d) => d.date === overtimeDayOpen);
          if (!day) return null;
          const rowsForDay = rows
            .map((tk) => {
              const cell = cellIndex.get(`${tk.id}|${day.date}`);
              if (!cell || cell.actualMinutes === 0) return null;
              return {
                taskId: tk.id,
                taskLabel: tk.title,
                taskSub: `${tk.projectKey}${tk.number > 0 ? `-${tk.number}` : ''} · ${tk.projectName}`,
                totalMinutes: cell.actualMinutes,
                overtimeMinutes: cell.overtimeMinutes,
              };
            })
            .filter((x): x is NonNullable<typeof x> => !!x);
          return (
            <OvertimeModal
              date={day.date}
              capacityHours={day.capacityHours}
              rows={rowsForDay}
              onSave={(upd) => saveOvertime(day.date, upd)}
              onClose={() => setOvertimeDayOpen(null)}
            />
          );
        })()}
    </div>
  );
}
