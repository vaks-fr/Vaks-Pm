/* ============================================================
   Vaks — Reports view (Phase 3)
   KPIs projet + burndown + breakdown temps + due adherence
   + export CSV. Pas de lib de charts : SVG inline.
   ============================================================ */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  apiBurndown,
  apiDueAdherence,
  apiProjectByTeam,
  apiProjectStats,
  apiTasksInWindow,
  apiTimeBreakdown,
  type BurndownReport,
  type DueAdherence,
  type ProjectStats,
  type TasksInWindowReportDto,
  type TimeBreakdown,
  type TimeBreakdownRow,
} from './api';
import { api } from '../api/client';
import { Icon } from './primitives';
import { ProjectSkillGapView } from './SkillGapSection';
import { useChartTooltip } from './chart-tooltip';
import { CfdChart } from './report-charts';
import { statusMeta } from './taskStatus';
import { PieChart, palette } from './finance-charts';
import { ReportWidgetsPanel, type ReportWidgetRow } from './ReportWidgetsPanel';
import {
  REPORT_WIDGET_KEYS,
  type ProjectAgentReportDto,
  type ProjectByTeamDto,
  type ProjectCfdDto,
  type ProjectQualityDto,
  type ReportWidgetKey,
  type ReportWidgetPreferenceDto,
} from '@vaks-pm/shared';

/** Registre des widgets pour le panneau "Personnaliser" — libellé i18n par
 *  clé. L'ordre ici n'a pas d'importance (l'ordre affiché suit widgetOrder). */
const WIDGET_ROWS: ReportWidgetRow[] = [
  { key: 'kpis', labelKey: 'reports:widgets.kpis' },
  { key: 'burndown', labelKey: 'reports:burndown.title' },
  { key: 'dueAdherence', labelKey: 'reports:dueAdherence.title' },
  { key: 'agentsQuality', labelKey: 'reports:agents.qualityTitle' },
  { key: 'teamBreakdown', labelKey: 'reports:widgets.teamBreakdown' },
  { key: 'quality', labelKey: 'reports:quality.title' },
  { key: 'agents', labelKey: 'reports:agents.title' },
  { key: 'cfd', labelKey: 'reports:cfd.title' },
  { key: 'tasksInWindow', labelKey: 'reports:tasksInWindow.title' },
  { key: 'breakdownTables', labelKey: 'reports:widgets.breakdownTables' },
  { key: 'skillGap', labelKey: 'reports:skillGap.title' },
];

/** Ces 3 widgets partagent une seule ligne flex-wrap quand ils sont
 *  consécutifs dans l'ordre effectif (comportement par défaut = identique
 *  à aujourd'hui) ; un widget déplacé en dehors de ce trio par
 *  l'utilisateur se retrouve seul sur sa propre ligne, pleine largeur. */
const CLUSTER_ROW_KEYS = new Set<ReportWidgetKey>(['burndown', 'dueAdherence', 'agentsQuality']);

interface Props {
  projectId: string;
  monday: Date;
  /** Ouvre la TaskDetail d'une tâche (clic depuis le Skill Gap uniquement). */
  onOpenTask?: (taskId: string) => void;
}


function fmtH(min: number): string {
  const h = min / 60;
  return h >= 10 ? h.toFixed(0) + 'h' : h.toFixed(1) + 'h';
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 12500 → "12.5k" ; 850 → "850". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/** Génère et déclenche le téléchargement d'un CSV à partir d'une matrice. */
function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  // BOM pour ouvrir correctement dans Excel
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Range presets (7j / 30j / 90j / Projet) ---------- */

const PRESETS: { id: string; labelKey: string; days?: number; project?: boolean }[] = [
  { id: '7d', labelKey: 'reports:presets.7d', days: 7 },
  { id: '30d', labelKey: 'reports:presets.30d', days: 30 },
  { id: '90d', labelKey: 'reports:presets.90d', days: 90 },
  { id: 'project', labelKey: 'reports:presets.project', project: true },
];

function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function RangePresets({
  active,
  stats,
  onChange,
}: {
  active: string | null;
  stats: ProjectStats;
  onChange: (from: string, to: string, presetId: string) => void;
}) {
  const { t } = useTranslation('reports');
  const today = new Date().toISOString().slice(0, 10);

  const apply = (p: (typeof PRESETS)[number]) => {
    if (p.project && stats.startDate && stats.dueDate) {
      onChange(stats.startDate, stats.dueDate, p.id);
      return;
    }
    if (p.days != null) {
      // Fenêtre = N jours à partir d'aujourd'hui vers le futur (vue planning :
      // « qu'est-ce qui se passe dans les N prochains jours »). On clampe sur
      // le projet pour ne pas sortir des bornes utiles.
      let nFrom = today;
      if (stats.startDate && nFrom < stats.startDate) {
        nFrom = stats.startDate;
      }
      let nTo = shiftDate(nFrom, p.days - 1);
      if (stats.dueDate && nTo > stats.dueDate) {
        nTo = stats.dueDate;
      }
      // Projet entièrement passé (COMPLETED) ou futur (DRAFT) : la fenêtre « N
      // jours depuis aujourd'hui » tombe hors des bornes du projet → fenêtre
      // inversée (from > to), que l'API rejette. On retombe alors sur la plage
      // du projet.
      if (nFrom > nTo) {
        nFrom = stats.startDate ?? nTo;
        nTo = stats.dueDate ?? nFrom;
        if (nFrom > nTo) nTo = nFrom;
      }
      onChange(nFrom, nTo, p.id);
    }
  };

  return (
    <div className="row" style={{ gap: 4 }}>
      {PRESETS.map((p) => {
        const disabled = !!p.project && (!stats.startDate || !stats.dueDate);
        const isActive = active === p.id;
        const label = t(p.labelKey);
        return (
          <button
            key={p.id}
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => apply(p)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: isActive ? 'var(--accent)' : 'var(--surface)',
              color: isActive ? '#fff' : disabled ? 'var(--text-3)' : 'var(--text)',
              opacity: disabled ? 0.4 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
            title={disabled ? t('reports:noProjectDates') : t('reports:presetTitle', { label })}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Disabled card (données insuffisantes) ---------- */

function DisabledCard({
  title,
  reason,
  flex,
  minHeight,
}: {
  title: string;
  reason: string;
  flex?: string;
  minHeight?: number;
}) {
  const { t } = useTranslation('reports');
  return (
    <div
      className="card"
      style={{
        flex: flex ?? '1 1 260px',
        minWidth: 240,
        padding: 14,
        opacity: 0.6,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            color: 'var(--text-3)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '1px 6px',
          }}
        >
          {t('reports:unavailable')}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: minHeight ?? 80,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontSize: 12.5,
          color: 'var(--text-3)',
          padding: '8px 12px',
          lineHeight: 1.5,
        }}
      >
        {reason}
      </div>
    </div>
  );
}

/* ---------- KPI cards ---------- */

function Kpi({
  label,
  value,
  hint,
  accent,
  scope,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  /** Précise si la valeur reflète tout le projet ou seulement la fenêtre. */
  scope?: 'project' | 'period';
}) {
  const { t } = useTranslation('reports');
  return (
    <div
      className="card"
      style={{
        flex: '1 1 160px',
        minWidth: 160,
        gap: 4,
        background: accent ? 'var(--accent-soft, var(--surface))' : undefined,
      }}
    >
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: accent ? 'var(--accent)' : 'var(--text-3)' }}>
          {label}
        </div>
        {scope && (
          <span
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              padding: '0 4px',
              lineHeight: 1.5,
            }}
          >
            {t('reports:scope.' + scope)}
          </span>
        )}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-.02em' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{hint}</div>}
    </div>
  );
}

/* ---------- Burndown line chart ---------- */

function BurndownChart({ data }: { data: BurndownReport }) {
  const { t } = useTranslation('reports');
  const W = 720;
  const H = 220;
  const padding = { top: 16, right: 20, bottom: 28, left: 36 };
  const innerW = W - padding.left - padding.right;
  const innerH = H - padding.top - padding.bottom;
  const maxY = Math.max(data.totalScopeHours, ...data.points.map((p) => p.actualRemainingHours), 1);
  const n = Math.max(data.points.length - 1, 1);
  const x = (i: number) => padding.left + (innerW * i) / n;
  const y = (v: number) => padding.top + innerH * (1 - v / maxY);

  const idealPath = data.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.idealRemainingHours).toFixed(1)}`)
    .join(' ');
  const actualPath = data.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.actualRemainingHours).toFixed(1)}`)
    .join(' ');

  const yTicks = [0, maxY / 2, maxY];
  const { bind: tipBind, tipNode } = useChartTooltip();

  return (
   <>
    {tipNode}
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} aria-label={t('reports:burndown.ariaLabel')}>
      {/* grille Y */}
      {yTicks.map((v, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            x2={W - padding.right}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--border)"
            strokeDasharray={i === 0 ? '' : '3 3'}
          />
          <text x={padding.left - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--text-3)">
            {Math.round(v)}h
          </text>
        </g>
      ))}
      {/* axe X — labels (1ère, milieu, dernière) */}
      {[0, Math.floor(data.points.length / 2), data.points.length - 1].map((i) =>
        data.points[i] ? (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-3)">
            {data.points[i].date.slice(5)}
          </text>
        ) : null,
      )}
      {/* idéal */}
      <path d={idealPath} fill="none" stroke="var(--text-3)" strokeWidth="2" strokeDasharray="5 4" />
      {/* réel */}
      <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      {/* points réels + zone de survol (tooltip date/valeur) */}
      {data.points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.actualRemainingHours)} r="3" fill="var(--accent)" pointerEvents="none" />
          <circle cx={x(i)} cy={y(p.actualRemainingHours)} r="10" fill="transparent"
            {...tipBind(<><b>{p.date}</b><br /><span className="ct-k">{t('reports:burndown.tooltipIdealActual', { actual: Math.round(p.actualRemainingHours), ideal: Math.round(p.idealRemainingHours) })}</span></>)} />
        </g>
      ))}
    </svg>
   </>
  );
}

/* ---------- Donut due adherence ---------- */

function DueDonut({ data }: { data: DueAdherence }) {
  const { t } = useTranslation('reports');
  const total = data.totalCompleted || 1;
  const fracOn = data.onTime / total;
  const fracLate = data.late / total;
  const fracNo = data.noDeadline / total;
  const R = 38;
  const C = 2 * Math.PI * R;
  const onLen = C * fracOn;
  const lateLen = C * fracLate;
  const noLen = C * fracNo;
  const { bind: tipBind, tipNode } = useChartTooltip();
  return (
    <div className="row" style={{ alignItems: 'center', gap: 16 }}>
      {tipNode}
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--border)" strokeWidth="14" />
        {data.totalCompleted > 0 && (
          <g transform="rotate(-90 50 50)">
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--c-ok, #16a34a)"
              strokeWidth="14"
              strokeDasharray={`${onLen} ${C}`}
              {...tipBind(<><b>{t('reports:due.onTime')}</b><br /><span className="ct-k">{data.onTime} · {Math.round(fracOn * 100)}%</span></>)}
            />
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--c-warn, #dc2626)"
              strokeWidth="14"
              strokeDasharray={`${lateLen} ${C}`}
              strokeDashoffset={-onLen}
              {...tipBind(<><b>{t('reports:due.late')}</b><br /><span className="ct-k">{data.late} · {Math.round(fracLate * 100)}%</span></>)}
            />
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--text-3)"
              strokeWidth="14"
              strokeDasharray={`${noLen} ${C}`}
              strokeDashoffset={-(onLen + lateLen)}
              {...tipBind(<><b>{t('reports:due.noDeadline')}</b><br /><span className="ct-k">{data.noDeadline} · {Math.round(fracNo * 100)}%</span></>)}
            />
          </g>
        )}
        <text x="50" y="48" textAnchor="middle" fontSize="18" fontWeight="800" fill="var(--text)">
          {data.onTimePct}%
        </text>
        <text x="50" y="62" textAnchor="middle" fontSize="9" fill="var(--text-3)">
          {t('reports:due.onTimeShort')}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <Legend swatch="var(--c-ok, #16a34a)" label={t('reports:due.onTime')} value={data.onTime} />
        <Legend swatch="var(--c-warn, #dc2626)" label={t('reports:due.late')} value={data.late} />
        <Legend swatch="var(--text-3)" label={t('reports:due.noDeadline')} value={data.noDeadline} />
        <div style={{ color: 'var(--text-3)', marginTop: 4 }}>{t('reports:due.completed', { count: data.totalCompleted })}</div>
      </div>
    </div>
  );
}

function Legend({ swatch, label, value }: { swatch: string; label: string; value: number }) {
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
      <span style={{ width: 10, height: 10, background: swatch, borderRadius: 2 }} />
      <span>{label}</span>
      <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>
        {value}
      </span>
    </div>
  );
}

/* ---------- Bar row for breakdown tables ---------- */

function BreakdownTable({
  title,
  rows,
  totalMinutes,
  onExport,
}: {
  title: string;
  rows: TimeBreakdownRow[];
  totalMinutes: number;
  onExport: () => void;
}) {
  const { t } = useTranslation('reports');
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  const { bind: tipBind, tipNode } = useChartTooltip();
  return (
    <div className="card" style={{ flex: '1 1 260px', minWidth: 240, padding: 14 }}>
      {tipNode}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <button className="btn btn-sm btn-ghost" onClick={onExport} disabled={rows.length === 0}>
          <Icon name="download" size={13} /> {t('reports:csv')}
        </button>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>{t('reports:noData')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.slice(0, 8).map((r, i) => {
            const pct = totalMinutes ? Math.round((r.minutes / totalMinutes) * 100) : 0;
            const w = (r.minutes / max) * 100;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                {...tipBind(<><b>{r.name}</b><br /><span className="ct-k">{fmtH(r.minutes)} · {pct}%</span></>)}>
                <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </span>
                  <span className="mono" style={{ color: 'var(--text-3)' }}>
                    {fmtH(r.minutes)} · {pct}%
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${w}%`,
                      height: '100%',
                      background: 'var(--accent)',
                      transition: 'width .25s ease',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- Tâches sur la période ---------- */

/* ---------- Barres hebdo du throughput agents (SVG inline) ---------- */

function AgentWeeklyBars({ weekly }: { weekly: { weekStart: string; count: number }[] }) {
  const max = Math.max(...weekly.map((w) => w.count), 1);
  const n = weekly.length;
  const barW = Math.max(10, Math.min(28, Math.floor(560 / n) - 4));
  const gap = 4;
  const W = n * (barW + gap) + 24;
  const H = 96;
  const chartH = 68;
  // Étiquettes de dates : au plus ~8 ticks pour rester lisible.
  const step = Math.max(1, Math.ceil(n / 8));
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
        {weekly.map((w, i) => {
          const h = Math.round((w.count / max) * chartH);
          const x = 12 + i * (barW + gap);
          const y = 8 + (chartH - h);
          return (
            <g key={w.weekStart}>
              <rect x={x} y={y} width={barW} height={Math.max(h, w.count > 0 ? 2 : 0)} rx={2} fill="var(--accent)" opacity={0.85}>
                <title>{`${w.weekStart} — ${w.count}`}</title>
              </rect>
              {w.count > 0 && h > 14 && (
                <text x={x + barW / 2} y={y + 11} textAnchor="middle" fontSize={9} fill="#fff" fontWeight={700}>
                  {w.count}
                </text>
              )}
              {i % step === 0 && (
                <text x={x + barW / 2} y={H - 4} textAnchor="middle" fontSize={8.5} fill="var(--text-3)">
                  {w.weekStart.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const TASKS_PER_PAGE = 10;

function TasksInWindowCard({ data }: { data: TasksInWindowReportDto }) {
  const { t } = useTranslation('reports');
  const tasks = data.tasks;
  // Tri prioritaire : en retard d'abord, puis par dueDate asc, puis startDate.
  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        const ad = a.dueDate ?? '9999';
        const bd = b.dueDate ?? '9999';
        if (ad !== bd) return ad < bd ? -1 : 1;
        const as = a.startDate ?? '9999';
        const bs = b.startDate ?? '9999';
        return as < bs ? -1 : as > bs ? 1 : 0;
      }),
    [tasks],
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / TASKS_PER_PAGE));
  const [page, setPage] = useState(0);
  // Re-clamp la page si la liste rétrécit (changement de période/filtre).
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);
  const pageTasks = sorted.slice(page * TASKS_PER_PAGE, page * TASKS_PER_PAGE + TASKS_PER_PAGE);

  if (tasks.length === 0) {
    return (
      <DisabledCard
        title={t('reports:tasksInWindow.title')}
        flex="1 1 100%"
        reason={t('reports:tasksInWindow.empty')}
      />
    );
  }

  const overdueCount = tasks.filter((t) => t.overdue).length;

  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <div style={{ fontWeight: 700 }}>{t('reports:tasksInWindow.title')}</div>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              padding: '0 5px',
            }}
          >
            {t('reports:scope.period')}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('reports:tasksInWindow.taskCount', { count: tasks.length })}
            {overdueCount > 0 && (
              <span style={{ color: 'var(--c-warn, #dc2626)', marginLeft: 8 }}>
                {t('reports:tasksInWindow.overdue', { count: overdueCount })}
              </span>
            )}
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {data.from} → {data.to}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('reports:tasksInWindow.colTask')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('reports:tasksInWindow.colStatus')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('reports:tasksInWindow.colAssignees')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('reports:tasksInWindow.colStart')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('reports:tasksInWindow.colDue')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:tasksInWindow.colEstimate')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:tasksInWindow.colProgress')}</th>
            </tr>
          </thead>
          <tbody>
            {pageTasks.map((tk) => {
              const m = statusMeta(tk.status);
              return (
                <tr key={tk.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tk.title}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <span style={{ color: m.reportColor, fontWeight: 600 }}>{t('reports:status.' + m.labelSubkey)}</span>
                  </td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-3)' }}>
                    {tk.assignees.length === 0
                      ? '—'
                      : tk.assignees.map((a) => a.name).join(', ')}
                  </td>
                  <td style={{ padding: '6px 8px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {tk.startDate ?? '—'}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      color: tk.overdue ? 'var(--c-warn, #dc2626)' : 'var(--text-3)',
                      fontWeight: tk.overdue ? 600 : 400,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tk.dueDate ?? '—'}
                    {tk.overdue && ' ⚠'}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-3)' }}>
                    {tk.estimateHours != null ? `${tk.estimateHours}h` : '—'}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-3)' }}>
                    {tk.progressPct}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {t('reports:tasksInWindow.pageRange', { from: page * TASKS_PER_PAGE + 1, to: Math.min((page + 1) * TASKS_PER_PAGE, sorted.length), total: sorted.length })}
          </span>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <button
              className="btn"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t('reports:tasksInWindow.prev')}
            </button>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {page + 1} / {pageCount}
            </span>
            <button
              className="btn"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              {t('reports:tasksInWindow.nextPage')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Main view ---------- */

export function ReportsView({ projectId, monday, onOpenTask }: Props) {
  const { t } = useTranslation('reports');
  // Période par défaut : semaine en cours.
  const defaultTo = useMemo(() => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + 6);
    return fmtDate(d);
  }, [monday]);
  const [from, setFrom] = useState(fmtDate(monday));
  const [to, setTo] = useState(defaultTo);
  // Preset actif (id ou null si dates custom). Mémorisé explicitement parce
  // que les clamps sur fin de projet peuvent réduire la span (90j devient 87j),
  // donc on ne peut pas l'inférer fiable depuis from/to.
  const [activePreset, setActivePreset] = useState<string | null>(null);
  // Quand stats arrive avec les dates du projet, on les utilise comme période par
  // défaut (une seule fois — si l'utilisateur a déjà touché les champs on respecte).
  const [datesSeeded, setDatesSeeded] = useState(false);

  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [burn, setBurn] = useState<BurndownReport | null>(null);
  const [due, setDue] = useState<DueAdherence | null>(null);
  const [breakdown, setBreakdown] = useState<TimeBreakdown | null>(null);
  const [tasksWin, setTasksWin] = useState<TasksInWindowReportDto | null>(null);
  const [cfd, setCfd] = useState<ProjectCfdDto | null>(null);
  const [quality, setQuality] = useState<ProjectQualityDto | null>(null);
  const [byTeam, setByTeam] = useState<ProjectByTeamDto | null>(null);
  const [agents, setAgents] = useState<ProjectAgentReportDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportsOpen, setExportsOpen] = useState(false);
  const [exportFmt, setExportFmt] = useState<'csv' | 'xlsx'>('csv');
  const [widgetPrefs, setWidgetPrefs] = useState<ReportWidgetPreferenceDto | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  // Préférence de widgets — indépendante de la plage de dates, un seul fetch
  // par projet. Pas de ligne côté serveur = ordre du registre, rien de
  // masqué (comportement par défaut, strictement identique à aujourd'hui).
  useEffect(() => {
    let cancelled = false;
    api
      .getReportWidgets(projectId)
      .then((p) => !cancelled && setWidgetPrefs(p))
      .catch(() => !cancelled && setWidgetPrefs({ widgetOrder: [...REPORT_WIDGET_KEYS], hiddenKeys: [] }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    Promise.all([
      apiProjectStats(projectId),
      apiBurndown(projectId, from, to),
      apiDueAdherence(projectId),
      apiTimeBreakdown({ projectId, from, to }),
      apiTasksInWindow(projectId, from, to),
    ])
      .then(([s, b, d, br, tw]) => {
        if (cancelled) return;
        setStats(s);
        setBurn(b);
        setDue(d);
        setBreakdown(br);
        setTasksWin(tw);
        setLoading(false);
        api.getProjectCfd(projectId, { from, to }).then((c) => !cancelled && setCfd(c)).catch(() => {});
        api.getProjectQuality(projectId).then((q) => !cancelled && setQuality(q)).catch(() => {});
        api.getProjectAgentReport(projectId, from, to).then((a) => !cancelled && setAgents(a)).catch(() => {});
        apiProjectByTeam(projectId).then((bt) => !cancelled && setByTeam(bt)).catch(() => {});
        // Re-cale la fenêtre sur les dates du projet si elles existent, une fois.
        if (!datesSeeded && s.startDate && s.dueDate) {
          setDatesSeeded(true);
          setFrom(s.startDate);
          setTo(s.dueDate);
          setActivePreset('project');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, from, to]);

  const exportBurndown = () => {
    if (!burn) return;
    downloadCsv(`burndown-${projectId.slice(0, 8)}.csv`, [
      ['date', 'ideal_remaining_hours', 'actual_remaining_hours', 'done_tasks'],
      ...burn.points.map((p) => [p.date, p.idealRemainingHours, p.actualRemainingHours, p.doneTasks]),
    ]);
  };
  const exportRows = (kind: string, rows: TimeBreakdownRow[], cols: string[]) => () => {
    downloadCsv(`time-${kind}-${projectId.slice(0, 8)}.csv`, [
      cols,
      ...rows.map((r) =>
        cols.map((c) => {
          const v = (r as unknown as Record<string, unknown>)[c];
          if (typeof v === 'number' && c === 'minutes') return v;
          return v == null ? '' : String(v);
        }),
      ),
    ]);
  };

  if (loading)
    return (
      <div className="placeholder">
        <div style={{ opacity: 0.6 }}>{t('reports:loadingReports')}</div>
      </div>
    );
  if (err)
    return (
      <div className="placeholder">
        <div style={{ color: 'var(--c-warn, #dc2626)' }}>{t('reports:errorPrefix', { message: err })}</div>
      </div>
    );
  if (!stats || !burn || !due || !breakdown || !tasksWin) return null;

  // Couleur stable par équipe, partagée entre les deux camemberts (heures /
  // tâches) pour qu'une même équipe ait la même teinte des deux côtés.
  const teamColor = new Map<string, string>();
  if (byTeam) {
    let ci = 0;
    for (const t of [...byTeam.hoursByTeam, ...byTeam.tasksByTeam]) {
      const k = t.teamId ?? '__none__';
      if (!teamColor.has(k)) teamColor.set(k, palette(ci++));
    }
  }
  const teamSeg = (t: { teamId: string | null; teamName: string }, value: number) => ({
    label: t.teamName,
    value,
    color: teamColor.get(t.teamId ?? '__none__'),
  });
  const hasTeamData = !!byTeam && (byTeam.hoursByTeam.length > 0 || byTeam.tasksByTeam.length > 0);

  // Widgets agents IA seulement pertinents/affichables si le projet les
  // autorise — inutile d'offrir un toggle qui ne changerait jamais rien.
  const availableWidgetKeys = new Set<ReportWidgetKey>(
    WIDGET_ROWS.map((w) => w.key).filter((k) => (k === 'agentsQuality' || k === 'agents' ? !!agents?.enabled : true)),
  );

  const sectionRenderers: Partial<Record<ReportWidgetKey, () => React.ReactNode>> = {
    kpis: () => (
      // alignItems: stretch → toutes les cartes prennent la hauteur de la plus
      // haute (`.row` par défaut aligne en `center`, ce qui laissait dépasser la
      // carte dont le libellé passe sur 2 lignes, ex. « Complétion à temps »).
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <Kpi label={t('reports:kpi.tasks')} value={String(stats.totalTasks)} hint={t('reports:kpi.tasksHint', { done: stats.byStatus.DONE, inProgress: stats.byStatus.IN_PROGRESS })} scope="project" />
        <Kpi label={t('reports:kpi.progress')} value={`${stats.completionPct}%`} hint={t('reports:kpi.progressHint', { done: stats.doneEstimateHours, total: stats.totalEstimateHours })} accent scope="project" />
        <Kpi label={t('reports:kpi.remaining')} value={`${stats.remainingEstimateHours}h`} hint={t('reports:kpi.remainingHint', { todo: stats.byStatus.TODO, review: stats.byStatus.IN_REVIEW })} scope="project" />
        <Kpi label={t('reports:kpi.overdue')} value={String(stats.overdueTasks)} hint={stats.overdueTasks > 0 ? t('reports:kpi.overdueToHandle') : t('reports:kpi.overdueNothing')} scope="project" />
        <Kpi
          label={t('reports:kpi.onTimeCompletion')}
          value={due.onTimeCompletionPct == null ? '—' : `${due.onTimeCompletionPct}%`}
          hint={due.onTimeCompletionPct == null ? t('reports:kpi.onTimeCompletionNone') : t('reports:kpi.onTimeCompletionHint', { onTime: due.onTime, total: due.onTime + due.late })}
          accent
          scope="project"
        />
        <Kpi label={t('reports:kpi.timeSpent')} value={fmtH(stats.totalSpentMinutes)} hint={t('reports:kpi.timeSpentHint', { count: breakdown.byUser.length })} scope="project" />
      </div>
    ),

    burndown: () =>
      !stats.startDate || !stats.dueDate ? (
        <DisabledCard title={t('reports:burndown.title')} flex="2 1 480px" minHeight={220} reason={t('reports:burndown.noDates')} />
      ) : burn.totalScopeHours === 0 ? (
        <DisabledCard title={t('reports:burndown.title')} flex="2 1 480px" minHeight={220} reason={t('reports:burndown.noEstimates')} />
      ) : (
        <div className="card" style={{ flex: '2 1 480px', minWidth: 320, padding: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontWeight: 700 }}>{t('reports:burndown.title')}</div>
            <button className="btn btn-sm btn-ghost" onClick={exportBurndown}>
              <Icon name="download" size={13} /> {t('reports:csv')}
            </button>
          </div>
          <BurndownChart data={burn} />
          <div className="row" style={{ gap: 14, fontSize: 12, color: 'var(--text-3)', marginTop: 6, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 18, height: 0, borderTop: '2px dashed var(--text-3)' }} /> {t('reports:burndown.ideal')}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span style={{ width: 18, height: 0, borderTop: '2.5px solid var(--accent)' }} /> {t('reports:burndown.actual')}
            </span>
            {(burn.from !== burn.referenceFrom || burn.to !== burn.referenceTo) && (
              <span
                className="mono"
                style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px' }}
                title={t('reports:burndown.zoomRefTitle', { from: burn.referenceFrom, to: burn.referenceTo })}
              >
                {t('reports:burndown.zoomRef', { from: burn.referenceFrom, to: burn.referenceTo })}
              </span>
            )}
            <span style={{ marginLeft: 'auto' }}>{t('reports:burndown.totalScope', { hours: burn.totalScopeHours })}</span>
          </div>
        </div>
      ),

    dueAdherence: () =>
      due.totalCompleted === 0 ? (
        <DisabledCard title={t('reports:dueAdherence.title')} flex="1 1 240px" reason={t('reports:dueAdherence.empty')} />
      ) : (
        <div className="card" style={{ flex: '1 1 240px', minWidth: 240, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('reports:dueAdherence.title')}</div>
          <DueDonut data={due} />
        </div>
      ),

    // Qualité livrables agents IA — visible seulement si le projet autorise
    // les agents (Project.agentsEnabled).
    agentsQuality: () =>
      !agents?.enabled ? null : (
        <div className="card" style={{ flex: '1 1 240px', minWidth: 240, padding: 14, display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('reports:agents.qualityTitle')}</div>
          {agents.approvedDeliverables === 0 ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5, padding: '8px 12px' }}>
              {t('reports:agents.noReviewData')}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center' }}>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-3)', fontWeight: 600 }}>
                  {t('reports:agents.firstPass')}
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: '#16a34a' }}>{agents.firstPassApprovalPct}%</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  {t('reports:agents.firstPassHint', { count: agents.approvedDeliverables })}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-3)', fontWeight: 600 }}>
                  {t('reports:agents.rework')}
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: agents.avgReviewRounds != null && agents.avgReviewRounds > 1.5 ? '#f97316' : undefined }}>
                  {agents.avgReviewRounds ?? '—'}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('reports:agents.reworkHint')}</div>
              </div>
            </div>
          )}
        </div>
      ),

    // Répartition par équipe (heures assignées / tâches assignées).
    teamBreakdown: () =>
      !hasTeamData ? null : (
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div className="card" style={{ flex: '1 1 320px', minWidth: 280, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('reports:byTeam.hoursTitle')}</div>
            <PieChart
              segments={byTeam!.hoursByTeam.map((tm) => teamSeg(tm, tm.hours))}
              fmt={(n) => `${Math.round(n * 10) / 10}h`}
              centerLabel={`${Math.round(byTeam!.hoursByTeam.reduce((s, tm) => s + tm.hours, 0))}h`}
              centerSub={t('reports:byTeam.hoursCenterSub')}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{t('reports:byTeam.hoursNote')}</div>
          </div>
          <div className="card" style={{ flex: '1 1 320px', minWidth: 280, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('reports:byTeam.tasksTitle')}</div>
            <PieChart
              segments={byTeam!.tasksByTeam.map((tm) => teamSeg(tm, tm.count))}
              fmt={(n) => `${Math.round(n * 10) / 10}`}
              centerLabel={String(Math.round(byTeam!.tasksByTeam.reduce((s, tm) => s + tm.count, 0)))}
              centerSub={t('reports:byTeam.tasksCenterSub')}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{t('reports:byTeam.tasksNote')}</div>
          </div>
        </div>
      ),

    quality: () =>
      !quality || quality.totalTasks === 0 ? null : (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>{t('reports:quality.title')}</div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <Kpi label={t('reports:quality.reworkRate')} value={`${quality.reworkRatePct}%`} hint={t('reports:quality.reworkHint', { reworked: quality.reworkedTasks, total: quality.totalTasks })} />
            <Kpi label={t('reports:quality.bugs')} value={String(quality.bugCount)} hint={t('reports:quality.bugsHint', { pct: quality.bugRatePct })} accent />
            <Kpi
              label={t('reports:quality.scopeCreep')}
              value={quality.hasBaselineDate ? `+${quality.scopeAddedTasks}` : '—'}
              hint={quality.hasBaselineDate ? t('reports:quality.scopeCreepHint', { hours: quality.scopeAddedEstimateHours }) : t('reports:quality.scopeCreepNoBaseline')}
            />
          </div>
        </div>
      ),

    // Agents IA — throughput, activité & détail par agent. Visible seulement
    // si le projet autorise les agents (Project.agentsEnabled).
    agents: () =>
      !agents?.enabled ? null : (
        <div className="card" style={{ padding: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontWeight: 700 }}>{t('reports:agents.title')}</div>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {agents.from} → {agents.to}
            </span>
          </div>
          {agents.tasksCompleted === 0 && agents.runs === 0 && agents.perAgent.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '12px 0', textAlign: 'center' }}>
              {t('reports:agents.noActivity')}
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 12, alignItems: 'stretch' }}>
                <Kpi label={t('reports:agents.kpiThroughput')} value={String(agents.tasksCompleted)} hint={t('reports:agents.kpiThroughputHint')} accent scope="period" />
                <Kpi label={t('reports:agents.kpiActive')} value={String(agents.activeAgents)} hint={t('reports:agents.kpiActiveHint')} scope="period" />
                <Kpi
                  label={t('reports:agents.kpiRuns')}
                  value={String(agents.runs)}
                  hint={t('reports:agents.kpiRunsHint', { tokens: fmtTokens(agents.tokensIn + agents.tokensOut) })}
                  scope="period"
                />
                <Kpi
                  label={t('reports:agents.kpiTurnaround')}
                  value={agents.avgReviewTurnaroundHours == null ? '—' : `${agents.avgReviewTurnaroundHours}h`}
                  hint={t('reports:agents.kpiTurnaroundHint')}
                  scope="period"
                />
              </div>
              {agents.weekly.some((w) => w.count > 0) && agents.weekly.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>
                    {t('reports:agents.weeklyTitle')}
                  </div>
                  <AgentWeeklyBars weekly={agents.weekly} />
                </div>
              )}
              {agents.perAgent.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                        <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('reports:agents.colAgent')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colTasks')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colDeliverables')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colApproved')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colFirstPass')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colRounds')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colRuns')}</th>
                        <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>{t('reports:agents.colTokens')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.perAgent.map((a) => (
                        <tr key={a.agentId} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 8px', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }} className="mono">{a.tasksCompleted}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }} className="mono">{a.deliverables}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }} className="mono">{a.approved}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: a.firstPassPct != null && a.firstPassPct < 50 ? '#f97316' : undefined }} className="mono">
                            {a.firstPassPct == null ? '—' : `${a.firstPassPct}%`}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }} className="mono">{a.avgRounds ?? '—'}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }} className="mono">{a.runs}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }} className="mono">{fmtTokens(a.tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      ),

    cfd: () =>
      !cfd || cfd.points.length <= 1 ? null : (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('reports:cfd.title')}</div>
          <CfdChart points={cfd.points} fmt={(n) => String(n)} />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{t('reports:cfd.note')}</div>
        </div>
      ),

    tasksInWindow: () => <TasksInWindowCard data={tasksWin} />,

    breakdownTables: () =>
      breakdown.totalMinutes === 0 ? (
        <DisabledCard title={t('reports:breakdown.title')} flex="1 1 100%" reason={t('reports:breakdown.empty')} />
      ) : (
        <>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <BreakdownTable
              title={t('reports:breakdown.byUser')}
              rows={breakdown.byUser}
              totalMinutes={breakdown.totalMinutes}
              onExport={exportRows('by-user', breakdown.byUser, ['name', 'email', 'minutes', 'billable'])}
            />
            <BreakdownTable
              title={t('reports:breakdown.byLabel')}
              rows={breakdown.byLabel}
              totalMinutes={breakdown.totalMinutes}
              onExport={exportRows('by-label', breakdown.byLabel, ['name', 'minutes'])}
            />
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Kpi label={t('reports:kpi.totalTime')} value={fmtH(breakdown.totalMinutes)} scope="period" />
            <Kpi label={t('reports:kpi.billable')} value={fmtH(breakdown.billableMinutes)} accent scope="period" />
            <Kpi label={t('reports:kpi.nonBillable')} value={fmtH(breakdown.nonBillableMinutes)} scope="period" />
          </div>
        </>
      ),

    // Skill Gap par projet (Phase F) — visible PM / lead équipe / portfolio /
    // admin uniquement. Le composant gère lui-même le 403 et l'affiche en
    // mode "réservé aux managers".
    skillGap: () => (
      <section style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{t('reports:skillGap.title')}</h3>
        <ProjectSkillGapView
          projectId={projectId}
          onOpenTask={onOpenTask}
          flash={(msg) => {
            // ReportsView n'a pas de flash bar dédié — on log juste les
            // erreurs non-403 dans la console pour ne pas polluer.
            // eslint-disable-next-line no-console
            console.warn('[skill-gap]', msg);
          }}
        />
      </section>
    ),
  };

  const effectiveOrder = widgetPrefs?.widgetOrder ?? [...REPORT_WIDGET_KEYS];
  const hiddenSet = new Set(widgetPrefs?.hiddenKeys ?? []);
  const visibleOrder = effectiveOrder.filter((k) => !hiddenSet.has(k) && sectionRenderers[k]);

  // Regroupe les runs consécutifs de CLUSTER_ROW_KEYS dans une seule ligne
  // flex-wrap (comportement identique à aujourd'hui en ordre par défaut) ;
  // tout le reste rend en ligne pleine largeur, indépendamment.
  const renderNodes: React.ReactNode[] = [];
  {
    let i = 0;
    while (i < visibleOrder.length) {
      const k = visibleOrder[i];
      if (CLUSTER_ROW_KEYS.has(k)) {
        const run: ReportWidgetKey[] = [];
        while (i < visibleOrder.length && CLUSTER_ROW_KEYS.has(visibleOrder[i])) {
          run.push(visibleOrder[i]);
          i++;
        }
        renderNodes.push(
          <div key={run.join('-')} className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {run.map((rk) => (
              <Fragment key={rk}>{sectionRenderers[rk]!()}</Fragment>
            ))}
          </div>,
        );
      } else {
        renderNodes.push(<Fragment key={k}>{sectionRenderers[k]!()}</Fragment>);
        i++;
      }
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 24px 32px' }}>
      {/* Période */}
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: '-.01em' }}>
          {t('reports:title', { key: stats.projectKey })}
        </h2>
        <RangePresets
          active={activePreset}
          stats={stats}
          onChange={(nf, nt, presetId) => {
            setFrom(nf);
            setTo(nt);
            setActivePreset(presetId);
          }}
        />
        <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
          <button
            className="btn btn-sm"
            onClick={() => setCustomizeOpen(true)}
            title={t('reports:widgets.customizeButtonTitle')}
          >
            <Icon name="grip" size={13} /> {t('reports:widgets.customizeButton')}
          </button>
          <button
            className="btn btn-sm btn-accent"
            onClick={() => setExportsOpen(true)}
            title={t('reports:exports.buttonTitle')}
          >
            <Icon name="download" size={13} /> {t('reports:exports.button')}
          </button>
          <label className="row" style={{ gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
            {t('reports:dateFrom')}{' '}
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setActivePreset(null);
              }}
              style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px' }}
            />
          </label>
          <label className="row" style={{ gap: 4, fontSize: 12, color: 'var(--text-3)' }}>
            {t('reports:dateTo')}{' '}
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setActivePreset(null);
              }}
              style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px' }}
            />
          </label>
        </div>
      </div>

      {/* Panneau latéral droit — exports CSV (côté serveur, dataset complet) */}
      {exportsOpen && (
        <div
          onClick={() => setExportsOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 60 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              height: '100%',
              width: 'min(340px, 92vw)',
              background: 'var(--surface)',
              borderLeft: '1px solid var(--border)',
              boxShadow: '-8px 0 30px rgba(0,0,0,.3)',
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              overflowY: 'auto',
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{t('reports:exports.panelTitle')}</div>
              <button className="icon-btn" onClick={() => setExportsOpen(false)} aria-label={t('common:close')}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {t('reports:exports.fullDataset', { from, to })}
            </div>

            {/* Sélecteur de format (données tabulaires) */}
            <div className="row" style={{ gap: 6 }}>
              {(['csv', 'xlsx'] as const).map((f) => (
                <button
                  key={f}
                  className={`btn ${exportFmt === f ? 'btn-primary' : 'btn-line'}`}
                  style={{ flex: 1, justifyContent: 'center' }}
                  onClick={() => setExportFmt(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>

            {(() => {
              const ext = exportFmt;
              const items: [string, string][] =
                ext === 'xlsx'
                  ? [
                      ['projectStats', `/projects/${projectId}/stats.xlsx`],
                      ['burndown', `/projects/${projectId}/burndown.xlsx?from=${from}&to=${to}`],
                      ['dueAdherence', `/projects/${projectId}/due-adherence.xlsx`],
                      ['tasksWindow', `/projects/${projectId}/tasks-in-window.xlsx?from=${from}&to=${to}`],
                      ['timeBreakdown3', `/reports/time-breakdown.xlsx?from=${from}&to=${to}&projectId=${projectId}`],
                      ['timeEntriesDetail', `/time-entries.xlsx?from=${from}&to=${to}&projectId=${projectId}`],
                    ]
                  : [
                      ['projectStats', `/projects/${projectId}/stats.csv`],
                      ['burndown', `/projects/${projectId}/burndown.csv?from=${from}&to=${to}`],
                      ['dueAdherence', `/projects/${projectId}/due-adherence.csv`],
                      ['tasksWindow', `/projects/${projectId}/tasks-in-window.csv?from=${from}&to=${to}`],
                      ['timeByProject', `/reports/time-breakdown.csv?from=${from}&to=${to}&by=project`],
                      ['timeByUser', `/reports/time-breakdown.csv?from=${from}&to=${to}&by=user`],
                      ['timeByLabel', `/reports/time-breakdown.csv?from=${from}&to=${to}&by=label`],
                      ['timeEntriesDetail', `/time-entries.csv?from=${from}&to=${to}&projectId=${projectId}`],
                    ];
              if (agents?.enabled) {
                items.push(['agentsReport', `/projects/${projectId}/agents-report.${ext}?from=${from}&to=${to}`]);
              }
              return items.map(([itemKey, path]) => {
                const label = t('reports:exports.items.' + itemKey);
                return (
                  <button
                    key={itemKey}
                    className="btn btn-line"
                    style={{ justifyContent: 'flex-start', gap: 8 }}
                    onClick={() =>
                      api
                        .downloadCsv(path, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${ext}`)
                        .catch((e) => setErr((e as Error).message))
                    }
                  >
                    <Icon name="download" size={14} /> {label}
                  </button>
                );
              });
            })()}

            {/* Rapports PDF mis en forme (KPIs + graphiques) */}
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 8, color: 'var(--text-2)' }}>{t('reports:exports.pdfReports')}</div>
            {(
              [
                ['projectReport', `/projects/${projectId}/report.pdf?from=${from}&to=${to}`],
                ['timeBreakdown', `/reports/time-breakdown.pdf?from=${from}&to=${to}&projectId=${projectId}`],
              ] as [string, string][]
            ).map(([itemKey, path]) => {
              const label = t('reports:exports.items.' + itemKey);
              return (
                <button
                  key={itemKey}
                  className="btn btn-line"
                  style={{ justifyContent: 'flex-start', gap: 8 }}
                  onClick={() =>
                    api
                      .downloadCsv(path, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`)
                      .catch((e) => setErr((e as Error).message))
                  }
                >
                  <Icon name="download" size={14} /> {label}
                </button>
              );
            })}

            {/* Point de statut client (PowerPoint) */}
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 8, color: 'var(--text-2)' }}>{t('reports:exports.clientDeck')}</div>
            <button
              className="btn btn-line"
              style={{ justifyContent: 'flex-start', gap: 8 }}
              onClick={() =>
                api
                  .downloadCsv(`/projects/${projectId}/status-deck.pptx`, `status-${projectId}.pptx`)
                  .catch((e) => setErr((e as Error).message))
              }
            >
              <Icon name="download" size={14} /> {t('reports:exports.items.clientStatusDeck')}
            </button>
          </div>
        </div>
      )}

      {/* Panneau "Personnaliser" — show/hide + reorder des widgets */}
      {customizeOpen && (
        <ReportWidgetsPanel
          widgets={WIDGET_ROWS}
          availableKeys={availableWidgetKeys}
          widgetOrder={widgetPrefs?.widgetOrder ?? [...REPORT_WIDGET_KEYS]}
          hiddenKeys={widgetPrefs?.hiddenKeys ?? []}
          onSave={(next) => {
            setWidgetPrefs(next);
            api.putReportWidgets(projectId, next).catch((e) => setErr((e as Error).message));
          }}
          onClose={() => setCustomizeOpen(false)}
        />
      )}

      {renderNodes}
    </div>
  );
}
