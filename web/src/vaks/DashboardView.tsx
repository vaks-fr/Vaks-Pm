/* ============================================================
   Vaks — Dashboard personnel (page d'accueil « Mes tâches »)
   Remplace l'ancien Kanban cross-projet. Agrège via `GET /me/dashboard`
   (tâches, stats, jalon, activité de l'équipe) + `GET /timesheet` (heures des
   7 derniers jours). Lecture seule : cliquer une tâche l'ouvre.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TaskStatus } from '@vaks-pm/shared';
import type { DashboardDto, DashboardActivityDto, WatchingEntryDto } from '@vaks-pm/shared';
import { apiGetDashboard, apiGetTimesheet, apiListMyWatching, hueFromId, initialsOf } from './api';
import type { TimesheetDto } from './api';
import { MONTHS, type Priority } from './data';
import { useAuth } from '../auth/AuthContext';
import { Icon, PriorityDot } from './primitives';
import { useChartTooltip } from './chart-tooltip';

/** Statut canonique → clé de couleur (col-dot) + clé i18n `tasks:status.*`.
 *  Les statuts « agent » retombent sur le plus proche pour éviter un rendu
 *  cassé (cf. mémoire agent statuses in status maps). */
const STATUS_META: Record<string, { color: string; key: string }> = {
  [TaskStatus.TODO]: { color: 'todo', key: 'todo' },
  [TaskStatus.CLAIMED]: { color: 'progress', key: 'progress' },
  [TaskStatus.IN_PROGRESS]: { color: 'progress', key: 'progress' },
  [TaskStatus.IN_REVIEW]: { color: 'review', key: 'review' },
  [TaskStatus.CHANGES_REQUESTED]: { color: 'review', key: 'review' },
  [TaskStatus.APPROVED]: { color: 'done', key: 'done' },
  [TaskStatus.ON_HOLD]: { color: 'hold', key: 'hold' },
  [TaskStatus.DONE]: { color: 'done', key: 'done' },
};
const STATUS_FALLBACK = { color: 'todo', key: 'todo' };

const MS_PER_DAY = 86_400_000;

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Libellé court d'échéance + drapeaux (overdue / today / soon) à partir d'un
 *  `yyyy-mm-dd`, relativement à aujourd'hui (local). */
function dueInfo(due: string | null): { label: string; overdue: boolean; today: boolean; soon: boolean } | null {
  if (!due) return null;
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((date.getTime() - today.getTime()) / MS_PER_DAY);
  return {
    label: `${MONTHS[m - 1]} ${d}`,
    overdue: diff < 0,
    today: diff === 0,
    soon: diff > 0 && diff <= 2,
  };
}

/** Durée en minutes → "3h30" / "45m" / "8h". */
function fmtHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

/** Temps relatif compact ("12m", "3h", "2d") à partir d'un ISO. */
function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(diffMs / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Avatar inline (initiales) pour un acteur du feed / une tâche. */
function MiniAvatar({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const h = hueFromId(id);
  return (
    <div
      className="dash-av"
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(140deg, oklch(0.62 0.16 ${h}), oklch(0.5 0.16 ${h + 25}))`,
      }}
    >
      {initialsOf(name)}
    </div>
  );
}

export function DashboardView({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { bind, tipNode } = useChartTooltip();
  const [data, setData] = useState<DashboardDto | null>(null);
  const [sheet, setSheet] = useState<TimesheetDto | null>(null);
  const [watching, setWatching] = useState<WatchingEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const today = new Date();
    const from = new Date(today.getTime() - 6 * MS_PER_DAY);
    try {
      // Le suivi et la timesheet sont accessoires : leur échec ne doit pas
      // vider le dashboard (le `catch` local les rend simplement absents).
      const [dash, ts, w] = await Promise.all([
        apiGetDashboard(),
        apiGetTimesheet({ from: isoDay(from), to: isoDay(today) }).catch(() => null),
        apiListMyWatching().catch(() => []),
      ]);
      setData(dash);
      setSheet(ts);
      setWatching(w);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const firstName = useMemo(() => (user?.name ?? '').split(/\s+/)[0] || '', [user]);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    const k = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    return t('dashboard.greeting.' + k);
  }, [t]);
  const todayLabel = useMemo(
    () =>
      new Date().toLocaleDateString(i18n.language, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    [i18n.language],
  );

  // --- Heures : semaine courante + barres 7 jours (depuis la timesheet) ---
  const hours = useMemo(() => {
    const days = sheet?.days ?? [];
    // Lundi de la semaine courante (local).
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    const mondayIso = isoDay(monday);
    let weekMin = 0;
    let weekCap = 0;
    for (const d of days) {
      if (d.date >= mondayIso) {
        weekMin += d.actualMinutes;
        weekCap += d.capacityHours;
      }
    }
    const maxMin = Math.max(1, ...days.map((d) => d.actualMinutes));
    const bars = days.map((d) => ({
      date: d.date,
      dow: d.dayOfWeek,
      pct: Math.round((d.actualMinutes / maxMin) * 100),
      empty: d.actualMinutes === 0,
      min: d.actualMinutes,
      capHours: d.capacityHours,
    }));
    return { weekH: Math.round(weekMin / 60), weekCap: Math.round(weekCap), bars };
  }, [sheet]);

  // --- Donut : Done (semaine) / Doing / To do ---
  const donut = useMemo(() => {
    const sc = data?.statusCounts ?? {};
    const done = data?.completedThisWeek ?? 0;
    const doing =
      (sc[TaskStatus.IN_PROGRESS] ?? 0) +
      (sc[TaskStatus.CLAIMED] ?? 0) +
      (sc[TaskStatus.IN_REVIEW] ?? 0) +
      (sc[TaskStatus.CHANGES_REQUESTED] ?? 0) +
      (sc[TaskStatus.APPROVED] ?? 0);
    const todo = (sc[TaskStatus.TODO] ?? 0) + (sc[TaskStatus.ON_HOLD] ?? 0);
    const total = done + doing + todo;
    const p1 = total ? (done / total) * 100 : 0;
    const p2 = total ? p1 + (doing / total) * 100 : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { done, doing, todo, total, p1, p2, pct };
  }, [data]);

  const DOW_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <div className="dash-scroll">
      {tipNode}
      <div className="dash-head">
        <div>
          <h1 className="dash-title">
            {greeting}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <div className="dash-sub">
            <span style={{ textTransform: 'capitalize' }}>{todayLabel}</span> · {t('dashboard.subtitle')}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          title={t('common:refresh')}
          style={{ gap: 6 }}
        >
          <Icon name="refresh" size={13} /> {t('common:refresh')}
        </button>
      </div>

      {loading && <div className="placeholder"><div className="ph-sub">{t('common:loading')}</div></div>}
      {error && !loading && (
        <div className="placeholder">
          <div className="ph-title">{t('dashboard.loadError')}</div>
          <button className="btn btn-accent btn-sm" onClick={() => void load()} style={{ marginTop: 12 }}>
            {t('common:retry')}
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <div className="dash-grid">
          {/* ---- Bandeau de stats ---- */}
          <div className="dash-card dash-span3">
            <div className="dash-stat-row">
              <Stat
                value={`${hours.weekH}h`}
                label={t('dashboard.stat.logged', { cap: hours.weekCap })}
                tone="cyan"
              />
              <Stat value={String(data.inProgress)} label={t('dashboard.stat.inProgress')} />
              <Stat
                value={String(data.overdueTeam)}
                label={t('dashboard.stat.overdueTeam')}
                tone={data.overdueTeam > 0 ? 'coral' : undefined}
              />
              <Stat
                value={String(data.completedThisWeek)}
                label={t('dashboard.stat.completedWeek')}
                tone="good"
              />
              <Stat
                value={data.nextMilestone ? dueInfo(data.nextMilestone.dueDate)!.label : '—'}
                label={
                  data.nextMilestone
                    ? t('dashboard.stat.nextMilestone', { name: data.nextMilestone.title })
                    : t('dashboard.stat.noMilestone')
                }
              />
            </div>
          </div>

          {/* ---- Mes tâches ---- */}
          <div className="dash-card dash-span2">
            <div className="dash-ch">
              <span className="dash-nm">{t('dashboard.myTasks')}</span>
            </div>
            {data.tasks.length === 0 ? (
              <div className="dash-empty">{t('dashboard.emptyTasks')}</div>
            ) : (
              <div className="dash-tasklist">
                {data.tasks.map((task) => {
                  const meta = STATUS_META[task.status] ?? STATUS_FALLBACK;
                  const due = dueInfo(task.dueDate);
                  return (
                    <button
                      key={task.id}
                      className="dash-trow"
                      onClick={() => onOpen(task.id)}
                      title={task.projectName}
                    >
                      <span className="dash-col-dot" data-status={meta.color} />
                      <span className="dash-tid mono">{task.key}</span>
                      <span className="dash-tnm">{task.title}</span>
                      {due && (
                        <span
                          className={
                            'dash-due mono ' +
                            (due.overdue ? 'due-over' : due.today ? 'due-today' : due.soon ? 'due-soon' : '')
                          }
                        >
                          {due.label}
                        </span>
                      )}
                      <span className="dash-tag" data-status={meta.color}>
                        <span className="dash-tag-dot" data-status={meta.color} />
                        {t('tasks:status.' + meta.key)}
                      </span>
                      <PriorityDot level={task.priority.toLowerCase() as Priority} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ---- Répartition (donut) ---- */}
          <div className="dash-card">
            <div className="dash-ch">
              <span className="dash-nm">{t('dashboard.breakdown')}</span>
            </div>
            <div className="dash-donut-row">
              <div
                className="dash-donut"
                style={{
                  background: `conic-gradient(var(--good) 0 ${donut.p1}%, var(--accent) ${donut.p1}% ${donut.p2}%, var(--surface-3) ${donut.p2}% 100%)`,
                }}
              >
                <div className="dash-donut-hole">
                  <div className="dash-donut-v">{donut.pct}%</div>
                  <div className="dash-donut-l">{t('dashboard.complete')}</div>
                </div>
              </div>
              <div className="dash-legend">
                {(
                  [
                    { color: 'var(--good)', label: t('dashboard.legend.done'), value: donut.done },
                    { color: 'var(--accent)', label: t('dashboard.legend.doing'), value: donut.doing },
                    { color: 'var(--surface-3)', label: t('dashboard.legend.todo'), value: donut.todo },
                  ] as const
                ).map((s) => {
                  const pct = donut.total ? Math.round((s.value / donut.total) * 100) : 0;
                  return (
                    <LegendRow
                      key={s.label}
                      color={s.color}
                      label={s.label}
                      value={s.value}
                      tip={bind(
                        <>
                          <b>{s.label}</b>
                          <br />
                          {s.value} {t('dashboard.tip.tasks')} · {pct}%
                        </>,
                      )}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---- Heures 7 jours ---- */}
          <div className="dash-card dash-span2">
            <div className="dash-ch">
              <span className="dash-nm">{t('dashboard.hours')}</span>
            </div>
            <div className="dash-bars">
              {hours.bars.length === 0 ? (
                <div className="dash-empty" style={{ alignSelf: 'center', margin: 'auto' }}>
                  {t('dashboard.noHours')}
                </div>
              ) : (
                hours.bars.map((b) => (
                  <div
                    className="dash-bc"
                    key={b.date}
                    {...bind(
                      <>
                        <b style={{ textTransform: 'capitalize' }}>
                          {new Date(b.date + 'T00:00:00').toLocaleDateString(i18n.language, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </b>
                        <br />
                        <span className="ct-k">{t('dashboard.tip.logged')}</span> {fmtHM(b.min)}
                        {b.capHours > 0 && (
                          <>
                            {' · '}
                            <span className="ct-k">{t('dashboard.tip.capacity')}</span> {fmtHM(b.capHours * 60)}
                          </>
                        )}
                      </>,
                    )}
                  >
                    <div
                      className={'dash-bar' + (b.empty ? ' mut' : '')}
                      style={{ height: `${b.empty ? 4 : Math.max(6, b.pct)}%` }}
                    />
                    <div className="dash-lb mono">{DOW_LABELS[b.dow] ?? ''}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ---- Activité de l'équipe ---- */}
          <div className="dash-card">
            <div className="dash-ch">
              <span className="dash-nm">{t('dashboard.activity')}</span>
            </div>
            {data.activity.length === 0 ? (
              <div className="dash-empty">{t('dashboard.activity.empty')}</div>
            ) : (
              <div className="dash-feed">
                {data.activity.map((a) => (
                  <ActivityRow key={a.id} item={a} onOpen={onOpen} />
                ))}
              </div>
            )}
          </div>

          {/* ---- Ce que je suis (watchers) ----
               Carte masquée quand on ne suit rien : le suivi est opt-in, une
               carte vide en permanence serait du bruit pour qui ne l'utilise pas. */}
          {watching.length > 0 && (
            <div className="dash-card dash-span2">
              <div className="dash-ch">
                <span className="dash-nm">{t('dashboard.watching')}</span>
              </div>
              <div className="dash-tasklist">
                {watching.map((w) => (
                  <button
                    key={w.id}
                    className="dash-trow"
                    // Un projet suivi n'est pas ouvrable ici (le dashboard ouvre
                    // des tâches) — seules les tâches sont cliquables.
                    onClick={w.taskId ? () => onOpen(w.taskId!) : undefined}
                    disabled={!w.taskId}
                    title={w.projectName}
                    style={!w.taskId ? { cursor: 'default' } : undefined}
                  >
                    <Icon name={w.kind === 'project' ? 'board' : 'list'} size={14} />
                    <span className="dash-tnm">{w.title}</span>
                    {w.kind === 'task' && <span className="dash-tid mono">{w.projectName}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'cyan' | 'coral' | 'good' }) {
  return (
    <div className="dash-stat">
      <div className={'dash-stat-v' + (tone ? ' ' + tone : '')}>{value}</div>
      <div className="dash-stat-l">{label}</div>
    </div>
  );
}

function LegendRow({
  color,
  label,
  value,
  tip,
}: {
  color: string;
  label: string;
  value: number;
  tip?: React.HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div className="dash-mi" {...tip}>
      <span className="dash-mi-d" style={{ background: color }} />
      <span className="dash-mi-nm">{label}</span>
      <b className="mono">{value}</b>
    </div>
  );
}

function ActivityRow({ item, onOpen }: { item: DashboardActivityDto; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const meta = item.toStatus ? STATUS_META[item.toStatus] ?? STATUS_FALLBACK : null;
  const verb =
    item.kind === 'move'
      ? t('dashboard.act.move', {
          key: item.taskKey,
          status: meta ? t('tasks:status.' + meta.key) : '',
        })
      : item.kind === 'comment'
        ? t('dashboard.act.comment', { key: item.taskKey })
        : t('dashboard.act.created', { key: item.taskKey });
  return (
    <button className="dash-fitem" onClick={() => onOpen(item.taskId)} title={item.taskTitle}>
      <MiniAvatar id={item.actor.id} name={item.actor.name} size={28} />
      <div className="dash-fitem-body">
        <div className="dash-fitem-tx">
          <b>{item.actor.name}</b> {verb}
        </div>
        <div className="dash-fitem-tm mono">{relTime(item.at)}</div>
      </div>
    </button>
  );
}
