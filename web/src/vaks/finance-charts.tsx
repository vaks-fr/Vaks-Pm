/* ============================================================
   Vaks — Finance charts (pure inline SVG, no chart lib)
   Donut/pie, horizontal bars, grouped monthly bars.
   ============================================================ */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useChartTooltip, axisLabelPad } from './chart-tooltip';

const PALETTE_HUES = [285, 215, 25, 155, 330, 195, 60, 240, 120, 0, 175, 300];
export function palette(i: number): string {
  return `oklch(0.63 0.15 ${PALETTE_HUES[i % PALETTE_HUES.length]})`;
}

export interface Segment { label: string; value: number; color?: string }

/* ---------------- Donut / pie with legend ---------------- */
export function PieChart({
  segments,
  fmt,
  size = 132,
  thickness = 20,
  centerLabel,
  centerSub,
}: {
  segments: Segment[];
  fmt: (n: number) => string;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const { t } = useTranslation('finances');
  const { bind, tipNode } = useChartTooltip();
  const segs = segments.filter((s) => s.value > 0);
  const total = segs.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="finc-pie">
      {tipNode}
      <div className="finc-pie-ring" style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        {total <= 0 ? (
          <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
          </svg>
        ) : (
          <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
            <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              {segs.map((s, i) => {
                const len = (s.value / total) * C;
                const pct = Math.round((s.value / total) * 100);
                const el = (
                  <circle
                    key={i}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={s.color ?? palette(i)}
                    strokeWidth={thickness}
                    strokeDasharray={`${len} ${C - len}`}
                    strokeDashoffset={-offset}
                    {...bind(<><b>{s.label}</b><br /><span className="ct-k">{fmt(s.value)} · {pct}%</span></>)}
                  />
                );
                offset += len;
                return el;
              })}
            </g>
          </svg>
        )}
        {(centerLabel || centerSub) && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none' }}>
            <div style={{ maxWidth: size - thickness * 2 - 4, overflow: 'hidden' }}>
              {centerLabel && <div className="mono" style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-.01em', lineHeight: 1.05, whiteSpace: 'nowrap' }}>{centerLabel}</div>}
              {centerSub && <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>{centerSub}</div>}
            </div>
          </div>
        )}
      </div>
      <div className="finc-legend">
        {segs.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('finances:common.noData')}</div>}
        {segs.map((s, i) => (
          <div key={s.label + i} className="finc-legend-row">
            <span className="finc-dot" style={{ background: s.color ?? palette(i) }} />
            <span className="finc-legend-key truncate" title={s.label}>{s.label}</span>
            <span className="finc-legend-pct mono">{total ? Math.round((s.value / total) * 100) : 0}%</span>
            <span className="finc-legend-val mono">{fmt(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Horizontal bars (single series) ---------------- */
export function HBars({
  items,
  fmt,
  color,
}: {
  items: Array<{ label: string; value: number; color?: string }>;
  fmt: (n: number) => string;
  color?: string;
}) {
  const { t } = useTranslation('finances');
  const { bind, tipNode } = useChartTooltip();
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <div className="finc-hbars">
      {tipNode}
      {items.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('finances:common.noData')}</div>}
      {items.map((it, i) => (
        <div key={it.label + i} className="finc-hbar-row" {...bind(<><b>{it.label}</b><br /><span className="ct-k">{fmt(it.value)}</span></>)}>
          <span className="finc-hbar-key truncate">{it.label}</span>
          <span className="finc-hbar-track">
            <span className="finc-hbar-fill" style={{ width: (Math.abs(it.value) / max) * 100 + '%', background: it.color ?? color ?? palette(i) }} />
          </span>
          <span className="finc-hbar-val mono">{fmt(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Grouped bars: revenue vs cost per row ---------------- */
export function DualBars({
  items,
  fmt,
}: {
  items: Array<{ label: string; revenue: number; cost: number }>;
  fmt: (n: number) => string;
}) {
  const { t } = useTranslation('finances');
  const { bind, tipNode } = useChartTooltip();
  const max = Math.max(1, ...items.flatMap((i) => [i.revenue, i.cost]));
  return (
    <div className="finc-hbars">
      {tipNode}
      <div className="finc-dual-legend">
        <span><i className="finc-dot" style={{ background: 'oklch(0.62 0.13 155)' }} /> {t('finances:charts.revenue')}</span>
        <span><i className="finc-dot" style={{ background: 'oklch(0.6 0.16 25)' }} /> {t('finances:charts.cost')}</span>
      </div>
      {items.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('finances:common.noData')}</div>}
      {items.map((it, i) => (
        <div key={it.label + i} className="finc-dual-row"
          {...bind(<><b>{it.label}</b><br /><span className="ct-k">{t('finances:charts.revenue')}</span> {fmt(it.revenue)} · <span className="ct-k">{t('finances:charts.cost')}</span> {fmt(it.cost)}</>)}>
          <span className="finc-hbar-key truncate">{it.label}</span>
          <span className="finc-dual-bars">
            <span className="finc-dual-track">
              <span className="finc-hbar-fill" style={{ width: (it.revenue / max) * 100 + '%', background: 'oklch(0.62 0.13 155)' }}><span className="finc-dual-tip mono">{fmt(it.revenue)}</span></span>
            </span>
            <span className="finc-dual-track">
              <span className="finc-hbar-fill" style={{ width: (it.cost / max) * 100 + '%', background: 'oklch(0.6 0.16 25)' }}><span className="finc-dual-tip mono">{fmt(it.cost)}</span></span>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Monthly grouped bars (cost vs revenue) + margin line ---------------- */
export function MonthlyChart({
  data,
  fmt,
}: {
  data: Array<{ month: string; cost: number; revenue: number }>;
  fmt: (n: number) => string;
}) {
  const { t } = useTranslation('finances');
  const H = 220;
  const margins = data.map((d) => d.revenue - d.cost);
  // Domain includes negative margins so the line can dip below the zero axis.
  const maxV = Math.max(1, ...data.flatMap((d) => [d.cost, d.revenue]), ...margins);
  const minV = Math.min(0, ...margins);
  // y-axis ticks: max, 0, and min (when negative)
  const ticks = Array.from(new Set([maxV, 0, ...(minV < 0 ? [minV] : [])]));
  const pad = { top: 16, right: 14, bottom: 26, left: axisLabelPad(ticks.map(fmt), 56) };
  const n = Math.max(1, data.length);
  // Width fills the container: a viewBox scaled to 100% width keeps column
  // sizing constant across periods (3 vs 12 months just adds/removes columns).
  const W = pad.left + pad.right + n * 64;
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const range = maxV - minV || 1;
  const slot = innerW / n;
  const barW = Math.min(18, slot / 3);
  const y = (v: number) => pad.top + innerH - ((v - minV) / range) * innerH;
  const zeroY = y(0);
  const monthLbl = (m: string) => {
    const mm = Number(m.slice(5, 7));
    return mm >= 1 && mm <= 12 ? t('finances:charts.month.' + mm) : m;
  };
  const pts = data.map((d, i) => {
    const cx = pad.left + slot * i + slot / 2;
    return { cx, cy: y(d.revenue - d.cost), m: d.revenue - d.cost };
  });
  const { bind, tipNode } = useChartTooltip();
  const monthFull = (m: string) => `${monthLbl(m)} ${m.slice(0, 4)}`;
  return (
    <div style={{ overflowX: 'auto' }}>
      {tipNode}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={pad.left} x2={W - pad.right} y1={y(tv)} y2={y(tv)} stroke={tv === 0 ? 'var(--border-2)' : 'var(--border)'} strokeWidth={1} />
            <text x={pad.left - 6} y={y(tv) + 3} textAnchor="end" fontSize={9} fill="var(--text-3)">{fmt(tv)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = pad.left + slot * i + slot / 2;
          const tip = (
            <>
              <b>{monthFull(d.month)}</b><br />
              <span className="ct-k">{t('finances:charts.revenue')}</span> {fmt(d.revenue)} · <span className="ct-k">{t('finances:charts.cost')}</span> {fmt(d.cost)}<br />
              <span className="ct-k">{t('finances:charts.margin')}</span> {fmt(d.revenue - d.cost)}
            </>
          );
          return (
            <g key={d.month}>
              {/* zone de survol pleine hauteur pour tout le mois */}
              <rect x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent" {...bind(tip)} />
              <rect x={x0 - barW - 1} y={y(d.revenue)} width={barW} height={Math.max(0, zeroY - y(d.revenue))} fill="oklch(0.62 0.13 155)" rx={2} pointerEvents="none" />
              <rect x={x0 + 1} y={y(d.cost)} width={barW} height={Math.max(0, zeroY - y(d.cost))} fill="oklch(0.6 0.16 25)" rx={2} pointerEvents="none" />
              <text x={x0} y={H - 8} textAnchor="middle" fontSize={9.5} fill="var(--text-3)" pointerEvents="none">{monthLbl(d.month)}</text>
            </g>
          );
        })}
        {pts.length > 1 && (
          <polyline points={pts.map((p) => `${p.cx},${p.cy}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={1.8} strokeDasharray="3 3" pointerEvents="none" />
        )}
        {pts.map((p, i) => (
          <circle key={i} cx={p.cx} cy={p.cy} r={2.4} fill="var(--accent)" pointerEvents="none" />
        ))}
      </svg>
      <div className="finc-dual-legend" style={{ paddingLeft: pad.left }}>
        <span><i className="finc-dot" style={{ background: 'oklch(0.62 0.13 155)' }} /> {t('finances:charts.revenue')}</span>
        <span><i className="finc-dot" style={{ background: 'oklch(0.6 0.16 25)' }} /> {t('finances:charts.cost')}</span>
        <span><i className="finc-dot" style={{ background: 'var(--accent)' }} /> {t('finances:charts.margin')}</span>
      </div>
    </div>
  );
}
