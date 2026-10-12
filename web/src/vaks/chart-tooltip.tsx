/* ============================================================
   Vaks — custom floating chart tooltip (replaces native title=)
   useChartTooltip() → { bind, tipNode }. Spread bind(content) onto
   any SVG/HTML element; render {tipNode} once in the component.
   ============================================================ */
import React, { useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Marge gauche (px) qui loge le plus long libellé d'axe Y (police 9px, ~5.6px/car.) + 10px d'écart.
 *  Une marge fixe rogne les montants monétaires longs (« 40 000,00 € »). */
export const axisLabelPad = (labels: string[], min: number) =>
  Math.max(min, Math.ceil(Math.max(0, ...labels.map((s) => s.length)) * 5.6) + 10);

export function useChartTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);

  // No `style` here on purpose — spreading bind() must never clobber an
  // element's own `style` (e.g. a bar's width). Cursor is handled in CSS.
  const bind = (content: ReactNode) => ({
    onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onMouseLeave: () => setTip(null),
  });

  let tipNode: ReactNode = null;
  if (tip) {
    // Clamp near the viewport edges (assume ~220×60 tooltip box).
    const left = Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 230);
    const top = Math.min(tip.y + 14, (typeof window !== 'undefined' ? window.innerHeight : 800) - 70);
    tipNode = createPortal(
      <div className="chart-tip" style={{ left, top }}>{tip.content}</div>,
      document.body,
    );
  }
  return { bind, tipNode };
}
