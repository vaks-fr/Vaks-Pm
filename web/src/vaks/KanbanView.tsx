/* ============================================================
   Vaks — Kanban board view
   Pointer drag & drop (mouse + touch), WIP limits, realtime feel
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { columns as COLUMNS, labels as LABELS, users as USERS, type BoardSubStatus, type Column, type Task, type User } from './data';

const GROUPS_COL: Column = { id: 'c_groups', name: 'Groups', status: 'group', wip: null };
import { Avatar, AvatarStack, effectiveColor, fmt, Icon, PriorityDot, subOf, Tag } from './primitives';
import { localizeColName } from './colLabel';
import { useConfirm } from './confirm';
import { startPointerDrag } from './dnd';

interface ToastInput {
  actor: User;
  text: string;
  warn?: boolean;
}

/**
 * Teinte OKLCH (0–360°) d'une couleur hex — cohérente avec le `oklch(from …)`
 * qui colore le fond de la carte pleine. Sert à décider l'inversion de la
 * pastille « en retard » (bande chaude rouge/orange → fond clair).
 */
function tintHue(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = lin(parseInt(full.slice(0, 2), 16));
  const g = lin(parseInt(full.slice(2, 4), 16));
  const b = lin(parseInt(full.slice(4, 6), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const oa = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const ob = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let hue = (Math.atan2(ob, oa) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return hue;
}

function KanbanCard({
  task,
  monday,
  density,
  showLabels,
  onPointerDown,
  dim,
  justMoved,
  tint,
  onEdit,
  onDelete,
  groups,
  onAssignGroup,
  onCreateGroup,
}: {
  task: Task;
  monday: Date;
  density: string;
  showLabels: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  dim: boolean;
  justMoved: boolean;
  /** Effective color inherited from the group hierarchy (#rrggbb). */
  tint: string | null;
  onEdit: () => void;
  onDelete: () => void;
  /** Groupes existants (tâches isGroup) pour le sous-menu « Groupe ». */
  groups: Task[];
  /** Assigne (ou retire si null) la tâche à un groupe — persiste parentTaskId. */
  onAssignGroup: (taskId: string, groupId: string | null) => void;
  /** Crée un groupe et renvoie la tâche réelle (id serveur) ou null. */
  onCreateGroup: (name: string) => Promise<Task | null>;
}) {
  const { t } = useTranslation('tasks');
  const confirm = useConfirm();
  const [menuOpen, setMenuOpen] = useState(false);
  const [groupSub, setGroupSub] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const currentParentId = task.parentTaskId ?? null;
  const submitNewGroup = async () => {
    const name = groupName.trim();
    if (!name) return;
    const g = await onCreateGroup(name);
    if (g) onAssignGroup(task.id, g.id);
    setGroupName('');
    setCreatingGroup(false);
    setGroupSub(false);
    setMenuOpen(false);
  };
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) {
      setGroupSub(false);
      setCreatingGroup(false);
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);
  const due = fmt.due(task.due, monday);
  const compact = density === 'compact';
  const sub = subOf(task);
  // Carte « pleine » colorée uniquement si la tâche hérite d'une couleur de groupe.
  // Sinon : fond neutre theme-aware (.card-neutral) — pas de fill blanc-texte forcé.
  const grouped = !!tint;
  // Bande chaude rouge/orange du fond → on inverse les pastilles d'alerte (fond
  // clair, texte rouge) pour garder le contraste sur une carte chaude.
  const warmFill = grouped && (() => { const hue = tintHue(tint!); return hue >= 340 || hue <= 75; })();
  const overduePill = !!due?.overdue;
  return (
    <div
      className={
        'card' +
        (grouped ? ' card-fill' : ' card-neutral') +
        (dim ? ' card-dim' : '') +
        (justMoved ? ' card-flash' : '') +
        (task.isGroup ? ' card-group' : '')
      }
      data-task={task.id}
      onPointerDown={onPointerDown}
      style={{
        touchAction: 'none',
        // La teinte source brute ; views.css la normalise (luminosité) pour le fond.
        ...(grouped ? ({ '--tint': tint } as React.CSSProperties) : null),
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="mono card-key">{task.key}</span>
        <div className="row" style={{ gap: 6 }}>
          {task.isBug && (
            <span className={'bug-flag' + (warmFill ? ' bug-flag-inv' : '')} title={t('card.bug')}>
              <Icon name="warn" size={11} /> {t('card.bug')}
            </span>
          )}
          {(task.externalBlocked || task.externalDependency) && (
            <span
              title={task.externalDependency || t('card.external')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: 999,
                whiteSpace: 'nowrap',
                color: task.externalBlocked ? 'oklch(0.62 0.2 25)' : 'var(--text-3)',
                background: task.externalBlocked
                  ? 'color-mix(in oklch, oklch(0.62 0.2 25) 16%, transparent)'
                  : 'var(--bg-2)',
              }}
            >
              <Icon name="link" size={10} /> {t('card.external')}
            </span>
          )}
          <PriorityDot level={task.priority} />
          <div ref={menuRef} data-no-drag style={{ position: 'relative' }}>
            <button
              className="card-menu"
              data-no-drag
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              aria-label={t('card.menu')}
            >
              <Icon name="dots" size={15} />
            </button>
            {menuOpen && (
              <div
                data-no-drag
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  right: 0,
                  minWidth: 140,
                  background: 'var(--surface-1, var(--bg-1))',
                  border: '1px solid var(--border, rgba(255,255,255,0.08))',
                  borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                  padding: 4,
                  zIndex: 50,
                }}
              >
                <button
                  className="dd-item"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '6px 10px', fontSize: 13, background: 'transparent',
                    border: 0, color: 'var(--text-1)', cursor: 'pointer', borderRadius: 6,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { setMenuOpen(false); onEdit(); }}
                >
                  <Icon name="pencil" size={13} /> {t('common:edit')}
                </button>

                {/* Groupe : assigner à un groupe existant, retirer, ou en créer un. */}
                {!task.isGroup && (
                  <>
                    <button
                      className="dd-item"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                        padding: '6px 10px', fontSize: 13, background: 'transparent',
                        border: 0, color: 'var(--text-1)', cursor: 'pointer', borderRadius: 6,
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => setGroupSub((v) => !v)}
                    >
                      <Icon name="branch" size={13} />
                      <span style={{ flex: 1 }}>{t('card.group')}</span>
                      <Icon name="chevDown" size={12} style={{ color: 'var(--text-3)' }} />
                    </button>
                    {groupSub && (
                      <div style={{ paddingLeft: 6, borderLeft: '2px solid var(--border)', margin: '2px 0 2px 12px' }}>
                        {currentParentId && (
                          <button
                            className="dd-item"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                              padding: '6px 10px', fontSize: 12.5, background: 'transparent',
                              border: 0, color: 'var(--text-3)', cursor: 'pointer', borderRadius: 6, textAlign: 'left',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            onClick={() => { onAssignGroup(task.id, null); setMenuOpen(false); }}
                          >
                            <Icon name="x" size={12} /> {t('card.removeFromGroup')}
                          </button>
                        )}
                        {groups.map((g) => (
                          <button
                            key={g.id}
                            className="dd-item"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                              padding: '6px 10px', fontSize: 13, background: 'transparent',
                              border: 0, color: 'var(--text-1)', cursor: 'pointer', borderRadius: 6, textAlign: 'left',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            onClick={() => { onAssignGroup(task.id, g.id); setMenuOpen(false); }}
                          >
                            <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: g.color ?? 'var(--text-faint)' }} />
                            <span className="truncate" style={{ flex: 1 }}>{g.title}</span>
                            {g.id === currentParentId && <Icon name="check" size={13} style={{ color: 'var(--accent)' }} />}
                          </button>
                        ))}
                        {creatingGroup ? (
                          <input
                            autoFocus
                            className="select-sm"
                            style={{ width: '100%', margin: '4px 0', fontSize: 12.5 }}
                            placeholder={t('kanban.groupNamePlaceholder')}
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); void submitNewGroup(); }
                              else if (e.key === 'Escape') { setCreatingGroup(false); setGroupName(''); }
                            }}
                          />
                        ) : (
                          <button
                            className="dd-item"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                              padding: '6px 10px', fontSize: 12.5, background: 'transparent',
                              border: 0, color: 'var(--accent)', cursor: 'pointer', borderRadius: 6, textAlign: 'left', fontWeight: 600,
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            onClick={() => setCreatingGroup(true)}
                          >
                            <Icon name="plus" size={12} /> {t('card.newGroup')}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}

                <button
                  className="dd-item"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '6px 10px', fontSize: 13, background: 'transparent',
                    border: 0, color: 'oklch(0.72 0.18 25)', cursor: 'pointer', borderRadius: 6,
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  onClick={async () => {
                    setMenuOpen(false);
                    if (await confirm({ title: t('common:delete'), message: t('confirmDelete', { title: task.title }), confirmLabel: t('common:delete'), danger: true })) onDelete();
                  }}
                >
                  <Icon name="x" size={13} /> {t('common:delete')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card-title" style={{ fontSize: compact ? 13 : 14 }}>
        {task.title}
      </div>

      {showLabels && task.labels.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
          {task.labels.map((l) => (
            <Tag key={l} id={l} />
          ))}
        </div>
      )}

      {!compact && task.progress > 0 && task.progress < 100 && (
        <div className="card-prog">
          <div className="card-prog-bar" style={{ width: task.progress + '%' }} />
        </div>
      )}

      <div className="row card-foot" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, color: 'var(--text-3)' }}>
          {due &&
            (overduePill ? (
              <span className={'due-pill' + (warmFill ? ' due-pill-inv' : '')}>
                <Icon name="cal" size={12} />
                <span className="mono">
                  {due.label} · {task.due}j
                </span>
              </span>
            ) : (
              <span
                className={'row due ' + (due.overdue ? 'due-over' : due.today ? 'due-today' : due.soon ? 'due-soon' : '')}
                style={{ gap: 4 }}
              >
                <Icon name="cal" size={13} />{' '}
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {due.label}
                </span>
              </span>
            ))}
          {sub && (
            <span className="row" style={{ gap: 4 }} title={t('card.subtasks')}>
              <Icon name="branch" size={13} />
              <span className="mono" style={{ fontSize: 11.5 }}>
                {sub.done}/{sub.total}
              </span>
            </span>
          )}
          {task.comments > 0 && (
            <span className="row" style={{ gap: 3 }} title={t('card.comments')}>
              <Icon name="chat" size={13} />
              <span className="mono" style={{ fontSize: 11.5 }}>
                {task.comments}
              </span>
            </span>
          )}
          {task.attachments > 0 && (
            <span className="row" style={{ gap: 3 }} title={t('card.attachments')}>
              <Icon name="paperclip" size={13} />
              <span className="mono" style={{ fontSize: 11.5 }}>
                {task.attachments}
              </span>
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {task.progress === 100 && <Icon name="check" size={14} style={{ color: 'var(--c-ok)' }} />}
          <AvatarStack ids={task.assignees} size={compact ? 20 : 22} />
        </div>
      </div>
    </div>
  );
}

interface DragState {
  id: string;
  overCol: string | null;
  overIndex: number | null;
  /** Container de sous-statut survolé (null = zone principale de la colonne). */
  overSub: string | null;
}

export function KanbanView({
  tasks,
  setTasks,
  monday,
  density,
  showLabels,
  live,
  pushToast,
  onOpen,
  onDelete,
  canEditBoard = false,
  onSetWip,
  onAssignGroup,
  onCreateGroup,
  onDeleteGroup,
  boardVersion = 0,
  subStatuses = [],
}: {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  monday: Date;
  density: string;
  showLabels: boolean;
  live: boolean;
  pushToast: (t: ToastInput) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** PM/lead/admin : affiche le menu d'édition de colonne (limite WIP). */
  canEditBoard?: boolean;
  /** Persiste la limite WIP d'une colonne (`null` = aucune limite). */
  onSetWip?: (columnId: string, wip: number | null) => void;
  /** Assigne/retire une tâche d'un groupe (persiste parentTaskId). */
  onAssignGroup: (taskId: string, groupId: string | null) => void;
  /** Crée un groupe (tâche isGroup + couleur) et renvoie la tâche réelle. */
  onCreateGroup: (name: string) => Promise<Task | null>;
  /** Supprime un groupe (détache ses tâches puis supprime le groupe). */
  onDeleteGroup: (groupId: string) => void;
  /** Bump externe pour re-render quand les colonnes changent. */
  boardVersion?: number;
  /** Sous-statuts applicables au projet (containers dans les colonnes). */
  subStatuses?: BoardSubStatus[];
}) {
  const { t } = useTranslation('tasks');
  const confirm = useConfirm();
  const [drag, setDrag] = useState<DragState | null>(null);
  // Menu d'édition de colonne ouvert (id de colonne) + valeur en cours de saisie.
  const [wipMenuCol, setWipMenuCol] = useState<string | null>(null);
  const [wipDraft, setWipDraft] = useState('');
  const wipMenuRef = useRef<HTMLDivElement | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newIsGroup, setNewIsGroup] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  // Création d'un groupe depuis le dropdown « Groupes » de la barre.
  const [filterCreating, setFilterCreating] = useState(false);
  const [filterGroupName, setFilterGroupName] = useState('');
  const filterRef = useRef<HTMLDivElement | null>(null);
  // Filtre par label (indépendant du filtre par groupe ; combinés en ET).
  const [labelFilter, setLabelFilter] = useState<Set<string>>(new Set());
  const [labelFilterOpen, setLabelFilterOpen] = useState(false);
  const labelFilterRef = useRef<HTMLDivElement | null>(null);

  // Filtre « bloqué par un prestataire externe » (client-side, comme les labels).
  const [externalBlockedOnly, setExternalBlockedOnly] = useState(false);

  // Close label filter popover on outside click
  useEffect(() => {
    if (!labelFilterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (labelFilterRef.current && !labelFilterRef.current.contains(e.target as Node)) {
        setLabelFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [labelFilterOpen]);

  // Close filter popover on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [filterOpen]);

  // Close column (WIP) menu on outside click.
  useEffect(() => {
    if (!wipMenuCol) return;
    const onDoc = (e: MouseEvent) => {
      if (wipMenuRef.current && !wipMenuRef.current.contains(e.target as Node)) {
        setWipMenuCol(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [wipMenuCol]);

  // Ouvre le menu d'une colonne en pré-remplissant la limite WIP courante.
  const openWipMenu = useCallback((col: Column) => {
    setWipDraft(col.wip != null ? String(col.wip) : '');
    setWipMenuCol(col.id);
  }, []);

  // Applique la saisie : entier ≥ 1 ⇒ limite, vide/0 ⇒ aucune limite.
  const applyWip = useCallback(
    (columnId: string) => {
      const n = parseInt(wipDraft, 10);
      onSetWip?.(columnId, Number.isFinite(n) && n >= 1 ? n : null);
      setWipMenuCol(null);
    },
    [wipDraft, onSetWip],
  );

  const allGroups = useMemo(() => tasks.filter((t) => t.isGroup), [tasks]);
  const hasGroups = allGroups.length > 0;

  // Build parent map for ancestor lookups (filter by group membership)
  const parentOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const t of tasks) m.set(t.id, t.parentTaskId ?? null);
    return m;
  }, [tasks]);

  // Drop stale ids from filter when groups disappear
  useEffect(() => {
    if (groupFilter.size === 0) return;
    const live = new Set(allGroups.map((g) => g.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of groupFilter) {
      if (live.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setGroupFilter(next);
  }, [allGroups, groupFilter]);

  const visibleTasks = useMemo(() => {
    let result = tasks;
    // Filtre par groupe (remonte la chaîne des parents).
    if (groupFilter.size > 0) {
      const isInFilter = (id: string): boolean => {
        let cur: string | null | undefined = id;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          if (groupFilter.has(cur)) return true;
          seen.add(cur);
          cur = parentOf.get(cur) ?? null;
        }
        return false;
      };
      result = result.filter((t) => isInFilter(t.id));
    }
    // Filtre par label (au moins un label sélectionné présent sur la tâche).
    if (labelFilter.size > 0) {
      result = result.filter((t) => t.labels.some((l) => labelFilter.has(l)));
    }
    // Filtre « bloqué par un prestataire externe ».
    if (externalBlockedOnly) {
      result = result.filter((t) => t.externalBlocked);
    }
    return result;
  }, [tasks, groupFilter, labelFilter, externalBlockedOnly, parentOf]);

  const toggleLabelFilter = (id: string) => {
    setLabelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const colTasks = useCallback(
    (cid: string) => {
      if (cid === GROUPS_COL.id) return visibleTasks.filter((t) => t.isGroup);
      return visibleTasks.filter((t) => !t.isGroup && t.col === cid);
    },
    [visibleTasks],
  );

  // `boardVersion` force la relecture du binding module `COLUMNS` (data.ts)
  // après une édition de colonne (ex. limite WIP) hors flux React.
  // La colonne « Groups » virtuelle a été retirée : les groupes ne sont plus une
  // colonne mais des conteneurs (création/assignation via le menu carte + le
  // dropdown « Groupes »). Les tâches isGroup restent exclues des colonnes normales.
  const renderedColumns: Column[] = useMemo(
    () => COLUMNS,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardVersion],
  );
  // Crée un groupe depuis le dropdown de la barre (sans l'assigner à une carte).
  const submitFilterGroup = async () => {
    const name = filterGroupName.trim();
    if (!name) return;
    await onCreateGroup(name);
    setFilterGroupName('');
    setFilterCreating(false);
  };

  const toggleGroupFilter = (id: string) => {
    setGroupFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  function computeDrop(
    under: Element | null,
    y: number,
  ): { col: string; sub: string | null; index: number } | null {
    // `closest` remonte au container de sous-statut s'il est survolé (zone
    // imbriquée dans la colonne), sinon à la colonne elle-même.
    const zone = under && (under.closest('[data-dropzone]') as HTMLElement | null);
    if (!zone) return null;
    const col = zone.getAttribute('data-dropzone')!;
    const sub = zone.getAttribute('data-subzone') || null;
    // Index parmi les cartes de CETTE zone seulement (un container de
    // sous-statut ne contient pas les cartes de la zone principale).
    const cards = [...zone.querySelectorAll('[data-task]')]
      .filter((c) => (c.closest('[data-dropzone]') as HTMLElement) === zone)
      .filter((c) => !c.classList.contains('drag-source'));
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    return { col, sub, index };
  }

  /** Zone effective d'une tâche dans sa colonne : id du sous-statut si celui-ci
   *  existe ET appartient au statut de la colonne, sinon zone principale
   *  (fallback obligatoire — jamais de carte orpheline invisible). */
  const subZoneOf = useCallback(
    (t: Task, colId: string): string | null => {
      if (!t.subStatusId) return null;
      const colStatus = COLUMNS.find((c) => c.id === colId)?.status;
      const sub = subStatuses.find((s) => s.id === t.subStatusId);
      return sub && sub.status === colStatus ? sub.id : null;
    },
    [subStatuses],
  );

  function moveTaskTo(ts: Task[], id: string, toCol: string, toIndex: number, toSub: string | null = null): Task[] {
    const moving = ts.find((t) => t.id === id);
    if (!moving) return ts;
    const toGroups = toCol === GROUPS_COL.id;
    // A group with existing children can't be demoted to a regular column
    // (server enforces this too). Block the drag silently.
    if (!toGroups && moving.isGroup) {
      const hasKids = ts.some((t) => t.parentTaskId === moving.id);
      if (hasKids) return ts;
    }
    // Convert type on cross-section drag.
    const becomeGroup = toGroups && !moving.isGroup;
    const becomeTask = !toGroups && moving.isGroup;
    const rest = ts.filter((t) => t.id !== id);
    // Groups col is virtual: don't mutate persisted col when dropping into it.
    const effectiveCol = toGroups ? moving.col : toCol;
    const isDoneCol = !toGroups && COLUMNS.find((c) => c.id === toCol)?.status === 'done';
    const moved: Task = {
      ...moving,
      col: effectiveCol,
      // Sous-statut : suit la zone de drop (null = zone principale). La colonne
      // Groupes virtuelle ne touche pas au sous-statut.
      subStatusId: toGroups ? moving.subStatusId : toSub,
      isGroup: becomeGroup ? true : becomeTask ? false : moving.isGroup,
      // Clear group color when demoting.
      color: becomeTask ? null : moving.color,
      progress: isDoneCol ? 100 : moving.progress === 100 && !isDoneCol ? 80 : moving.progress,
    };
    // Insertion à l'index parmi les cartes de la MÊME zone (colonne × sous-statut).
    const matchesTarget = (t: Task) =>
      toCol === GROUPS_COL.id
        ? !!t.isGroup
        : !t.isGroup && t.col === toCol && subZoneOf(t, toCol) === (toGroups ? null : toSub);
    const result: Task[] = [];
    let colCount = 0;
    let inserted = false;
    for (const t of rest) {
      if (matchesTarget(t)) {
        if (colCount === toIndex) {
          result.push(moved);
          inserted = true;
        }
        colCount++;
      }
      result.push(t);
    }
    if (!inserted) result.push(moved);
    return result;
  }

  function onCardPointerDown(e: React.PointerEvent, task: Task) {
    if (e.button != null && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    const sourceEl = e.currentTarget as HTMLElement;
    startPointerDrag({
      startEvent: e.nativeEvent,
      sourceEl,
      onMove: ({ under, y }) => {
        const d = computeDrop(under, y);
        if (d) setDrag({ id: task.id, overCol: d.col, overIndex: d.index, overSub: d.sub });
        else setDrag({ id: task.id, overCol: null, overIndex: null, overSub: null });
      },
      onDrop: ({ under, y }) => {
        const d = computeDrop(under, y);
        setDrag(null);
        if (d) {
          setTasks((ts) => moveTaskTo(ts, task.id, d.col, d.index, d.sub));
          if (d.col !== task.col) {
            setFlash(task.id);
            setTimeout(() => setFlash(null), 900);
          }
        }
      },
      onCancel: () => {
        setDrag(null);
        onOpen && onOpen(task.id);
      },
    });
  }

  function addCard(col: string) {
    const title = newTitle.trim();
    if (!title) {
      setAdding(null);
      return;
    }
    const isGroupCol = col === GROUPS_COL.id;
    const asGroup = isGroupCol || newIsGroup;
    // Backend doesn't know c_groups: persist groups with the first real column id.
    const persistedCol = isGroupCol ? COLUMNS[0]?.id ?? col : col;
    if (isGroupCol && !COLUMNS[0]?.id) {
      setAdding(null);
      return;
    }
    const n = tasks.length + 1;
    const nt: Task = {
      id: 't_new' + Date.now(),
      col: persistedCol,
      title,
      key: 'ATL-' + (200 + n),
      assignees: [],
      labels: [],
      priority: 'normal',
      due: null,
      start: null,
      estimate: null,
      progress: 0,
      comments: 0,
      attachments: 0,
      subtasks: null,
      desc: '',
      isGroup: asGroup,
    };
    setTasks((ts) => [...ts, nt]);
    setNewTitle('');
    setNewIsGroup(false);
    setAdding(null);
  }

  // ---- realtime simulation ----
  useEffect(() => {
    if (!live) return;
    const flow = ['c_backlog', 'c_todo', 'c_prog', 'c_review', 'c_done'];
    const id = setInterval(() => {
      setTasks((ts) => {
        const movable = ts.filter((mt) => !mt.isGroup && mt.col !== 'c_done' && mt.col !== 'c_review');
        if (!movable.length) return ts;
        const mt = movable[Math.floor(Math.random() * movable.length)];
        const ni = Math.min(flow.indexOf(mt.col) + 1, flow.length - 1);
        const toCol = flow[ni];
        const others = USERS.filter((u) => !mt.assignees.includes(u.id) && u.online);
        const actor = others[Math.floor(Math.random() * others.length)] || USERS[0];
        const colName = COLUMNS.find((c) => c.id === toCol)!.name;
        pushToast({ actor, text: t('kanban.movedToast', { title: mt.title, column: colName }) });
        setFlash(mt.id);
        setTimeout(() => setFlash(null), 1100);
        return moveTaskTo(ts, mt.id, toCol, 0);
      });
    }, 14000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  return (
    <div className="board-scroll">
      <div
        className="row"
        style={{
          justifyContent: 'flex-end',
          padding: '6px 12px 0',
          gap: 8,
        }}
      >
        <div ref={labelFilterRef} style={{ position: 'relative' }}>
          <button
            className={'btn btn-sm' + (labelFilter.size > 0 ? ' btn-accent' : ' btn-ghost')}
            onClick={() => setLabelFilterOpen((v) => !v)}
            title={t('kanban.filterByLabel')}
            style={{ gap: 6 }}
          >
            <Icon name="flag" size={13} />
            <span>
              {labelFilter.size === 0
                ? t('kanban.allLabels')
                : t('kanban.nLabels', { count: labelFilter.size })}
            </span>
            <Icon name="chevDown" size={13} />
          </button>
          {labelFilterOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                minWidth: 200,
                maxHeight: 320,
                overflowY: 'auto',
                background: 'var(--surface-1, var(--bg-1))',
                border: '1px solid var(--border, rgba(255,255,255,0.08))',
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                padding: 6,
                zIndex: 50,
              }}
            >
              <div
                className="row"
                style={{ justifyContent: 'space-between', padding: '4px 8px 6px', fontSize: 11, color: 'var(--text-3)' }}
              >
                <span>{t('kanban.filterByLabel')}</span>
                {labelFilter.size > 0 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '2px 6px', fontSize: 11 }}
                    onClick={() => setLabelFilter(new Set())}
                  >
                    {t('kanban.clear')}
                  </button>
                )}
              </div>
              {Object.values(LABELS).length === 0 ? (
                <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t('detail.noLabelsAvailable')}</div>
              ) : (
                Object.values(LABELS).map((l) => {
                  const checked = labelFilter.has(l.id);
                  return (
                    <label
                      key={l.id}
                      className="row"
                      style={{ gap: 8, padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleLabelFilter(l.id)} />
                      <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: `oklch(0.6 0.16 ${l.hue})` }} />
                      <span className="truncate" style={{ flex: 1 }}>{l.name}</span>
                    </label>
                  );
                })
              )}
            </div>
          )}
        </div>
        <button
          className={'btn btn-sm' + (externalBlockedOnly ? ' btn-accent' : ' btn-ghost')}
          onClick={() => setExternalBlockedOnly((v) => !v)}
          title={t('kanban.filterExternalBlocked')}
          style={{ gap: 6 }}
        >
          <Icon name="link" size={13} />
          <span>{t('kanban.externalBlocked')}</span>
        </button>
        <div ref={filterRef} style={{ position: 'relative' }}>
          <button
            className={'btn btn-sm' + (groupFilter.size > 0 ? ' btn-accent' : ' btn-ghost')}
            onClick={() => setFilterOpen((v) => !v)}
            title={t('kanban.filterByGroup')}
            style={{ gap: 6 }}
          >
            <Icon name="branch" size={13} />
            <span>
              {groupFilter.size === 0
                ? t('kanban.allGroups')
                : groupFilter.size === 1
                  ? t('kanban.oneGroup')
                  : t('kanban.nGroups', { count: groupFilter.size })}
            </span>
            <Icon name="chevDown" size={13} />
          </button>
          {filterOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                minWidth: 220,
                maxHeight: 320,
                overflowY: 'auto',
                background: 'var(--surface-1, var(--bg-1))',
                border: '1px solid var(--border, rgba(255,255,255,0.08))',
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                padding: 6,
                zIndex: 50,
              }}
            >
              <div
                className="row"
                style={{
                  justifyContent: 'space-between',
                  padding: '4px 8px 6px',
                  fontSize: 11,
                  color: 'var(--text-3)',
                }}
              >
                <span>{hasGroups ? t('kanban.filterByGroup') : t('kanban.noGroupsYet')}</span>
                {groupFilter.size > 0 && (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '2px 6px', fontSize: 11 }}
                    onClick={() => setGroupFilter(new Set())}
                  >
                    {t('kanban.clear')}
                  </button>
                )}
              </div>
              {allGroups.map((g) => {
                const checked = groupFilter.has(g.id);
                return (
                  <label
                    key={g.id}
                    className="row"
                    style={{
                      gap: 8,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      borderRadius: 6,
                      fontSize: 13,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleGroupFilter(g.id)}
                    />
                    <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: g.color ?? 'var(--text-faint)' }} />
                    <span className="truncate" style={{ flex: 1 }}>{g.title}</span>
                    <button
                      className="td-label-x"
                      title={t('kanban.deleteGroup')}
                      aria-label={t('kanban.deleteGroup')}
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (await confirm({ title: t('kanban.deleteGroup'), message: t('kanban.deleteGroupConfirm', { name: g.title }), confirmLabel: t('kanban.deleteGroup'), danger: true })) onDeleteGroup(g.id);
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </label>
                );
              })}
              {/* Création d'un groupe directement depuis le dropdown. */}
              <div style={{ borderTop: hasGroups ? '1px solid var(--border)' : 'none', marginTop: 4, paddingTop: 4 }}>
                {filterCreating ? (
                  <input
                    autoFocus
                    className="select-sm"
                    style={{ width: '100%', fontSize: 13 }}
                    placeholder={t('kanban.groupNamePlaceholder')}
                    value={filterGroupName}
                    onChange={(e) => setFilterGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void submitFilterGroup(); }
                      else if (e.key === 'Escape') { setFilterCreating(false); setFilterGroupName(''); }
                    }}
                    onBlur={() => { if (!filterGroupName.trim()) setFilterCreating(false); }}
                  />
                ) : (
                  <button
                    className="dd-item"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '6px 8px', fontSize: 13, background: 'transparent',
                      border: 0, color: 'var(--accent)', cursor: 'pointer', borderRadius: 6,
                      textAlign: 'left', fontWeight: 600,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setFilterCreating(true)}
                  >
                    <Icon name="plus" size={13} /> {t('card.newGroup')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="board">
        {renderedColumns.map((col) => {
          const isGroupsCol = col.id === GROUPS_COL.id;
          const items = colTasks(col.id);
          const over = col.wip != null && items.length > col.wip;
          const isDropCol = drag && drag.overCol === col.id;
          // Sous-statuts de cette colonne (containers). Une carte dont le
          // sous-statut est inconnu / d'un autre parent reste en zone
          // principale (fallback subZoneOf). Containers vides masqués.
          const colSubs = isGroupsCol ? [] : subStatuses.filter((s) => s.status === col.status);
          const mainItems = colSubs.length
            ? items.filter((tk) => subZoneOf(tk, col.id) === null)
            : items;
          const subGroups = colSubs
            .map((s) => ({ sub: s, items: items.filter((tk) => subZoneOf(tk, col.id) === s.id) }))
            .filter((g) => g.items.length > 0);
          const isDropMain = !!isDropCol && drag!.overSub === null;
          return (
            <section className={'col' + (over ? ' col-over' : '')} key={col.id}>
              <header className="col-head">
                <div className="row" style={{ gap: 8 }}>
                  <span className="col-dot" data-status={col.status} />
                  <span className="col-name">{isGroupsCol ? t('kanban.group') : localizeColName(col.name, t)}</span>
                  <span className="col-count mono">{items.length}</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {col.wip != null && (
                    <span
                      className={'wip mono' + (over ? ' wip-over' : items.length === col.wip ? ' wip-full' : '')}
                      title={
                        over
                          ? t('kanban.wipOver', { count: items.length, limit: col.wip })
                          : items.length === col.wip
                            ? t('kanban.wipFull', { count: items.length, limit: col.wip })
                            : t('kanban.wipLimit')
                      }
                    >
                      {over && <Icon name="warn" size={12} />}
                      {items.length}/{col.wip}
                    </span>
                  )}
                  <button
                    className="col-add"
                    aria-label={t('kanban.addCard')}
                    onClick={() => {
                      setAdding(col.id);
                      setNewTitle('');
                    }}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                  {/* Limite WIP : pertinente uniquement sur la colonne de travail
                      en cours, pas le backlog (To do) ni les colonnes terminales. */}
                  {canEditBoard && col.status === 'progress' && (
                    <div style={{ position: 'relative' }} ref={wipMenuCol === col.id ? wipMenuRef : undefined}>
                      <button
                        className="col-add"
                        aria-label={t('kanban.colMenu')}
                        title={t('kanban.colMenu')}
                        onClick={() => (wipMenuCol === col.id ? setWipMenuCol(null) : openWipMenu(col))}
                      >
                        <Icon name="dots" size={16} />
                      </button>
                      {wipMenuCol === col.id && (
                        <div className="dd-menu" style={{ right: 0, minWidth: 200, gap: 8, padding: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
                            {t('kanban.wipLimit')}
                          </div>
                          <input
                            type="number"
                            min={1}
                            className="select-sm"
                            style={{ width: '100%' }}
                            value={wipDraft}
                            placeholder={t('kanban.wipNoLimit')}
                            autoFocus
                            onChange={(e) => setWipDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') applyWip(col.id);
                              else if (e.key === 'Escape') setWipMenuCol(null);
                            }}
                          />
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => { setWipDraft(''); onSetWip?.(col.id, null); setWipMenuCol(null); }}
                            >
                              {t('kanban.wipNoLimit')}
                            </button>
                            <button className="btn btn-accent btn-sm" onClick={() => applyWip(col.id)}>
                              {t('common:save')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </header>

              <div className="col-body" data-dropzone={col.id}>
                {adding === col.id && (
                  <div className="composer">
                    <textarea
                      autoFocus
                      value={newTitle}
                      placeholder={t('kanban.taskTitlePlaceholder')}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          addCard(col.id);
                        }
                        if (e.key === 'Escape') setAdding(null);
                      }}
                    />
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn btn-accent btn-sm" onClick={() => addCard(col.id)}>
                        {t('kanban.addTask')}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setAdding(null)}
                      >
                        {t('common:cancel')}
                      </button>
                    </div>
                  </div>
                )}
                {mainItems.map((t, i) => (
                  <React.Fragment key={t.id}>
                    {isDropMain && drag!.overIndex === i && drag!.id !== t.id && <div className="drop-line" />}
                    <KanbanCard
                      task={t}
                      monday={monday}
                      density={density}
                      showLabels={showLabels}
                      dim={!!drag && drag.id === t.id}
                      justMoved={flash === t.id}
                      tint={effectiveColor(t, tasks)}
                      onPointerDown={(e) => onCardPointerDown(e, t)}
                      onEdit={() => onOpen(t.id)}
                      onDelete={() => onDelete(t.id)}
                      groups={allGroups}
                      onAssignGroup={onAssignGroup}
                      onCreateGroup={onCreateGroup}
                    />
                  </React.Fragment>
                ))}
                {isDropMain && (drag!.overIndex! >= mainItems.length || drag!.overIndex == null) && <div className="drop-line" />}

                {/* Containers de sous-statut : zones de drop imbriquées (le
                    `closest('[data-dropzone]')` du drag les fait gagner sur la
                    colonne). Masqués si vides — la première pose d'un
                    sous-statut passe par le détail de tâche. */}
                {subGroups.map((g) => {
                  const isDropSub = !!isDropCol && drag!.overSub === g.sub.id;
                  return (
                    <div
                      key={g.sub.id}
                      className="subcol"
                      data-dropzone={col.id}
                      data-subzone={g.sub.id}
                      style={g.sub.color ? { borderColor: `color-mix(in oklch, ${g.sub.color} 45%, var(--border))` } : undefined}
                    >
                      <div className="subcol-head">
                        <span
                          className="subcol-dot"
                          style={{ background: g.sub.color ?? 'var(--text-3)' }}
                        />
                        <span className="subcol-name truncate">{g.sub.name}</span>
                        <span className="col-count mono">{g.items.length}</span>
                      </div>
                      {g.items.map((t, i) => (
                        <React.Fragment key={t.id}>
                          {isDropSub && drag!.overIndex === i && drag!.id !== t.id && <div className="drop-line" />}
                          <KanbanCard
                            task={t}
                            monday={monday}
                            density={density}
                            showLabels={showLabels}
                            dim={!!drag && drag.id === t.id}
                            justMoved={flash === t.id}
                            tint={effectiveColor(t, tasks)}
                            onPointerDown={(e) => onCardPointerDown(e, t)}
                            onEdit={() => onOpen(t.id)}
                            onDelete={() => onDelete(t.id)}
                            groups={allGroups}
                            onAssignGroup={onAssignGroup}
                            onCreateGroup={onCreateGroup}
                          />
                        </React.Fragment>
                      ))}
                      {isDropSub && (drag!.overIndex! >= g.items.length || drag!.overIndex == null) && <div className="drop-line" />}
                    </div>
                  );
                })}
                {items.length === 0 && adding !== col.id && (
                  <button
                    className="col-empty"
                    onClick={() => {
                      setAdding(col.id);
                      setNewTitle('');
                    }}
                  >
                    <Icon name="plus" size={15} /> {isGroupsCol ? t('kanban.addAGroup') : t('kanban.addATask')}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
