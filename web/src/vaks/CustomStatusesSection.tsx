/* ============================================================
   Admin > Custom Status (sous-statuts)
   Catalogue des sous-statuts de l'organisation. Un sous-statut appartient à un
   statut parent (TODO / IN_PROGRESS / IN_REVIEW / ON_HOLD / DONE — le cycle
   agents n'est pas subdivisable) et peut être restreint à certains projets.
   Édition gouvernée par `customStatuses.writeMode` (contrôle serveur ; l'UI
   masque juste les affordances si `canWrite` est faux).

   UX calquée sur CustomFieldsSection : recherche, liste `dir-card` groupée par
   statut parent, modale d'édition avec sélecteur de portée projets.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { SUB_STATUS_PARENTS, type SubStatusParent } from '@vaks-pm/shared';
import type { CustomStatusDto, ProjectDto, TeamDto, UserDto } from '@vaks-pm/shared';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

const SCOPE_PAGE_SIZE = 8;

/** Couleur de repère par statut parent (pastille de groupe). */
const PARENT_COLOR: Record<SubStatusParent, string> = {
  TODO: 'var(--text-3)',
  IN_PROGRESS: 'var(--accent)',
  IN_REVIEW: '#8a63d2',
  ON_HOLD: '#c47f17',
  DONE: '#3a9d5d',
};

interface FormState {
  id: string | null; // null = création
  parentStatus: SubStatusParent;
  name: string;
  color: string | null;
  projectIds: string[];
  /** Notification à l'entrée : users directs + équipes (tous les membres). */
  notifyUserIds: string[];
  notifyTeamIds: string[];
}

const BLANK: FormState = {
  id: null,
  parentStatus: 'IN_PROGRESS',
  name: '',
  color: null,
  projectIds: [],
  notifyUserIds: [],
  notifyTeamIds: [],
};

export default function CustomStatusesSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('customstatuses');
  const confirm = useConfirm();
  const [statuses, setStatuses] = useState<CustomStatusDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, caps, projs, tms, usrs] = await Promise.all([
        api.listCustomStatuses(),
        api.customStatusCapabilities().catch(() => ({ canWrite: false })),
        api.listProjects('all').catch(() => [] as ProjectDto[]),
        api.listTeams().catch(() => [] as TeamDto[]),
        api.listUsers().catch(() => [] as UserDto[]),
      ]);
      setStatuses(list);
      setCanWrite(caps.canWrite);
      setProjects(projs);
      setTeams(tms);
      setUsers(usrs);
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? id,
    [projects],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return statuses.filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [statuses, search]);

  /** Groupes par statut parent, dans l'ordre canonique, vides masqués. */
  const groups = useMemo(
    () =>
      SUB_STATUS_PARENTS.map((parent) => ({
        parent,
        items: filtered.filter((s) => s.parentStatus === parent),
      })).filter((g) => g.items.length > 0),
    [filtered],
  );

  const openCreate = () => setEdit({ ...BLANK });
  const openEdit = (s: CustomStatusDto) =>
    setEdit({
      id: s.id,
      parentStatus: s.parentStatus,
      name: s.name,
      color: s.color,
      projectIds: s.projectIds,
      notifyUserIds: s.notifyUserIds ?? [],
      notifyTeamIds: s.notifyTeamIds ?? [],
    });

  const submit = async () => {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) return flash(t('nameRequired'), 'err');
    setSaving(true);
    try {
      if (edit.id) {
        // Le statut parent est immuable : on n'envoie que le modifiable.
        await api.updateCustomStatus(edit.id, {
          name,
          color: edit.color,
          projectIds: edit.projectIds,
          notifyUserIds: edit.notifyUserIds,
          notifyTeamIds: edit.notifyTeamIds,
        });
        flash(t('saved'), 'ok');
      } else {
        await api.createCustomStatus({
          parentStatus: edit.parentStatus,
          name,
          color: edit.color,
          projectIds: edit.projectIds,
          notifyUserIds: edit.notifyUserIds,
          notifyTeamIds: edit.notifyTeamIds,
        });
        flash(t('created'), 'ok');
      }
      setEdit(null);
      await refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: CustomStatusDto) => {
    if (
      !(await confirm({
        title: t('deleteTitle'),
        message: t('deleteMsg', { name: s.name }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteCustomStatus(s.id);
      flash(t('deleted'), 'ok');
      await refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  return (
    <div>
      {/* Recherche + total + créer */}
      <div className="lfilter">
        <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
        />
        <span className="lf-count">{filtered.length}</span>
        {canWrite && (
          <button
            className="btn btn-accent btn-sm"
            style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
            onClick={openCreate}
          >
            <Icon name="plus" size={14} /> {t('newStatus')}
          </button>
        )}
      </div>

      {loading && <div className="set-desc" style={{ padding: 16 }}>{t('common:loading')}</div>}
      {!loading && filtered.length === 0 && (
        <div className="dir-card">
          <div className="set-desc" style={{ padding: 16 }}>
            {statuses.length === 0 ? t('empty') : t('noMatch')}
          </div>
        </div>
      )}

      {!loading &&
        groups.map((g) => (
          <div key={g.parent} style={{ marginBottom: 14 }}>
            <div
              className="md-label"
              style={{ margin: '10px 2px 6px', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span
                aria-hidden
                style={{ width: 8, height: 8, borderRadius: '50%', background: PARENT_COLOR[g.parent] }}
              />
              {t('parent.' + g.parent)}
              <span style={{ opacity: 0.5, fontWeight: 400 }}>({g.items.length})</span>
            </div>
            <div className="dir-card">
              {g.items.map((s) => (
                <div key={s.id} className="dir-row">
                  <div
                    aria-hidden
                    style={{
                      width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                      display: 'grid', placeItems: 'center',
                      background: s.color
                        ? `color-mix(in oklch, ${s.color} 18%, var(--surface))`
                        : 'color-mix(in oklch, var(--accent) 14%, var(--surface))',
                      color: s.color ?? 'var(--accent)',
                    }}
                  >
                    <Icon name="flag" size={15} />
                  </div>
                  <div className="dir-id">
                    <div className="dir-name">{s.name}</div>
                    <div
                      className="dir-email"
                      title={
                        s.projectIds.length === 0
                          ? undefined
                          : s.projectIds.map(projectName).join(', ')
                      }
                    >
                      {s.projectIds.length === 0
                        ? t('scopeAll')
                        : t('scopeNProjects', { count: s.projectIds.length })}
                    </div>
                  </div>
                  <div className="dir-title">
                    {t('parent.' + s.parentStatus)}
                    {(s.notifyUserIds?.length ?? 0) + (s.notifyTeamIds?.length ?? 0) > 0 && (
                      <span
                        title={t('notifyBadgeTitle')}
                        style={{ marginLeft: 8, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12 }}
                      >
                        <Icon name="bell" size={13} />
                        {(s.notifyUserIds?.length ?? 0) + (s.notifyTeamIds?.length ?? 0)}
                      </span>
                    )}
                  </div>
                  <div className="row gap2" style={{ flexShrink: 0 }}>
                    {canWrite && (
                      <>
                        <button
                          className="btn btn-line btn-sm"
                          style={{ whiteSpace: 'nowrap' }}
                          onClick={() => openEdit(s)}
                        >
                          <Icon name="pencil" size={14} /> {t('common:edit')}
                        </button>
                        <button className="icon-btn" onClick={() => remove(s)} title={t('common:delete')}>
                          <Icon name="x" size={15} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

      {edit && (
        <StatusEditorModal
          edit={edit}
          setEdit={setEdit}
          projects={projects}
          teams={teams}
          users={users}
          saving={saving}
          onCancel={() => setEdit(null)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modale — nom, statut parent (figé en édition), couleur, portée projets.
// ---------------------------------------------------------------------------

function StatusEditorModal({
  edit,
  setEdit,
  projects,
  teams,
  users,
  saving,
  onCancel,
  onSubmit,
}: {
  edit: FormState;
  setEdit: React.Dispatch<React.SetStateAction<FormState | null>>;
  projects: ProjectDto[];
  teams: TeamDto[];
  users: UserDto[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation('customstatuses');
  const [scopeSearch, setScopeSearch] = useState('');
  const [scopePage, setScopePage] = useState(1);
  useEffect(() => setScopePage(1), [scopeSearch]);
  // Recherche du picker de users à notifier (liste bornée : 8 premiers matches).
  const [userSearch, setUserSearch] = useState('');
  const toggleIn = (key: 'notifyUserIds' | 'notifyTeamIds', id: string) =>
    setEdit((s) =>
      s
        ? {
            ...s,
            [key]: s[key].includes(id) ? s[key].filter((x) => x !== id) : [...s[key], id],
          }
        : s,
    );
  const matchedUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    // Sélectionnés toujours affichés en tête ; puis les correspondances.
    const selected = users.filter((u) => edit.notifyUserIds.includes(u.id));
    const rest = users.filter(
      (u) =>
        !edit.notifyUserIds.includes(u.id) &&
        (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
    );
    return [...selected, ...rest.slice(0, 8)];
  }, [users, userSearch, edit.notifyUserIds]);

  const toggleProject = (id: string) =>
    setEdit((s) =>
      s
        ? {
            ...s,
            projectIds: s.projectIds.includes(id)
              ? s.projectIds.filter((x) => x !== id)
              : [...s.projectIds, id],
          }
        : s,
    );

  const filteredProjects = useMemo(() => {
    const q = scopeSearch.trim().toLowerCase();
    return projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [projects, scopeSearch]);

  const scopePageCount = Math.max(1, Math.ceil(filteredProjects.length / SCOPE_PAGE_SIZE));
  const scopePaged = filteredProjects.slice(
    (scopePage - 1) * SCOPE_PAGE_SIZE,
    scopePage * SCOPE_PAGE_SIZE,
  );

  return (
    <div className="md-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="md-card" role="dialog" aria-label={edit.id ? t('editTitle') : t('newStatus')}>
        <div className="md-head">{edit.id ? t('editTitle') : t('newStatus')}</div>
        <div className="md-body">
          <div className="md-field">
            <label className="md-label">{t('col.name')}</label>
            <input
              className="td-in grow"
              value={edit.name}
              autoFocus
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
          </div>

          {/* Statut parent : figé en édition (changer le parent muterait le
              statut moteur des tâches qui portent le sous-statut). */}
          <div className="md-field">
            <label className="md-label">{t('col.parent')}</label>
            <select
              className="td-in grow"
              value={edit.parentStatus}
              disabled={!!edit.id}
              onChange={(e) => setEdit({ ...edit, parentStatus: e.target.value as SubStatusParent })}
            >
              {SUB_STATUS_PARENTS.map((p) => (
                <option key={p} value={p}>
                  {t('parent.' + p)}
                </option>
              ))}
            </select>
            {edit.id && (
              <div className="atext" style={{ fontSize: 11, opacity: 0.6 }}>{t('parentLocked')}</div>
            )}
          </div>

          <div className="md-field">
            <label className="md-label">{t('col.color')}</label>
            <div className="row gap2" style={{ alignItems: 'center' }}>
              <input
                type="color"
                value={edit.color ?? '#7c5cff'}
                onChange={(e) => setEdit({ ...edit, color: e.target.value })}
                style={{ width: 40, height: 28, padding: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
              />
              {edit.color ? (
                <button className="btn btn-line btn-sm" onClick={() => setEdit({ ...edit, color: null })}>
                  {t('colorClear')}
                </button>
              ) : (
                <span className="atext" style={{ fontSize: 12, opacity: 0.6 }}>{t('colorNone')}</span>
              )}
            </div>
          </div>

          {/* Notification à l'ENTRÉE : équipes (tous les membres) + users
              directs. Email + carte Teams via le pipeline automations
              (cooldown anti-spam par tâche×sous-statut, acteur exclu). */}
          <div className="md-field">
            <label className="md-label">
              <Icon name="bell" size={13} /> {t('notifyLabel')}
              {edit.notifyTeamIds.length + edit.notifyUserIds.length > 0 && (
                <span style={{ opacity: 0.6, fontWeight: 400 }}>
                  {' '}
                  · {t('scopeSelected', { count: edit.notifyTeamIds.length + edit.notifyUserIds.length })}
                </span>
              )}
            </label>
            <div className="atext" style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
              {t('notifyHint')}
            </div>

            {teams.length > 0 && (
              <>
                <div className="atext" style={{ fontSize: 11, fontWeight: 700, margin: '2px 0 4px' }}>
                  {t('notifyTeams')}
                </div>
                <div
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 2,
                    border: '1px solid var(--border)', borderRadius: 8, padding: 6,
                    maxHeight: 150, overflowY: 'auto', marginBottom: 8,
                  }}
                >
                  {teams.map((tm) => (
                    <label
                      key={tm.id}
                      className="row gap1"
                      style={{ cursor: 'pointer', fontSize: 13, padding: '4px 4px', borderRadius: 6 }}
                    >
                      <input
                        type="checkbox"
                        checked={edit.notifyTeamIds.includes(tm.id)}
                        onChange={() => toggleIn('notifyTeamIds', tm.id)}
                      />
                      <span>{tm.displayName ?? tm.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="atext" style={{ fontSize: 11, fontWeight: 700, margin: '2px 0 4px' }}>
              {t('notifyUsers')}
            </div>
            <div className="lfilter" style={{ marginBottom: 6 }}>
              <Icon name="search" size={14} style={{ color: 'var(--text-3)' }} />
              <input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder={t('notifyUserSearchPlaceholder')}
              />
            </div>
            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 2,
                border: '1px solid var(--border)', borderRadius: 8, padding: 6,
                maxHeight: 180, overflowY: 'auto',
              }}
            >
              {matchedUsers.length === 0 ? (
                <div className="atext" style={{ fontSize: 12, opacity: 0.6, padding: 8 }}>
                  {t('noProjectMatch')}
                </div>
              ) : (
                matchedUsers.map((u) => (
                  <label
                    key={u.id}
                    className="row gap1"
                    style={{ cursor: 'pointer', fontSize: 13, padding: '4px 4px', borderRadius: 6 }}
                  >
                    <input
                      type="checkbox"
                      checked={edit.notifyUserIds.includes(u.id)}
                      onChange={() => toggleIn('notifyUserIds', u.id)}
                    />
                    <span className="truncate">{u.name}</span>
                    <span className="truncate" style={{ opacity: 0.5, fontSize: 12 }}>{u.email}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="md-field">
            <label className="md-label">
              {t('scopeLabel')}
              {edit.projectIds.length > 0 && (
                <span style={{ opacity: 0.6, fontWeight: 400 }}>
                  {' '}
                  · {t('scopeSelected', { count: edit.projectIds.length })}
                </span>
              )}
            </label>
            <div className="atext" style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
              {t('scopeHint')}
            </div>

            <div className="lfilter" style={{ marginBottom: 8 }}>
              <Icon name="search" size={14} style={{ color: 'var(--text-3)' }} />
              <input
                value={scopeSearch}
                onChange={(e) => setScopeSearch(e.target.value)}
                placeholder={t('scopeSearchPlaceholder')}
              />
              <span className="lf-count">{filteredProjects.length}</span>
            </div>

            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 2,
                border: '1px solid var(--border)', borderRadius: 8, padding: 6, minHeight: 200,
              }}
            >
              {scopePaged.length === 0 ? (
                <div className="atext" style={{ fontSize: 12, opacity: 0.6, padding: 8 }}>
                  {t('noProjectMatch')}
                </div>
              ) : (
                scopePaged.map((p) => (
                  <label
                    key={p.id}
                    className="row gap1"
                    style={{ cursor: 'pointer', fontSize: 13, padding: '4px 4px', borderRadius: 6 }}
                  >
                    <input
                      type="checkbox"
                      checked={edit.projectIds.includes(p.id)}
                      onChange={() => toggleProject(p.id)}
                    />
                    <span>{p.name}</span>
                  </label>
                ))
              )}
            </div>

            {scopePageCount > 1 && (
              <div className="row gap2" style={{ marginTop: 8, justifyContent: 'center', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  disabled={scopePage <= 1}
                  onClick={() => setScopePage((p) => Math.max(1, p - 1))}
                >
                  <Icon name="chevL" size={14} /> {t('prev')}
                </button>
                <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                  {t('pageOf', { page: scopePage, pageCount: scopePageCount })}
                </span>
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  disabled={scopePage >= scopePageCount}
                  onClick={() => setScopePage((p) => Math.min(scopePageCount, p + 1))}
                >
                  {t('next')} <Icon name="chevR" size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="md-foot">
          <button className="btn" onClick={onCancel} disabled={saving}>
            {t('common:cancel')}
          </button>
          <button className="btn primary" onClick={onSubmit} disabled={saving || !edit.name.trim()}>
            {t('common:save')}
          </button>
        </div>
      </div>
    </div>
  );
}
