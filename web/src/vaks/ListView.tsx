/* ============================================================
   Vaks — List view (same tasks, grouped by status)
   ============================================================ */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { columns as COLUMNS, users as USERS, type Task, type User } from './data';
import { Avatar, AvatarStack, fmt, Icon, PriorityDot, ProgressRing, Tag } from './primitives';
import { localizeColName } from './colLabel';

interface Group {
  key: string;
  label: string;
  status?: string;
  user?: User;
  items: Task[];
}

export function ListView({
  tasks,
  monday,
  onOpen,
}: {
  tasks: Task[];
  monday: Date;
  density?: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('tasks');
  const [groupBy, setGroupBy] = useState<'status' | 'assignee' | 'priority'>('status');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState<'none' | 'due' | 'priority' | 'progress' | 'title'>('none');
  const [filterPrio, setFilterPrio] = useState<'' | 'urgent' | 'high' | 'normal' | 'low'>('');

  // Filtre (priorité) appliqué avant le regroupement.
  const filtered = useMemo(
    () => (filterPrio ? tasks.filter((t2) => t2.priority === filterPrio) : tasks),
    [tasks, filterPrio],
  );

  // Tri appliqué à l'intérieur de chaque groupe (stable, valeurs absentes en fin).
  const sortItems = useCallback(
    (items: Task[]): Task[] => {
      if (sortBy === 'none') return items;
      const PRIO = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
      const arr = [...items];
      arr.sort((a, b) => {
        switch (sortBy) {
          case 'due': {
            if (a.due == null && b.due == null) return 0;
            if (a.due == null) return 1;
            if (b.due == null) return -1;
            return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
          }
          case 'priority':
            return PRIO[a.priority] - PRIO[b.priority];
          case 'progress':
            return (b.progress ?? 0) - (a.progress ?? 0);
          case 'title':
            return a.title.localeCompare(b.title);
          default:
            return 0;
        }
      });
      return arr;
    },
    [sortBy],
  );

  const groups: Group[] = useMemo(() => {
    let g: Group[];
    if (groupBy === 'status') {
      g = COLUMNS.map((c) => ({ key: c.id, label: localizeColName(c.name, t), status: c.status, items: filtered.filter((t) => t.col === c.id) }));
    } else if (groupBy === 'priority') {
      const order = ['urgent', 'high', 'normal', 'low'] as const;
      g = order.map((p) => ({
        key: p,
        label: t('list.priorityGroup', { priority: t(`list.prio.${p}`) }),
        items: filtered.filter((t2) => t2.priority === p),
      }));
    } else {
      // assignee
      g = USERS.map((u) => ({ key: u.id, label: u.name, user: u, items: filtered.filter((t2) => t2.assignees.includes(u.id)) })).filter(
        (grp) => grp.items.length,
      );
    }
    return g.map((grp) => ({ ...grp, items: sortItems(grp.items) }));
  }, [filtered, groupBy, t, sortItems]);

  return (
    <div className="list-wrap">
      <div className="list-toolbar">
        <div className="row gap2">
          <span className="lt-label">{t('list.groupBy')}</span>
          <div className="seg">
            {(['status', 'assignee', 'priority'] as const).map((g) => (
              <button key={g} className={'seg-btn' + (groupBy === g ? ' seg-on' : '')} onClick={() => setGroupBy(g)}>
                {t(`list.${g}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="row gap2" style={{ color: 'var(--text-3)' }}>
          <label className="row gap1 lt-label" style={{ gap: 6 }}>
            <Icon name="filter" size={15} />
            <select
              className="select-sm"
              value={filterPrio}
              onChange={(e) => setFilterPrio(e.target.value as typeof filterPrio)}
              aria-label={t('list.filter')}
            >
              <option value="">{t('list.filterAll')}</option>
              {(['urgent', 'high', 'normal', 'low'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`list.prio.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="row gap1 lt-label" style={{ gap: 6 }}>
            <Icon name="sort" size={15} />
            <select
              className="select-sm"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              aria-label={t('list.sortBy')}
            >
              <option value="none">{t('list.sortNone')}</option>
              <option value="due">{t('list.due')}</option>
              <option value="priority">{t('list.priority')}</option>
              <option value="progress">{t('list.progress')}</option>
              <option value="title">{t('list.task')}</option>
            </select>
          </label>
        </div>
      </div>

      <div className="list-head">
        <span style={{ paddingLeft: 30 }}>{t('list.task')}</span>
        <span>{t('list.assignees')}</span>
        <span>{t('list.priority')}</span>
        <span>{t('list.due')}</span>
        <span>{t('list.estimate')}</span>
        <span>{t('list.progress')}</span>
      </div>

      {groups.map((g) => {
        const open = !collapsed[g.key];
        return (
          <div key={g.key} className="list-group">
            <button className="list-grouphead" onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}>
              <Icon
                name="chevR"
                size={15}
                style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}
              />
              {g.status && <span className="col-dot" data-status={g.status} />}
              {g.user && <Avatar user={g.user} size={20} />}
              <span className="lg-label">{g.label}</span>
              <span className="lg-count mono">{g.items.length}</span>
            </button>
            {open &&
              g.items.map((t) => {
                const due = fmt.due(t.due, monday);
                return (
                  <div className="list-row" key={t.id} onClick={() => onOpen && onOpen(t.id)}>
                    <div className="lr-title row gap2">
                      <span className="mono lr-key">{t.key}</span>
                      <span className="truncate">{t.title}</span>
                      <div className="row gap1" style={{ flexWrap: 'wrap' }}>
                        {t.labels.slice(0, 2).map((l) => (
                          <Tag key={l} id={l} />
                        ))}
                      </div>
                    </div>
                    <div>
                      <AvatarStack ids={t.assignees} size={22} />
                    </div>
                    <div>
                      <PriorityDot level={t.priority} withLabel />
                    </div>
                    <div>
                      {due ? (
                        <span className={'mono lr-due ' + (due.overdue ? 'due-over' : due.today ? 'due-today' : '')}>{due.label}</span>
                      ) : (
                        <span className="lr-empty">—</span>
                      )}
                    </div>
                    <div className="mono">{t.estimate ? t.estimate + 'h' : <span className="lr-empty">—</span>}</div>
                    <div className="row gap2">
                      <ProgressRing value={t.progress} size={20} />
                      <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        {t.progress}%
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
