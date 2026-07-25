/* ============================================================
   Panneau "Personnaliser" du rapport projet — show/hide + reorder
   des widgets existants. Sauvegarde immédiate à chaque changement
   (pas de bouton "Enregistrer"), même style sans-save-explicite
   que le reste des écrans de config self-service.
   ============================================================ */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportWidgetKey } from '@vaks-pm/shared';
import { Icon } from './primitives';
import { startPointerDrag } from './dnd';

export interface ReportWidgetRow {
  key: ReportWidgetKey;
  labelKey: string;
}

interface Props {
  /** Tous les widgets du registre, avec leur clé i18n de libellé. */
  widgets: ReportWidgetRow[];
  /** Sous-ensemble de `widgets` réellement pertinent pour ce projet (ex :
   *  les widgets agents IA seulement si le projet les autorise) — les autres
   *  clés restent dans widgetOrder mais ne sont pas affichées ici. */
  availableKeys: Set<ReportWidgetKey>;
  widgetOrder: ReportWidgetKey[];
  hiddenKeys: ReportWidgetKey[];
  onSave: (next: { widgetOrder: ReportWidgetKey[]; hiddenKeys: ReportWidgetKey[] }) => void;
  onClose: () => void;
}

function moveKey(
  order: ReportWidgetKey[],
  dragged: ReportWidgetKey,
  targetKey: ReportWidgetKey,
  after: boolean,
): ReportWidgetKey[] {
  const without = order.filter((k) => k !== dragged);
  const idx = without.indexOf(targetKey);
  if (idx === -1) return order;
  const insertAt = after ? idx + 1 : idx;
  without.splice(insertAt, 0, dragged);
  return without;
}

export function ReportWidgetsPanel({ widgets, availableKeys, widgetOrder, hiddenKeys, onSave, onClose }: Props) {
  const { t } = useTranslation(['reports', 'common']);
  const [order, setOrder] = useState<ReportWidgetKey[]>(widgetOrder);
  const [hidden, setHidden] = useState<Set<ReportWidgetKey>>(new Set(hiddenKeys));
  const [dragKey, setDragKey] = useState<ReportWidgetKey | null>(null);
  const [overInfo, setOverInfo] = useState<{ key: ReportWidgetKey; after: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const labelByKey = new Map(widgets.map((w) => [w.key, t(w.labelKey)]));
  const rows = order.filter((k) => availableKeys.has(k));

  function commit(nextOrder: ReportWidgetKey[], nextHidden: Set<ReportWidgetKey>) {
    setOrder(nextOrder);
    setHidden(nextHidden);
    onSave({ widgetOrder: nextOrder, hiddenKeys: Array.from(nextHidden) });
  }

  function toggle(key: ReportWidgetKey) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commit(order, next);
  }

  function onGripDown(e: React.PointerEvent, key: ReportWidgetKey) {
    if (e.button != null && e.button !== 0) return;
    const sourceEl = (e.currentTarget as HTMLElement).closest('[data-widget-row]') as HTMLElement | null;
    if (!sourceEl) return;
    setDragKey(key);
    startPointerDrag({
      startEvent: e.nativeEvent,
      sourceEl,
      onMove: ({ y, under }) => {
        const rowEl = (under as Element | null)?.closest('[data-widget-row]') as HTMLElement | null;
        if (!rowEl || !listRef.current?.contains(rowEl)) {
          setOverInfo(null);
          return;
        }
        const overKey = rowEl.dataset.widgetRow as ReportWidgetKey;
        if (overKey === key) {
          setOverInfo(null);
          return;
        }
        const rect = rowEl.getBoundingClientRect();
        const after = y > rect.top + rect.height / 2;
        setOverInfo({ key: overKey, after });
      },
      onDrop: () => {
        setOverInfo((info) => {
          if (info) commit(moveKey(order, key, info.key, info.after), hidden);
          return null;
        });
        setDragKey(null);
      },
      onCancel: () => {
        setDragKey(null);
        setOverInfo(null);
      },
    });
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 60 }}>
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
          <div style={{ fontWeight: 700, fontSize: 15 }}>{t('reports:widgets.panelTitle')}</div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('reports:widgets.panelHint')}</div>

        <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((key) => {
            const isHidden = hidden.has(key);
            const isDragging = dragKey === key;
            const showBefore = overInfo?.key === key && !overInfo.after;
            const showAfter = overInfo?.key === key && overInfo.after;
            return (
              <div
                key={key}
                data-widget-row={key}
                className="row"
                style={{
                  gap: 8,
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  opacity: isDragging ? 0.5 : 1,
                  borderTop: showBefore ? '2px solid var(--accent)' : undefined,
                  borderBottom: showAfter ? '2px solid var(--accent)' : undefined,
                }}
              >
                <span
                  onPointerDown={(e) => onGripDown(e, key)}
                  style={{ cursor: 'grab', display: 'flex', color: 'var(--text-3)', touchAction: 'none' }}
                  title={t('reports:widgets.dragHint')}
                >
                  <Icon name="grip" size={14} />
                </span>
                <label className="row" style={{ gap: 8, alignItems: 'center', flex: 1, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!isHidden} onChange={() => toggle(key)} />
                  <span style={{ fontSize: 13, opacity: isHidden ? 0.5 : 1 }}>{labelByKey.get(key)}</span>
                </label>
                {isHidden && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: '.04em',
                      textTransform: 'uppercase',
                      color: 'var(--text-3)',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                      padding: '1px 5px',
                    }}
                  >
                    {t('reports:widgets.hiddenNote')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
