/* ============================================================
   Vaks — Network / PERT view (activity-on-node)
   Ported from the design's PERTView.jsx — hybrid node style with
   a CPM strip (ES/DUR/EF · LS/SLK/LF) under each card. Layered
   left-to-right by dependency rank, critical chain pinned on the
   middle lane. Toggles: Critical path · Critical only.
   ES/EF/LS/LF are computed client-side from the API's scheduled
   dates and totalSlack (the server already runs CPM — we just
   normalize the result back to day offsets for display).
   ============================================================ */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GanttDto, GanttTaskDto, TaskAssigneeDto } from '@vaks-pm/shared';
import { api } from '../api/client';
import { foldStatus, statusMeta } from './taskStatus';
import { Avatar, Icon } from './primitives';
import { useConfirm } from './confirm';
import type { User } from './data';

interface Props {
  projectId: string;
  onOpen: (id: string) => void;
  refreshKey?: number;
}

// Node footprint (hybrid layout: head + title + foot + CPM strip).
const NODE_W = 234;
/** Hauteur de base : carte avec titre court (≤ 2 lignes). */
const NODE_H_BASE = 152;
/** Hauteur d'une ligne de titre supplémentaire (font-size 13.5 × line-height 1.3). */
const TITLE_LINE_H = 19;
/** Nombre max de lignes de titre avant qu'on s'arrête (au-delà → tooltip). */
const TITLE_MAX_LINES = 6;
/** Largeur approximative consommée par un caractère du titre dans la carte
 *  (poids 700, ~210px utilisables). Estimation prudente : les majuscules,
 *  les chiffres, certaines ligatures, mais aussi le `word-wrap` qui peut
 *  finir une ligne avant les 210px si le mot suivant ne tient pas. */
const TITLE_CHARS_PER_LINE = 18;
const COL_GAP = 92; // along flow
const LANE_GAP = 26; // across flow
const PAD = 28;

/** Hauteur d'une carte en fonction de la longueur du titre. */
function nodeHeightFor(title: string): number {
  const lines = Math.min(
    TITLE_MAX_LINES,
    Math.max(2, Math.ceil(title.length / TITLE_CHARS_PER_LINE)),
  );
  return NODE_H_BASE + Math.max(0, lines - 2) * TITLE_LINE_H;
}

function parseDay(iso: string): Date {
  return new Date(iso + 'T00:00:00Z');
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((+b - +a) / 86_400_000);
}

function assigneeUser(a: TaskAssigneeDto): User {
  const parts = a.name.trim().split(/\s+/).filter(Boolean);
  const initials = (
    parts.length >= 2
      ? parts[0][0] + parts[parts.length - 1][0]
      : (parts[0]?.slice(0, 2) ?? '?')
  ).toUpperCase();
  // Hash sur l'*id utilisateur* (pas le nom) — même formule que `hueFromId`
  // de api.ts/AdminPanel pour une couleur d'avatar identique partout.
  let h = 0;
  for (let i = 0; i < a.userId.length; i++) h = ((h * 31) + a.userId.charCodeAt(i)) | 0;
  return {
    id: a.userId,
    name: a.name,
    short: a.name.split(/\s+/)[0] ?? a.name,
    role: '',
    initials,
    hue: ((h % 360) + 360) % 360,
    online: false,
  };
}

interface CpmNode {
  id: string;
  task: GanttTaskDto;
  ES: number;
  EF: number;
  LS: number;
  LF: number;
  dur: number;
  slack: number;
  crit: boolean;
  rank: number;
  deps: string[];
  x: number;
  y: number;
  h: number;
}

export function PertView({ projectId, onOpen, refreshKey = 0 }: Props) {
  const { t } = useTranslation('timeline');
  const confirm = useConfirm();
  const [data, setData] = useState<GanttDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCrit, setShowCrit] = useState(true);
  const [critOnly, setCritOnly] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const keyKey = 'vaks.pert.legend.collapsed';
  const [keyCollapsed, setKeyCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem(keyKey) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(keyKey, keyCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [keyCollapsed]);
  /** Manual offsets applied on top of the auto layout (id → {dx, dy}).
   *  Persisted in localStorage scoped by projectId so the user finds the
   *  arrangement again on reload. "Reset layout" wipes the whole map. */
  const offsetsKey = `vaks.pert.offsets.${projectId}`;
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>(() => {
    try {
      const raw = window.localStorage.getItem(offsetsKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(offsetsKey, JSON.stringify(offsets)); } catch { /* ignore */ }
  }, [offsets, offsetsKey]);
  // When the project changes, reload its persisted offsets.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`vaks.pert.offsets.${projectId}`);
      setOffsets(raw ? JSON.parse(raw) : {});
    } catch {
      setOffsets({});
    }
  }, [projectId]);
  /** While dragging, live offset of the dragged node — kept out of `offsets`
   *  state so we don't write to localStorage 60×/sec. Commits on pointerup. */
  const [dragLive, setDragLive] = useState<{ id: string; dx: number; dy: number } | null>(null);
  /** Hauteur réelle des cartes une fois rendues, mesurée via ResizeObserver
   *  dans chaque PertNode. Tant qu'une carte n'a pas été mesurée, on retombe
   *  sur l'estimation `nodeHeightFor(title)` — ça évite un "saut" visible :
   *  le premier rendu utilise l'estimation, le second la vraie mesure. */
  const [measuredH, setMeasuredH] = useState<Record<string, number>>({});
  const reportHeight = useCallback((id: string, h: number) => {
    setMeasuredH((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .getGantt(projectId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [projectId, refreshKey]);

  /** Build a CPM-flavoured node set out of the gantt response.
   *  Server has already computed scheduledStart/scheduledEnd + totalSlack
   *  + critical flag — we just translate dates into integer day offsets
   *  from the project start, which is what the design expects. */
  const cpm = useMemo(() => {
    if (!data) return null;
    // Leaf tasks only (groups have aggregated dates but no real activity).
    const tasks = data.tasks.filter((t) => !t.isGroup);
    if (tasks.length === 0) return null;
    const visibleIds = new Set(tasks.map((t) => t.id));
    const deps = data.dependencies.filter(
      (d) => visibleIds.has(d.predecessorId) && visibleIds.has(d.successorId),
    );

    const epoch = parseDay(data.projectStart);
    const predMap = new Map<string, string[]>();
    for (const t of tasks) predMap.set(t.id, []);
    for (const d of deps) predMap.get(d.successorId)!.push(d.predecessorId);

    // Longest-path rank assignment.
    const rankOf = new Map<string, number>();
    const visiting = new Set<string>();
    function rank(id: string): number {
      const c = rankOf.get(id);
      if (c !== undefined) return c;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const ps = predMap.get(id) ?? [];
      let r = 0;
      for (const p of ps) r = Math.max(r, rank(p) + 1);
      visiting.delete(id);
      rankOf.set(id, r);
      return r;
    }

    const nodes: CpmNode[] = tasks.map((t) => {
      const start = parseDay(t.scheduledStart);
      const end = parseDay(t.scheduledEnd);
      const ES = daysBetween(epoch, start);
      // Day-inclusive duration: a single-day task has dur = 1.
      const dur = Math.max(1, daysBetween(start, end) + 1);
      const EF = ES + dur;
      const slack = t.totalSlack;
      const LS = ES + slack;
      const LF = EF + slack;
      return {
        id: t.id,
        task: t,
        ES, EF, LS, LF, dur, slack,
        crit: t.critical,
        rank: rank(t.id),
        deps: predMap.get(t.id) ?? [],
        x: 0, y: 0,
        // Hauteur réelle si mesurée, sinon estimation prudente. Sera
        // remplacée à la 2e passe via reportHeight().
        h: measuredH[t.id] ?? nodeHeightFor(t.title),
      };
    });

    return { nodes, deps };
  }, [data, measuredH]);

  /** Layered layout: critical node of a rank pinned on lane 0 (center),
   *  others fanning out alternately ±1, ±2… (matches the design). */
  const layout = useMemo(() => {
    if (!cpm) return null;
    const all = cpm.nodes;
    const shown = critOnly ? all.filter((n) => n.crit) : all;
    if (shown.length === 0) return null;

    const byRank = new Map<number, CpmNode[]>();
    for (const n of shown) {
      const arr = byRank.get(n.rank) ?? [];
      arr.push(n);
      byRank.set(n.rank, arr);
    }
    const laneOf = new Map<string, number>();
    for (const col of byRank.values()) {
      const crit = col.filter((n) => n.crit);
      const rest = col
        .filter((n) => !n.crit)
        .sort((a, b) => a.ES - b.ES || a.id.localeCompare(b.id));
      crit.forEach((n) => laneOf.set(n.id, 0));
      rest.forEach((n, i) => {
        const lane = (i % 2 === 0 ? 1 : -1) * (Math.floor(i / 2) + 1);
        laneOf.set(n.id, lane);
      });
    }

    const lanes = shown.map((n) => laneOf.get(n.id)!);
    const minLane = Math.min(...lanes, 0);
    const maxLane = Math.max(...lanes, 0);
    const maxRank = Math.max(...shown.map((n) => n.rank), 0);
    const stepRank = NODE_W + COL_GAP;

    // Hauteur effective de chaque voie = max(hauteur des cartes qui y
    // tombent), pour qu'une carte avec un titre long ne chevauche pas la
    // voie d'à côté. On indexe par lane absolu (peut être négatif).
    const rowHeight = new Map<number, number>();
    for (const n of shown) {
      const lane = laneOf.get(n.id)!;
      const cur = rowHeight.get(lane) ?? NODE_H_BASE;
      if (n.h > cur) rowHeight.set(lane, n.h);
    }
    // Position Y du haut de chaque voie, en empilant minLane → maxLane.
    const yOfLane = new Map<number, number>();
    let yCursor = PAD;
    for (let lane = minLane; lane <= maxLane; lane++) {
      yOfLane.set(lane, yCursor);
      const rh = rowHeight.get(lane) ?? NODE_H_BASE;
      yCursor += rh + LANE_GAP;
    }

    for (const n of shown) {
      n.x = n.rank * stepRank + PAD;
      n.y = yOfLane.get(laneOf.get(n.id)!)!;
    }

    const canvasW = (maxRank + 1) * stepRank + PAD * 2 - COL_GAP;
    // yCursor a été incrémenté d'un LANE_GAP en trop après la dernière voie.
    const canvasH = yCursor - LANE_GAP + PAD;
    return { shown, canvasW, canvasH };
  }, [cpm, critOnly]);

  const edges = useMemo(() => {
    if (!cpm || !layout) return [];
    const shownIds = new Set(layout.shown.map((n) => n.id));
    const byId = new Map(cpm.nodes.map((n) => [n.id, n]));
    const out: { id: string; from: string; to: string; a: CpmNode; b: CpmNode; crit: boolean }[] = [];
    for (const n of layout.shown) {
      for (const dep of n.deps) {
        if (!shownIds.has(dep)) continue;
        const a = byId.get(dep)!;
        const b = n;
        const crit = a.crit && b.crit && a.EF === b.ES;
        out.push({ id: `${dep}-${n.id}`, from: dep, to: n.id, a, b, crit });
      }
    }
    return out;
  }, [cpm, layout]);

  const litEdges = useMemo(() => {
    if (!hover) return null;
    return new Set(edges.filter((e) => e.from === hover || e.to === hover).map((e) => e.id));
  }, [hover, edges]);
  const litNodes = useMemo(() => {
    if (!hover) return null;
    const s = new Set<string>([hover]);
    for (const e of edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, edges]);

  /** Effective position of a node = base layout + persisted offset + live drag. */
  const posOf = useCallback(
    (n: CpmNode) => {
      const o = offsets[n.id];
      const live = dragLive && dragLive.id === n.id ? dragLive : null;
      const dx = (o?.dx ?? 0) + (live?.dx ?? 0);
      const dy = (o?.dy ?? 0) + (live?.dy ?? 0);
      return { x: n.x + dx, y: n.y + dy };
    },
    [offsets, dragLive],
  );

  function edgePath(e: { a: CpmNode; b: CpmNode }) {
    const pa = posOf(e.a);
    const pb = posOf(e.b);
    const x1 = pa.x + NODE_W;
    const y1 = pa.y + e.a.h / 2;
    const x2 = pb.x;
    const y2 = pb.y + e.b.h / 2;
    const dx = Math.max(28, (x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  /** Commit a drag: persist the new offset and clear the live preview. */
  const commitDrag = useCallback((id: string, dx: number, dy: number) => {
    setOffsets((prev) => {
      const cur = prev[id] ?? { dx: 0, dy: 0 };
      const nx = cur.dx + dx;
      const ny = cur.dy + dy;
      // If the cumulative offset is back to ~0, drop the entry to keep the
      // map clean (so the auto-layout takes back over for that node).
      if (Math.abs(nx) < 0.5 && Math.abs(ny) < 0.5) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: { dx: nx, dy: ny } };
    });
    setDragLive(null);
  }, []);

  const resetLayout = async () => {
    if (Object.keys(offsets).length === 0) return;
    if (!(await confirm({ title: t('common:confirm'), message: t('timeline:pert.resetConfirm'), danger: true }))) return;
    setOffsets({});
  };

  if (error) {
    return (
      <div className="placeholder">
        <div className="ph-icon"><Icon name="branch" size={30} /></div>
        <h2 className="ph-title">{t('timeline:pert.unavailableTitle')}</h2>
        <p className="ph-sub">{error}</p>
      </div>
    );
  }
  if (!data) {
    return <div style={{ padding: 24, opacity: 0.7, fontSize: 13 }}>{t('timeline:pert.loading')}</div>;
  }
  if (!cpm) {
    return (
      <div className="placeholder">
        <div className="ph-icon"><Icon name="branch" size={30} /></div>
        <h2 className="ph-title">{t('timeline:pert.noTasksTitle')}</h2>
        <p className="ph-sub">{t('timeline:pert.noTasksSub')}</p>
      </div>
    );
  }
  // cpm existe (≥ 1 tâche) mais layout vide ⇒ le filtre « Critical only » n'a
  // rien retenu : le message doit dire « aucune tâche critique », pas « ajoutez
  // des tâches » (il y en a).
  if (!layout) {
    return (
      <div className="placeholder">
        <div className="ph-icon"><Icon name="branch" size={30} /></div>
        <h2 className="ph-title">{t('timeline:pert.noCritTitle')}</h2>
        <p className="ph-sub">{t('timeline:pert.noCritSub')}</p>
      </div>
    );
  }

  const critCount = cpm.nodes.filter((n) => n.crit).length;

  return (
    <div className="pert-wrap">
      <div className="pert-toolbar">
        <div className="row gap2" style={{ flexWrap: 'wrap' }}>
          <h1 className="view-h1">{t('timeline:pert.title')}</h1>
          <span className="view-sub">
            {t('timeline:pert.subtitle')}{' '}
            <b className="pert-crit-num">{t('timeline:pert.subtitleDays', { days: data.criticalPathDays })}</b> ·{' '}
            {t('timeline:pert.taskCount', { count: critCount })}
          </span>
        </div>
        <div className="row gap4" style={{ flexWrap: 'wrap' }}>
          <div className="pert-legend row gap3">
            <span className="row gap1"><span className="plg plg-crit" /> {t('timeline:pert.legendCritical')}</span>
            <span className="row gap1"><span className="plg plg-slack" /> {t('timeline:pert.legendSlack')}</span>
          </div>
          <div className="row gap2">
            <button
              className={'pert-toggle' + (showCrit ? ' on' : '')}
              onClick={() => setShowCrit((v) => !v)}
              title={t('timeline:pert.criticalPathTitle')}
            >
              <Icon name="zap" size={14} /> {t('timeline:pert.criticalPath')}
            </button>
            <button
              className={'pert-toggle' + (critOnly ? ' on' : '')}
              onClick={() => setCritOnly((v) => !v)}
              title={t('timeline:pert.critOnlyTitle')}
            >
              <Icon name="filter" size={14} /> {t('timeline:pert.critOnly')}
            </button>
            <button
              className="pert-toggle"
              onClick={resetLayout}
              disabled={Object.keys(offsets).length === 0}
              title={t('timeline:pert.resetTitle')}
              style={Object.keys(offsets).length === 0 ? { opacity: 0.4, cursor: 'default' } : undefined}
            >
              <Icon name="refresh" size={14} /> {t('timeline:pert.reset')}
            </button>
          </div>
        </div>
      </div>

      <div className={'pert-key' + (keyCollapsed ? ' collapsed' : '')}>
        <button
          type="button"
          className="pert-key-head"
          onClick={() => setKeyCollapsed((v) => !v)}
          title={keyCollapsed ? t('timeline:pert.showLegend') : t('timeline:pert.hideLegend')}
        >
          <Icon name={keyCollapsed ? 'chevR' : 'chevDown'} size={13} />
          <span className="pert-key-title">{t('timeline:pert.keyTitle')}</span>
        </button>
        {!keyCollapsed && (
          <div className="pert-key-body">
            <div className="pn-cpm pert-key-cpm">
              <div className="pn-cpm-row">
                <span className="pn-cell"><i>ES</i></span>
                <span className="pn-cell pn-dur"><i>DUR</i></span>
                <span className="pn-cell"><i>EF</i></span>
              </div>
              <div className="pn-cpm-row">
                <span className="pn-cell"><i>LS</i></span>
                <span className="pn-cell pn-slack"><i>SLK</i></span>
                <span className="pn-cell"><i>LF</i></span>
              </div>
            </div>
            <ul className="pert-key-list">
              <li><b>ES</b> {t('timeline:pert.keyEsDesc')}</li>
              <li><b>DUR</b> {t('timeline:pert.keyDurDesc')}</li>
              <li><b>EF</b> {t('timeline:pert.keyEfDesc')}</li>
              <li><b>LS</b> {t('timeline:pert.keyLsDesc')}</li>
              <li><b>SLK</b> {t('timeline:pert.keySlkDesc')}</li>
              <li><b>LF</b> {t('timeline:pert.keyLfDesc')}</li>
            </ul>
            <div className="pert-key-note">{t('timeline:pert.keyNote')}</div>
          </div>
        )}
      </div>

      <div className="pert-scroll">
        {(() => {
          // Grow the canvas if any persisted/live offset has pushed cards past
          // the auto-layout bounds. Otherwise the dragged card gets clipped
          // and the scroll area can't reach it.
          let canvasW = layout.canvasW;
          let canvasH = layout.canvasH;
          for (const n of layout.shown) {
            const p = posOf(n);
            canvasW = Math.max(canvasW, p.x + NODE_W + PAD);
            canvasH = Math.max(canvasH, p.y + n.h + PAD);
          }
          return (
            <div
              className={
                'pert-canvas' + (showCrit ? ' show-crit' : '') + (hover ? ' has-hover' : '')
              }
              style={{ width: canvasW, height: canvasH }}
            >
              <svg className="pert-edges" width={canvasW} height={canvasH}>
                <defs>
                  <marker id="parrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-faint)" />
                  </marker>
                  <marker id="parrow-crit" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--pert-crit)" />
                  </marker>
                </defs>
                {edges.map((e) => {
                  const isCrit = e.crit && showCrit;
                  const lit = litEdges ? litEdges.has(e.id) : true;
                  return (
                    <path
                      key={e.id}
                      d={edgePath(e)}
                      className={
                        'pert-edge' + (isCrit ? ' pert-edge-crit' : '') + (lit ? '' : ' dim')
                      }
                      markerEnd={`url(#${isCrit ? 'parrow-crit' : 'parrow'})`}
                    />
                  );
                })}
              </svg>

              {layout.shown.map((n) => {
                const dim = litNodes ? !litNodes.has(n.id) : false;
                const p = posOf(n);
                return (
                  <PertNode
                    key={n.id}
                    n={n}
                    x={p.x}
                    y={p.y}
                    minH={n.h}
                    showCrit={showCrit}
                    dim={dim}
                    onOpen={() => onOpen(n.id)}
                    onEnter={() => setHover(n.id)}
                    onLeave={() => setHover((cur) => (cur === n.id ? null : cur))}
                    onDragLive={(dx, dy) => setDragLive({ id: n.id, dx, dy })}
                    onDragEnd={(dx, dy) => commitDrag(n.id, dx, dy)}
                    onMeasure={reportHeight}
                  />
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function PertNode({
  n,
  x,
  y,
  minH,
  showCrit,
  dim,
  onOpen,
  onEnter,
  onLeave,
  onDragLive,
  onDragEnd,
  onMeasure,
}: {
  n: CpmNode;
  x: number;
  y: number;
  minH: number;
  showCrit: boolean;
  dim: boolean;
  onOpen: () => void;
  onEnter: () => void;
  onLeave: () => void;
  onDragLive: (dx: number, dy: number) => void;
  onDragEnd: (dx: number, dy: number) => void;
  onMeasure: (id: string, h: number) => void;
}) {
  const { t } = useTranslation('timeline');
  /** Mesure réelle de la carte une fois rendue. Si le titre fait pousser la
   *  carte plus haut que l'estimation, on remonte la vraie hauteur au parent
   *  qui recalcule alors la disposition (espacement entre voies). */
  const cardRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => onMeasure(n.id, el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n.id, onMeasure]);
  const tk = n.task;
  const crit = n.crit && showCrit;
  const assignees = (tk.assignees || []).map(assigneeUser);
  const slackBadge = n.slack === 0 ? t('timeline:pert.slackCritical') : t('timeline:pert.slackBadge', { slack: n.slack });

  /** Pointer-drag: track delta from the press point. Below the 4px deadzone
   *  we treat the gesture as a click (open the task); past it, it's a drag
   *  and we suppress the click on release. */
  const dragRef = useRef<{ startX: number; startY: number; dx: number; dy: number; moved: boolean } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    // Don't start a drag from interactive child elements (avatars, badges).
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input')) return;
    const el = e.currentTarget;
    dragRef.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false };
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      if (!dragRef.current.moved && Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
      dragRef.current.dx = dx;
      dragRef.current.dy = dy;
      if (dragRef.current.moved) onDragLive(dx, dy);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.classList.remove('is-dragging');
      const state = dragRef.current;
      dragRef.current = null;
      if (state?.moved) {
        onDragEnd(state.dx, state.dy);
        ev.preventDefault();
      } else {
        // No movement → treat as click.
        onDragLive(0, 0);
        onOpen();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  }

  return (
    <div
      ref={cardRef}
      className={'pert-node pert-hybrid' + (crit ? ' is-crit' : '') + (dim ? ' dim' : '')}
      style={{
        left: x,
        top: y,
        width: NODE_W,
        // minHeight (et pas height) → la carte peut s'étirer si le titre
        // déborde de l'estimation. Le parent re-layoutera via ResizeObserver.
        minHeight: minH,
        // Teinte du liseré gauche = couleur du groupe/projet uniquement.
        // Plus aucune couleur dérivée du statut (le statut est écrit en
        // toutes lettres) : sans couleur de groupe, le liseré reste neutre
        // (fallback CSS).
        ...(tk.color ? { ['--ntint' as never]: tk.color } : null),
      }}
      onPointerDown={onPointerDown}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      title={t('timeline:pert.nodeTooltip', { title: tk.title, es: n.ES, ef: n.EF, dur: n.dur, ls: n.LS, lf: n.LF, slack: n.slack })}
    >
      <div className="pn-head">
        {/* Libellé du statut REPLIÉ sur sa base canonique (pas de pastille : la
            couleur de la carte identifie déjà le groupe/projet). */}
        <span className="pn-status-label">{t('timeline:pert.status.' + statusMeta(foldStatus(tk.status)).labelSubkey)}</span>
        {tk.isMilestone && (
          <Icon name="flag" size={11} style={{ color: 'var(--accent)' }} />
        )}
        <span className="grow" />
        <span className={'pn-slack-badge' + (n.slack === 0 ? ' zero' : '')}>
          {slackBadge}
        </span>
      </div>
      {/* Pas de line-clamp ici : on a déjà dimensionné la carte pour
          contenir le titre (cf. nodeHeightFor). Si l'estimation se
          trompe d'une ligne, mieux vaut un léger vide en bas que de
          retrouver "..." sur des titres de 35 caractères. */}
      <div className="pn-title" style={{ wordBreak: 'break-word' }}>
        {tk.title}
      </div>
      <div className="grow" />
      <div className="pn-foot">
        <div className="pn-avatars">
          {assignees.slice(0, 3).map((u, i) => (
            <div key={u.id} style={{ marginLeft: i ? -7 : 0, zIndex: 5 - i }}>
              <Avatar user={u} size={24} ring title={false} />
            </div>
          ))}
        </div>
        <span className="grow" />
        <span className="pn-dur-badge mono">
          <Icon name="clock" size={12} /> {t('timeline:pert.durBadge', { dur: n.dur })}
        </span>
      </div>
      <div className="pn-cpm">
        <div className="pn-cpm-row">
          <span className="pn-cell"><i>ES</i>{n.ES}</span>
          <span className="pn-cell pn-dur"><i>DUR</i>{t('timeline:pert.durBadge', { dur: n.dur })}</span>
          <span className="pn-cell"><i>EF</i>{n.EF}</span>
        </div>
        <div className="pn-cpm-row">
          <span className="pn-cell"><i>LS</i>{n.LS}</span>
          <span className={'pn-cell pn-slack' + (n.slack === 0 ? ' zero' : '')}>
            <i>SLK</i>{t('timeline:pert.durBadge', { dur: n.slack })}
          </span>
          <span className="pn-cell"><i>LF</i>{n.LF}</span>
        </div>
      </div>
    </div>
  );
}
