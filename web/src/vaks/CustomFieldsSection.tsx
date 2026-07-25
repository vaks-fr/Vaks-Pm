/* ============================================================
   Admin > Custom fields
   Catalogue des champs personnalisés de l'organisation. Un champ est défini
   sur les tâches OU les projets, avec un type, et optionnellement restreint à
   certains projets. Édition gouvernée par `customFields.writeMode` (contrôlée
   côté serveur ; l'UI masque juste les affordances si `canWrite` est faux).

   UX calquée sur l'annuaire des utilisateurs : barre de recherche, onglets
   Tâches / Projets (segmented), liste compacte `dir-card`/`dir-row` paginée.
   La modale d'édition pagine et filtre la liste des projets (portée).
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import type {
  CustomFieldDefinitionDto,
  CustomFieldEntity,
  CustomFieldType,
  ProjectDto,
} from '@vaks-pm/shared';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'select', 'checkbox'];
const ENTITIES: CustomFieldEntity[] = ['task', 'project'];

/** Icône par type de champ (repère visuel dans la liste). */
const TYPE_ICON: Record<CustomFieldType, string> = {
  text: 'list',
  number: 'gauge',
  date: 'cal',
  select: 'chevDown',
  checkbox: 'check',
};

const PAGE_SIZE = 12; // champs par page dans la liste
const SCOPE_PAGE_SIZE = 8; // projets par page dans le sélecteur de portée

interface FormState {
  id: string | null; // null = création
  entityType: CustomFieldEntity;
  name: string;
  type: CustomFieldType;
  /** Options saisies une par ligne (type='select'). */
  optionsText: string;
  order: number;
  projectIds: string[];
}

const BLANK: FormState = {
  id: null,
  entityType: 'task',
  name: '',
  type: 'text',
  optionsText: '',
  order: 0,
  projectIds: [],
};

function parseOptions(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function CustomFieldsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('customfields');
  const confirm = useConfirm();
  const [fields, setFields] = useState<CustomFieldDefinitionDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  // Filtres liste : onglet entité + recherche + pagination (client).
  const [tab, setTab] = useState<CustomFieldEntity>('task');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, caps, projs] = await Promise.all([
        api.listCustomFields(),
        api.customFieldCapabilities().catch(() => ({ canWrite: false })),
        api.listProjects('all').catch(() => [] as ProjectDto[]),
      ]);
      setFields(list);
      setCanWrite(caps.canWrite);
      setProjects(projs);
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Changement d'onglet ou de recherche → retour page 1.
  useEffect(() => setPage(1), [tab, search]);

  const counts = useMemo(() => {
    const g: Record<CustomFieldEntity, number> = { task: 0, project: 0 };
    for (const f of fields) g[f.entityType] += 1;
    return g;
  }, [fields]);

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? id,
    [projects],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return fields
      .filter((f) => f.entityType === tab)
      .filter((f) => !q || f.name.toLowerCase().includes(q));
  }, [fields, tab, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const from = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, filtered.length);

  const openCreate = () => setEdit({ ...BLANK, entityType: tab });
  const openEdit = (f: CustomFieldDefinitionDto) =>
    setEdit({
      id: f.id,
      entityType: f.entityType,
      name: f.name,
      type: f.type,
      optionsText: f.options.join('\n'),
      order: f.order,
      projectIds: f.projectIds,
    });

  const submit = async () => {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) return flash(t('nameRequired'), 'err');
    if (edit.type === 'select' && parseOptions(edit.optionsText).length === 0) {
      return flash(t('optionsRequired'), 'err');
    }
    setSaving(true);
    try {
      if (edit.id) {
        // Type et entité immuables : on n'envoie que ce qui est modifiable.
        await api.updateCustomField(edit.id, {
          name,
          order: edit.order,
          projectIds: edit.projectIds,
          ...(edit.type === 'select' ? { options: parseOptions(edit.optionsText) } : {}),
        });
        flash(t('saved'), 'ok');
      } else {
        await api.createCustomField({
          entityType: edit.entityType,
          name,
          type: edit.type,
          order: edit.order,
          projectIds: edit.projectIds,
          ...(edit.type === 'select' ? { options: parseOptions(edit.optionsText) } : {}),
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

  const remove = async (f: CustomFieldDefinitionDto) => {
    if (
      !(await confirm({
        title: t('deleteTitle'),
        message: t('deleteMsg', { name: f.name }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteCustomField(f.id);
      flash(t('deleted'), 'ok');
      await refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  return (
    <div>
      {/* Barre de recherche + total + bouton créer */}
      <div className="lfilter">
        <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
        />
        <span className="lf-count">
          {from}–{to} / {filtered.length}
        </span>
        {canWrite && (
          <button
            className="btn btn-accent btn-sm"
            style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
            onClick={openCreate}
          >
            <Icon name="plus" size={14} /> {t('newField')}
          </button>
        )}
      </div>

      {/* Onglets Tâches / Projets */}
      <div className="row gap2" style={{ margin: '4px 0 12px' }}>
        <div className="seg">
          {ENTITIES.map((ent) => (
            <button
              key={ent}
              className={'seg-btn' + (tab === ent ? ' seg-on' : '')}
              onClick={() => setTab(ent)}
            >
              {t('entity.' + ent)} <span style={{ opacity: 0.6 }}>({counts[ent]})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dir-card">
        {loading && <div className="set-desc" style={{ padding: 16 }}>{t('common:loading')}</div>}
        {!loading && filtered.length === 0 && (
          <div className="set-desc" style={{ padding: 16 }}>
            {fields.filter((f) => f.entityType === tab).length === 0 ? t('emptyTab') : t('noMatch')}
          </div>
        )}
        {!loading &&
          paged.map((f) => (
            <CustomFieldRow
              key={f.id}
              field={f}
              canWrite={canWrite}
              projectName={projectName}
              onEdit={() => openEdit(f)}
              onRemove={() => remove(f)}
            />
          ))}
      </div>

      {/* Pagination client */}
      {pageCount > 1 && (
        <div className="row gap2" style={{ marginTop: 12, justifyContent: 'center', alignItems: 'center' }}>
          <button
            className="btn btn-line btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <Icon name="chevL" size={14} /> {t('prev')}
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{t('pageOf', { page, pageCount })}</span>
          <button
            className="btn btn-line btn-sm"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            {t('next')} <Icon name="chevR" size={14} />
          </button>
        </div>
      )}

      {edit && (
        <FieldEditorModal
          edit={edit}
          setEdit={setEdit}
          projects={projects}
          saving={saving}
          onCancel={() => setEdit(null)}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ligne compacte (icône type · nom · type · portée · actions)
// ---------------------------------------------------------------------------

function CustomFieldRow({
  field: f,
  canWrite,
  projectName,
  onEdit,
  onRemove,
}: {
  field: CustomFieldDefinitionDto;
  canWrite: boolean;
  projectName: (id: string) => string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('customfields');
  const scopeLabel =
    f.projectIds.length === 0
      ? t('scopeAll')
      : t('scopeNProjects', { count: f.projectIds.length });
  const scopeTitle = f.projectIds.length === 0 ? undefined : f.projectIds.map(projectName).join(', ');

  return (
    <div className="dir-row">
      <div
        aria-hidden
        style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          display: 'grid', placeItems: 'center',
          background: 'color-mix(in oklch, var(--accent) 14%, var(--surface))',
          color: 'var(--accent)',
        }}
      >
        <Icon name={TYPE_ICON[f.type]} size={15} />
      </div>
      <div className="dir-id">
        <div className="dir-name">{f.name}</div>
        <div className="dir-email" title={scopeTitle}>
          {scopeLabel}
        </div>
      </div>
      <div className="dir-title">
        {t('type.' + f.type)}
        {f.type === 'select' && f.options.length > 0 && (
          <span style={{ opacity: 0.6 }}> · {f.options.join(', ')}</span>
        )}
      </div>
      <div className="row gap2" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        <span className="pill pill-role">{scopeLabel}</span>
      </div>
      <div className="row gap2" style={{ flexShrink: 0 }}>
        {canWrite && (
          <>
            <button className="btn btn-line btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={onEdit}>
              <Icon name="pencil" size={14} /> {t('common:edit')}
            </button>
            <button className="icon-btn" onClick={onRemove} title={t('common:delete')}>
              <Icon name="x" size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modale d'édition — nom, entité/type (figés en édition), options, portée
// (sélecteur de projets recherchable + paginé).
// ---------------------------------------------------------------------------

function FieldEditorModal({
  edit,
  setEdit,
  projects,
  saving,
  onCancel,
  onSubmit,
}: {
  edit: FormState;
  setEdit: React.Dispatch<React.SetStateAction<FormState | null>>;
  projects: ProjectDto[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation('customfields');

  // Recherche + pagination du sélecteur de projets.
  const [scopeSearch, setScopeSearch] = useState('');
  const [scopePage, setScopePage] = useState(1);
  useEffect(() => setScopePage(1), [scopeSearch]);

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
      <div className="md-card" role="dialog" aria-label={edit.id ? t('editTitle') : t('newField')}>
        <div className="md-head">{edit.id ? t('editTitle') : t('newField')}</div>
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

          {/* Entité et type : figés en édition (changer invaliderait les valeurs). */}
          <div className="md-field">
            <label className="md-label">{t('col.entity')}</label>
            <select
              className="td-in grow"
              value={edit.entityType}
              disabled={!!edit.id}
              onChange={(e) => setEdit({ ...edit, entityType: e.target.value as CustomFieldEntity })}
            >
              {ENTITIES.map((en) => (
                <option key={en} value={en}>
                  {t('entity.' + en)}
                </option>
              ))}
            </select>
          </div>

          <div className="md-field">
            <label className="md-label">{t('col.type')}</label>
            <select
              className="td-in grow"
              value={edit.type}
              disabled={!!edit.id}
              onChange={(e) => setEdit({ ...edit, type: e.target.value as CustomFieldType })}
            >
              {FIELD_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t('type.' + ty)}
                </option>
              ))}
            </select>
            {edit.id && <div className="atext" style={{ fontSize: 11, opacity: 0.6 }}>{t('typeLocked')}</div>}
          </div>

          {edit.type === 'select' && (
            <div className="md-field">
              <label className="md-label">{t('optionsLabel')}</label>
              <textarea
                className="td-desc"
                rows={4}
                placeholder={t('optionsPlaceholder')}
                value={edit.optionsText}
                onChange={(e) => setEdit({ ...edit, optionsText: e.target.value })}
              />
            </div>
          )}

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

            {/* Recherche projets */}
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
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 6,
                minHeight: 200,
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

            {/* Pagination projets */}
            {scopePageCount > 1 && (
              <div
                className="row gap2"
                style={{ marginTop: 8, justifyContent: 'center', alignItems: 'center' }}
              >
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
