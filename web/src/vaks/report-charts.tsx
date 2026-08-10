/* ============================================================
   Vaks — report charts (EVM line, CFD stacked area, capacity matrix,
   status columns). Pure inline SVG, custom tooltip.
   ============================================================ */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useChartTooltip } from './chart-tooltip';
import { palette } from './finance-charts';
// Les légendes de ces graphes utilisent `.finc-dot`/`.finc-dual-legend` (pastilles
// de couleur + espacement). Ces classes vivent dans finances.css : sans cet import,
// une vue hôte qui ne charge pas finances.css (ex. ReportsView) rend une légende
// SANS pastilles et labels collés (audit UI 2026-08-02). On l'importe ici pour que
// tout consommateur de ces charts ait le style, quelle que soit la vue.
import './finances.css';
// Le FOLD des statuts agents et `foldedStatusCount` vivent dans le module
// central `taskStatus.ts` (source unique de vérité). On les ré-exporte ici
// pour ne pas casser les consommateurs (TeamReportView) qui les importaient
// depuis ce fichier.
export { foldedStatusCount } from './taskStatus';

/* ---- task status palette (shared by CFD + status columns) ----
   Labels are resolved via i18n at call sites; the map carries colors +
   the translation key for the status label. Palette d'affichage propre à ces
   graphes (5 colonnes canoniques) — distincte des teintes Gantt / couleurs
   Reports ; le fold, lui, est centralisé. */
export const TASK_STATUS_META: Record<string, { labelKey: string; color: string }> = {
  TODO: { labelKey: 'reports:charts.status.todo', color: 'oklch(0.7 0.02 260)' },
  IN_PROGRESS: { labelKey: 'reports:charts.status.inProgress', color: 'oklch(0.62 0.14 250)' },
  IN_REVIEW: { labelKey: 'reports:charts.status.inReview', color: 'var(--info)' },
  ON_HOLD: { labelKey: 'reports:charts.status.onHold', color: 'oklch(0.62 0.16 300)' },
  DONE: { labelKey: 'reports:charts.status.done', color: 'oklch(0.62 0.13 155)' },
};
export const STATUS_ORDER = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'ON_HOLD', 'DONE'];

const MONTH_KEYS = ['', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const shortDate = (iso: string) => {
  const mm = Number(iso.slice(5, 7));
  return `${iso.slice(8, 10)}/${mm}`;
};

/* ============================================================ Cumulative PV vs AC line */
export function PvAcLine({
  data,
  fmt,
}: {
  data: Array<{ month: string; pv: number | null; ac: number }>;
  fmt: (n: number) => string;
}) {
  const { t } = useTranslation('reports');
  const { bind, tipNode } = useChartTooltip();
  const H = 240;
  const pad = { top: 16, right: 16, bottom: 28, left: 60 };
  const n = Math.max(1, data.length);
  const W = pad.left + pad.right + Math.max(1, n - 1) * 70 + 20;
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const maxV = Math.max(1, ...data.flatMap((d) => [d.pv ?? 0, d.ac]));
  const x = (i: number) => pad.left + (innerW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + innerH - (v / maxV) * innerH;
  const monthLbl = (m: string) => {
    const mm = Number(m.slice(5, 7));
    const k = MONTH_KEYS[mm];
    return k ? t('reports:charts.months.' + k) : m;
  };
  const line = (key: 'pv' | 'ac') =>
    data
      .map((d, i) => (d[key] == null ? null : `${x(i).toFixed(1)},${y(d[key] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  return (
    <div style={{ overflowX: 'auto' }}>
      {tipNode}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH * (1 - g)} y2={pad.top + innerH * (1 - g)} stroke="var(--border)" />
            <text x={pad.left - 6} y={pad.top + innerH * (1 - g) + 3} textAnchor="end" fontSize={9} fill="var(--text-3)">{fmt(maxV * g)}</text>
          </g>
        ))}
        <polyline points={line('pv')} fill="none" stroke="var(--text-3)" strokeWidth={2} strokeDasharray="5 4" />
        <polyline points={line('ac')} fill="none" stroke="oklch(0.6 0.16 25)" strokeWidth={2.5} />
        {data.map((d, i) => (
          <g key={d.month}>
            <rect x={x(i) - 18} y={pad.top} width={36} height={innerH} fill="transparent"
              {...bind(<><b>{monthLbl(d.month)} {d.month.slice(0, 4)}</b><br /><span className="ct-k">{t('reports:charts.planned')}</span> {d.pv == null ? '—' : fmt(d.pv)} · <span className="ct-k">{t('reports:charts.actual')}</span> {fmt(d.ac)}</>)} />
            {d.pv != null && <circle cx={x(i)} cy={y(d.pv)} r={2.3} fill="var(--text-3)" pointerEvents="none" />}
            <circle cx={x(i)} cy={y(d.ac)} r={2.6} fill="oklch(0.6 0.16 25)" pointerEvents="none" />
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={9.5} fill="var(--text-3)" pointerEvents="none">{monthLbl(d.month)}</text>
          </g>
        ))}
      </svg>
      <div className="finc-dual-legend" style={{ paddingLeft: pad.left }}>
        <span><i className="finc-dot" style={{ background: 'var(--text-3)' }} /> {t('reports:charts.plannedValue')}</span>
        <span><i className="finc-dot" style={{ background: 'oklch(0.6 0.16 25)' }} /> {t('reports:charts.actualCost')}</span>
      </div>
    </div>
  );
}

/* ============================================================ CFD (stacked area by status) */
export function CfdChart({
  points,
  fmt,
}: {
  points: Array<{ date: string; [status: string]: number | string }>;
  fmt: (n: number) => string;
}) {
  const num = (p: { [k: string]: number | string }, k: string) => Number(p[k] ?? 0);
  const { t } = useTranslation('reports');
  const { bind, tipNode } = useChartTooltip();
  const H = 240;
  const pad = { top: 14, right: 14, bottom: 26, left: 40 };
  const n = Math.max(1, points.length);
  const W = pad.left + pad.right + Math.max(360, (n - 1) * 22);
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const totals = points.map((p) => STATUS_ORDER.reduce((s, k) => s + num(p, k), 0));
  const maxV = Math.max(1, ...totals);
  const x = (i: number) => pad.left + (innerW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + innerH - (v / maxV) * innerH;
  // Build stacked area polygons per status (bottom→top in STATUS_ORDER).
  const cum = points.map(() => 0);
  const areas = STATUS_ORDER.map((k) => {
    const lower = points.map((_, i) => cum[i]);
    points.forEach((p, i) => (cum[i] += num(p, k)));
    const upper = points.map((_, i) => cum[i]);
    const top = upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const bot = lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ');
    return { key: k, points: `${top} ${bot}` };
  });
  return (
    <div style={{ overflowX: 'auto' }}>
      {tipNode}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH * (1 - g)} y2={pad.top + innerH * (1 - g)} stroke="var(--border)" />
            <text x={pad.left - 6} y={pad.top + innerH * (1 - g) + 3} textAnchor="end" fontSize={9} fill="var(--text-3)">{Math.round(maxV * g)}</text>
          </g>
        ))}
        {areas.map((a) => (
          <polygon key={a.key} points={a.points} fill={TASK_STATUS_META[a.key].color} opacity={0.92} />
        ))}
        {points.map((p, i) => (
          <rect key={p.date} x={x(i) - (innerW / Math.max(1, n - 1)) / 2} y={pad.top} width={Math.max(8, innerW / Math.max(1, n - 1))} height={innerH} fill="transparent"
            {...bind(<><b>{p.date}</b><br />{STATUS_ORDER.map((k) => (p[k] ? <span key={k} className="ct-k">{t(TASK_STATUS_META[k].labelKey)}: {p[k]}  </span> : null))}</>)} />
        ))}
      </svg>
      <div className="finc-dual-legend" style={{ paddingLeft: pad.left, flexWrap: 'wrap' }}>
        {STATUS_ORDER.map((k) => (
          <span key={k}><i className="finc-dot" style={{ background: TASK_STATUS_META[k].color }} /> {t(TASK_STATUS_META[k].labelKey)}</span>
        ))}
      </div>
      {points.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', paddingLeft: pad.left, marginTop: 2 }}>
          {shortDate(points[0].date)} → {shortDate(points[points.length - 1].date)}
        </div>
      )}
    </div>
  );
}

/* ============================================================ Stacked columns (vertical) */
export interface ColumnDef {
  label: string;
  /** Pour le mode capacité : capacité totale (= 100%). */
  reference?: number;
  segments: Array<{ key: string; label: string; color: string; value: number }>;
}
export function StackedColumns({
  columns,
  fmt,
  mode = 'absolute',
  refLabelPct = 100,
}: {
  columns: ColumnDef[];
  fmt: (n: number) => string;
  /** 'percent' = chaque colonne ÷ reference → %, ligne de réf à 100%. 'absolute' = échelle au max. */
  mode?: 'percent' | 'absolute';
  refLabelPct?: number;
}) {
  const { bind, tipNode } = useChartTooltip();
  const H = 230;
  const pad = { top: 16, right: 12, bottom: 40, left: 40 };
  const totals = columns.map((c) => c.segments.reduce((s, x) => s + x.value, 0));
  // domaine
  let maxV: number;
  const colPct = (i: number) =>
    mode === 'percent' && columns[i].reference ? (totals[i] / (columns[i].reference as number)) * 100 : totals[i];
  if (mode === 'percent') maxV = Math.max(120, ...columns.map((_, i) => colPct(i)));
  else maxV = Math.max(1, ...totals);
  const colW = 46;
  const barW = 26;
  const W = pad.left + pad.right + Math.max(1, columns.length) * colW;
  const innerH = H - pad.top - pad.bottom;
  const y = (v: number) => pad.top + innerH - (v / maxV) * innerH;
  return (
    <div style={{ overflowX: 'auto' }}>
      {tipNode}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: columns.length <= 10 ? '100%' : undefined }}>
        {/* gridlines */}
        {[0, 0.5, 1].map((g) => (
          <line key={g} x1={pad.left} x2={W - pad.right} y1={y(maxV * g)} y2={y(maxV * g)} stroke="var(--border)" />
        ))}
        {/* 100% reference (percent mode) */}
        {mode === 'percent' && refLabelPct <= maxV && (
          <g>
            <line x1={pad.left} x2={W - pad.right} y1={y(refLabelPct)} y2={y(refLabelPct)} stroke="var(--c-over)" strokeWidth={1.4} strokeDasharray="4 3" />
            <text x={W - pad.right} y={y(refLabelPct) - 3} textAnchor="end" fontSize={9} fill="var(--c-over)">{refLabelPct}%</text>
          </g>
        )}
        {columns.map((c, i) => {
          const cx = pad.left + i * colW + colW / 2;
          const scale = mode === 'percent' && c.reference ? 100 / (c.reference as number) : 1;
          let acc = 0;
          const tot = totals[i];
          const pct = mode === 'percent' && c.reference ? Math.round((tot / (c.reference as number)) * 100) : null;
          return (
            <g key={c.label + i}>
              {c.segments.map((s, si) => {
                const v0 = acc; acc += s.value;
                const top = y((v0 + s.value) * scale);
                const bot = y(v0 * scale);
                return (
                  <rect key={si} x={cx - barW / 2} y={top} width={barW} height={Math.max(0, bot - top)} fill={s.color}
                    {...bind(<><b>{c.label}</b><br /><span className="ct-k">{s.label}</span> {fmt(s.value)}{pct != null ? ` · ${Math.round((s.value / (c.reference as number)) * 100)}%` : ''}</>)} />
                );
              })}
              {tot === 0 && <rect x={cx - barW / 2} y={y(0) - 2} width={barW} height={2} fill="var(--surface-3)" />}
              <text x={cx} y={H - 26} textAnchor="end" fontSize={9} fill="var(--text-3)" transform={`rotate(-35 ${cx} ${H - 26})`}>{c.label.length > 12 ? c.label.slice(0, 11) + '…' : c.label}</text>
              {pct != null && <text x={cx} y={Math.max(pad.top + 8, y((tot * scale)) - 4)} textAnchor="middle" fontSize={9} fontWeight={700} fill={pct > 100 ? 'var(--c-over)' : 'var(--text-3)'}>{pct}%</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
