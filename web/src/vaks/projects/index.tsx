/* ============================================================
   Vaks — Projects panel
   Grid of every project the current user can see + "Manage" modal.
   Visibility is controlled by the API:
   - global admin or `project:view_all` → every project in the org
   - PROJECT_MANAGER → only their assigned projects
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, Avatar } from '../primitives';
import { api } from '../../api/client';
import { ProjectStatus, type ProjectDto } from '@vaks-pm/shared';
import { useAuth } from '../../auth/AuthContext';
import { useOrgProjectEvents } from '../../api/realtime';
import {
  ALL_STATUSES,
  STATUS_META,
  StatusPill,
  VirtualList,
  avatarUser,
  colorFromKey,
  daysLeft,
  shortDate,
  statusLabel,
} from './shared';
import { ManageModal } from './ManageModal';
import { CreateDraftModal, CopyPickerModal } from './CreateDraftModal';
import { useIsMobile } from '../useIsMobile';

/* ============================ Project card ============================ */

interface ProjectCardProps {
  p: ProjectDto;
  onManage: (p: ProjectDto) => void;
  /** Ouvre le projet (bascule le projet courant + va au board). */
  onOpen?: (p: ProjectDto) => void;
}

function ProjectCard({ p, onManage, onOpen }: ProjectCardProps) {
  const { t } = useTranslation('projects');
  const left = daysLeft(p.dueDate);
  // The due-date countdown / "overdue" badge only makes sense while a project
  // is still running. A COMPLETED or ARCHIVED project is finished, so an
  // "X days over" badge (computed from due date vs today) is meaningless and
  // can read as a huge number on old projects — hide it for terminal statuses.
  const showCountdown =
    p.status !== ProjectStatus.COMPLETED && p.status !== ProjectStatus.ARCHIVED;
  const hue = colorFromKey(p.key);
  const clickable = !!onOpen;
  const counts = p.taskCounts;
  const pct =
    counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : null;
  const managers = p.managers ?? [];
  return (
    <div
      className={'pj-card' + (clickable ? ' pj-card-clickable' : '')}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen!(p) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen!(p);
              }
            }
          : undefined
      }
    >
      <div className="pj-card-top">
        <div className="pj-key mono" style={{ background: `oklch(0.55 0.15 ${hue})` }}>
          {p.key}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="pj-name truncate">{p.name}</div>
          <div className="pj-sub truncate">
            {p.status === ProjectStatus.ACTIVE && <span className="pj-active-dot" />}
            <Icon
              name="user"
              size={11}
              style={{ color: 'var(--text-3)', marginRight: 2, verticalAlign: '-1px' }}
            />
            {p.client ? p.client.name : t('card.internal')}
            {counts ? t('card.tasksSuffix', { done: counts.done, total: counts.total }) : ''}
          </div>
          <span
            className="pj-billable-badge"
            title={p.billable ? t('card.billableTitle') : t('card.nonBillableTitle')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              marginTop: 3,
              padding: '1px 7px',
              borderRadius: 999,
              fontSize: 10.5,
              fontWeight: 600,
              lineHeight: 1.5,
              color: p.billable ? 'oklch(0.45 0.13 155)' : 'var(--text-3)',
              background: p.billable ? 'oklch(0.95 0.05 155)' : 'var(--surface-2)',
              border: '1px solid ' + (p.billable ? 'oklch(0.85 0.08 155)' : 'var(--border)'),
            }}
          >
            {p.billable ? t('card.billable') : t('card.nonBillable')}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <StatusPill status={p.status} />
          {(p.offerRefusalCount ?? 0) > 0 && (
            <span
              className="pj-status"
              title={t('card.offerRefusedTitle', { count: p.offerRefusalCount })}
              style={{ color: 'oklch(0.5 0.13 25)', background: 'oklch(0.95 0.05 25)' }}
            >
              <Icon name="warn" size={11} /> {t('card.refused', { count: p.offerRefusalCount })}
            </span>
          )}
        </div>
      </div>

      {p.description && <p className="pj-desc">{p.description}</p>}

      {/* Barre d'avancement (tâches DONE / total) */}
      {counts && counts.total > 0 && (
        <div
          title={t('card.tasksDonePct', { done: counts.done, total: counts.total, pct })}
          style={{
            height: 4,
            borderRadius: 999,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            overflow: 'hidden',
            margin: '8px 0 2px',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 999,
              background: pct === 100 ? 'oklch(0.62 0.16 155)' : 'var(--accent)',
              transition: 'width .25s ease',
            }}
          />
        </div>
      )}

      <div className="pj-card-foot">
        <div className="pj-dates">
          <Icon name="cal" size={14} style={{ color: 'var(--text-3)' }} />
          <span>
            {shortDate(p.startDate)} – {shortDate(p.dueDate)}
          </span>
          {left !== null && showCountdown && (
            <span className={'pj-left' + (left < 0 ? ' over' : left <= 14 ? ' soon' : '')}>
              {left < 0
                ? t('card.daysOver', { count: -left })
                : left === 0
                  ? t('card.dueToday')
                  : t('card.daysLeft', { count: left })}
            </span>
          )}
        </div>
        {managers.length > 0 && (
          <div
            className="row"
            style={{ marginLeft: 'auto', gap: 0, alignItems: 'center' }}
            title={t('card.pmTitle', { names: managers.map((m) => m.name).join(', ') })}
          >
            {managers.slice(0, 3).map((m, i) => (
              <span key={m.id} style={{ marginLeft: i === 0 ? 0 : -6, display: 'inline-flex' }}>
                <Avatar user={avatarUser(m)} size={20} title={false} />
              </span>
            ))}
            {managers.length > 3 && (
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', marginLeft: 3 }}>
                +{managers.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      <button
        className="pj-manage"
        onClick={(e) => {
          e.stopPropagation();
          onManage(p);
        }}
      >
        <Icon name="settings" size={15} /> {t('card.manage')}
      </button>
    </div>
  );
}

/**
 * One collapsible row inside the narrow-screen consolidated filters panel.
 * Closed by default (per-section, tracked by the caller) so a user scanning
 * for one filter doesn't have to page past four fully-expanded others; the
 * collapsed header still shows the current value so the state is visible
 * without opening it.
 */
function FilterAccordionSection({
  title,
  valueLabel,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  valueLabel?: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pj-filter-section">
      <button type="button" className="pj-filter-section-head" onClick={onToggle}>
        <span className="pj-filter-section-title">{title}</span>
        <span className="row" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
          {valueLabel && <span className="pj-filter-section-value truncate">{valueLabel}</span>}
          <span
            style={{
              opacity: 0.6,
              display: 'inline-block',
              transform: isOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform .15s ease',
            }}
          >
            ▾
          </span>
        </span>
      </button>
      {isOpen && <div className="pj-filter-section-body">{children}</div>}
    </div>
  );
}

/* ============================ Panel root ============================ */

export interface ProjectsPanelProps {
  pushToast: (text: string, warn?: boolean) => void;
  /** Ouvre un projet : bascule le projet courant et affiche son board. */
  onOpenProject?: (projectId: string) => void;
  /** Requête de la searchbox globale (topbar) — filtre la grille. */
  search?: string;
}

/** Statuts cochés par défaut dans le filtre — tout sauf ARCHIVED. */
const DEFAULT_VISIBLE_STATUSES: ProjectStatus[] = [
  ProjectStatus.DRAFT,
  ProjectStatus.CHARTER_REVIEW,
  ProjectStatus.ACTIVE,
  ProjectStatus.COMPLETED,
];
const STATUS_FILTER_STORAGE_KEY = 'vaks.projects.statusFilter';
/** Default scope: only the connected user's projects ('mine') vs the whole org ('all'). */
const SCOPE_STORAGE_KEY = 'vaks.projects.scope';
/** Projects shown per page in the grid. */
const PAGE_SIZE = 24;

/** Billable filter modes. */
type BillableFilter = 'ALL' | 'BILLABLE' | 'NON_BILLABLE';
/** Fiscal timeframe granularity. */
type TimeframeGran = 'quarter' | 'year';

/**
 * Computes the [start, end] bounds (local midnight → end-of-day) of a fiscal
 * period, given the org's fiscal-year start month (1–12), a granularity and an
 * offset from the current period (0 = current, -1 = previous, +1 = next).
 */
function fiscalPeriod(
  startMonth: number,
  gran: TimeframeGran,
  offset: number,
  now: Date,
): { start: Date; end: Date; quarter: number; fyStartYear: number } {
  const m0 = Math.min(11, Math.max(0, startMonth - 1)); // 0-based fiscal start month
  const mo = now.getMonth();
  const monthsSinceFyStart = (mo - m0 + 12) % 12;
  const fyStartYear = mo >= m0 ? now.getFullYear() : now.getFullYear() - 1;

  if (gran === 'year') {
    const sy = fyStartYear + offset;
    const start = new Date(sy, m0, 1, 0, 0, 0, 0);
    const end = new Date(sy + 1, m0, 0, 23, 59, 59, 999); // day 0 = last day of prev month
    return { start, end, quarter: 0, fyStartYear: sy };
  }
  // quarter: 3-month buckets aligned to the fiscal year start.
  const qIndexNow = Math.floor(monthsSinceFyStart / 3); // 0..3
  const base = new Date(fyStartYear, m0, 1, 0, 0, 0, 0);
  const start = new Date(base.getFullYear(), base.getMonth() + (qIndexNow + offset) * 3, 1, 0, 0, 0, 0);
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 0, 23, 59, 59, 999);
  // Fiscal year + quarter number that `start` belongs to.
  const startMo = start.getMonth();
  const qFyStartYear = startMo >= m0 ? start.getFullYear() : start.getFullYear() - 1;
  const quarter = Math.floor(((startMo - m0 + 12) % 12) / 3) + 1;
  return { start, end, quarter, fyStartYear: qFyStartYear };
}

/** Human label for a fiscal period (calendar-aligned years show a single year). */
function fiscalLabel(
  startMonth: number,
  gran: TimeframeGran,
  p: { quarter: number; fyStartYear: number },
): string {
  const fyTag = startMonth === 1 ? String(p.fyStartYear) : `FY${(p.fyStartYear + 1) % 100}`;
  return gran === 'year'
    ? startMonth === 1
      ? String(p.fyStartYear)
      : `FY ${p.fyStartYear}–${String((p.fyStartYear + 1) % 100).padStart(2, '0')}`
    : `Q${p.quarter} ${fyTag}`;
}

/**
 * A project is "active during" [start, end] if its own [startDate, dueDate]
 * range overlaps the period. Missing bounds are treated as open-ended so a
 * date-less project is never hidden by the timeframe filter.
 */
function activeDuring(p: ProjectDto, start: Date, end: Date): boolean {
  const ps = p.startDate ? new Date(p.startDate).getTime() : -Infinity;
  const pe = p.dueDate ? new Date(p.dueDate).getTime() : Infinity;
  return ps <= end.getTime() && pe >= start.getTime();
}

function loadStatusFilter(): Set<ProjectStatus> {
  try {
    const raw = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE_STATUSES);
    const arr = JSON.parse(raw) as string[];
    return new Set(arr.filter((s) => s in STATUS_META) as ProjectStatus[]);
  } catch {
    return new Set(DEFAULT_VISIBLE_STATUSES);
  }
}

export function ProjectsPanel({ pushToast, onOpenProject, search = '' }: ProjectsPanelProps) {
  const { t } = useTranslation('projects');
  const { can, orgSettings } = useAuth();
  const canCreate = can('project:create');
  const fyStartMonth = orgSettings.fiscalYearStartMonth || 1;
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [manageId, setManageId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copySource, setCopySource] = useState<ProjectDto | null>(null);
  const [pickingCopySource, setPickingCopySource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleStatuses, setVisibleStatuses] = useState<Set<ProjectStatus>>(() => loadStatusFilter());
  const [filterOpen, setFilterOpen] = useState(false);
  // Below this width the 5 individual filter dropdown buttons no longer fit
  // the toolbar on one line and become unreadable — collapse them into a
  // single "Filters" button opening one consolidated panel instead.
  const isNarrowToolbar = useIsMobile('(max-width: 1080px)');
  const [filtersMenuOpen, setFiltersMenuOpen] = useState(false);
  // Which sections of the consolidated mobile filters panel are expanded —
  // all closed by default each time the panel is (re)opened.
  const [openFilterSections, setOpenFilterSections] = useState<Set<string>>(() => new Set());
  function toggleFilterSection(key: string) {
    setOpenFilterSections((curr) => {
      const next = new Set(curr);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  // Client filter: 'ALL' | 'INTERNAL' (no client) | a clientId.
  const [clientFilter, setClientFilter] = useState<string>('ALL');
  const [clientMenuOpen, setClientMenuOpen] = useState(false);
  const [clientQuery, setClientQuery] = useState('');
  // Project-manager filter: 'ALL' | 'NONE' (no manager) | a manager userId.
  const [managerFilter, setManagerFilter] = useState<string>('ALL');
  const [managerMenuOpen, setManagerMenuOpen] = useState(false);
  const [managerQuery, setManagerQuery] = useState('');
  // Billable filter.
  const [billableFilter, setBillableFilter] = useState<BillableFilter>('ALL');
  const [billableMenuOpen, setBillableMenuOpen] = useState(false);
  // Fiscal timeframe filter (off by default).
  const [tfActive, setTfActive] = useState(false);
  const [tfGran, setTfGran] = useState<TimeframeGran>('quarter');
  const [tfOffset, setTfOffset] = useState(0);
  const [tfMenuOpen, setTfMenuOpen] = useState(false);
  // Pagination over the filtered grid (the API returns the full list).
  const [page, setPage] = useState(1);
  // Scope: by default show only the connected user's projects. Users who can
  // see the whole org (admins / project:view_all) get an "All projects" toggle.
  const canViewAll = can('project:view_all');
  const [scope, setScope] = useState<'mine' | 'all'>(() => {
    try {
      return localStorage.getItem(SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'mine';
    } catch {
      return 'mine';
    }
  });

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const list = await api.listProjects(canViewAll ? scope : 'mine');
      setProjects(list);
      setError(null);
    } catch (e) {
      if (!opts?.silent) setError((e as Error).message);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [canViewAll, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Temps réel : un autre user crée/modifie/supprime un projet → la room org
  // pousse `project.*` (payload {id} seul) et on refetch silencieusement la
  // liste (la visibilité est ré-appliquée côté serveur). Débouncé pour
  // absorber les rafales.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOrgProjectEvents(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh({ silent: true }), 400);
  });
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  // Persist filter selection across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(
        STATUS_FILTER_STORAGE_KEY,
        JSON.stringify(Array.from(visibleStatuses)),
      );
    } catch {
      // ignore quota / private-mode errors
    }
  }, [visibleStatuses]);
  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, scope);
    } catch {
      // ignore quota / private-mode errors
    }
  }, [scope]);

  const managed = projects.find((p) => p.id === manageId) ?? null;

  // Distinct clients present in the visible project set (for the client filter).
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    let hasInternal = false;
    for (const p of projects) {
      if (p.client) m.set(p.client.id, p.client.name);
      else hasInternal = true;
    }
    return {
      list: [...m.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      hasInternal,
    };
  }, [projects]);

  // Distinct project managers across the visible set (for the manager filter).
  const managerOptions = useMemo(() => {
    const m = new Map<string, string>();
    let hasNone = false;
    for (const p of projects) {
      const mgrs = p.managers ?? [];
      if (mgrs.length === 0) hasNone = true;
      for (const mg of mgrs) m.set(mg.id, mg.name);
    }
    return {
      list: [...m.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      hasNone,
    };
  }, [projects]);

  // Resolve the active fiscal period once (re-used by the predicate + label).
  const tfPeriod = useMemo(
    () => fiscalPeriod(fyStartMonth, tfGran, tfOffset, new Date()),
    [fyStartMonth, tfGran, tfOffset],
  );

  const query = search.trim().toLowerCase();
  const filteredProjects = useMemo(
    () =>
      projects.filter((p) => {
        if (!visibleStatuses.has(p.status)) return false;
        if (clientFilter === 'INTERNAL') {
          if (p.client) return false;
        } else if (clientFilter !== 'ALL') {
          if (p.client?.id !== clientFilter) return false;
        }
        if (managerFilter === 'NONE') {
          if ((p.managers ?? []).length > 0) return false;
        } else if (managerFilter !== 'ALL') {
          if (!(p.managers ?? []).some((m) => m.id === managerFilter)) return false;
        }
        if (billableFilter === 'BILLABLE' && !p.billable) return false;
        if (billableFilter === 'NON_BILLABLE' && p.billable) return false;
        if (tfActive && !activeDuring(p, tfPeriod.start, tfPeriod.end)) return false;
        if (!query) return true;
        return (
          p.name.toLowerCase().includes(query) ||
          p.key.toLowerCase().includes(query) ||
          (p.description ?? '').toLowerCase().includes(query) ||
          (p.client?.name ?? '').toLowerCase().includes(query)
        );
      }),
    [projects, visibleStatuses, clientFilter, managerFilter, billableFilter, tfActive, tfPeriod, query],
  );
  const hiddenCount = projects.length - filteredProjects.length;

  // Pagination: clamp the page to the available range and slice the grid.
  const totalPages = Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedProjects = useMemo(
    () => filteredProjects.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredProjects, safePage],
  );
  // Reset to the first page whenever the filters / search change the result set.
  useEffect(() => {
    setPage(1);
  }, [query, visibleStatuses, clientFilter, managerFilter, billableFilter, tfActive, tfPeriod]);

  const selectedClientLabel =
    clientFilter === 'ALL'
      ? t('panel.allClients')
      : clientFilter === 'INTERNAL'
        ? t('panel.internalOnly')
        : (clientOptions.list.find((c) => c.id === clientFilter)?.name ?? t('panel.allClients'));

  const selectedManagerLabel =
    managerFilter === 'ALL'
      ? t('panel.allManagers')
      : managerFilter === 'NONE'
        ? t('panel.noManager')
        : (managerOptions.list.find((m) => m.id === managerFilter)?.name ?? t('panel.allManagers'));

  const selectedBillableLabel =
    billableFilter === 'BILLABLE'
      ? t('panel.billableOnly')
      : billableFilter === 'NON_BILLABLE'
        ? t('panel.nonBillableOnly')
        : t('panel.billableAll');

  const tfLabel = tfActive
    ? fiscalLabel(fyStartMonth, tfGran, tfPeriod)
    : t('panel.anyTimeframe');

  const isDefaultStatusFilter =
    visibleStatuses.size === DEFAULT_VISIBLE_STATUSES.length &&
    DEFAULT_VISIBLE_STATUSES.every((s) => visibleStatuses.has(s));
  // Count of filter dimensions that differ from their default — shown as a
  // badge on the consolidated "Filters" button on narrow screens.
  const activeFilterCount =
    (clientFilter !== 'ALL' ? 1 : 0) +
    (managerFilter !== 'ALL' ? 1 : 0) +
    (billableFilter !== 'ALL' ? 1 : 0) +
    (tfActive ? 1 : 0) +
    (isDefaultStatusFilter ? 0 : 1);

  function resetAllFilters() {
    setClientFilter('ALL');
    setManagerFilter('ALL');
    setBillableFilter('ALL');
    setTfActive(false);
    setVisibleStatuses(new Set(DEFAULT_VISIBLE_STATUSES));
  }

  function toggleStatus(s: ProjectStatus) {
    setVisibleStatuses((curr) => {
      const next = new Set(curr);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const header = (
    <div
      className="row pj-toolbar"
      style={{ justifyContent: 'flex-end', gap: 8, marginBottom: 12, position: 'relative' }}
    >
      {canViewAll && (
        <div className="seg" role="group" aria-label={t('panel.scopeAria')} style={{ marginRight: 'auto' }}>
          <button
            className={'seg-btn' + (scope === 'mine' ? ' seg-on' : '')}
            onClick={() => setScope('mine')}
          >
            {t('panel.myProjects')}
          </button>
          <button
            className={'seg-btn' + (scope === 'all' ? ' seg-on' : '')}
            onClick={() => setScope('all')}
          >
            {t('panel.allProjects')}
          </button>
        </div>
      )}
      {!isNarrowToolbar && (clientOptions.list.length > 0 || clientOptions.hasInternal) && (
        <div style={{ position: 'relative' }}>
          <button
            className="btn btn-ghost"
            onClick={() => setClientMenuOpen((o) => !o)}
            title={t('panel.filterByClient')}
            style={{ maxWidth: 220 }}
          >
            <Icon name="user" size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            <span className="truncate" style={{ maxWidth: 150, display: 'inline-block', verticalAlign: 'bottom' }}>
              {selectedClientLabel}
            </span>{' '}
            <span style={{ opacity: 0.6 }}>▾</span>
          </button>
          {clientMenuOpen && (
            <>
              <div
                onClick={() => setClientMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 100 }}
              />
              <div
                className="dd-menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 4px)',
                  width: 260,
                  padding: 6,
                  zIndex: 101,
                  maxHeight: 360,
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  className="input"
                  autoFocus
                  placeholder={t('panel.searchClient')}
                  value={clientQuery}
                  onChange={(e) => setClientQuery(e.target.value)}
                  style={{ marginBottom: 6 }}
                />
                <div style={{ overflowY: 'auto' }}>
                  <button
                    className="dd-item"
                    style={{ width: '100%', textAlign: 'left', fontWeight: clientFilter === 'ALL' ? 700 : 400 }}
                    onClick={() => {
                      setClientFilter('ALL');
                      setClientMenuOpen(false);
                    }}
                  >
                    {t('panel.allClients')}
                  </button>
                  {clientOptions.hasInternal && (
                    <button
                      className="dd-item"
                      style={{ width: '100%', textAlign: 'left', fontWeight: clientFilter === 'INTERNAL' ? 700 : 400 }}
                      onClick={() => {
                        setClientFilter('INTERNAL');
                        setClientMenuOpen(false);
                      }}
                    >
                      {t('panel.internalOnly')}
                    </button>
                  )}
                  <VirtualList
                    key={clientQuery}
                    items={clientOptions.list.filter((c) =>
                      c.name.toLowerCase().includes(clientQuery.trim().toLowerCase()),
                    )}
                    itemHeight={34}
                    visibleCount={5}
                    keyFn={(c) => c.id}
                    renderItem={(c) => (
                      <button
                        className="dd-item truncate"
                        style={{ width: '100%', textAlign: 'left', fontWeight: clientFilter === c.id ? 700 : 400 }}
                        onClick={() => {
                          setClientFilter(c.id);
                          setClientMenuOpen(false);
                        }}
                      >
                        {c.name}
                      </button>
                    )}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Project manager filter ---- */}
      {!isNarrowToolbar && (managerOptions.list.length > 0 || managerOptions.hasNone) && (
        <div style={{ position: 'relative' }}>
          <button
            className="btn btn-ghost"
            onClick={() => setManagerMenuOpen((o) => !o)}
            title={t('panel.filterByManager')}
            style={{ maxWidth: 220 }}
          >
            <Icon name="users" size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            <span className="truncate" style={{ maxWidth: 150, display: 'inline-block', verticalAlign: 'bottom' }}>
              {selectedManagerLabel}
            </span>{' '}
            <span style={{ opacity: 0.6 }}>▾</span>
          </button>
          {managerMenuOpen && (
            <>
              <div
                onClick={() => setManagerMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 100 }}
              />
              <div
                className="dd-menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 4px)',
                  width: 260,
                  padding: 6,
                  zIndex: 101,
                  maxHeight: 360,
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  className="input"
                  autoFocus
                  placeholder={t('panel.searchManager')}
                  value={managerQuery}
                  onChange={(e) => setManagerQuery(e.target.value)}
                  style={{ marginBottom: 6 }}
                />
                <div style={{ overflowY: 'auto' }}>
                  <button
                    className="dd-item"
                    style={{ width: '100%', textAlign: 'left', fontWeight: managerFilter === 'ALL' ? 700 : 400 }}
                    onClick={() => {
                      setManagerFilter('ALL');
                      setManagerMenuOpen(false);
                    }}
                  >
                    {t('panel.allManagers')}
                  </button>
                  {managerOptions.hasNone && (
                    <button
                      className="dd-item"
                      style={{ width: '100%', textAlign: 'left', fontWeight: managerFilter === 'NONE' ? 700 : 400 }}
                      onClick={() => {
                        setManagerFilter('NONE');
                        setManagerMenuOpen(false);
                      }}
                    >
                      {t('panel.noManager')}
                    </button>
                  )}
                  <VirtualList
                    key={managerQuery}
                    items={managerOptions.list.filter((m) =>
                      m.name.toLowerCase().includes(managerQuery.trim().toLowerCase()),
                    )}
                    itemHeight={34}
                    visibleCount={5}
                    keyFn={(m) => m.id}
                    renderItem={(m) => (
                      <button
                        className="dd-item truncate"
                        style={{ width: '100%', textAlign: 'left', fontWeight: managerFilter === m.id ? 700 : 400 }}
                        onClick={() => {
                          setManagerFilter(m.id);
                          setManagerMenuOpen(false);
                        }}
                      >
                        {m.name}
                      </button>
                    )}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Billable filter ---- */}
      {!isNarrowToolbar && (
      <div style={{ position: 'relative' }}>
        <button
          className="btn btn-ghost"
          onClick={() => setBillableMenuOpen((o) => !o)}
          title={t('panel.filterByBillable')}
          style={{ maxWidth: 200 }}
        >
          <Icon name="zap" size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          <span className="truncate" style={{ maxWidth: 140, display: 'inline-block', verticalAlign: 'bottom' }}>
            {selectedBillableLabel}
          </span>{' '}
          <span style={{ opacity: 0.6 }}>▾</span>
        </button>
        {billableMenuOpen && (
          <>
            <div
              onClick={() => setBillableMenuOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 100 }}
            />
            <div
              className="dd-menu"
              style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', width: 200, padding: 6, zIndex: 101 }}
              onClick={(e) => e.stopPropagation()}
            >
              {([
                ['ALL', t('panel.billableAll')],
                ['BILLABLE', t('panel.billableOnly')],
                ['NON_BILLABLE', t('panel.nonBillableOnly')],
              ] as [BillableFilter, string][]).map(([val, label]) => (
                <button
                  key={val}
                  className="dd-item"
                  style={{ width: '100%', textAlign: 'left', fontWeight: billableFilter === val ? 700 : 400 }}
                  onClick={() => {
                    setBillableFilter(val);
                    setBillableMenuOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      )}

      {/* ---- Fiscal timeframe filter ---- */}
      {!isNarrowToolbar && (
      <div style={{ position: 'relative' }}>
        <button
          className="btn btn-ghost"
          onClick={() => setTfMenuOpen((o) => !o)}
          title={t('panel.filterByTimeframe')}
          style={{ maxWidth: 220 }}
        >
          <Icon name="cal" size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          <span className="truncate" style={{ maxWidth: 150, display: 'inline-block', verticalAlign: 'bottom' }}>
            {tfLabel}
          </span>{' '}
          <span style={{ opacity: 0.6 }}>▾</span>
        </button>
        {tfMenuOpen && (
          <>
            <div
              onClick={() => setTfMenuOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 100 }}
            />
            <div
              className="dd-menu"
              style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', width: 250, padding: 10, zIndex: 101 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Any timeframe (off) */}
              <button
                className="dd-item"
                style={{ width: '100%', textAlign: 'left', fontWeight: !tfActive ? 700 : 400 }}
                onClick={() => {
                  setTfActive(false);
                  setTfMenuOpen(false);
                }}
              >
                {t('panel.anyTimeframe')}
              </button>

              <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />

              {/* Granularity */}
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                {(['quarter', 'year'] as TimeframeGran[]).map((g) => (
                  <button
                    key={g}
                    className={'btn btn-sm ' + (tfActive && tfGran === g ? 'btn-accent' : 'btn-ghost')}
                    style={{ flex: 1 }}
                    onClick={() => {
                      setTfGran(g);
                      setTfOffset(0);
                      setTfActive(true);
                    }}
                  >
                    {g === 'quarter' ? t('panel.timeframeQuarter') : t('panel.timeframeYear')}
                  </button>
                ))}
              </div>

              {/* Period navigation */}
              <div className="row" style={{ gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  title={t('panel.prevPeriod')}
                  onClick={() => {
                    setTfActive(true);
                    setTfOffset((o) => o - 1);
                  }}
                >
                  ‹
                </button>
                <span
                  style={{ fontSize: 13, fontWeight: 700, minWidth: 90, textAlign: 'center' }}
                >
                  {fiscalLabel(fyStartMonth, tfGran, tfPeriod)}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  title={t('panel.nextPeriod')}
                  onClick={() => {
                    setTfActive(true);
                    setTfOffset((o) => o + 1);
                  }}
                >
                  ›
                </button>
              </div>
              {tfActive && tfOffset !== 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={() => setTfOffset(0)}
                >
                  {t('panel.thisPeriod')}
                </button>
              )}
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
                {t('panel.timeframeNote')}
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {!isNarrowToolbar && (
      <div style={{ position: 'relative' }}>
        <button
          className="btn btn-ghost"
          onClick={() => setFilterOpen((o) => !o)}
          title={t('panel.filterByStatus')}
        >
          {t('panel.status', { selected: visibleStatuses.size, total: ALL_STATUSES.length })}{' '}
          <span style={{ opacity: 0.6 }}>▾</span>
        </button>
        {filterOpen && (
          <>
            {/* click-outside catcher */}
            <div
              onClick={() => setFilterOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 100 }}
            />
            <div
              className="dd-menu"
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 4px)',
                width: 220,
                padding: 6,
                zIndex: 101,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {ALL_STATUSES.map((s) => {
                const checked = visibleStatuses.has(s);
                const meta = STATUS_META[s];
                return (
                  <label key={s} className="dd-item" style={{ cursor: 'pointer', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleStatus(s)}
                      style={{ accentColor: `oklch(0.55 0.15 ${meta.hue})` }}
                    />
                    <span
                      className="pj-status-dot"
                      style={{ background: `oklch(0.62 0.16 ${meta.hue})` }}
                    />
                    <span className="grow">{statusLabel(t, s)}</span>
                  </label>
                );
              })}
              <div
                style={{
                  borderTop: '1px solid var(--border)',
                  marginTop: 4,
                  paddingTop: 4,
                  display: 'flex',
                  gap: 6,
                  fontSize: 11,
                }}
              >
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setVisibleStatuses(new Set(DEFAULT_VISIBLE_STATUSES))}
                >
                  {t('panel.resetHideArchived')}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setVisibleStatuses(new Set(ALL_STATUSES))}
                >
                  {t('panel.showAll')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}

      {/* ---- Narrow screens: all 5 filters collapsed into one panel ---- */}
      {isNarrowToolbar && (
        <div style={{ position: 'relative' }}>
          <button
            className="btn btn-ghost"
            onClick={() =>
              setFiltersMenuOpen((o) => {
                if (!o) setOpenFilterSections(new Set());
                return !o;
              })
            }
            title={t('panel.filters')}
          >
            <Icon name="filter" size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            {activeFilterCount > 0
              ? t('panel.filtersActive', { count: activeFilterCount })
              : t('panel.filters')}{' '}
            <span style={{ opacity: 0.6 }}>▾</span>
          </button>
          {filtersMenuOpen && (
            <>
              <div
                onClick={() => setFiltersMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 100 }}
              />
              <div
                className="dd-menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 'calc(100% + 4px)',
                  width: 300,
                  maxWidth: 'calc(100vw - 24px)',
                  maxHeight: '75vh',
                  overflowY: 'auto',
                  padding: 10,
                  zIndex: 101,
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {(clientOptions.list.length > 0 || clientOptions.hasInternal) && (
                  <FilterAccordionSection
                    title={t('panel.sectionClient')}
                    valueLabel={selectedClientLabel}
                    isOpen={openFilterSections.has('client')}
                    onToggle={() => toggleFilterSection('client')}
                  >
                    <input
                      className="input"
                      placeholder={t('panel.searchClient')}
                      value={clientQuery}
                      onChange={(e) => setClientQuery(e.target.value)}
                      style={{ marginBottom: 6, width: '100%' }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <button
                        className="dd-item"
                        style={{ width: '100%', textAlign: 'left', fontWeight: clientFilter === 'ALL' ? 700 : 400 }}
                        onClick={() => setClientFilter('ALL')}
                      >
                        {t('panel.allClients')}
                      </button>
                      {clientOptions.hasInternal && (
                        <button
                          className="dd-item"
                          style={{ width: '100%', textAlign: 'left', fontWeight: clientFilter === 'INTERNAL' ? 700 : 400 }}
                          onClick={() => setClientFilter('INTERNAL')}
                        >
                          {t('panel.internalOnly')}
                        </button>
                      )}
                      <VirtualList
                        key={clientQuery}
                        items={clientOptions.list.filter((c) =>
                          c.name.toLowerCase().includes(clientQuery.trim().toLowerCase()),
                        )}
                        itemHeight={34}
                        visibleCount={5}
                        keyFn={(c) => c.id}
                        renderItem={(c) => (
                          <button
                            className="dd-item truncate"
                            style={{ width: '100%', textAlign: 'left', fontWeight: clientFilter === c.id ? 700 : 400 }}
                            onClick={() => setClientFilter(c.id)}
                          >
                            {c.name}
                          </button>
                        )}
                      />
                    </div>
                  </FilterAccordionSection>
                )}

                {(managerOptions.list.length > 0 || managerOptions.hasNone) && (
                  <FilterAccordionSection
                    title={t('panel.sectionManager')}
                    valueLabel={selectedManagerLabel}
                    isOpen={openFilterSections.has('manager')}
                    onToggle={() => toggleFilterSection('manager')}
                  >
                    <input
                      className="input"
                      placeholder={t('panel.searchManager')}
                      value={managerQuery}
                      onChange={(e) => setManagerQuery(e.target.value)}
                      style={{ marginBottom: 6, width: '100%' }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <button
                        className="dd-item"
                        style={{ width: '100%', textAlign: 'left', fontWeight: managerFilter === 'ALL' ? 700 : 400 }}
                        onClick={() => setManagerFilter('ALL')}
                      >
                        {t('panel.allManagers')}
                      </button>
                      {managerOptions.hasNone && (
                        <button
                          className="dd-item"
                          style={{ width: '100%', textAlign: 'left', fontWeight: managerFilter === 'NONE' ? 700 : 400 }}
                          onClick={() => setManagerFilter('NONE')}
                        >
                          {t('panel.noManager')}
                        </button>
                      )}
                      <VirtualList
                        key={managerQuery}
                        items={managerOptions.list.filter((m) =>
                          m.name.toLowerCase().includes(managerQuery.trim().toLowerCase()),
                        )}
                        itemHeight={34}
                        visibleCount={5}
                        keyFn={(m) => m.id}
                        renderItem={(m) => (
                          <button
                            className="dd-item truncate"
                            style={{ width: '100%', textAlign: 'left', fontWeight: managerFilter === m.id ? 700 : 400 }}
                            onClick={() => setManagerFilter(m.id)}
                          >
                            {m.name}
                          </button>
                        )}
                      />
                    </div>
                  </FilterAccordionSection>
                )}

                <FilterAccordionSection
                  title={t('panel.sectionBillable')}
                  valueLabel={selectedBillableLabel}
                  isOpen={openFilterSections.has('billable')}
                  onToggle={() => toggleFilterSection('billable')}
                >
                  <div className="row" style={{ gap: 6 }}>
                    {([
                      ['ALL', t('panel.billableAll')],
                      ['BILLABLE', t('panel.billableOnly')],
                      ['NON_BILLABLE', t('panel.nonBillableOnly')],
                    ] as [BillableFilter, string][]).map(([val, label]) => (
                      <button
                        key={val}
                        className={'btn btn-sm ' + (billableFilter === val ? 'btn-accent' : 'btn-ghost')}
                        style={{ flex: 1 }}
                        onClick={() => setBillableFilter(val)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </FilterAccordionSection>

                <FilterAccordionSection
                  title={t('panel.sectionTimeframe')}
                  valueLabel={tfLabel}
                  isOpen={openFilterSections.has('timeframe')}
                  onToggle={() => toggleFilterSection('timeframe')}
                >
                  <button
                    className="dd-item"
                    style={{ width: '100%', textAlign: 'left', fontWeight: !tfActive ? 700 : 400 }}
                    onClick={() => setTfActive(false)}
                  >
                    {t('panel.anyTimeframe')}
                  </button>
                  <div className="row" style={{ gap: 6, margin: '8px 0' }}>
                    {(['quarter', 'year'] as TimeframeGran[]).map((g) => (
                      <button
                        key={g}
                        className={'btn btn-sm ' + (tfActive && tfGran === g ? 'btn-accent' : 'btn-ghost')}
                        style={{ flex: 1 }}
                        onClick={() => {
                          setTfGran(g);
                          setTfOffset(0);
                          setTfActive(true);
                        }}
                      >
                        {g === 'quarter' ? t('panel.timeframeQuarter') : t('panel.timeframeYear')}
                      </button>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      title={t('panel.prevPeriod')}
                      onClick={() => {
                        setTfActive(true);
                        setTfOffset((o) => o - 1);
                      }}
                    >
                      ‹
                    </button>
                    <span style={{ fontSize: 13, fontWeight: 700, minWidth: 90, textAlign: 'center' }}>
                      {fiscalLabel(fyStartMonth, tfGran, tfPeriod)}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      title={t('panel.nextPeriod')}
                      onClick={() => {
                        setTfActive(true);
                        setTfOffset((o) => o + 1);
                      }}
                    >
                      ›
                    </button>
                  </div>
                  {tfActive && tfOffset !== 0 && (
                    <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setTfOffset(0)}>
                      {t('panel.thisPeriod')}
                    </button>
                  )}
                </FilterAccordionSection>

                <FilterAccordionSection
                  title={t('panel.sectionStatus')}
                  valueLabel={t('panel.status', { selected: visibleStatuses.size, total: ALL_STATUSES.length })}
                  isOpen={openFilterSections.has('status')}
                  onToggle={() => toggleFilterSection('status')}
                >
                  {ALL_STATUSES.map((s) => {
                    const checked = visibleStatuses.has(s);
                    const meta = STATUS_META[s];
                    return (
                      <label key={s} className="dd-item" style={{ cursor: 'pointer', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleStatus(s)}
                          style={{ accentColor: `oklch(0.55 0.15 ${meta.hue})` }}
                        />
                        <span className="pj-status-dot" style={{ background: `oklch(0.62 0.16 ${meta.hue})` }} />
                        <span className="grow">{statusLabel(t, s)}</span>
                      </label>
                    );
                  })}
                  <div style={{ display: 'flex', gap: 6, fontSize: 11, marginTop: 4 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setVisibleStatuses(new Set(DEFAULT_VISIBLE_STATUSES))}>
                      {t('panel.resetHideArchived')}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setVisibleStatuses(new Set(ALL_STATUSES))}>
                      {t('panel.showAll')}
                    </button>
                  </div>
                </FilterAccordionSection>

                <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
                  <button className="btn btn-ghost btn-sm" style={{ flex: 1 }} onClick={resetAllFilters}>
                    {t('panel.resetAllFilters')}
                  </button>
                  <button className="btn btn-accent btn-sm" style={{ flex: 1 }} onClick={() => setFiltersMenuOpen(false)}>
                    {t('common.close')}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {canCreate && projects.length > 0 && (
        <button
          className="btn btn-ghost"
          onClick={() => setPickingCopySource(true)}
          title={t('panel.copyTitle')}
        >
          <Icon name="settings" size={14} /> {t('panel.copyProject')}
        </button>
      )}
      {canCreate && (
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> {t('panel.newDraft')}
        </button>
      )}
    </div>
  );

  const createModal =
    creating || copySource ? (
      <CreateDraftModal
        copyFrom={copySource}
        existingProjects={projects}
        onClose={() => {
          setCreating(false);
          setCopySource(null);
        }}
        onCreated={(p) => {
          setCreating(false);
          setCopySource(null);
          setProjects((ps) => [p, ...ps]);
          setManageId(p.id);
        }}
        pushToast={pushToast}
      />
    ) : null;

  if (loading) {
    return (
      <div className="pj-wrap" style={{ color: 'var(--text-3)' }}>
        {t('panel.loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="pj-wrap" style={{ color: 'var(--c-over)' }}>
        {t('panel.loadFailed', { error })}{' '}
        <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="pj-wrap">
      {header}
      {projects.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>
          {canViewAll && scope === 'mine' ? (
            <>
              {t('panel.emptyMine')}{' '}
              <button className="btn btn-ghost btn-sm" onClick={() => setScope('all')}>
                {t('panel.allProjects')}
              </button>
            </>
          ) : canCreate ? (
            t('panel.emptyCanCreate')
          ) : (
            t('panel.emptyNoVisible')
          )}
        </div>
      ) : filteredProjects.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>
          {query
            ? t('panel.noMatchSearch', { query: search.trim(), count: hiddenCount })
            : t('panel.noMatchFilter', { count: hiddenCount })}
        </div>
      ) : (
        <>
          <div className="pj-scroll">
            <div className="pj-grid">
              {pagedProjects.map((p) => (
                <ProjectCard
                  key={p.id}
                  p={p}
                  onManage={() => setManageId(p.id)}
                  onOpen={onOpenProject ? () => onOpenProject(p.id) : undefined}
                />
              ))}
            </div>
          </div>
          <div className="pj-foot">
          {totalPages > 1 && (
            <div
              className="row"
              style={{
                gap: 10,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <button
                className="btn btn-ghost btn-sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹ {t('panel.prevPage')}
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {t('panel.pageOf', { page: safePage, pages: totalPages })}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t('panel.nextPage')} ›
              </button>
            </div>
          )}
          <div
            style={{
              marginTop: totalPages > 1 ? 6 : 0,
              fontSize: 12,
              color: 'var(--text-3)',
              textAlign: 'right',
            }}
          >
            {t('panel.showingRange', {
              from: filteredProjects.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1,
              to: Math.min(safePage * PAGE_SIZE, filteredProjects.length),
              total: filteredProjects.length,
            })}
            {hiddenCount > 0
              ? ' · ' +
                (query
                  ? t('panel.hiddenBySearch', { count: hiddenCount })
                  : t('panel.hiddenByFilter', { count: hiddenCount }))
              : ''}
          </div>
          </div>
        </>
      )}
      {managed && (
        <ManageModal
          project={managed}
          onClose={() => setManageId(null)}
          onDeleted={(deletedId) => {
            setProjects((ps) => ps.filter((x) => x.id !== deletedId));
            setManageId(null);
          }}
          onSaved={(next) =>
            // Merge plutôt que remplacement : la réponse d'un PATCH ne porte
            // pas taskCounts/managers (enrichis seulement par GET /projects).
            setProjects((ps) => ps.map((x) => (x.id === next.id ? { ...x, ...next } : x)))
          }
          pushToast={pushToast}
        />
      )}
      {createModal}
      {pickingCopySource && (
        <CopyPickerModal
          projects={projects}
          onClose={() => setPickingCopySource(false)}
          onPick={(p) => {
            setPickingCopySource(false);
            setCopySource(p);
          }}
        />
      )}
    </div>
  );
}
