/**
 * Générateurs de graphiques SVG **purs** (aucune dépendance navigateur).
 *
 * Produits côté serveur pour être embarqués dans les PDF via `svg-to-pdfkit`.
 * On reste volontairement sur un sous-ensemble SVG simple (rect / line / path /
 * circle / text) que `svg-to-pdfkit` rend fidèlement. Les couleurs sont en
 * hexadécimal (pas de variables CSS : le PDF n'a pas de thème).
 */

export const CHART_COLORS = {
  ink: '#0f172a',
  grid: '#e2e8f0',
  axis: '#94a3b8',
  muted: '#64748b',
  accent: '#2563eb',
  ideal: '#94a3b8',
  good: '#16a34a',
  warn: '#f59e0b',
  bad: '#dc2626',
  neutral: '#cbd5e1',
  palette: ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#9333ea', '#0891b2', '#db2777', '#65a30d'],
} as const;

/** Échappe le texte injecté dans un nœud SVG. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('fr-FR');
}

/** Tronque un libellé trop long pour tenir dans la largeur allouée. */
function clip(label: string, max: number): string {
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

// ============================================================
// Burndown : courbe idéale (pointillés) vs réelle (pleine)
// ============================================================
export function burndownSvg(
  points: Array<{ date: string; idealRemainingHours: number; actualRemainingHours: number }>,
  opts: { width?: number; height?: number } = {},
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 260;
  const pad = { top: 16, right: 16, bottom: 34, left: 46 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  if (points.length === 0) {
    return emptyChart(W, H, 'Aucune donnée');
  }

  const maxY = Math.max(1, ...points.map((p) => Math.max(p.idealRemainingHours, p.actualRemainingHours)));
  const n = points.length;
  const x = (i: number) => pad.left + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v: number) => pad.top + ih - (ih * v) / maxY;

  const path = (key: 'idealRemainingHours' | 'actualRemainingHours') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

  // 4 lignes de grille horizontales + graduations Y
  const gridLines: string[] = [];
  for (let g = 0; g <= 4; g++) {
    const gy = pad.top + (ih * g) / 4;
    const val = maxY * (1 - g / 4);
    gridLines.push(
      `<line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${pad.left + iw}" y2="${gy.toFixed(1)}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`,
      `<text x="${pad.left - 6}" y="${(gy + 3).toFixed(1)}" font-size="9" fill="${CHART_COLORS.muted}" text-anchor="end">${esc(fmtNum(val))}</text>`,
    );
  }

  // Quelques labels de dates sur l'axe X (max ~6)
  const xLabels: string[] = [];
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    const d = points[i].date.slice(5); // MM-DD
    xLabels.push(
      `<text x="${x(i).toFixed(1)}" y="${(H - 12).toFixed(1)}" font-size="9" fill="${CHART_COLORS.muted}" text-anchor="middle">${esc(d)}</text>`,
    );
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
${gridLines.join('\n')}
<path d="${path('idealRemainingHours')}" fill="none" stroke="${CHART_COLORS.ideal}" stroke-width="1.5" stroke-dasharray="4 3"/>
<path d="${path('actualRemainingHours')}" fill="none" stroke="${CHART_COLORS.accent}" stroke-width="2"/>
${xLabels.join('\n')}
</svg>`;
}

// ============================================================
// Donut : segments (on-time / late / none …)
// ============================================================
export function donutSvg(
  segments: Array<{ label: string; value: number; color: string }>,
  opts: { size?: number; centerLabel?: string; centerValue?: string } = {},
): string {
  const S = opts.size ?? 180;
  const cx = S / 2;
  const cy = S / 2;
  const r = S / 2 - 6;
  const inner = r * 0.6;
  const total = segments.reduce((s, x) => s + x.value, 0);

  if (total <= 0) return emptyChart(S, S, 'Aucune donnée');

  let angle = -Math.PI / 2; // démarre en haut
  const arcs: string[] = [];
  for (const seg of segments) {
    if (seg.value <= 0) continue;
    const frac = seg.value / total;
    // Clamp à < 360° : un arc SVG de 2π exactement (start == end) ne dessine
    // rien (cas d'un segment unique à 100 %). 359.94° rend un anneau plein.
    const sweep = Math.min(frac * 2 * Math.PI, 2 * Math.PI - 0.001);
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(angle);
    const y0 = cy + r * Math.sin(angle);
    const x1 = cx + r * Math.cos(end);
    const y1 = cy + r * Math.sin(end);
    const xi1 = cx + inner * Math.cos(end);
    const yi1 = cy + inner * Math.sin(end);
    const xi0 = cx + inner * Math.cos(angle);
    const yi0 = cy + inner * Math.sin(angle);
    arcs.push(
      `<path d="M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${xi1.toFixed(2)},${yi1.toFixed(2)} A${inner},${inner} 0 ${large} 0 ${xi0.toFixed(2)},${yi0.toFixed(2)} Z" fill="${seg.color}"/>`,
    );
    angle = end;
  }

  const center = opts.centerValue
    ? `<text x="${cx}" y="${cy - 2}" font-size="20" font-weight="700" fill="${CHART_COLORS.ink}" text-anchor="middle">${esc(opts.centerValue)}</text>
<text x="${cx}" y="${cy + 14}" font-size="9" fill="${CHART_COLORS.muted}" text-anchor="middle">${esc(opts.centerLabel ?? '')}</text>`
    : '';

  return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
${arcs.join('\n')}
${center}
</svg>`;
}

// ============================================================
// Barres horizontales (top N) — time breakdown
// ============================================================
export function barsSvg(
  items: Array<{ label: string; value: number }>,
  opts: { width?: number; rowHeight?: number; color?: string; valueSuffix?: string; max?: number } = {},
): string {
  const W = opts.width ?? 720;
  const rh = opts.rowHeight ?? 22;
  const color = opts.color ?? CHART_COLORS.accent;
  const labelW = 150;
  const valW = 70;
  const data = items.slice(0, 12);
  const H = Math.max(rh, data.length * rh) + 8;

  if (data.length === 0) return emptyChart(W, 60, 'Aucune donnée');

  const max = Math.max(opts.max ?? 0, ...data.map((d) => d.value), 1);
  const barMax = W - labelW - valW - 8;

  const rows = data.map((d, i) => {
    const y = i * rh + 4;
    const bw = Math.max(0, (barMax * d.value) / max);
    return `<text x="0" y="${y + rh / 2 + 3}" font-size="10" fill="${CHART_COLORS.ink}">${esc(clip(d.label, 28))}</text>
<rect x="${labelW}" y="${y + 3}" width="${bw.toFixed(1)}" height="${rh - 8}" rx="2" fill="${color}"/>
<text x="${(labelW + bw + 5).toFixed(1)}" y="${y + rh / 2 + 3}" font-size="9" fill="${CHART_COLORS.muted}">${esc(fmtNum(d.value))}${esc(opts.valueSuffix ?? '')}</text>`;
  });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
${rows.join('\n')}
</svg>`;
}

function emptyChart(W: number, H: number, msg: string): string {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<text x="${W / 2}" y="${H / 2}" font-size="11" fill="${CHART_COLORS.muted}" text-anchor="middle">${esc(msg)}</text>
</svg>`;
}
