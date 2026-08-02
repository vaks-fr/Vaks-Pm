/* ============================================================
   Vaks — App shell: sidebar / topbar / routing / theme / toasts
   (Ported from the design's App.jsx; the design-tool Tweaks panel
   is intentionally omitted — its settings live as fixed defaults.)
   ============================================================ */
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  comments as DATA_COMMENTS,
  columns as DATA_COLUMNS,
  projects as PROJECTS,
  tasks as DATA_TASKS,
  timeEntries as DATA_TIME,
  currentUser,
  setVaksData,
  type BoardSubStatus,
  type Comment,
  type Project,
  type Task,
  type TimeEntry,
  type User,
} from './data';
import { Avatar, BrandMark, GROUP_COLORS, Icon } from './primitives';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { DEMO } from '../demo/config';
// Vues d'atterrissage + overlays instantanés : chargées eager (bundle initial).
import { KanbanView } from './KanbanView';
import { CommandPalette } from './CommandPalette';
import { DashboardView } from './DashboardView';
import { ListView } from './ListView';
import ChangePasswordDialog from './ChangePasswordDialog';
// Vues lourdes chargées à la demande (code-splitting) : chaque `import()` sort
// dans un chunk séparé, hors du bundle initial. On ne charge TaskDetail /
// AdminPanel / Reports / Timeline / etc. que lorsque l'utilisateur les ouvre.
// `hueFromId` (appelé eager au rendu) était ré-exporté par AdminPanel → on le
// prend désormais depuis `./api` (déjà eager) pour ne pas retenir AdminPanel
// dans le bundle initial. Les 3 lazy pointant sur ./TaskDetail partagent le
// même chunk (Rollup dédup).
const WorkloadView = lazy(() => import('./WorkloadView').then((m) => ({ default: m.WorkloadView })));
const TaskDetail = lazy(() => import('./TaskDetail').then((m) => ({ default: m.TaskDetail })));
const PredecessorBlockModal = lazy(() => import('./TaskDetail').then((m) => ({ default: m.PredecessorBlockModal })));
const HoldReasonModal = lazy(() => import('./TaskDetail').then((m) => ({ default: m.HoldReasonModal })));
const ReportsView = lazy(() => import('./ReportsView').then((m) => ({ default: m.ReportsView })));
const FinancesView = lazy(() => import('./FinancesView').then((m) => ({ default: m.FinancesView })));
const FinancePanel = lazy(() => import('./FinancePanel').then((m) => ({ default: m.FinancePanel })));
const TeamReportView = lazy(() => import('./TeamReportView').then((m) => ({ default: m.TeamReportView })));
const PortfolioKpiView = lazy(() => import('./PortfolioKpiView').then((m) => ({ default: m.PortfolioKpiView })));
const TimesheetView = lazy(() => import('./TimesheetView').then((m) => ({ default: m.TimesheetView })));
const TimelineView = lazy(() => import('./TimelineView').then((m) => ({ default: m.TimelineView })));
const PertView = lazy(() => import('./PertView').then((m) => ({ default: m.PertView })));
const ProjectsPanel = lazy(() => import('./ProjectsPanel').then((m) => ({ default: m.ProjectsPanel })));
const PortfolioPanel = lazy(() => import('./PortfolioPanel').then((m) => ({ default: m.PortfolioPanel })));
const MembersView = lazy(() => import('./MembersView').then((m) => ({ default: m.MembersView })));
const ProjectDocumentsView = lazy(() =>
  import('./projects/ProjectDocumentsView').then((m) => ({ default: m.ProjectDocumentsView })),
);
const AdminPanel = lazy(() => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })));
const TeamView = lazy(() => import('./TeamView').then((m) => ({ default: m.TeamView })));
const AgentsWorkspaceView = lazy(() => import('./AgentsWorkspaceView').then((m) => ({ default: m.AgentsWorkspaceView })));
const SecuritySettings = lazy(() => import('./SecuritySettings'));

/** Fallback affiché pendant le chargement d'un chunk de vue (React.Suspense). */
function ViewFallback() {
  return (
    <div className="view-suspense">
      <div className="sp" aria-label="loading" />
    </div>
  );
}
import { api as ApiClient, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useOrgName } from '../api/orgName';
import {
  apiAddComment,
  apiAddTimeEntry,
  apiCreateLabel,
  apiCreateTask,
  apiDeleteTask,
  apiMoveTask,
  apiLoadSubStatuses,
  apiPatchTask,
  loadVaksFromApi,
  tryApplyProjectSnapshot,
  thisMondayUTC,
  toVaksComment,
  toVaksTask,
  toVaksTimeEntry,
  apiListProjectWatchers,
  apiWatchProject,
  apiUnwatchProject,
  hueFromId,
} from './api';
import { useProjectEvents, useUserNotifications } from '../api/realtime';
import {
  getMode,
  pushNotification,
  setMode,
  useRealtime,
} from '../realtime/store';
import { NotificationsPanel } from '../realtime/NotificationsPanel';
import type { TaskDto, CommentDto, TimeEntryDto } from '@vaks-pm/shared';

interface Settings {
  theme: 'dark' | 'light';
  accent: string;
  navLayout: 'sidebar' | 'top';
  density: 'comfortable' | 'compact';
  showLabels: boolean;
  wlViz: 'heatmap' | 'bars';
  live: boolean;
}

const TWEAK_DEFAULTS: Settings = {
  theme: 'dark',
  accent: '#d9604c',
  navLayout: 'sidebar',
  density: 'comfortable',
  showLabels: true,
  wlViz: 'heatmap',
  // Simulation realtime désactivée maintenant qu'on est sur l'API réelle.
  // Les futurs events WS prendront le relais (à brancher ultérieurement).
  live: false,
};

const ACCENTS: Record<string, { h: number; c: number; name: string }> = {
  '#d9604c': { h: 31, c: 0.165, name: 'Coral' }, // marque (dérivé du logo) — défaut
  '#2f7ef0': { h: 252, c: 0.15, name: 'Blue' },
  '#0fae96': { h: 178, c: 0.115, name: 'Teal' },
  '#e8590c': { h: 50, c: 0.16, name: 'Amber' },
  '#e64980': { h: 0, c: 0.16, name: 'Rose' },
};

interface NavEntry {
  id: string;
  labelKey: string;
  icon: string;
  soon?: string;
  star?: boolean;
}
// `reports` et `finances` ne sont plus des entrées plates : ils vivent sous le
// groupe déroulant « KPI project » (voir NavItems / NavGroup).
const NAV: NavEntry[] = [
  { id: 'board', labelKey: 'nav.board', icon: 'board' },
  { id: 'list', labelKey: 'nav.list', icon: 'list' },
  { id: 'timeline', labelKey: 'nav.timeline', icon: 'timeline' },
  { id: 'pert', labelKey: 'nav.pert', icon: 'branch' },
  { id: 'workload', labelKey: 'nav.workload', icon: 'gauge', star: true },
  { id: 'timesheet', labelKey: 'nav.timesheet', icon: 'hourglass' },
  { id: 'documents', labelKey: 'nav.documents', icon: 'paperclip' },
  { id: 'members', labelKey: 'nav.members', icon: 'users' },
];

// Le lundi de la semaine en cours est calculé dans le composant via
// thisMondayUTC() et stocké dans mondayRef. Plus de date hardcodée.

interface Toast {
  id: number;
  actor: User;
  text: string;
  warn?: boolean;
}

function Toasts({ items, dismiss }: { items: Toast[]; dismiss: (id: number) => void }) {
  const { t: tr } = useTranslation();
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={'toast' + (t.warn ? ' toast-warn' : '')}>
          <Avatar user={t.actor} size={26} title={false} />
          <div className="grow">
            <span className="toast-name">{t.actor.short}</span> <span className="toast-text">{t.text}</span>
          </div>
          <button className="toast-x" onClick={() => dismiss(t.id)} aria-label={tr('dismiss')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Écran plein affiché à un compte **sans siège de licence** non-admin (parqué /
 * provisionné au-delà du plafond). Il ne peut rien faire dans l'app tant qu'un
 * administrateur ne lui attribue pas de siège ; on lui offre juste la
 * déconnexion. (Un admin-only, lui, est redirigé vers le portail admin.)
 */
function NoSeatScreen({ onLogout, email }: { onLogout: () => void; email: string }) {
  const { t: tr } = useTranslation();
  return (
    <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
      <div className="placeholder" style={{ maxWidth: 460, textAlign: 'center' }}>
        <div className="ph-icon">
          <BrandMark size={28} />
        </div>
        <h2 style={{ marginTop: 16 }}>{tr('noSeat.title')}</h2>
        <p style={{ color: 'var(--text-2)', marginTop: 8 }}>{tr('noSeat.body')}</p>
        {email && (
          <p className="mono" style={{ color: 'var(--text-faint)', marginTop: 8, fontSize: 13 }}>
            {tr('noSeat.signedInAs', { email })}
          </p>
        )}
        <button className="btn btn-line" style={{ marginTop: 20 }} onClick={onLogout}>
          {tr('shell.signOut')}
        </button>
      </div>
    </div>
  );
}

function Placeholder({ nav }: { nav: string }) {
  const meta = (
    {
      timeline: {
        icon: 'timeline',
        title: 'Gantt & Timeline',
        phase: 'Phase 4',
        lines: ['Resizable task bars on a date axis', 'Dependencies (FS / SS / FF / SF) with lag', 'Milestones, critical path & cascade shifting'],
      },
      reports: {
        icon: 'dash',
        title: 'Reporting & Dashboards',
        phase: 'Phase 3',
        lines: ['Progress, burndown & burnup charts', 'Time spent by project, person & label', 'On-time vs late · capacity overview · CSV / PDF export'],
      },
    } as Record<string, { icon: string; title: string; phase: string; lines: string[] }>
  )[nav];
  return (
    <div className="placeholder">
      <div className="ph-icon">
        <Icon name={meta.icon} size={30} />
      </div>
      <div className="ph-phase mono">{meta.phase}</div>
      <h2 className="ph-title">{meta.title}</h2>
      <p className="ph-sub">Wired to the same task data as Board, List and Workload — coming in this build phase.</p>
      <ul className="ph-list">
        {meta.lines.map((l, i) => (
          <li key={i}>
            <Icon name="check" size={15} /> {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================================================
   Team picker for the Workload view.
   Loads the team list from the API on mount. If no team exists
   (empty list), the picker collapses to a non-interactive "Everyone"
   label. Otherwise it shows a dropdown with "Everyone" + each team.
   ============================================================ */
function TeamScopePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t: tr } = useTranslation();
  const [teams, setTeams] = React.useState<
    { id: string; name: string; color: string | null }[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    ApiClient.listTeams()
      .then((list) => {
        if (cancelled) return;
        setTeams(list.map((t) => ({ id: t.id, name: t.name, color: t.color })));
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  const selected =
    value === 'all'
      ? { name: tr('shell.everyone'), color: null as string | null }
      : teams.find((t) => t.id === value) ?? {
          name: tr('shell.everyone'),
          color: null as string | null,
        };

  // No teams in the org → just show a static "Everyone" label.
  if (!loading && teams.length === 0) {
    return (
      <span
        style={{
          fontSize: 13,
          color: 'var(--text-2)',
          padding: '6px 12px',
          border: '1px solid var(--border)',
          borderRadius: 999,
          background: 'var(--surface-2)',
        }}
      >
        {tr('shell.everyone')}
      </span>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          border: '1px solid var(--border)',
          borderRadius: 999,
          background: 'var(--surface-2)',
          color: 'var(--text)',
          fontSize: 13,
          fontFamily: 'inherit',
          cursor: 'pointer',
          minWidth: 140,
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}
        >
          {selected.color && (
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: selected.color,
                flexShrink: 0,
              }}
            />
          )}
          <Icon name="users" size={13} style={{ color: 'var(--text-3)' }} />
          <span
            className="truncate"
            style={{ minWidth: 0, maxWidth: 160 }}
          >
            {selected.name}
          </span>
        </span>
        <Icon name="chevDown" size={14} style={{ color: 'var(--text-3)' }} />
      </button>
      {open && (
        <div
          className="dd-menu team-scope-menu"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            minWidth: 200,
            maxHeight: 320,
            overflowY: 'auto',
            boxShadow: '0 10px 30px oklch(0 0 0 / 0.35)',
            zIndex: 50,
            padding: 4,
          }}
        >
          <button
            className="dd-item"
            onClick={() => {
              onChange('all');
              setOpen(false);
            }}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              border: 0,
              background:
                value === 'all'
                  ? 'oklch(from var(--accent) l c h / 0.12)'
                  : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              borderRadius: 6,
              textAlign: 'left',
            }}
          >
            <Icon name="users" size={13} style={{ color: 'var(--text-3)' }} />
            <span style={{ flex: 1 }}>{tr('shell.everyone')}</span>
            {value === 'all' && (
              <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />
            )}
          </button>
          {teams.length > 0 && (
            <div
              style={{
                height: 1,
                background: 'var(--border)',
                margin: '4px 0',
              }}
            />
          )}
          {teams.map((t) => (
            <button
              key={t.id}
              className="dd-item"
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                border: 0,
                background:
                  value === t.id
                    ? 'oklch(from var(--accent) l c h / 0.12)'
                    : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                borderRadius: 6,
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: t.color ?? 'var(--accent)',
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }} className="truncate">
                {t.name}
              </span>
              {value === t.id && (
                <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Workspace() {
  const { t: tr } = useTranslation();
  // Réglages UI persistés (thème, accent, densité…) — survivent à un F5.
  const [t, setT] = useState<Settings>(() => {
    try {
      const saved = localStorage.getItem('vaks_settings');
      if (saved) {
        const merged = { ...TWEAK_DEFAULTS, ...(JSON.parse(saved) as Partial<Settings>) };
        // Migration palette de marque : un accent sauvegardé qui n'existe plus
        // dans les presets (ancien indigo #6d5efc, valeur corrompue…) retombe
        // sur le corail de marque. Idempotent, réécrit au prochain setItem.
        if (!ACCENTS[merged.accent]) merged.accent = TWEAK_DEFAULTS.accent;
        return merged;
      }
    } catch {
      /* localStorage indispo ou JSON corrompu → défauts */
    }
    return TWEAK_DEFAULTS;
  });
  const setTweak = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => setT((s) => ({ ...s, [key]: value })), []);
  useEffect(() => {
    try {
      localStorage.setItem('vaks_settings', JSON.stringify(t));
    } catch {
      /* quota / mode privé : on ignore, l'UI reste fonctionnelle */
    }
  }, [t]);

  // La vue active est reflétée dans l'URL (?view=…) pour survivre à un F5
  // et activer le bouton Précédent du navigateur.
  const [searchParams, setSearchParams] = useSearchParams();
  // Vue d'atterrissage par défaut (URL sans `?view=`) = le dashboard personnel
  // (`mytasks`) — première chose vue à la connexion. Le board projet est
  // désormais explicite (`?view=board`).
  const [view, setViewState] = useState(() => searchParams.get('view') || 'mytasks');
  const setView = useCallback(
    (next: string) => {
      setViewState(next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'mytasks') params.delete('view');
          else params.set('view', next);
          return params;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );
  // Synchronise quand l'URL change sous nos pieds (bouton Précédent/Suivant).
  useEffect(() => {
    const urlView = searchParams.get('view') || 'mytasks';
    setViewState((cur) => (cur === urlView ? cur : urlView));
  }, [searchParams]);
  const [tasks, setTasks] = useState<Task[]>(DATA_TASKS);
  const [openId, setOpenId] = useState<string | null>(null);
  // Tâche ouverte appartenant à un AUTRE projet que celui courant (ex. depuis
  // la vue Workload en scope global/équipe). Chargée à la demande par id, et
  // rendue dans TaskDetail avec un bandeau « tâche d'un autre projet ».
  const [foreignTask, setForeignTask] = useState<Task | null>(null);
  const [timelineRefresh, setTimelineRefresh] = useState(0);
  const [workloadRefresh, setWorkloadRefresh] = useState(0);
  const [comments, setComments] = useState<Record<string, Comment[]>>(DATA_COMMENTS);
  const [entries, setEntries] = useState<Record<string, TimeEntry[]>>(DATA_TIME);
  const [scope, setScope] = useState('all');
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Popup « tâches précédentes non terminées » déclenché par un déplacement
  // Kanban vers la colonne Done refusé par le serveur (409). Mémorise la cible
  // pour rejouer le move en cascade si l'utilisateur confirme.
  const [predBlock, setPredBlock] = useState<{
    taskId: string;
    columnId: string;
    beforeTaskId?: string;
    afterTaskId?: string;
    predecessors: { id: string; title: string }[];
  } | null>(null);
  // Tâche pour laquelle on demande la raison de mise en pause (facultative),
  // ouverte après un passage en colonne On Hold (drag Kanban ou dropdown détail).
  const [holdReasonTask, setHoldReasonTask] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  // Avertissement affiché à l'arrivée sur la démo sandbox (une fois par onglet
  // navigateur — sessionStorage, pas localStorage : on veut le revoir à chaque
  // nouvelle visite, pas seulement au tout premier passage jamais).
  const [demoWelcomeOpen, setDemoWelcomeOpen] = useState(false);
  useEffect(() => {
    if (!DEMO) return;
    try {
      if (sessionStorage.getItem('vaks-demo-welcome-seen')) return;
    } catch {
      /* sessionStorage indispo (mode privé strict) : on affiche quand même */
    }
    setDemoWelcomeOpen(true);
  }, []);
  const dismissDemoWelcome = useCallback(() => {
    setDemoWelcomeOpen(false);
    try {
      sessionStorage.setItem('vaks-demo-welcome-seen', '1');
    } catch {
      /* ignore */
    }
  }, []);
  const [search, setSearch] = useState('');
  const toastId = useRef(0);
  // Contexte API (rempli après loadVaksFromApi)
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mondayRef = useRef<Date>(thisMondayUTC());
  const projectIdRef = useRef<string | null>(null);
  const [projectsList, setProjectsList] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  // Sous-statuts (Custom Status) applicables au projet courant : containers du
  // board + sélecteur TaskDetail. Fail-soft (liste vide si l'appel échoue —
  // le board retombe sur les colonnes simples).
  const [subStatuses, setSubStatuses] = useState<BoardSubStatus[]>([]);
  useEffect(() => {
    let alive = true;
    if (!currentProjectId) {
      setSubStatuses([]);
      return;
    }
    apiLoadSubStatuses(currentProjectId)
      .then((s) => {
        if (alive) setSubStatuses(s);
      })
      .catch(() => {
        if (alive) setSubStatuses([]);
      });
    return () => {
      alive = false;
    };
  }, [currentProjectId]);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [projSearch, setProjSearch] = useState('');
  const projSwitchRef = useRef<HTMLDivElement | null>(null);
  const projSearchRef = useRef<HTMLInputElement | null>(null);
  const [myPermissions, setMyPermissions] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [managesAnyProject, setManagesAnyProject] = useState(false);
  // Bump pour re-render quand les colonnes du board (binding module `data.ts`)
  // changent hors du flux `setTasks` — ex. édition de la limite WIP.
  const [boardVersion, setBoardVersion] = useState(0);
  // Command palette (⌘K / Ctrl+K) — recherche globale projets/tâches.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isProjectAdmin =
    isAdmin || myPermissions.includes('*') || myPermissions.includes('project:view_all');
  // Édition de la config du board (dont limite WIP) : PM/lead/admin. L'API
  // (`project:update`) reste le garde-fou réel ; ici on cache juste le contrôle.
  const canEditBoard =
    isAdmin ||
    myPermissions.includes('*') ||
    myPermissions.includes('project:update') ||
    managesAnyProject;
  const canSeeProjectsPanel = isProjectAdmin || managesAnyProject;
  const canSeePortfolioPanel =
    isAdmin ||
    myPermissions.includes('*') ||
    myPermissions.includes('client:view') ||
    myPermissions.includes('client:manage');
  const canSeeFinance =
    isAdmin || myPermissions.includes('*') || myPermissions.includes('finance:view');
  // « AI administrator » : grant orthogonal `agent:manage` empilé sur le rôle org.
  // Ouvre l'admin panel en mode restreint (sections agents uniquement) sans être
  // admin global. `isAdmin` court-circuite (accès complet).
  const canAgentAdmin =
    isAdmin || myPermissions.includes('*') || myPermissions.includes('agent:manage');

  // apply theme + accent to :root
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', t.theme);
    const a = ACCENTS[t.accent] || ACCENTS['#d9604c'];
    root.style.setProperty('--accent-h', String(a.h));
    root.style.setProperty('--accent-c', String(a.c));
  }, [t.theme, t.accent]);

  // Chargement initial depuis l'API réelle (remplace les mocks de data.ts).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const preferred = sessionStorage.getItem('vaks.currentProjectId');
        const [{ monday, projectId }, meResp] = await Promise.all([
          loadVaksFromApi(preferred),
          ApiClient.me().catch(() => null),
        ]);
        if (cancelled) return;
        mondayRef.current = monday;
        projectIdRef.current = projectId;
        const m = await import('./data');
        setProjectsList(m.projects);
        setCurrentProjectId(projectId);
        setTasks(m.tasks);
        setComments(m.comments);
        setEntries(m.timeEntries);
        setMyPermissions(meResp?.permissions ?? []);
        setIsAdmin(!!meResp?.isAdmin);
        setManagesAnyProject(!!meResp?.managesAnyProject);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[Vaks] load failed', e);
        setLoadError((e as Error).message);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bascule de projet : stale-while-revalidate. Si on a un snapshot en cache
  // pour ce projet, on l'applique synchronement (zéro loader) et on rafraîchit
  // en arrière-plan. Sinon flow normal avec loader.
  const switchProject = useCallback(async (projectId: string) => {
    if (projectId === projectIdRef.current) {
      setProjMenuOpen(false);
      return;
    }
    setProjMenuOpen(false);
    sessionStorage.setItem('vaks.currentProjectId', projectId);

    const applySnapshot = async (monday: Date, loaded: string | null) => {
      mondayRef.current = monday;
      projectIdRef.current = loaded;
      // Le store data.ts vient d'être patché par {tryApplyProjectSnapshot|loadVaksFromApi}.
      // Les `export let` reflètent les nouvelles valeurs via ESM live bindings.
      const m = await import('./data');
      setProjectsList(m.projects);
      setCurrentProjectId(loaded);
      setTasks(m.tasks);
      setComments(m.comments);
      setEntries(m.timeEntries);
    };

    const cached = tryApplyProjectSnapshot(projectId);
    if (cached) {
      await applySnapshot(cached.monday, cached.projectId);
      setOpenId(null);
      setTimelineRefresh((n) => n + 1);
      // Refresh en arrière-plan : pas de loader, pas d'erreur bloquante.
      void (async () => {
        try {
          const { monday, projectId: loaded } = await loadVaksFromApi(projectId, { skipGlobal: true });
          if (projectIdRef.current !== loaded) return; // l'utilisateur a re-switché entretemps
          await applySnapshot(monday, loaded);
          setTimelineRefresh((n) => n + 1);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Vaks] background refresh failed', e);
        }
      })();
      return;
    }

    setLoading(true);
    try {
      const { monday, projectId: loaded } = await loadVaksFromApi(projectId, { skipGlobal: true });
      await applySnapshot(monday, loaded);
      setOpenId(null);
      setTimelineRefresh((n) => n + 1);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Vaks] project switch failed', e);
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Ouvre/ferme la command palette via ⌘K / Ctrl+K (capture globale).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Sélection d'un résultat de recherche globale : bascule de projet si besoin,
  // puis ouvre la tâche (le drawer lit la tâche dans le snapshot chargé).
  const openSearchTask = useCallback(
    async (pid: string, taskId: string) => {
      if (pid !== projectIdRef.current) await switchProject(pid);
      setOpenId(taskId);
    },
    [switchProject],
  );

  // Ferme le menu projets quand on clique en dehors.
  useEffect(() => {
    if (!projMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!projSwitchRef.current) return;
      if (!projSwitchRef.current.contains(e.target as Node)) setProjMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [projMenuOpen]);

  // Lazy-load des commentaires : on ne fetch que quand on ouvre une tâche
  // (et une seule fois — `comments[openId]` est défini ensuite, même si vide).
  useEffect(() => {
    if (!openId) return;
    if (comments[openId] !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const cs = await ApiClient.listComments(openId);
        if (cancelled) return;
        setComments((prev) =>
          prev[openId] !== undefined ? prev : { ...prev, [openId]: cs.map(toVaksComment) },
        );
      } catch {
        if (cancelled) return;
        setComments((prev) =>
          prev[openId] !== undefined ? prev : { ...prev, [openId]: [] },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openId, comments]);

  // Tâche d'un autre projet : si `openId` ne correspond à aucune tâche du
  // projet courant (cas typique : double-clic sur un chip Workload en scope
  // global/équipe), on charge la tâche par id pour pouvoir l'ouvrir quand même.
  useEffect(() => {
    if (!openId) {
      setForeignTask(null);
      return;
    }
    if (tasks.some((tk) => tk.id === openId)) {
      // Présente dans le projet courant → pas de chargement externe.
      setForeignTask(null);
      return;
    }
    if (foreignTask?.id === openId) return; // déjà chargée
    let cancelled = false;
    (async () => {
      try {
        const dto = await ApiClient.getTask(openId);
        if (cancelled) return;
        const pkey = projectsList.find((p) => p.id === dto.projectId)?.key;
        setForeignTask(toVaksTask(dto, mondayRef.current, pkey));
      } catch {
        if (cancelled) return;
        setForeignTask(null);
        setOpenId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openId, tasks, foreignTask, projectsList]);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { ...toast, id }].slice(-4));
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 5200);
  }, []);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((x) => x.id !== id));

  const updateTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      // Mutations qui invalident le rollup d'estimate côté groupes :
      // un changement d'estimate, de parent, ou du flag groupe peut faire
      // bouger la somme remontée sur les ancêtres.
      const triggersRollup =
        patch.estimate !== undefined ||
        patch.parentTaskId !== undefined ||
        patch.isGroup !== undefined;

      // Optimistic UI : applique localement la modif demandée puis propage
      // les rollups d'estimate sur tous les groupes ancêtres concernés.
      const rollupPatches: { id: string; estimate: number | null }[] = [];
      setTasks((ts) => {
        let next = ts.map((tk) => (tk.id === id ? { ...tk, ...patch } : tk));
        if (!triggersRollup) return next;
        // Ensemble des ancêtres à recomputer : on remonte depuis la tâche
        // modifiée ET — au cas où parentTaskId a changé — depuis l'ancien parent.
        const visited = new Set<string>();
        const ancestorsToVisit: string[] = [];
        const target = next.find((t) => t.id === id);
        if (target?.parentTaskId) ancestorsToVisit.push(target.parentTaskId);
        const oldParent = ts.find((t) => t.id === id)?.parentTaskId;
        if (oldParent && oldParent !== target?.parentTaskId)
          ancestorsToVisit.push(oldParent);
        while (ancestorsToVisit.length) {
          const aid = ancestorsToVisit.shift()!;
          if (visited.has(aid)) continue;
          visited.add(aid);
          const group = next.find((t) => t.id === aid);
          if (!group || !group.isGroup) continue;
          const rolled = sumLeafEstimates(next, group.id);
          if ((group.estimate ?? null) !== rolled) {
            next = next.map((t) =>
              t.id === group.id ? { ...t, estimate: rolled } : t,
            );
            rollupPatches.push({ id: group.id, estimate: rolled });
          }
          if (group.parentTaskId) ancestorsToVisit.push(group.parentTaskId);
        }
        return next;
      });

      // On n'envoie pas certaines clés (col, comments count) — ces patchs
      // viennent du drag-and-drop Kanban qui appelle déjà l'API via apiMoveTask
      // dans KanbanView. Ici on relaie les autres champs (priorité, titre…).
      const sendable: Partial<Task> = { ...patch };
      delete (sendable as { col?: unknown }).col;
      delete (sendable as { comments?: unknown }).comments;
      delete (sendable as { attachments?: unknown }).attachments;
      delete (sendable as { subtasks?: unknown }).subtasks;
      delete (sendable as { key?: unknown }).key;
      const sysActorLocal = { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true };
      if (Object.keys(sendable).length > 0) {
        apiPatchTask(id, sendable, mondayRef.current).catch((err) => {
          pushToast({ actor: sysActorLocal, text: tr('toast.saveFailed', { message: (err as Error).message }), warn: true });
        });
      }
      // Patches d'estimates rollupés sur les groupes ancêtres
      for (const rp of rollupPatches) {
        apiPatchTask(rp.id, { estimate: rp.estimate }, mondayRef.current).catch(
          (err) => {
            pushToast({ actor: sysActorLocal, text: tr('toast.rollupFailed', { message: (err as Error).message }), warn: true });
          },
        );
      }
      // Force la Timeline à se recharger pour refléter les changements d'estimate
      // (qui peuvent décaler les durées calculées par CPM côté serveur).
      if (triggersRollup) setTimelineRefresh((n) => n + 1);
    },
    [pushToast, tr],
  );

  /**
   * Somme des `estimate` (en heures) de toutes les tâches feuilles (non-groupe)
   * descendantes du groupe identifié. Retourne `null` si aucune feuille n'a
   * d'estimate (pour éviter d'écrire un 0 trompeur dans la base).
   */
  function sumLeafEstimates(all: Task[], groupId: string): number | null {
    let total = 0;
    let found = false;
    const stack = [groupId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const t of all) {
        if (t.parentTaskId !== cur) continue;
        if (t.isGroup) {
          stack.push(t.id);
        } else if (typeof t.estimate === 'number') {
          total += t.estimate;
          found = true;
        }
      }
    }
    return found ? Math.round(total * 100) / 100 : null;
  }
  const toggleCheck = useCallback(
    (id: string, itemId: string) =>
      setTasks((ts) =>
        ts.map((tk) => {
          if (tk.id !== id || !tk.checklist) return tk;
          const checklist = tk.checklist.map((c) => (c.id === itemId ? { ...c, done: !c.done } : c));
          const done = checklist.filter((c) => c.done).length;
          return { ...tk, checklist, progress: tk.checklist.length ? Math.round((done / tk.checklist.length) * 100) : tk.progress };
        }),
      ),
    [],
  );
  const addComment = useCallback((taskId: string, body: string) => {
    // Optimistic
    const tempId = 'tmp-' + Date.now();
    const optimistic: Comment = { id: tempId, user: currentUser, at: 'just now', body };
    setComments((cs) => ({ ...cs, [taskId]: [...(cs[taskId] || []), optimistic] }));
    apiAddComment(taskId, body)
      .then((real) => {
        setComments((cs) => ({
          ...cs,
          [taskId]: (cs[taskId] || []).map((c) => (c.id === tempId ? real : c)),
        }));
      })
      .catch((err) => {
        // rollback
        setComments((cs) => ({
          ...cs,
          [taskId]: (cs[taskId] || []).filter((c) => c.id !== tempId),
        }));
        pushToast({
          actor: { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true },
          text: tr('toast.commentFailed', { message: (err as Error).message }),
          warn: true,
        });
      });
  }, [tr]);

  const addTime = useCallback((taskId: string, entry: TimeEntry) => {
    // Optimistic
    const tempId = 'tmp-' + Date.now();
    setEntries((es) => ({ ...es, [taskId]: [...(es[taskId] || []), { ...entry, id: tempId }] }));
    // entry.day est un offset depuis lundi (peut être négatif). Reconstruit la date ISO.
    const date = new Date(mondayRef.current.getTime() + entry.day * 86_400_000)
      .toISOString()
      .slice(0, 10);
    apiAddTimeEntry(
      taskId,
      { hours: entry.hours, note: entry.note, date },
      mondayRef.current,
    )
      .then((real) => {
        setEntries((es) => ({
          ...es,
          [taskId]: (es[taskId] || []).map((e) => (e.id === tempId ? real : e)),
        }));
      })
      .catch((err) => {
        setEntries((es) => ({
          ...es,
          [taskId]: (es[taskId] || []).filter((e) => e.id !== tempId),
        }));
        pushToast({
          actor: { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true },
          text: tr('toast.timeEntryFailed', { message: (err as Error).message }),
          warn: true,
        });
      });
  }, [tr]);

  const deleteTask = useCallback((taskId: string) => {
    // Optimistic : retire localement, rollback en cas d'erreur API.
    let snapshot: Task[] = [];
    setTasks((ts) => {
      snapshot = ts;
      return ts.filter((t) => t.id !== taskId);
    });
    setOpenId((cur) => (cur === taskId ? null : cur));
    apiDeleteTask(taskId).catch((err) => {
      setTasks(snapshot);
      pushToast({
        actor: { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true },
        text: tr('toast.deleteFailed', { message: (err as Error).message }),
        warn: true,
      });
    });
  }, [pushToast, tr]);
  /**
   * Enveloppe `setTasks` pour Kanban : détecte les déplacements de colonne
   * (changement de `col`) ET les créations locales (ids non vus avant),
   * puis synchronise avec l'API. KanbanView reste ignorant de l'API.
   */
  const sysActor = useMemo<User>(
    () => ({ id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true }),
    [],
  );
  const setTasksSync: React.Dispatch<React.SetStateAction<Task[]>> = useCallback(
    (updater) => {
      setTasks((prev) => {
        const next =
          typeof updater === 'function' ? (updater as (p: Task[]) => Task[])(prev) : updater;
        const prevById = new Map(prev.map((tk) => [tk.id, tk]));
        for (const tk of next) {
          const old = prevById.get(tk.id);
          if (!old) {
            // Nouvelle carte locale : la persister via l'API.
            if (!projectIdRef.current) continue;
            apiCreateTask(projectIdRef.current, {
              title: tk.title,
              columnId: tk.col,
              priority: tk.priority,
              estimateHours: tk.estimate ?? undefined,
              due: tk.due,
              monday: mondayRef.current,
              isGroup: tk.isGroup,
              isMilestone: tk.isMilestone,
            })
              .then((real) => {
                // Remplace l'id local par l'id réel renvoyé par l'API
                setTasks((cur) => cur.map((c) => (c.id === tk.id ? real : c)));
              })
              .catch((err) => {
                setTasks((cur) => cur.filter((c) => c.id !== tk.id));
                pushToast({ actor: sysActor, text: tr('toast.createFailed', { message: (err as Error).message }), warn: true });
              });
          } else if (old.col !== tk.col) {
            // Déplacement entre colonnes
            const colArr = next.filter((x) => x.col === tk.col);
            const idx = colArr.findIndex((x) => x.id === tk.id);
            const afterTaskId = idx > 0 ? colArr[idx - 1].id : undefined;
            const beforeTaskId = idx < colArr.length - 1 ? colArr[idx + 1].id : undefined;
            const prevCol = old.col;
            // Le drag Kanban fixe déjà le sous-statut cible (container ou zone
            // principale) sur la tâche : on le transmet explicitement.
            apiMoveTask(tk.id, tk.col, mondayRef.current, beforeTaskId, afterTaskId, {
              subStatusId: tk.subStatusId ?? null,
            }).catch((err) => {
              // Déplacement vers Done refusé car des prédécesseurs sont ouverts :
              // on annule visuellement le déplacement et on propose la cascade.
              const body = err instanceof ApiError ? (err.body as { code?: string; message?: string; predecessors?: { id: string; title: string }[] }) : null;
              if (body?.code === 'PREDECESSORS_NOT_DONE') {
                setTasks((ts) => ts.map((t) => (t.id === tk.id ? { ...t, col: prevCol } : t)));
                setPredBlock({
                  taskId: tk.id,
                  columnId: tk.col,
                  beforeTaskId,
                  afterTaskId,
                  predecessors: body.predecessors ?? [],
                });
                return;
              }
              // Limite WIP atteinte : la colonne cible est pleine → on annule
              // visuellement le déplacement et on explique pourquoi.
              if (body?.code === 'WIP_LIMIT_REACHED') {
                setTasks((ts) => ts.map((t) => (t.id === tk.id ? { ...t, col: prevCol } : t)));
                pushToast({ actor: sysActor, text: body.message ?? tr('toast.moveFailed', { message: '' }), warn: true });
                return;
              }
              pushToast({ actor: sysActor, text: tr('toast.moveFailed', { message: (err as Error).message }), warn: true });
            });
            // Passage en colonne On Hold : proposer de saisir une raison (facultative).
            if (DATA_COLUMNS.find((c) => c.id === tk.col)?.status === 'hold') {
              setHoldReasonTask(tk.id);
            }
          } else if ((old.subStatusId ?? null) !== (tk.subStatusId ?? null)) {
            // Déplacement DANS la colonne entre containers de sous-statut
            // (même statut, sous-statut différent) : move avec la même colonne.
            const colArr = next.filter((x) => x.col === tk.col);
            const idx = colArr.findIndex((x) => x.id === tk.id);
            const afterTaskId = idx > 0 ? colArr[idx - 1].id : undefined;
            const beforeTaskId = idx < colArr.length - 1 ? colArr[idx + 1].id : undefined;
            const prevSub = old.subStatusId ?? null;
            apiMoveTask(tk.id, tk.col, mondayRef.current, beforeTaskId, afterTaskId, {
              subStatusId: tk.subStatusId ?? null,
            }).catch((err) => {
              setTasks((ts) => ts.map((t) => (t.id === tk.id ? { ...t, subStatusId: prevSub } : t)));
              pushToast({ actor: sysActor, text: tr('toast.moveFailed', { message: (err as Error).message }), warn: true });
            });
          }
          // Persist a type flip triggered by drag between Groups column and a status column.
          if (old && !!old.isGroup !== !!tk.isGroup) {
            const patch: Partial<Task> = { isGroup: !!tk.isGroup };
            if (!tk.isGroup) patch.color = null;
            apiPatchTask(tk.id, patch, mondayRef.current).catch((err) => {
              pushToast({ actor: sysActor, text: tr('toast.typeChangeFailed', { message: (err as Error).message }), warn: true });
            });
          }
        }
        return next;
      });
    },
    [pushToast, sysActor, tr],
  );

  /**
   * Crée un groupe (tâche `isGroup` + couleur auto) et le persiste. Renvoie la
   * tâche réelle (id serveur) pour que l'appelant puisse y assigner une carte.
   * `apiCreateTask` ne porte pas la couleur → on la pousse en patch juste après.
   */
  const createGroup = useCallback(
    async (name: string): Promise<Task | null> => {
      const trimmed = name.trim();
      if (!trimmed || !projectIdRef.current) return null;
      const groupCount = tasks.filter((tk) => tk.isGroup).length;
      const color = GROUP_COLORS[groupCount % GROUP_COLORS.length].hex;
      try {
        const created = await apiCreateTask(projectIdRef.current, {
          title: trimmed,
          columnId: DATA_COLUMNS[0]?.id,
          priority: 'normal',
          monday: mondayRef.current,
          isGroup: true,
        });
        const colored: Task = { ...created, color };
        setTasks((ts) => [...ts, colored]);
        apiPatchTask(created.id, { color }, mondayRef.current).catch((err) => {
          pushToast({ actor: sysActor, text: tr('toast.saveFailed', { message: (err as Error).message }), warn: true });
        });
        return colored;
      } catch (err) {
        pushToast({ actor: sysActor, text: tr('toast.createFailed', { message: (err as Error).message }), warn: true });
        return null;
      }
    },
    [tasks, pushToast, sysActor, tr],
  );

  /**
   * Supprime un groupe : détache d'abord ses tâches enfants (`parentTaskId → null`,
   * persisté) pour ne pas laisser de référence pendante, puis supprime la tâche-groupe.
   */
  const deleteGroup = useCallback(
    (groupId: string) => {
      const children = tasks.filter((t) => t.parentTaskId === groupId);
      for (const c of children) updateTask(c.id, { parentTaskId: null });
      deleteTask(groupId);
    },
    [tasks, updateTask, deleteTask],
  );

  /**
   * Crée un label dans le projet courant (couleur auto via la palette), met à
   * jour le catalogue `data.ts` + bump `boardVersion` pour re-render, et renvoie
   * le label réel pour que l'appelant puisse l'ajouter à la tâche.
   */
  const createLabel = useCallback(
    async (name: string): Promise<{ id: string } | null> => {
      const pid = projectIdRef.current;
      const trimmed = name.trim();
      if (!pid || !trimmed) return null;
      try {
        const m = await import('./data');
        const count = Object.keys(m.labels).length;
        const color = GROUP_COLORS[count % GROUP_COLORS.length].hex;
        const created = await apiCreateLabel(pid, { name: trimmed, color });
        setVaksData({ labels: { ...m.labels, [created.id]: created } });
        setBoardVersion((v) => v + 1);
        return created;
      } catch (err) {
        pushToast({ actor: sysActor, text: tr('toast.createFailed', { message: (err as Error).message }), warn: true });
        return null;
      }
    },
    [pushToast, sysActor, tr],
  );

  /**
   * Déplace une tâche vers une colonne depuis TaskDetail (le dropdown de
   * statut), en persistant le statut via l'endpoint move (l'optimistic local
   * `col`/`progress` est déjà appliqué par `updateTask`). `completePredecessors`
   * autorise la clôture en cascade des prédécesseurs.
   */
  const moveTaskColumn = useCallback(
    (taskId: string, columnId: string, opts?: { completePredecessors?: boolean }) => {
      apiMoveTask(taskId, columnId, mondayRef.current, undefined, undefined, opts).catch(
        (err) => {
          const body =
            err instanceof ApiError
              ? (err.body as { code?: string; predecessors?: { id: string; title: string }[] })
              : null;
          if (body?.code === 'PREDECESSORS_NOT_DONE') {
            setPredBlock({ taskId, columnId, predecessors: body.predecessors ?? [] });
            return;
          }
          pushToast({ actor: sysActor, text: tr('toast.saveFailed', { message: (err as Error).message }), warn: true });
        },
      );
      // Passage en colonne On Hold via le dropdown du détail : proposer une raison.
      if (DATA_COLUMNS.find((c) => c.id === columnId)?.status === 'hold') {
        setHoldReasonTask(taskId);
      }
      setTimelineRefresh((n) => n + 1);
      setWorkloadRefresh((n) => n + 1);
    },
    [pushToast, sysActor, tr],
  );

  /**
   * Définit (ou efface) la limite WIP d'une colonne du board courant.
   * `wip = null` ⇒ aucune limite. Persiste via l'API (`project:update`), puis
   * met à jour le binding `data.ts` + bump `boardVersion` pour re-render.
   */
  const setColumnWip = useCallback(
    async (columnId: string, wip: number | null) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      try {
        await ApiClient.updateColumn(pid, columnId, { wipLimit: wip });
        const m = await import('./data');
        setVaksData({ columns: m.columns.map((c) => (c.id === columnId ? { ...c, wip } : c)) });
        setBoardVersion((v) => v + 1);
      } catch (err) {
        pushToast({ actor: sysActor, text: tr('toast.saveFailed', { message: (err as Error).message }), warn: true });
      }
    },
    [pushToast, sysActor, tr],
  );

  // ---- Realtime : patche le state local sur events WS du projet courant ----
  const realtime = useRealtime();
  useProjectEvents(currentProjectId ?? undefined, {
    'task.created': (payload) => {
      const dto = payload as unknown as TaskDto;
      const pkey = PROJECTS.find((p) => p.id === dto.projectId)?.key;
      const vtask = toVaksTask(dto, mondayRef.current, pkey);
      setTasks((ts) => (ts.some((t) => t.id === vtask.id) ? ts : [...ts, vtask]));
    },
    'task.updated': (payload) => {
      const dto = payload as unknown as TaskDto;
      const pkey = PROJECTS.find((p) => p.id === dto.projectId)?.key;
      const vtask = toVaksTask(dto, mondayRef.current, pkey);
      setTasks((ts) => ts.map((t) => (t.id === vtask.id ? { ...t, ...vtask } : t)));
    },
    'task.moved': (payload) => {
      const p = payload as { taskId: string; boardColumnId: string };
      setTasks((ts) => ts.map((t) => (t.id === p.taskId ? { ...t, col: p.boardColumnId } : t)));
    },
    'task.deleted': (payload) => {
      const p = payload as { taskId: string };
      setTasks((ts) => ts.filter((t) => t.id !== p.taskId));
    },
    'comment.created': (payload) => {
      const dto = payload as unknown as CommentDto;
      const v = toVaksComment(dto);
      setComments((cs) => {
        const list = cs[dto.taskId] || [];
        if (list.some((c) => c.id === v.id)) return cs;
        return { ...cs, [dto.taskId]: [...list, v] };
      });
      pushNotification({
        kind: 'comment',
        title: tr('realtime.newComment'),
        body: dto.body.slice(0, 120),
        taskId: dto.taskId,
        projectId: currentProjectId ?? undefined,
      });
    },
    'comment.deleted': (payload) => {
      const p = payload as { id: string };
      setComments((cs) => {
        const next: typeof cs = {};
        for (const [tid, list] of Object.entries(cs)) {
          next[tid] = list.filter((c) => c.id !== p.id);
        }
        return next;
      });
    },
    'time_entry.created': (payload) => {
      const dto = payload as unknown as TimeEntryDto;
      const v = toVaksTimeEntry(dto, mondayRef.current);
      setEntries((es) => {
        const list = es[dto.taskId] || [];
        if (list.some((e) => e.id === v.id)) return es;
        return { ...es, [dto.taskId]: [...list, v] };
      });
    },
    'time_entry.deleted': (payload) => {
      const p = payload as { id: string };
      setEntries((es) => {
        const next: typeof es = {};
        for (const [tid, list] of Object.entries(es)) {
          next[tid] = list.filter((e) => e.id !== p.id);
        }
        return next;
      });
    },
  });

  // Notifications personnelles (assignation, mention, changement de statut) —
  // canal `user:<id>`, reçu quel que soit le projet affiché. Alimente la cloche
  // en haut à droite. Le libellé est construit ici pour rester dans la langue de
  // l'UI (le serveur envoie des données structurées, pas du texte rendu).
  useUserNotifications((p) => {
    const title =
      p.kind === 'assignment'
        ? tr('realtime.assignedToYou')
        : p.kind === 'mention'
        ? tr('realtime.mentionedYou', { name: p.actorName ?? tr('realtime.someone') })
        : p.kind === 'status'
        ? tr('realtime.statusChangedTitle')
        : tr('realtime.newNotification');
    const body =
      p.kind === 'status'
        ? tr('realtime.statusChangedBody', {
            task: p.taskTitle ?? '',
            from: p.fromStatus ?? '',
            to: p.toStatus ?? '',
          })
        : p.kind === 'mention'
        ? p.excerpt ?? p.taskTitle
        : p.taskTitle;
    pushNotification({
      kind: p.kind === 'comment' ? 'comment' : p.kind,
      title,
      body,
      taskId: p.taskId,
      projectId: p.projectId,
    });
  });

  const localOpenTask = tasks.find((tk) => tk.id === openId) || null;
  // Tâche d'un autre projet (chargée à la demande) si elle n'est pas dans le
  // projet courant. `isForeignTask` pilote le bandeau d'avertissement.
  const openTask =
    localOpenTask ?? (foreignTask?.id === openId ? foreignTask : null);
  const isForeignTask = !localOpenTask && openTask != null;

  const filtered = useMemo(() => {
    if (!search.trim()) return tasks;
    const q = search.toLowerCase();
    return tasks.filter((tk) => tk.title.toLowerCase().includes(q) || (tk.key && tk.key.toLowerCase().includes(q)));
  }, [tasks, search]);

  const proj =
    (currentProjectId && projectsList.find((p) => p.id === currentProjectId)) ||
    projectsList[0] ||
    PROJECTS[0];
  const hasProject = !!proj;
  const projKey = proj?.key ?? '—';
  const projName = proj?.name ?? tr('shell.noProjectYet');
  const projColor = proj?.color ?? 250;

  const { user: authUser, logout } = useAuth();
  const orgName = useOrgName();
  const me: User | null = authUser
    ? {
        id: authUser.id,
        name: authUser.name,
        short: authUser.name.split(' ')[0] || authUser.name,
        initials: authUser.name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((p) => p[0]!.toUpperCase())
          .join(''),
        role: authUser.roleName || (authUser.isAdmin ? 'Admin' : ''),
        hue: hueFromId(authUser.id),
        online: true,
      }
    : null;

  // ---- Suivi du projet courant (watchers) ----
  // Suivre un projet = recevoir ce qui concerne TOUTES ses tâches (union
  // résolue côté serveur) ; c'est la forme la plus utile du suivi — un sponsor
  // ne va pas s'abonner tâche par tâche. Doit rester AVANT les early-returns
  // ci-dessous : ce sont des hooks.
  const [projWatching, setProjWatching] = useState(false);
  const [projWatchBusy, setProjWatchBusy] = useState(false);
  useEffect(() => {
    if (!currentProjectId || !authUser) {
      setProjWatching(false);
      return;
    }
    let alive = true;
    apiListProjectWatchers(currentProjectId)
      .then((ws) => {
        if (alive) setProjWatching(ws.some((w) => w.userId === authUser.id));
      })
      .catch(() => {
        /* best-effort : le suivi ne doit jamais casser la topbar */
      });
    return () => {
      alive = false;
    };
  }, [currentProjectId, authUser]);

  const toggleProjectWatch = async () => {
    if (!currentProjectId || projWatchBusy) return;
    setProjWatchBusy(true);
    const next = !projWatching;
    setProjWatching(next); // optimiste
    try {
      await (next ? apiWatchProject(currentProjectId) : apiUnwatchProject(currentProjectId));
      if (me) {
        pushToast({
          actor: me,
          text: next
            ? tr('watch.nowFollowing', { name: projName })
            : tr('watch.stopped', { name: projName }),
        });
      }
    } catch {
      setProjWatching(!next);
      if (me) pushToast({ actor: me, text: tr('watch.failed'), warn: true });
    } finally {
      setProjWatchBusy(false);
    }
  };

  // Loading / error states avant le rendu du shell.
  if (loading) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', opacity: 0.7 }}>
          <div style={{ fontSize: 14 }}>{tr('shell.loadingWorkspace')}</div>
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>{tr('shell.loadFailed')}</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>{loadError}</div>
        </div>
      </div>
    );
  }

  /** Groupe de navigation déroulant : un en-tête + des sous-entrées. En mode
   *  vertical (sidebar) = disclosure inline ; en horizontal (topbar) = popover.
   *  S'ouvre automatiquement quand une de ses entrées est active. */
  function NavGroup({
    icon,
    label,
    items,
    orientation,
  }: {
    icon: string;
    label: string;
    items: { id: string; label: string; icon: string }[];
    orientation: 'vertical' | 'horizontal';
  }) {
    const activeChild = items.some((i) => i.id === view);
    const [open, setOpen] = React.useState(activeChild);
    const wrapRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (activeChild) setOpen(true);
    }, [activeChild]);
    React.useEffect(() => {
      if (!open || orientation !== 'horizontal') return;
      const close = (e: PointerEvent) => {
        if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener('pointerdown', close, true);
      return () => document.removeEventListener('pointerdown', close, true);
    }, [open, orientation]);

    const childBtn = (it: { id: string; label: string; icon: string }) => (
      <button
        key={it.id}
        className={'nav-item' + (view === it.id ? ' nav-on' : '')}
        onClick={() => {
          setView(it.id);
          setDrawer(false);
          if (orientation === 'horizontal') setOpen(false);
        }}
      >
        <Icon name={it.icon} size={16} />
        <span className="nav-label">{it.label}</span>
      </button>
    );

    const header = (
      <button
        className={'nav-item' + (activeChild ? ' nav-on' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Icon name={icon} size={18} />
        <span className="nav-label">{label}</span>
        <Icon name={open ? 'chevDown' : 'chevR'} size={13} style={{ marginLeft: 'auto', opacity: 0.55 }} />
      </button>
    );

    if (orientation === 'horizontal') {
      return (
        <div ref={wrapRef} style={{ position: 'relative' }}>
          {header}
          {open && (
            <div
              style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 60, minWidth: 190,
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
                padding: 4, marginTop: 4, boxShadow: 'var(--shadow, 0 8px 24px rgba(0,0,0,.18))',
                display: 'flex', flexDirection: 'column',
              }}
            >
              {items.map(childBtn)}
            </div>
          )}
        </div>
      );
    }
    return (
      <>
        {header}
        {open && (
          <div style={{ marginLeft: 11, paddingLeft: 8, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
            {items.map(childBtn)}
          </div>
        )}
      </>
    );
  }

  function NavItems({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
    // « KPI project » regroupe Reports + Project finance (finance:view requis).
    const kpiItems = [
      { id: 'reports', label: tr('nav.reports'), icon: 'dash' },
      ...(canSeeFinance ? [{ id: 'finances', label: tr('nav.projectFinance'), icon: 'coins' }] : []),
    ];
    const flat = NAV.filter((n) => n.id !== 'members');
    const members = NAV.find((n) => n.id === 'members');
    const renderItem = (n: NavEntry) => (
      <button
        key={n.id}
        className={'nav-item' + (view === n.id ? ' nav-on' : '')}
        onClick={() => {
          setView(n.id);
          setDrawer(false);
        }}
      >
        <Icon name={n.icon} size={18} />
        <span className="nav-label">{tr(n.labelKey)}</span>
        {n.star && <span className="nav-badge">★</span>}
        {n.soon && orientation === 'vertical' && <span className="nav-soon mono">{n.soon}</span>}
      </button>
    );
    return (
      <nav className={'nav nav-' + orientation}>
        {flat.map(renderItem)}
        <NavGroup icon="dash" label={tr('nav.kpiProject')} items={kpiItems} orientation={orientation} />
        {members && renderItem(members)}
      </nav>
    );
  }

  /** Org-wide nav entries (Projects, Admin). Live under the "Workspace"
   *  section, not under the per-project section. Gated by role. */
  function WorkspaceNav() {
    return (
      <nav className="nav nav-vertical">
        <button
          className={'nav-item' + (view === 'mytasks' ? ' nav-on' : '')}
          onClick={() => {
            setView('mytasks');
            setDrawer(false);
          }}
        >
          <Icon name="dash" size={18} />
          <span className="nav-label">{tr('nav.dashboard')}</span>
        </button>
        <button
          className={'nav-item' + (view === 'team' ? ' nav-on' : '')}
          onClick={() => {
            setView('team');
            setDrawer(false);
          }}
        >
          <Icon name="users" size={18} />
          <span className="nav-label">{tr('nav.team')}</span>
        </button>
        <button
          className={'nav-item' + (view === 'agents' ? ' nav-on' : '')}
          onClick={() => {
            setView('agents');
            setDrawer(false);
          }}
        >
          <Icon name="zap" size={18} />
          <span className="nav-label">{tr('nav.agents', { defaultValue: 'AI Agents' })}</span>
        </button>
        <button
          className={'nav-item' + (view === 'teamreport' ? ' nav-on' : '')}
          onClick={() => {
            setView('teamreport');
            setDrawer(false);
          }}
        >
          <Icon name="gauge" size={18} />
          <span className="nav-label">{tr('nav.teamKpi')}</span>
        </button>
        {canSeeProjectsPanel && (
          <button
            className={'nav-item' + (view === 'projects' ? ' nav-on' : '')}
            onClick={() => {
              setView('projects');
              setDrawer(false);
            }}
          >
            <Icon name="board" size={18} />
            <span className="nav-label">{tr('nav.projects')}</span>
          </button>
        )}
        {canSeePortfolioPanel && (
          <button
            className={'nav-item' + (view === 'portfolio' ? ' nav-on' : '')}
            onClick={() => {
              setView('portfolio');
              setDrawer(false);
            }}
          >
            <Icon name="users" size={18} />
            <span className="nav-label">{tr('nav.portfolio')}</span>
          </button>
        )}
        {canSeeFinance && (
          <NavGroup
            icon="dash"
            label={tr('nav.globalKpi')}
            orientation="vertical"
            items={[
              { id: 'finance', label: tr('nav.globalFinance'), icon: 'coins' },
              { id: 'portfoliokpi', label: tr('nav.globalProjectKpi'), icon: 'gauge' },
            ]}
          />
        )}
        {(isAdmin || canAgentAdmin) && (
          <button
            className={'nav-item' + (view === 'admin' ? ' nav-on' : '')}
            onClick={() => {
              setView('admin');
              setDrawer(false);
            }}
          >
            <Icon name="settings" size={18} />
            <span className="nav-label">{isAdmin ? tr('nav.admin') : tr('nav.agentAdmin')}</span>
          </button>
        )}
      </nav>
    );
  }

  const sidebar = t.navLayout === 'sidebar';

  // ===== Frontière de siège de licence =====
  // Un compte sans siège (`licensed === false`) n'a pas accès au dashboard.
  //  • admin-only (isAdmin) → portail admin verrouillé, pas de retour dashboard.
  //  • parqué (non-admin) → écran « aucun siège » + déconnexion.
  // `licensed === false` strictement : `undefined` (legacy) reste autorisé.
  const noSeat = !!authUser && authUser.licensed === false;
  if (noSeat && isAdmin) {
    return (
      <Suspense fallback={<ViewFallback />}>
        <AdminPanel onExit={logout} lockedNoSeat />
      </Suspense>
    );
  }
  if (noSeat) {
    return <NoSeatScreen onLogout={logout} email={authUser?.email ?? ''} />;
  }

  // Admin panel takes over the whole viewport (own sidebar/main).
  // Un « AI administrator » non-admin y entre en mode restreint (sections agents
  // seulement) — le filtrage vit dans AdminPanel via `agentAdminOnly`.
  if (view === 'admin' && (isAdmin || canAgentAdmin)) {
    return (
      <Suspense fallback={<ViewFallback />}>
        <AdminPanel onExit={() => setView('board')} agentAdminOnly={!isAdmin} />
      </Suspense>
    );
  }

  return (
    <div className={'app' + (sidebar ? ' app-sidebar' : ' app-top')}>
      {/* ===== Sidebar ===== */}
      {sidebar && (
        <aside className={'sidebar' + (drawer ? ' sidebar-open' : '')}>
          <div className="brand">
            <div className="brand-mark">
              <BrandMark />
            </div>
            <div className="brand-name">{orgName}</div>
            <button className="drawer-x" onClick={() => setDrawer(false)} aria-label={tr('closeMenu')}>
              <Icon name="x" size={18} />
            </button>
          </div>

          <div className="proj-switch-wrap" ref={projSwitchRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className="proj-switch"
              onClick={() => {
                if (projectsList.length === 0) return;
                const next = !projMenuOpen;
                setProjMenuOpen(next);
                if (next) {
                  setProjSearch('');
                  setTimeout(() => projSearchRef.current?.focus(), 50);
                }
              }}
              aria-haspopup="listbox"
              aria-expanded={projMenuOpen}
              style={{ width: '100%', textAlign: 'left', cursor: projectsList.length > 0 ? 'pointer' : 'default' }}
            >
              <div className="proj-key mono" style={{ background: `oklch(0.55 0.15 ${projColor})` }}>
                {projKey}
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="proj-name truncate">{projName}</div>
                <div className="proj-meta">
                  {hasProject ? tr('shell.taskCount', { count: tasks.length }) : tr('shell.createFirstProject')}
                </div>
              </div>
              <Icon name="chevDown" size={16} style={{ color: 'var(--text-3)' }} />
            </button>
            {projMenuOpen && projectsList.length > 0 && (() => {
              const q = projSearch.toLowerCase().trim();
              const filtered = q
                ? projectsList.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
                : projectsList;
              return (
                <div className="dd-menu" style={{ left: 0, right: 0, top: 'calc(100% + 4px)', minWidth: 220 }} role="listbox">
                  <div style={{ padding: '6px 8px 4px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface-3)', borderRadius: 6, padding: '4px 8px' }}>
                      <Icon name="search" size={13} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                      <input
                        ref={projSearchRef}
                        type="text"
                        value={projSearch}
                        onChange={(e) => setProjSearch(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Escape') { setProjMenuOpen(false); setProjSearch(''); } }}
                        placeholder={tr('shell.searchProjects')}
                        style={{ border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12.5, width: '100%', fontFamily: 'inherit' }}
                      />
                      {projSearch && (
                        <button type="button" onClick={() => setProjSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, lineHeight: 1 }}>
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {filtered.length === 0 ? (
                      <div style={{ padding: '10px 14px', fontSize: 12.5, color: 'var(--text-3)', textAlign: 'center' }}>{tr('shell.noProjectsFound')}</div>
                    ) : filtered.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="dd-item"
                        role="option"
                        aria-selected={p.id === currentProjectId}
                        onClick={() => { switchProject(p.id); setProjSearch(''); }}
                        style={{ width: '100%' }}
                      >
                        <div
                          className="proj-key mono"
                          style={{ background: `oklch(0.55 0.15 ${p.color})`, fontSize: 11, padding: '2px 6px' }}
                        >
                          {p.key}
                        </div>
                        <span className="truncate" style={{ flex: 1 }}>{p.name}</span>
                        {p.id === currentProjectId && <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          <button className="btn btn-accent btn-block" onClick={() => setView('board')}>
            <Icon name="plus" size={17} /> {tr('shell.newTask')}
          </button>

          <div className="nav-section">{tr('section.project')}</div>
          <NavItems orientation="vertical" />

          <div className="nav-section">{tr('section.workspace')}</div>
          <WorkspaceNav />

          <div className="sidebar-foot">
            {me ? (
              <>
                <Avatar user={me} size={30} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>{me.name}</div>
                  <div className="truncate" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{me.role}</div>
                </div>
              </>
            ) : (
              <div className="grow" style={{ minWidth: 0, fontSize: 12, color: 'var(--text-3)' }}>
                {tr('shell.signedIn')}
              </div>
            )}
            <button
              className="icon-btn"
              onClick={() => setSecurityOpen(true)}
              title={tr('shell.accountSecurity')}
              aria-label={tr('shell.accountSecurity')}
            >
              <Icon name="settings" size={18} />
            </button>
            <button
              className="icon-btn"
              onClick={logout}
              title={tr('shell.signOut')}
              aria-label={tr('shell.signOut')}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </aside>
      )}
      {drawer && sidebar && <div className="scrim" onClick={() => setDrawer(false)} />}

      {/* ===== Main ===== */}
      <div className="main">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setDrawer(true)} aria-label={tr('menu')}>
            <Icon name="list" size={20} />
          </button>

          {!sidebar && (
            <div className="brand brand-top">
              <div className="brand-mark">
                <BrandMark />
              </div>
              <div className="brand-name">{orgName}</div>
            </div>
          )}

          <div className="crumb">
            <span className="crumb-key mono" style={{ color: `oklch(0.6 0.15 ${projColor})` }}>
              {projKey}
            </span>
            <span className="crumb-name truncate">{projName}</span>
            {/* Suivre le projet = suivre toutes ses tâches (résolution par union
                côté serveur). Masqué hors contexte projet (vues transverses). */}
            {currentProjectId && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={toggleProjectWatch}
                disabled={projWatchBusy}
                title={projWatching ? tr('watch.unwatchProject') : tr('watch.watchProject')}
                aria-label={projWatching ? tr('watch.unwatchProject') : tr('watch.watchProject')}
                aria-pressed={projWatching}
                style={
                  projWatching
                    ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
                    : undefined
                }
              >
                <Icon name="eye" size={15} />
                <span className="only-wide">
                  {projWatching ? tr('watch.followingProjectBtn') : tr('watch.followProjectBtn')}
                </span>
              </button>
            )}
          </div>

          {!sidebar && <NavItems orientation="horizontal" />}

          <div className="grow" />

          <div className="searchbox">
            <Icon name="search" size={16} style={{ color: 'var(--text-3)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={view === 'projects' ? tr('shell.searchProjects') : tr('shell.searchTasks')}
            />
          </div>

          <button
            className={'live-btn' + (realtime.mode === 'live' ? ' live-on' : '')}
            onClick={() => setMode(getMode() === 'live' ? 'paused' : 'live')}
            title={
              realtime.mode === 'live'
                ? tr('live.tooltipLive')
                : tr('live.tooltipPaused', { count: realtime.buffered.length })
            }
          >
            <span className="live-dot" />{' '}
            <span className="only-wide">{realtime.mode === 'live' ? tr('live.live') : tr('live.paused')}</span>
            {realtime.mode === 'paused' && realtime.buffered.length > 0 && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'var(--accent)',
                  color: '#fff',
                  minWidth: 16,
                  textAlign: 'center',
                }}
              >
                {realtime.buffered.length}
              </span>
            )}
          </button>

          {DEMO && (
            <div className="row gap2" style={{ alignItems: 'center' }}>
              <span
                title={tr('shell.demoBadgeTitle')}
                style={{
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: '.06em',
                  padding: '3px 8px',
                  borderRadius: 999,
                  color: 'var(--warn, #92610a)',
                  background: 'var(--warn-soft, #fdf1d6)',
                  border: '1px solid var(--warn-line, #f0d38a)',
                }}
              >
                {tr('shell.demoBadge')}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                title={tr('shell.demoResetTitle')}
                onClick={async () => {
                  if (!window.confirm(tr('shell.demoResetConfirm'))) return;
                  const { resetDemo } = await import('../demo/store');
                  resetDemo();
                  window.location.reload();
                }}
              >
                <Icon name="refresh" size={15} />
                <span className="only-wide">{tr('shell.demoReset')}</span>
              </button>
            </div>
          )}

          <LanguageSwitcher className="lang-switcher" />
          <button
            className="icon-btn"
            onClick={() => setTweak('theme', t.theme === 'dark' ? 'light' : 'dark')}
            aria-label={tr('shell.toggleTheme')}
          >
            <Icon name={t.theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          <NotificationsPanel
            onOpen={(n) => {
              const pid = n.projectId ?? currentProjectId;
              if (n.taskId && pid) void openSearchTask(pid, n.taskId);
            }}
          />
        </header>

        {/* view title bar for workload scope */}
        {view === 'workload' && (
          <div className="subbar">
            <div className="row gap2">
              <h1 className="view-h1">{tr('workload.title')}</h1>
              <span className="view-sub">{tr('workload.subtitle')}</span>
            </div>
            <TeamScopePicker value={scope} onChange={setScope} />
          </div>
        )}

        <main className="content">
         <Suspense fallback={<ViewFallback />}>
          {view === 'team' && <TeamView />}
          {view === 'agents' && <AgentsWorkspaceView />}
          {view === 'projects' && canSeeProjectsPanel && (
            <ProjectsPanel
              search={search}
              pushToast={(text, warn) =>
                pushToast({
                  actor: { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true },
                  text,
                  warn,
                })
              }
              onOpenProject={(pid) => {
                switchProject(pid);
                setView('board');
              }}
            />
          )}
          {view === 'portfolio' && canSeePortfolioPanel && (
            <PortfolioPanel
              pushToast={(text, warn) =>
                pushToast({
                  actor: { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true },
                  text,
                  warn,
                })
              }
            />
          )}
          {view === 'finance' && canSeeFinance && (
            <FinancePanel
              onOpenProjectFinance={(pid) => {
                switchProject(pid);
                setView('finances');
              }}
            />
          )}
          {view === 'teamreport' && <TeamReportView />}
          {view === 'portfoliokpi' && canSeeFinance && <PortfolioKpiView />}
          {view !== 'projects' && view !== 'portfolio' && view !== 'finance' && view !== 'portfoliokpi' && view !== 'teamreport' && view !== 'team' && view !== 'admin' && view !== 'timesheet' && view !== 'mytasks' && !hasProject && (
            <div className="placeholder">
              <div className="ph-icon">
                <Icon name="board" size={30} />
              </div>
              <div className="ph-phase mono">{tr('empty.phase')}</div>
              <h2 className="ph-title">{tr('empty.title')}</h2>
              <p className="ph-sub">{tr('empty.body')}</p>
              <ul className="ph-list">
                <li><Icon name="check" size={15} /> {tr('empty.step1')}</li>
                <li><Icon name="check" size={15} /> {tr('empty.step2')}</li>
                <li><Icon name="check" size={15} /> {tr('empty.step3')}</li>
              </ul>
            </div>
          )}
          {hasProject && view === 'board' && (
            <KanbanView
              tasks={filtered}
              setTasks={setTasksSync}
              monday={mondayRef.current}
              density={t.density}
              showLabels={t.showLabels}
              live={t.live}
              pushToast={pushToast}
              onOpen={setOpenId}
              onDelete={deleteTask}
              canEditBoard={canEditBoard}
              onSetWip={setColumnWip}
              onAssignGroup={(taskId, groupId) => updateTask(taskId, { parentTaskId: groupId })}
              onCreateGroup={createGroup}
              onDeleteGroup={deleteGroup}
              boardVersion={boardVersion}
              subStatuses={subStatuses}
            />
          )}
          {hasProject && view === 'list' && <ListView tasks={filtered} monday={mondayRef.current} density={t.density} onOpen={setOpenId} />}
          {hasProject && view === 'documents' && projectIdRef.current && (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div className="subbar" style={{ borderBottom: 'none' }}>
                <div className="row gap2">
                  <h1 className="view-h1">{tr('nav.documents')}</h1>
                  <span className="view-sub">{tr('nav.documentsSub')}</span>
                </div>
              </div>
              <div style={{ padding: '0 20px 20px' }}>
                <ProjectDocumentsView
                  projectId={projectIdRef.current}
                  pushToast={(text, warn) => pushToast({ actor: sysActor, text, warn })}
                />
              </div>
            </div>
          )}
          {hasProject && view === 'workload' && (
            <WorkloadView
              monday={mondayRef.current}
              viz={t.wlViz}
              scope={scope}
              teamId={scope === 'all' ? undefined : scope}
              projectId={projectIdRef.current ?? undefined}
              projectStatus={proj?.status}
              pushToast={pushToast}
              onOpen={setOpenId}
              refreshKey={workloadRefresh}
            />
          )}
          {hasProject && view === 'reports' && projectIdRef.current && (
            <ReportsView projectId={projectIdRef.current} monday={mondayRef.current} onOpenTask={setOpenId} />
          )}
          {hasProject && view === 'finances' && projectIdRef.current && canSeeFinance && (
            <FinancesView
              projectId={projectIdRef.current}
              pushToast={(text, warn) =>
                pushToast({
                  actor: { id: '', name: 'System', short: 'Sys', initials: 'S', role: '', hue: 0, online: true },
                  text,
                  warn,
                })
              }
            />
          )}
          {hasProject && view === 'timeline' && projectIdRef.current && (
            <TimelineView
              projectId={projectIdRef.current}
              onOpen={setOpenId}
              refreshKey={timelineRefresh}
            />
          )}
          {hasProject && view === 'pert' && projectIdRef.current && (
            <PertView
              projectId={projectIdRef.current}
              onOpen={setOpenId}
              refreshKey={timelineRefresh}
            />
          )}
          {hasProject && view === 'members' && projectIdRef.current && (
            <MembersView projectId={projectIdRef.current} projectName={projName} />
          )}
          {view === 'timesheet' && (
            <TimesheetView monday={mondayRef.current} />
          )}
          {view === 'mytasks' && <DashboardView onOpen={setOpenId} />}
         </Suspense>
        </main>
      </div>

      <Toasts items={toasts} dismiss={dismiss} />

      <Suspense fallback={null}>
      {openTask && (
        <TaskDetail
          task={openTask}
          monday={mondayRef.current}
          // Tâche d'un autre projet : on passe son propre projectId (pour les
          // dépendances / skills) plutôt que celui du projet courant.
          projectId={
            isForeignTask
              ? openTask.projectId ?? undefined
              : projectIdRef.current ?? undefined
          }
          foreign={isForeignTask}
          comments={comments[openTask.id] || []}
          entries={entries[openTask.id] || []}
          allTasks={isForeignTask ? [openTask] : tasks}
          onClose={() => {
            setOpenId(null);
            setTimelineRefresh((n) => n + 1);
            setWorkloadRefresh((n) => n + 1);
          }}
          onUpdate={(patch) => {
            updateTask(openTask.id, patch);
            // Le store `tasks` ne contient pas la tâche étrangère : on applique
            // l'optimistic update directement sur `foreignTask`.
            if (isForeignTask)
              setForeignTask((ft) =>
                ft && ft.id === openTask.id ? { ...ft, ...patch } : ft,
              );
          }}
          onUpdateOther={(id, patch) => updateTask(id, patch)}
          onMoveColumn={(columnId, opts) => moveTaskColumn(openTask.id, columnId, opts)}
          subStatuses={isForeignTask ? [] : subStatuses}
          onAddComment={(body) => addComment(openTask.id, body)}
          onAddTime={(entry) => addTime(openTask.id, entry)}
          onToggleCheck={(itemId) => toggleCheck(openTask.id, itemId)}
          onDelete={() => deleteTask(openTask.id)}
          pushToast={pushToast}
          onCreateLabel={createLabel}
        />
      )}
      {predBlock && (
        <PredecessorBlockModal
          predecessors={predBlock.predecessors}
          onCancel={() => setPredBlock(null)}
          onConfirm={() => {
            const b = predBlock;
            setPredBlock(null);
            // Rejoue le déplacement vers Done en demandant la clôture en
            // cascade des prédécesseurs ; réapplique l'optimistic local.
            setTasks((ts) =>
              ts.map((t) => (t.id === b.taskId ? { ...t, col: b.columnId, progress: 100 } : t)),
            );
            apiMoveTask(
              b.taskId,
              b.columnId,
              mondayRef.current,
              b.beforeTaskId,
              b.afterTaskId,
              { completePredecessors: true },
            ).catch((err) => {
              pushToast({ actor: sysActor, text: 'Move failed: ' + (err as Error).message, warn: true });
            });
          }}
        />
      )}
      {holdReasonTask && (
        <HoldReasonModal
          initial={tasks.find((t) => t.id === holdReasonTask)?.holdReason ?? ''}
          onClose={() => setHoldReasonTask(null)}
          onSubmit={(reason) => {
            const id = holdReasonTask;
            setHoldReasonTask(null);
            // Optimistic local + persistance (statusReason → holdReason côté API).
            setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, holdReason: reason || null } : t)));
            apiPatchTask(id, { holdReason: reason || null }, mondayRef.current).catch((err) => {
              pushToast({ actor: sysActor, text: tr('toast.saveFailed', { message: (err as Error).message }), warn: true });
            });
          }}
        />
      )}
      {securityOpen && <SecuritySettings onClose={() => setSecurityOpen(false)} />}
      </Suspense>
      {DEMO && demoWelcomeOpen && (
        <div className="md-overlay" onMouseDown={dismissDemoWelcome}>
          <div
            className="md-card"
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ width: 'min(480px, 100%)' }}
          >
            <div className="md-head">
              <Icon name="warn" size={22} style={{ color: 'var(--warn, #92610a)', flexShrink: 0 }} />
              <div className="grow">
                <div className="md-eyebrow mono">{tr('shell.demoWelcomeEyebrow')}</div>
                <div className="md-title">{tr('shell.demoWelcomeTitle')}</div>
              </div>
              <button className="icon-btn" onClick={dismissDemoWelcome} aria-label={tr('close')}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="md-body">
              <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('shell.demoWelcomeBody')}</p>
            </div>
            <div className="md-foot">
              <a
                className="btn btn-ghost btn-sm"
                href="/demo-request.html"
                target="_top"
                rel="noopener noreferrer"
              >
                {tr('shell.demoWelcomeCta')}
              </a>
              <button className="btn btn-primary btn-sm" onClick={dismissDemoWelcome}>
                {tr('shell.demoWelcomeDismiss')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Forced password change: blocks the whole app until the user updates
          their password (admin reset or expiry). Non-dismissible. */}
      {authUser?.mustChangePassword && (
        <ChangePasswordDialog mode="forced" onClose={() => { /* refreshUser inside */ }} />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onSelectProject={(pid) => switchProject(pid)}
          onSelectTask={openSearchTask}
        />
      )}
    </div>
  );
}
