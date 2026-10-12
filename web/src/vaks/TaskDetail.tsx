/* ============================================================
   Vaks — Task detail panel (right drawer)
   Editable props · checklist · time tracking (timer) · comments + @mentions
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  availableAssigneeIds,
  columns as COLUMNS,
  currentUser,
  labels as LABELS,
  projects as PROJECTS,
  userById,
  users as USERS,
  type Column,
  type BoardSubStatus,
  type Comment,
  type Priority,
  type Task,
  type TimeEntry,
  type User,
} from './data';
import { Avatar, AvatarStack, fmt, GROUP_COLORS, Icon, NumberStepper, PriorityDot, subOf, Tag } from './primitives';
import { localizeColName } from './colLabel';
import { useConfirm } from './confirm';
import type {
  AllocationDto,
  AssigneeSuggestionDto,
  DependencyDto,
  SkillDto,
  TaskAgentActivityDto,
  TeamDto,
  UpdateAllocationDto,
  UserDto,
  WorkScheduleDto,
} from '@vaks-pm/shared';
import { DependencyType } from '@vaks-pm/shared';
import { api } from '../api/client';
import { useAuth, labelForLevel } from '../auth/AuthContext';
import { useFormat } from '../lib/format';
import { safeUrl } from '../lib/url';
import SkillPicker from './SkillPicker';
import {
  apiPatchTask,
  apiListAttachments,
  apiUploadAttachment,
  apiDeleteAttachment,
  apiDownloadAttachment,
  apiFetchAttachmentBlob,
  apiListDeliverables,
  apiSubmitForReview,
  apiReviewDeliverable,
  apiDownloadDeliverable,
  apiSetAcceptanceCriteria,
  apiSetTaskAgentBudget,
  apiListTaskWatchers,
  apiWatchTask,
  apiUnwatchTask,
  apiGetRecurrence,
  apiUpsertRecurrence,
  apiDeleteRecurrence,
  apiGetTaskCustomFields,
  type AttachmentDto,
  type DeliverableDto,
} from './api';
import type { WatcherDto, RecurringTaskDto, UpsertRecurrenceDto, RecurrenceFrequency } from '@vaks-pm/shared';
import { DEMO } from '../demo/config';
import { CustomFieldValuesSection } from './CustomFieldValuesSection';
import { DocumentViewerModal, isViewableDoc } from './projects/DocumentViewerModal';
import type { AcceptanceCriterion } from '@vaks-pm/shared';
import {
  getOrgDefaultCountry,
  holidayHitsFor,
  loadHolidaysFor,
  type HolidayHit,
} from './holidays';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---- Cache SWR des dépendances par projet --------------------------------
   Le drawer est monté/démonté à chaque ouverture : sans cache, les warnings
   FS (« Late start ») et la liste des prédécesseurs n'apparaissent qu'au
   retour du fetch → pop-in + décalage de layout à chaque ouverture. On sert
   la dernière réponse connue de façon synchrone, puis on revalide en fond.
   Les requêtes concurrentes (deux consommateurs dans le drawer) sont
   dédupliquées via `depsInflight`. */
const depsCache = new Map<string, DependencyDto[]>();
const depsInflight = new Map<string, Promise<DependencyDto[]>>();

function loadDepsSWR(
  projectId: string,
  onData: (deps: DependencyDto[]) => void,
  serveStale = true,
): { cancel: () => void; done: Promise<void> } {
  let cancelled = false;
  if (serveStale) {
    const cached = depsCache.get(projectId);
    if (cached) onData(cached);
  }
  let inflight = depsInflight.get(projectId);
  if (!inflight) {
    inflight = api.listDependencies(projectId).finally(() => {
      depsInflight.delete(projectId);
    });
    depsInflight.set(projectId, inflight);
  }
  const done = inflight
    .then((deps) => {
      depsCache.set(projectId, deps);
      if (!cancelled) onData(deps);
    })
    .catch(() => { /* silencieux — l'état déjà affiché reste valable */ });
  return { cancel: () => { cancelled = true; }, done };
}

/** Convertit l'offset Vaks (jours depuis lundi) en YYYY-MM-DD pour `<input type="date">`. */
function dueOffsetToIso(offset: number | null | undefined, monday: Date): string | null {
  if (offset == null) return null;
  const d = new Date(monday);
  d.setDate(monday.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convertit "YYYY-MM-DD" en offset jours depuis lundi (entier signé). */
function isoToDueOffset(iso: string, monday: Date): number {
  const [y, m, d] = iso.split('-').map(Number);
  // Comparaison en local time pour rester cohérent avec dueOffsetToIso.
  const target = new Date(y, m - 1, d);
  const ref = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  return Math.round((+target - +ref) / 86_400_000);
}

/**
 * Calcule l'offset de la due date la plus courte à partir d'un `start`
 * (offset depuis monday) et d'une charge `estimateHours`. Modèle :
 *   - capacité quotidienne combinée = nombre d'assignees × HOURS_PER_DAY
 *     (les gens travaillent en parallèle sur la tâche)
 *   - on saute les week-ends (Mon-Fri par défaut)
 *
 * On travaille en LOCAL pour rester cohérent avec dueOffsetToIso /
 * isoToDueOffset qui sont aussi en local. (Une version "tout UTC" créait
 * un mismatch d'un jour avec ces fonctions dans les fuseaux négatifs.)
 *
 * Approximation MVP — on n'a pas le schedule réel de chaque user côté UI ;
 * le serveur affinera lors de l'allocation. C'est une suggestion : l'user
 * peut toujours surcharger la date manuellement après.
 */
function computeSuggestedDueOffset(
  startOffset: number,
  estimateHours: number,
  assigneeCount: number,
  monday: Date,
  hoursPerDay = HOURS_PER_DAY,
): number {
  if (!(estimateHours > 0)) return startOffset;
  const N = Math.max(1, assigneeCount);
  const dailyCap = hoursPerDay * N;
  let remaining = estimateHours;
  const curDate = new Date(monday);
  curDate.setDate(monday.getDate() + startOffset);
  let curOffset = startOffset;
  let lastWorkOffset = startOffset;
  const MAX_OFFSET = startOffset + 365 * 5;
  while (remaining > 0.0001 && curOffset <= MAX_OFFSET) {
    const dow = curDate.getDay(); // 0=Dim, 6=Sam (local)
    if (dow !== 0 && dow !== 6) {
      const taken = Math.min(remaining, dailyCap);
      remaining -= taken;
      lastWorkOffset = curOffset;
      if (remaining <= 0.0001) break;
    }
    curDate.setDate(curDate.getDate() + 1);
    curOffset++;
  }
  return lastWorkOffset;
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    function h(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/* ---- small dropdown ---- */
function Dropdown({
  trigger,
  children,
  align = 'left',
  width = 200,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <div className="dd" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className="dd-menu" style={{ [align]: 0, width }} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ---- skill picker with search (replaces the legacy dropdown for `Required skill`) ---- */
/** Chip + dropdown pour choisir le skill requis d'une tâche. Single-select.
 *  Délègue la liste/recherche/dossiers au composant partagé `SkillPicker`. */
function RequiredSkillChip({
  selected,
  catalog,
  onPick,
  onClear,
  canRequestMissing,
  onRequestMissing,
}: {
  selected: SkillDto | null;
  catalog: SkillDto[];
  onPick: (s: SkillDto) => void;
  onClear: () => void;
  /** Vrai si l'utilisateur peut émettre une demande de compétence (PM only). */
  canRequestMissing?: boolean;
  /** Appelé avec le texte de recherche courant (prefill du popup de demande). */
  onRequestMissing?: (initialName: string) => void;
}) {
  const { t } = useTranslation('tasks');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);

  return (
    <div className="dd" ref={ref} style={{ display: 'inline-block' }}>
      {selected ? (
        <button
          type="button"
          title={t('skillChip.change')}
          onClick={() => setOpen((o) => !o)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderRadius: 999,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            color: 'var(--text)',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'inherit',
            cursor: 'pointer',
            maxWidth: 180,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: selected.color ?? '#6d5efc',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {selected.name}
          </span>
          <Icon name="chevDown" size={12} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
        </button>
      ) : (
        <button
          type="button"
          className="td-add-btn"
          title={t('skillChip.set')}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="plus" size={15} /> <span style={{ fontSize: 12 }}>{t('skillChip.skill')}</span>
        </button>
      )}
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 'calc(100% + 4px)',
            width: 320,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 8,
            boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
            zIndex: 50,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onClear();
              setOpen(false);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              background: 'transparent',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13,
              color: 'var(--text-3)',
              marginBottom: 4,
            }}
          >
            <span style={{ flex: 1, textAlign: 'left' }}>{t('skillChip.none')}</span>
            {!selected && (
              <Icon name="check" size={15} style={{ color: 'var(--accent)' }} />
            )}
          </button>
          <SkillPicker
            skills={catalog}
            selected={selected ? [selected.id] : []}
            onChange={(ids) => {
              const next = ids[ids.length - 1];
              if (!next) return;
              const s = catalog.find((x) => x.id === next);
              if (s) {
                onPick(s);
                setOpen(false);
              }
            }}
            multiple={false}
            placeholder={t('skillChip.searchPlaceholder')}
            emptyHint={
              catalog.length === 0
                ? t('skillChip.emptyCatalog')
                : t('skillChip.noMatch')
            }
            maxHeight={260}
            footer={(q) =>
              canRequestMissing && onRequestMissing ? (
                <div
                  style={{
                    borderTop: '1px solid var(--border)',
                    marginTop: 4,
                    paddingTop: 4,
                  }}
                >
                  <button
                    type="button"
                    className="dd-item"
                    onClick={() => {
                      onRequestMissing(q.trim());
                      setOpen(false);
                    }}
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                <Icon name="plus" size={14} style={{ color: 'var(--accent)' }} />
                <span className="grow truncate" style={{ textAlign: 'left' }}>
                  {t('skillChip.requestMissing')}
                </span>
              </button>
            </div>
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * Sous-ensemble des utilisateurs assignables aux tâches du projet courant.
 * Si `availableAssigneeIds` est null (config non chargée / aucune équipe), on
 * retombe sur l'annuaire complet.
 *
 * Les agents IA sont exclus par défaut (le modèle historique est « pull » — un
 * agent claim, il n'est pas assigné). `includeAgents` (projets `agentsEnabled`)
 * les réintègre : un humain peut alors assigner un agent **membre** du projet
 * (le nudge se déclenche sur `task.assigned`). `availableAssigneeIds` contient
 * déjà les membres directs (agents inclus), donc seuls les agents membres
 * apparaissent ; le serveur re-valide de toute façon (agentsEnabled + membership).
 */
function pickableUsers(includeAgents = false): User[] {
  const base = includeAgents ? USERS : USERS.filter((u) => u.kind !== 'AGENT');
  if (!availableAssigneeIds || availableAssigneeIds.size === 0) return base;
  return base.filter((u) => availableAssigneeIds!.has(u.id));
}

/* ---- mention-aware comment body ---- */
function renderBody(body: string) {
  const shorts = new Set(USERS.map((u) => u.short.toLowerCase()));
  return body.split(/(@\w+)/g).map((seg, i) => {
    if (seg[0] === '@' && shorts.has(seg.slice(1).toLowerCase())) {
      return (
        <span className="mention" key={i}>
          {seg}
        </span>
      );
    }
    return <React.Fragment key={i}>{seg}</React.Fragment>;
  });
}

/* ---- mention input ---- */
function MentionInput({ onSubmit }: { onSubmit: (body: string) => void }) {
  const { t } = useTranslation('tasks');
  const [val, setVal] = useState('');
  const [sug, setSug] = useState<{ query: string; items: User[]; start: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function recompute(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = before.match(/@(\w*)$/);
    if (!m) {
      setSug(null);
      return;
    }
    const q = m[1].toLowerCase();
    const items = pickableUsers()
      .filter((u) => u.short.toLowerCase().startsWith(q) || u.name.toLowerCase().includes(q))
      .slice(0, 5);
    setSug(items.length ? { query: m[1], items, start: caret - m[0].length } : null);
  }
  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setVal(e.target.value);
    recompute(e.target.value, e.target.selectionStart);
  }
  function pick(u: User) {
    const ta = taRef.current!;
    const caret = ta.selectionStart;
    const before = val.slice(0, sug!.start);
    const after = val.slice(caret);
    const next = before + '@' + u.short + ' ' + after;
    setVal(next);
    setSug(null);
    requestAnimationFrame(() => {
      ta.focus();
      const p = (before + '@' + u.short + ' ').length;
      ta.setSelectionRange(p, p);
    });
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (sug && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pick(sug.items[0]);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') setSug(null);
  }
  function submit() {
    const t = val.trim();
    if (!t) return;
    onSubmit(t);
    setVal('');
    setSug(null);
  }
  return (
    <div className="mi">
      <div className="mi-box">
        <Avatar user={userById[currentUser]} size={28} />
        <div className="grow" style={{ position: 'relative' }}>
          <textarea
            ref={taRef}
            value={val}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={t('comment.placeholder')}
            rows={2}
          />
          {sug && (
            <div className="mi-sug">
              {sug.items.map((u, i) => (
                <button key={u.id} className={'mi-sug-item' + (i === 0 ? ' mi-sug-on' : '')} onClick={() => pick(u)}>
                  <Avatar user={u} size={22} title={false} />
                  <span className="mi-sug-name">{u.name}</span>
                  <span className="mi-sug-role">{u.role}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <span className="mi-hint">{t('comment.sendHint')}</span>
        <button className="btn btn-accent btn-sm" onClick={submit} disabled={!val.trim()}>
          {t('comment.submit')}
        </button>
      </div>
    </div>
  );
}

interface ToastInput {
  actor: User;
  text: string;
  warn?: boolean;
}

/**
 * Hook : pour la tâche courante, résout les jours fériés à signaler.
 *   - Si la tâche a au moins un assignee : on prend le pays de chacun
 *     (User.countryCode, ou défaut org si null).
 *   - Sinon : on prend uniquement le pays par défaut de l'organisation.
 * Retourne une fonction `(offset:number|null) => HolidayHit[]` à utiliser
 * sur les champs date pour décider d'afficher l'avertissement.
 */
function useTaskHolidayCheck(task: Task, monday: Date) {
  const [orgDefault, setOrgDefault] = useState<string | null>(null);
  const [maps, setMaps] = useState<Map<string, Map<string, string>> | null>(null);

  // Charge le défaut org une seule fois.
  useEffect(() => {
    let cancelled = false;
    getOrgDefaultCountry().then((c) => {
      if (!cancelled) setOrgDefault(c);
    });
    return () => { cancelled = true; };
  }, []);

  // Pays pertinents pour cette tâche. Dépend du défaut org + des assignees.
  const countries = useMemo(() => {
    const out = new Set<string>();
    if (task.assignees.length > 0) {
      for (const uid of task.assignees) {
        const u = USERS.find((x) => x.id === uid);
        const cc = (u?.countryCode || orgDefault || '').toUpperCase();
        if (/^[A-Z]{2}$/.test(cc)) out.add(cc);
      }
    } else if (orgDefault) {
      out.add(orgDefault.toUpperCase());
    }
    return out;
  }, [task.assignees, orgDefault]);

  // Dates concernées pour borner les années à charger (start, due, aujourd'hui en filet).
  const dates = useMemo(() => {
    const arr: Date[] = [new Date()];
    if (task.start != null) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + task.start);
      arr.push(d);
    }
    if (task.due != null) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + task.due);
      arr.push(d);
    }
    return arr;
  }, [task.start, task.due, monday]);

  useEffect(() => {
    let cancelled = false;
    if (countries.size === 0) {
      setMaps(null);
      return;
    }
    loadHolidaysFor(countries, dates).then((m) => {
      if (!cancelled) setMaps(m);
    });
    return () => { cancelled = true; };
  }, [countries, dates]);

  return (offset: number | null | undefined): HolidayHit[] => {
    if (offset == null || !maps) return [];
    const d = new Date(monday);
    d.setDate(monday.getDate() + offset);
    return holidayHitsFor(d, maps);
  };
}

/** Petit warning sous un champ date quand celui-ci tombe sur un férié. */
function DependencyWarning({
  conflicts,
  monday,
}: {
  conflicts: { predTitle: string; predDue: number; minStart: number; lagDays: number; anchorIsStart?: boolean }[];
  monday: Date;
}) {
  if (conflicts.length === 0) return null;
  const f = useFormat();
  const { t } = useTranslation('tasks');
  const fmtOffset = (off: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + off);
    return f.dayMonth(d);
  };
  return (
    <div
      style={{
        marginTop: 4,
        padding: '6px 10px',
        borderRadius: 6,
        border: '1px solid oklch(from oklch(0.65 0.18 25) l c h / 0.40)',
        background: 'oklch(from oklch(0.65 0.18 25) l c h / 0.10)',
        fontSize: 11.5,
        lineHeight: 1.4,
        color: 'oklch(0.78 0.18 25)',
      }}
      title={t('dep.conflictTooltip')}
    >
      <div className="row gap1" style={{ alignItems: 'center', fontWeight: 600 }}>
        <Icon name="warn" size={12} /> {t('dep.conflictTitle')}
      </div>
      {conflicts.map((c, i) => (
        <div key={i} style={{ marginTop: 2, color: 'var(--text-1)' }}>
          <strong>{c.predTitle}</strong> {t(c.anchorIsStart ? 'dep.startsOn' : 'dep.endsOn')}{' '}
          <span className="mono">{fmtOffset(c.predDue)}</span>
          {c.lagDays !== 0 && (
            <span className="mono" style={{ color: 'var(--text-3)' }}>
              {' '}{t('dep.lag', { lag: `${c.lagDays > 0 ? '+' : ''}${c.lagDays}` })}
            </span>
          )}
          {' '}{t('dep.expectedStart', { date: fmtOffset(c.minStart) })}
        </div>
      ))}
    </div>
  );
}

function DependencyGapWarning({
  gaps,
  monday,
}: {
  gaps: { predTitle: string; predDue: number; minStart: number; lagDays: number; gapDays: number; anchorIsStart?: boolean }[];
  monday: Date;
}) {
  if (gaps.length === 0) return null;
  const f = useFormat();
  const { t } = useTranslation('tasks');
  const fmtOffset = (off: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + off);
    return f.dayMonth(d);
  };
  return (
    <div
      style={{
        marginTop: 4,
        padding: '6px 10px',
        borderRadius: 6,
        border: '1px solid oklch(from oklch(0.75 0.18 85) l c h / 0.45)',
        background: 'oklch(from oklch(0.75 0.18 85) l c h / 0.10)',
        fontSize: 11.5,
        lineHeight: 1.4,
        color: 'oklch(0.85 0.18 85)',
      }}
      title={t('dep.lateStartTooltip')}
    >
      <div className="row gap1" style={{ alignItems: 'center', fontWeight: 600 }}>
        <Icon name="warn" size={12} /> {t('dep.lateStartTitle')}
      </div>
      {gaps.map((g, i) => (
        <div key={i} style={{ marginTop: 2, color: 'var(--text-1)' }}>
          {t(g.anchorIsStart ? 'dep.startsAfterStart' : 'dep.startsAfter', { days: g.gapDays, title: g.predTitle })}
          {' '}<span className="mono" style={{ color: 'var(--text-3)' }}>({fmtOffset(g.predDue)})</span>.
        </div>
      ))}
    </div>
  );
}

function HolidayWarning({ hits }: { hits: HolidayHit[] }) {
  const { t } = useTranslation('tasks');
  if (hits.length === 0) return null;
  // Groupe par nom (souvent identique entre pays voisins) → liste des pays par nom.
  const byName = new Map<string, string[]>();
  for (const h of hits) {
    const arr = byName.get(h.name) ?? [];
    arr.push(h.country);
    byName.set(h.name, arr);
  }
  const parts: string[] = [];
  for (const [name, ccs] of byName) parts.push(`${name} (${ccs.join(', ')})`);
  return (
    <div
      className="row gap1"
      style={{
        marginTop: 4,
        fontSize: 11.5,
        color: 'oklch(0.72 0.16 60)',
        alignItems: 'center',
        lineHeight: 1.35,
      }}
      title={t('dep.holidayTooltip')}
    >
      <Icon name="warn" size={12} />
      <span>{t('dep.holiday', { holidays: parts.join(' · ') })}</span>
    </div>
  );
}

/* ============================================================ RÉCURRENCE
   Section autonome : charge et écrit sa propre récurrence. Poser une
   récurrence crée des copies de CETTE tâche (le modèle) au rythme choisi. */
function RecurrenceSection({ taskId }: { taskId: string }) {
  const { t } = useTranslation('tasks');
  const { can } = useAuth();
  // Poser une récurrence = fabriquer des tâches → gaté `task:update` (le back
  // renvoie 403 sinon). Un lecteur voit l'état, contrôles désactivés.
  const canEdit = can('task:update');
  const [rec, setRec] = useState<RecurringTaskDto | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiGetRecurrence(taskId)
      .then((r) => alive && setRec(r))
      .catch(() => alive && setRec(null));
    return () => {
      alive = false;
    };
  }, [taskId]);

  const apply = async (patch: Partial<UpsertRecurrenceDto> & { frequency: RecurrenceFrequency }) => {
    setBusy(true);
    try {
      // Défauts sensés selon la fréquence choisie (lundi / 1er du mois).
      const dto: UpsertRecurrenceDto = {
        frequency: patch.frequency,
        weekday: patch.frequency === 'weekly' ? (patch.weekday ?? rec?.weekday ?? 1) : null,
        monthDay: patch.frequency === 'monthly' ? (patch.monthDay ?? rec?.monthDay ?? 1) : null,
      };
      setRec(await apiUpsertRecurrence(taskId, dto));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await apiDeleteRecurrence(taskId);
      setRec(null);
    } finally {
      setBusy(false);
    }
  };

  if (rec === undefined) return null; // pas encore chargé : on ne clignote pas

  const freq = rec?.frequency ?? 'none';
  return (
    <div className="td-section">
      <div className="td-stitle row gap1">
        <Icon name="refresh" size={11} style={{ color: 'var(--text-3)', opacity: 0.7 }} />
        <span>{t('detail.recurrence')}</span>
      </div>
      <div className="row gap2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          className="td-in"
          value={freq}
          disabled={busy || !canEdit}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'none') void stop();
            else void apply({ frequency: v as RecurrenceFrequency });
          }}
        >
          <option value="none">{t('detail.recurrenceNone')}</option>
          <option value="daily">{t('detail.recurrenceDaily')}</option>
          <option value="weekly">{t('detail.recurrenceWeekly')}</option>
          <option value="monthly">{t('detail.recurrenceMonthly')}</option>
        </select>

        {rec?.frequency === 'weekly' && (
          <select
            className="td-in"
            value={rec.weekday ?? 1}
            disabled={busy || !canEdit}
            onChange={(e) => void apply({ frequency: 'weekly', weekday: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d} value={d}>
                {t('detail.weekday.' + d)}
              </option>
            ))}
          </select>
        )}

        {rec?.frequency === 'monthly' && (
          <select
            className="td-in"
            value={rec.monthDay ?? 1}
            disabled={busy || !canEdit}
            onChange={(e) => void apply({ frequency: 'monthly', monthDay: Number(e.target.value) })}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
      </div>
      {rec && (
        <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
          {/* Sémantique « tâche-modèle » : le back clone CETTE tâche à chaque
              occurrence, donc l'éditer change les copies futures. Contre-intuitif
              → on l'explicite (cf. décision v1, pas de prompt calendrier). */}
          <div className="td-hint" style={{ color: 'var(--text-3)', fontSize: 12 }}>
            {t('detail.recurrenceHint')}
          </div>
          <div className="td-hint" style={{ color: 'var(--text-3)', fontSize: 12 }}>
            {t('detail.recurrenceNext', { date: new Date(rec.nextRunAt).toLocaleDateString() })}
            {rec.lastRunAt &&
              ' · ' + t('detail.recurrenceLast', { date: new Date(rec.lastRunAt).toLocaleDateString() })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================ PANEL */
// Catalogue de skills + maxLevel mis en cache côté module pour éviter de
// refetcher à chaque ouverture du panneau. Invalidé naturellement à chaque
// reload de la page (suffisant pour cette donnée à faible volatilité).
const skillsCatalogCache: { current: SkillDto[] | null } = { current: null };
const skillsMaxLevelCache: { current: number } = { current: 10 };

export function TaskDetail({
  task,
  monday,
  projectId,
  foreign,
  comments,
  entries,
  allTasks,
  onClose,
  onUpdate,
  onUpdateOther,
  onMoveColumn,
  onAddComment,
  onAddTime,
  onToggleCheck,
  onDelete,
  pushToast,
  onCreateLabel,
  subStatuses = [],
}: {
  task: Task;
  monday: Date;
  /** Permet de fetcher les dépendances du projet pour avertir des violations
   *  FS quand l'utilisateur change la start date manuellement. */
  projectId?: string;
  /** Vrai si la tâche appartient à un autre projet que celui actuellement
   *  ouvert (ex. ouverture depuis la vue Workload en scope global). Affiche un
   *  bandeau d'avertissement. */
  foreign?: boolean;
  comments: Comment[];
  entries: TimeEntry[];
  allTasks: Task[];
  onClose: () => void;
  onUpdate: (patch: Partial<Task>) => void;
  /** Optimistic update for ANOTHER task (used by cascade flows). Falls back to direct API if absent. */
  onUpdateOther?: (id: string, patch: Partial<Task>) => void;
  /** Déplace la tâche vers une colonne (persiste le statut via l'API move).
   *  `completePredecessors` autorise la clôture en cascade des prédécesseurs. */
  onMoveColumn?: (columnId: string, opts?: { completePredecessors?: boolean }) => void;
  onAddComment: (body: string) => void;
  onAddTime: (entry: TimeEntry) => void;
  onToggleCheck: (itemId: string) => void;
  onDelete: () => void;
  pushToast: (t: ToastInput) => void;
  /** Crée un label dans le projet et renvoie le label réel (id serveur) ou null. */
  onCreateLabel?: (name: string) => Promise<{ id: string } | null>;
  /** Sous-statuts (Custom Status) applicables au projet courant. Le sélecteur
   *  n'offre que ceux du statut courant de la tâche (changer de phase se fait
   *  par le statut, pas par le sous-statut). */
  subStatuses?: BoardSubStatus[];
}) {
  const fmtDate = useFormat();
  const { t } = useTranslation('tasks');
  const confirm = useConfirm();
  const { orgSettings, can } = useAuth();
  const levelScale = orgSettings.skillsLevelScale;

  // Onglets du panneau (redesign « tabbed ») : un seul jeu de contenu visible
  // à la fois pour réduire le scroll « tout en même temps ». Les avertissements
  // et le récapitulatif restent au-dessus des onglets (jamais masqués).
  const [tab, setTab] = useState<'details' | 'fields' | 'planning' | 'time' | 'ai' | 'activity'>('details');

  // Nombre de champs personnalisés applicables : sert à n'afficher l'onglet
  // « Champs » que s'il y en a (comme l'onglet IA). Le contenu est rendu par
  // CustomFieldValuesSection, qui recharge sa propre donnée à l'ouverture.
  const [cfCount, setCfCount] = useState<number>(0);
  useEffect(() => {
    if (foreign) { setCfCount(0); return; }
    let alive = true;
    apiGetTaskCustomFields(task.id)
      .then((rows) => { if (alive) setCfCount(rows.length); })
      .catch(() => { if (alive) setCfCount(0); });
    return () => { alive = false; };
  }, [task.id, foreign]);

  // Le projet effectif de la tâche : on résout par `projectId` (prop) ou par
  // le champ `projectId` posé sur la tâche au moment du toVaksTask. Fallback
  // PROJECTS[0] uniquement si rien n'est trouvé (cas dégradé maquette).
  // Déclaré ici (haut du composant) car des effets ci-dessous (onglet AI) le lisent.
  const proj =
    PROJECTS.find((p) => p.id === (projectId ?? task.projectId)) ?? PROJECTS[0];

  // ---- Activité agent (onglet AI) : runs déclarés + coût déclaré vs référence
  // + anomalies + budget par tâche. Rechargé à l'ouverture de l'onglet. ----
  const [aiActivity, setAiActivity] = useState<TaskAgentActivityDto | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  useEffect(() => {
    if (tab !== 'ai' || foreign || !proj?.agentsEnabled) return;
    let alive = true;
    setAiLoading(true);
    api.getTaskAgentActivity(task.id)
      .then((a) => { if (alive) setAiActivity(a); })
      .catch(() => { if (alive) setAiActivity(null); })
      .finally(() => { if (alive) setAiLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, task.id, foreign, proj?.agentsEnabled]);

  // ---- Watchers : abonnement passif (suivre sans être assigné) ----
  const [watchers, setWatchers] = useState<WatcherDto[]>([]);
  const [watching, setWatching] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const { user: authUser } = useAuth();
  const watcherCount = watchers.length;
  useEffect(() => {
    let alive = true;
    // La liste sert au compteur, à l'état du bouton ET à l'infobulle « qui suit »
    // — un seul appel pour les trois.
    apiListTaskWatchers(task.id)
      .then((ws) => {
        if (!alive) return;
        setWatchers(ws);
        setWatching(ws.some((w) => w.userId === authUser?.id));
      })
      .catch(() => {
        /* best-effort : le suivi ne doit jamais casser l'ouverture du détail */
      });
    return () => {
      alive = false;
    };
  }, [task.id, authUser?.id]);

  const toggleWatch = async () => {
    if (watchBusy) return;
    setWatchBusy(true);
    const next = !watching;
    const before = watchers;
    // Optimiste : le bouton répond tout de suite, on rollback si l'API refuse.
    setWatching(next);
    setWatchers((ws) =>
      next
        ? [...ws, { id: 'tmp', userId: authUser?.id ?? '', name: authUser?.name ?? '', email: authUser?.email ?? '' }]
        : ws.filter((w) => w.userId !== authUser?.id),
    );
    try {
      await (next ? apiWatchTask(task.id) : apiUnwatchTask(task.id));
      // Resynchronise (récupère l'id réel de la ligne créée côté serveur).
      apiListTaskWatchers(task.id).then(setWatchers).catch(() => undefined);
    } catch {
      setWatching(!next);
      setWatchers(before);
      pushToast({ actor: userById[currentUser], text: t('detail.watchFailed'), warn: true });
    } finally {
      setWatchBusy(false);
    }
  };
  const [manual, setManual] = useState<{ hours: string; note: string; date: string }>({
    hours: '',
    note: '',
    // Jour travaillé = aujourd'hui par défaut (UTC, cohérent avec la grille
    // timesheet qui mappe les jours en offsets UTC depuis le lundi).
    date: new Date().toISOString().slice(0, 10),
  });
  // Création de label en ligne depuis le dropdown des labels.
  const [newLabelName, setNewLabelName] = useState('');
  const submitNewLabel = async () => {
    const name = newLabelName.trim();
    if (!name || !onCreateLabel) return;
    const created = await onCreateLabel(name);
    if (created) onUpdate({ labels: [...task.labels, created.id] });
    setNewLabelName('');
  };
  // Wrap onUpdate : si on touche à start ou estimate ET que la due est null,
  // on auto-suggère la due la plus courte en fonction du nombre d'assignees.
  // L'utilisateur peut toujours surcharger ensuite (on ne touche pas une due
  // déjà posée). Demandé pour fluidifier la création de plan.
  const onUpdateAuto = useCallback(
    (patch: Partial<Task>) => {
      const touchedStartOrEstimate = 'start' in patch || 'estimate' in patch;
      const nextStart = 'start' in patch ? patch.start : task.start;
      const nextEstimate = 'estimate' in patch ? patch.estimate : task.estimate;
      const nextDue = 'due' in patch ? patch.due : task.due;
      if (
        touchedStartOrEstimate &&
        nextStart != null &&
        nextEstimate != null &&
        nextEstimate > 0 &&
        nextDue == null
      ) {
        const suggested = computeSuggestedDueOffset(
          nextStart,
          nextEstimate,
          task.assignees?.length ?? 0,
          monday,
          orgSettings.hoursPerDay,
        );
        onUpdate({ ...patch, due: suggested });
      } else {
        onUpdate(patch);
      }
    },
    [task.start, task.estimate, task.due, task.assignees, monday, onUpdate],
  );
  // Patch d'une AUTRE tâche (ex. successeurs à décaler quand on change la due).
  // Utilise le hook parent s'il existe (maj du board en mémoire), sinon
  // persiste directement via l'API.
  const patchOtherTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      if (onUpdateOther) onUpdateOther(id, patch);
      else
        apiPatchTask(id, patch, monday).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('apiPatchTask failed', err);
          alert((err as Error).message);
        });
    },
    [onUpdateOther, monday],
  );

  // Prompt « décaler les tâches dépendantes » quand on modifie la due date.
  // Propagation transitive : chaque tâche décalée conserve sa durée (la due
  // suit le start), ce qui fait cascader le décalage à TOUTE la chaîne FS.
  const [depShiftPrompt, setDepShiftPrompt] = useState<{
    successors: {
      id: string;
      title: string;
      oldStart: number | null;
      newStart: number;
      oldDue: number | null;
      newDue: number | null;
    }[];
  } | null>(null);

  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);
  const [attView, setAttView] = useState<AttachmentDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---------- Skills (catalogue org + suggestions assignees) ----------
  // Le catalogue est org-global, chargé une fois et caché en module-level
  // dans skillsCatalogCache pour éviter de fetcher à chaque ouverture d'un
  // TaskDetail. Les suggestions d'assignees, elles, sont fetchées par tâche
  // et rafraîchies quand task.id / task.requiredSkillId / fenêtre changent.
  const [skillsCatalog, setSkillsCatalog] = useState<SkillDto[]>(
    () => skillsCatalogCache.current ?? [],
  );
  const [skillsMaxLevel, setSkillsMaxLevel] = useState<number>(skillsMaxLevelCache.current);
  const [suggestions, setSuggestions] = useState<AssigneeSuggestionDto[]>([]);
  useEffect(() => {
    if (skillsCatalog.length > 0) return;
    api.listSkills()
      .then((list) => {
        skillsCatalogCache.current = list;
        setSkillsCatalog(list);
      })
      .catch(() => { /* non bloquant */ });
    api.getPublicSettings()
      .then((s) => {
        const n = s?.skillsMaxLevel;
        if (typeof n === 'number' && n >= 1 && n <= 100) {
          skillsMaxLevelCache.current = n;
          setSkillsMaxLevel(n);
        }
      })
      .catch(() => { /* défaut 10 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const requiredSkill = useMemo(
    () => skillsCatalog.find((s) => s.id === task.requiredSkillId) ?? null,
    [skillsCatalog, task.requiredSkillId],
  );
  useEffect(() => {
    // (Re)charge les suggestions à chaque changement de tâche ou de skill.
    let cancelled = false;
    const from = task.start != null
      ? new Date(monday.getTime() + task.start * 86_400_000).toISOString().slice(0, 10)
      : undefined;
    const to = task.due != null
      ? new Date(monday.getTime() + task.due * 86_400_000).toISOString().slice(0, 10)
      : undefined;
    api.suggestAssignees(task.id, { from, to })
      .then((rows) => { if (!cancelled) setSuggestions(rows); })
      .catch(() => { /* non bloquant */ });
    return () => { cancelled = true; };
  }, [task.id, task.requiredSkillId, task.requiredSkillLevel, task.start, task.due, monday]);

  // Catalogue restreint au périmètre des équipes du projet (soft scoping).
  // `scoped=false` ⇒ aucune équipe sur le projet ⇒ fallback catalogue complet.
  const [scopedSkills, setScopedSkills] = useState<SkillDto[] | null>(null);
  const [skillsScoped, setSkillsScoped] = useState(false);
  const [canRequestSkill, setCanRequestSkill] = useState(false);
  const [requestModal, setRequestModal] = useState<{ initialName: string } | null>(null);
  // Picker d'assignés : par défaut on filtre sur le skill requis ; ce flag
  // lève le filtre pour montrer tous les membres. Remis à false quand le
  // skill requis change (sinon on garderait un filtre levé hors contexte).
  const [showAllAssignees, setShowAllAssignees] = useState(false);
  useEffect(() => {
    setShowAllAssignees(false);
  }, [task.requiredSkillId, task.requiredSkillLevel]);
  useEffect(() => {
    const pid = projectId ?? task.projectId;
    if (!pid) {
      setScopedSkills(null);
      return;
    }
    let cancelled = false;
    api
      .availableProjectSkills(pid)
      .then((r) => {
        if (cancelled) return;
        setScopedSkills(r.skills);
        setSkillsScoped(r.scoped);
        setCanRequestSkill(!!r.canRequestSkill);
      })
      .catch(() => {
        if (!cancelled) setScopedSkills(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, task.projectId]);
  // Catalogue présenté dans le picker : périmètre projet si dispo, sinon org.
  const pickerCatalog = scopedSkills ?? skillsCatalog;
  // Le skill requis actuel est-il hors périmètre des équipes du projet ?
  const requiredSkillOutOfScope = useMemo(
    () =>
      !!requiredSkill &&
      skillsScoped &&
      scopedSkills !== null &&
      !scopedSkills.some((s) => s.id === requiredSkill.id),
    [requiredSkill, skillsScoped, scopedSkills],
  );

  const [dragOver, setDragOver] = useState(false);
  const sub = subOf(task);
  const due = fmt.due(task.due, monday);
  // Pour une tâche d'un autre projet (`foreign`), `task.col` référence une
  // colonne du board de CET autre projet, absente du store `COLUMNS` courant.
  // On retombe alors sur une colonne synthétique pour ne pas crasher (le statut
  // précis n'est pas éditable depuis ce contexte — voir bandeau d'avertissement).
  const col =
    COLUMNS.find((c) => c.id === task.col) ??
    ({ id: task.col, name: '—', status: 'todo', wip: null } as Column);
  const logged = entries.reduce((s, e) => s + e.hours, 0);
  const estPct = task.estimate ? Math.min(logged / task.estimate, 1) * 100 : 0;
  const overEst = !!task.estimate && logged > task.estimate;
  const holidayCheck = useTaskHolidayCheck(task, monday);
  const startHolidayHits = holidayCheck(task.start);
  const dueHolidayHits = holidayCheck(task.due);

  // Dépendances du projet pour avertir des violations FS (la start date ne
  // doit pas être avant la due date d'une tâche prédécesseur + lag).
  const [taskDeps, setTaskDeps] = useState<DependencyDto[]>(
    // Valeur connue servie dès le premier rendu : les warnings FS sont
    // affichés immédiatement, sans pop-in (revalidation dans l'effet).
    () => (projectId && depsCache.get(projectId)) || [],
  );
  useEffect(() => {
    if (!projectId) {
      setTaskDeps([]);
      return;
    }
    const sub = loadDepsSWR(projectId, setTaskDeps);
    return sub.cancel;
  }, [projectId]);

  /** Prédécesseurs TRANSITIFS (toutes natures de dépendance) NON terminés :
   *  on remonte toute la chaîne (prédécesseurs des prédécesseurs inclus) tant
   *  qu'on croise des tâches ouvertes ; un prédécesseur déjà terminé arrête
   *  l'exploration sur sa branche. Une tâche est « terminée » si sa colonne a
   *  le statut `done`. Sert au pré-check avant de passer la tâche à « Done ». */
  const blockingPreds = useMemo(() => {
    const isDone = (t: Task) => COLUMNS.find((c) => c.id === t.col)?.status === 'done';
    // Index prédécesseurs par successeur (toutes natures de dépendance).
    const predsOf = new Map<string, string[]>();
    for (const d of taskDeps) {
      predsOf.set(d.successorId, [...(predsOf.get(d.successorId) ?? []), d.predecessorId]);
    }
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const out: Task[] = [];
    const collected = new Set<string>();
    const visited = new Set<string>([task.id]);
    let frontier = [task.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const sid of frontier) {
        for (const pid of predsOf.get(sid) ?? []) {
          if (visited.has(pid)) continue;
          visited.add(pid);
          const pred = byId.get(pid);
          if (!pred || isDone(pred)) continue; // branche satisfaite : on s'arrête
          if (!collected.has(pid)) {
            collected.add(pid);
            out.push(pred);
          }
          next.push(pid);
        }
      }
      frontier = next;
    }
    return out;
  }, [task.id, taskDeps, allTasks]);

  // Popup affiché quand on tente de clôturer une tâche dont des prédécesseurs
  // restent ouverts. `col` = colonne « Done » cible choisie.
  const [predBlock, setPredBlock] = useState<Column | null>(null);

  // Édition de la raison de mise en pause (tâche déjà en colonne On Hold).
  const [holdEdit, setHoldEdit] = useState(false);
  const onHold = !foreign && col.status === 'hold';

  /** Sélection d'une colonne de statut dans le dropdown. Pour la colonne
   *  « Done » avec des prédécesseurs ouverts, on intercepte pour afficher le
   *  popup. Sinon on persiste directement via l'API move. */
  function pickColumn(c: Column, completePredecessors = false) {
    if (c.status === 'done' && !completePredecessors && blockingPreds.length > 0) {
      setPredBlock(c);
      return;
    }
    // Optimistic local (col + avancement 100 % pour Done) ; persistance réelle
    // via onMoveColumn (endpoint move). Fallback onUpdate si non câblé.
    onUpdate({ col: c.id, progress: c.status === 'done' ? 100 : task.progress });
    if (onMoveColumn) onMoveColumn(c.id, { completePredecessors });
  }

  /** Analyse des 4 types de dépendance sur la start date (Lot 1c.3, généralise
   *  l'ancien calcul FS-only) :
   *   - violation (rouge) : start < plancher calculé → contrainte non respectée
   *   - gap (jaune)       : start > plancher calculé → démarrage en retard
   *  FS/SS contraignent directement le start ; FF/SF contraignent la due date
   *  de CETTE tâche, ramenée à un plancher de start via sa propre durée
   *  (approximation en jours calendaires, cohérente avec le reste de l'UI —
   *  pas le CPM jours-ouvrés exact du backend). `predDue` porte l'ancre du
   *  prédécesseur pertinente pour ce type (sa due date pour FS/FF, son start
   *  pour SS/SF — `anchorIsStart` distingue les deux pour l'affichage).
   *  Calculé en une passe pour éviter de re-parcourir les deps deux fois. */
  const { startDateConflicts, startDateGaps } = useMemo(() => {
    const conflicts: { predTitle: string; predDue: number; minStart: number; lagDays: number; anchorIsStart: boolean }[] = [];
    const gaps: { predTitle: string; predDue: number; minStart: number; lagDays: number; gapDays: number; anchorIsStart: boolean }[] = [];
    if (task.start == null) return { startDateConflicts: conflicts, startDateGaps: gaps };
    const myDuration = task.due != null ? Math.max(0, task.due - task.start) : 0;
    for (const d of taskDeps) {
      if (d.successorId !== task.id) continue;
      const pred = allTasks.find((x) => x.id === d.predecessorId);
      if (!pred) continue;
      const lag = d.lagDays ?? 0;
      const anchorIsStart = d.type === DependencyType.SS || d.type === DependencyType.SF;
      const predAnchor = anchorIsStart ? pred.start : pred.due;
      if (predAnchor == null) continue;
      const constrainsEnd = d.type === DependencyType.FF || d.type === DependencyType.SF;
      const rawConstraint = predAnchor + lag;
      const minStart = constrainsEnd ? rawConstraint - myDuration : rawConstraint;
      if (task.start < minStart) {
        conflicts.push({ predTitle: pred.title, predDue: predAnchor, minStart, lagDays: lag, anchorIsStart });
      } else if (task.start > minStart) {
        gaps.push({
          predTitle: pred.title, predDue: predAnchor, minStart, lagDays: lag,
          gapDays: task.start - minStart, anchorIsStart,
        });
      }
    }
    return { startDateConflicts: conflicts, startDateGaps: gaps };
  }, [task.id, task.start, task.due, taskDeps, allTasks]);

  /**
   * Quand la due date de cette tâche change, calcule la cascade complète des
   * décalages le long de la chaîne de dépendances FS.
   *
   *  - On parcourt le graphe de dépendances (4 types, Lot 1c.3 — avant : FS
   *    seul) en ordre topologique (prédécesseurs avant successeurs), en
   *    injectant la NOUVELLE due pour la tâche courante.
   *  - Pour chaque tâche, contrainte de START = max sur ses prédécesseurs de
   *    l'ancre pertinente + lag (due effective pour FS, start effectif pour
   *    SS ; pour FF/SF la contrainte porte sur la DUE de cette tâche,
   *    ramenée à un plancher de start via sa propre durée — approximation
   *    calendaire, cohérente avec le reste de l'UI). Si elle démarre trop tôt
   *    (ou n'a pas de start), on la décale à cette contrainte ; sinon (gap
   *    volontaire) on la laisse — et la cascade s'arrête sur cette branche
   *    (sa due ne bouge pas).
   *  - Une tâche décalée CONSERVE sa durée : la due suit le start du même
   *    delta, ce qui propage le décalage à ses propres successeurs.
   *
   * Retourne la liste des tâches à décaler (start + due), hors tâche courante.
   */
  function computeDependentShifts(newDue: number | null) {
    const out: {
      id: string;
      title: string;
      oldStart: number | null;
      newStart: number;
      oldDue: number | null;
      newDue: number | null;
    }[] = [];
    if (newDue == null) return out;

    // Graphe limité aux tâches connues, TOUS types de dépendance (avant :
    // FS seul — SS/FF/SF ne débloquaient/décalaient jamais rien).
    const known = new Set(allTasks.map((t) => t.id));
    const deps = taskDeps.filter(
      (d) => known.has(d.predecessorId) && known.has(d.successorId),
    );
    const predsOf = new Map<string, { pred: string; lag: number; type: DependencyType }[]>();
    const succsOf = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    for (const id of known) indeg.set(id, 0);
    for (const d of deps) {
      predsOf.set(d.successorId, [
        ...(predsOf.get(d.successorId) ?? []),
        { pred: d.predecessorId, lag: d.lagDays ?? 0, type: d.type },
      ]);
      succsOf.set(d.predecessorId, [...(succsOf.get(d.predecessorId) ?? []), d.successorId]);
      indeg.set(d.successorId, (indeg.get(d.successorId) ?? 0) + 1);
    }

    // Tri topologique (Kahn). En cas de cycle (théoriquement bloqué côté
    // serveur), les nœuds restants sont simplement ignorés.
    const work = new Map(indeg);
    const queue: string[] = [];
    for (const [id, deg] of work) if (deg === 0) queue.push(id);
    const order: string[] = [];
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const s of succsOf.get(n) ?? []) {
        work.set(s, (work.get(s) ?? 0) - 1);
        if ((work.get(s) ?? 0) === 0) queue.push(s);
      }
    }

    // Dues/starts effectifs propagés le long de la chaîne (SS/SF ont besoin du
    // start effectif du prédécesseur, pas seulement de sa due).
    const effDue = new Map<string, number | null>();
    const effStart = new Map<string, number | null>();
    for (const t of allTasks) {
      effDue.set(t.id, t.due ?? null);
      effStart.set(t.id, t.start ?? null);
    }
    effDue.set(task.id, newDue);
    const anchorFor = (predId: string, type: DependencyType): number | null =>
      type === DependencyType.SS || type === DependencyType.SF
        ? effStart.get(predId) ?? null
        : effDue.get(predId) ?? null;

    for (const id of order) {
      if (id === task.id) continue; // sa due est fixée par l'utilisateur
      const preds = predsOf.get(id) ?? [];
      if (!preds.length) continue;
      const t = allTasks.find((x) => x.id === id);
      if (!t) continue;
      // Durée courante de CETTE tâche (jours calendaires) — sert à convertir
      // une contrainte FF/SF (posée sur sa due) en plancher de start.
      const myDuration = t.start != null && t.due != null ? Math.max(0, t.due - t.start) : 0;
      let constraint: number | null = null;
      for (const { pred, lag, type } of preds) {
        const anchor = anchorFor(pred, type);
        if (anchor == null) continue;
        const raw = anchor + lag;
        const constrainsEnd = type === DependencyType.FF || type === DependencyType.SF;
        const c = constrainsEnd ? raw - myDuration : raw;
        if (constraint == null || c > constraint) constraint = c;
      }
      if (constraint == null) continue;
      const oldStart = t.start ?? null;
      // Gap volontaire : la tâche démarre déjà après la contrainte → on ne
      // touche pas, et la cascade s'arrête ici (sa due ne bouge pas).
      if (oldStart != null && oldStart >= constraint) continue;
      const newStart = constraint;
      // Conserve la durée : décale la due du même delta (si start+due connus).
      const oldDue = t.due ?? null;
      const computedNewDue =
        oldStart != null && oldDue != null ? oldDue + (newStart - oldStart) : oldDue;
      effDue.set(id, computedNewDue);
      effStart.set(id, newStart);
      out.push({ id, title: t.title, oldStart, newStart, oldDue, newDue: computedNewDue });
    }
    return out;
  }

  useEffect(() => {
    function esc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Charge les pièces jointes quand le panneau ouvre une tâche.
  useEffect(() => {
    let cancelled = false;
    apiListAttachments(task.id)
      .then((rows) => { if (!cancelled) setAttachments(rows); })
      .catch(() => { if (!cancelled) setAttachments([]); });
    return () => { cancelled = true; };
  }, [task.id]);

  async function handleUpload(files: FileList | File[]) {
    const arr = Array.from(files);
    if (!arr.length) return;
    setUploading(true);
    try {
      for (const f of arr) {
        try {
          const att = await apiUploadAttachment(task.id, f);
          setAttachments((prev) => [att, ...prev]);
        } catch (e) {
          pushToast({ actor: userById[currentUser], text: t('detail.uploadFailed', { message: (e as Error).message }), warn: true });
        }
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteAttachment(id: string) {
    const snapshot = attachments;
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await apiDeleteAttachment(id);
    } catch (e) {
      setAttachments(snapshot);
      pushToast({ actor: userById[currentUser], text: t('detail.deleteFailed', { message: (e as Error).message }), warn: true });
    }
  }

  function addManual() {
    const h = parseFloat(manual.hours);
    if (!h || h <= 0) return;
    // Offset jours depuis le lundi en UTC — même convention que daysFromMonday /
    // la reconstruction de date dans Workspace.addTime. (Surtout PAS isoToDueOffset
    // qui travaille en local et décalerait d'un jour dans certains fuseaux.)
    const [y, m, d] = manual.date.split('-').map(Number);
    const day = Math.round((Date.UTC(y, m - 1, d) - monday.getTime()) / 86_400_000);
    onAddTime({ id: 'e' + Date.now(), user: currentUser, day, hours: h, note: manual.note || t('detail.timeLoggedDefault') });
    setManual((prev) => ({ ...prev, hours: '', note: '' }));
  }

  return (
    <div className="td-overlay">
      <div className="td-scrim" onClick={onClose} />
      <aside className="td-drawer" role="dialog" aria-label={t('detail.dialogLabel')}>
        {/* header */}
        <div className="td-head">
          <div className="row gap2" style={{ minWidth: 0 }}>
            <span className="td-pkey mono" style={{ color: `oklch(0.6 0.15 ${proj.color})` }}>
              {proj.key}
            </span>
            <span className="mono td-key">{task.key}</span>
          </div>
          <div className="row gap1">
            <button
              className="btn btn-sm btn-ghost"
              onClick={toggleWatch}
              disabled={watchBusy}
              // L'infobulle liste les abonnés : le compteur seul ne dit pas QUI
              // suit, et c'est la question qu'on se pose en le voyant.
              title={
                (watching ? t('detail.unwatch') : t('detail.watch')) +
                (watcherCount > 0
                  ? `\n${t('detail.watchers')} : ${watchers.map((w) => w.name).join(', ')}`
                  : '')
              }
              aria-label={watching ? t('detail.unwatch') : t('detail.watch')}
              aria-pressed={watching}
              style={
                watching
                  ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
                  : undefined
              }
            >
              <Icon name="eye" size={16} />
              {watching ? t('detail.watchingBtn') : t('detail.watchBtn')}
              {watcherCount > 0 && (
                <span className="mono" style={{ fontSize: 11, marginLeft: 1 }}>
                  {watcherCount}
                </span>
              )}
            </button>
            <Dropdown
              align="right"
              width={180}
              trigger={
                <button className="icon-btn" title={t('detail.more')} aria-label={t('detail.moreActions')}>
                  <Icon name="dots" size={18} />
                </button>
              }
            >
              <button
                className="dd-item"
                style={{ color: 'oklch(0.72 0.18 25)' }}
                onClick={async () => {
                  if (await confirm({ title: t('common:delete'), message: t('confirmDelete', { title: task.title }), confirmLabel: t('common:delete'), danger: true })) {
                    onDelete();
                  }
                }}
              >
                <Icon name="x" size={14} /> {t('detail.deleteTask')}
              </button>
            </Dropdown>
            <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
              <Icon name="x" size={18} />
            </button>
          </div>
        </div>

        <div className="td-body">
          {foreign && (
            <div className="td-foreign-banner" role="note">
              <Icon name="warn" size={14} />
              <span>
                {t('detail.foreignBanner')}
                {proj?.name ? <> — <b>{proj.name}</b></> : null}
              </span>
            </div>
          )}
          {/* title (cliquable / éditable — pencil affordance) */}
          <div className="td-editable td-title-wrap" style={{ position: 'relative' }}>
            <textarea
              className="td-title"
              value={task.title}
              rows={1}
              onChange={(e) => onUpdate({ title: e.target.value })}
              onInput={(e) => {
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = el.scrollHeight + 'px';
              }}
            />
            <Icon
              name="pencil"
              size={13}
              className="td-edit-hint"
              style={{
                position: 'absolute',
                top: 8,
                right: 6,
                color: 'var(--text-3)',
                pointerEvents: 'none',
                opacity: 0.5,
              }}
            />
          </div>

          {/* Récapitulatif (lecture seule) : statut · priorité · assignés · échéance.
              Toujours visible, quel que soit l'onglet actif. */}
          <div className="td-summary">
            <span className="td-summary-item">
              <span className="col-dot" data-status={col.status} />
              <span>{col.name !== '—' ? localizeColName(col.name, t) : `${task.progress}%`}</span>
            </span>
            <span className="td-summary-sep" />
            <PriorityDot level={task.priority} withLabel />
            <span className="td-summary-sep" />
            {task.assignees.length > 0 ? (
              <AvatarStack ids={task.assignees} size={22} />
            ) : (
              <span className="td-empty">{t('detail.unassigned')}</span>
            )}
            <span className="td-summary-sep" />
            {task.due != null && due ? (
              <span
                className="td-summary-item mono"
                style={{
                  color: due.overdue
                    ? 'var(--danger)'
                    : due.today
                      ? 'var(--accent)'
                      : 'var(--text-2)',
                }}
              >
                <Icon name="cal" size={14} /> {due.label}
              </span>
            ) : (
              <span className="td-empty">{t('detail.noDue')}</span>
            )}
          </div>

          {/* Bandeau « En pause » : visible tant que la tâche est en colonne On Hold.
              Affiche la raison courante (si saisie) et permet de l'éditer. */}
          {onHold && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                margin: '0 0 12px',
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid color-mix(in oklch, oklch(0.62 0.16 300) 40%, var(--border))',
                background: 'color-mix(in oklch, oklch(0.62 0.16 300) 10%, transparent)',
              }}
            >
              <span className="col-dot" data-status="hold" style={{ marginTop: 5 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{t('hold.banner')}</div>
                <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2, whiteSpace: 'pre-wrap' }}>
                  {task.holdReason ? task.holdReason : t('hold.noReason')}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setHoldEdit(true)}>
                {task.holdReason ? t('hold.edit') : t('hold.add')}
              </button>
            </div>
          )}
          {holdEdit && (
            <HoldReasonModal
              initial={task.holdReason ?? ''}
              onClose={() => setHoldEdit(false)}
              onSubmit={(reason) => {
                setHoldEdit(false);
                onUpdate({ holdReason: reason || null });
              }}
            />
          )}

          {/* Avertissements hissés au-dessus des onglets (jamais masqués par un onglet).
              Chaque composant se garde lui-même (rend null si rien à signaler). */}
          <DependencyGapWarning gaps={startDateGaps} monday={monday} />
          <DependencyWarning conflicts={startDateConflicts} monday={monday} />
          {task.externalBlocked && (
            <div className="td-callout td-callout-danger" role="alert">
              <Icon name="warn" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <div className="grow">
                <strong>{t('detail.blockedTitle')}</strong>{' '}
                {task.externalDependency
                  ? task.externalDependency
                  : t('detail.blockedGeneric')}
              </div>
            </div>
          )}

          {/* Barre d'onglets */}
          <div className="td-tabbar" role="tablist">
            {([
              { id: 'details' as const, label: t('detail.tabs.details') },
              // Onglet « Champs » masqué si la tâche n'a aucun champ personnalisé.
              ...(cfCount > 0 ? [{ id: 'fields' as const, label: t('detail.tabs.fields') }] : []),
              { id: 'planning' as const, label: t('detail.tabs.planning') },
              { id: 'time' as const, label: t('detail.tabs.time') },
              // Onglet IA masqué si le projet n'a pas activé les agents.
              ...(proj?.agentsEnabled ? [{ id: 'ai' as const, label: t('detail.tabs.ai') }] : []),
              { id: 'activity' as const, label: t('detail.tabs.activity'), count: comments.length },
            ]).map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={tab === tb.id}
                className={'td-tabbar-btn' + (tab === tb.id ? ' on' : '')}
                onClick={() => setTab(tb.id)}
              >
                {tb.label}
                {tb.count != null && tb.count > 0 && (
                  <span className="td-tabbar-cnt mono">{tb.count}</span>
                )}
              </button>
            ))}
          </div>

          {/* ============ Onglet DÉTAILS : propriétés ============ */}
          {tab === 'details' && (
          <div className="td-props">
            <div className="td-prop">
              <span className="td-plabel">{t('detail.status')}</span>
              {foreign ? (
                // Tâche d'un autre projet : les colonnes du board courant ne
                // s'appliquent pas. On affiche le statut en lecture seule
                // (la progression reste visible plus bas).
                <span className="td-pval" title={t('detail.statusNotEditable')}>
                  <span className="col-dot" data-status={col.status} />{' '}
                  {col.name !== '—' ? localizeColName(col.name, t) : `${task.progress}%`}
                </span>
              ) : (
                <Dropdown
                  width={180}
                  trigger={
                    <button className="td-pval td-select">
                      <span className="col-dot" data-status={col.status} /> {localizeColName(col.name, t)}{' '}
                      <Icon name="chevDown" size={14} style={{ color: 'var(--text-3)' }} />
                    </button>
                  }
                >
                  {COLUMNS.map((c) => (
                    <button
                      key={c.id}
                      className="dd-item"
                      onClick={() => pickColumn(c)}
                    >
                      <span className="col-dot" data-status={c.status} /> {localizeColName(c.name, t)}
                    </button>
                  ))}
                </Dropdown>
              )}
            </div>

            {/* Sous-statut (Custom Status) : seulement ceux du statut courant —
                affiné dans la phase, jamais un changement de phase déguisé.
                Masqué si aucun sous-statut applicable. */}
            {!foreign &&
              (() => {
                const colSubs = subStatuses.filter((s) => s.status === col.status);
                if (colSubs.length === 0) return null;
                const current = colSubs.find((s) => s.id === task.subStatusId);
                return (
                  <div className="td-prop">
                    <span className="td-plabel">{t('detail.subStatus')}</span>
                    <Dropdown
                      width={200}
                      trigger={
                        <button className="td-pval td-select">
                          <span
                            className="col-dot"
                            style={current?.color ? { background: current.color } : undefined}
                            data-status={col.status}
                          />{' '}
                          {current?.name ?? t('detail.subStatusNone')}{' '}
                          <Icon name="chevDown" size={14} style={{ color: 'var(--text-3)' }} />
                        </button>
                      }
                    >
                      <button className="dd-item" onClick={() => onUpdate({ subStatusId: null })}>
                        <span className="col-dot" data-status={col.status} /> {t('detail.subStatusNone')}
                      </button>
                      {colSubs.map((s) => (
                        <button
                          key={s.id}
                          className="dd-item"
                          onClick={() => onUpdate({ subStatusId: s.id })}
                        >
                          <span
                            className="col-dot"
                            style={s.color ? { background: s.color } : undefined}
                            data-status={col.status}
                          />{' '}
                          {s.name}
                        </button>
                      ))}
                    </Dropdown>
                  </div>
                );
              })()}

            <div className="td-prop">
              <span className="td-plabel">{t('detail.priority')}</span>
              <Dropdown
                width={160}
                trigger={
                  <button className="td-pval td-select">
                    <PriorityDot level={task.priority} withLabel /> <Icon name="chevDown" size={14} style={{ color: 'var(--text-3)' }} />
                  </button>
                }
              >
                {(['urgent', 'high', 'normal', 'low'] as Priority[]).map((p) => (
                  <button key={p} className="dd-item" onClick={() => onUpdate({ priority: p })}>
                    <PriorityDot level={p} withLabel />
                  </button>
                ))}
              </Dropdown>
            </div>

            {/* Skill démoté après l'échéance (ordre visuel via grid `order`) */}
            <div className="td-prop" style={{ order: 1 }}>
              <span className="td-plabel">{t('detail.requiredSkill')}</span>
              <div
                className="row"
                style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 6 }}
              >
                <RequiredSkillChip
                  selected={requiredSkill}
                  catalog={pickerCatalog}
                  onPick={(s) => {
                    // Niveau par défaut à la sélection : 50 % du max (arrondi sup,
                    // borné ≥ 1). Si la tâche avait déjà un niveau, on le conserve.
                    const defaultLevel = Math.max(1, Math.ceil(skillsMaxLevel / 2));
                    onUpdate({
                      requiredSkillId: s.id,
                      requiredSkillLevel: task.requiredSkillLevel ?? defaultLevel,
                    });
                  }}
                  onClear={() =>
                    onUpdate({ requiredSkillId: null, requiredSkillLevel: null })
                  }
                  canRequestMissing={canRequestSkill}
                  onRequestMissing={(initialName) =>
                    setRequestModal({ initialName })
                  }
                />
                {requiredSkillOutOfScope && (
                  <span
                    title={t('detail.outOfScopeTitle')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#b45309',
                      background: '#fef3c7',
                      border: '1px solid #fcd34d',
                      borderRadius: 999,
                      padding: '2px 8px',
                      flexShrink: 0,
                    }}
                  >
                    <Icon name="warn" size={12} /> {t('detail.outOfTeamScope')}
                  </span>
                )}
                {requiredSkill && (() => {
                  const scaleMode =
                    orgSettings.skillsLevelInputMode === 'scale' && levelScale.length > 0;
                  const lvl =
                    task.requiredSkillLevel ??
                    Math.max(1, Math.ceil(skillsMaxLevel / 2));
                  return (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {t('detail.desiredLevel')}
                    </span>
                    {scaleMode ? (
                      <select
                        value={(labelForLevel(lvl, levelScale) ?? levelScale[0].label) as string}
                        onChange={(e) => {
                          const row = levelScale.find((r) => r.label === e.target.value);
                          if (!row) return;
                          onUpdate({ requiredSkillLevel: row.level });
                        }}
                        aria-label={t('detail.desiredLevelAria')}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          fontSize: 13,
                          minWidth: 140,
                        }}
                      >
                        {levelScale.map((r) => (
                          <option key={r.level} value={r.label}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <NumberStepper
                          value={lvl}
                          onChange={(n) => {
                            if (n == null) return;
                            const clamped = Math.max(1, Math.min(skillsMaxLevel, Math.round(n)));
                            onUpdate({ requiredSkillLevel: clamped });
                          }}
                          step={1}
                          min={1}
                          max={skillsMaxLevel}
                          width={72}
                          ariaLabel={t('detail.desiredLevelAria')}
                        />
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                          / {skillsMaxLevel}
                        </span>
                        {(() => {
                          const tier = labelForLevel(lvl, levelScale);
                          if (!tier) return null;
                          return (
                            <span
                              title={t('detail.tierConfigured', { tier })}
                              style={{
                                fontSize: 11,
                                color: 'var(--text-3)',
                                fontStyle: 'italic',
                                padding: '2px 8px',
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                borderRadius: 999,
                              }}
                            >
                              {tier}
                            </span>
                          );
                        })()}
                      </>
                    )}
                  </div>
                  );
                })()}
              </div>
            </div>

            <div className="td-prop">
              <span className="td-plabel">{t('detail.assignees')}</span>
              <div className="row gap2" style={{ flexWrap: 'wrap' }}>
                {task.assignees.length > 0 ? (
                  task.assignees.map((uid) => (
                    <span key={uid} className="td-assignee-chip">
                      <Avatar user={userById[uid]} size={22} title={false} />
                      <span className="td-assignee-name truncate">{userById[uid]?.short ?? uid.slice(0, 6)}</span>
                      <button
                        type="button"
                        className="td-assignee-x"
                        title={t('detail.removeAssignee')}
                        aria-label={t('detail.removeAssignee')}
                        onClick={() => onUpdate({ assignees: task.assignees.filter((a) => a !== uid) })}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="td-empty">{t('detail.unassigned')}</span>
                )}
                <Dropdown
                  width={320}
                  trigger={
                    <button className="td-add-btn" title={t('detail.addAssignee')}>
                      <Icon name="plus" size={15} />
                    </button>
                  }
                >
                  {(() => {
                    // Fusionne suggestions API (triées skill×dispo) + fallback
                    // local. Garde tous les pickables pour ne jamais cacher
                    // un user que la suggestion n'aurait pas renvoyé. Sur un
                    // projet agents-enabled, les agents membres sont assignables.
                    const local = pickableUsers(!!proj?.agentsEnabled);
                    const byId = new Map(local.map((u) => [u.id, u]));
                    type Row = {
                      user: User;
                      sug?: AssigneeSuggestionDto;
                    };
                    const rows: Row[] = [];
                    const seen = new Set<string>();
                    for (const s of suggestions) {
                      const u = byId.get(s.userId);
                      if (!u) continue;
                      rows.push({ user: u, sug: s });
                      seen.add(s.userId);
                    }
                    for (const u of local) {
                      if (!seen.has(u.id)) rows.push({ user: u });
                    }
                    if (rows.length === 0) {
                      return (
                        <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>
                          {t('detail.noAssignableUser')}
                        </div>
                      );
                    }
                    // Quand un skill est requis, on ne montre par défaut que
                    // les personnes qui l'atteignent au niveau souhaité (ou
                    // déjà assignées). Le bouton « voir tous les membres »
                    // lève ce filtre.
                    const filtering = !!requiredSkill && !showAllAssignees;
                    const matches = (r: Row) =>
                      task.assignees.includes(r.user.id) || r.sug?.meetsRequired === true;
                    const visible = filtering ? rows.filter(matches) : rows;
                    const hiddenCount = rows.length - visible.length;
                    const renderRow = ({ user: u, sug }: Row) => {
                      const on = task.assignees.includes(u.id);
                      const lvl = sug?.level ?? 0;
                      const meets = sug?.meetsRequired ?? true;
                      const free = sug?.availableForTask;
                      return (
                        <button
                          key={u.id}
                          className="dd-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            onUpdate({
                              assignees: on
                                ? task.assignees.filter((a) => a !== u.id)
                                : [...task.assignees, u.id],
                            });
                          }}
                          style={{ alignItems: 'center', gap: 8 }}
                        >
                          <Avatar user={u} size={22} title={false} />
                          <span
                            className="grow truncate"
                            style={{ textAlign: 'left', display: 'grid', lineHeight: 1.15 }}
                          >
                            <span>{u.name}</span>
                            {sug && (
                              <span style={{ fontSize: 11, opacity: 0.65 }}>
                                {sug.capacityHours > 0
                                  ? t('detail.freeHoursOfCapacity', { free: sug.freeHours.toFixed(0), capacity: sug.capacityHours.toFixed(0) })
                                  : t('detail.freeHours', { free: sug.freeHours.toFixed(0) })}
                              </span>
                            )}
                          </span>
                          {requiredSkill && (() => {
                            const tier = labelForLevel(lvl, levelScale);
                            const requiredLvl = task.requiredSkillLevel ?? 0;
                            const requiredTier = labelForLevel(requiredLvl, levelScale);
                            const tt = t('detail.levelTooltip', {
                              level: lvl,
                              max: skillsMaxLevel,
                              tier: tier ? t('detail.levelTierSuffix', { tier }) : '',
                              skill: requiredSkill.name,
                              required: requiredLvl
                                ? t('detail.requiredSuffix', {
                                    level: requiredLvl,
                                    tier: requiredTier ? t('detail.levelTierSuffix', { tier: requiredTier }) : '',
                                  })
                                : '',
                            });
                            return (
                            <span
                              title={tt}
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                padding: '1px 6px',
                                borderRadius: 999,
                                background: meets
                                  ? 'rgba(22,163,74,0.15)'
                                  : lvl > 0
                                    ? 'rgba(234,179,8,0.15)'
                                    : 'rgba(220,38,38,0.12)',
                                color: meets
                                  ? '#15803d'
                                  : lvl > 0
                                    ? '#92400e'
                                    : '#991b1b',
                              }}
                            >
                              {orgSettings.skillsLevelInputMode === 'scale' && levelScale.length > 0
                                ? (tier ?? (lvl > 0 ? t('detail.levelLabel', { level: lvl }) : '—'))
                                : (
                                  <>
                                    {lvl}/{skillsMaxLevel}
                                    {tier && (
                                      <span
                                        style={{
                                          marginLeft: 4,
                                          fontWeight: 400,
                                          opacity: 0.85,
                                        }}
                                      >
                                        · {tier}
                                      </span>
                                    )}
                                  </>
                                )}
                            </span>
                            );
                          })()}
                          {free === false && sug && (
                            <span
                              title={t('detail.insufficientCapacity')}
                              style={{ color: '#dc2626' }}
                            >
                              <Icon name="warn" size={14} />
                            </span>
                          )}
                          {on && (
                            <Icon
                              name="check"
                              size={15}
                              style={{ color: 'var(--accent)' }}
                            />
                          )}
                        </button>
                      );
                    };
                    return (
                      <>
                        {visible.length > 0 ? (
                          visible.map(renderRow)
                        ) : (
                          <div style={{ padding: 10, fontSize: 12, opacity: 0.7 }}>
                            {t('detail.noOneHasSkill', { skill: requiredSkill!.name })}
                          </div>
                        )}
                        {filtering && hiddenCount > 0 && (
                          <button
                            className="dd-item"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowAllAssignees(true);
                            }}
                            style={{
                              alignItems: 'center',
                              gap: 8,
                              borderTop: '1px solid var(--border)',
                              opacity: 0.85,
                            }}
                          >
                            <Icon name="users" size={14} />
                            <span className="grow truncate" style={{ textAlign: 'left' }}>
                              {t('detail.showAllMembers', { count: hiddenCount })}
                            </span>
                          </button>
                        )}
                        {filtering && canRequestSkill && (
                          <button
                            className="dd-item"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRequestModal({ initialName: requiredSkill!.name });
                            }}
                            style={{
                              alignItems: 'center',
                              gap: 8,
                              borderTop: '1px solid var(--border)',
                            }}
                          >
                            <Icon name="plus" size={14} />
                            <span className="grow truncate" style={{ textAlign: 'left' }}>
                              {t('detail.requestSkillFromLead')}
                            </span>
                          </button>
                        )}
                      </>
                    );
                  })()}
                </Dropdown>
              </div>
            </div>

            <div className="td-prop">
              <span className="td-plabel">{t('detail.startDate')}</span>
              <div>
                <StartDateRow
                  task={task}
                  monday={monday}
                  allTasks={allTasks}
                  onUpdate={onUpdateAuto}
                  onUpdateOther={(id, patch) => {
                    if (onUpdateOther) onUpdateOther(id, patch);
                    else {
                      apiPatchTask(id, patch, monday).catch((err) => {
                        // eslint-disable-next-line no-console
                        console.error('apiPatchTask failed', err);
                        alert((err as Error).message);
                      });
                    }
                  }}
                />
                <HolidayWarning hits={startHolidayHits} />
              </div>
            </div>

            <div className="td-prop">
              <span className="td-plabel">{t('detail.estimate')}</span>
              <div className="row gap1" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <EstimateField task={task} allTasks={allTasks} onUpdate={onUpdateAuto} />
                {task.start != null && task.estimate != null && task.estimate > 0 && (() => {
                  const aCount = Math.max(1, task.assignees?.length ?? 0);
                  const dailyCap = orgSettings.hoursPerDay * aCount;
                  const workDays = Math.ceil(task.estimate / dailyCap);
                  const suggested = computeSuggestedDueOffset(
                    task.start!,
                    task.estimate!,
                    task.assignees?.length ?? 0,
                    monday,
                    orgSettings.hoursPerDay,
                  );
                  const startIso = dueOffsetToIso(task.start, monday) ?? '?';
                  const dueIso = dueOffsetToIso(suggested, monday) ?? '?';
                  return (
                    <button
                      className="btn btn-ghost btn-sm"
                      title={t('detail.suggestDueTooltip', {
                        estimate: task.estimate,
                        dailyCap,
                        count: aCount,
                        who: aCount > 1 ? t('detail.assigneesParallel') : t('detail.assigneeOne'),
                        days: workDays,
                        start: startIso,
                        due: dueIso,
                      })}
                      onClick={() => {
                        onUpdate({ due: suggested });
                        const shifts = computeDependentShifts(suggested);
                        if (shifts.length) setDepShiftPrompt({ successors: shifts });
                      }}
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      {t('detail.suggestDue', { days: workDays })}
                    </button>
                  );
                })()}
              </div>
            </div>

            <div className="td-prop">
              <span className="td-plabel">{t('detail.dueDate')}</span>
              <div>
              <div className="row gap1" style={{ alignItems: 'center' }}>
                <Icon
                  name="cal"
                  size={14}
                  style={{
                    color: due?.overdue
                      ? 'var(--c-bad, oklch(0.65 0.18 25))'
                      : 'var(--text-3)',
                  }}
                />
                <input
                  type="date"
                  lang={fmtDate.locale}
                  className={
                    'td-date mono ' +
                    (due?.overdue ? 'due-over' : due?.today ? 'due-today' : '')
                  }
                  value={dueOffsetToIso(task.due, monday) ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    const off = v ? isoToDueOffset(v, monday) : null;
                    onUpdate({ due: off });
                    // Propose de décaler les tâches dépendantes (successeurs FS).
                    const shifts = computeDependentShifts(off);
                    if (shifts.length) setDepShiftPrompt({ successors: shifts });
                  }}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--line)',
                    color: 'var(--text-1)',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    colorScheme: 'dark light',
                  }}
                />
                {task.due != null && (
                  <button
                    className="icon-btn"
                    onClick={() => onUpdate({ due: null })}
                    title={t('detail.clearDueDate')}
                    style={{ width: 22, height: 22 }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
                <HolidayWarning hits={dueHolidayHits} />
              </div>
            </div>

            <div className="td-prop" style={{ order: 2 }}>
              <span className="td-plabel">{t('detail.labels')}</span>
              <div className="row gap1" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                {task.labels.length ? (
                  task.labels.map((l) => (
                    <span key={l} className="row" style={{ gap: 2, alignItems: 'center' }}>
                      <Tag id={l} />
                      <button
                        className="td-label-x"
                        title={t('detail.removeLabel')}
                        aria-label={t('detail.removeLabel')}
                        onClick={() => onUpdate({ labels: task.labels.filter((x) => x !== l) })}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="td-empty">{t('detail.noLabels')}</span>
                )}
                <Dropdown
                  width={240}
                  trigger={
                    <button className="td-add-btn" title={t('detail.addLabel')}>
                      <Icon name="plus" size={15} />
                    </button>
                  }
                >
                  {Object.values(LABELS).map((l) => {
                    const on = task.labels.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        className="dd-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUpdate({
                            labels: on
                              ? task.labels.filter((x) => x !== l.id)
                              : [...task.labels, l.id],
                          });
                        }}
                        style={{ alignItems: 'center', gap: 8 }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: `oklch(0.6 0.16 ${l.hue})`,
                          }}
                        />
                        <span className="grow truncate" style={{ textAlign: 'left' }}>
                          {l.name}
                        </span>
                        {on && <Icon name="check" size={15} style={{ color: 'var(--accent)' }} />}
                      </button>
                    );
                  })}
                  {/* Création d'un label dans le projet, directement depuis le dropdown. */}
                  {onCreateLabel && (
                    <div
                      className="row"
                      style={{ gap: 6, padding: '6px 4px 2px', marginTop: 4, borderTop: '1px solid var(--border)' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        className="td-in grow"
                        style={{ fontSize: 13 }}
                        placeholder={t('detail.newLabelPlaceholder')}
                        value={newLabelName}
                        onChange={(e) => setNewLabelName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void submitNewLabel(); }
                        }}
                      />
                      <button
                        className="btn btn-accent btn-sm"
                        disabled={!newLabelName.trim()}
                        onClick={() => void submitNewLabel()}
                      >
                        <Icon name="plus" size={13} />
                      </button>
                    </div>
                  )}
                </Dropdown>
              </div>
            </div>

            {/* Dépendance prestataire externe : compacte, entre Labels et Planning.
                Masquée sur les tickets externes (timesheet only). */}
            {!foreign && (
              <div className="td-prop" style={{ order: 2 }}>
                <span className="td-plabel">{t('detail.externalDep.title')}</span>
                <div className="row gap1" style={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 6 }}>
                  <input
                    className="td-in"
                    style={{ flex: 1, minWidth: 150, fontSize: 13 }}
                    value={task.externalDependency ?? ''}
                    placeholder={t('detail.externalDep.placeholder')}
                    maxLength={500}
                    onChange={(e) => onUpdate({ externalDependency: e.target.value })}
                  />
                  <label
                    className="row"
                    style={{
                      gap: 4,
                      fontSize: 12,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      color: task.externalBlocked ? 'oklch(0.62 0.2 25)' : 'var(--text-3)',
                      fontWeight: task.externalBlocked ? 700 : 400,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!task.externalBlocked}
                      onChange={(e) => onUpdate({ externalBlocked: e.target.checked })}
                    />
                    {t('detail.externalDep.blocked')}
                  </label>
                </div>
              </div>
            )}
          </div>
          )}

          {/* ============ Onglet PLANIFICATION ============ */}
          {tab === 'planning' && (
            <PlanningSection task={task} allTasks={allTasks} onUpdate={onUpdate} projectId={projectId ?? task.projectId ?? null} />
          )}
          {tab === 'planning' && task.isGroup && (
            <GroupChildrenSection task={task} allTasks={allTasks} />
          )}

          {/* ============ Onglet ACTIVITÉ ============ */}
          {/* description */}
          {tab === 'activity' && (
          <div className="td-section">
            <div className="td-stitle row gap1">
              <span>{t('detail.description')}</span>
              <Icon
                name="pencil"
                size={11}
                style={{ color: 'var(--text-3)', opacity: 0.7 }}
              />
            </div>
            <textarea
              className="td-desc"
              value={task.desc}
              placeholder={t('detail.descriptionPlaceholder')}
              onChange={(e) => onUpdate({ desc: e.target.value })}
              rows={3}
            />
          </div>
          )}

          {/* Récurrence (Activité) — indisponible sur une sous-tâche (on ne fabrique
              pas d'arbres récurrents) et sur les tickets externes. */}
          {tab === 'activity' && !sub && !foreign && <RecurrenceSection taskId={task.id} />}

          {/* ============ Onglet CHAMPS (champs personnalisés) ============ */}
          {tab === 'fields' && !foreign && (
            <CustomFieldValuesSection
              kind="task"
              entityId={task.id}
              pushError={(msg) => pushToast({ actor: userById[currentUser], text: msg, warn: true })}
            />
          )}

          {/* checklist (Activité) */}
          {tab === 'activity' && sub && task.checklist && (
            <div className="td-section">
              <div className="td-stitle row" style={{ justifyContent: 'space-between' }}>
                <span>{t('detail.subtasks')}</span>
                <span className="mono td-stcount">
                  {sub.done}/{sub.total}
                </span>
              </div>
              <div className="td-checkprog">
                <div className="td-checkprog-bar" style={{ width: (sub.total ? (sub.done / sub.total) * 100 : 0) + '%' }} />
              </div>
              <div className="td-checklist">
                {task.checklist.map((item) => (
                  <button
                    key={item.id}
                    className={'td-check' + (item.done ? ' td-check-on' : '')}
                    onClick={() => onToggleCheck(item.id)}
                  >
                    <span className="td-check-box">{item.done && <Icon name="check" size={13} />}</span>
                    <span className="td-check-text">{item.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ============ Onglet TEMPS ============ */}
          {tab === 'time' && (
          <div className="td-section">
            <div className="td-stitle">{t('detail.timeTracking')}</div>
            <div className="td-time-summary">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, alignItems: 'center' }}>
                <span className="mono td-time-num">
                  {logged.toFixed(2)}h <span className="td-empty">{t('detail.logged')}</span>
                </span>
                <span className="mono td-time-est td-empty" style={{ fontSize: 12 }}>
                  {task.estimate != null && task.estimate > 0
                    ? t('detail.estimated', { hours: task.estimate })
                    : t('detail.noEstimate')}
                </span>
              </div>
              {task.estimate && task.estimate > 0 ? (
                <div className="td-time-bar">
                  <div className={'td-time-fill' + (overEst ? ' over' : '')} style={{ width: Math.min(estPct, 100) + '%' }} />
                </div>
              ) : null}
              {overEst && (
                <div
                  className="td-over-note"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '8px 10px',
                    marginTop: 6,
                    borderRadius: 6,
                    background: 'oklch(0.65 0.18 25 / 0.14)',
                    border: '1px solid oklch(0.65 0.18 25 / 0.4)',
                    color: 'oklch(0.78 0.18 25)',
                    fontSize: 12,
                    lineHeight: 1.4,
                  }}
                >
                  <Icon name="warn" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong>{t('detail.overEstimateTitle', { hours: (logged - task.estimate!).toFixed(1) })}</strong>{' '}
                    {t('detail.overEstimateDetail', { logged: logged.toFixed(1), estimate: task.estimate })}
                    {' '}
                    <span style={{ opacity: 0.85 }}>
                      {t('detail.overEstimateNote')}
                    </span>
                  </span>
                </div>
              )}
              <ScheduleOverrunNote task={task} monday={monday} />
            </div>

            {/* Timer en temps réel retiré — la saisie se fait manuellement
                via le NumberStepper ci-dessous (cf. décision UX : pas de
                tracking automatique, le user saisit ses heures). */}

            <div className="td-manual">
              <NumberStepper
                value={manual.hours === '' ? null : parseFloat(manual.hours)}
                onChange={(v) =>
                  setManual((m) => ({ ...m, hours: v == null ? '' : String(v) }))
                }
                step={0.25}
                min={0}
                placeholder="0.0"
                ariaLabel={t('detail.hoursToLog')}
              />
              <span className="td-in-unit">h</span>
              <input
                type="date"
                className="td-in"
                value={manual.date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setManual((m) => ({ ...m, date: e.target.value || m.date }))}
                aria-label={t('detail.dayWorked')}
                title={t('detail.dayWorked')}
              />
              <input
                className="td-in grow"
                placeholder={t('detail.workedOnPlaceholder')}
                value={manual.note}
                onChange={(e) => setManual((m) => ({ ...m, note: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && addManual()}
              />
              <button className="btn btn-ghost btn-sm" onClick={addManual}>
                {t('common:add')}
              </button>
            </div>

            {entries.length > 0 && (
              <div className="td-entries">
                {entries.map((e) => {
                  const d = fmt.due(e.day, monday);
                  return (
                    <div className="td-entry" key={e.id}>
                      <Avatar user={userById[e.user]} size={22} />
                      <span className="td-entry-note grow truncate">{e.note}</span>
                      <span className="mono td-entry-date">{d ? d.label : ''}</span>
                      <span className="mono td-entry-h">{e.hours}h</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* allocations / workload (Phase 5) — onglet Temps */}
          {tab === 'time' && (
            <AllocationsSection task={task} monday={monday} onUpdate={onUpdate} />
          )}

          {/* ============ Onglet IA ============ */}
          {tab === 'ai' && (
            <div className="td-section" style={{ borderTop: 'none', paddingTop: 4 }}>
              <div className="td-stitle">{t('detail.ai.title')}</div>
              {!proj?.agentsEnabled ? (
                <div className="td-ai-empty">
                  <Icon name="zap" size={26} style={{ color: 'var(--text-faint)' }} />
                  <div>{t('detail.ai.notEnabled')}</div>
                </div>
              ) : (
                <>
                  {/* Runs déclarés + coût (batch 1). Coût déclaré vs coût de
                      référence recalculé serveur, flag d'anomalie. */}
                  {aiLoading && !aiActivity ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '8px 0' }}>
                      {t('detail.ai.loading', { defaultValue: 'Loading agent activity…' })}
                    </div>
                  ) : aiActivity ? (
                    <>
                      <div
                        style={{
                          display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center',
                          padding: '10px 12px', background: 'var(--surface-2)',
                          border: '1px solid var(--border)', borderRadius: 10, marginBottom: 12,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                            {t('detail.ai.totalCost', { defaultValue: 'Total agent cost' })}
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 18 }}>
                            {aiActivity.budget.spent.toFixed(2)} €
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                            {t('detail.ai.runs', { defaultValue: 'Runs' })}
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 18 }}>{aiActivity.budget.runCount}</div>
                        </div>
                        {aiActivity.budget.taskBudget != null && (
                          <div style={{ minWidth: 160 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                              {t('detail.ai.budget', { defaultValue: 'Task budget' })}
                            </div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>
                              {aiActivity.budget.spent.toFixed(2)} / {aiActivity.budget.taskBudget.toFixed(2)} €
                            </div>
                            <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
                              <div
                                style={{
                                  height: '100%',
                                  width: `${Math.min(100, aiActivity.budget.taskBudget > 0 ? (aiActivity.budget.spent / aiActivity.budget.taskBudget) * 100 : 0)}%`,
                                  background: aiActivity.budget.spent >= aiActivity.budget.taskBudget ? 'var(--danger, #d64545)' : 'var(--accent)',
                                }}
                              />
                            </div>
                          </div>
                        )}
                        {aiActivity.claim && (
                          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
                            {t('detail.ai.claimedBy', { defaultValue: 'Claimed by' })}{' '}
                            <b style={{ color: 'var(--text-2)' }}>{aiActivity.claim.agentName ?? '—'}</b>
                          </div>
                        )}
                      </div>

                      {aiActivity.runs.length === 0 ? (
                        <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '4px 0 10px' }}>
                          {t('detail.ai.noRuns', { defaultValue: 'No agent runs declared on this task yet.' })}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
                          {aiActivity.runs.map((r) => {
                            const anomalyLabel = r.anomaly === 'no_tokens'
                              ? t('detail.ai.anomalyNoTokens', { defaultValue: 'Deliverable, 0 tokens' })
                              : r.anomaly === 'zero_cost'
                                ? t('detail.ai.anomalyZeroCost', { defaultValue: 'Zero cost vs rate' })
                                : r.anomaly === 'below_reference'
                                  ? t('detail.ai.anomalyBelow', { defaultValue: 'Below reference' })
                                  : null;
                            return (
                              <div
                                key={r.id}
                                style={{
                                  display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap',
                                  padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8,
                                }}
                              >
                                <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 110 }}>
                                  {r.model ?? '—'}
                                </span>
                                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                                  {(r.tokensIn ?? 0).toLocaleString()} → {(r.tokensOut ?? 0).toLocaleString()} tok
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>
                                  {r.cost != null ? `${r.cost.toFixed(2)} €` : '—'}
                                </span>
                                {r.derivedCost != null && (
                                  <span style={{ fontSize: 11, color: 'var(--text-3)' }} title={t('detail.ai.refHint', { defaultValue: 'Server-computed reference cost' })}>
                                    {t('detail.ai.ref', { defaultValue: 'ref' })} {r.derivedCost.toFixed(2)} €
                                  </span>
                                )}
                                {anomalyLabel && (
                                  <span
                                    style={{
                                      fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 6,
                                      color: 'var(--danger, #d64545)', background: 'var(--danger-soft, #fbe6e6)',
                                    }}
                                  >
                                    ⚠ {anomalyLabel}
                                  </span>
                                )}
                                {r.note && (
                                  <span style={{ fontSize: 12, color: 'var(--text-3)', flexBasis: '100%' }}>{r.note}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  ) : null}

                  {/* Livrables + critères + budget agent (déplacés ici depuis
                      l'onglet Activité : leur place logique est l'onglet IA). */}
                  <DeliverablesSection
                    task={task}
                    can={can}
                    me={userById[currentUser]}
                    pushToast={pushToast}
                  />
                </>
              )}
            </div>
          )}

          {/* attachments (Activité) */}
          {tab === 'activity' && (
          <div className="td-section">
            <div className="row gap2" style={{ alignItems: 'baseline', marginBottom: 10 }}>
              <div className="td-stitle">
                {t('detail.attachmentsTitle')} <span className="td-stcount">{attachments.length}</span>
              </div>
              <span className="grow" />
              <button
                className="btn btn-ghost"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? t('detail.uploading') : t('detail.addFile')}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) handleUpload(e.target.files);
                e.target.value = '';
              }}
            />
            <div
              className={'td-dropzone' + (dragOver ? ' on' : '')}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) handleUpload(e.dataTransfer.files);
              }}
            >
              {t('detail.dropFiles')} <b>{t('detail.addFileBold')}</b> {t('detail.maxSize')}
            </div>
            {DEMO && (
              <div
                style={{
                  marginTop: 8, fontSize: 12, lineHeight: 1.5,
                  color: 'var(--warn, #92610a)', background: 'var(--warn-soft, #fdf1d6)',
                  border: '1px solid var(--warn-line, #f0d38a)', borderRadius: 8, padding: '7px 10px',
                }}
              >
                Démo : l’upload de fichiers est désactivé (aucun stockage). Dans le produit réel, vos pièces
                jointes sont stockées de façon sécurisée.
              </div>
            )}
            {attachments.length > 0 && (
              <div className="td-attachments">
                {attachments.map((a) => (
                  <div className="td-att" key={a.id}>
                    <Icon name={isViewableDoc(a) ? 'eye' : 'paperclip'} size={16} />
                    <button
                      className="td-att-name grow truncate"
                      onClick={() => (isViewableDoc(a) ? setAttView(a) : apiDownloadAttachment(a))}
                      title={
                        isViewableDoc(a)
                          ? t('deliverables.preview', { defaultValue: 'Preview' })
                          : t('detail.downloadFile', { filename: a.filename })
                      }
                    >
                      {a.filename}
                    </button>
                    <span className="mono td-att-size">{fmtBytes(a.sizeBytes)}</span>
                    <span className="td-att-meta truncate">
                      {a.uploader.name} · {fmtDate.dateShort(a.createdAt)}
                    </span>
                    {(a.uploader.id === currentUser) && (
                      <button
                        className="icon-btn td-att-del"
                        title={t('detail.removeAttachment')}
                        onClick={() => handleDeleteAttachment(a.id)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {attView && (
              <DocumentViewerModal
                target={attView}
                fetchBlob={() => apiFetchAttachmentBlob(attView.id, attView.filename)}
                onClose={() => setAttView(null)}
                onDownload={() => apiDownloadAttachment(attView)}
              />
            )}
          </div>
          )}

          {/* deliverables (chantier 2c) — Activité, uniquement si le projet autorise
              les agents IA (livrables/critères/budget IA sont des concepts agent). */}
          {/* Livrables agent : déplacés vers l'onglet IA (leur place logique). */}

          {/* comments (Activité) */}
          {tab === 'activity' && (
          <div className="td-section">
            <div className="td-stitle">
              {t('detail.comments')} <span className="td-stcount">{comments.length}</span>
            </div>

            <div className="td-comments">
              {comments.map((c) => {
                // Fallback : auteur absent de l'annuaire (compte supprimé,
                // agent hors périmètre…) → on rend depuis le nom snapshoté
                // dans le commentaire, JAMAIS de crash.
                const u =
                  userById[c.user] ??
                  {
                    id: c.user,
                    name: c.userName ?? '—',
                    short: (c.userName ?? '—').split(' ')[0],
                    initials: (c.userName ?? '?')
                      .split(' ')
                      .map((w) => w[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase(),
                    role: '',
                    hue: 220,
                    online: false,
                  };
                return (
                  <div className="td-comment" key={c.id}>
                    <Avatar user={u} size={30} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row gap2">
                        <span className="td-cname">{u.name}</span>
                        {u.kind === 'AGENT' && (
                          <span
                            className="pill"
                            style={{
                              background: 'color-mix(in oklch, var(--accent) 16%, var(--surface))',
                              color: 'var(--accent)',
                              fontSize: 10,
                            }}
                          >
                            Agent
                          </span>
                        )}
                        <span className="td-cat">{c.at}</span>
                      </div>
                      <div className="td-cbody">{renderBody(c.body)}</div>
                    </div>
                  </div>
                );
              })}
              <MentionInput
                onSubmit={(body) => {
                  onAddComment(body);
                  const shorts = USERS.filter((u) => new RegExp('@' + u.short + '\\b', 'i').test(body));
                  if (shorts.length) pushToast({ actor: userById[currentUser], text: t('comment.mentionedToast', { names: shorts.map((s) => s.short).join(', ') }) });
                }}
              />
            </div>
          </div>
          )}
        </div>
      </aside>
      {requestModal && (
        <SkillRequestModal
          taskId={task.id}
          projectId={projectId ?? task.projectId ?? null}
          initialName={requestModal.initialName}
          onClose={() => setRequestModal(null)}
        />
      )}
      {depShiftPrompt && (
        <DependentShiftModal
          successors={depShiftPrompt.successors}
          monday={monday}
          onClose={() => setDepShiftPrompt(null)}
          onApply={() => {
            for (const s of depShiftPrompt.successors) {
              const patch: Partial<Task> = { start: s.newStart };
              // Conserve la durée : applique aussi la nouvelle due si elle
              // change (c'est ce qui propage la cascade à toute la chaîne).
              if (s.newDue != null && s.newDue !== s.oldDue) patch.due = s.newDue;
              patchOtherTask(s.id, patch);
            }
            setDepShiftPrompt(null);
          }}
        />
      )}
      {predBlock && (
        <PredecessorBlockModal
          predecessors={blockingPreds.map((p) => ({ id: p.id, title: p.title }))}
          onCancel={() => setPredBlock(null)}
          onConfirm={() => {
            const target = predBlock;
            setPredBlock(null);
            // Marque optimistiquement les prédécesseurs directs comme terminés ;
            // le serveur clôture la chaîne complète + émet les events WS.
            const doneCol = COLUMNS.find((c) => c.status === 'done');
            if (doneCol) {
              for (const p of blockingPreds)
                patchOtherTask(p.id, { col: doneCol.id, progress: 100 });
            }
            pickColumn(target, true);
          }}
        />
      )}
    </div>
  );
}

/* ---- popup : décaler les tâches dépendantes après un changement de due ---- */
function DependentShiftModal({
  successors,
  monday,
  onApply,
  onClose,
}: {
  successors: {
    id: string;
    title: string;
    oldStart: number | null;
    newStart: number;
    oldDue: number | null;
    newDue: number | null;
  }[];
  monday: Date;
  onApply: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('tasks');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter') onApply();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onApply, onClose]);

  const n = successors.length;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(460px, 96vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon name="branch" size={18} style={{ color: 'var(--accent)' }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {n > 1 ? t('shift.titleMany') : t('shift.titleOne')}
          </h2>
        </div>

        <div style={{ padding: '14px 20px', fontSize: 14, lineHeight: 1.5, overflowY: 'auto' }}>
          <p style={{ margin: '0 0 10px' }}>
            {n === 1 ? t('shift.bodyOne') : t('shift.bodyMany', { count: n })}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {successors.map((s) => {
              const dueMoves = s.newDue != null && s.newDue !== s.oldDue;
              return (
                <div
                  key={s.id}
                  style={{
                    fontSize: 13,
                    padding: '6px 8px',
                    background: 'var(--surface-2)',
                    borderRadius: 6,
                  }}
                >
                  <div className="row gap2" style={{ alignItems: 'center' }}>
                    <span className="grow truncate">{s.title}</span>
                    <span className="td-empty" style={{ fontSize: 11 }}>{t('shift.start')}</span>
                    <span className="mono td-empty">
                      {s.oldStart != null ? dueOffsetToIso(s.oldStart, monday) : '—'}
                    </span>
                    <span style={{ opacity: 0.6 }}>→</span>
                    <span className="mono" style={{ color: 'var(--accent)' }}>
                      {dueOffsetToIso(s.newStart, monday)}
                    </span>
                  </div>
                  {dueMoves && (
                    <div
                      className="row gap2"
                      style={{ alignItems: 'center', marginTop: 3, opacity: 0.75 }}
                    >
                      <span className="grow" />
                      <span className="td-empty" style={{ fontSize: 11 }}>{t('shift.due')}</span>
                      <span className="mono td-empty">
                        {s.oldDue != null ? dueOffsetToIso(s.oldDue, monday) : '—'}
                      </span>
                      <span style={{ opacity: 0.6 }}>→</span>
                      <span className="mono" style={{ color: 'var(--accent)' }}>
                        {dueOffsetToIso(s.newDue, monday)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('shift.notNow')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={onApply} autoFocus>
            {n > 1 ? t('shift.applyMany', { count: n }) : t('shift.applyOne')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- popup : clôture bloquée par des prédécesseurs non terminés ----
   Affiché quand on tente de passer une tâche à « Done » alors que des tâches
   précédentes ne sont pas terminées. Propose de toutes les clôturer en cascade.
   Exporté pour être réutilisé par le Kanban (Workspace). */
export function PredecessorBlockModal({
  predecessors,
  onCancel,
  onConfirm,
}: {
  predecessors: { id: string; title: string }[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('tasks');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const n = predecessors.length;
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(460px, 96vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Icon name="alert" size={18} style={{ color: 'var(--warn, #d97706)' }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {t('predBlock.title')}
          </h2>
        </div>

        <div style={{ padding: '14px 20px', fontSize: 14, lineHeight: 1.5, overflowY: 'auto' }}>
          <p style={{ margin: '0 0 10px' }}>
            {n > 1 ? t('predBlock.bodyMany', { count: n }) : t('predBlock.bodyOne')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {predecessors.map((p) => (
              <div
                key={p.id}
                className="row gap2"
                style={{
                  alignItems: 'center',
                  fontSize: 13,
                  padding: '6px 8px',
                  background: 'var(--surface-2)',
                  borderRadius: 6,
                }}
              >
                <span className="col-dot" data-status="todo" />
                <span className="grow truncate">{p.title}</span>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t('common:cancel')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={onConfirm} autoFocus>
            {n > 1 ? t('predBlock.confirmMany', { count: n }) : t('predBlock.confirmOne')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- popup : raison (facultative) de mise en pause d'une tâche ----
   Affiché après un passage en colonne On Hold (drag Kanban ou dropdown détail),
   ou pour éditer la raison courante. La raison est facultative : « Passer » ferme
   sans rien enregistrer. */
export function HoldReasonModal({
  initial = '',
  onSubmit,
  onClose,
}: {
  initial?: string;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('tasks');
  const [reason, setReason] = useState(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          width: 'min(460px, 96vw)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span className="col-dot" data-status="hold" />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t('hold.title')}</h2>
        </div>

        <div style={{ padding: '14px 20px', fontSize: 14, lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 10px', color: 'var(--text-2)' }}>{t('hold.body')}</p>
          <textarea
            autoFocus
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('hold.placeholder')}
            rows={3}
            style={{
              width: '100%',
              resize: 'vertical',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(reason.trim());
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('hold.skip')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => onSubmit(reason.trim())}>
            {t('hold.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- popup : émettre une demande de compétence depuis une tâche (PM only) ----
   Exporté pour être réutilisé par le Skill Gap (Reports). */
export function SkillRequestModal({
  taskId,
  projectId,
  initialName,
  onClose,
}: {
  taskId: string;
  projectId: string | null;
  initialName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('tasks');
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [teamId, setTeamId] = useState('');
  const [type, setType] = useState<'ASSIGN_SKILL' | 'TRAINING' | 'EXTERNAL'>('TRAINING');
  const [existingSkillId, setExistingSkillId] = useState('');
  const [proposedName, setProposedName] = useState(initialName);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    Promise.all([
      api.listTeams().catch(() => [] as TeamDto[]),
      api.listSkills().catch(() => [] as SkillDto[]),
    ]).then(([ts, ss]) => {
      setTeams(ts);
      setSkills(ss);
      // Préselectionne un skill existant si le texte tapé matche
      const lower = initialName.trim().toLowerCase();
      if (lower) {
        const match = ss.find((s) => s.name.toLowerCase() === lower);
        if (match) {
          setExistingSkillId(match.id);
          setProposedName('');
        }
      }
    });
  }, [initialName]);

  const submit = async () => {
    if (!teamId) {
      setError(t('skillRequest.errorTeam'));
      return;
    }
    if (!existingSkillId && !proposedName.trim()) {
      setError(t('skillRequest.errorSkill'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.createSkillRequest({
        teamId,
        type,
        skillId: existingSkillId || undefined,
        proposedName: existingSkillId ? undefined : proposedName.trim() || undefined,
        projectId: projectId ?? undefined,
        taskId,
        note: note.trim() || undefined,
      });
      setDone(true);
      setTimeout(onClose, 1400);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,16,28,0.5)',
        display: 'grid', placeItems: 'center',
      }}
    >
      <div
        style={{
          width: 'min(560px, 92vw)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
          display: 'grid',
          gap: 12,
          color: 'var(--text)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('skillRequest.title')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {t('skillRequest.subtitle')}
          </div>
        </div>

        {done ? (
          <div style={{ padding: 16, color: 'var(--accent)', fontWeight: 600 }}>
            {t('skillRequest.sent')}
          </div>
        ) : (
          <>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
              {t('skillRequest.targetTeam')}
              <select
                className="atext"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                style={{ color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '6px 8px', borderRadius: 8 }}
              >
                <option value="">{t('skillRequest.chooseTeam')}</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
              {t('skillRequest.requestType')}
              <select
                className="atext"
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                style={{ color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '6px 8px', borderRadius: 8 }}
              >
                <option value="ASSIGN_SKILL">{t('skillRequest.typeAssign')}</option>
                <option value="TRAINING">{t('skillRequest.typeTraining')}</option>
                <option value="EXTERNAL">{t('skillRequest.typeExternal')}</option>
              </select>
            </label>

            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
              {t('skillRequest.existingSkill')}
              <select
                className="atext"
                value={existingSkillId}
                onChange={(e) => {
                  setExistingSkillId(e.target.value);
                  if (e.target.value) setProposedName('');
                }}
                style={{ color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '6px 8px', borderRadius: 8 }}
              >
                <option value="">{t('skillRequest.noneProposeNew')}</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.category ? `${s.category} · ` : ''}{s.name}
                  </option>
                ))}
              </select>
            </label>

            {!existingSkillId && (
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
                {t('skillRequest.newSkillName')}
                <input
                  className="atext"
                  value={proposedName}
                  onChange={(e) => setProposedName(e.target.value)}
                  placeholder={t('skillRequest.newSkillPlaceholder')}
                  style={{ color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '6px 8px', borderRadius: 8 }}
                />
              </label>
            )}

            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
              {t('skillRequest.note')}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={t('skillRequest.notePlaceholder')}
                style={{ color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '6px 8px', borderRadius: 8, fontFamily: 'inherit', resize: 'vertical' }}
              />
            </label>

            {error && (
              <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={onClose} disabled={submitting}>
                {t('common:cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={submit}
                disabled={submitting || !teamId}
              >
                {submitting ? t('skillRequest.sending') : t('skillRequest.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Livrables (chantier 2c) — l'artefact produit pour la tâche + la revue humaine.
 * Un agent soumet ses livrables via MCP ; ici le reviewer (`task:review`)
 * approuve ou demande des changements quand la tâche est en revue (IN_REVIEW).
 * Le statut brut de la tâche est relu via l'API (le type UI collapse IN_REVIEW /
 * APPROVED sur « review »).
 */
function DeliverablesSection({
  task,
  can,
  me,
  pushToast,
}: {
  task: Task;
  can: (p: string) => boolean;
  me: User;
  pushToast: (t: ToastInput) => void;
}) {
  const { t } = useTranslation('tasks');
  const fmtDate = useFormat();
  const [rows, setRows] = useState<DeliverableDto[]>([]);
  const [view, setView] = useState<{ id: string; filename: string; sizeBytes: number } | null>(null);
  const [rawStatus, setRawStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [criteria, setCriteria] = useState<AcceptanceCriterion[]>([]);
  const [newCrit, setNewCrit] = useState('');
  const [taskBudget, setTaskBudget] = useState('');

  const load = useCallback(async () => {
    try {
      const [ds, fresh] = await Promise.all([apiListDeliverables(task.id), api.getTask(task.id)]);
      setRows(ds);
      setRawStatus(fresh.status as string);
      setCriteria(fresh.acceptanceCriteria ?? []);
      setTaskBudget(fresh.agentCostBudget != null ? String(fresh.agentCostBudget) : '');
    } catch {
      /* best-effort : section muette si l'appel échoue */
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const canReview = can('task:review');
  const canEdit = can('task:update');
  const inReview = rawStatus === 'IN_REVIEW';
  const inProgress = rawStatus === 'IN_PROGRESS';
  const inLifecycle =
    inReview || inProgress || rawStatus === 'CLAIMED' || rawStatus === 'CHANGES_REQUESTED';
  const pending = rows.filter((d) => d.reviewStatus === 'PENDING').length;

  const saveCriteria = async (next: AcceptanceCriterion[]) => {
    setCriteria(next);
    try {
      await apiSetAcceptanceCriteria(task.id, next);
    } catch (e) {
      pushToast({ actor: me, text: (e as Error).message, warn: true });
      await load();
    }
  };
  const addCriterion = () => {
    const text = newCrit.trim();
    if (!text) return;
    void saveCriteria([...criteria, { text, done: false }]);
    setNewCrit('');
  };
  const saveTaskBudget = async () => {
    const v = taskBudget.trim() === '' ? null : Number(taskBudget);
    if (v != null && (Number.isNaN(v) || v < 0)) return;
    try {
      await apiSetTaskAgentBudget(task.id, v);
    } catch (e) {
      pushToast({ actor: me, text: (e as Error).message, warn: true });
      await load();
    }
  };

  // Rien à afficher : aucun livrable, aucun critère, et pas dans le cycle agent.
  if (rows.length === 0 && criteria.length === 0 && !inLifecycle) return null;

  const showCriteria = criteria.length > 0 || inLifecycle;

  const review = async (d: DeliverableDto, decision: 'approve' | 'request_changes') => {
    setBusy(d.id);
    try {
      await apiReviewDeliverable(task.id, d.id, { decision, note: notes[d.id]?.trim() || undefined });
      pushToast({
        actor: me,
        text: t(decision === 'approve' ? 'deliverables.approved' : 'deliverables.changesRequested'),
      });
      setNotes((n) => ({ ...n, [d.id]: '' }));
      await load();
    } catch (e) {
      pushToast({ actor: me, text: (e as Error).message, warn: true });
    } finally {
      setBusy(null);
    }
  };

  const submitForReview = async () => {
    setBusy('__submit__');
    try {
      await apiSubmitForReview(task.id);
      pushToast({ actor: me, text: t('deliverables.submittedForReview') });
      await load();
    } catch (e) {
      pushToast({ actor: me, text: (e as Error).message, warn: true });
    } finally {
      setBusy(null);
    }
  };

  const statusPill = (s: DeliverableDto['reviewStatus']) => {
    const map: Record<string, { bg: string; fg: string }> = {
      PENDING: { bg: 'color-mix(in oklch, var(--warn, #d29922) 18%, var(--surface))', fg: 'var(--warn, #d29922)' },
      APPROVED: { bg: 'color-mix(in oklch, var(--ok, #3fb950) 18%, var(--surface))', fg: 'var(--ok, #3fb950)' },
      CHANGES_REQUESTED: { bg: 'color-mix(in oklch, var(--danger, #f85149) 18%, var(--surface))', fg: 'var(--danger, #f85149)' },
    };
    const c = map[s] ?? map.PENDING;
    return (
      <span className="pill" style={{ background: c.bg, color: c.fg, fontSize: 10 }}>
        {t(`deliverables.status.${s}`)}
      </span>
    );
  };

  return (
    <>
      {showCriteria && (
        <div className="td-section">
          <div className="td-stitle" style={{ marginBottom: 8 }}>
            {t('deliverables.criteriaTitle')} <span className="td-stcount">{criteria.length}</span>
          </div>
          {criteria.length === 0 && !canEdit && (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('deliverables.noCriteria')}</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {criteria.map((c, i) => (
              <label key={i} className="row gap2" style={{ alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!canReview && !canEdit}
                  onChange={(e) =>
                    saveCriteria(criteria.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))
                  }
                  style={{ marginTop: 3 }}
                />
                <span
                  className="grow"
                  style={{
                    textDecoration: c.done ? 'line-through' : 'none',
                    color: c.done ? 'var(--text-3)' : 'inherit',
                  }}
                >
                  {c.text}
                </span>
                {canEdit && (
                  <button
                    className="icon-btn"
                    title={t('deliverables.removeCriterion')}
                    onClick={() => saveCriteria(criteria.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={13} />
                  </button>
                )}
              </label>
            ))}
          </div>
          {canEdit && (
            <div className="row gap2" style={{ marginTop: 8 }}>
              <input
                className="atext"
                value={newCrit}
                onChange={(e) => setNewCrit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCriterion();
                  }
                }}
                placeholder={t('deliverables.addCriterionPlaceholder')}
                style={{ flex: 1 }}
              />
              <button className="btn btn-line" onClick={addCriterion} disabled={!newCrit.trim()}>
                {t('deliverables.addCriterion')}
              </button>
            </div>
          )}
          {canEdit && (
            <div className="row gap2" style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('deliverables.taskBudget')}</span>
              <input
                className="atext"
                type="number"
                min={0}
                step="0.01"
                placeholder="€"
                value={taskBudget}
                onChange={(e) => setTaskBudget(e.target.value)}
                onBlur={saveTaskBudget}
                style={{ width: 120 }}
              />
            </div>
          )}
        </div>
      )}

      <div className="td-section">
      <div className="row gap2" style={{ alignItems: 'baseline', marginBottom: 10 }}>
        <div className="td-stitle">
          {t('deliverables.title')} <span className="td-stcount">{rows.length}</span>
        </div>
        <span className="grow" />
        {inProgress && pending > 0 && (
          <button className="btn btn-ghost" disabled={busy === '__submit__'} onClick={submitForReview}>
            {t('deliverables.submitForReview')}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 2px' }}>
          {t('deliverables.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((d) => (
            <div
              key={d.id}
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div className="row gap2" style={{ alignItems: 'center' }}>
                <Icon name="paperclip" size={15} />
                <span className="grow truncate" style={{ fontWeight: 600 }}>
                  {safeUrl(d.url) ? (
                    <a href={safeUrl(d.url)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                      {d.title}
                    </a>
                  ) : (
                    d.title
                  )}
                </span>
                {d.version > 1 && (
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>v{d.version}</span>
                )}
                {statusPill(d.reviewStatus)}
              </div>
              <div className="row gap2" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                <span>{d.author.name}</span>
                {d.author.isAgent && (
                  <span
                    className="pill"
                    style={{ background: 'color-mix(in oklch, var(--accent) 16%, var(--surface))', color: 'var(--accent)', fontSize: 9 }}
                  >
                    Agent
                  </span>
                )}
                <span>· {fmtDate.dateShort(d.createdAt)}</span>
              </div>
              {d.attachment && (
                <button
                  className="btn btn-line"
                  style={{ alignSelf: 'flex-start', fontSize: 12, maxWidth: '100%', minWidth: 0 }}
                  onClick={() =>
                    isViewableDoc(d.attachment!)
                      ? setView(d.attachment!)
                      : apiDownloadDeliverable(d.attachment!.id, d.attachment!.filename)
                  }
                  title={
                    (isViewableDoc(d.attachment) ? t('deliverables.preview') : t('deliverables.download')) +
                    ' — ' +
                    d.attachment.filename
                  }
                >
                  <Icon name={isViewableDoc(d.attachment) ? 'eye' : 'download'} size={13} style={{ flexShrink: 0 }} />
                  <span className="truncate" style={{ minWidth: 0 }}>{d.attachment.filename}</span>
                  <span className="mono" style={{ color: 'var(--text-3)', flexShrink: 0 }}>
                    {fmtBytes(d.attachment.sizeBytes)}
                  </span>
                </button>
              )}
              {d.justification && <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{d.justification}</div>}
              {d.reviewNote && (
                <div style={{ fontSize: 12, borderLeft: '3px solid var(--border)', paddingLeft: 8, color: 'var(--text-2)' }}>
                  <b>{t('deliverables.reviewNote')}</b> {d.reviewNote}
                  {d.reviewedBy ? ` — ${d.reviewedBy.name}` : ''}
                </div>
              )}
              {inReview && canReview && d.reviewStatus === 'PENDING' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  <textarea
                    className="atext"
                    rows={2}
                    placeholder={t('deliverables.notePlaceholder')}
                    value={notes[d.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))}
                    style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                  <div className="row gap2">
                    <button className="btn btn-primary" disabled={busy === d.id} onClick={() => review(d, 'approve')}>
                      {t('deliverables.approve')}
                    </button>
                    <button className="btn btn-line" disabled={busy === d.id} onClick={() => review(d, 'request_changes')}>
                      {t('deliverables.requestChanges')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </div>
      {view && (
        <DocumentViewerModal
          target={view}
          fetchBlob={() => apiFetchAttachmentBlob(view.id, view.filename)}
          onClose={() => setView(null)}
          onDownload={() => apiDownloadDeliverable(view.id, view.filename)}
        />
      )}
    </>
  );
}

function GroupChildrenSection({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  const { t } = useTranslation('tasks');
  // Flatten the group's descendant tree (depth-first) so nested subgroups show their items too.
  const rows = React.useMemo(() => {
    const out: { task: Task; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (parentId: string, depth: number) => {
      const kids = allTasks
        .filter((t) => t.parentTaskId === parentId)
        .sort((a, b) => a.title.localeCompare(b.title));
      for (const k of kids) {
        if (seen.has(k.id)) continue;
        seen.add(k.id);
        out.push({ task: k, depth });
        if (k.isGroup) walk(k.id, depth + 1);
      }
    };
    walk(task.id, 0);
    return out;
  }, [task.id, allTasks]);

  return (
    <div className="td-section">
      <div className="td-stitle row" style={{ justifyContent: 'space-between' }}>
        <span>{t('detail.tasksInGroup')}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 2px' }}>
          {t('detail.noTaskInGroup')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
          {rows.map(({ task: rowTask, depth }) => {
            const col = COLUMNS.find((c) => c.id === rowTask.col);
            const done = col?.status === 'done';
            return (
              <div
                key={rowTask.id}
                className="row gap2"
                style={{
                  padding: '6px 8px 6px ' + (8 + depth * 16) + 'px',
                  borderRadius: 6,
                  fontSize: 13,
                  background: 'var(--bg-2)',
                  border: '1px solid transparent',
                }}
              >
                <Icon
                  name={rowTask.isGroup ? 'branch' : done ? 'check' : 'board'}
                  size={13}
                  style={{
                    color: rowTask.isGroup
                      ? 'var(--accent)'
                      : done
                        ? 'var(--c-ok)'
                        : 'var(--text-3)',
                    flexShrink: 0,
                  }}
                />
                <span
                  className="grow truncate"
                  style={{
                    textAlign: 'left',
                    textDecoration: done ? 'line-through' : 'none',
                    opacity: done ? 0.65 : 1,
                  }}
                  title={rowTask.title}
                >
                  {rowTask.title}
                </span>
                {col && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: 'var(--text-3)',
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: 'var(--bg-1)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {localizeColName(col.name, t)}
                  </span>
                )}
                {rowTask.assignees.length > 0 && (
                  <AvatarStack ids={rowTask.assignees} size={20} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   "Planning" section: group flag · parent group · milestone
   · predecessors & successors. Loads dependencies from the API.
   Group rules enforced both client- and server-side:
     - A regular task can belong to a group, or to nothing (root). Never to another task.
     - A group can belong to another group, or be a root.
     - A regular task can require any task or group.
     - A group can require another group or a standalone (root, non-group) task.
   ============================================================ */
/** Forme minimale d'une tâche pour la résolution des libellés/pickers du
 *  panneau Planning (titres de prédécesseurs/successeurs, sélecteur parent). */
type PlanTask = Pick<Task, 'id' | 'title' | 'isGroup' | 'parentTaskId'> & {
  /** Statut, pour afficher l'avancement du découpage. Absent des tâches venant
   *  du board courant si la carte ne le porte pas — d'où l'optionalité. */
  status?: string;
};

function PlanningSection({
  task,
  allTasks,
  onUpdate,
  projectId,
}: {
  task: Task;
  allTasks: Task[];
  onUpdate: (patch: Partial<Task>) => void;
  projectId: string | null;
}) {
  const { t } = useTranslation('tasks');
  const [deps, setDeps] = useState<DependencyDto[]>(
    // Cache SWR : liste connue affichée dès le montage (pas de « load… »).
    () => ((projectId ?? task.projectId) && depsCache.get((projectId ?? task.projectId)!)) || [],
  );
  // Tâches du projet, chargées à la demande UNIQUEMENT quand `allTasks` est
  // insuffisant (tâche « étrangère » ouverte hors du projet courant : Workspace
  // passe alors `allTasks=[openTask]`). Sert à résoudre les titres des
  // prédécesseurs/successeurs et à peupler le sélecteur — sinon ils s'affichent
  // en UUID brut et le picker reste vide.
  const [projTasks, setProjTasks] = useState<PlanTask[] | null>(null);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  // Type du lien choisi dans chaque picker « Ajouter » (Lot 1c.3, défaut FS —
  // rétro-compat avec le comportement historique).
  const [predLinkType, setPredLinkType] = useState<DependencyType>(DependencyType.FS);
  const [succLinkType, setSuccLinkType] = useState<DependencyType>(DependencyType.FS);

  // Charge les dépendances du PROJET DE LA TÂCHE (pas du premier projet actif —
  // sinon les prédécesseurs d'une tâche hors de ce projet n'apparaissent jamais
  // alors que le Gantt les affiche).
  const effectiveProjectId = projectId ?? task.projectId ?? null;
  // On charge TOUJOURS les tâches du projet pour résoudre les libellés des
  // prédécesseurs/successeurs (sinon une dépendance vers une tâche absente de
  // `allTasks` — filtrée, autre groupe, vue Workload — s'affiche en UUID brut).
  // L'onglet Planning est monté à la demande : ce fetch n'a lieu qu'à son
  // ouverture, pas à chaque ouverture du panneau.
  const needsProjectTasks = true;
  useEffect(() => {
    let cancelled = false;
    let sub: { cancel: () => void; done: Promise<void> } | null = null;
    (async () => {
      try {
        let pid = effectiveProjectId;
        if (!pid) {
          const projects = await api.listProjects();
          const proj = projects.find((p) => p.status === 'ACTIVE') ?? projects[0];
          pid = proj?.id ?? null;
        }
        if (!pid || cancelled) return;
        // Dépendances via le cache SWR (liste connue affichée immédiatement,
        // revalidation en fond). Après une mutation (tick > 0) on attend la
        // version fraîche pour ne pas ré-afficher l'état d'avant.
        const s = loadDepsSWR(pid, (d) => { if (!cancelled) setDeps(d); }, tick === 0);
        sub = s;
        const [, tasksRes] = await Promise.all([
          s.done,
          needsProjectTasks ? api.listTasks(pid) : Promise.resolve(null),
        ]);
        if (tasksRes && !cancelled) {
          setProjTasks(
            tasksRes.map((tk) => ({
              id: tk.id,
              title: tk.title,
              isGroup: tk.isGroup,
              parentTaskId: tk.parentTaskId,
            })),
          );
        }
      } catch {
        // silent — empty state is acceptable
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; sub?.cancel(); };
  }, [tick, effectiveProjectId, needsProjectTasks]);

  // Liste effective pour résoudre titres + pickers : union des tâches du projet
  // (chargées ci-dessus) et de `allTasks`, ces dernières prioritaires (données
  // les plus fraîches du board courant). Garantit que chaque prédécesseur/
  // successeur résout son titre, jamais un UUID brut.
  const tasks: PlanTask[] = useMemo(() => {
    if (!projTasks) return allTasks;
    const map = new Map<string, PlanTask>();
    for (const t of projTasks) map.set(t.id, t);
    for (const t of allTasks)
      map.set(t.id, {
        id: t.id,
        title: t.title,
        isGroup: t.isGroup,
        parentTaskId: t.parentTaskId,
      });
    return [...map.values()];
  }, [projTasks, allTasks]);

  const incoming = deps.filter((d) => d.successorId === task.id);
  const outgoing = deps.filter((d) => d.predecessorId === task.id);

  // Parent picker : on exclut soi-même et ses descendants (anti-cycle). Depuis
  // la séparation affichage/découpage, le parent n'a plus à être un « groupe » —
  // une tâche ordinaire peut porter un découpage sans devenir un conteneur de
  // board (elle resterait alors invisible dans sa colonne de statut).
  const forbiddenParents = useMemo(() => {
    const set = new Set<string>([task.id]);
    let added = true;
    while (added) {
      added = false;
      for (const t of tasks) {
        if (t.parentTaskId && set.has(t.parentTaskId) && !set.has(t.id)) {
          set.add(t.id);
          added = true;
        }
      }
    }
    return set;
  }, [task.id, tasks]);

  // Les groupes d'abord (le cas le plus courant du rattachement manuel), puis
  // les tâches ordinaires — l'ordre guide sans interdire.
  const candidateParents = tasks
    .filter((t) => !forbiddenParents.has(t.id))
    .sort((a, b) => Number(!!b.isGroup) - Number(!!a.isGroup));
  const parentTask = task.parentTaskId
    ? tasks.find((t) => t.id === task.parentTaskId)
    : null;

  // Predecessor picker:
  //  - if the current task is a group, only standalone tasks (root, non-group) or groups.
  //  - if the current task is a regular task, any other task or group.
  const alreadyPredIds = new Set(incoming.map((d) => d.predecessorId));
  const candidatePredecessors = tasks.filter((t) => {
    if (t.id === task.id) return false;
    if (alreadyPredIds.has(t.id)) return false;
    if (task.isGroup) {
      const standaloneTask = !t.isGroup && (t.parentTaskId == null);
      return t.isGroup || standaloneTask;
    }
    return true;
  });

  // Successor picker (« Blocks ») : toute autre tâche non déjà successeur ni
  // prédécesseur direct (évite un cycle immédiat). Les règles de groupe fines
  // sont validées côté serveur au createDependency (rejet remonté à l'UI).
  const alreadySuccIds = new Set(outgoing.map((d) => d.successorId));
  const candidateSuccessors = tasks.filter((t) => {
    if (t.id === task.id) return false;
    if (alreadySuccIds.has(t.id)) return false;
    if (alreadyPredIds.has(t.id)) return false;
    return true;
  });

  const childTasks = useMemo(
    () => tasks.filter((t) => t.parentTaskId === task.id),
    [tasks, task.id],
  );
  const hasChildren = childTasks.length > 0;

  async function addPredecessor(predId: string, type: DependencyType = predLinkType) {
    setAdding(true);
    try {
      await api.createDependency({
        predecessorId: predId,
        successorId: task.id,
        type,
      });
      // Aligne automatiquement la date de début sur la due date du
      // prédécesseur le plus tardif (max sur tous les prédécesseurs FS,
      // lag inclus) — UNIQUEMENT pour les contraintes FS, les seules qui
      // contraignent directement le start via due+lag (SS/FF/SF sont posées
      // consciemment par l'utilisateur, pas d'auto-ajustement pour elles —
      // Lot 1c.3). Évite de créer d'emblée un conflit de contrainte
      // (start < pred.due + lag). On ne tire PAS la date en arrière si
      // l'utilisateur a déjà posé un début plus tardif (gap volontaire),
      // et on ignore les prédécesseurs sans due date.
      const candidates = [
        ...(type === DependencyType.FS ? [{ id: predId, lag: 0 }] : []), // dépendance qu'on vient de créer (lag 0)
        ...incoming
          .filter((d) => d.type === DependencyType.FS)
          .map((d) => ({ id: d.predecessorId, lag: d.lagDays ?? 0 })),
      ]
        .map(({ id, lag }) => {
          const p = allTasks.find((t) => t.id === id);
          return p && p.due != null ? p.due + lag : null;
        })
        .filter((v): v is number => v != null);
      if (candidates.length) {
        const minStart = Math.max(...candidates);
        if (task.start == null || task.start < minStart) {
          onUpdate({ start: minStart });
        }
      }
      setTick((n) => n + 1);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function removeDep(id: string) {
    try {
      await api.deleteDependency(id);
      setTick((n) => n + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function changeDepType(id: string, type: DependencyType) {
    try {
      await api.updateDependency(id, { type });
      setTick((n) => n + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  // Ajoute un successeur : cette tâche devient le prédécesseur de `succId`
  // (type choisi dans le picker, défaut FS — Lot 1c.3).
  async function addSuccessor(succId: string, type: DependencyType = succLinkType) {
    setAdding(true);
    try {
      await api.createDependency({
        predecessorId: task.id,
        successorId: succId,
        type,
      });
      setTick((n) => n + 1);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  // Dégrouper une tâche qui a des enfants est désormais légitime : elle redevient
  // une tâche ordinaire portant un découpage (le serveur ne le refuse plus).
  // Le drapeau `isGroup` ne pilote plus que l'affichage board.
  const groupToggleDisabled = false;

  return (
    <div className="td-section">
      <div className="td-stitle">{t('planning.title')}</div>

      {/* Group flag */}
      <div className="td-prop" style={{ marginBottom: 8 }}>
        <span className="td-plabel">{t('planning.type')}</span>
        <button
          className="td-pval td-select"
          disabled={groupToggleDisabled}
          title={
            groupToggleDisabled
              ? t('planning.cannotDemote')
              : t('planning.toggleTaskGroup')
          }
          onClick={() => onUpdate({ isGroup: !task.isGroup })}
          style={{ maxWidth: '100%' }}
        >
          {task.isGroup ? (
            <>
              <Icon name="branch" size={13} style={{ color: 'var(--accent)' }} />
              <span>{t('planning.group')}</span>
            </>
          ) : (
            <>
              <Icon name="board" size={13} style={{ color: 'var(--text-3)' }} />
              <span>{t('planning.task')}</span>
            </>
          )}
          <Icon
            name="pencil"
            size={11}
            style={{ color: 'var(--text-3)', marginLeft: 4, opacity: 0.6 }}
          />
        </button>
      </div>

      {/* Color picker — groups only */}
      {task.isGroup && (
        <div className="td-prop" style={{ marginBottom: 8 }}>
          <span className="td-plabel">{t('planning.color')}</span>
          <GroupColorPicker
            color={task.color ?? null}
            onChange={(hex) => onUpdate({ color: hex })}
          />
        </div>
      )}

      {/* Rattachement : « Groupe parent » quand le parent EST un conteneur de
          board, « Tâche parente » quand c'est une tâche ordinaire qui porte un
          découpage. Le libellé doit dire la vérité de ce qu'on voit. */}
      <div className="td-prop" style={{ marginBottom: 8 }}>
        <span className="td-plabel">
          {parentTask && !parentTask.isGroup
            ? t('planning.parentTask', { defaultValue: 'Tâche parente' })
            : t('planning.parentGroup')}
        </span>
        <Dropdown
          width={260}
          trigger={
            <button
              className="td-pval td-select"
              style={{
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {parentTask ? (
                <>
                  <Icon name="branch" size={13} />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 140,
                    }}
                  >
                    {parentTask.title}
                  </span>
                </>
              ) : (
                <span className="td-empty">{t('planning.noneRoot')}</span>
              )}
              <Icon name="chevDown" size={14} style={{ color: 'var(--text-3)' }} />
            </button>
          }
        >
          <button
            className="dd-item"
            onClick={() => onUpdate({ parentTaskId: null })}
          >
            <span className="td-empty">{t('planning.noneRootDash')}</span>
          </button>
          {candidateParents.length === 0 && (
            <div className="dd-item td-empty">{t('planning.noGroupAvailable')}</div>
          )}
          {candidateParents.map((t) => (
            <button
              key={t.id}
              className="dd-item"
              onClick={() => onUpdate({ parentTaskId: t.id })}
            >
              <Icon name={t.isGroup ? 'branch' : 'list'} size={13} />
              <span className="grow truncate" style={{ textAlign: 'left' }}>
                {t.title}
              </span>
              {t.id === task.parentTaskId && (
                <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />
              )}
            </button>
          ))}
        </Dropdown>
      </div>

      {/* Découpage : les tâches enfants. Rendu dès qu'il y en a, que la tâche
          soit un « groupe » de board ou une tâche ordinaire — c'est le pendant
          descendant du rattachement ci-dessus, et sans lui une tâche découpée ne
          montre nulle part qu'elle l'est. (À ne pas confondre avec la checklist,
          appelée « sous-tâches » dans l'onglet Activité.) */}
      {childTasks.length > 0 && (
        <div className="td-prop td-prop-col" style={{ marginBottom: 8, display: 'block' }}>
          <span className="td-plabel">
            {t('planning.breakdown', { defaultValue: 'Découpage' })}{' '}
            <span className="mono td-stcount">
              {childTasks.filter((c) => c.status === 'DONE').length}/{childTasks.length}
            </span>
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {childTasks.map((c) => (
              <div
                key={c.id}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-2)' }}
              >
                <Icon name="list" size={12} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                <span className="truncate" style={{ flex: 1 }}>{c.title}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                  {c.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Milestone */}
      <div className="td-prop" style={{ marginBottom: 8 }}>
        <span className="td-plabel">{t('planning.milestone')}</span>
        <button
          className="td-pval td-select"
          onClick={() => onUpdate({ isMilestone: !task.isMilestone })}
          title={t('planning.clickToToggle')}
        >
          {task.isMilestone ? (
            <>
              <Icon name="flag" size={13} style={{ color: 'var(--accent)' }} /> {t('planning.yes')}
            </>
          ) : (
            <span className="td-empty">{t('planning.no')}</span>
          )}
          <Icon
            name="pencil"
            size={11}
            style={{ color: 'var(--text-3)', marginLeft: 4, opacity: 0.6 }}
          />
        </button>
      </div>

      {/* Bug / défaut */}
      <div className="td-prop" style={{ marginBottom: 8 }}>
        <span className="td-plabel">{t('planning.bug')}</span>
        <button
          className="td-pval td-select"
          onClick={() => onUpdate({ isBug: !task.isBug })}
          title={t('planning.bugTitle')}
        >
          {task.isBug ? (
            <>
              <Icon name="warn" size={13} style={{ color: 'var(--c-over)' }} /> {t('planning.bugYes')}
            </>
          ) : (
            <span className="td-empty">{t('planning.bugNo')}</span>
          )}
          <Icon name="pencil" size={11} style={{ color: 'var(--text-3)', marginLeft: 4, opacity: 0.6 }} />
        </button>
      </div>

      {/* Predecessors */}
      <PlanSub
        title={t('planning.predecessors')}
        loading={loading}
        empty={t('planning.noIncoming')}
      >
        {incoming.map((d) => {
          const t = tasks.find((x) => x.id === d.predecessorId);
          return (
            <DepRow
              key={d.id}
              icon="branch"
              title={t?.title ?? d.predecessorId}
              isGroup={t?.isGroup}
              type={d.type}
              lagDays={d.lagDays}
              onRemove={() => removeDep(d.id)}
              onChangeType={(nt) => changeDepType(d.id, nt)}
            />
          );
        })}
        <Dropdown
          width={280}
          trigger={
            <button className="td-add-row" disabled={adding}>
              <Icon name="plus" size={14} />
              <span className="grow truncate" style={{ textAlign: 'left' }}>
                {t('planning.addPredecessor')}
              </span>
            </button>
          }
        >
          <DepTypePicker value={predLinkType} onChange={setPredLinkType} />
          {candidatePredecessors.length === 0 && (
            <div className="dd-item td-empty">{t('planning.noEligibleTask')}</div>
          )}
          {candidatePredecessors.map((t2) => (
            <button
              key={t2.id}
              className="dd-item"
              onClick={() => addPredecessor(t2.id)}
            >
              <Icon
                name={t2.isGroup ? 'branch' : 'board'}
                size={13}
                style={{ color: t2.isGroup ? 'var(--accent)' : 'var(--text-3)' }}
              />
              <span className="grow truncate" style={{ textAlign: 'left' }}>
                {t2.title}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {t2.isGroup ? t('planning.kindGroup') : t2.parentTaskId ? t('planning.kindInGroup') : t('planning.kindTask')}
              </span>
            </button>
          ))}
        </Dropdown>
        {task.isGroup && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              marginTop: 6,
              lineHeight: 1.4,
            }}
          >
            {t('planning.groupDepHint')}
          </div>
        )}
      </PlanSub>

      {/* Successors (« Blocks ») — symétrique aux prédécesseurs : rangs compacts,
          suppression ×, et une ligne « Ajouter » en pointillés. */}
      <PlanSub title={t('planning.successors')} empty={t('planning.noOutgoing')}>
        {outgoing.map((d) => {
          const st = tasks.find((x) => x.id === d.successorId);
          return (
            <DepRow
              key={d.id}
              icon="arrowR"
              title={st?.title ?? d.successorId}
              isGroup={st?.isGroup}
              type={d.type}
              lagDays={d.lagDays}
              onRemove={() => removeDep(d.id)}
              onChangeType={(nt) => changeDepType(d.id, nt)}
            />
          );
        })}
        <Dropdown
          width={280}
          trigger={
            <button className="td-add-row" disabled={adding}>
              <Icon name="plus" size={14} />
              <span className="grow truncate" style={{ textAlign: 'left' }}>
                {t('planning.addSuccessor')}
              </span>
            </button>
          }
        >
          <DepTypePicker value={succLinkType} onChange={setSuccLinkType} />
          {candidateSuccessors.length === 0 && (
            <div className="dd-item td-empty">{t('planning.noEligibleTask')}</div>
          )}
          {candidateSuccessors.map((t2) => (
            <button
              key={t2.id}
              className="dd-item"
              onClick={() => addSuccessor(t2.id)}
            >
              <Icon
                name={t2.isGroup ? 'branch' : 'board'}
                size={13}
                style={{ color: t2.isGroup ? 'var(--accent)' : 'var(--text-3)' }}
              />
              <span className="grow truncate" style={{ textAlign: 'left' }}>
                {t2.title}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {t2.isGroup ? t('planning.kindGroup') : t2.parentTaskId ? t('planning.kindInGroup') : t('planning.kindTask')}
              </span>
            </button>
          ))}
        </Dropdown>
      </PlanSub>
    </div>
  );
}

function PlanSub({
  title,
  loading,
  empty,
  children,
}: {
  title: string;
  loading?: boolean;
  empty?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation('tasks');
  const arr = React.Children.toArray(children);
  const hasContent = arr.length > 0;
  return (
    <div style={{ marginTop: 12 }}>
      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          marginBottom: 6,
          fontSize: 11,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontWeight: 600,
        }}
      >
        <span>{title}</span>
        {loading && <span style={{ textTransform: 'none' }}>{t('planning.loading')}</span>}
      </div>
      {!hasContent && empty && (
        <div className="td-empty" style={{ fontSize: 12, marginBottom: 6 }}>
          {empty}
        </div>
      )}
      {children}
    </div>
  );
}

/** Petit sélecteur de type de dépendance (4 options + aide), utilisé au
 *  moment de créer un lien (Lot 1c.3). Empêche le clic d'ouvrir/refermer le
 *  `Dropdown` englobant (qui ferme sur tout clic dans son menu). */
function DepTypePicker({
  value,
  onChange,
}: {
  value: DependencyType;
  onChange: (t: DependencyType) => void;
}) {
  const { t } = useTranslation('tasks');
  return (
    <div
      className="dd-item"
      style={{ cursor: 'default', gap: 8 }}
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
        {t('common:depType.pickerLabel')}
      </span>
      <select
        className="td-select-inline"
        value={value}
        title={t(`common:depType.${value}.help`)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value as DependencyType)}
        style={{ marginLeft: 'auto' }}
      >
        {(['FS', 'SS', 'FF', 'SF'] as const).map((dt) => (
          <option key={dt} value={dt}>
            {t(`common:depType.${dt}.label`)}
          </option>
        ))}
      </select>
    </div>
  );
}

function DepRow({
  icon,
  title,
  isGroup,
  type,
  lagDays,
  onRemove,
  onChangeType,
  muted,
}: {
  icon: string;
  title: string;
  isGroup?: boolean;
  type: string;
  lagDays: number;
  onRemove?: () => void;
  /** Change le type d'un lien EXISTANT (Lot 1c.3). Absent = affichage figé
   *  (compat. avec d'éventuels appelants read-only futurs). */
  onChangeType?: (type: DependencyType) => void;
  muted?: boolean;
}) {
  const { t } = useTranslation('tasks');
  return (
    <div
      className="row gap2"
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--bg-2)',
        marginBottom: 4,
        fontSize: 13,
        opacity: muted ? 0.85 : 1,
        minWidth: 0,
      }}
    >
      <Icon
        name={isGroup ? 'branch' : icon}
        size={13}
        style={{ color: isGroup ? 'var(--accent)' : 'var(--text-3)', flexShrink: 0 }}
      />
      <span
        className="grow"
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
        title={title}
      >
        {title}
      </span>
      {onChangeType ? (
        <span className="row gap1" style={{ flexShrink: 0, alignItems: 'center' }}>
          <select
            className="mono td-select-inline"
            value={type}
            title={t(`common:depType.${type}.help`)}
            onChange={(e) => onChangeType(e.target.value as DependencyType)}
            style={{ fontSize: 11, color: 'var(--text-3)' }}
          >
            {(['FS', 'SS', 'FF', 'SF'] as const).map((dt) => (
              <option key={dt} value={dt}>
                {dt}
              </option>
            ))}
          </select>
          {lagDays !== 0 && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {`+${lagDays}d`}
            </span>
          )}
        </span>
      ) : (
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}
        >
          {type}
          {lagDays ? ` +${lagDays}d` : ''}
        </span>
      )}
      {onRemove && (
        <button
          className="icon-btn"
          onClick={onRemove}
          title={t('planning.removeDependency')}
          style={{ width: 22, height: 22, flexShrink: 0 }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/* ============================================================
   Start date row.
   When the task is a group, changing the start date opens a small
   modal listing descendant tasks so the user can pick which ones
   should also adopt the new start date.
   ============================================================ */
function StartDateRow({
  task,
  monday,
  allTasks,
  onUpdate,
  onUpdateOther,
}: {
  task: Task;
  monday: Date;
  allTasks: Task[];
  onUpdate: (patch: Partial<Task>) => void;
  onUpdateOther: (id: string, patch: Partial<Task>) => void;
}) {
  const { locale } = useFormat();
  const { t } = useTranslation('tasks');
  const [cascadeFor, setCascadeFor] = useState<number | null>(null);
  // Descendants leaf-tasks (non-group) of the current task, computed lazily.
  const descendants = useMemo(() => {
    if (!task.isGroup) return [];
    const out: Task[] = [];
    const stack = [task.id];
    const visited = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const t of allTasks) {
        if (t.parentTaskId === cur) {
          out.push(t);
          if (t.isGroup) stack.push(t.id);
        }
      }
    }
    return out;
  }, [task, allTasks]);

  const iso = dueOffsetToIso(task.start ?? null, monday);
  const overdue =
    task.start != null && task.due != null && task.start > task.due;

  return (
    <>
      <div className="row gap1" style={{ alignItems: 'center' }}>
        <Icon
          name="cal"
          size={14}
          style={{
            color: overdue
              ? 'var(--c-bad, oklch(0.65 0.18 25))'
              : 'var(--text-3)',
          }}
        />
        <input
          type="date"
          lang={locale}
          className="td-date mono"
          value={iso ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            const off = v ? isoToDueOffset(v, monday) : null;
            onUpdate({ start: off });
            // Pour un groupe : si on a posé une vraie date (pas null), proposer
            // de la propager aux sous-tâches.
            if (task.isGroup && off != null) {
              setCascadeFor(off);
            }
          }}
          style={{
            background: 'transparent',
            border: '1px solid var(--line)',
            color: 'var(--text-1)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 13,
            fontFamily: 'inherit',
            colorScheme: 'dark light',
          }}
        />
        {task.start != null && (
          <button
            className="icon-btn"
            onClick={() => onUpdate({ start: null })}
            title={t('detail.clearStartDate')}
            style={{ width: 22, height: 22 }}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {cascadeFor != null && (
        <StartCascadeModal
          startOffset={cascadeFor}
          monday={monday}
          group={task}
          descendants={descendants}
          onClose={() => setCascadeFor(null)}
          onApply={(ids) => {
            for (const id of ids) onUpdateOther(id, { start: cascadeFor });
            setCascadeFor(null);
          }}
        />
      )}
    </>
  );
}

/* ---- Modal: choose which child tasks adopt the group's start date ---- */
function StartCascadeModal({
  startOffset,
  monday,
  group,
  descendants,
  onClose,
  onApply,
}: {
  startOffset: number;
  monday: Date;
  group: Task;
  descendants: Task[];
  onClose: () => void;
  onApply: (ids: string[]) => void;
}) {
  const { t } = useTranslation('tasks');
  // Par défaut : on coche les tâches qui n'ont PAS encore de start, et
  // celles dont le start serait postérieur à la nouvelle date (ça raccourcit
  // probablement la planif). Les groupes intermédiaires ne sont pas cochés
  // par défaut — l'utilisateur peut les cocher manuellement.
  const initial = useMemo(() => {
    const s = new Set<string>();
    for (const t of descendants) {
      if (t.isGroup) continue;
      if (t.start == null || t.start > startOffset) s.add(t.id);
    }
    return s;
  }, [descendants, startOffset]);
  const [selected, setSelected] = useState<Set<string>>(initial);

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const isoLabel = dueOffsetToIso(startOffset, monday);

  // Group descendants by their parent so the user sees the structure.
  const byParent = new Map<string, Task[]>();
  for (const t of descendants) {
    const p = t.parentTaskId ?? group.id;
    const arr = byParent.get(p) ?? [];
    arr.push(t);
    byParent.set(p, arr);
  }
  function renderChildren(parentId: string, depth: number): React.ReactNode {
    const kids = byParent.get(parentId) ?? [];
    if (kids.length === 0) return null;
    return kids.map((ct) => (
      <React.Fragment key={ct.id}>
        <label
          className="row gap2"
          style={{
            padding: '6px 8px 6px ' + (8 + depth * 16) + 'px',
            borderRadius: 6,
            cursor: 'pointer',
            background: selected.has(ct.id)
              ? 'oklch(from var(--accent) l c h / 0.12)'
              : 'transparent',
            fontSize: 13,
            border: '1px solid transparent',
          }}
        >
          <input
            type="checkbox"
            checked={selected.has(ct.id)}
            onChange={() => toggle(ct.id)}
          />
          <Icon
            name={ct.isGroup ? 'branch' : 'board'}
            size={13}
            style={{ color: ct.isGroup ? 'var(--accent)' : 'var(--text-3)' }}
          />
          <span className="grow truncate" style={{ textAlign: 'left' }}>
            {ct.title}
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {ct.start != null
              ? dueOffsetToIso(ct.start, monday)
              : t('cascade.noStart')}
          </span>
        </label>
        {ct.isGroup && renderChildren(ct.id, depth + 1)}
      </React.Fragment>
    ));
  }

  const leafCount = descendants.filter((t) => !t.isGroup).length;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t('cascade.dialogLabel')}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: 'min(520px, 92vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 18px 48px oklch(0 0 0 / 0.45)',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {t('cascade.title')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {t('cascade.intro', { date: isoLabel, group: group.title })}
          </div>
        </div>
        <div
          style={{
            padding: '8px 8px',
            overflowY: 'auto',
            flex: 1,
            minHeight: 60,
          }}
        >
          {leafCount === 0 ? (
            <div
              style={{
                padding: 20,
                textAlign: 'center',
                color: 'var(--text-3)',
                fontSize: 13,
              }}
            >
              {t('cascade.noChildren')}
            </div>
          ) : (
            renderChildren(group.id, 0)
          )}
        </div>
        <div
          className="row gap2"
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border)',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('cascade.selectedOf', { selected: selected.size, total: descendants.length })}
          </div>
          <div className="row gap1">
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              {t('cascade.skip')}
            </button>
            <button
              className="btn btn-accent btn-sm"
              onClick={() => onApply([...selected])}
              disabled={selected.size === 0}
            >
              {selected.size > 1 ? t('cascade.applyMany', { count: selected.size }) : t('cascade.applyOne', { count: selected.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Estimate field.
   - Regular task: editable number input (hours).
   - Group: read-only sum of all descendant non-group tasks. Updated live
     from local state — when a child's estimate changes, the Workspace's
     updateTask propagates the new sum up to every ancestor group both
     locally and via the API.
   ============================================================ */
/**
 * Heures par jour ouvré — **valeur de repli uniquement**. La vraie valeur vient
 * désormais du backend (`org.hoursPerDay`, panneau admin > Working Time), exposée
 * via `/admin/settings/public` et lue dans les composants par
 * `useAuth().orgSettings.hoursPerDay`. Cette constante ne sert plus que de défaut
 * statique (composants non montés sous l'AuthProvider, ou paramètre optionnel).
 */
export const HOURS_PER_DAY = 8;

function EstimateField({
  task,
  allTasks,
  onUpdate,
}: {
  task: Task;
  allTasks: Task[];
  onUpdate: (patch: Partial<Task>) => void;
}) {
  const { t } = useTranslation('tasks');
  const { orgSettings } = useAuth();
  const hoursPerDay = orgSettings.hoursPerDay;
  // Unité d'affichage (heures ou jours). Mémorisée par utilisateur via localStorage
  // pour que le choix persiste entre les ouvertures du panneau.
  const [unit, setUnit] = useState<'h' | 'd'>(() => {
    try {
      return (localStorage.getItem('vaks.estimate.unit') as 'h' | 'd') ?? 'h';
    } catch {
      return 'h';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('vaks.estimate.unit', unit);
    } catch {
      /* ignore */
    }
  }, [unit]);

  const rollup = useMemo(() => {
    if (!task.isGroup) return null;
    let total = 0;
    let leafCount = 0;
    const stack = [task.id];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const t of allTasks) {
        if (t.parentTaskId !== cur) continue;
        if (t.isGroup) {
          stack.push(t.id);
        } else if (typeof t.estimate === 'number') {
          total += t.estimate;
          leafCount++;
        }
      }
    }
    return { total: Math.round(total * 100) / 100, leafCount };
  }, [task, allTasks]);

  const unitToggle = (
    <UnitToggle unit={unit} onChange={setUnit} hoursPerDay={hoursPerDay} />
  );

  if (task.isGroup) {
    const totalH = rollup?.total ?? 0;
    const display =
      unit === 'd'
        ? `${(Math.round((totalH / hoursPerDay) * 2) / 2).toFixed(1)}d`
        : `${totalH}h`;
    return (
      <span
        className="mono td-time-est"
        title={t('estimate.rolledUpTitle')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {rollup && rollup.leafCount > 0 ? (
          <>
            {display} {t('estimate.estimated')}{' '}
            <span className="td-empty" style={{ fontSize: 11 }}>
              {rollup.leafCount > 1
                ? t('estimate.rolledUpFromMany', { count: rollup.leafCount })
                : t('estimate.rolledUpFromOne', { count: rollup.leafCount })}
            </span>
          </>
        ) : (
          <span className="td-empty">{t('estimate.noEstimateNoChild')}</span>
        )}
        {unitToggle}
      </span>
    );
  }

  // Conversion : l'entité stockée est `estimate` en HEURES. En mode jours on
  // affiche la valeur divisée, et on snap à 0.5 jour. En mode heures, step=0.25.
  const stepperValue =
    task.estimate == null
      ? null
      : unit === 'd'
        ? Math.round((task.estimate / hoursPerDay) * 2) / 2
        : task.estimate;
  const stepperStep = unit === 'd' ? 0.5 : 0.25;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <NumberStepper
        value={stepperValue}
        onChange={(v) => {
          if (v == null) return onUpdate({ estimate: null });
          // En mode jours on a déjà snap (snap=true) -> v est multiple de 0.5.
          // On reconvertit en heures pour la persistance.
          const hours = unit === 'd' ? v * hoursPerDay : v;
          onUpdate({ estimate: hours });
        }}
        step={stepperStep}
        min={0}
        snap={unit === 'd'}
        ariaLabel={unit === 'd' ? t('estimate.estimatedDays') : t('estimate.estimatedHours')}
      />
      <span className="td-empty mono" style={{ fontSize: 12 }}>
        {t('estimate.estimated')}
      </span>
      {unitToggle}
    </span>
  );
}

/** Petit toggle h / d à droite du stepper d'estimation. */
function UnitToggle({
  unit,
  onChange,
  hoursPerDay = HOURS_PER_DAY,
}: {
  unit: 'h' | 'd';
  onChange: (u: 'h' | 'd') => void;
  hoursPerDay?: number;
}) {
  const { t } = useTranslation('tasks');
  return (
    <span
      role="group"
      aria-label={t('estimate.unit')}
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border, var(--line))',
        borderRadius: 6,
        overflow: 'hidden',
        height: 22,
        fontSize: 11,
        fontFamily: 'inherit',
      }}
    >
      {(['h', 'd'] as const).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          style={{
            background: unit === u ? 'var(--accent)' : 'transparent',
            color: unit === u ? '#fff' : 'var(--text-3)',
            border: 0,
            padding: '0 8px',
            cursor: 'pointer',
            fontWeight: 600,
            fontFamily: 'inherit',
            minWidth: 22,
          }}
          title={u === 'h' ? t('estimate.hours') : t('estimate.days', { hours: hoursPerDay })}
        >
          {u}
        </button>
      ))}
    </span>
  );
}

/* ============================================================
   Schedule overrun note.
   Computes the projected end date from `start + estimate / HOURS_PER_DAY`
   and warns if it falls after the due date. Shown only when both `start`
   and `due` are set and `estimate > 0`.
   ============================================================ */
/* ============================================================
   Group color picker. Shows the 10 preset swatches + a "clear" slot.
   The currently selected swatch is outlined with the accent and a
   check mark inside.
   ============================================================ */
function GroupColorPicker({
  color,
  onChange,
}: {
  color: string | null;
  onChange: (hex: string | null) => void;
}) {
  const { t } = useTranslation('tasks');
  const current = color ? color.toLowerCase() : null;
  const Swatch = ({
    hex,
    title,
    children,
  }: {
    hex: string | null;
    title: string;
    children?: React.ReactNode;
  }) => {
    const selected =
      (hex === null && current === null) ||
      (hex !== null && current === hex.toLowerCase());
    return (
      <button
        type="button"
        onClick={() => onChange(hex)}
        title={title}
        aria-label={title}
        aria-pressed={selected}
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          border: selected
            ? '2px solid var(--accent)'
            : '1px solid var(--border, var(--line))',
          background: hex ?? 'transparent',
          padding: 0,
          cursor: 'pointer',
          display: 'inline-grid',
          placeItems: 'center',
          color: '#fff',
          boxShadow: selected
            ? '0 0 0 2px oklch(from var(--accent) l c h / 0.25)'
            : 'none',
          transition: 'transform 0.12s, box-shadow 0.12s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = '';
        }}
      >
        {children}
      </button>
    );
  };
  return (
    <span
      role="group"
      aria-label={t('color.groupColor')}
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
      }}
    >
      <Swatch hex={null} title={t('color.noColor')}>
        <Icon
          name="x"
          size={11}
          style={{
            color: current ? 'var(--text-3)' : 'var(--accent)',
          }}
        />
      </Swatch>
      {GROUP_COLORS.map((c) => (
        <Swatch key={c.hex} hex={c.hex} title={c.name}>
          {current === c.hex.toLowerCase() && (
            <Icon name="check" size={12} />
          )}
        </Swatch>
      ))}
    </span>
  );
}

function ScheduleOverrunNote({ task, monday }: { task: Task; monday: Date }) {
  const { orgSettings } = useAuth();
  const { t } = useTranslation('tasks');
  if (task.start == null || task.due == null) return null;
  if (!task.estimate || task.estimate <= 0) return null;
  // Fin projetée = même calcul que le bouton "↻ Suggest due" pour rester
  // cohérent : capacité combinée des assignees × HOURS_PER_DAY, on saute
  // les week-ends, on consomme l'estimate. Avant on faisait `start +
  // ceil(estimate/8)` en JOURS CALENDAIRES, ce qui ignorait les weekends
  // et avait un off-by-one (un 5-day task démarré Lundi finissait "Samedi
  // = +1 vs Vendredi" alors que c'est en fait Vendredi).
  const projectedEndOffset = computeSuggestedDueOffset(
    task.start,
    task.estimate,
    task.assignees?.length ?? 0,
    monday,
    orgSettings.hoursPerDay,
  );
  if (projectedEndOffset <= task.due) return null;
  const projectedIso = dueOffsetToIso(projectedEndOffset, monday);
  const dueIso = dueOffsetToIso(task.due, monday);
  const overByDays = projectedEndOffset - task.due;
  return (
    <div
      className="td-over-note"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
        fontSize: 12,
        color: 'oklch(0.7 0.18 25)',
      }}
    >
      <Icon name="warn" size={13} />
      <span>
        {t('overrun.endsPast', { end: projectedIso, due: dueIso })}{' '}
        <span className="td-empty" style={{ fontSize: 11 }}>
          {t('overrun.overByDays', { days: overByDays })}
        </span>
      </span>
    </div>
  );
}

/* ============================================================
   Allocations section (Phase 5)
   Liste les allocations (user × plage × h/jour) pour la tâche.
   Permet de saisir directement "2h/j sur 10 jours" sans passer
   par la vue Workload. Total prévu calculé en jours ouvrés
   Mon-Fri × hoursPerDay, comparé à `task.estimate` pour
   afficher un warning d'overrun.
   ============================================================ */
function workdaysBetweenIso(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const s = new Date(startIso + 'T00:00:00Z');
  const e = new Date(endIso + 'T00:00:00Z');
  if (isNaN(+s) || isNaN(+e) || +e < +s) return 0;
  let count = 0;
  for (let d = +s; d <= +e; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function AllocationsSection({
  task,
  monday,
  onUpdate,
}: {
  task: Task;
  monday: Date;
  onUpdate: (patch: Partial<Task>) => void;
}) {
  const { t } = useTranslation('tasks');
  const confirm = useConfirm();
  const [allocs, setAllocs] = useState<AllocationDto[]>([]);
  const [allUsers, setAllUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    userId: '',
    startDate: '',
    endDate: '',
    hoursPerDay: '4',
  });
  const [busy, setBusy] = useState(false);
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [splitInfo, setSplitInfo] = useState<{
    workdays: number;
    blockedDays: number;
    effectiveHours: number;
    requestedHours: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.listAllocations({ taskId: task.id }),
      api.listUsers(),
    ])
      .then(([a, u]) => {
        if (cancelled) return;
        setAllocs(a);
        setAllUsers(u);
      })
      .catch(() => {
        /* silent: empty state */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  /** Total prévu : on préfère `effectiveHours` calculé serveur (respecte
   *  schedule/TO/fériés) ; fallback Mon-Fri si l'API n'envoie pas le champ
   *  (compat ancienne version). */
  const totalHours = useMemo(
    () =>
      allocs.reduce(
        (s, a) =>
          s +
          (a.effectiveHours ??
            workdaysBetweenIso(a.startDate, a.endDate) * a.hoursPerDay),
        0,
      ),
    [allocs],
  );

  async function add() {
    if (!form.userId || !form.startDate || !form.endDate) {
      setError(t('alloc.errPickUserRange'));
      return;
    }
    const hpd = parseFloat(form.hoursPerDay);
    if (!(hpd > 0)) {
      setError(t('alloc.errHoursPositive'));
      return;
    }
    if (form.endDate < form.startDate) {
      setError(t('alloc.errEndAfterStart'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createAllocation({
        userId: form.userId,
        taskId: task.id,
        startDate: form.startDate,
        endDate: form.endDate,
        hoursPerDay: hpd,
      });
      setAllocs((prev) => [...prev, created]);
      setAdding(false);
      setForm({ userId: '', startDate: '', endDate: '', hoursPerDay: '4' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ title: t('common:delete'), message: t('alloc.confirmDeleteOne'), confirmLabel: t('common:delete'), danger: true }))) return;
    try {
      await api.deleteAllocation(id);
      setAllocs((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  async function removeAll() {
    if (allocs.length === 0) return;
    if (
      !(await confirm({ title: t('common:delete'), message: t('alloc.confirmDeleteAll', { count: allocs.length }), confirmLabel: t('common:delete'), danger: true }))
    )
      return;
    setBusy(true);
    // Suppression en parallèle, on tolère les échecs partiels : on enlève
    // d'abord les OK, puis on signale les KO. Plus prévisible côté UI qu'une
    // suppression séquentielle qui s'arrête à la première erreur.
    const ids = allocs.map((a) => a.id);
    const results = await Promise.allSettled(
      ids.map((id) => api.deleteAllocation(id)),
    );
    const failed: string[] = [];
    const deletedOk = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') deletedOk.add(ids[i]);
      else failed.push((r.reason as Error).message);
    });
    setAllocs((prev) => prev.filter((a) => !deletedOk.has(a.id)));
    setBusy(false);
    if (failed.length) {
      window.alert(
        t('alloc.couldNotDelete', { count: failed.length }) + '\n' +
          failed.join('\n'),
      );
    }
  }

  async function patchAlloc(id: string, dto: UpdateAllocationDto) {
    try {
      const upd = await api.updateAllocation(id, dto);
      setAllocs((prev) => prev.map((a) => (a.id === id ? upd : a)));
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  /** On ne propose à l'allocation QUE les users déjà assignés à la tâche :
   *  ça force à passer par l'attribution (champ Assignees) d'abord, qui
   *  porte les règles RBAC et la cohérence avec le board. */
  const sortedUsers = useMemo(() => {
    const assigned = new Set(task.assignees);
    return allUsers
      .filter((u) => assigned.has(u.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allUsers, task.assignees]);

  const est = task.estimate ?? null;
  const overEst = est != null && totalHours > est + 0.01;
  const underEst = est != null && totalHours > 0 && totalHours < est - 0.01;

  return (
    <div className="td-section">
      <div
        className="td-stitle row"
        style={{ justifyContent: 'space-between', alignItems: 'baseline' }}
      >
        <span>
          {t('alloc.title')} <span className="mono td-stcount">{allocs.length}</span>
        </span>
        {!adding && (
          <div className="row" style={{ gap: 6 }}>
            {allocs.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={removeAll}
                disabled={busy}
                title={t('alloc.deleteAllTitle', { count: allocs.length })}
                style={{ color: 'var(--c-over, #d33)' }}
              >
                {busy ? t('alloc.deleting') : t('alloc.deleteAll')}
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setError(null);
                setSplitDialogOpen(true);
              }}
              disabled={
                task.assignees.length === 0 ||
                task.estimate == null ||
                task.estimate <= 0
              }
              title={
                task.assignees.length === 0
                  ? t('alloc.assignFirst')
                  : task.estimate == null
                    ? t('alloc.setEstimateFirst')
                    : t('alloc.openPlanner')
              }
            >
              {t('alloc.autoSplit')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setError(null);
                const firstAssignee = task.assignees[0] ?? '';
                setForm((f) => ({ ...f, userId: f.userId || firstAssignee }));
                setAdding(true);
              }}
              disabled={task.assignees.length === 0}
              title={
                task.assignees.length === 0
                  ? t('alloc.allocateDisabledHint')
                  : ''
              }
            >
              {t('alloc.allocate')}
            </button>
          </div>
        )}
      </div>

      {est != null && (
        <div className="td-prop" style={{ gridTemplateColumns: '100px 1fr' }}>
          <span className="td-plabel">{t('alloc.planned')}</span>
          <span className="td-pval mono" style={{ gap: 8, flexWrap: 'wrap' }}>
            {totalHours.toFixed(1)}h{' '}
            <span className="td-empty" style={{ fontWeight: 400 }}>
              {t('alloc.ofEstimate', { hours: est })}
            </span>
            {overEst && (
              <span className="td-over-note" style={{ marginLeft: 6 }}>
                <Icon name="warn" size={12} /> {t('alloc.overBy', { hours: (totalHours - est).toFixed(1) })}
              </span>
            )}
            {underEst && (
              <span
                className="td-empty"
                style={{ marginLeft: 6, fontSize: 12 }}
              >
                {t('alloc.stillToPlan', { hours: (est - totalHours).toFixed(1) })}
              </span>
            )}
          </span>
        </div>
      )}

      {loading ? (
        <div className="td-empty">{t('common:loading')}</div>
      ) : allocs.length === 0 && !adding ? (
        <div className="td-empty">
          {task.assignees.length === 0
            ? t('alloc.emptyNoAssignee')
            : t('alloc.empty')}
        </div>
      ) : (
        <div className="td-entries">
          {allocs.map((a) => {
            const u = allUsers.find((x) => x.id === a.userId) ?? null;
            // Préfère les chiffres serveur (schedule/TO/fériés-aware) sinon
            // fallback Mon-Fri × h/d pour compat clients anciens.
            const wd =
              a.workdays ?? workdaysBetweenIso(a.startDate, a.endDate);
            const total =
              a.effectiveHours ??
              workdaysBetweenIso(a.startDate, a.endDate) * a.hoursPerDay;
            const blocked = a.blockedDays ?? 0;
            const name = u?.name ?? a.user?.name ?? a.userId.slice(0, 8);
            return (
              <div className="td-entry" key={a.id}>
                <span className="td-entry-note grow truncate">
                  <b>{name}</b>{' '}
                  <span className="td-empty" style={{ fontWeight: 400 }}>
                    {a.startDate} → {a.endDate} · {wd} {wd > 1 ? t('alloc.workdayMany') : t('alloc.workdayOne')}
                    {blocked > 0 && (
                      <> · <span title={t('alloc.skippedTitle')}>
                        {t('alloc.skipped', { count: blocked })}
                      </span></>
                    )}
                  </span>
                </span>
                <input
                  type="number"
                  min={0.25}
                  max={24}
                  step={0.25}
                  className="td-in td-in-h"
                  defaultValue={a.hoursPerDay}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (v > 0 && v !== a.hoursPerDay) {
                      patchAlloc(a.id, { hoursPerDay: v });
                    } else if (!(v > 0)) {
                      e.target.value = String(a.hoursPerDay);
                    }
                  }}
                  title={t('alloc.hoursPerWorkday')}
                />
                <span className="td-in-unit">h/d</span>
                <span className="mono td-entry-h">= {total.toFixed(1)}h</span>
                <button
                  className="btn btn-ghost btn-sm"
                  title={t('alloc.removeAllocation')}
                  onClick={() => remove(a.id)}
                  style={{
                    padding: '4px 8px',
                    color: 'var(--c-over, #d33)',
                  }}
                >
                  <Icon name="x" size={13} /> {t('common:delete')}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <div className="td-manual-form" style={{ marginTop: 12 }}>
          {/* Ligne 1 : assignee (pleine largeur). */}
          <select
            className="td-in"
            value={form.userId}
            onChange={(e) =>
              setForm((f) => ({ ...f, userId: e.target.value }))
            }
            style={{ width: '100%' }}
          >
            <option value="">{t('alloc.pickAssignee')}</option>
            {sortedUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>

          {/* Ligne 2 : plage de dates. */}
          <div className="td-manual-row">
            <input
              type="date"
              className="td-in td-in-grow"
              value={form.startDate}
              onChange={(e) =>
                setForm((f) => ({ ...f, startDate: e.target.value }))
              }
            />
            <span className="td-empty">→</span>
            <input
              type="date"
              className="td-in td-in-grow"
              value={form.endDate}
              onChange={(e) =>
                setForm((f) => ({ ...f, endDate: e.target.value }))
              }
            />
          </div>

          {/* Ligne 3 : heures/jour + total prévu + actions. */}
          <div className="td-manual-row">
            <input
              type="number"
              min={0.25}
              max={24}
              step={0.25}
              className="td-in td-in-h"
              value={form.hoursPerDay}
              onChange={(e) =>
                setForm((f) => ({ ...f, hoursPerDay: e.target.value }))
              }
            />
            <span className="td-in-unit">h/d</span>
            {form.startDate && form.endDate && (
              <span className="mono td-empty" style={{ fontSize: 12 }}>
                ={' '}
                {(
                  workdaysBetweenIso(form.startDate, form.endDate) *
                  (parseFloat(form.hoursPerDay) || 0)
                ).toFixed(1)}
                h
              </span>
            )}
            <span className="grow" />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAdding(false);
                setError(null);
                setSplitInfo(null);
              }}
              disabled={busy}
            >
              {t('common:cancel')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={add}
              disabled={busy}
            >
              {busy ? t('common:saving') : t('common:add')}
            </button>
          </div>

          {error && (
            <div className="td-over-note">
              <Icon name="warn" size={12} /> {error}
            </div>
          )}
        </div>
      )}

      {/* Confirmation post-création de l'auto-split — persiste tant que
          l'user ne clique pas sur la croix. Avant elle disparaissait au
          bout de 6s, c'était trop court pour lire. */}
      {splitInfo && !adding && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            fontSize: 12,
            color: 'var(--text-2)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            padding: '8px 10px',
            marginTop: 8,
          }}
        >
          <Icon name="check" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          <div className="grow">
            <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
              {t('alloc.created')}
            </div>
            <div>
              {t('alloc.createdDetail', {
                requested: splitInfo.requestedHours.toFixed(1),
                scheduled: splitInfo.effectiveHours.toFixed(1),
                days: splitInfo.workdays,
              })}
              {splitInfo.blockedDays > 0 &&
                t('alloc.createdSkipped', { count: splitInfo.blockedDays })}
              .
            </div>
            {splitInfo.effectiveHours + 0.01 < splitInfo.requestedHours && (
              <div
                style={{
                  marginTop: 4,
                  color: 'var(--c-over, #d33)',
                  fontWeight: 600,
                }}
              >
                {t('alloc.couldNotPlace', {
                  hours: (splitInfo.requestedHours - splitInfo.effectiveHours).toFixed(1),
                })}
              </div>
            )}
          </div>
          <button
            className="icon-btn"
            onClick={() => setSplitInfo(null)}
            title={t('alloc.dismiss')}
            style={{ width: 22, height: 22 }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      {splitDialogOpen && (
        <AutoSplitDialog
          task={task}
          monday={monday}
          allUsers={allUsers}
          assignees={sortedUsers}
          alreadyPlanned={totalHours}
          existingAllocs={allocs}
          onClose={() => setSplitDialogOpen(false)}
          onCreated={(createdList, info, removedIds) => {
            setAllocs((prev) => [
              ...prev.filter((a) => !removedIds?.includes(a.id)),
              ...createdList,
            ]);
            setSplitInfo(info);
            setSplitDialogOpen(false);
          }}
          onTaskPatch={onUpdate}
        />
      )}
    </div>
  );
}

/* ============================================================
   AutoSplitDialog — modal d'aide à la planification.
   Demande la cadence souhaitée (full / half / quarter / custom),
   propose des valeurs par défaut intelligentes (start = task.start,
   total = estimate - already planned), prévisualise et flagge les
   conflits avec task.start / task.due. En cas d'impossibilité de
   tout caser avant la due date, propose 3 résolutions :
     - autoriser l'overtime
     - étendre la due date
     - renvoyer vers l'attribution d'un autre assignee
   ============================================================ */
function AutoSplitDialog({
  task,
  monday,
  allUsers,
  assignees,
  alreadyPlanned,
  existingAllocs,
  onClose,
  onCreated,
  onTaskPatch,
}: {
  task: Task;
  monday: Date;
  allUsers: UserDto[];
  assignees: UserDto[];
  alreadyPlanned: number;
  existingAllocs: AllocationDto[];
  onClose: () => void;
  onCreated: (
    created: AllocationDto[],
    info: {
      workdays: number;
      blockedDays: number;
      effectiveHours: number;
      requestedHours: number;
    },
    removedIds?: string[],
  ) => void;
  onTaskPatch: (patch: Partial<Task>) => void;
}) {
  const { t } = useTranslation('tasks');
  const { orgSettings } = useAuth();
  const taskStartIso = dueOffsetToIso(task.start ?? null, monday);
  const taskDueIso = dueOffsetToIso(task.due ?? null, monday);
  const defaultRemaining = Math.max(
    (task.estimate ?? 0) - alreadyPlanned,
    0,
  );

  const [userId, setUserId] = useState<string>(
    assignees[0]?.id ?? task.assignees[0] ?? '',
  );
  const [startDate, setStartDate] = useState<string>(
    taskStartIso ?? new Date().toISOString().slice(0, 10),
  );
  const [pace, setPace] = useState<'full' | 'half' | 'quarter' | 'custom'>(
    'full',
  );
  const [customHpd, setCustomHpd] = useState<string>('4');
  const [userSchedule, setUserSchedule] = useState<WorkScheduleDto | null>(
    null,
  );
  // Default : ce qui reste à planifier. Avant on retombait sur task.estimate
  // quand defaultRemaining === 0, ce qui faisait doublonner les allocations
  // si l'utilisateur rouvrait le dialogue. On préfère afficher 0 + un
  // warning explicite (la création devient impossible tant qu'on n'a pas
  // bumpé manuellement OU activé "replace existing").
  const [totalHours, setTotalHours] = useState<string>(String(defaultRemaining));
  const [constrainByDue, setConstrainByDue] = useState<boolean>(
    !!taskDueIso,
  );
  const [allowOvertime, setAllowOvertime] = useState(false);
  // Quand on planifie pour un user qui a déjà des allocations sur cette
  // tâche, on offre l'option "remplacer" : les anciennes sont supprimées
  // avant de créer les nouvelles. Évite de cumuler en rouvrant le dialogue.
  const [replaceExisting, setReplaceExisting] = useState(false);

  // --- Mode multi-personnes : répartit le total sur plusieurs assignees.
  // Activable seulement si la tâche a au moins 2 assignees. En mode multi
  // on n'utilise plus `userId`/`pace` mais la checklist + la stratégie.
  const canMulti = assignees.length >= 2;
  const [multiMode, setMultiMode] = useState(false);
  const [multiUserIds, setMultiUserIds] = useState<string[]>(
    assignees.map((u) => u.id),
  );
  const [strategy, setStrategy] = useState<
    'proportional' | 'equal' | 'greedy'
  >('proportional');

  const [preview, setPreview] = useState<{
    endDate: string;
    workdays: number;
    blockedDays: number;
    effectiveHours: number;
    requestedHours: number;
    shortfallHours: number;
    hitDeadline: boolean;
    chunks: Array<{ startDate: string; endDate: string; hoursPerDay: number }>;
  } | null>(null);
  const [multiPreview, setMultiPreview] = useState<{
    startDate: string;
    endDate: string;
    requestedHours: number;
    effectiveHours: number;
    shortfallHours: number;
    hitDeadline: boolean;
    peopleUsed: number;
    peopleShort: number;
    perUser: Array<{
      userId: string;
      targetHours: number;
      effectiveHours: number;
      workdays: number;
      blockedDays: number;
      shortfallHours: number;
      startDate: string;
      endDate: string;
      chunks: Array<{ startDate: string; endDate: string; hoursPerDay: number }>;
    }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Capacité quotidienne du user : on prend le max des heures contractuelles
  // sur la semaine × le pourcentage d'occupation. Représente "une journée
  // pleine pour cette personne" (8h pour un full-time standard, 4h pour un
  // mi-temps à 4h/j, etc.). Fallback HOURS_PER_DAY tant que le schedule
  // n'est pas chargé.
  const userDailyCap = useMemo(() => {
    if (!userSchedule) return orgSettings.hoursPerDay;
    const maxHours = Math.max(
      userSchedule.hoursMon,
      userSchedule.hoursTue,
      userSchedule.hoursWed,
      userSchedule.hoursThu,
      userSchedule.hoursFri,
      userSchedule.hoursSat,
      userSchedule.hoursSun,
    );
    const occ = (userSchedule.occupancyPct ?? 100) / 100;
    return Math.round(maxHours * occ * 100) / 100;
  }, [userSchedule, orgSettings.hoursPerDay]);

  const hoursPerDay = useMemo(() => {
    if (pace === 'full') return userDailyCap;
    if (pace === 'half') return 4;
    if (pace === 'quarter') return 2;
    return parseFloat(customHpd) || 0;
  }, [pace, customHpd, userDailyCap]);

  // Charge le schedule du user choisi (pour calibrer "full day" et les
  // warnings). Refait à chaque changement d'assignee.
  useEffect(() => {
    if (!userId) {
      setUserSchedule(null);
      return;
    }
    let cancelled = false;
    api
      .getWorkSchedule(userId)
      .then((s) => {
        if (!cancelled) setUserSchedule(s);
      })
      .catch(() => {
        if (!cancelled) setUserSchedule(null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // ESC pour fermer.
  useEffect(() => {
    function esc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  // Warnings purement front (la vérité finale vient du preview serveur).
  const startBeforeTaskStart =
    taskStartIso != null && startDate < taskStartIso;

  async function computePreview() {
    setError(null);
    setPreview(null);
    if (!userId) {
      setError(t('autoSplit.errPickAssignee'));
      return;
    }
    const total = parseFloat(totalHours);
    if (!(total > 0)) {
      setError(t('autoSplit.errTotalPositive'));
      return;
    }
    if (!(hoursPerDay > 0)) {
      setError(t('autoSplit.errPacePositive'));
      return;
    }
    setBusy(true);
    try {
      // Si on est en mode "replace existing", on demande au serveur
      // d'ignorer les allocations qu'on va supprimer juste après — sinon
      // il croit que ces jours sont déjà occupés et reporte un faux
      // shortfall ("cannot fit in the deadline").
      const excludeAllocationIds = replaceExisting
        ? existingAllocs
            .filter((a) => a.userId === userId)
            .map((a) => a.id)
        : undefined;
      const res = await api.autoSplitAllocation({
        userId,
        taskId: task.id,
        startDate,
        totalHours: total,
        hoursPerDay,
        mustFinishBy:
          constrainByDue && taskDueIso ? taskDueIso : undefined,
        allowOvertime,
        excludeAllocationIds,
      });
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function computeMultiPreview() {
    setError(null);
    setMultiPreview(null);
    if (multiUserIds.length === 0) {
      setError(t('autoSplit.errPickAtLeastOne'));
      return;
    }
    const total = parseFloat(totalHours);
    if (!(total > 0)) {
      setError(t('autoSplit.errTotalPositive'));
      return;
    }
    setBusy(true);
    try {
      const res = await api.autoSplitMultiAllocation({
        taskId: task.id,
        userIds: multiUserIds,
        startDate,
        totalHours: total,
        strategy,
        // En mode multi, le pace "custom" sert de plafond par personne ;
        // sinon on remplit chacun à pleine capacité (côté serveur).
        hoursPerDayCap: pace === 'custom' ? parseFloat(customHpd) || undefined : undefined,
        mustFinishBy: constrainByDue && taskDueIso ? taskDueIso : undefined,
        allowOvertime,
      });
      setMultiPreview(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Re-compute le preview à chaque changement de paramètre (debounce léger).
  // En mode multi on appelle l'endpoint multi, sinon le mono.
  useEffect(() => {
    if (!startDate) return;
    if (multiMode) {
      if (multiUserIds.length === 0) return;
    } else if (!userId) {
      return;
    }
    const t = window.setTimeout(() => {
      if (multiMode) void computeMultiPreview();
      else void computePreview();
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    multiMode,
    multiUserIds,
    strategy,
    userId,
    startDate,
    totalHours,
    hoursPerDay,
    customHpd,
    pace,
    constrainByDue,
    allowOvertime,
    replaceExisting,
  ]);

  const endAfterTaskDue =
    preview != null &&
    taskDueIso != null &&
    preview.endDate > taskDueIso &&
    !constrainByDue;

  async function createMultiIt() {
    if (!multiPreview) return;
    setBusy(true);
    setError(null);
    try {
      // Une allocation par chunk et par personne. Les co-assignees non
      // mobilisés (chunks vides en greedy) sont simplement ignorés.
      const createdList: AllocationDto[] = [];
      for (const p of multiPreview.perUser) {
        for (const c of p.chunks) {
          const a = await api.createAllocation({
            userId: p.userId,
            taskId: task.id,
            startDate: c.startDate,
            endDate: c.endDate,
            hoursPerDay: c.hoursPerDay,
            origin: 'auto_split',
          });
          createdList.push(a);
        }
      }
      const totalWorkdays = multiPreview.perUser.reduce(
        (s, p) => s + p.workdays,
        0,
      );
      const totalBlocked = multiPreview.perUser.reduce(
        (s, p) => s + p.blockedDays,
        0,
      );
      onCreated(createdList, {
        workdays: totalWorkdays,
        blockedDays: totalBlocked,
        effectiveHours: multiPreview.effectiveHours,
        requestedHours: multiPreview.requestedHours,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createIt() {
    if (!preview) return;
    if (preview.shortfallHours > 0.01) {
      setError(
        t('autoSplit.cannotPlaceResolution', { hours: preview.shortfallHours.toFixed(1) }),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // (Replace mode) D'abord supprimer les allocations existantes : pour
      // le user choisi si l'utilisateur veut juste re-planifier sa part, OU
      // toutes les allocs de la tâche si on veut un reset complet. On va au
      // plus simple : on supprime celles du user choisi UNIQUEMENT (les
      // co-assignees ne sont pas touchés — c'est leur planning à eux).
      const removedIds: string[] = [];
      if (replaceExisting) {
        const toDelete = existingAllocs.filter((a) => a.userId === userId);
        for (const a of toDelete) {
          await api.deleteAllocation(a.id);
          removedIds.push(a.id);
        }
      }
      // Une allocation par chunk : ça évite de surévaluer le dernier jour
      // (ex. 41h à 4h/j = 10j×4h + 1j×1h, pas 11j×4h). Fallback sur l'ancien
      // mode "1 seule allocation" si le serveur n'a pas renvoyé de chunks
      // (compat).
      const chunks =
        preview.chunks && preview.chunks.length > 0
          ? preview.chunks
          : [
              {
                startDate,
                endDate: preview.endDate,
                hoursPerDay,
              },
            ];
      const createdList: AllocationDto[] = [];
      for (const c of chunks) {
        const a = await api.createAllocation({
          userId,
          taskId: task.id,
          startDate: c.startDate,
          endDate: c.endDate,
          hoursPerDay: c.hoursPerDay,
          origin: 'auto_split',
        });
        createdList.push(a);
      }
      onCreated(
        createdList,
        {
          workdays: preview.workdays,
          blockedDays: preview.blockedDays,
          effectiveHours: preview.effectiveHours,
          requestedHours: preview.requestedHours,
        },
        removedIds.length > 0 ? removedIds : undefined,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Résolution "déplacer la due date" : on convertit le nouvel endDate en
  // offset (jours depuis monday) et on patche la tâche, puis on désactive
  // le constraint pour que le preview recharge sans deadline.
  function extendDueDate() {
    if (!preview) return;
    const newOffset = isoToDueOffset(preview.endDate, monday);
    onTaskPatch({ due: newOffset });
    setConstrainByDue(false);
  }

  const userName = (uid: string) =>
    allUsers.find((u) => u.id === uid)?.name ?? uid.slice(0, 8);

  return (
    <div
      className="md-overlay"
      onMouseDown={onClose}
      style={{ zIndex: 1000 }}
    >
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(640px, 96vw)' }}
      >
        <div className="md-head">
          <div className="anav-mark" style={{ width: 38, height: 38 }}>
            <Icon name="zap" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('autoSplit.eyebrow')}</div>
            <div className="md-title">{t('autoSplit.title')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div style={{ padding: 16, display: 'grid', gap: 14 }}>
          {/* Toggle multi-personnes (≥ 2 assignees) */}
          {canMulti && (
            <label
              className="row"
              style={{
                gap: 8,
                cursor: 'pointer',
                alignItems: 'center',
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                background: multiMode ? 'var(--surface-2)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={multiMode}
                onChange={(e) => setMultiMode(e.target.checked)}
              />
              <span>
                <b>{t('autoSplit.spreadMultiple')}</b>{' '}
                <span className="td-empty" style={{ fontSize: 12 }}>
                  {t('autoSplit.spreadMultipleHint')}
                </span>
              </span>
            </label>
          )}

          {/* Assignee (mono) ou checklist + stratégie (multi) */}
          {!multiMode ? (
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="td-plabel">{t('autoSplit.assignee')}</span>
              <select
                className="td-in"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="">{t('alloc.pickAssignee')}</option>
                {assignees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gap: 4 }}>
                <span className="td-plabel">
                  {t('autoSplit.people')}{' '}
                  <span className="td-empty" style={{ fontWeight: 400 }}>
                    {t('autoSplit.peopleSelected', { selected: multiUserIds.length, total: assignees.length })}
                  </span>
                </span>
                <div
                  className="row"
                  style={{ gap: 10, flexWrap: 'wrap' }}
                >
                  {assignees.map((u) => (
                    <label
                      key={u.id}
                      className="row"
                      style={{ gap: 4, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={multiUserIds.includes(u.id)}
                        onChange={(e) =>
                          setMultiUserIds((prev) =>
                            e.target.checked
                              ? [...prev, u.id]
                              : prev.filter((x) => x !== u.id),
                          )
                        }
                      />
                      <span>{u.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                <span className="td-plabel">{t('autoSplit.distributionStrategy')}</span>
                <div
                  className="row"
                  style={{ gap: 12, flexWrap: 'wrap' }}
                >
                  {(
                    [
                      {
                        k: 'proportional',
                        label: t('autoSplit.strategyProportional'),
                      },
                      { k: 'equal', label: t('autoSplit.strategyEqual') },
                      { k: 'greedy', label: t('autoSplit.strategyGreedy') },
                    ] as const
                  ).map((opt) => (
                    <label
                      key={opt.k}
                      className="row"
                      style={{ gap: 4, cursor: 'pointer' }}
                    >
                      <input
                        type="radio"
                        checked={strategy === opt.k}
                        onChange={() => setStrategy(opt.k)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Total hours */}
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="td-plabel">
              {t('autoSplit.hoursToSpread')}{' '}
              <span className="td-empty" style={{ fontWeight: 400 }}>
                {t('autoSplit.estimateAlreadyPlanned', { estimate: task.estimate ?? 0, planned: alreadyPlanned.toFixed(1) })}
              </span>
            </span>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="number"
                min={0}
                step={0.25}
                className="td-in td-in-h"
                value={totalHours}
                onChange={(e) => setTotalHours(e.target.value)}
                style={{ width: 80 }}
              />
              <span className="td-in-unit">h</span>
              {defaultRemaining > 0 &&
                parseFloat(totalHours) !== defaultRemaining && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setTotalHours(String(defaultRemaining))}
                  >
                    {t('autoSplit.resetToRemaining', { hours: defaultRemaining.toFixed(1) })}
                  </button>
                )}
            </div>
          </label>

          {/* Replace existing toggle + over-plan warning (mono uniquement) */}
          {!multiMode && (() => {
            const userExisting = existingAllocs.filter((a) => a.userId === userId);
            const userExistingHours = userExisting.reduce(
              (s, a) =>
                s +
                (a.effectiveHours ??
                  workdaysBetweenIso(a.startDate, a.endDate) * a.hoursPerDay),
              0,
            );
            const asked = parseFloat(totalHours) || 0;
            // Si replace : on déduit ce qu'on va supprimer pour ce user.
            const effectiveAfter = replaceExisting
              ? alreadyPlanned - userExistingHours + asked
              : alreadyPlanned + asked;
            const est = task.estimate ?? 0;
            const overplanned = est > 0 && effectiveAfter > est + 0.01;
            const nothingToDo = asked <= 0.01;
            return (
              <div style={{ display: 'grid', gap: 6 }}>
                {userExisting.length > 0 && (
                  <label
                    className="row"
                    style={{ gap: 8, fontSize: 12, alignItems: 'center' }}
                  >
                    <input
                      type="checkbox"
                      checked={replaceExisting}
                      onChange={(e) => setReplaceExisting(e.target.checked)}
                    />
                    <span>
                      {t('autoSplit.replaceExisting', {
                        count: userExisting.length,
                        name: userName(userId),
                        hours: userExistingHours.toFixed(1),
                      })}
                    </span>
                  </label>
                )}
                {nothingToDo && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'oklch(0.75 0.18 85 / 0.18)',
                      color: 'oklch(0.85 0.18 85)',
                      fontSize: 12,
                    }}
                  >
                    {t('autoSplit.nothingToPlan', { hours: asked })}
                  </div>
                )}
                {!nothingToDo && overplanned && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'oklch(0.65 0.18 25 / 0.18)',
                      color: 'oklch(0.78 0.18 25)',
                      fontSize: 12,
                    }}
                  >
                    {t('autoSplit.overplanned', {
                      after: effectiveAfter.toFixed(1),
                      estimate: est,
                      over: (effectiveAfter - est).toFixed(1),
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Pace — mono uniquement. En multi, chacun est rempli à sa
              propre capacité par jour (calcul côté serveur). */}
          {!multiMode && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span className="td-plabel">
              {t('autoSplit.pace')}{' '}
              {userSchedule && (
                <span className="td-empty" style={{ fontWeight: 400 }}>
                  {t('autoSplit.typicallyWorks', { name: userName(userId), hours: userDailyCap })}
                </span>
              )}
            </span>
            <div
              className="row"
              style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}
            >
              {(
                [
                  {
                    k: 'full',
                    label: t('autoSplit.fullDay', { hours: userDailyCap }),
                  },
                  { k: 'half', label: t('autoSplit.halfDay') },
                  { k: 'quarter', label: t('autoSplit.quarterDay') },
                  { k: 'custom', label: t('autoSplit.custom') },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.k}
                  className="row"
                  style={{ gap: 4, cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    checked={pace === opt.k}
                    onChange={() => setPace(opt.k)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
              {pace === 'custom' && (
                <div className="row" style={{ gap: 6 }}>
                  <input
                    type="number"
                    min={0.25}
                    max={24}
                    step={0.25}
                    className="td-in td-in-h"
                    value={customHpd}
                    onChange={(e) => setCustomHpd(e.target.value)}
                    style={{ width: 70 }}
                  />
                  <span className="td-in-unit">h/d</span>
                </div>
              )}
            </div>
            {/* Warnings cadence vs capacité réelle du user. Half/Quarter sont
                des valeurs fixes (4h/2h) qui peuvent dépasser la capacité d'un
                mi-temps ; Custom est libre. Si le user veut vraiment dépasser
                la capacité (overtime), il a un bouton inline pour l'activer
                directement, sans attendre un éventuel shortfall. */}
            {userSchedule &&
              (() => {
                const askedHpd = hoursPerDay;
                const over = askedHpd > userDailyCap + 0.001 && !allowOvertime;
                if (!over) return null;
                const label =
                  pace === 'half'
                    ? t('autoSplit.halfDayLabel')
                    : pace === 'quarter'
                      ? t('autoSplit.quarterDayLabel')
                      : t('autoSplit.perDay', { hours: askedHpd });
                return (
                  <div
                    className="td-over-note"
                    style={{
                      fontSize: 12,
                      marginTop: 4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <Icon name="warn" size={12} />
                    <span>
                      {t('autoSplit.exceedsCapacity', { label, name: userName(userId), cap: userDailyCap })}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setAllowOvertime(true)}
                      title={t('autoSplit.allowOvertimeTitle')}
                    >
                      {t('autoSplit.allowOvertime')}
                    </button>
                  </div>
                );
              })()}
          </div>
          )}

          {/* Start date */}
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="td-plabel">
              {t('autoSplit.startDate')}{' '}
              {taskStartIso && (
                <span className="td-empty" style={{ fontWeight: 400 }}>
                  {t('autoSplit.taskStarts', { date: taskStartIso })}
                </span>
              )}
            </span>
            <input
              type="date"
              className="td-in"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{ width: 'fit-content' }}
            />
            {startBeforeTaskStart && (
              <span
                className="td-over-note"
                style={{ fontSize: 12, marginTop: 4 }}
              >
                <Icon name="warn" size={12} /> {t('autoSplit.startBeforeTask', { date: taskStartIso })}
              </span>
            )}
          </label>

          {/* Must finish by */}
          {taskDueIso && (
            <label
              className="row"
              style={{ gap: 6, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={constrainByDue}
                onChange={(e) => setConstrainByDue(e.target.checked)}
              />
              <span>
                {t('autoSplit.mustFinishBy')}{' '}
                <span className="td-empty" style={{ fontSize: 12 }}>
                  ({taskDueIso})
                </span>
              </span>
            </label>
          )}

          {/* Live preview */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              padding: 12,
              background: 'var(--surface-2)',
            }}
          >
            <div
              className="td-plabel"
              style={{ marginBottom: 6, textTransform: 'uppercase' }}
            >
              {t('autoSplit.proposal')}
            </div>
            {multiMode ? (
              busy && !multiPreview ? (
                <div className="td-empty">{t('autoSplit.computing')}</div>
              ) : multiPreview ? (
                <>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>
                    {t('autoSplit.multiSummary', {
                      scheduled: multiPreview.effectiveHours.toFixed(1),
                      requested: multiPreview.requestedHours.toFixed(1),
                      people: multiPreview.peopleUsed,
                      end: multiPreview.endDate,
                    })}
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {multiPreview.perUser.map((p) => {
                      const used = p.effectiveHours > 0.01;
                      return (
                        <div
                          key={p.userId}
                          className="row"
                          style={{
                            gap: 8,
                            fontSize: 12,
                            opacity: used ? 1 : 0.5,
                            justifyContent: 'space-between',
                          }}
                        >
                          <span className="truncate">
                            <b>{userName(p.userId)}</b>
                            {used ? (
                              <span className="td-empty">
                                {' '}· {p.startDate} → {p.endDate} ·{' '}
                                {p.workdays} {p.workdays > 1 ? t('autoSplit.dayMany') : t('autoSplit.dayOne')}
                              </span>
                            ) : (
                              <span className="td-empty">{t('autoSplit.notMobilized')}</span>
                            )}
                          </span>
                          <span className="mono" style={{ flexShrink: 0 }}>
                            {p.effectiveHours.toFixed(1)}h
                            {p.shortfallHours > 0.01 && (
                              <span style={{ color: 'var(--c-over, #d33)' }}>
                                {' '}(−{p.shortfallHours.toFixed(1)}h)
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {multiPreview.shortfallHours > 0.01 && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: 8,
                        border: '1px solid var(--c-over, #d33)',
                        borderRadius: 'var(--r-sm)',
                        background: 'rgba(220, 50, 50, 0.06)',
                        fontSize: 12,
                      }}
                    >
                      <div
                        style={{
                          color: 'var(--c-over, #d33)',
                          fontWeight: 600,
                          marginBottom: 6,
                        }}
                      >
                        <Icon name="warn" size={12} />{' '}
                        {t('autoSplit.multiShortfall', {
                          hours: multiPreview.shortfallHours.toFixed(1),
                          deadline: multiPreview.hitDeadline ? t('autoSplit.deadlineSuffix') : '',
                          people: multiPreview.peopleUsed,
                        })}
                        {multiPreview.peopleShort > 0 &&
                          t('autoSplit.needMorePeople', { count: multiPreview.peopleShort })}
                      </div>
                      <div
                        className="row"
                        style={{ gap: 6, flexWrap: 'wrap' }}
                      >
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setAllowOvertime(true)}
                          disabled={allowOvertime}
                        >
                          {t('autoSplit.allowOvertime')}
                        </button>
                        {taskDueIso && constrainByDue && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setConstrainByDue(false)}
                          >
                            {t('autoSplit.liftDeadline')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="td-empty">
                  {t('autoSplit.pickPersonAndStart')}
                </div>
              )
            ) : busy && !preview ? (
              <div className="td-empty">{t('autoSplit.computing')}</div>
            ) : preview ? (
              <>
                <div style={{ fontSize: 13 }}>
                  {t('autoSplit.monoFromTo', { name: userName(userId), start: startDate, end: preview.endDate })}
                  <br />
                  {t('autoSplit.monoPerDay', {
                    hours: hoursPerDay,
                    days: preview.workdays,
                    scheduled: preview.effectiveHours.toFixed(1),
                    requested: preview.requestedHours.toFixed(1),
                  })}
                  {preview.blockedDays > 0 && (
                    <>
                      <br />
                      <span className="td-empty">
                        {t('autoSplit.monoSkipped', { count: preview.blockedDays })}
                      </span>
                    </>
                  )}
                </div>
                {preview.chunks && preview.chunks.length > 1 && (
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: 'var(--text-2)',
                    }}
                  >
                    {t('autoSplit.willCreateChunks', { count: preview.chunks.length })}
                    <ul
                      style={{
                        margin: '4px 0 0 18px',
                        padding: 0,
                        listStyle: 'disc',
                      }}
                    >
                      {preview.chunks.map((c, i) => (
                        <li key={i} className="mono">
                          {t('autoSplit.chunkLine', {
                            range: c.startDate !== c.endDate ? `${c.startDate} → ${c.endDate}` : c.startDate,
                            hours: c.hoursPerDay,
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {endAfterTaskDue && (
                  <div
                    className="td-over-note"
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <Icon name="warn" size={12} />
                    <span>
                      {t('autoSplit.endPastDue', { end: preview.endDate, due: taskDueIso })}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        onTaskPatch({
                          due: isoToDueOffset(preview.endDate, monday),
                        })
                      }
                    >
                      {t('autoSplit.moveTaskDueTo', { date: preview.endDate })}
                    </button>
                  </div>
                )}

                {preview.shortfallHours > 0.01 && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: 8,
                      border: '1px solid var(--c-over, #d33)',
                      borderRadius: 'var(--r-sm)',
                      background: 'rgba(220, 50, 50, 0.06)',
                      fontSize: 12,
                    }}
                  >
                    <div
                      style={{
                        color: 'var(--c-over, #d33)',
                        fontWeight: 600,
                        marginBottom: 6,
                      }}
                    >
                      <Icon name="warn" size={12} /> {t('autoSplit.cannotFit', { hours: preview.shortfallHours.toFixed(1) })}
                    </div>
                    <div
                      style={{
                        marginBottom: 6,
                        color: 'var(--text-2)',
                      }}
                    >
                      {t('autoSplit.pickResolution')}
                    </div>
                    <div
                      className="row"
                      style={{ gap: 6, flexWrap: 'wrap' }}
                    >
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setAllowOvertime(true)}
                        disabled={allowOvertime}
                        title={t('autoSplit.allowOvertimeTitleMono')}
                      >
                        {t('autoSplit.allowOvertime')}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={extendDueDate}
                      >
                        {t('autoSplit.extendDueTo', { date: preview.endDate })}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={onClose}
                        title={t('autoSplit.addAnotherTitle')}
                      >
                        {t('autoSplit.addAnotherAssignee')}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="td-empty">
                {t('autoSplit.fillAssigneeStart')}
              </div>
            )}
          </div>

          {allowOvertime && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-2)',
                padding: '6px 8px',
                background: 'var(--surface-2)',
                borderRadius: 'var(--r-sm)',
              }}
            >
              <Icon name="warn" size={12} /> {t('autoSplit.overtimeMode')}{' '}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setAllowOvertime(false)}
              >
                {t('autoSplit.turnOff')}
              </button>
            </div>
          )}

          {error && (
            <div className="td-over-note" style={{ fontSize: 12 }}>
              <Icon name="warn" size={12} /> {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: 12,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 6,
          }}
        >
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={busy}
          >
            {t('common:cancel')}
          </button>
          {multiMode ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={createMultiIt}
              disabled={
                busy ||
                !multiPreview ||
                multiPreview.effectiveHours <= 0.01 ||
                multiUserIds.length === 0 ||
                (parseFloat(totalHours) || 0) <= 0.01
              }
              title={
                multiPreview && multiPreview.shortfallHours > 0.01
                  ? t('autoSplit.createAllocationsTitle')
                  : undefined
              }
            >
              {busy ? t('common:saving') : t('autoSplit.createAllocations')}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={createIt}
              disabled={
                busy ||
                !preview ||
                preview.shortfallHours > 0.01 ||
                !userId ||
                (parseFloat(totalHours) || 0) <= 0.01
              }
            >
              {busy
                ? t('common:saving')
                : replaceExisting
                  ? t('autoSplit.replaceAllocations')
                  : t('autoSplit.createAllocation')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
