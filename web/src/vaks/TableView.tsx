/* ============================================================
   Vaks — Table view (dense editable grid, built-in fields)
   Même état que Kanban/List (`tasks` = `filtered`, `updateTask`/`onMoveColumn`
   = les mêmes handlers Workspace). Édition inline, tri, filtre, sélection
   multiple + actions de masse, colonnes champs personnalisés en lecture
   (opt-in, lazy, cache). Aucun nouvel endpoint, aucun changement de schéma.

   ⚠️ Statuts agents (CLAIMED/CHANGES_REQUESTED/APPROVED) : on ne lit/compare
   JAMAIS `task.status` en dur — toujours via `colKeyOf()` (qui passe par
   `statusColKey()` de taskStatus.ts) ou via la colonne board réelle
   (`task.col` → `COLUMNS`). Cf. mémoire project_agent_statuses_status_maps.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomFieldDefinitionDto, CustomFieldValueDto } from '@vaks-pm/shared';
import {
  columns as COLUMNS,
  users as USERS,
  userById,
  availableAssigneeIds as AVAILABLE_ASSIGNEE_IDS,
  type BoardSubStatus,
  type Priority,
  type Task,
} from './data';
import { Avatar, AvatarStack, Icon, PRIO, fmt } from './primitives';
import { localizeColName } from './colLabel';
import { statusColKey, type StatusColKey } from './taskStatus';
import { CustomFieldControl } from './CustomFieldControl';
import { apiGetTaskCustomFields, apiSetTaskCustomFields, apiListTaskCustomFieldDefs } from './api';

type SortKey = 'title' | 'status' | 'assignee' | 'priority' | 'due' | 'estimate';
type SortDir = 'asc' | 'desc';

const STATUS_COL_ORDER: StatusColKey[] = ['todo', 'progress', 'review', 'hold', 'done'];
const PRIO_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

/** Colonne board (canonique repliée si `task.status` inconnu / colonne disparue). */
function colKeyOf(task: Task): StatusColKey {
  if (task.status) return statusColKey(task.status);
  const col = COLUMNS.find((c) => c.id === task.col);
  return (col?.status as StatusColKey | undefined) ?? 'todo';
}

/** Offset (jours depuis lundi) → valeur `<input type=date>` (YYYY-MM-DD), en
 *  arithmétique UTC pure — DOIT matcher `apiPatchTask` (86_400_000, pas de
 *  méthodes locales) sinon décalage d'un jour. */
function offsetToDateValue(offset: number | null, monday: Date): string {
  if (offset == null) return '';
  return new Date(monday.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}
/** Valeur `<input type=date>` → offset (jours depuis lundi). `''` → null. */
function dateValueToOffset(value: string, monday: Date): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime() - monday.getTime();
  return Math.round(ms / 86_400_000);
}

/** Exécute `fn` sur `items` avec au plus `limit` promesses en vol. */
async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item).catch(() => {});
    }
  });
  await Promise.all(workers);
}

interface TableViewProps {
  tasks: Task[];
  monday: Date;
  density?: string;
  /** Sous-statuts (Custom Status) applicables au projet — affichés en lecture
   *  (petit libellé sous le badge de statut) quand une tâche en porte un. */
  subStatuses: BoardSubStatus[];
  projectId?: string | null;
  onOpen: (id: string) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  onMoveColumn: (taskId: string, columnId: string, opts?: { completePredecessors?: boolean }) => void;
  /** Sortie du mode « édition en masse » → retour à la vue Liste. */
  onExit?: () => void;
}

export function TableView({
  tasks,
  monday,
  density,
  subStatuses,
  projectId,
  onOpen,
  updateTask,
  onMoveColumn,
  onExit,
}: TableViewProps) {
  const { t } = useTranslation('tasks');
  const { t: tc } = useTranslation();
  const compact = density === 'compact';

  // ---------- Filtre ----------
  const [filterStatus, setFilterStatus] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterPriority, setFilterPriority] = useState<'' | Priority>('');

  const filtered = useMemo(() => {
    return tasks.filter((tk) => {
      if (filterStatus && colKeyOf(tk) !== filterStatus) return false;
      if (filterPriority && tk.priority !== filterPriority) return false;
      if (filterAssignee === '__none__' && tk.assignees.length > 0) return false;
      if (filterAssignee && filterAssignee !== '__none__' && !tk.assignees.includes(filterAssignee)) return false;
      return true;
    });
  }, [tasks, filterStatus, filterAssignee, filterPriority]);

  // ---------- Tri ----------
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const toggleSort = useCallback((key: SortKey) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      if (s.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let c = 0;
      switch (sort.key) {
        case 'title':
          c = a.title.localeCompare(b.title);
          break;
        case 'status':
          c = STATUS_COL_ORDER.indexOf(colKeyOf(a)) - STATUS_COL_ORDER.indexOf(colKeyOf(b));
          break;
        case 'assignee': {
          const an = a.assignees.length ? (userById[a.assignees[0]]?.name ?? '') : '';
          const bn = b.assignees.length ? (userById[b.assignees[0]]?.name ?? '') : '';
          if (!an && !bn) c = 0;
          else if (!an) c = 1;
          else if (!bn) c = -1;
          else c = an.localeCompare(bn);
          break;
        }
        case 'priority':
          c = PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority];
          break;
        case 'due':
          if (a.due == null && b.due == null) c = 0;
          else if (a.due == null) c = 1;
          else if (b.due == null) c = -1;
          else c = a.due - b.due;
          break;
        case 'estimate':
          if (a.estimate == null && b.estimate == null) c = 0;
          else if (a.estimate == null) c = 1;
          else if (b.estimate == null) c = -1;
          else c = a.estimate - b.estimate;
          break;
      }
      return c * dir;
    });
    return arr;
  }, [filtered, sort]);

  // ---------- Sélection multiple ----------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Un projet/filtre change sous nos pieds : purge les ids qui ont disparu
    // de la liste visible plutôt que de garder une sélection fantôme.
    setSelected((s) => {
      const visible = new Set(sorted.map((tk) => tk.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of s) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : s;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted]);
  const allVisibleSelected = sorted.length > 0 && sorted.every((tk) => selected.has(tk.id));
  const toggleSelectAll = () => {
    setSelected((s) => {
      if (allVisibleSelected) return new Set();
      return new Set(sorted.map((tk) => tk.id));
    });
  };
  const toggleSelectRow = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---------- Brouillon (édition en masse = save explicite) ----------
  // Toutes les éditions (inline + actions de masse + champs custom) sont
  // ACCUMULÉES localement et ne partent en base qu'au clic « Enregistrer ».
  // `draft` = patch de champs built-in par tâche ; `customDraft` = valeurs de
  // champs personnalisés en attente par tâche/field. `effective()` fusionne le
  // brouillon par-dessus la tâche d'origine pour l'affichage.
  const [draft, setDraft] = useState<Record<string, Partial<Task>>>({});
  const [customDraft, setCustomDraft] = useState<Record<string, Record<string, string>>>({});
  const stage = useCallback((id: string, patch: Partial<Task>) => {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  }, []);
  const stageCustom = useCallback((id: string, fieldId: string, value: string) => {
    setCustomDraft((d) => ({ ...d, [id]: { ...d[id], [fieldId]: value } }));
  }, []);
  const effective = useCallback((tk: Task): Task => (draft[tk.id] ? { ...tk, ...draft[tk.id] } : tk), [draft]);

  // ---------- Actions de masse ----------
  const bulkAssign = (userId: string) => {
    if (!userId) return;
    for (const id of selected) {
      const tk = tasks.find((x) => x.id === id);
      if (!tk) continue;
      const cur = effective(tk).assignees;
      if (cur.includes(userId)) continue;
      stage(id, { assignees: [...cur, userId] });
    }
    setSelected(new Set());
  };
  const bulkStatus = (columnId: string) => {
    const col = COLUMNS.find((c) => c.id === columnId);
    if (!col) return;
    for (const id of selected) {
      const tk = tasks.find((x) => x.id === id);
      if (!tk) continue;
      stage(id, { col: col.id, progress: col.status === 'done' ? 100 : (effective(tk).progress ?? 0) });
    }
    setSelected(new Set());
  };
  const bulkPriority = (priority: Priority) => {
    for (const id of selected) stage(id, { priority });
    setSelected(new Set());
  };

  // ---------- Édition inline (échéance / estimation) ----------
  const [editing, setEditing] = useState<{ id: string; field: 'due' | 'estimate' } | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  // Escape déclenche `setEditing(null)`, qui démonte l'input → le navigateur
  // émet un `blur` natif sur un nœud sur le point d'être retiré. `onBlur` est
  // un simple callback (pas de setState fonctionnel) : sa fermeture capture
  // `editing`/`editBuffer` du dernier rendu (non-null) et pourrait donc
  // re-sauver la valeur qu'Échap vient d'annuler si ce blur est redispatché.
  // Un ref (identité stable, lu à la volée) coupe court à cette course sans
  // dépendre du timing exact React/navigateur.
  const skipBlurRef = useRef(false);
  const startEdit = (task: Task, field: 'due' | 'estimate') => {
    setEditing({ id: task.id, field });
    setEditBuffer(field === 'due' ? offsetToDateValue(task.due, monday) : task.estimate != null ? String(task.estimate) : '');
  };
  const commitEdit = () => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    if (!editing) return;
    const { id, field } = editing;
    if (field === 'due') {
      stage(id, { due: dateValueToOffset(editBuffer, monday) });
    } else {
      const n = editBuffer.trim() === '' ? null : parseFloat(editBuffer);
      stage(id, { estimate: Number.isFinite(n as number) ? n : null });
    }
    setEditing(null);
  };
  const cancelEdit = () => {
    skipBlurRef.current = true;
    setEditing(null);
  };

  // ---------- Assignees (popover par ligne) ----------
  const [assigneeEditId, setAssigneeEditId] = useState<string | null>(null);
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const assigneeWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!assigneeEditId) return;
    const close = (e: PointerEvent) => {
      if (assigneeWrapRef.current && !assigneeWrapRef.current.contains(e.target as Node)) {
        setAssigneeEditId(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [assigneeEditId]);
  const assignableUsers = useMemo(
    () =>
      AVAILABLE_ASSIGNEE_IDS
        ? USERS.filter((u) => AVAILABLE_ASSIGNEE_IDS!.has(u.id))
        : USERS.filter((u) => u.kind !== 'AGENT'),
    // USERS/AVAILABLE_ASSIGNEE_IDS sont des bindings ESM live (module data.ts) ;
    // recalculés à chaque render du composant (peu coûteux, listes bornées).
    [tasks],
  );

  // ---------- Champs personnalisés (lecture, opt-in) ----------
  const [showCustom, setShowCustom] = useState(false);
  const [customDefs, setCustomDefs] = useState<CustomFieldDefinitionDto[] | null>(null);
  const [customValues, setCustomValues] = useState<Record<string, CustomFieldValueDto[]>>({});
  const customCacheRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!showCustom || customDefs !== null) return;
    let alive = true;
    apiListTaskCustomFieldDefs()
      .then((defs) => {
        if (!alive) return;
        setCustomDefs(
          defs.filter((d) => d.projectIds.length === 0 || (!!projectId && d.projectIds.includes(projectId))),
        );
      })
      .catch(() => alive && setCustomDefs([]));
    return () => {
      alive = false;
    };
  }, [showCustom, customDefs, projectId]);

  useEffect(() => {
    if (!showCustom || !customDefs || customDefs.length === 0) return;
    const missing = sorted.map((tk) => tk.id).filter((id) => !customCacheRef.current.has(id));
    if (missing.length === 0) return;
    // Marqué "en cache" tout de suite (avant résolution) : un nouveau run de cet
    // effet (tri/filtre qui change pendant que ce lot est en vol) ne relance pas
    // les mêmes fetch — la concurrence globale reste bornée par lot de 4.
    for (const id of missing) customCacheRef.current.add(id);
    void runBounded(missing, 4, async (id) => {
      try {
        const rows = await apiGetTaskCustomFields(id);
        setCustomValues((cv) => ({ ...cv, [id]: rows }));
      } catch {
        // Best-effort : la cellule reste vide plutôt que de casser la table.
      }
    });
  }, [showCustom, customDefs, sorted]);

  // ---------- Save / discard du brouillon ----------
  const dirtyIds = useMemo(
    () => new Set([...Object.keys(draft), ...Object.keys(customDraft)]),
    [draft, customDraft],
  );
  const dirtyCount = dirtyIds.size;
  const [saving, setSaving] = useState(false);

  const saveAll = useCallback(async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    try {
      // Champs built-in : un updateTask par tâche ; un onMoveColumn si la
      // colonne (statut) a changé — même ordre que l'édition live d'origine.
      for (const [id, patch] of Object.entries(draft)) {
        updateTask(id, patch);
        if (patch.col !== undefined) onMoveColumn(id, patch.col);
      }
      // Champs personnalisés : un appel batché par tâche.
      await Promise.all(
        Object.entries(customDraft).map(async ([id, fields]) => {
          const payload = Object.entries(fields).map(([fieldId, value]) => ({ fieldId, value }));
          if (payload.length === 0) return;
          try {
            const rows = await apiSetTaskCustomFields(id, payload);
            setCustomValues((cv) => ({ ...cv, [id]: rows }));
          } catch {
            /* best-effort : la cellule retombe sur la valeur connue */
          }
        }),
      );
      setDraft({});
      setCustomDraft({});
    } finally {
      setSaving(false);
    }
  }, [dirtyCount, draft, customDraft, updateTask, onMoveColumn]);

  const discardAll = useCallback(() => {
    setDraft({});
    setCustomDraft({});
    setEditing(null);
  }, []);

  const saveAndExit = useCallback(() => {
    void saveAll().then(() => onExit?.());
  }, [saveAll, onExit]);
  const discardAndExit = useCallback(() => {
    discardAll();
    onExit?.();
  }, [discardAll, onExit]);

  // ---------- Grille (colonnes dynamiques selon champs custom) ----------
  const baseTemplate = 'minmax(26px,26px) minmax(220px,2.3fr) 148px 128px 116px 108px 88px';
  const customTemplate = showCustom && customDefs ? customDefs.map(() => '140px').join(' ') : '';
  const gridTemplate = customTemplate ? `${baseTemplate} ${customTemplate}` : baseTemplate;

  const sortIcon = (key: SortKey) =>
    sort?.key === key ? (
      <Icon name="chevDown" size={12} style={{ transform: sort.dir === 'asc' ? 'rotate(180deg)' : 'none' }} />
    ) : null;

  return (
    <div className={'tbl-wrap' + (compact ? ' tbl-compact' : '')}>
      <div className="tbl-toolbar">
        <div className="row gap2" style={{ flexWrap: 'wrap' }}>
          <label className="row gap1 lt-label" style={{ gap: 6 }}>
            <Icon name="filter" size={14} />
            <select
              className="tbl-select"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              aria-label={t('table.filterStatus')}
            >
              <option value="">{t('table.filterAll')}</option>
              {STATUS_COL_ORDER.map((k) => (
                <option key={k} value={k}>
                  {t('status.' + k)}
                </option>
              ))}
            </select>
          </label>
          <select
            className="tbl-select"
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            aria-label={t('table.filterAssignee')}
          >
            <option value="">{t('table.filterAll')}</option>
            <option value="__none__">{t('table.unassigned')}</option>
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select
            className="tbl-select"
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value as '' | Priority)}
            aria-label={t('table.filterPriority')}
          >
            <option value="">{t('table.filterAll')}</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`list.prio.${p}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="row gap2">
          <button
            type="button"
            className={'btn btn-sm btn-ghost' + (showCustom ? ' tbl-toggle-on' : '')}
            onClick={() => setShowCustom((v) => !v)}
            title={showCustom ? t('table.hideCustom') : t('table.showCustom')}
          >
            <Icon name="sliders" size={14} />
            {showCustom ? t('table.hideCustom') : t('table.showCustom')}
          </button>
          {dirtyCount > 0 ? (
            <>
              <span className="tbl-dirty-badge">{t('table.unsavedCount', { count: dirtyCount })}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={discardAndExit} disabled={saving}>
                {t('table.discard')}
              </button>
              <button type="button" className="btn btn-sm btn-primary row gap1" onClick={saveAndExit} disabled={saving}>
                <Icon name="check" size={14} />
                {t('table.save', { count: dirtyCount })}
              </button>
            </>
          ) : (
            onExit && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={onExit}>
                {t('table.close')}
              </button>
            )
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="tbl-bulkbar">
          <span className="tbl-bulkcount mono">{t('table.selectedCount', { count: selected.size })}</span>
          <select
            className="tbl-select"
            value=""
            onChange={(e) => e.target.value && bulkAssign(e.target.value)}
            aria-label={t('table.bulkAssign')}
          >
            <option value="">{t('table.bulkAssign')}</option>
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select
            className="tbl-select"
            value=""
            onChange={(e) => e.target.value && bulkStatus(e.target.value)}
            aria-label={t('table.bulkStatus')}
          >
            <option value="">{t('table.bulkStatus')}</option>
            {COLUMNS.map((c) => (
              <option key={c.id} value={c.id}>
                {localizeColName(c.name, t)}
              </option>
            ))}
          </select>
          <select
            className="tbl-select"
            value=""
            onChange={(e) => e.target.value && bulkPriority(e.target.value as Priority)}
            aria-label={t('table.bulkPriority')}
          >
            <option value="">{t('table.bulkPriority')}</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`list.prio.${p}`)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            {t('table.clearSelection')}
          </button>
        </div>
      )}

      <div className="tbl-scroll">
        <div className="tbl-head" style={{ gridTemplateColumns: gridTemplate }}>
          <span>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              aria-label={t('table.selectAll')}
            />
          </span>
          <button className="tbl-hcell" onClick={() => toggleSort('title')}>
            {t('table.colTask')} {sortIcon('title')}
          </button>
          <button className="tbl-hcell" onClick={() => toggleSort('status')}>
            {t('table.colStatus')} {sortIcon('status')}
          </button>
          <button className="tbl-hcell" onClick={() => toggleSort('assignee')}>
            {t('table.colAssignees')} {sortIcon('assignee')}
          </button>
          <button className="tbl-hcell" onClick={() => toggleSort('priority')}>
            {t('table.colPriority')} {sortIcon('priority')}
          </button>
          <button className="tbl-hcell" onClick={() => toggleSort('due')}>
            {t('table.colDue')} {sortIcon('due')}
          </button>
          <button className="tbl-hcell" onClick={() => toggleSort('estimate')}>
            {t('table.colEstimate')} {sortIcon('estimate')}
          </button>
          {showCustom &&
            customDefs?.map((def) => (
              <span className="tbl-hcell tbl-hcell-static" key={def.id} title={def.name}>
                {def.name}
              </span>
            ))}
        </div>

        {sorted.length === 0 && <div className="tbl-empty">{t('table.empty')}</div>}

        {sorted.map((tk) => {
          const etk = effective(tk);
          const col = COLUMNS.find((c) => c.id === etk.col);
          const dotStatus = col?.status ?? colKeyOf(etk);
          const statusLabel = col ? localizeColName(col.name, t) : t('status.' + colKeyOf(etk));
          const sub = etk.subStatusId ? subStatuses.find((s) => s.id === etk.subStatusId) : undefined;
          const due = fmt.due(etk.due, monday);
          const isEditingDue = editing?.id === tk.id && editing.field === 'due';
          const isEditingEst = editing?.id === tk.id && editing.field === 'estimate';
          const rowDirty = dirtyIds.has(tk.id);
          return (
            <div className={'tbl-row' + (rowDirty ? ' tbl-row-dirty' : '')} key={tk.id} style={{ gridTemplateColumns: gridTemplate }}>
              <span>
                <input
                  type="checkbox"
                  checked={selected.has(tk.id)}
                  onChange={() => toggleSelectRow(tk.id)}
                  aria-label={t('table.selectRow', { title: tk.title })}
                />
              </span>
              <div className="tbl-title row gap2" onClick={() => onOpen(tk.id)}>
                <span className="mono lr-key">{tk.key}</span>
                <span className="truncate">{tk.title}</span>
              </div>
              <div className="tbl-cell tbl-status-cell">
                <span className="col-dot" data-status={dotStatus} />
                <select
                  className="td-select-inline tbl-status-select"
                  value={etk.col}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const c = COLUMNS.find((x) => x.id === e.target.value);
                    if (!c) return;
                    stage(tk.id, { col: c.id, progress: c.status === 'done' ? 100 : etk.progress });
                  }}
                  aria-label={t('table.colStatus')}
                >
                  {COLUMNS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {localizeColName(c.name, t)}
                    </option>
                  ))}
                  {!col && <option value={etk.col}>{statusLabel}</option>}
                </select>
                {sub && <span className="tbl-substatus truncate">{sub.name}</span>}
              </div>
              <div className="tbl-cell" ref={assigneeEditId === tk.id ? assigneeWrapRef : undefined} style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="tbl-assignee-trigger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAssigneeQuery('');
                    setAssigneeEditId((cur) => (cur === tk.id ? null : tk.id));
                  }}
                  title={t('table.editHint')}
                >
                  {etk.assignees.length > 0 ? (
                    <AvatarStack ids={etk.assignees} size={20} />
                  ) : (
                    <span className="lr-empty">{t('table.unassigned')}</span>
                  )}
                </button>
                {assigneeEditId === tk.id && (
                  <div className="dd-menu tbl-assignee-menu">
                    <input
                      className="tbl-assignee-search"
                      value={assigneeQuery}
                      onChange={(e) => setAssigneeQuery(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder={t('table.searchUser')}
                      autoFocus
                    />
                    <div className="tbl-assignee-list">
                      {(() => {
                        const q = assigneeQuery.trim().toLowerCase();
                        const list = q
                          ? assignableUsers.filter((u) => u.name.toLowerCase().includes(q))
                          : assignableUsers;
                        if (list.length === 0)
                          return <div className="tbl-empty-menu">{t(q ? 'table.noMatch' : 'table.unassigned')}</div>;
                        return list.map((u) => {
                          const on = etk.assignees.includes(u.id);
                          return (
                            <button
                              key={u.id}
                              type="button"
                              className="dd-item"
                              onClick={() =>
                                stage(tk.id, {
                                  assignees: on
                                    ? etk.assignees.filter((a) => a !== u.id)
                                    : [...etk.assignees, u.id],
                                })
                              }
                            >
                              <Avatar user={u} size={18} title={false} />
                              <span className="grow truncate">{u.name}</span>
                              {on && <Icon name="check" size={14} style={{ color: 'var(--accent)' }} />}
                            </button>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}
              </div>
              <div className="tbl-cell">
                <select
                  className="td-select-inline"
                  style={{ color: PRIO[etk.priority]?.c, fontWeight: 700 }}
                  value={etk.priority}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => stage(tk.id, { priority: e.target.value as Priority })}
                  aria-label={t('table.colPriority')}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {tc(`priority.${p}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tbl-cell" onClick={(e) => e.stopPropagation()}>
                {isEditingDue ? (
                  <input
                    className="td-in tbl-in"
                    type="date"
                    autoFocus
                    value={editBuffer}
                    onChange={(e) => setEditBuffer(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      else if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                ) : (
                  <button type="button" className="tbl-editable" onClick={() => startEdit(etk, 'due')} title={t('table.editHint')}>
                    {due ? (
                      <span className={'mono lr-due ' + (due.overdue ? 'due-over' : due.today ? 'due-today' : '')}>{due.label}</span>
                    ) : (
                      <span className="lr-empty">—</span>
                    )}
                  </button>
                )}
              </div>
              <div className="tbl-cell" onClick={(e) => e.stopPropagation()}>
                {isEditingEst ? (
                  <input
                    className="td-in tbl-in tbl-in-num mono"
                    type="number"
                    step={0.25}
                    min={0}
                    autoFocus
                    value={editBuffer}
                    onChange={(e) => setEditBuffer(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      else if (e.key === 'Escape') cancelEdit();
                    }}
                  />
                ) : (
                  <button type="button" className="tbl-editable mono" onClick={() => startEdit(etk, 'estimate')} title={t('table.editHint')}>
                    {etk.estimate ? etk.estimate + 'h' : <span className="lr-empty">—</span>}
                  </button>
                )}
              </div>
              {showCustom &&
                customDefs?.map((def) => {
                  const rows = customValues[tk.id];
                  const row = rows?.find((r) => r.fieldId === def.id);
                  const draftVal = customDraft[tk.id]?.[def.id];
                  const effVal = draftVal !== undefined ? draftVal : (row?.value ?? null);
                  return (
                    <div className="tbl-cell" key={def.id} onClick={(e) => e.stopPropagation()}>
                      {rows === undefined ? (
                        <span className="lr-empty">…</span>
                      ) : (
                        <CustomFieldControl
                          def={def}
                          value={effVal}
                          onChange={(v) => stageCustom(tk.id, def.id, v)}
                        />
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
