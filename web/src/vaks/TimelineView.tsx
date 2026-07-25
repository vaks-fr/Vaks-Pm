/* ============================================================
   Vaks — Timeline / Gantt view
   Frozen-pane date grid · weekend + bank-holiday highlighting
   · status-grouped rows · status-hued task bars with progress
   · assignee avatar + title inside bars · drag bar to reschedule
   · milestone lane · dependency arrows · critical path highlight
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DependencyDto,
  GanttDto,
  GanttTaskDto,
  TaskAssigneeDto,
} from '@vaks-pm/shared';
import { DependencyType, TaskStatus } from '@vaks-pm/shared';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useFormat } from '../lib/format';
import { Avatar, Icon } from './primitives';
import { useConfirm } from './confirm';
import { useIsMobile } from './useIsMobile';
import type { User } from './data';
/* Les fériés viennent désormais de l'API (pays par défaut org + override par
 * assignee selon User.countryCode). Plus de liste statique côté front. */

interface Props {
  projectId: string;
  onOpen: (id: string) => void;
  /** Bump from parent to force a re-fetch (e.g. after closing TaskDetail). */
  refreshKey?: number;
}

type Mode = 'global' | 'grouped';
/** En mode "Personnalisé" on garde un min lisible, on scrolle au-delà. */
type ViewMode = 'custom' | 'week' | 'month';
const DAY_W_MIN = 34;
/** Nombre de jours visibles à l'écran d'un coup en mode Personnalisé. */
const VISIBLE_DAYS = 30;
/** Durée par défaut de la fenêtre d'affichage (en jours). */
const DEFAULT_RANGE_DAYS = 60;

const LABEL_W = 260;
const HEAD_H = 56;
const GROUP_H = 32;
const MILE_H = 42;
const ROW_H = 38;
const BAR_H = 24;

const STATUS_HUE: Record<TaskStatus, number> = {
  [TaskStatus.TODO]: 250,
  [TaskStatus.CLAIMED]: 250,
  [TaskStatus.IN_PROGRESS]: 240,
  [TaskStatus.CHANGES_REQUESTED]: 240,
  [TaskStatus.IN_REVIEW]: 90,
  [TaskStatus.APPROVED]: 90,
  [TaskStatus.ON_HOLD]: 300,
  [TaskStatus.DONE]: 150,
};

const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

function parseDay(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((+b - +a) / 86_400_000);
}
// fmtShort / fmtMonth ont migré vers `useFormat()` (lib/format.ts) — la
// locale est désormais consommée depuis les settings org au lieu d'être
// codée en dur en fr-FR.
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function todayUtcDate(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** Convertit une date UTC vers le format `yyyy-Www` attendu par <input type="week"> (ISO 8601). */
function toIsoWeekString(d: Date): string {
  // Algorithme ISO 8601 : la semaine 1 contient le jeudi de la première semaine
  // contenant un jeudi de l'année.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Décale vers le jeudi de la semaine en cours.
  const dayNum = tmp.getUTCDay() || 7; // dimanche = 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((+tmp - +yearStart) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Inverse de `toIsoWeekString` : renvoie le lundi UTC de la semaine ISO. */
function fromIsoWeekString(s: string): Date | null {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(s);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  // Lundi de la semaine 1 : 4 janvier - décalage du jour de la semaine.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return target;
}

/** Convertit une date UTC vers `yyyy-MM` pour <input type="month">. */
function toMonthString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function fromMonthString(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1));
}

/** Build an Avatar-compatible User from a task assignee. */
function assigneeUser(a: TaskAssigneeDto): User {
  const parts = a.name.trim().split(/\s+/).filter(Boolean);
  const initials = (
    parts.length >= 2
      ? parts[0][0] + parts[parts.length - 1][0]
      : (parts[0]?.slice(0, 2) ?? '?')
  ).toUpperCase();
  // Hash sur l'*id utilisateur* (pas le nom) — même formule que `hueFromId`
  // de api.ts/AdminPanel pour une couleur d'avatar identique partout.
  let h = 0;
  for (let i = 0; i < a.userId.length; i++) {
    h = ((h * 31) + a.userId.charCodeAt(i)) | 0;
  }
  return {
    id: a.userId,
    name: a.name,
    short: a.name.split(/\s+/)[0] ?? a.name,
    role: '',
    initials,
    hue: ((h % 360) + 360) % 360,
    online: false,
  };
}

export function TimelineView({ projectId, onOpen, refreshKey = 0 }: Props) {
  const { t: tr } = useTranslation('timeline');
  const confirm = useConfirm();
  const t = tr;
  const { orgSettings } = useAuth();
  const fmt = useFormat();
  const fmtShort = (d: Date) => fmt.dayMonth(d);
  const fmtMonth = (d: Date) => fmt.monthShort(d);
  const weekStart = orgSettings.weekStart;
  // Bascule vers une liste verticale d'échéancier sur téléphone (le Gantt SVG
  // horizontal est inutilisable en portrait).
  const isMobile = useIsMobile();
  const [data, setData] = useState<GanttDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('grouped');

  // Mode d'affichage du calendrier :
  //  - 'custom' : pickers Du/Au, viewport 30 jours visibles, scroll horizontal
  //  - 'week'   : 7 jours autour d'une ancre, remplit exactement la largeur
  //  - 'month'  : mois complet de l'ancre, remplit exactement la largeur
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem('vaks.timeline.viewMode') : null;
    return v === 'week' || v === 'month' || v === 'custom' ? (v as ViewMode) : 'custom';
  });
  useEffect(() => {
    try { window.localStorage.setItem('vaks.timeline.viewMode', viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  const [showCritical, setShowCritical] = useState<boolean>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem('vaks.timeline.showCritical') : null;
    return v === null ? true : v === '1';
  });
  useEffect(() => {
    try { window.localStorage.setItem('vaks.timeline.showCritical', showCritical ? '1' : '0'); } catch { /* ignore */ }
  }, [showCritical]);

  // Fenêtre d'affichage : [from, to] en UTC. Initialisée à aujourd'hui + 60j,
  // persistée en localStorage pour retrouver l'état après reload.
  const [from, setFrom] = useState<Date>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem('vaks.timeline.from') : null;
    if (v) {
      const d = new Date(v);
      if (!isNaN(+d)) return d;
    }
    return todayUtcDate();
  });
  const [to, setTo] = useState<Date>(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem('vaks.timeline.to') : null;
    if (v) {
      const d = new Date(v);
      if (!isNaN(+d)) return d;
    }
    const d = todayUtcDate();
    d.setUTCDate(d.getUTCDate() + DEFAULT_RANGE_DAYS - 1);
    return d;
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Callback-ref pour mesurer `.gantt-scroll` dès qu'il s'attache au DOM.
  // (un useEffect([]) classique ne suffit pas : il s'exécute pendant l'écran
  // "Chargement…" où le div n'existe pas encore, donc l'observer ne se branche
  // jamais après que `data` arrive.)
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [containerW, setContainerW] = useState<number>(1200);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    scrollRef.current = el;
    if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(() => {
      setContainerW(el.clientWidth);
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // Map ISO yyyy-mm-dd → libellé, pour fériés org-default. S'applique en fond
  // sur toute la colonne (concerne tout le monde par défaut).
  const [orgHolidays, setOrgHolidays] = useState<Map<string, string>>(new Map());
  /** Conflit de dépendance détecté : la nouvelle date viole une contrainte
   *  par rapport à une tâche prédécesseur. */
  interface DependencyConflict {
    predTitle: string;
    predEnd: string; // YYYY-MM-DD
    minStart: string; // borne minimale calculée (pred.end + lagDays)
    lagDays: number;
    type: 'FS'; // pour l'instant on ne signale que les FS (cas le plus courant)
  }
  /** Info gap : la tâche commence plus tard que ce qui serait optimal vis-à-vis
   *  de sa dépendance FS. Pas une violation, juste un avertissement informatif. */
  interface DependencyGap {
    predTitle: string;
    predEnd: string;
    minStart: string;
    lagDays: number;
    gapDays: number;
  }
  /** Déplacement en attente de confirmation après drag-drop d'une barre. */
  const [pendingMove, setPendingMove] = useState<{
    taskId: string;
    taskTitle: string;
    oldStart: string;
    oldEnd: string;
    newStart: string;
    newEnd: string;
    dayDelta: number;
    conflicts: DependencyConflict[];
    gaps: DependencyGap[];
  } | null>(null);
  /** Map userId → (date → name) pour les assignees dont countryCode ≠ défaut org. */
  const [userHolidays, setUserHolidays] = useState<Map<string, Map<string, string>>>(new Map());

  useEffect(() => {
    try { window.localStorage.setItem('vaks.timeline.from', from.toISOString()); } catch { /* ignore */ }
  }, [from]);
  useEffect(() => {
    try { window.localStorage.setItem('vaks.timeline.to', to.toISOString()); } catch { /* ignore */ }
  }, [to]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .getGantt(projectId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTick, refreshKey]);

  const reload = () => setRefreshTick((t) => t + 1);

  // Chargement des fériés couvrant la fenêtre :
  //  - 1 fetch pour le pays par défaut de l'org (background des colonnes)
  //  - 1 fetch par countryCode distinct trouvé chez les assignees du projet,
  //    quand ce countryCode diffère du défaut org (tint sur la ligne du user).
  useEffect(() => {
    let cancelled = false;
    // On recalcule la plage à fetcher en fonction du mode pour éviter la
    // dépendance circulaire avec `view` (déclarée plus bas).
    let fStart: Date, fEnd: Date;
    if (viewMode === 'week') {
      const a = new Date(from);
      // Snape sur le début de la semaine selon weekStart (Mon ou Sun).
      const diff = weekStart === 'sunday' ? a.getUTCDay() : (a.getUTCDay() + 6) % 7;
      fStart = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() - diff));
      fEnd = addDays(fStart, 6);
    } else if (viewMode === 'month') {
      fStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
      fEnd = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
    } else {
      fStart = from;
      fEnd = to;
    }
    const fromIso = isoDay(fStart);
    const toIso = isoDay(fEnd);
    api
      .getDefaultHolidayCountry()
      .then(({ country }) =>
        api.previewHolidays({ country, from: fromIso, to: toIso }).then((r) => ({ defCountry: country, list: r.holidays })),
      )
      .then(async ({ defCountry, list }) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const h of list) m.set(h.date, h.name);
        setOrgHolidays(m);

        // Récupère les pays distincts ≠ défaut chez les assignees.
        const userCountries = new Map<string, string>(); // userId → country
        if (data) {
          for (const t of data.tasks) {
            for (const a of t.assignees || []) {
              const cc = (a.countryCode || '').toUpperCase();
              if (cc && cc !== defCountry.toUpperCase() && !userCountries.has(a.userId)) {
                userCountries.set(a.userId, cc);
              }
            }
          }
        }
        const uniqueCountries = Array.from(new Set(userCountries.values()));
        const byCountry = new Map<string, Map<string, string>>();
        await Promise.all(
          uniqueCountries.map((cc) =>
            api.previewHolidays({ country: cc, from: fromIso, to: toIso }).then((r) => {
              const m2 = new Map<string, string>();
              for (const h of r.holidays) m2.set(h.date, h.name);
              byCountry.set(cc, m2);
            }).catch(() => { /* ignore */ }),
          ),
        );
        if (cancelled) return;
        const userMap = new Map<string, Map<string, string>>();
        for (const [uid, cc] of userCountries) {
          const days = byCountry.get(cc);
          if (days) userMap.set(uid, days);
        }
        setUserHolidays(userMap);
      })
      .catch(() => {
        if (cancelled) return;
        setOrgHolidays(new Map());
        setUserHolidays(new Map());
      });
    return () => { cancelled = true; };
  }, [viewMode, from, to, data, weekStart]);

  // Dérive la fenêtre effective + dayW selon le mode.
  //  - 'week'  : 7 jours, lundi UTC ≤ `from` → `lundi+6`, dayW = avail/7
  //  - 'month' : mois UTC contenant `from`, dayW = avail/N
  //  - 'custom': from/to tel quel, dayW = avail/VISIBLE_DAYS (scroll possible)
  const avail = Math.max(600, containerW - LABEL_W - 4);
  const view = useMemo(() => {
    if (viewMode === 'week') {
      const a = new Date(from);
      const diff = weekStart === 'sunday' ? a.getUTCDay() : (a.getUTCDay() + 6) % 7;
      const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() - diff));
      const end = addDays(start, 6);
      return {
        from: start,
        to: end,
        totalDays: 7,
        dayW: Math.floor(avail / 7),
        label: fmt.range(start, end),
      };
    }
    if (viewMode === 'month') {
      const y = from.getUTCFullYear();
      const m = from.getUTCMonth();
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      const totalDays = daysBetween(start, end) + 1;
      return {
        from: start,
        to: end,
        totalDays,
        dayW: Math.floor(avail / totalDays),
        label: fmt.monthYear(start),
      };
    }
    let start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    let end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
    if (end.getTime() < start.getTime()) { const tmp = start; start = end; end = tmp; }
    const totalDays = daysBetween(start, end) + 1;
    return {
      from: start, to: end, totalDays,
      dayW: Math.max(DAY_W_MIN, Math.floor(avail / VISIBLE_DAYS)),
      label: null,
    };
  }, [viewMode, from, to, avail, weekStart, fmt]);
  const dayW = view.dayW;

  const layout = useMemo(() => {
    if (!data || data.tasks.length === 0) return null;
    const epoch = view.from;
    const end = view.to;
    const totalDays = view.totalDays;

    const sortByStart = (a: GanttTaskDto, b: GanttTaskDto) =>
      +parseDay(a.scheduledStart) - +parseDay(b.scheduledStart);

    // Filtre : on garde uniquement les tâches qui chevauchent la fenêtre.
    // Un groupe est conservé si lui ou au moins un de ses enfants chevauche.
    const overlaps = (t: GanttTaskDto) => {
      const s = +parseDay(t.scheduledStart);
      const e = +parseDay(t.scheduledEnd);
      return s <= +end && e >= +epoch;
    };
    const visibleTasks = data.tasks.filter(overlaps);
    const visibleSet = new Set(visibleTasks.map((t) => t.id));
    // Promote groups whose children are visible even if the group bar itself
    // sits outside the window.
    for (const t of data.tasks) {
      if (!visibleSet.has(t.id) && t.parentTaskId && visibleSet.has(t.parentTaskId)) {
        visibleSet.add(t.id);
      }
      if (!visibleSet.has(t.id) && t.isGroup) {
        // Inclure le groupe si au moins un enfant est visible.
        const hasVisChild = data.tasks.some((c) => c.parentTaskId === t.id && visibleSet.has(c.id));
        if (hasVisChild) visibleSet.add(t.id);
      }
    }
    const filteredTasks = data.tasks.filter((t) => visibleSet.has(t.id));

    // Grouped mode: tasks with isGroup=true become section headers, their
    // children (parentTaskId === group.id) render under them, the rest fall
    // into a "Sans groupe" section. Global mode (or no groups in the project):
    // a single flat list with no headers — dependency arrows still drawn.
    const groupTasks = filteredTasks
      .filter((t) => t.isGroup)
      .sort(sortByStart);
    const hasGroups = groupTasks.length > 0;
    const useGrouped = mode === 'grouped' && hasGroups;

    type Section =
      | { kind: 'group'; id: string; title: string; items: GanttTaskDto[] }
      | { kind: 'flat'; id: string; items: GanttTaskDto[] };

    let sections: Section[];
    if (useGrouped) {
      const childrenByParent = new Map<string, GanttTaskDto[]>();
      const orphans: GanttTaskDto[] = [];
      for (const t of filteredTasks) {
        if (t.isGroup) continue;
        if (t.parentTaskId && groupTasks.some((g) => g.id === t.parentTaskId)) {
          const arr = childrenByParent.get(t.parentTaskId) ?? [];
          arr.push(t);
          childrenByParent.set(t.parentTaskId, arr);
        } else {
          orphans.push(t);
        }
      }
      sections = groupTasks.map<Section>((g) => ({
        kind: 'group',
        id: g.id,
        title: g.title,
        items: (childrenByParent.get(g.id) ?? []).sort(sortByStart),
      }));
      if (orphans.length) {
        sections.push({
          kind: 'group',
          id: '__ungrouped__',
          title: t('timeline:ungrouped'),
          items: orphans.sort(sortByStart),
        });
      }
    } else {
      sections = [
        {
          kind: 'flat',
          id: '__all__',
          items: filteredTasks
            .filter((t) => !t.isGroup)
            .sort(sortByStart),
        },
      ];
    }

    const yByTask = new Map<string, number>();
    let y = MILE_H;
    for (const s of sections) {
      if (s.kind === 'group') y += GROUP_H;
      if (s.kind === 'group' && collapsed[s.id]) continue;
      for (const t of s.items) {
        yByTask.set(t.id, y);
        y += ROW_H;
      }
    }
    const totalH = Math.max(y, MILE_H + ROW_H);

    const milestones = filteredTasks.filter((t) => t.isMilestone);

    return { epoch, totalDays, sections, yByTask, totalH, milestones, hasGroups };
  }, [data, collapsed, mode, view]);

  if (error) {
    return (
      <div className="placeholder">
        <div className="ph-icon">
          <Icon name="timeline" size={30} />
        </div>
        <h2 className="ph-title">{t('timeline:unavailableTitle')}</h2>
        <p className="ph-sub">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 24, opacity: 0.7, fontSize: 13 }}>
        {t('timeline:loadingTimeline')}
      </div>
    );
  }

  // ---- Mise en page TÉLÉPHONE : liste verticale d'échéancier (date-triée).
  //      Le canevas Gantt horizontal ne tient pas en portrait. L'édition des
  //      dépendances reste dans le détail de la tâche (tap → onOpen). ----
  if (isMobile) {
    return <GanttMobile data={data} onOpen={onOpen} />;
  }

  if (!layout) {
    return (
      <div className="placeholder">
        <div className="ph-icon">
          <Icon name="timeline" size={30} />
        </div>
        <div className="ph-phase mono">{t('timeline:phase')}</div>
        <h2 className="ph-title">{t('timeline:noTasksTitle')}</h2>
        <p className="ph-sub">
          {t('timeline:noTasksSub')}
        </p>
      </div>
    );
  }

  const { epoch, totalDays, sections, yByTask, totalH, milestones } = layout;
  const trackW = totalDays * dayW;

  const todayUtc = new Date();
  const todayKey = Date.UTC(
    todayUtc.getUTCFullYear(),
    todayUtc.getUTCMonth(),
    todayUtc.getUTCDate(),
  );

  const days = Array.from({ length: totalDays }, (_, i) => {
    const d = addDays(epoch, i);
    const dow = d.getUTCDay();
    const iso = isoDay(d);
    const name = orgHolidays.get(iso) ?? null;
    return {
      date: d,
      dow,
      weekend: dow === 0 || dow === 6,
      today: +d === todayKey,
      holiday: name ? { key: iso, name } : null,
    };
  });

  // Month header segments
  const monthSegs: { label: string; year: number; span: number }[] = [];
  for (const d of days) {
    const last = monthSegs[monthSegs.length - 1];
    const label = fmtMonth(d.date);
    const year = d.date.getUTCFullYear();
    if (last && last.label === label && last.year === year) last.span++;
    else monthSegs.push({ label, year, span: 1 });
  }

  const todayIdx = days.findIndex((d) => d.today);

  const xAtDay = (idx: number) => idx * dayW;
  const xAtIso = (iso: string) =>
    daysBetween(epoch, parseDay(iso)) * dayW;

  async function handleCreateLink(succId: string) {
    if (!linkSource || linkSource === succId) {
      setLinkSource(null);
      return;
    }
    try {
      await api.createDependency({
        predecessorId: linkSource,
        successorId: succId,
        type: DependencyType.FS,
      });
      setLinkSource(null);
      reload();
    } catch (e) {
      alert(t('timeline:link.refused', { message: (e as Error).message }));
      setLinkSource(null);
    }
  }

  async function handleDeleteDep(id: string) {
    if (!(await confirm({ title: t('common:delete'), message: t('timeline:link.deleteConfirm'), confirmLabel: t('common:delete'), danger: true }))) return;
    try {
      await api.deleteDependency(id);
      reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  /** Analyse FS pour le drag-drop : retourne conflicts (rouge) et gaps (jaune).
   *  - conflict : newStart < pred.end + lag (violation)
   *  - gap      : newStart > pred.end + lag (démarrage en retard, informatif) */
  function detectFsState(
    taskId: string,
    newStartIso: string,
    gantt: GanttDto,
  ): { conflicts: DependencyConflict[]; gaps: DependencyGap[] } {
    const conflicts: DependencyConflict[] = [];
    const gaps: DependencyGap[] = [];
    for (const dep of gantt.dependencies) {
      if (dep.successorId !== taskId) continue;
      if (dep.type !== DependencyType.FS) continue;
      const pred = gantt.tasks.find((x) => x.id === dep.predecessorId);
      if (!pred) continue;
      const lag = dep.lagDays ?? 0;
      const minStartDate = addDays(parseDay(pred.scheduledEnd), lag);
      const newStartDate = parseDay(newStartIso);
      if (newStartDate < minStartDate) {
        conflicts.push({
          predTitle: pred.title,
          predEnd: pred.scheduledEnd,
          minStart: isoDay(minStartDate),
          lagDays: lag,
          type: 'FS',
        });
      } else if (newStartDate > minStartDate) {
        const gapDays = Math.round((+newStartDate - +minStartDate) / 86_400_000);
        gaps.push({
          predTitle: pred.title,
          predEnd: pred.scheduledEnd,
          minStart: isoDay(minStartDate),
          lagDays: lag,
          gapDays,
        });
      }
    }
    return { conflicts, gaps };
  }

  /** Prépare une demande de déplacement après drag : on ouvre la modale au lieu
   *  d'appliquer tout de suite. L'utilisateur confirme (ou annule) ensuite. */
  function requestShiftTask(taskId: string, dayDelta: number) {
    if (!data || dayDelta === 0) return;
    const t = data.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const oldStart = t.scheduledStart;
    const oldEnd = t.scheduledEnd;
    const newStart = isoDay(addDays(parseDay(oldStart), dayDelta));
    const newEnd = isoDay(addDays(parseDay(oldEnd), dayDelta));
    const { conflicts, gaps } = detectFsState(taskId, newStart, data);
    setPendingMove({
      taskId,
      taskTitle: t.title,
      oldStart, oldEnd,
      newStart, newEnd,
      dayDelta,
      conflicts,
      gaps,
    });
  }

  /** Persist a schedule shift (positive = later) and refresh on conflict.
   *  Drag updates every date the task carries: startDate, endDate, and dueDate
   *  (when set) — so Kanban/TaskDetail stay in sync with the timeline. */
  async function applyShiftTask(taskId: string, newStart: string, newEnd: string) {
    if (!data) return;
    // Optimistic update
    setData((d) =>
      d
        ? {
            ...d,
            tasks: d.tasks.map((x) =>
              x.id === taskId
                ? { ...x, scheduledStart: newStart, scheduledEnd: newEnd }
                : x,
            ),
          }
        : d,
    );
    try {
      await api.updateTask(taskId, {
        startDate: newStart,
        endDate: newEnd,
        dueDate: newEnd,
      });
      reload();
    } catch (e) {
      alert(t('timeline:replanRefused', { message: (e as Error).message }));
      reload();
    }
  }

  function depEndpoints(dep: DependencyDto) {
    const pred = data!.tasks.find((t) => t.id === dep.predecessorId);
    const succ = data!.tasks.find((t) => t.id === dep.successorId);
    if (!pred || !succ) return null;
    const yPred = yByTask.get(pred.id);
    const ySucc = yByTask.get(succ.id);
    if (yPred == null || ySucc == null) return null;
    const predEnd = xAtIso(pred.scheduledEnd);
    const predStart = xAtIso(pred.scheduledStart);
    const succEnd = xAtIso(succ.scheduledEnd);
    const succStart = xAtIso(succ.scheduledStart);
    let x1: number, x2: number;
    switch (dep.type) {
      case DependencyType.FS:
        x1 = predEnd;
        x2 = succStart;
        break;
      case DependencyType.SS:
        x1 = predStart;
        x2 = succStart;
        break;
      case DependencyType.FF:
        x1 = predEnd;
        x2 = succEnd;
        break;
      case DependencyType.SF:
        x1 = predStart;
        x2 = succEnd;
        break;
    }
    const y1 = yPred + ROW_H / 2;
    const y2 = ySucc + ROW_H / 2;
    const isCritical =
      showCritical &&
      pred.critical &&
      succ.critical &&
      dep.type === DependencyType.FS;
    return { x1, y1, x2, y2, isCritical };
  }

  function Bar({ t }: { t: GanttTaskDto }) {
    const dragRef = useRef<{
      startX: number;
      delta: number;
      moved: boolean;
    } | null>(null);
    const [dragPx, setDragPx] = useState(0);

    const sStart = parseDay(t.scheduledStart);
    const sEnd = parseDay(t.scheduledEnd);
    const startIdx = daysBetween(epoch, sStart);
    const widthDays = Math.max(1, daysBetween(sStart, sEnd));
    const left = xAtDay(startIdx);
    const w = widthDays * dayW;
    const hue = STATUS_HUE[t.status];
    const done = t.progressPct >= 100;
    const assigneeDto = t.assignees[0];
    const assignee = assigneeDto ? assigneeUser(assigneeDto) : undefined;

    // Show title inside when there's room for avatar + a few chars.
    const minInside = assignee ? 70 : 50;
    // Bornes "réelles" de la barre (peuvent dépasser à gauche / à droite la
    // fenêtre courante en mode semaine/mois).
    const rawLeft = left + 3;
    const rawWidth = Math.max(8, w - 6);
    const clipsLeft = rawLeft < 0;
    const clipsRight = rawLeft + rawWidth > trackW;
    // On n'affiche le label "outside" que si la barre n'est tronquée d'aucun
    // côté — sinon le libellé déborde sur la colonne des noms ou hors écran.
    const labelOutside = w < minInside && !clipsLeft && !clipsRight;

    function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      dragRef.current = { startX: e.clientX, delta: 0, moved: false };
      el.setPointerCapture(e.pointerId);
      el.classList.add('gbar-dragging');

      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        if (Math.abs(dx) > 4) dragRef.current.moved = true;
        const d = Math.round(dx / dayW);
        dragRef.current.delta = d;
        setDragPx(d * dayW);
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        el.classList.remove('gbar-dragging');
        const d = dragRef.current?.delta ?? 0;
        const moved = dragRef.current?.moved ?? false;
        dragRef.current = null;
        setDragPx(0);
        if (!moved) {
          if (linkSource) handleCreateLink(t.id);
          else onOpen(t.id);
          return;
        }
        if (d !== 0) requestShiftTask(t.id, d);
        ev.preventDefault();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    }

    const cls =
      'gbar' +
      (done ? ' gbar-done' : '') +
      (showCritical && t.critical ? ' is-critical' : '') +
      (labelOutside ? ' gbar-mini' : '') +
      (clipsLeft ? ' gbar-clip-l' : '') +
      (clipsRight ? ' gbar-clip-r' : '');

    // Clamp à la fenêtre visible : si la barre déborde, on l'ampute du côté
    // qui dépasse et on ajoute une classe pour le repère visuel (chevron).
    const realLeft = rawLeft + dragPx;
    const realRight = realLeft + rawWidth;
    const clampedLeft = Math.max(0, realLeft);
    const clampedRight = Math.min(trackW, realRight);
    const barLeft = clampedLeft;
    const barWidth = Math.max(0, clampedRight - clampedLeft);
    if (barWidth <= 0) return null;
    return (
      <>
        <div
          className={cls + (t.color ? ' has-tint' : '')}
          style={{
            left: barLeft,
            width: barWidth,
            height: BAR_H,
            top: (ROW_H - BAR_H) / 2,
            ['--bhue' as never]: hue,
            ...(t.color ? { ['--btint' as never]: t.color } : null),
          }}
          onPointerDown={onPointerDown}
          title={tr('timeline:barTooltip', { title: t.title, start: fmtShort(sStart), end: fmtShort(sEnd), pct: t.progressPct })}
        >
          <div className="gbar-fill" style={{ width: t.progressPct + '%' }} />
          {!labelOutside && (
            <div className="gbar-in">
              {assignee && <Avatar user={assignee} size={BAR_H - 8} title={false} />}
              <span className="gbar-title">{t.title}</span>
              {w >= 130 && <span className="gbar-pct mono">{t.progressPct}%</span>}
            </div>
          )}
        </div>
        {labelOutside && (
          <div
            className="gbar-out"
            style={{
              left: barLeft + barWidth + 8,
              top: (ROW_H - BAR_H) / 2,
            }}
          >
            {assignee && <Avatar user={assignee} size={BAR_H - 8} title={false} />}
            <span className="gbar-out-title">{t.title}</span>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="gantt-wrap">
      {/* toolbar */}
      <div
        className="gantt-toolbar"
        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}
      >
        {/* Ligne 1 : titre à gauche, légende à droite. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            flexWrap: 'wrap',
            width: '100%',
          }}
        >
          <div className="row gap2">
            <h1 className="view-h1">{t('timeline:title')}</h1>
            <span className="view-sub">
              {t('timeline:taskCount', { count: data.tasks.length })} ·{' '}
              {t('timeline:criticalPathDays', { days: data.criticalPathDays })}
            </span>
          </div>
          <div className="row gap3" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {linkSource && (
              <span className="gantt-link-banner">
                {t('timeline:link.chooseTarget')}
                <button onClick={() => setLinkSource(null)}>{t('timeline:link.cancel')}</button>
              </span>
            )}
            <div className="gantt-legend row gap3">
              <span className="row gap1">
                <span className="glg glg-weekend" /> {t('timeline:legend.weekend')}
              </span>
              <span className="row gap1">
                <span className="glg glg-holiday" /> {t('timeline:legend.holiday')}
              </span>
              <span className="row gap1">
                <span className="glg glg-today" /> {t('timeline:legend.today')}
              </span>
              <span className="row gap1">
                <span className="glg glg-mile" /> {t('timeline:legend.milestone')}
              </span>
              <button
                type="button"
                className={'glg-toggle row gap1' + (showCritical ? ' is-on' : '')}
                onClick={() => setShowCritical((v) => !v)}
                title={
                  showCritical
                    ? t('timeline:legend.hideCritical')
                    : t('timeline:legend.showCritical')
                }
              >
                <span className="glg glg-crit" /> {t('timeline:legend.criticalPath')}
              </button>
            </div>
          </div>
        </div>
        {/* Ligne 2 : pickers à gauche, segments mode + refresh à droite. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
            flexWrap: 'wrap',
            width: '100%',
          }}
        >
          <div
            className="row gap2"
            style={{ alignItems: 'center', flexWrap: 'wrap' }}
          >
            {viewMode === 'custom' && (
              <>
                <label className="row gap1" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {t('timeline:picker.from')}
                  <input
                    type="date"
                    className="atext mono"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    value={isoDay(from)}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setFrom(new Date(e.target.value + 'T00:00:00Z'));
                    }}
                  />
                </label>
                <label className="row gap1" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {t('timeline:picker.to')}
                  <input
                    type="date"
                    className="atext mono"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    value={isoDay(to)}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setTo(new Date(e.target.value + 'T00:00:00Z'));
                    }}
                  />
                </label>
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => {
                    const duration = Math.max(1, daysBetween(from, to));
                    const start = todayUtcDate();
                    const end = new Date(start);
                    end.setUTCDate(end.getUTCDate() + duration);
                    setFrom(start);
                    setTo(end);
                  }}
                  title={t('timeline:picker.fromTodayTitle')}
                >
                  {t('timeline:picker.fromToday')}
                </button>
              </>
            )}
            {viewMode === 'week' && (
              <>
                <label className="row gap1" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {t('timeline:picker.week')}
                  <input
                    type="week"
                    className="atext mono"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    value={toIsoWeekString(from)}
                    onChange={(e) => {
                      const d = fromIsoWeekString(e.target.value);
                      if (d) setFrom(d);
                    }}
                  />
                </label>
                <button
                  className="icon-btn"
                  title={t('timeline:picker.prevWeek')}
                  onClick={() =>
                    setFrom((cur) => {
                      const n = new Date(cur);
                      n.setUTCDate(n.getUTCDate() - 7);
                      return n;
                    })
                  }
                >
                  <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} />
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setFrom(todayUtcDate())}
                  title={t('timeline:picker.thisWeekTitle')}
                >
                  {t('timeline:picker.thisWeek')}
                </button>
                <button
                  className="icon-btn"
                  title={t('timeline:picker.nextWeek')}
                  onClick={() =>
                    setFrom((cur) => {
                      const n = new Date(cur);
                      n.setUTCDate(n.getUTCDate() + 7);
                      return n;
                    })
                  }
                >
                  <Icon name="chevR" size={14} />
                </button>
                {view.label && (
                  <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 6 }}>
                    {view.label}
                  </span>
                )}
              </>
            )}
            {viewMode === 'month' && (
              <>
                <label className="row gap1" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {t('timeline:picker.month')}
                  <input
                    type="month"
                    className="atext mono"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    value={toMonthString(from)}
                    onChange={(e) => {
                      const d = fromMonthString(e.target.value);
                      if (d) setFrom(d);
                    }}
                  />
                </label>
                <button
                  className="icon-btn"
                  title={t('timeline:picker.prevMonth')}
                  onClick={() =>
                    setFrom((cur) => {
                      const n = new Date(cur);
                      n.setUTCMonth(n.getUTCMonth() - 1, 1);
                      return n;
                    })
                  }
                >
                  <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} />
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '4px 10px' }}
                  onClick={() => setFrom(todayUtcDate())}
                  title={t('timeline:picker.thisMonthTitle')}
                >
                  {t('timeline:picker.thisMonth')}
                </button>
                <button
                  className="icon-btn"
                  title={t('timeline:picker.nextMonth')}
                  onClick={() =>
                    setFrom((cur) => {
                      const n = new Date(cur);
                      n.setUTCMonth(n.getUTCMonth() + 1, 1);
                      return n;
                    })
                  }
                >
                  <Icon name="chevR" size={14} />
                </button>
                {view.label && (
                  <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 6 }}>
                    {view.label}
                  </span>
                )}
              </>
            )}
          </div>
          {/* Bloc droit : segments calendrier + mode + refresh. */}
          <div className="row gap3" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="seg">
              {(['global', 'grouped'] as Mode[]).map((m) => (
                <button
                  key={m}
                  className={'seg-btn' + (mode === m ? ' seg-on' : '')}
                  onClick={() => setMode(m)}
                >
                  {m === 'global' ? t('timeline:mode.global') : t('timeline:mode.grouped')}
                </button>
              ))}
            </div>
            <div className="seg">
              {(['custom', 'week', 'month'] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  className={'seg-btn' + (viewMode === m ? ' seg-on' : '')}
                  onClick={() => setViewMode(m)}
                  title={
                    m === 'custom' ? t('timeline:viewMode.customTitle')
                      : m === 'week' ? t('timeline:viewMode.weekTitle')
                        : t('timeline:viewMode.monthTitle')
                  }
                >
                  {m === 'custom' ? t('timeline:viewMode.custom') : m === 'week' ? t('timeline:viewMode.week') : t('timeline:viewMode.month')}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={reload} title={t('timeline:reload')}>
              <Icon name="refresh" size={16} />
            </button>
          </div>
        </div>
      </div>

      <div className="gantt-scroll" ref={setScrollRef}>
        <div className="gantt-grid" style={{ width: LABEL_W + trackW }}>
          {/* sticky header */}
          <div className="gantt-head" style={{ height: HEAD_H }}>
            <div className="gantt-corner" style={{ width: LABEL_W }}>
              <Icon name="timeline" size={16} style={{ color: 'var(--accent)' }} />
              <span>{t('timeline:tasksHeader')}</span>
            </div>
            <div className="gantt-head-track" style={{ width: trackW }}>
              <div className="gantt-months">
                {monthSegs.map((m, i) => (
                  <div
                    key={i}
                    className="gantt-month"
                    style={{ width: m.span * dayW }}
                  >
                    {m.label}{' '}
                    <span className="gantt-month-yr">{m.year}</span>
                  </div>
                ))}
              </div>
              <div className="gantt-dayrow">
                {days.map((d, i) => (
                  <div
                    key={i}
                    className={
                      'gantt-dcell' +
                      (d.weekend ? ' is-weekend' : '') +
                      (d.holiday ? ' is-holiday' : '') +
                      (d.today ? ' is-today' : '')
                    }
                    style={{ width: dayW }}
                    title={d.holiday ? d.holiday.name : undefined}
                  >
                    <span className="gantt-dow">{DOW[d.dow]}</span>
                    <span className="gantt-dnum mono">{d.date.getUTCDate()}</span>
                    {d.holiday && <Icon name="flag" size={9} className="gantt-dflag" />}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* rows area */}
          <div className="gantt-rows" style={{ minHeight: totalH }}>
            {/* background day stripes */}
            <div
              className="gantt-bg"
              style={{ left: LABEL_W, width: trackW }}
            >
              {days.map((d, i) => (
                <div
                  key={i}
                  className={
                    'gantt-bgcol' +
                    (d.weekend ? ' is-weekend' : '') +
                    (d.holiday ? ' is-holiday' : '')
                  }
                  style={{ width: dayW }}
                />
              ))}
            </div>
            {todayIdx >= 0 && (
              <div
                className="gantt-today-line"
                style={{ left: LABEL_W + xAtDay(todayIdx) + dayW / 2 }}
              />
            )}

            {/* dependency arrows */}
            <svg
              className="gantt-deps"
              width={LABEL_W + trackW}
              height={totalH}
            >
              <defs>
                <marker
                  id="garrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="5.5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-faint)" />
                </marker>
                <marker
                  id="garrow-crit"
                  markerWidth="7"
                  markerHeight="7"
                  refX="5.5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6 Z" fill="oklch(0.65 0.18 25)" />
                </marker>
              </defs>
              {data.dependencies.map((dep) => {
                const ep = depEndpoints(dep);
                if (!ep) return null;
                const x1 = LABEL_W + ep.x1 - 3;
                const x2 = LABEL_W + ep.x2 + 3;
                const midX = Math.max(x1 + 12, x2 - 14);
                const path = `M ${x1} ${ep.y1} H ${midX} V ${ep.y2} H ${x2 - 6}`;
                return (
                  <g key={dep.id}>
                    <path
                      d={path}
                      className={
                        'gantt-dep' + (ep.isCritical ? ' is-critical' : '')
                      }
                      markerEnd={`url(#${ep.isCritical ? 'garrow-crit' : 'garrow'})`}
                    />
                    <path
                      d={path}
                      className="gantt-dep-hit"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteDep(dep.id);
                      }}
                    >
                      <title>
                        {dep.lagDays
                          ? t('timeline:link.depTooltipLag', { type: dep.type, lag: dep.lagDays })
                          : t('timeline:link.depTooltip', { type: dep.type })}
                      </title>
                    </path>
                  </g>
                );
              })}
            </svg>

            {/* milestone lane */}
            <div
              className="gantt-row gantt-mile-row"
              style={{
                height: MILE_H,
                gridTemplateColumns: `${LABEL_W}px 1fr`,
              }}
            >
              <div
                className="gantt-rlabel gantt-mile-label"
                style={{ width: LABEL_W }}
              >
                <Icon name="flag" size={14} /> {t('timeline:milestones')}
              </div>
              <div className="gantt-rtrack">
                {milestones.map((m) => {
                  const idx = daysBetween(epoch, parseDay(m.scheduledStart));
                  return (
                    <div
                      key={m.id}
                      className={
                        'gantt-mile' + (showCritical && m.critical ? ' is-critical' : '')
                      }
                      style={{ left: xAtDay(idx) + dayW / 2 }}
                      onClick={() => onOpen(m.id)}
                      title={t('timeline:milestoneTooltip', { title: m.title, date: fmtShort(parseDay(m.scheduledStart)) })}
                    >
                      <span className="gantt-mile-dot" />
                      <span className="gantt-mile-name">{m.title}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* sections + task rows (sections = parent groups, or a single flat list) */}
            {sections.map((s) => {
              const open = s.kind === 'flat' ? true : !collapsed[s.id];
              return (
                <div key={s.id}>
                  {s.kind === 'group' && (
                    <div
                      className="gantt-grouphead"
                      style={{
                        height: GROUP_H,
                        width: LABEL_W + trackW,
                      }}
                      onClick={() =>
                        setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))
                      }
                    >
                      <Icon
                        name="chevR"
                        size={14}
                        style={{
                          transform: open ? 'rotate(90deg)' : 'none',
                          transition: 'transform .15s var(--ease)',
                        }}
                      />
                      <Icon
                        name="branch"
                        size={13}
                        style={{
                          color:
                            (s.kind === 'group' && s.items[0]?.color) ||
                            'var(--accent)',
                        }}
                      />
                      <span className="gantt-gname">{s.title}</span>
                      <span className="gantt-gcount mono">{s.items.length}</span>
                    </div>
                  )}
                  {open &&
                    s.items.map((t) => {
                      const sStart = parseDay(t.scheduledStart);
                      const sEnd = parseDay(t.scheduledEnd);
                      const widthDays = Math.max(1, daysBetween(sStart, sEnd));
                      const isSelected = selectedTaskId === t.id;
                      const isSource = linkSource === t.id;
                      return (
                        <div
                          className="gantt-row"
                          key={t.id}
                          style={{
                            height: ROW_H,
                            gridTemplateColumns: `${LABEL_W}px 1fr`,
                          }}
                        >
                          <div
                            className={
                              'gantt-rlabel' +
                              (isSelected ? ' is-selected' : '') +
                              (isSource ? ' is-source' : '')
                            }
                            style={{ width: LABEL_W }}
                            onClick={() => setSelectedTaskId(t.id)}
                            onDoubleClick={() => onOpen(t.id)}
                          >
                            {showCritical && t.critical && <span className="gantt-rdot-crit" />}
                            {t.color && (
                              <span
                                title={tr('timeline:groupColor')}
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: 2,
                                  background: t.color,
                                  flexShrink: 0,
                                }}
                              />
                            )}
                            {t.isMilestone && (
                              <Icon
                                name="flag"
                                size={12}
                                style={{ color: 'var(--accent)' }}
                              />
                            )}
                            <span className="gantt-rtitle truncate">
                              {t.title}
                            </span>
                            <button
                              className={
                                'gantt-rlink' + (isSource ? ' is-armed' : '')
                              }
                              title={
                                linkSource
                                  ? linkSource === t.id
                                    ? tr('timeline:link.sourceTitle')
                                    : tr('timeline:link.makeTarget')
                                  : tr('timeline:link.startFrom')
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (linkSource) handleCreateLink(t.id);
                                else setLinkSource(t.id);
                              }}
                            >
                              <Icon
                                name={linkSource ? 'arrowRight' : 'link'}
                                size={12}
                              />
                            </button>
                          </div>
                          <div className="gantt-rtrack" style={{ position: 'relative' }}>
                            {/* Tint des jours fériés *spécifiques* à un assignee
                                de cette tâche (countryCode ≠ défaut org). Le
                                fond global org est déjà appliqué sur la colonne. */}
                            {(() => {
                              const assigneeIds = (t.assignees || []).map((a) => a.userId);
                              const days: { iso: string; name: string }[] = [];
                              const seen = new Set<string>();
                              for (const uid of assigneeIds) {
                                const m = userHolidays.get(uid);
                                if (!m) continue;
                                for (const [iso, name] of m) {
                                  if (seen.has(iso)) continue;
                                  seen.add(iso);
                                  // Restreindre à la fenêtre visible.
                                  const idx = daysBetween(epoch, parseDay(iso));
                                  if (idx < 0 || idx >= totalDays) continue;
                                  days.push({ iso, name });
                                }
                              }
                              if (!days.length) return null;
                              return days.map((h) => {
                                const idx = daysBetween(epoch, parseDay(h.iso));
                                return (
                                  <div
                                    key={h.iso}
                                    title={tr('timeline:assigneeHoliday', { name: h.name })}
                                    style={{
                                      position: 'absolute',
                                      left: xAtDay(idx),
                                      width: dayW,
                                      top: 0,
                                      bottom: 0,
                                      pointerEvents: 'none',
                                      background:
                                        'oklch(from oklch(0.65 0.18 25) l c h / 0.12)',
                                      borderLeft: '1px dashed oklch(0.65 0.18 25 / 0.4)',
                                      borderRight: '1px dashed oklch(0.65 0.18 25 / 0.4)',
                                    }}
                                  />
                                );
                              });
                            })()}
                            {!t.isMilestone && <Bar t={t} />}
                            {t.isMilestone && (
                              <div
                                className={
                                  'gantt-mile' +
                                  (showCritical && t.critical ? ' is-critical' : '')
                                }
                                style={{
                                  left:
                                    xAtDay(daysBetween(epoch, sStart)) + dayW / 2,
                                }}
                                onClick={() => onOpen(t.id)}
                              >
                                <span className="gantt-mile-dot" />
                              </div>
                            )}
                            {!t.isMilestone && widthDays * dayW >= 110 && (
                              <span
                                className="gantt-rspan mono"
                                style={{
                                  left:
                                    xAtDay(daysBetween(epoch, sStart) + widthDays) +
                                    8,
                                }}
                              >
                                {tr('timeline:daysSpan', { days: widthDays })}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {pendingMove && (
        <MoveConfirmModal
          move={pendingMove}
          onCancel={() => setPendingMove(null)}
          onConfirm={async () => {
            const m = pendingMove;
            setPendingMove(null);
            await applyShiftTask(m.taskId, m.newStart, m.newEnd);
          }}
        />
      )}
    </div>
  );
}

function MoveConfirmModal({
  move,
  onCancel,
  onConfirm,
}: {
  move: {
    taskTitle: string;
    oldStart: string;
    oldEnd: string;
    newStart: string;
    newEnd: string;
    dayDelta: number;
    conflicts: {
      predTitle: string;
      predEnd: string;
      minStart: string;
      lagDays: number;
      type: 'FS';
    }[];
    gaps: {
      predTitle: string;
      predEnd: string;
      minStart: string;
      lagDays: number;
      gapDays: number;
    }[];
  };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('timeline');
  const f = useFormat();
  const fmt = (iso: string) => f.dayMonthYear(iso);
  const same = move.oldStart === move.oldEnd && move.newStart === move.newEnd;
  const dir = move.dayDelta > 0 ? `+${move.dayDelta}` : `${move.dayDelta}`;
  return (
    <div className="md-overlay" onMouseDown={onCancel}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 520 }}
      >
        <div className="md-head">
          <div className="anav-mark" style={{ width: 38, height: 38 }}>
            <Icon name="timeline" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('timeline:move.eyebrow')}</div>
            <div className="md-title truncate">{move.taskTitle}</div>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            {t('timeline:move.movedFromTo')}{' '}
            <strong>
              {same ? fmt(move.oldStart) : `${fmt(move.oldStart)} → ${fmt(move.oldEnd)}`}
            </strong>{' '}
            {t('timeline:move.to')}{' '}
            <strong>
              {same ? fmt(move.newStart) : `${fmt(move.newStart)} → ${fmt(move.newEnd)}`}
            </strong>{' '}
            <span className="mono" style={{ color: 'var(--text-3)', fontSize: 12 }}>
              {t('timeline:move.dayDelta', { delta: dir })}
            </span>.
          </p>
          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-3)' }}>
            {t('timeline:move.datesUpdated')}
          </p>
          {move.conflicts.length > 0 && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 8,
                background: 'oklch(from oklch(0.65 0.18 25) l c h / 0.10)',
                border: '1px solid oklch(from oklch(0.65 0.18 25) l c h / 0.40)',
                color: 'var(--text-1)',
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'oklch(0.78 0.18 25)' }}>
                <Icon name="warn" size={14} /> {t('timeline:move.conflictTitle')}
              </div>
              <div style={{ marginTop: 6 }}>
                {move.conflicts.length > 1
                  ? t('timeline:move.conflictIntroOther', { date: fmt(move.newStart) })
                  : t('timeline:move.conflictIntroOne', { date: fmt(move.newStart) })}
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {move.conflicts.map((c, i) => (
                  <li key={i} style={{ marginTop: 2 }}>
                    <strong>{c.predTitle}</strong> {t('timeline:move.conflictEnds')}{' '}
                    <span className="mono">{fmt(c.predEnd)}</span>
                    {c.lagDays !== 0 && (
                      <span className="mono" style={{ color: 'var(--text-3)' }}>
                        {t('timeline:move.conflictLag', { lag: `${c.lagDays > 0 ? '+' : ''}${c.lagDays}` })}
                      </span>
                    )}
                    {t('timeline:move.conflictExpected')}{' '}
                    <span className="mono">{fmt(c.minStart)}</span>.
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
                {t('timeline:move.conflictNote')}
              </div>
            </div>
          )}
          {move.conflicts.length === 0 && move.gaps.length > 0 && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 8,
                background: 'oklch(from oklch(0.75 0.18 85) l c h / 0.10)',
                border: '1px solid oklch(from oklch(0.75 0.18 85) l c h / 0.40)',
                color: 'var(--text-1)',
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'oklch(0.85 0.18 85)' }}>
                <Icon name="warn" size={14} /> {t('timeline:move.lateStartTitle')}
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {move.gaps.map((g, i) => (
                  <li key={i} style={{ marginTop: 2 }}>
                    {t('timeline:move.lateStartItemPrefix')}{' '}
                    <strong>{t('timeline:move.lateStartItemDays', { days: g.gapDays })}</strong>{' '}
                    {t('timeline:move.lateStartItemSuffix')}{' '}
                    <strong>{g.predTitle}</strong>{' '}
                    <span className="mono" style={{ color: 'var(--text-3)' }}>
                      ({fmt(g.predEnd)})
                    </span>.
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="md-foot">
          <div className="md-foot-meta" />
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onCancel}>
              {t('common:cancel')}
            </button>
            <button
              className={move.conflicts.length > 0 ? 'btn btn-danger' : 'btn btn-accent'}
              onClick={onConfirm}
            >
              {move.conflicts.length > 0
                ? t('timeline:move.confirmDespite')
                : t('timeline:move.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Mise en page TÉLÉPHONE (≤620px) — échéancier vertical.
   Le Gantt SVG horizontal ne tient pas en portrait. On réutilise les données
   (tasks CPM, fenêtre projet) et on rend une liste de tâches triée par date de
   début : chaque ligne montre un mini-bar positionné dans la fenêtre du projet,
   le badge chemin critique, l'avancement et les assignés. Tap → détail tâche
   (où l'on édite les dépendances). Desktop intouché.
   ============================================================ */
function GanttMobile({ data, onOpen }: { data: GanttDto; onOpen: (id: string) => void }) {
  const { t } = useTranslation('timeline');
  const fmt = useFormat();
  const fmtShort = (d: Date) => fmt.dayMonth(d);
  const [criticalOnly, setCriticalOnly] = useState(false);

  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const projStart = parseDay(data.projectStart);
  const projEnd = parseDay(data.projectEnd);
  const span = Math.max(1, daysBetween(projStart, projEnd));
  const today = todayUtcDate();
  const todayPct = clamp(daysBetween(projStart, today) / span, 0, 1) * 100;
  const todayInRange = +today >= +projStart && +today <= +projEnd;

  const baseTasks = data.tasks.filter((tk) => !tk.isGroup);
  const criticalCount = baseTasks.filter((tk) => tk.critical).length;
  const tasks = (criticalOnly ? baseTasks.filter((tk) => tk.critical) : baseTasks)
    .slice()
    .sort(
      (a, b) =>
        +parseDay(a.scheduledStart) - +parseDay(b.scheduledStart) || a.title.localeCompare(b.title),
    );

  return (
    <div className="gm-wrap">
      <div className="gm-head">
        <div className="gm-sub">
          {t('timeline:taskCount', { count: baseTasks.length })}
          {data.criticalPathDays > 0 && <> · {t('timeline:criticalPathDays', { days: data.criticalPathDays })}</>}
        </div>
        {criticalCount > 0 && (
          <button
            className={'btn btn-line btn-sm gm-crit-toggle' + (criticalOnly ? ' is-on' : '')}
            onClick={() => setCriticalOnly((v) => !v)}
            style={{ whiteSpace: 'nowrap' }}
          >
            {t('timeline:mobile.criticalOnly')}
          </button>
        )}
      </div>

      {tasks.map((tk) => {
        const s = parseDay(tk.scheduledStart);
        const e = parseDay(tk.scheduledEnd);
        const left = clamp(daysBetween(projStart, s) / span, 0, 1) * 100;
        const width = Math.max(clamp(daysBetween(s, e) / span, 0, 1) * 100, 2);
        const hue = STATUS_HUE[tk.status] ?? 250;
        const color = tk.critical ? 'var(--c-over)' : `oklch(0.62 0.15 ${hue})`;
        const prog = Math.round(tk.progressPct);
        return (
          <button
            key={tk.id}
            className={'gm-row' + (tk.critical ? ' is-critical' : '')}
            onClick={() => onOpen(tk.id)}
          >
            <div className="gm-row-top">
              {tk.isMilestone ? (
                <span className="gm-mile-flag" style={{ color }}>◆</span>
              ) : (
                <span className="gm-dot" style={{ background: color }} />
              )}
              <span className="gm-title">{tk.title}</span>
              {tk.critical && <span className="gm-badge gm-crit">{t('timeline:mobile.critical')}</span>}
            </div>
            <div className="gm-meta">
              <span className="mono">
                {fmtShort(s)}
                {tk.isMilestone ? '' : ` – ${fmtShort(e)}`}
              </span>
              {!tk.isMilestone && prog > 0 && <span className="gm-prog mono">{prog}%</span>}
              {tk.assignees && tk.assignees.length > 0 && (
                <span className="gm-avs">
                  {tk.assignees.slice(0, 3).map((a) => (
                    <Avatar key={a.userId} user={assigneeUser(a)} size={18} title={false} />
                  ))}
                </span>
              )}
            </div>
            <div className="gm-track">
              {todayInRange && <span className="gm-today" style={{ left: todayPct + '%' }} />}
              {tk.isMilestone ? (
                <span className="gm-mile-dot" style={{ left: left + '%', background: color }} />
              ) : (
                <span className="gm-bar" style={{ left: left + '%', width: width + '%', background: color }}>
                  {prog > 0 && <span className="gm-bar-prog" style={{ width: Math.min(prog, 100) + '%' }} />}
                </span>
              )}
            </div>
          </button>
        );
      })}

      {tasks.length === 0 && <div className="tsm-empty">{t('timeline:noTasksTitle')}</div>}
    </div>
  );
}
