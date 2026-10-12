/* ============================================================
   Vaks — Vue Calendrier (CalendarView)
   ----------------------------------------------------------------
   Vue mensuelle bimodale, sans nouveau schéma ni endpoint : elle agrège
   des fenêtres déjà exposées.

   • Mode PERSONNEL (projectId absent) — mes échéances à travers TOUS mes
     projets (`GET /me/tasks`, self-only, cross-projet), avec en overlay mes
     congés (`/time-offs`), les jours fériés de l'org (`/holidays`) et un
     indicateur d'allocation quotidienne (`/allocations`). Comble le trou
     laissé par la suppression de MyTasksView.
   • Mode PROJET (projectId fourni) — échéances (`/projects/:id/tasks-in-window`)
     + jalons (`/projects/:id/gantt`, `isMilestone`) du projet courant, fériés
     en overlay.

   Les statuts sont coloriés via la source unique `taskStatus.ts` (gère les 8
   statuts dont les statuts agents → anti écran blanc). Semaine alignée sur
   `orgSettings.weekStart`. Libellés localisés (namespace `calendar`, ×4).
   ============================================================ */
import './calendar.css';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { statusMeta } from './taskStatus';
import { useAuth } from '../auth/AuthContext';
import { useFormat } from '../lib/format';
import { Icon } from './primitives';

interface Props {
  /** Fourni → mode projet ; absent → mode personnel cross-projet. */
  projectId?: string;
  onOpen: (taskId: string) => void;
  /** Bump du parent pour forcer un refetch (ex. fermeture de TaskDetail). */
  refreshKey?: number;
}

/** Événement placé sur une case du calendrier (échéance ou jalon). */
interface CalEvent {
  id: string;
  title: string;
  status: string;
  /** Date de placement (yyyy-mm-dd). */
  date: string;
  isMilestone: boolean;
  overdue: boolean;
  /** Trigramme projet (mode personnel uniquement). */
  projectKey?: string;
}

const MS_DAY = 86_400_000;
const MAX_CHIPS = 3;
const STORAGE_KEY = 'vaks.calendar.anchor';

/** yyyy-mm-dd (UTC) d'une Date. */
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Parse un yyyy-mm-dd en Date UTC minuit (cohérent avec le stockage). */
function parseIso(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
/** Aujourd'hui en yyyy-mm-dd UTC. */
function todayIso(): string {
  return isoOf(new Date());
}

/** Grille mensuelle : uniquement les jours du mois, complétés pour finir les
 *  semaines (pas de 6e semaine forcée). Le nombre de lignes s'adapte au mois
 *  (4 à 6) → taille fixe, sans scroll. Les cases hors-mois servent seulement à
 *  compléter la première/dernière semaine et sont rendues vides. */
function buildGrid(anchor: Date, weekStartsMonday: boolean): { weeks: Date[][]; start: Date; end: Date } {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const dow = first.getUTCDay(); // 0=dim … 6=sam
  const offset = weekStartsMonday ? (dow + 6) % 7 : dow;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const numWeeks = Math.ceil((offset + daysInMonth) / 7);
  const start = addDays(first, -offset);
  const weeks: Date[][] = [];
  let cur = start;
  for (let w = 0; w < numWeeks; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(cur);
      cur = addDays(cur, 1);
    }
    weeks.push(row);
  }
  return { weeks, start, end: addDays(start, numWeeks * 7 - 1) };
}

export function CalendarView({ projectId, onOpen, refreshKey = 0 }: Props) {
  const { t, i18n } = useTranslation('calendar');
  const fmt = useFormat();
  const { user, orgSettings } = useAuth();
  const weekStartsMonday = orgSettings.weekStart !== 'sunday';
  const locale = i18n.language || 'en';

  const [anchor, setAnchor] = useState<Date>(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) return new Date(Date.UTC(parseIso(s).getUTCFullYear(), parseIso(s).getUTCMonth(), 1));
    } catch {
      /* localStorage indisponible — on retombe sur le mois courant. */
    }
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, isoOf(anchor));
    } catch {
      /* pas bloquant */
    }
  }, [anchor]);

  const grid = useMemo(() => buildGrid(anchor, weekStartsMonday), [anchor, weekStartsMonday]);
  const fromIso = isoOf(grid.start);
  const toIso = isoOf(grid.end);

  const [events, setEvents] = useState<CalEvent[]>([]);
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [timeOff, setTimeOff] = useState<Record<string, string>>({});
  const [allocByDay, setAllocByDay] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setExpanded(new Set());

    async function orgHolidays(): Promise<Record<string, string>> {
      try {
        const { country } = await api.getOrgDefaultHolidayCountry();
        if (!country) return {};
        const { holidays: hs } = await api.lookupHolidays({ country, from: fromIso, to: toIso });
        const m: Record<string, string> = {};
        for (const h of hs) m[h.date] = h.name;
        return m;
      } catch {
        return {};
      }
    }

    (async () => {
      try {
        if (projectId) {
          // ---- Mode projet : échéances + jalons ----
          const [win, gantt, hol] = await Promise.all([
            api.tasksInWindow(projectId, fromIso, toIso),
            api.getGantt(projectId).catch(() => null),
            orgHolidays(),
          ]);
          const milestoneById = new Map<string, { title: string; status: string; date: string }>();
          gantt?.tasks.forEach((g) => {
            if (g.isMilestone) {
              milestoneById.set(g.id, {
                title: g.title,
                status: g.status,
                date: g.scheduledEnd || g.scheduledStart,
              });
            }
          });
          const evs: CalEvent[] = [];
          const seen = new Set<string>();
          for (const tk of win.tasks) {
            const date = tk.dueDate ?? tk.startDate;
            if (!date || date < fromIso || date > toIso) continue;
            seen.add(tk.id);
            evs.push({
              id: tk.id,
              title: tk.title,
              status: tk.status,
              date,
              isMilestone: milestoneById.has(tk.id),
              overdue: tk.overdue,
            });
          }
          // Jalons non couverts par tasks-in-window (placés sur leur fin planifiée).
          milestoneById.forEach((m, id) => {
            if (seen.has(id) || !m.date || m.date < fromIso || m.date > toIso) return;
            evs.push({ id, title: m.title, status: m.status, date: m.date, isMilestone: true, overdue: false });
          });
          if (!alive) return;
          setEvents(evs);
          setHolidays(hol);
          setTimeOff({});
          setAllocByDay({});
        } else {
          // ---- Mode personnel : mes tâches cross-projet ----
          const [my, hol] = await Promise.all([api.myTasks(), orgHolidays()]);
          const projKey = new Map(my.projects.map((p) => [p.id, p.key] as [string, string]));
          const today = todayIso();
          const evs: CalEvent[] = [];
          for (const tk of my.tasks) {
            const date = tk.dueDate ?? tk.startDate;
            if (!date || date < fromIso || date > toIso) continue;
            evs.push({
              id: tk.id,
              title: tk.title,
              status: tk.status,
              date,
              isMilestone: tk.isMilestone,
              overdue: tk.status !== 'DONE' && !!tk.dueDate && tk.dueDate < today,
              projectKey: projKey.get(tk.projectId),
            });
          }
          const me = user?.id;
          const [tos, allocs] = await Promise.all([
            api.listTimeOffs({ from: fromIso, to: toIso, userId: me }).catch(() => []),
            api.listAllocations({ from: fromIso, to: toIso, userId: me }).catch(() => []),
          ]);
          // Congés → étalés jour par jour.
          const offMap: Record<string, string> = {};
          for (const off of tos) {
            let cur = parseIso(off.startDate < fromIso ? fromIso : off.startDate);
            const end = parseIso(off.endDate > toIso ? toIso : off.endDate);
            while (cur <= end) {
              offMap[isoOf(cur)] = off.type;
              cur = addDays(cur, 1);
            }
          }
          // Allocations → total d'heures par jour ouvré.
          const alloc: Record<string, number> = {};
          for (const a of allocs) {
            let cur = parseIso(a.startDate < fromIso ? fromIso : a.startDate);
            const end = parseIso(a.endDate > toIso ? toIso : a.endDate);
            while (cur <= end) {
              const wd = cur.getUTCDay();
              if (wd !== 0 && wd !== 6) {
                const k = isoOf(cur);
                alloc[k] = (alloc[k] ?? 0) + a.hoursPerDay;
              }
              cur = addDays(cur, 1);
            }
          }
          if (!alive) return;
          setEvents(evs);
          setHolidays(hol);
          setTimeOff(offMap);
          setAllocByDay(alloc);
        }
      } catch {
        if (alive) {
          setEvents([]);
          setHolidays({});
          setTimeOff({});
          setAllocByDay({});
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fromIso, toIso, refreshKey, user?.id]);

  const eventsByDay = useMemo(() => {
    const m: Record<string, CalEvent[]> = {};
    for (const e of events) (m[e.date] ??= []).push(e);
    for (const k of Object.keys(m)) {
      m[k].sort(
        (a, b) =>
          Number(b.isMilestone) - Number(a.isMilestone) ||
          Number(b.overdue) - Number(a.overdue) ||
          a.title.localeCompare(b.title),
      );
    }
    return m;
  }, [events]);

  const weekdayLabels = useMemo(() => {
    // 2024-01-01 = lundi ; 2023-12-31 = dimanche.
    const base = parseIso(weekStartsMonday ? '2024-01-01' : '2023-12-31');
    const wd = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => wd.format(addDays(base, i)));
  }, [locale, weekStartsMonday]);

  const today = todayIso();
  const curMonth = anchor.getUTCMonth();

  function shiftMonth(delta: number) {
    setAnchor((a) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + delta, 1)));
  }
  function goToday() {
    const now = new Date();
    setAnchor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  }

  const isEmpty = !loading && events.length === 0;

  return (
    <div className="cal-wrap">
      <div className="cal-toolbar">
        <div className="cal-title-block">
          <h1 className="cal-title">{projectId ? t('projectTitle') : t('personalTitle')}</h1>
          <span className="cal-sub">{projectId ? t('projectSub') : t('personalSub')}</span>
        </div>

        <div className="cal-nav">
          <button className="cal-btn cal-btn-icon" onClick={() => shiftMonth(-1)} title={t('prevMonth')} aria-label={t('prevMonth')}>
            <Icon name="chevL" size={16} />
          </button>
          <span className="cal-month">{fmt.monthYear(anchor)}</span>
          <button className="cal-btn cal-btn-icon" onClick={() => shiftMonth(1)} title={t('nextMonth')} aria-label={t('nextMonth')}>
            <Icon name="chevR" size={16} />
          </button>
          <button className="cal-btn" onClick={goToday} title={t('thisMonth')}>
            {t('today')}
          </button>
        </div>

        {loading && <span className="cal-loadbar">{t('loading')}</span>}

        <div className="cal-spacer" />

        <div className="cal-legend">
          <span className="cal-leg"><span className="cal-leg-swatch cal-leg-today" /> {t('legend.today')}</span>
          <span className="cal-leg"><Icon name="flag" size={12} className="cal-leg-ms" /> {t('legend.milestone')}</span>
          <span className="cal-leg"><span className="cal-leg-swatch cal-leg-over" /> {t('legend.overdue')}</span>
          <span className="cal-leg"><span className="cal-leg-swatch cal-leg-hol" /> {t('legend.holiday')}</span>
          {!projectId && (
            <span className="cal-leg"><span className="cal-leg-swatch cal-leg-off" /> {t('legend.timeOff')}</span>
          )}
        </div>
      </div>

      <div className="cal-scroll">
        <div className="cal-weekhead">
          {weekdayLabels.map((w, i) => (
            <div key={i} className="cal-wd">{w}</div>
          ))}
        </div>

        {isEmpty && <div className="cal-empty">{t('empty')}</div>}

        <div className="cal-grid">
          {grid.weeks.flat().map((day) => {
            const iso = isoOf(day);
            const dow = day.getUTCDay();
            const outside = day.getUTCMonth() !== curMonth;
            // Cases hors-mois : seulement là pour finir la semaine → rendues vides
            // (pas de numéro ni d'événement) conformément à « uniquement le mois ».
            if (outside) return <div key={iso} className="cal-cell cal-cell-blank" />;
            const isWeekend = dow === 0 || dow === 6;
            const holName = holidays[iso];
            const offType = timeOff[iso];
            const allocH = allocByDay[iso] ?? 0;
            const dayEvents = eventsByDay[iso] ?? [];
            const isExpanded = expanded.has(iso);
            const shown = isExpanded ? dayEvents : dayEvents.slice(0, MAX_CHIPS);
            const overflow = dayEvents.length - shown.length;

            const cls =
              'cal-cell' +
              (outside ? ' cal-cell-out' : '') +
              (holName ? ' cal-cell-hol' : isWeekend ? ' cal-cell-weekend' : '') +
              (iso === today ? ' cal-cell-today' : '');

            return (
              <div key={iso} className={cls}>
                <div className="cal-daynum-row">
                  <span className="cal-daynum">{day.getUTCDate()}</span>
                  {holName && (
                    <span className="cal-badge-hol" title={t('tt.holiday', { name: holName, date: fmt.dayMonth(iso) })}>
                      <Icon name="sun" size={12} />
                    </span>
                  )}
                  <span className="cal-spacer" />
                  {allocH > 0 && (
                    <span className="cal-alloc" title={t('tt.allocated', { hours: Math.round(allocH * 10) / 10, date: fmt.dayMonth(iso) })}>
                      {t('allocated', { hours: Math.round(allocH * 10) / 10 })}
                    </span>
                  )}
                </div>

                {holName && <div className="cal-holname" title={holName}>{holName}</div>}
                {offType && (
                  <div className="cal-tooff" title={t('tt.timeOff', { type: t('workload:timeOffType.' + offType, { defaultValue: offType }), start: fmt.dayMonth(iso), end: fmt.dayMonth(iso) })}>
                    {t('workload:timeOffType.' + offType, { defaultValue: offType })}
                  </div>
                )}

                <div className="cal-events">
                  {shown.map((e) => {
                    const hue = statusMeta(e.status).hue;
                    const tip = e.isMilestone
                      ? t('tt.milestone', { title: e.title, date: fmt.dayMonth(e.date) })
                      : e.overdue
                        ? t('tt.overdue', { title: e.title, date: fmt.dayMonth(e.date) })
                        : t('tt.due', { title: e.title, date: fmt.dayMonth(e.date) });
                    return (
                      <button
                        key={e.id}
                        className={'cal-chip' + (e.isMilestone ? ' cal-chip-ms' : '') + (e.overdue ? ' cal-chip-over' : '')}
                        style={{ '--chip-hue': hue } as React.CSSProperties}
                        onClick={() => onOpen(e.id)}
                        title={tip}
                      >
                        {e.isMilestone ? <Icon name="flag" size={11} /> : <span className="cal-dot" />}
                        {e.projectKey && <span className="cal-chip-key">{e.projectKey}</span>}
                        <span className="cal-chip-title">{e.title}</span>
                      </button>
                    );
                  })}
                  {overflow > 0 && (
                    <button
                      className="cal-more"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          next.add(iso);
                          return next;
                        })
                      }
                    >
                      {t('more', { count: overflow })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
