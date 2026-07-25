/* ============================================================
   Pointer drag — unified mouse/touch. Creates a floating ghost
   that follows the pointer; reports the element under it.
   ============================================================ */
interface DragOpts {
  startEvent: PointerEvent;
  sourceEl: HTMLElement;
  ghostScale?: number;
  threshold?: number;
  onMove?: (info: { x: number; y: number; under: Element | null }) => void;
  onDrop?: (info: { x: number; y: number; under: Element | null }) => void;
  onCancel?: () => void;
}

export function startPointerDrag({ startEvent, sourceEl, ghostScale = 1, onMove, onDrop, onCancel, threshold = 4 }: DragOpts) {
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  const rect = sourceEl.getBoundingClientRect();
  const offX = startX - rect.left;
  const offY = startY - rect.top;
  let ghost: HTMLElement | null = null;
  let active = false;

  function makeGhost() {
    ghost = sourceEl.cloneNode(true) as HTMLElement;
    ghost.style.position = 'fixed';
    ghost.style.left = '0';
    ghost.style.top = '0';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.margin = '0';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    ghost.style.boxShadow = 'var(--ghost-shadow)';
    ghost.style.transform = `translate(${rect.left}px, ${rect.top}px) rotate(2deg) scale(${ghostScale})`;
    ghost.style.transformOrigin = `${offX}px ${offY}px`;
    ghost.style.opacity = '0.96';
    ghost.style.transition = 'none';
    ghost.classList.add('drag-ghost');
    document.body.appendChild(ghost);
    document.body.style.cursor = 'grabbing';
    document.body.classList.add('dragging-active');
  }
  function elUnder(x: number, y: number): Element | null {
    if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (ghost) ghost.style.display = '';
    return el;
  }
  function move(e: PointerEvent) {
    const x = e.clientX;
    const y = e.clientY;
    if (!active) {
      if (Math.abs(x - startX) < threshold && Math.abs(y - startY) < threshold) return;
      active = true;
      makeGhost();
      sourceEl.classList.add('drag-source');
    }
    ghost!.style.transform = `translate(${x - offX}px, ${y - offY}px) rotate(2deg) scale(${ghostScale})`;
    const under = elUnder(x, y);
    onMove && onMove({ x, y, under });
    e.preventDefault();
  }
  function up(e: PointerEvent) {
    cleanup();
    if (active) {
      const under = elUnder(e.clientX, e.clientY);
      onDrop && onDrop({ x: e.clientX, y: e.clientY, under });
    } else {
      onCancel && onCancel();
    }
  }
  function cleanup() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (ghost) ghost.remove();
    sourceEl.classList.remove('drag-source');
    document.body.style.cursor = '';
    document.body.classList.remove('dragging-active');
  }
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
