/* ============================================================
   Vaks — report charts (EVM line, CFD stacked area, capacity matrix,
   status columns). Pure inline SVG, custom tooltip.
   ============================================================ */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useChartTooltip } from './chart-tooltip';
// Les légendes de ces graphes utilisent `.finc-dot`/`.finc-dual-legend` (pastilles
// de couleur + espacement). Ces classes vivent dans finances.css : sans cet import,
// une vue hôte qui ne charge pas finances.css (ex. ReportsView) rend une légende
// SANS pastilles et labels collés (audit UI 2026-08-02). On l'importe ici pour que
// tout consommateur de ces charts ait le style, quelle que soit la vue.
import './finances.css';
// Le FOLD des statuts agents, `foldedStatusCount` et l'ordre canonique vivent
// dans le module central `taskStatus.ts` (source unique de vérité). On les
// ré-exporte ici pour ne pas casser les consommateurs (TeamReportView) qui
// les importaient depuis ce fichier.
import { CANONICAL_ORDER } from './taskStatus';
export { foldedStatusCount } from './taskStatus';

/* ---- task status palette (shared by CFD + status columns) ----
   Labels are resolved via i18n at call sites; the map carries colors +
   the translation key for the status label. Palette d'affichage propre à ces
   graphes (5 colonnes canoniques) — distincte des teintes Gantt / couleurs
   Reports ; le fold, lui, est centralisé. */
// Couleurs de statut alignées sur les colonnes du board (`.col-dot[data-status]`
// dans views.css) — même statut, même couleur partout : To do bleu, In progress
// coral (accent Vaks), In review ambre, On hold violet, Done vert.
export const TASK_STATUS_META: Record<string, { labelKey: string; color: string }> = {
  TODO: { labelKey: 'reports:charts.status.todo', color: 'var(--c-free)' },
  IN_PROGRESS: { labelKey: 'reports:charts.status.inProgress', color: 'var(--accent)' },
  IN_REVIEW: { labelKey: 'reports:charts.status.inReview', color: 'var(--c-warn)' },
  ON_HOLD: { labelKey: 'reports:charts.status.onHold', color: 'oklch(0.62 0.16 300)' },
  DONE: { labelKey: 'reports:charts.status.done', color: 'var(--c-ok)' },
};
export const STATUS_ORDER: string[] = [...CANONICAL_ORDER];
/** Ordre d'empilement du CFD, bas→haut : Done au sol (gonfle), To do au sommet
 *  (fond au fil de l'avancement). Distinct de l'ordre de lecture STATUS_ORDER. */
const CFD_DRAW_ORDER: string[] = ['DONE', 'IN_REVIEW', 'IN_PROGRESS', 'ON_HOLD', 'TODO'];

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
  data: Array<{ month: string; pv: number | null; ac: number; ev: number }>;
  fmt: (n: number) => string;
}) {
  const { t } = useTranslation('reports');
  const { bind, tipNode } = useChartTooltip();
  // Largeur responsive + hauteur fixe modérée (même patron que le CFD).
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [cw, setCw] = React.useState(720);
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setCw(Math.max(280, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 184;
  const pad = { top: 12, right: 14, bottom: 26, left: 52 };
  const n = Math.max(1, data.length);
  const W = cw;
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const maxV = Math.max(1, ...data.flatMap((d) => [d.pv ?? 0, d.ac, d.ev]));
  const x = (i: number) => pad.left + (innerW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + innerH - (v / maxV) * innerH;
  const monthLbl = (m: string) => {
    const mm = Number(m.slice(5, 7));
    const k = MONTH_KEYS[mm];
    return k ? t('reports:charts.months.' + k) : m;
  };
  const line = (key: 'pv' | 'ac' | 'ev') =>
    data
      .map((d, i) => (d[key] == null ? null : `${x(i).toFixed(1)},${y(d[key] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  // Zone d'écart coût entre EV et AC : coral en DÉPASSEMENT (AC > EV, on dépense
  // plus qu'on ne produit de valeur), vert quand efficace (EV > AC). État jugé
  // sur le dernier point.
  const last = data[n - 1];
  const overspend = !!last && last.ac > last.ev;
  const varianceColor = overspend ? 'var(--c-over)' : 'var(--c-ok)';
  const evTop = data.map((d, i) => `${x(i).toFixed(1)},${y(d.ev).toFixed(1)}`).join(' ');
  const acBot = data.map((d, i) => `${x(i).toFixed(1)},${y(d.ac).toFixed(1)}`).reverse().join(' ');
  const perPt = innerW / Math.max(1, n - 1);
  const step = Math.max(1, Math.ceil(48 / Math.max(1, perPt)));
  const showLabel = (i: number) => (i === n - 1 ? true : i % step === 0 && (n - 1 - i) * perPt >= 40);
  return (
    <div>
      <div className="finc-dual-legend" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <span><i className="finc-dot" style={{ background: 'var(--text-3)' }} /> {t('reports:charts.plannedValue')}</span>
        <span><i className="finc-dot" style={{ background: 'var(--c-free)' }} /> {t('reports:charts.earnedValue')}</span>
        <span><i className="finc-dot" style={{ background: 'var(--c-over)' }} /> {t('reports:charts.actualCost')}</span>
      </div>
      <div ref={wrapRef}>
        {tipNode}
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
          {[0, 0.5, 1].map((g) => (
            <g key={g}>
              <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH * (1 - g)} y2={pad.top + innerH * (1 - g)} stroke="var(--border)" />
              <text x={pad.left - 6} y={pad.top + innerH * (1 - g) + 3} textAnchor="end" fontSize={9} className="mono" fill="var(--text-3)">{fmt(maxV * g)}</text>
            </g>
          ))}
          {n > 1 && <polygon points={`${evTop} ${acBot}`} fill={varianceColor} opacity={0.16} />}
          <polyline points={line('pv')} fill="none" stroke="var(--text-3)" strokeWidth={2} strokeDasharray="5 4" />
          <polyline points={line('ev')} fill="none" stroke="var(--c-free)" strokeWidth={2.4} />
          <polyline points={line('ac')} fill="none" stroke="var(--c-over)" strokeWidth={2.4} />
          {data.map((d, i) => (
            <g key={d.month}>
              <rect x={x(i) - perPt / 2} y={pad.top} width={Math.max(6, perPt)} height={innerH} fill="transparent"
                {...bind(<><b>{monthLbl(d.month)} {d.month.slice(0, 4)}</b><br /><span className="ct-k">{t('reports:charts.planned')}</span> {d.pv == null ? '—' : fmt(d.pv)} · <span className="ct-k">{t('reports:charts.earned')}</span> {fmt(d.ev)} · <span className="ct-k">{t('reports:charts.actual')}</span> {fmt(d.ac)}</>)} />
              {d.pv != null && <circle cx={x(i)} cy={y(d.pv)} r={2.1} fill="var(--text-3)" pointerEvents="none" />}
              <circle cx={x(i)} cy={y(d.ev)} r={2.4} fill="var(--c-free)" pointerEvents="none" />
              <circle cx={x(i)} cy={y(d.ac)} r={2.4} fill="var(--c-over)" pointerEvents="none" />
              {showLabel(i) && <text x={x(i)} y={H - 7} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={9} className="mono" fill="var(--text-3)" pointerEvents="none">{monthLbl(d.month)}</text>}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ============================================================ CFD (stacked area by status) */
export function CfdChart({
  points,
}: {
  points: Array<{ date: string; [status: string]: number | string }>;
}) {
  const num = (p: { [k: string]: number | string }, k: string) => Number(p[k] ?? 0);
  const { t } = useTranslation('reports');
  const { bind, tipNode } = useChartTooltip();
  // Largeur responsive mesurée + HAUTEUR FIXE modérée : le CFD remplit toujours
  // la carte quel que soit le nombre de points, sans jamais prendre la moitié de
  // la page (le bug venait d'une hauteur fixe trop grande sur données triviales).
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [cw, setCw] = React.useState(720);
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setCw(Math.max(280, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 172;
  const pad = { top: 10, right: 12, bottom: 24, left: 34 };
  const n = Math.max(1, points.length);
  const W = cw;
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const totals = points.map((p) => STATUS_ORDER.reduce((s, k) => s + num(p, k), 0));
  const maxV = Math.max(1, ...totals);
  const x = (i: number) => pad.left + (innerW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + innerH - (v / maxV) * innerH;
  // Aire empilée dessinée bas→haut : Done en bas (le vert gonfle au fil du
  // temps), To do en haut (le gris fond). L'ordre visuel diffère volontairement
  // de STATUS_ORDER (qui reste l'ordre de lecture de la légende).
  const cum = points.map(() => 0);
  const areas = CFD_DRAW_ORDER.filter((k) => TASK_STATUS_META[k]).map((k) => {
    const lower = points.map((_, i) => cum[i]);
    points.forEach((p, i) => (cum[i] += num(p, k)));
    const upper = points.map((_, i) => cum[i]);
    const top = upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const bot = lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ');
    return { key: k, points: `${top} ${bot}` };
  });
  // Labels de dates : espacés d'au moins ~52px, dernier toujours affiché, sans
  // collision avec l'avant-dernier ; bords ancrés start/end pour ne pas rogner.
  const perPt = innerW / Math.max(1, n - 1);
  const step = Math.max(1, Math.ceil(52 / Math.max(1, perPt)));
  const showLabel = (i: number) => (i === n - 1 ? true : i % step === 0 && (n - 1 - i) * perPt >= 44);
  return (
    <div>
      {/* Légende en haut (ordre de lecture To do → Done). */}
      <div className="finc-dual-legend" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        {STATUS_ORDER.map((k) => (
          <span key={k}><i className="finc-dot" style={{ background: TASK_STATUS_META[k].color }} /> {t(TASK_STATUS_META[k].labelKey)}</span>
        ))}
      </div>
      <div ref={wrapRef}>
        {tipNode}
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
          {[0, 0.5, 1].map((g) => (
            <g key={g}>
              <line x1={pad.left} x2={W - pad.right} y1={pad.top + innerH * (1 - g)} y2={pad.top + innerH * (1 - g)} stroke="var(--border)" />
              <text x={pad.left - 6} y={pad.top + innerH * (1 - g) + 3} textAnchor="end" fontSize={9} className="mono" fill="var(--text-3)">{Math.round(maxV * g)}</text>
            </g>
          ))}
          {areas.map((a) => (
            <polygon key={a.key} points={a.points} fill={TASK_STATUS_META[a.key].color} opacity={0.95} />
          ))}
          {points.map((p, i) => (
            <g key={p.date}>
              <rect x={x(i) - perPt / 2} y={pad.top} width={Math.max(6, perPt)} height={innerH} fill="transparent"
                {...bind(<><b>{p.date}</b><br />{STATUS_ORDER.map((k) => (p[k] ? <span key={k} className="ct-k">{t(TASK_STATUS_META[k].labelKey)}: {p[k]}  </span> : null))}</>)} />
              {showLabel(i) && (
                <text x={x(i)} y={H - 7} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={9} className="mono" fill="var(--text-3)">{shortDate(p.date)}</text>
              )}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ============================================================ Column model (shared)
   Structure commune consommée par LoadBullets / StatusRings / ShareBars : une
   colonne = une entité (membre), `reference` = base 100 % (capacité / total),
   `segments` = tranches colorées. (L'ancien `StackedColumns` vertical a été
   retiré — le Team KPI « Taux d'utilisation » est passé aux barres de part
   horizontales `ShareBars`.) */
export interface ColumnDef {
  label: string;
  /** Pour le mode capacité : capacité totale (= 100%). */
  reference?: number;
  segments: Array<{ key: string; label: string; color: string; value: number }>;
}

/**
 * Charge multi-projets — bullet horizontal trié (refonte KPI).
 * Reçoit les mêmes `ColumnDef[]` que StackedColumns (mode percent) : chaque
 * colonne = un membre, `reference` = capacité, `segments` = allocations par
 * projet. On les réduit à un taux de charge (total ÷ capacité), on trie en
 * décroissant, et on rend une ligne par membre : nom · piste + remplissage
 * coloré par seuil · repère 100 % · valeur %. Le détail par projet reste dans
 * le tooltip flottant (`useChartTooltip`).
 */
export function LoadBullets({ columns, fmt }: { columns: ColumnDef[]; fmt: (n: number) => string }) {
  const { bind, tipNode } = useChartTooltip();
  const rows = columns
    .map((c) => {
      const total = c.segments.reduce((s, x) => s + x.value, 0);
      const ref = c.reference && c.reference > 0 ? c.reference : 0;
      const pct = ref > 0 ? (total / ref) * 100 : 0;
      return { c, total, pct };
    })
    .sort((a, b) => b.pct - a.pct);
  // Domaine borné à 140 % mini pour que le repère 100 % ne colle jamais au bord.
  const maxV = Math.max(140, ...rows.map((r) => r.pct));
  const refLeft = (100 / maxV) * 100;
  // Couleurs de CHART (pas la marque) : l'accent Vaks est coral (h31) et se
  // confondrait avec la surcharge (c-over). Échelle de charge dédiée bleu →
  // ambre → coral, cohérente avec le code couleur du Workload.
  const fillCol = (pct: number) => (pct > 100 ? 'var(--c-over)' : pct >= 95 ? 'var(--c-warn)' : 'var(--c-free)');
  return (
    <div className="load-bullets">
      {tipNode}
      {rows.map((r, i) => {
        const segs = r.c.segments.filter((s) => s.value > 0);
        const tip = (
          <>
            <b>{r.c.label}</b> · {Math.round(r.pct)}%
            {segs.map((s) => (
              <span key={s.key} style={{ display: 'block' }}>
                <span className="ct-k">{s.label}</span> {fmt(s.value)}
              </span>
            ))}
          </>
        );
        return (
          <div className="lb-row" key={r.c.label + '_' + i}>
            <span className="lb-name" title={r.c.label}>{r.c.label}</span>
            <div className="lb-track" {...bind(tip)}>
              <span className="lb-bg" />
              <span className="lb-fill" style={{ width: `${Math.min(100, (r.pct / maxV) * 100)}%`, background: fillCol(r.pct) }} />
              <span className="lb-ref" style={{ left: `${refLeft}%` }} />
            </div>
            <span className="lb-val mono" style={{ color: r.pct > 100 ? 'var(--c-over)' : 'var(--text)' }}>{Math.round(r.pct)}%</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Part facturable vs opérationnel — barres horizontales de part (refonte KPI).
 * Reçoit les mêmes `ColumnDef[]` que StackedColumns : chaque colonne = un membre,
 * `segments` = tranches de temps (facturable, opérationnel/admin). On rend une
 * ligne par membre : nom · barre 100 % empilée (chaque segment coloré, largeur ∝
 * part du total) · % du segment `sortByKey` (facturable par défaut), triée en
 * décroissant. Même langage visuel que `LoadBullets` (piste pill, tooltip
 * flottant). Le détail heures + % par segment vit dans le tooltip.
 */
export function ShareBars({
  columns,
  fmt,
  sortByKey,
}: {
  columns: ColumnDef[];
  fmt: (n: number) => string;
  /** clé du segment dont la part pilote le tri + la valeur affichée (déf. 1er segment). */
  sortByKey?: string;
}) {
  const { bind, tipNode } = useChartTooltip();
  const rows = columns
    .map((c) => {
      const total = c.segments.reduce((s, x) => s + x.value, 0);
      const primary = sortByKey
        ? c.segments.find((s) => s.key === sortByKey)?.value ?? 0
        : c.segments[0]?.value ?? 0;
      const pct = total > 0 ? (primary / total) * 100 : 0;
      return { c, total, pct };
    })
    .sort((a, b) => b.pct - a.pct);
  return (
    <div className="load-bullets">
      {tipNode}
      {rows.map((r, i) => {
        const tip = (
          <>
            <b>{r.c.label}</b>
            {r.c.segments.map((s) => (
              <span key={s.key} style={{ display: 'block' }}>
                <span className="ct-k">{s.label}</span> {fmt(s.value)}
                {r.total > 0 ? ` · ${Math.round((s.value / r.total) * 100)}%` : ''}
              </span>
            ))}
          </>
        );
        let acc = 0;
        return (
          <div className="lb-row" key={r.c.label + '_' + i}>
            <span className="lb-name" title={r.c.label}>{r.c.label}</span>
            <div className="lb-track sb-track" {...bind(tip)}>
              {r.total > 0 ? (
                r.c.segments.map((s) => {
                  const w = (s.value / r.total) * 100;
                  const left = acc; acc += w;
                  return w > 0 ? (
                    <span key={s.key} className="sb-seg" style={{ left: `${left}%`, width: `${w}%`, background: s.color }} />
                  ) : null;
                })
              ) : (
                <span className="lb-bg" />
              )}
            </div>
            <span className="lb-val mono">{r.total > 0 ? Math.round(r.pct) + '%' : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Tâches par statut & membre — anneaux small-multiples (refonte KPI).
 * Un donut par membre : composition des statuts (ordre `STATUS_ORDER`), total
 * au centre, prénom dessous. Les cellules s'enroulent (flex-wrap) → tient de
 * quelques membres à plusieurs dizaines. Couleurs = `TASK_STATUS_META`
 * (sémantiques par statut). Détail au survol via `useChartTooltip`.
 */
export function StatusRings({ columns }: { columns: ColumnDef[] }) {
  const { bind, tipNode } = useChartTooltip();
  const R = 34;
  const TH = 11;
  const size = (R + TH) * 2 + 6;
  const C = 2 * Math.PI * R;
  return (
    <div className="status-rings">
      {tipNode}
      {columns.map((c, ci) => {
        const total = c.segments.reduce((s, x) => s + x.value, 0);
        let off = 0;
        const first = c.label.split(/\s+/)[0] || c.label;
        return (
          <div className="sr-cell" key={c.label + '_' + ci}>
            <div className="sr-donut" style={{ width: size, height: size }}>
              <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
                <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--surface-3)" strokeWidth={TH} />
                <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
                  {c.segments.filter((s) => s.value > 0).map((s) => {
                    const len = total > 0 ? (s.value / total) * C : 0;
                    const node = (
                      <circle
                        key={s.key}
                        cx={size / 2}
                        cy={size / 2}
                        r={R}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={TH}
                        strokeDasharray={`${len} ${C - len}`}
                        strokeDashoffset={-off}
                        {...bind(<><b>{c.label}</b><br /><span className="ct-k">{s.label}</span> {s.value}</>)}
                      />
                    );
                    off += len;
                    return node;
                  })}
                </g>
              </svg>
              <div className="sr-center mono">{total}</div>
            </div>
            <div className="sr-name" title={c.label}>{first}</div>
          </div>
        );
      })}
    </div>
  );
}
