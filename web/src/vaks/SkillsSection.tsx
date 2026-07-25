/* ============================================================
   Admin > Skills catalog
   Référentiel global des skills de l'organisation. Édition réservée
   aux Org Admins (permission `member:manage`, contrôlée côté serveur).
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import type {
  PackScopeTeamDto,
  SkillDto,
  SkillPackSummaryDto,
  CreateSkillPackDto,
  TeamDto,
} from '@vaks-pm/shared';
import { useAuth } from '../auth/AuthContext';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

interface FormState {
  id: string | null;
  name: string;
  description: string;
  color: string;
  category: string;
}

/** Palette de présélection : 12 teintes harmonisées avec le reste de l'app
 *  (cohérentes avec les accents de la sidebar et les hues d'avatars). */
const COLOR_PRESETS = [
  '#6d5efc', // indigo
  '#2f7ef0', // blue
  '#0fae96', // teal
  '#16a34a', // green
  '#eab308', // amber
  '#e8590c', // orange
  '#dc2626', // red
  '#e64980', // pink
  '#a855f7', // purple
  '#0891b2', // cyan
  '#64748b', // slate
  '#374151', // graphite
];

const BLANK: FormState = {
  id: null,
  name: '',
  description: '',
  color: COLOR_PRESETS[0],
  category: '',
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Comparaison souple : minuscules, accents enlevés, espaces collapsés. */
function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export default function SkillsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('skills');
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const isAdmin = !!me?.isAdmin;
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<FormState | null>(null);
  const [query, setQuery] = useState('');
  const [packs, setPacks] = useState<SkillPackSummaryDto[]>([]);
  const [packsOpen, setPacksOpen] = useState(false);
  const [applyingPack, setApplyingPack] = useState<string | null>(null);
  const [scopeDialog, setScopeDialog] = useState<SkillPackSummaryDto | null>(null);
  /** Dialogue de création/édition d'un pack custom (null = fermé). */
  const [customPackOpen, setCustomPackOpen] = useState(false);
  /** Catégories repliées dans le tableau du catalogue (clé = nom de catégorie). */
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, pk] = await Promise.all([
        api.listSkills(),
        api.listSkillPacks().catch(() => [] as SkillPackSummaryDto[]),
      ]);
      setSkills(list);
      setPacks(pk);
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyPack = async (p: SkillPackSummaryDto, force = false) => {
    setApplyingPack(p.id);
    try {
      // « Installer » (aucun skill actif du pack) = fresh install : on force
      // pour réactiver d'éventuelles entrées soft-deleted laissées par un
      // cycle install → désinstall précédent. La sticky-delete ne s'applique
      // qu'au mode « Compléter » (partial install) — le seul cas où tu as
      // intentionnellement supprimé des skills d'un pack à moitié installé.
      const isFreshInstall = p.seeded === 0;
      const effectiveForce = force || isFreshInstall;
      const r = await api.applySkillPack(p.id, { force: effectiveForce });
      const parts: string[] = [];
      if (r.created) parts.push(t('skills:packs.part.created', { count: r.created }));
      if (r.updated) parts.push(t('skills:packs.part.updated', { count: r.updated }));
      if (r.restored) parts.push(t('skills:packs.part.restored', { count: r.restored }));
      if (r.skippedDisabled)
        parts.push(t('skills:packs.part.skippedDisabled', { count: r.skippedDisabled }));
      const bindNote = r.autoBoundToTeams
        ? t('skills:packs.bindNote', { count: r.autoBoundToTeams })
        : '';
      flash(
        t('skills:packs.applied', {
          label: r.label,
          parts: parts.join(', ') || t('skills:packs.noChange'),
          bindNote,
        }),
        'ok',
      );
      await refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setApplyingPack(null);
    }
  };

  const removePack = async (p: SkillPackSummaryDto) => {
    if (
      !(await confirm({
        title: t('common:confirm'),
        message: t('skills:packs.confirmRemove', { label: p.label, seeded: p.seeded }),
        danger: true,
      }))
    )
      return;
    setApplyingPack(p.id);
    try {
      const r = await api.removeSkillPack(p.id);
      flash(t('skills:packs.removed', { label: r.label, count: r.removed }), 'ok');
      await refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setApplyingPack(null);
    }
  };

  /** Supprime seulement la *définition* d'un pack custom (le catalogue installé
   *  n'est pas touché — cf. CLAUDE.md). */
  const deleteCustomPackDef = async (p: SkillPackSummaryDto) => {
    if (!(await confirm({ title: t('common:delete'), message: t('skills:packs.confirmDeleteDefinition', { label: p.label }), confirmLabel: t('common:delete'), danger: true })))
      return;
    try {
      await api.deleteCustomSkillPackDefinition(p.id);
      flash(t('skills:packs.definitionDeleted', { label: p.label }), 'ok');
      await refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const saveCustomPack = async (dto: CreateSkillPackDto) => {
    await api.upsertCustomSkillPack(dto);
    flash(
      t('skills:packs.customSaved', { label: dto.label, count: dto.skills.length }),
      'ok',
    );
    setCustomPackOpen(false);
    await refresh();
  };

  /** Skills déjà existants qui pourraient être des doublons du nom en cours
   *  de saisie : match exact insensible à la casse OU match large (substring
   *  ou substring inverse, longueur normalisée >= 3 caractères). */
  const duplicateHints = useMemo(() => {
    if (!edit) return { exact: null as SkillDto | null, near: [] as SkillDto[] };
    const norm = normalizeName(edit.name);
    if (norm.length < 2) return { exact: null, near: [] };
    let exact: SkillDto | null = null;
    const near: SkillDto[] = [];
    for (const s of skills) {
      if (edit.id && s.id === edit.id) continue;
      const sn = normalizeName(s.name);
      if (sn === norm) {
        exact = s;
        continue;
      }
      if (norm.length >= 3 && (sn.includes(norm) || norm.includes(sn))) {
        near.push(s);
      }
    }
    return { exact, near: near.slice(0, 5) };
  }, [edit, skills]);

  const submit = async () => {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) return flash(t('skills:form.nameRequired'), 'err');
    if (duplicateHints.exact) {
      return flash(
        t('skills:form.nameTakenError', { name: duplicateHints.exact.name }),
        'err',
      );
    }
    const color = edit.color && HEX_RE.test(edit.color) ? edit.color : undefined;
    const payload = {
      name,
      description: edit.description.trim() || undefined,
      color,
      category: edit.category.trim(),
    };
    try {
      if (edit.id) {
        await api.updateSkill(edit.id, payload);
        flash(t('skills:form.updated'), 'ok');
      } else {
        await api.createSkill(payload);
        flash(t('skills:form.created'), 'ok');
      }
      setEdit(null);
      refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const remove = async (s: SkillDto) => {
    if (!(await confirm({ title: t('common:delete'), message: t('skills:form.confirmDelete', { name: s.name }), confirmLabel: t('common:delete'), danger: true })))
      return;
    try {
      await api.deleteSkill(s.id);
      flash(t('skills:form.deleted'), 'ok');
      refresh();
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        (s.category ?? '').toLowerCase().includes(q),
    );
  }, [skills, query]);

  const categories = useMemo(
    () =>
      Array.from(
        new Set(skills.map((s) => s.category?.trim()).filter(Boolean) as string[]),
      ).sort((a, b) => a.localeCompare(b)),
    [skills],
  );

  // Catalogue regroupé par catégorie (= pack) pour un affichage en « dossiers ».
  const grouped = useMemo(() => {
    const UNCAT = t('uncategorized');
    const map = new Map<string, SkillDto[]>();
    for (const s of filtered) {
      const key = s.category?.trim() || UNCAT;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries())
      .sort((a, b) =>
        a[0] === UNCAT ? 1 : b[0] === UNCAT ? -1 : a[0].localeCompare(b[0]),
      )
      .map(([cat, items]) => ({
        cat,
        color: items.find((x) => x.color)?.color ?? '#6d5efc',
        items: items.sort((x, y) => x.name.localeCompare(y.name)),
      }));
  }, [filtered, t]);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="asection-card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <input
              className="atext"
              placeholder={t('skills:catalog.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <button
            className="btn primary"
            onClick={() => setEdit({ ...BLANK })}
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
          >
            <Icon name="plus" size={15} /> {t('skills:catalog.newSkill')}
          </button>
        </div>
      </div>

      {/* ----- Bibliothèque de packs ----- */}
      {packs.length > 0 && (
        <div className="asection-card" style={{ padding: 14 }}>
          <button
            type="button"
            onClick={() => setPacksOpen((v) => !v)}
            aria-expanded={packsOpen}
            title={packsOpen ? t('skills:packs.collapseTitle') : t('skills:packs.expandTitle')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              background: packsOpen ? 'var(--surface-2)' : 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 10,
              cursor: 'pointer',
              padding: '8px 12px',
              font: 'inherit',
              color: 'var(--text)',
              transition: 'background 120ms ease',
            }}
          >
            <Icon
              name="chevDown"
              size={16}
              style={{
                color: 'var(--text-3)',
                transform: packsOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 120ms ease',
              }}
            />
            <strong style={{ flex: 1, textAlign: 'left' }}>
              {t('skills:packs.heading')}{' '}
              <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>
                {t('skills:packs.headingNote')}
              </span>
            </strong>
            <span className="md-count">{packs.length}</span>
            <span
              aria-hidden
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--accent)',
                marginLeft: 4,
              }}
            >
              {packsOpen ? t('skills:packs.collapse') : t('skills:packs.show')}
            </span>
          </button>

          {packsOpen && (
            <div
              style={{
                marginTop: 12,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 10,
              }}
            >
              {packs.map((p) => {
                const full = p.seeded >= p.total;
                return (
                  <div
                    key={p.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: 12,
                      display: 'grid',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 3,
                          background: p.color ?? '#6d5efc',
                          flexShrink: 0,
                        }}
                      />
                      <strong style={{ flex: 1, minWidth: 0 }}>{p.label}</strong>
                      {p.source === 'CUSTOM' && (
                        <span
                          title={t('skills:packs.customBadgeTitle')}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#fff',
                            background: '#7e57c2',
                            padding: '1px 6px',
                            borderRadius: 999,
                            letterSpacing: 0.3,
                          }}
                        >
                          {t('skills:packs.customBadge')}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {t('skills:packs.skillCount', { count: p.total })}
                      {p.seeded > 0 && (
                        <>
                          {' · '}
                          <span style={{ color: full ? '#16a34a' : '#b45309' }}>
                            {t('skills:packs.inCatalog', { seeded: p.seeded, total: p.total })}
                          </span>
                        </>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-3)',
                        flexWrap: 'wrap',
                      }}
                    >
                      {p.teamScope.length === 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Icon name="users" size={11} /> {t('skills:packs.visibleAllTeams')}
                        </span>
                      ) : (
                        <span
                          title={t('skills:packs.restrictedTitle')}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            color: 'var(--accent)',
                            fontWeight: 600,
                          }}
                        >
                          <Icon name="users" size={11} /> {t('skills:packs.teamCount', { count: p.teamScope.length })}
                        </span>
                      )}
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => setScopeDialog(p)}
                          title={t('skills:packs.editScopeTitle')}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 11,
                            textDecoration: 'underline',
                          }}
                        >
                          {t('skills:packs.editScope')}
                        </button>
                      )}
                      {isAdmin && p.source === 'CUSTOM' && (
                        <button
                          type="button"
                          onClick={() => deleteCustomPackDef(p)}
                          title={t('skills:packs.deleteDefinitionTitle')}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#dc2626',
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 11,
                            textDecoration: 'underline',
                          }}
                        >
                          {t('skills:packs.deleteDefinition')}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className={p.seeded === 0 ? 'btn primary' : 'btn'}
                        onClick={() => applyPack(p)}
                        disabled={applyingPack === p.id}
                        style={{
                          flex: 1,
                          minWidth: 100,
                          display: 'inline-flex',
                          gap: 6,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {applyingPack === p.id ? (
                          '…'
                        ) : full ? (
                          <>
                            <Icon name="check" size={14} /> {t('skills:packs.upToDate')}
                          </>
                        ) : p.seeded > 0 ? (
                          <>
                            <Icon name="plus" size={14} /> {t('skills:packs.complete')}
                          </>
                        ) : (
                          <>
                            <Icon name="plus" size={14} /> {t('skills:packs.install')}
                          </>
                        )}
                      </button>
                      {p.seeded > 0 && (
                        <>
                          <button
                            className="btn"
                            onClick={() => applyPack(p, true)}
                            disabled={applyingPack === p.id}
                            title={t('skills:packs.resyncTitle')}
                            style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
                          >
                            <Icon name="check" size={14} /> {t('skills:packs.resync')}
                          </button>
                          <button
                            className="btn"
                            onClick={() => removePack(p)}
                            disabled={applyingPack === p.id}
                            title={t('skills:packs.removeTitle')}
                            style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: '#dc2626' }}
                          >
                            <Icon name="x" size={14} /> {t('skills:packs.remove')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {packsOpen && isAdmin && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => setCustomPackOpen(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Icon name="plus" size={14} /> {t('skills:packs.createCustom')}
              </button>
            </div>
          )}
          {packsOpen && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPacksOpen(false);
                  // Remonte en haut du panneau pour ne pas laisser l'user perdu après pliage.
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Icon
                  name="chevDown"
                  size={14}
                  style={{ transform: 'rotate(180deg)' }}
                />
                {t('skills:packs.collapsePacks')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="asection-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 18, opacity: 0.6 }}>{t('skills:catalog.loading')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 18, opacity: 0.6 }}>
            {skills.length === 0
              ? t('skills:catalog.emptyNoSkills')
              : t('skills:catalog.emptyNoMatch')}
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 12,
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface-2)',
                fontSize: 12,
                color: 'var(--text-3)',
              }}
            >
              <span>
                {t('skills:catalog.categoryCount', { count: grouped.length })} · {t('skills:catalog.skillCount', { count: filtered.length })}
              </span>
              <button
                type="button"
                onClick={() => setCollapsedCats(new Set(grouped.map((g) => g.cat)))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 0, fontSize: 12, fontWeight: 600 }}
                disabled={grouped.every((g) => collapsedCats.has(g.cat))}
              >
                {t('skills:catalog.collapseAll')}
              </button>
              <span style={{ opacity: 0.5 }}>·</span>
              <button
                type="button"
                onClick={() => setCollapsedCats(new Set())}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', padding: 0, fontSize: 12, fontWeight: 600 }}
                disabled={collapsedCats.size === 0}
              >
                {t('skills:catalog.expandAll')}
              </button>
            </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)' }}>
                <th style={th}>{t('skills:catalog.colNom')}</th>
                <th style={th}>{t('skills:catalog.colDescription')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{t('skills:catalog.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => {
                const isCollapsed = collapsedCats.has(g.cat);
                return (
                <React.Fragment key={g.cat}>
                  <tr>
                    <td
                      colSpan={3}
                      style={{
                        padding: 0,
                        background: 'var(--surface-2)',
                        borderTop: '1px solid var(--border)',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedCats((cur) => {
                            const next = new Set(cur);
                            next.has(g.cat) ? next.delete(g.cat) : next.add(g.cat);
                            return next;
                          })
                        }
                        aria-expanded={!isCollapsed}
                        title={isCollapsed ? t('skills:catalog.expandCategory') : t('skills:catalog.collapseCategory')}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 14px',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          fontSize: 12,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          color: 'var(--text-3)',
                          fontFamily: 'inherit',
                        }}
                      >
                        <Icon
                          name="chevDown"
                          size={14}
                          style={{
                            color: 'var(--text-3)',
                            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                            transition: 'transform 120ms ease',
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 2,
                            background: g.color,
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                        />
                        <span>{g.cat}</span>
                        <span style={{ opacity: 0.7 }}>· {g.items.length}</span>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed && g.items.map((s) => (
                    <tr key={s.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={td}>
                        <span
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                        >
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 3,
                              background: s.color ?? '#6d5efc',
                              display: 'inline-block',
                            }}
                          />
                          <strong>{s.name}</strong>
                        </span>
                      </td>
                      <td style={{ ...td, color: 'var(--text-3)' }}>
                        {s.description ?? '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="btn"
                          onClick={() =>
                            setEdit({
                              id: s.id,
                              name: s.name,
                              description: s.description ?? '',
                              color: s.color ?? '#6d5efc',
                              category: s.category ?? '',
                            })
                          }
                        >
                          {t('common:edit')}
                        </button>
                        <button
                          className="btn"
                          style={{ marginLeft: 6 }}
                          onClick={() => remove(s)}
                        >
                          {t('common:delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
          </>
        )}
      </div>

      {edit && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,16,28,0.5)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEdit(null);
          }}
        >
          <div
            className="asection-card"
            style={{ padding: 18, width: 'min(560px, 92vw)', display: 'grid', gap: 12 }}
          >
            <h3 style={{ margin: 0 }}>{edit.id ? t('skills:form.editTitle') : t('skills:form.newTitle')}</h3>
            <label style={lbl}>
              {t('skills:form.nameLabel')}
              <input
                autoFocus
                className="atext"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder={t('skills:form.namePlaceholder')}
                aria-invalid={duplicateHints.exact ? true : undefined}
                style={
                  duplicateHints.exact
                    ? { borderColor: '#dc2626', boxShadow: '0 0 0 1px #dc2626' }
                    : undefined
                }
              />
              {duplicateHints.exact ? (
                <span
                  style={{
                    fontSize: 12,
                    color: '#dc2626',
                    fontWeight: 500,
                  }}
                >
                  {t('skills:form.duplicate', { name: duplicateHints.exact.name })}
                </span>
              ) : duplicateHints.near.length > 0 ? (
                <span style={{ fontSize: 12, color: '#b45309' }}>
                  {t('skills:form.similarPrefix')}{' '}
                  {duplicateHints.near.map((s, i) => (
                    <React.Fragment key={s.id}>
                      {i > 0 && ', '}
                      <strong>{s.name}</strong>
                    </React.Fragment>
                  ))}{' '}
                  {t('skills:form.similarSuffix')}
                </span>
              ) : null}
            </label>
            <label style={lbl}>
              {t('skills:form.categoryLabel')}
              <input
                className="atext"
                list="skill-category-list"
                value={edit.category}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                placeholder={t('skills:form.categoryPlaceholder')}
              />
              <datalist id="skill-category-list">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label style={lbl}>
              {t('skills:form.descriptionLabel')}
              <textarea
                className="atext"
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                rows={3}
                placeholder={t('skills:form.descriptionPlaceholder')}
              />
            </label>
            <div style={lbl}>
              <span>{t('skills:form.colorLabel')}</span>
              <div
                role="radiogroup"
                aria-label={t('skills:form.colorAria')}
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
              >
                {COLOR_PRESETS.map((c) => {
                  const on = edit.color.toLowerCase() === c.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setEdit({ ...edit, color: c })}
                      title={c}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: c,
                        border: on ? '2px solid #111' : '2px solid transparent',
                        boxShadow: on
                          ? '0 0 0 2px #fff inset, 0 1px 2px rgba(0,0,0,0.15)'
                          : '0 1px 2px rgba(0,0,0,0.10)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEdit(null)}>
                {t('common:cancel')}
              </button>
              <button
                className="btn primary"
                onClick={submit}
                disabled={!edit.name.trim() || !!duplicateHints.exact}
              >
                {edit.id ? t('common:save') : t('common:create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {scopeDialog && (
        <PackScopeDialog
          pack={scopeDialog}
          onClose={() => setScopeDialog(null)}
          onSaved={() => {
            setScopeDialog(null);
            refresh();
          }}
          flash={flash}
        />
      )}
      {customPackOpen && (
        <CustomPackDialog
          existingIds={packs.map((p) => p.id)}
          onClose={() => setCustomPackOpen(false)}
          onSave={saveCustomPack}
          flash={flash}
        />
      )}
    </div>
  );
}

/* ===================== Custom pack create/edit dialog ===================== */

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function CustomPackDialog({
  existingIds,
  onClose,
  onSave,
  flash,
}: {
  existingIds: string[];
  onClose: () => void;
  onSave: (dto: CreateSkillPackDto) => Promise<void>;
  flash: Flash;
}) {
  const { t } = useTranslation('skills');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#6d5efc');
  // Une compétence par ligne : `Nom` ou `Nom | description`.
  const [skillsText, setSkillsText] = useState('');
  const [busy, setBusy] = useState(false);

  const skills = skillsText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.split('|');
      return {
        name: name.trim(),
        description: rest.join('|').trim() || undefined,
      };
    })
    .filter((s) => s.name);

  const idTaken = existingIds.includes(id.trim().toLowerCase());
  const idValid = PACK_ID_RE.test(id.trim().toLowerCase());

  const submit = async () => {
    const cleanId = id.trim().toLowerCase();
    if (!idValid) return flash(t('skills:customPack.idInvalid'), 'err');
    if (!label.trim()) return flash(t('skills:customPack.labelRequired'), 'err');
    if (skills.length === 0) return flash(t('skills:customPack.atLeastOneSkill'), 'err');
    setBusy(true);
    try {
      await onSave({
        id: cleanId,
        label: label.trim(),
        color: color || null,
        skills,
      });
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(620px, 94vw)' }}
      >
        <div className="md-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('skills:customPack.eyebrow')}</div>
            <div className="md-title">{t('skills:customPack.title')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <div className="md-field">
            <div className="md-label">{t('skills:customPack.idLabel')}</div>
            <input
              className="atext mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t('skills:customPack.idPlaceholder')}
              style={{ width: '100%' }}
            />
            <div className="md-span">
              {t('skills:customPack.idHelp')}
              {id && idTaken && (
                <span style={{ color: '#b45309' }}>
                  {t('skills:customPack.idTaken')}
                </span>
              )}
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('skills:customPack.labelLabel')}</div>
            <input
              className="atext"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('skills:customPack.labelPlaceholder')}
              style={{ width: '100%' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('skills:customPack.colorLabel')}</div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 56, height: 30, padding: 0, border: 'none', background: 'none' }}
            />
          </div>
          <div className="md-field">
            <div className="md-label">
              {t('skills:customPack.skillsLabel')} <span style={{ color: 'var(--text-3)' }}>({skills.length})</span>
            </div>
            <textarea
              className="atext mono"
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
              placeholder={t('skills:customPack.skillsPlaceholder')}
              spellCheck={false}
              style={{ width: '100%', minHeight: 150, resize: 'vertical' }}
            />
          </div>
        </div>
        <div className="md-foot">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('common:cancel')}
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || !idValid || !label.trim() || skills.length === 0}
          >
            {busy ? t('common:saving') : t('skills:customPack.savePack')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Pack scope dialog ----------------------------- */

function PackScopeDialog({
  pack,
  onClose,
  onSaved,
  flash,
}: {
  pack: SkillPackSummaryDto;
  onClose: () => void;
  onSaved: () => void;
  flash: Flash;
}) {
  const { t } = useTranslation('skills');
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listTeams(),
      api.getSkillPackScope(pack.id).catch(() => [] as PackScopeTeamDto[]),
    ])
      .then(([allTeams, scope]) => {
        if (cancelled) return;
        setTeams(allTeams);
        setSelected(scope.map((tm) => tm.id));
      })
      .catch((e) => flash((e as Error).message, 'err'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pack.id, flash]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const save = async () => {
    setSaving(true);
    try {
      await api.setSkillPackScope(pack.id, selected);
      flash(
        selected.length
          ? t('skills:scope.restricted', { label: pack.label, count: selected.length })
          : t('skills:scope.allTeamsAgain', { label: pack.label }),
        'ok',
      );
      onSaved();
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,16,28,0.5)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="asection-card"
        style={{ padding: 18, width: 'min(520px, 92vw)', display: 'grid', gap: 12 }}
      >
        <div>
          <h3 style={{ margin: 0 }}>{t('skills:scope.title')}</h3>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>
            <Trans
              i18nKey="skills:scope.intro"
              values={{ label: pack.label }}
              components={[<strong />]}
            />
          </div>
        </div>
        {loading ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('skills:scope.loading')}</div>
        ) : (
          <div
            style={{
              maxHeight: 320,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 6,
            }}
          >
            {teams.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13 }}>
                {t('skills:scope.noTeams')}
              </div>
            ) : (
              teams.map((tm) => {
                const on = selected.includes(tm.id);
                return (
                  <button
                    key={tm.id}
                    type="button"
                    onClick={() => toggle(tm.id)}
                    aria-pressed={on}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      border: 'none',
                      background: on ? 'var(--accent-soft)' : 'transparent',
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: 'var(--text)',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: on ? '5px solid var(--accent)' : '2px solid var(--border-2)',
                        background: on ? 'var(--accent)' : 'var(--surface)',
                        flex: '0 0 auto',
                      }}
                    />
                    {tm.color && (
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 2,
                          background: tm.color,
                          flex: '0 0 auto',
                        }}
                      />
                    )}
                    <span style={{ flex: 1, fontWeight: on ? 600 : 400 }}>{tm.name}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {selected.length === 0
              ? t('skills:scope.orgWide')
              : t('skills:scope.selectedCount', { count: selected.length })}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving ? t('common:saving') : t('common:save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 12,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--text-3)',
};
const td: React.CSSProperties = { padding: '10px 14px', fontSize: 14 };
const lbl: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 13,
  fontWeight: 500,
};
