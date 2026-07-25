/* ============================================================
   Vaks — Team view (sidebar > Workspace > Team).
   Calque la liste utilisateurs du Admin Panel mais restreinte aux
   membres des équipes auxquelles l'utilisateur courant appartient.
   - Membres simples : lecture seule (avatar, email, schedule résumé).
   - Team leads (isLead) : peuvent éditer le schedule des membres
     et modifier les infos de leur équipe (nom, description, couleur).
   ============================================================ */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Icon, Avatar } from './primitives';
import { api } from '../api/client';
import { useAuth, labelForLevel } from '../auth/AuthContext';
import SkillPicker from './SkillPicker';
import type {
  SkillDto,
  TeamDto,
  TeamWithMembersDto,
  TeamMemberDto,
  UserDto,
  UserSkillDto,
  WorkScheduleDto,
} from '@vaks-pm/shared';
import {
  DAY_KEYS,
  DAY_SHORT,
  UserScheduleModal,
  hueFromId,
  summarizeSchedule,
} from './AdminPanel';
import './admin.css';

const TEAM_COLORS = [
  '#6d5efc', '#2f7ef0', '#0fae96', '#e8590c', '#e64980',
  '#7e57c2', '#26a69a', '#ef5350', '#ab47bc', '#42a5f5',
];

function FlashBar({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        padding: '10px 16px',
        borderRadius: 8,
        fontSize: 13,
        boxShadow: '0 10px 30px oklch(0 0 0 / 0.35)',
        zIndex: 80,
      }}
    >
      {msg}
    </div>
  );
}

/* ----------------------- Team info editor (lead only) ---------------------- */

function TeamInfoEditor({
  team,
  onSaved,
  flash,
}: {
  team: TeamWithMembersDto;
  onSaved: (t: TeamDto) => void;
  flash: (m: string) => void;
}) {
  const [name, setName] = useState(team.name);
  const [displayName, setDisplayName] = useState(team.displayName ?? '');
  const [description, setDescription] = useState(team.description ?? '');
  const [color, setColor] = useState(team.color ?? TEAM_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation('teams');
  const scimManaged = team.source !== 'LOCAL';

  // Reset form when team identity changes (switching teams).
  useEffect(() => {
    setName(team.name);
    setDisplayName(team.displayName ?? '');
    setDescription(team.description ?? '');
    setColor(team.color ?? TEAM_COLORS[0]);
  }, [team.id]);

  const dirty =
    (!scimManaged && name.trim() !== team.name) ||
    (displayName.trim() || null) !== (team.displayName ?? null) ||
    (!scimManaged && (description.trim() || null) !== (team.description ?? null)) ||
    color !== (team.color ?? TEAM_COLORS[0]);

  async function save() {
    if (!scimManaged && !name.trim()) {
      flash(t('info.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      // Équipe SCIM : on n'envoie QUE l'override d'affichage + la couleur
      // (le nom canonique et la composition viennent de l'IdP).
      const payload = scimManaged
        ? { displayName: displayName.trim() || null, color }
        : {
            name: name.trim(),
            displayName: displayName.trim() || null,
            description: description.trim() || null,
            color,
          };
      const updated = await api.updateTeam(team.id, payload);
      onSaved(updated);
      flash(t('info.updated'));
    } catch (e) {
      flash(t('info.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  // Équipe synchronisée (SCIM/OIDC) : nom canonique + membres gérés par l'IdP,
  // mais on autorise un **nom d'affichage local** (override) + la couleur.
  if (scimManaged) {
    return (
      <div
        style={{
          padding: 16, border: '1px solid var(--border)', borderRadius: 10,
          background: 'var(--surface-2)', marginBottom: 16, display: 'grid', gap: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13 }}>{t('info.settings')}</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
          <Trans
            t={t}
            i18nKey="info.synced"
            values={{ source: team.source, name: team.name }}
            components={[<strong />, <code />, <strong />]}
          />
        </div>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('info.displayNameOverride')}</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={team.name}
            className="atxt"
            style={{
              padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--surface)', color: 'var(--text)', fontSize: 13,
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {t('info.displayNameHint')}
          </span>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('info.color')}</span>
          <div className="acolor" style={{ flexWrap: 'wrap' }}>
            {TEAM_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={'acolor-sw' + (color === c ? ' on' : '')}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
                title={c}
              />
            ))}
          </div>
        </label>
        <div>
          <button className="btn btn-accent btn-sm" disabled={!dirty || saving} onClick={save}>
            {saving ? t('common:saving') : t('common:save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 16,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface-2)',
        marginBottom: 16,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.2 }}>
        {t('info.settings')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('info.name')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="atxt"
            style={{
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: 13,
            }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('info.color')}</span>
          <div className="acolor" style={{ flexWrap: 'wrap' }}>
            {TEAM_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={'acolor-sw' + (color === c ? ' on' : '')}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
                title={c}
              />
            ))}
          </div>
        </label>
      </div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('info.description')}</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          style={{
            padding: '8px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--surface)',
            color: 'var(--text)',
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
      </label>
      <div className="row gap2" style={{ justifyContent: 'flex-end' }}>
        <button
          className="btn btn-accent"
          onClick={save}
          disabled={!dirty || saving}
        >
          {saving ? t('common:saving') : t('info.saveTeam')}
        </button>
      </div>
    </div>
  );
}

/* ------------------- Team skills (competency domain) ----------------------- */

function TeamSkillsEditor({
  team,
  flash,
}: {
  team: TeamWithMembersDto;
  flash: (m: string) => void;
}) {
  const [catalog, setCatalog] = useState<SkillDto[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [initial, setInitial] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCat, setNewCat] = useState('');
  const [creating, setCreating] = useState(false);
  const { t } = useTranslation('teams');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.listSkills(), api.listTeamSkills(team.id)])
      .then(([cat, ts]) => {
        if (cancelled) return;
        setCatalog(cat);
        const ids = ts.map((tk) => tk.skillId);
        setSelected(ids);
        setInitial(ids);
      })
      .catch((e) => flash(t('skills.loadError', { message: (e as Error).message })))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `flash` exclu volontairement (fonction inline du parent — provoque un
    // re-fire continu qui peut annuler le chargement avant qu'il aboutisse).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);

  const dirty = useMemo(() => {
    if (selected.length !== initial.length) return true;
    const a = new Set(initial);
    return selected.some((id) => !a.has(id));
  }, [selected, initial]);

  const categories = useMemo(
    () =>
      Array.from(
        new Set(catalog.map((s) => s.category?.trim()).filter(Boolean) as string[]),
      ).sort((a, b) => a.localeCompare(b)),
    [catalog],
  );

  async function save() {
    setSaving(true);
    try {
      const ts = await api.setTeamSkills(team.id, selected);
      const ids = ts.map((tk) => tk.skillId);
      setSelected(ids);
      setInitial(ids);
      flash(t('skills.saved'));
    } catch (e) {
      flash(t('skills.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function createSkill() {
    const name = newName.trim();
    if (!name) return;
    const norm = name.toLowerCase().replace(/\s+/g, ' ');
    if (catalog.find((s) => s.name.toLowerCase().replace(/\s+/g, ' ') === norm)) {
      flash(t('skills.alreadyExists', { name }));
      return;
    }
    setCreating(true);
    try {
      const created = await api.createSkill({
        name,
        category: newCat.trim() || undefined,
      });
      setCatalog((arr) =>
        [...arr, created].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setSelected((s) => [...s, created.id]);
      setNewName('');
      flash(t('skills.skillCreated', { name: created.name }));
    } catch (e) {
      flash(t('skills.createFailed', { message: (e as Error).message }));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      style={{
        padding: 16,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface-2)',
        marginBottom: 16,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.2 }}>
        {t('skills.title')}{' '}
        <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>
          {t('skills.subtitle')}
        </span>
      </div>
      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          <SkillPicker
            skills={catalog}
            selected={selected}
            onChange={setSelected}
            multiple
            placeholder={t('skills.searchPlaceholder')}
            emptyHint={t('skills.emptyHint')}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="atext"
              placeholder={t('skills.newSkillPlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createSkill();
              }}
              disabled={creating}
              style={{ flex: '2 1 160px' }}
            />
            <input
              className="atext"
              list="team-skill-category-list"
              placeholder={t('skills.categoryPlaceholder')}
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
              disabled={creating}
              style={{ flex: '1 1 120px' }}
            />
            <datalist id="team-skill-category-list">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <button
              className="btn btn-line btn-sm"
              onClick={createSkill}
              disabled={creating || !newName.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              <Icon name="plus" size={14} /> {t('common:create')}
            </button>
          </div>
          <div className="row gap2" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 'auto' }}>
              {t('skills.selectedCount', { count: selected.length })}
            </span>
            <button className="btn btn-accent" onClick={save} disabled={!dirty || saving}>
              {saving ? t('common:saving') : t('skills.saveCompetencies')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}


/* ----------------------------- Member list ---------------------------------- */

function MemberList({
  team,
  canEdit,
  flash,
  onMembersChanged,
}: {
  team: TeamWithMembersDto;
  canEdit: boolean;
  flash: (m: string) => void;
  onMembersChanged: (members: TeamMemberDto[]) => void;
}) {
  const { user: meAuth } = useAuth();
  const { t } = useTranslation('teams');
  const [f, setF] = useState('');
  const ff = f.trim().toLowerCase();
  const [scheduleByUser, setScheduleByUser] = useState<Record<string, WorkScheduleDto>>({});
  const [editing, setEditing] = useState<TeamMemberDto['user'] | null>(null);
  const [editingSkills, setEditingSkills] = useState<TeamMemberDto['user'] | null>(null);
  const [editingRates, setEditingRates] = useState<TeamMemberDto['user'] | null>(null);
  const [adding, setAdding] = useState(false);

  const members = team.members;
  const rows = members.filter(
    (m) => !ff || (m.user.name + ' ' + m.user.email).toLowerCase().includes(ff),
  );

  useEffect(() => {
    if (members.length === 0) return;
    let cancelled = false;
    Promise.all(
      members.map((m) =>
        api.getWorkSchedule(m.user.id).then((s) => [m.user.id, s] as const).catch(() => null),
      ),
    ).then((all) => {
      if (cancelled) return;
      const map: Record<string, WorkScheduleDto> = {};
      for (const r of all) if (r) map[r[0]] = r[1];
      setScheduleByUser(map);
    });
    return () => {
      cancelled = true;
    };
  }, [members]);

  return (
    <div>
      {team.source === 'SCIM' && (
        <div
          style={{
            fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: '8px 12px', marginBottom: 10,
          }}
        >
          <Trans t={t} i18nKey="members.scimNotice" components={[<strong />]} />
        </div>
      )}
      <div className="lfilter">
        <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
        <input
          value={f}
          onChange={(e) => setF(e.target.value)}
          placeholder={t('members.filterPlaceholder')}
        />
        <span className="lf-count">
          {rows.length}/{members.length}
        </span>
        {canEdit && team.source !== 'SCIM' && (
          <button
            className="btn btn-accent btn-sm"
            style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" size={14} /> {t('members.addToTeam')}
          </button>
        )}
      </div>
      <div className="dir-card">
        {rows.length === 0 && (
          <div className="set-desc" style={{ padding: '16px' }}>
            {t('members.noMatch', { filter: f })}
          </div>
        )}
        {rows.map((m) => {
          const u = m.user;
          const initials = u.name
            .split(' ')
            .map((w) => w[0])
            .join('')
            .slice(0, 2)
            .toUpperCase();
          const sched = scheduleByUser[u.id];
          const sum = sched ? summarizeSchedule(sched) : null;
          return (
            <div className="dir-row tm-member-row" key={u.id}>
              <Avatar
                user={{
                  id: u.id,
                  name: u.name,
                  short: u.name.split(' ')[0],
                  initials,
                  role: '',
                  hue: hueFromId(u.id),
                  online: false,
                }}
                size={32}
                title={false}
              />
              <div className="dir-id">
                <div
                  className="dir-name"
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span>{u.name}</span>
                  {m.isLead && (
                    <span
                      className="pill pill-role"
                      title={t('members.leadTitle')}
                      style={{ fontSize: 10, padding: '1px 6px' }}
                    >
                      {t('members.lead')}
                    </span>
                  )}
                </div>
                <div className="dir-email">{u.email}</div>
              </div>
              <div className="dir-title">
                {sum ? (
                  <span>
                    {sum.isDefault ? (
                      <span style={{ color: 'var(--text-faint)' }}>{t('members.scheduleDefault')}</span>
                    ) : (
                      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{t('members.scheduleCustom')}</span>
                    )}
                    {sum.daysOn.map((k) => DAY_SHORT[k]).join(' · ') || t('members.noWorkingDay')}
                    {' · '}
                    <span className="mono">{t('members.hoursPerWeek', { hours: sum.hoursPerWeek })}</span>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-faint)' }}>{t('members.loadingSchedule')}</span>
                )}
              </div>
              <div className="row gap2" style={{ flexShrink: 0 }}>
                <button
                  className="btn btn-line btn-sm"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => setEditing(u)}
                  title={canEdit ? t('members.editSchedule') : t('members.viewSchedule')}
                >
                  <Icon name="cal" size={14} /> {canEdit ? t('members.schedule') : t('members.view')}
                </button>
                <button
                  className="btn btn-line btn-sm"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => setEditingSkills(u)}
                  title={canEdit ? t('members.editSkills') : t('members.viewSkills')}
                >
                  <Icon name="zap" size={14} /> {t('members.skills')}
                </button>
                {canEdit && (
                  <button
                    className="btn btn-line btn-sm"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => setEditingRates(u)}
                    title={t('members.ratesTitle')}
                  >
                    <span style={{ fontWeight: 700 }}>€</span>{' '}
                    {u.defaultCostRate != null ? (
                      <span className="mono">{t('members.perHour', { rate: u.defaultCostRate })}</span>
                    ) : (
                      t('members.ratesLabel')
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editing && canEdit && (
        <UserScheduleModal
          user={{
            id: editing.id,
            email: editing.email,
            name: editing.name,
            timezone: 'UTC',
            status: 'ACTIVE',
            isAdmin: false,
            roleKey: null,
            roleName: null,
            countryCode: null,
            employeeId: null,
            authProvider: 'LOCAL',
            allowLocalLogin: true,
            mfaEnabled: false,
            mustChangePassword: false,
            createdAt: '',
            updatedAt: '',
          } as any}
          initial={scheduleByUser[editing.id] ?? null}
          onClose={() => setEditing(null)}
          onSaved={(s) => setScheduleByUser((mp) => ({ ...mp, [editing.id]: s }))}
          flash={flash}
        />
      )}
      {editing && !canEdit && (
        <ReadOnlyScheduleDialog
          user={editing}
          schedule={scheduleByUser[editing.id] ?? null}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <AddMemberDialog
          team={team}
          onClose={() => setAdding(false)}
          onAdded={(newMember) => {
            onMembersChanged([...members, newMember]);
            flash(t('members.memberAdded', { name: newMember.user.name, team: team.name }));
            setAdding(false);
          }}
          flash={flash}
        />
      )}
      {editingSkills && (
        <UserSkillsDialog
          user={editingSkills}
          adminOrLeadEdit={canEdit}
          isSelf={!!meAuth && meAuth.id === editingSkills.id}
          onClose={() => setEditingSkills(null)}
          flash={flash}
        />
      )}
      {editingRates && canEdit && (
        <MemberRatesDialog
          teamId={team.id}
          user={editingRates}
          onClose={() => setEditingRates(null)}
          onSaved={(u) => {
            onMembersChanged(
              members.map((m) => (m.userId === u.id ? { ...m, user: { ...m.user, ...u } } : m)),
            );
            setEditingRates(null);
            flash(t('members.ratesUpdated', { name: u.name }));
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

/* ----------------------- Member default rates (lead only) -------------------- */

/**
 * Coûts par défaut d'un membre (coût interne + taux facturé / h), stockés sur
 * le User (globaux, pas par équipe). Visibles et éditables uniquement par un
 * Team Manager de l'équipe (le serveur strip les champs pour les autres).
 * Résolution finance : taux projet explicite > défaut user > défaut projet.
 */
function MemberRatesDialog({
  teamId,
  user,
  onClose,
  onSaved,
  flash,
}: {
  teamId: string;
  user: TeamMemberDto['user'];
  onClose: () => void;
  onSaved: (u: TeamMemberDto['user']) => void;
  flash: (m: string) => void;
}) {
  const [cost, setCost] = useState(user.defaultCostRate != null ? String(user.defaultCostRate) : '');
  const [bill, setBill] = useState(user.defaultBillRate != null ? String(user.defaultBillRate) : '');
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation('teams');

  const parse = (s: string): number | null | undefined => {
    const v = s.trim().replace(',', '.');
    if (v === '') return null; // champ vidé = effacer le défaut
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined; // undefined = invalide
  };

  const save = async () => {
    const c = parse(cost);
    const b = parse(bill);
    if (c === undefined || b === undefined) {
      flash(t('rates.invalid'));
      return;
    }
    setSaving(true);
    try {
      const m = await api.updateTeamMember(teamId, user.id, {
        defaultCostRate: c,
        defaultBillRate: b,
      });
      onSaved({
        ...user,
        defaultCostRate: m.user.defaultCostRate ?? c,
        defaultBillRate: m.user.defaultBillRate ?? b,
      });
    } catch (e) {
      flash(t('rates.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 420 }}
      >
        <div className="md-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('rates.eyebrow')}</div>
            <div className="md-title truncate">{user.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <div className="md-field">
            <div className="md-label">{t('rates.costRate')}</div>
            <input
              className="atext mono"
              inputMode="decimal"
              value={cost}
              placeholder={t('rates.costPlaceholder')}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('rates.billRate')}</div>
            <input
              className="atext mono"
              inputMode="decimal"
              value={bill}
              placeholder={t('rates.billPlaceholder')}
              onChange={(e) => setBill(e.target.value)}
            />
          </div>
          <div className="set-desc" style={{ fontSize: 12 }}>
            {t('rates.description')}
          </div>
        </div>
        <div className="md-foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-line btn-sm" onClick={onClose} disabled={saving}>
            {t('common:cancel')}
          </button>
          <button className="btn btn-accent btn-sm" onClick={save} disabled={saving}>
            {saving ? t('common:saving') : t('common:save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Add member dialog ---------------------------- */

function AddMemberDialog({
  team,
  onClose,
  onAdded,
  flash,
}: {
  team: TeamWithMembersDto;
  onClose: () => void;
  onAdded: (m: TeamMemberDto) => void;
  flash: (m: string) => void;
}) {
  const [allUsers, setAllUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<UserDto | null>(null);
  const [isLead, setIsLead] = useState(false);
  const [saving, setSaving] = useState(false);
  const { t } = useTranslation('teams');

  useEffect(() => {
    let cancelled = false;
    api
      // Les agents IA sont éligibles à une équipe « comme un humain » — ils
      // suivent alors les affectations projet de l'équipe (badge « Agent »).
      .listUsers({ includeAgents: true })
      .then((list) => {
        if (!cancelled) setAllUsers(list);
      })
      .catch((e) => {
        if (!cancelled) flash(t('addMember.loadUsersFailed', { message: (e as Error).message }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const memberIds = useMemo(
    () => new Set(team.members.map((m) => m.userId)),
    [team.members],
  );
  const candidates = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return allUsers
      .filter((u) => !memberIds.has(u.id) && u.status === 'ACTIVE')
      .filter(
        (u) => !qq || (u.name + ' ' + u.email).toLowerCase().includes(qq),
      )
      .slice(0, 50);
  }, [allUsers, memberIds, q]);

  async function save() {
    if (!picked) return;
    setSaving(true);
    try {
      const created = await api.addTeamMember(team.id, {
        userId: picked.id,
        isLead,
      });
      onAdded({
        userId: created.userId,
        isLead: created.isLead,
        user: created.user,
      });
    } catch (e) {
      flash(t('addMember.addFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="md-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('addMember.eyebrow')}</div>
            <div className="md-title truncate">{team.displayName || team.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body" style={{ display: 'grid', gap: 12 }}>
          <div className="lfilter">
            <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('addMember.searchPlaceholder')}
            />
          </div>
          <div
            style={{
              maxHeight: 280,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
            }}
          >
            {loading && (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13 }}>
                {t('addMember.loadingUsers')}
              </div>
            )}
            {!loading && candidates.length === 0 && (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13 }}>
                {q
                  ? t('addMember.noMatchingUser')
                  : t('addMember.allActiveMembers')}
              </div>
            )}
            {candidates.map((u) => {
              const initials = u.name
                .split(' ')
                .map((w) => w[0])
                .join('')
                .slice(0, 2)
                .toUpperCase();
              const on = picked?.id === u.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setPicked(u)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '8px 10px',
                    border: 0,
                    background: on
                      ? 'oklch(from var(--accent) l c h / 0.12)'
                      : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13,
                  }}
                >
                  <Avatar
                    user={{
                      id: u.id,
                      name: u.name,
                      short: u.name.split(' ')[0],
                      initials,
                      role: '',
                      hue: hueFromId(u.id),
                      online: false,
                    }}
                    size={28}
                    title={false}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="truncate" style={{ fontWeight: 600 }}>
                      {u.name}
                    </div>
                    <div
                      className="truncate"
                      style={{ color: 'var(--text-3)', fontSize: 12 }}
                    >
                      {u.email}
                    </div>
                  </div>
                  {u.kind === 'AGENT' && (
                    <span
                      className="pill"
                      style={{
                        background: 'color-mix(in oklch, var(--accent) 16%, var(--surface))',
                        color: 'var(--accent)',
                        fontSize: 10.5,
                        flexShrink: 0,
                      }}
                    >
                      {t('addMember.agentBadge')}
                    </span>
                  )}
                  {on && (
                    <Icon name="check" size={16} style={{ color: 'var(--accent)' }} />
                  )}
                </button>
              );
            })}
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: 'var(--text-2)',
            }}
          >
            <input
              type="checkbox"
              checked={isLead}
              onChange={(e) => setIsLead(e.target.checked)}
            />
            {t('addMember.promoteAsLead')}
          </label>
        </div>
        <div className="md-foot">
          <div className="md-foot-meta" />
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            <button
              className="btn btn-accent"
              onClick={save}
              disabled={!picked || saving}
            >
              {saving ? t('addMember.adding') : t('members.addToTeam')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- Read-only schedule view -------------------------- */

function ReadOnlyScheduleDialog({
  user,
  schedule,
  onClose,
}: {
  user: TeamMemberDto['user'];
  schedule: WorkScheduleDto | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('teams');
  const sum = schedule ? summarizeSchedule(schedule) : null;
  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="md-head">
          <Avatar
            user={{
              id: user.id,
              name: user.name,
              short: user.name.split(' ')[0],
              initials: user.name
                .split(' ')
                .map((w) => w[0])
                .join('')
                .slice(0, 2)
                .toUpperCase(),
              role: '',
              hue: hueFromId(user.id),
              online: false,
            }}
            size={38}
            title={false}
          />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('readOnlySchedule.eyebrow')}</div>
            <div className="md-title truncate">{user.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          {sum ? (
            <>
              <div className="md-field">
                <div className="md-label">{t('readOnlySchedule.workingDays')}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAY_KEYS.map((k) => {
                    const on = sum.daysOn.includes(k);
                    return (
                      <span
                        key={k}
                        style={{
                          padding: '4px 10px',
                          border: '1px solid var(--border)',
                          borderRadius: 999,
                          fontSize: 12,
                          background: on
                            ? 'oklch(from var(--accent) l c h / 0.12)'
                            : 'var(--surface-2)',
                          color: on ? 'var(--accent)' : 'var(--text-3)',
                        }}
                      >
                        {DAY_SHORT[k]}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="md-field">
                <div className="md-label">{t('readOnlySchedule.hoursPerWeek')}</div>
                <div className="mono" style={{ fontSize: 15 }}>
                  {sum.hoursPerWeek}h
                </div>
              </div>
              {schedule?.occupancyPct != null && (
                <div className="md-field">
                  <div className="md-label">{t('readOnlySchedule.targetOccupancy')}</div>
                  <div className="mono">{schedule.occupancyPct}%</div>
                </div>
              )}
              <div className="md-span" style={{ color: 'var(--text-3)' }}>
                {sum.isDefault
                  ? t('readOnlySchedule.inheritsDefaults')
                  : t('readOnlySchedule.customSet')}
                {' '}{t('readOnlySchedule.noPermission')}
              </div>
            </>
          ) : (
            <div className="md-span">{t('readOnlySchedule.noScheduleData')}</div>
          )}
        </div>
        <div className="md-foot">
          <div className="md-foot-meta" />
          <div className="row gap2">
            <button className="btn btn-line" onClick={onClose}>
              {t('common:close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Main view --------------------------------- */

export function TeamView() {
  const { user: authUser } = useAuth();
  const { t } = useTranslation('teams');
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamWithMembersDto | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);

  const flash = (m: string) => {
    setFlashMsg(m);
    setTimeout(() => setFlashMsg((cur) => (cur === m ? null : cur)), 3200);
  };

  // Load list of teams the user belongs to.
  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    api
      .listTeams()
      .then((list) => {
        if (cancelled) return;
        setTeams(list);
        if (list.length > 0) {
          const preferred = sessionStorage.getItem('vaks.teamView.selectedId');
          const valid = preferred && list.some((tm) => tm.id === preferred) ? preferred : list[0].id;
          setSelectedId(valid);
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load selected team details.
  useEffect(() => {
    if (!selectedId) {
      setTeam(null);
      return;
    }
    let cancelled = false;
    setLoadingTeam(true);
    sessionStorage.setItem('vaks.teamView.selectedId', selectedId);
    api
      .getTeam(selectedId)
      .then((tm) => {
        if (!cancelled) setTeam(tm);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingTeam(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const isLead = useMemo(() => {
    if (!team || !authUser) return false;
    if (authUser.isAdmin) return true;
    return team.members.some((m) => m.userId === authUser.id && m.isLead);
  }, [team, authUser]);

  if (loadingList) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
        {t('view.loadingTeams')}
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
        {t('view.loadFailed', { error })}
      </div>
    );
  }
  if (teams.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
        {t('view.noTeams')}
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 16,
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="users" size={18} />
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('header.title')}</h2>
        </div>
        {teams.length > 1 && (
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: 13,
            }}
          >
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.displayName || tm.name}
              </option>
            ))}
          </select>
        )}
        {team && (
          <span
            className="pill"
            style={{
              background: team.color ?? 'var(--surface-2)',
              color: team.color ? '#fff' : 'var(--text-3)',
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            {t('header.memberCount', { count: team.members.length })}
          </span>
        )}
        {isLead && (
          <span
            className="pill pill-role"
            style={{ marginLeft: 'auto', fontSize: 11 }}
            title={t('header.youCanEdit')}
          >
            {t('header.youAreLead')}
          </span>
        )}
      </header>

      {loadingTeam || !team ? (
        <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
          {t('view.loadingTeam')}
        </div>
      ) : (
        <>
          {team.description && !isLead && (
            <div
              style={{
                padding: 12,
                marginBottom: 16,
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--surface-2)',
                fontSize: 13,
                color: 'var(--text-2)',
              }}
            >
              {team.description}
            </div>
          )}
          {isLead && (
            <TeamInfoEditor
              team={team}
              onSaved={(updated) => {
                setTeam((cur) => (cur ? { ...cur, ...updated } : cur));
                setTeams((list) =>
                  list.map((tm) => (tm.id === updated.id ? { ...tm, ...updated } : tm)),
                );
              }}
              flash={flash}
            />
          )}
          {isLead && <TeamSkillsEditor team={team} flash={flash} />}
          <MemberList
            team={team}
            canEdit={isLead}
            flash={flash}
            onMembersChanged={(members) =>
              setTeam((cur) => (cur ? { ...cur, members } : cur))
            }
          />
        </>
      )}
      <FlashBar msg={flashMsg} />
      </div>
    </div>
  );
}

/* ---------------------------- User skills dialog ---------------------------- */

export function UserSkillsDialog({
  user,
  adminOrLeadEdit,
  isSelf,
  onClose,
  flash,
}: {
  user: TeamMemberDto['user'];
  /** True si le caller est admin ou team-lead de cet utilisateur. */
  adminOrLeadEdit: boolean;
  /** True si la cible = l'utilisateur courant. */
  isSelf: boolean;
  onClose: () => void;
  flash: (m: string) => void;
}) {
  const { orgSettings } = useAuth();
  const { t } = useTranslation('teams');
  const [catalog, setCatalog] = useState<SkillDto[]>([]);
  const [mine, setMine] = useState<UserSkillDto[]>([]);
  const [maxLevel, setMaxLevel] = useState(orgSettings.skillsMaxLevel);
  const levelScale = orgSettings.skillsLevelScale;
  const [selfEditAllowed, setSelfEditAllowed] = useState(false);
  const [canWriteCatalog, setCanWriteCatalog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Niveau en cours de saisie pour chaque skill (string pour permettre champ vide).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newSkillName, setNewSkillName] = useState('');
  const [creating, setCreating] = useState(false);

  const canEdit = adminOrLeadEdit || (isSelf && selfEditAllowed);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listSkills(),
      api.listUserSkills(user.id),
      api.getPublicSettings().catch(() => null),
      api.skillsCapabilities().catch(() => ({ canWriteCatalog: false })),
    ])
      .then(([cat, us, settings, caps]) => {
        if (cancelled) return;
        setCatalog(cat);
        setMine(us);
        const n = settings?.skillsMaxLevel;
        if (typeof n === 'number' && n >= 1 && n <= 100) setMaxLevel(n);
        setSelfEditAllowed(settings?.skillsSelfEditEnabled === true);
        setCanWriteCatalog(!!caps.canWriteCatalog);
      })
      .catch((e) => flash(t('userSkills.error', { message: (e as Error).message })))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `flash` est volontairement exclu : c'est une fonction recréée à chaque
    // render du parent (TeamView), et la mettre dans les deps déclenche un
    // re-fire perpétuel qui annule le chargement avant que setCatalog n'ait
    // le temps d'exécuter → le catalogue restait vide en boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const createSkillInline = async () => {
    const name = newSkillName.trim();
    if (!name) return;
    // Doublon insensible à la casse / espaces.
    const norm = name.toLowerCase().replace(/\s+/g, ' ');
    const dup = catalog.find(
      (s) => s.name.toLowerCase().replace(/\s+/g, ' ') === norm,
    );
    if (dup) {
      flash(t('userSkills.alreadyExists', { name: dup.name }));
      return;
    }
    setCreating(true);
    try {
      const created = await api.createSkill({ name });
      setCatalog((arr) => [...arr, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewSkillName('');
      flash(t('userSkills.skillCreated', { name: created.name }));
    } catch (e) {
      flash(t('userSkills.createFailed', { message: (e as Error).message }));
    } finally {
      setCreating(false);
    }
  };

  const levelOf = (skillId: string) =>
    mine.find((m) => m.skillId === skillId)?.level ?? 0;

  const setLevel = async (skillId: string, level: number) => {
    setBusy((b) => ({ ...b, [skillId]: true }));
    try {
      const saved = await api.upsertUserSkill(user.id, skillId, level);
      setMine((arr) => {
        const idx = arr.findIndex((x) => x.skillId === skillId);
        if (idx >= 0) {
          const copy = arr.slice();
          copy[idx] = saved;
          return copy;
        }
        return [...arr, saved];
      });
    } catch (e) {
      flash(t('userSkills.error', { message: (e as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [skillId]: false }));
    }
  };

  const removeLevel = async (skillId: string) => {
    setBusy((b) => ({ ...b, [skillId]: true }));
    try {
      await api.deleteUserSkill(user.id, skillId);
      setMine((arr) => arr.filter((x) => x.skillId !== skillId));
    } catch (e) {
      flash(t('userSkills.error', { message: (e as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [skillId]: false }));
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
        className="md-card"
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '85vh',
          display: 'grid',
          gridTemplateRows: 'auto auto 1fr auto',
          background: 'var(--surface)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600 }}>{t('userSkills.title', { name: user.name })}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {t('userSkills.levelPerSkill', { max: maxLevel })} · {canEdit
              ? adminOrLeadEdit
                ? t('userSkills.editableAdmin')
                : t('userSkills.editableSelf')
              : isSelf && !selfEditAllowed
                ? t('userSkills.readOnlyNoSelfEdit')
                : t('userSkills.readOnly')}
          </div>
          {levelScale.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginTop: 6,
                fontSize: 11,
                color: 'var(--text-3)',
              }}
              title={t('userSkills.scaleTitle')}
            >
              {levelScale.map((r) => (
                <span
                  key={r.level}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 6px',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                  }}
                >
                  <strong style={{ color: 'var(--text-2)' }}>{r.level}</strong>
                  <span>{r.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'grid',
            gap: 8,
          }}
        >
          {canWriteCatalog && (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="atext"
                placeholder={t('userSkills.newSkillPlaceholder')}
                value={newSkillName}
                onChange={(e) => setNewSkillName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createSkillInline();
                }}
                disabled={creating}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-line btn-sm"
                onClick={createSkillInline}
                disabled={creating || !newSkillName.trim()}
                style={{ whiteSpace: 'nowrap' }}
              >
                <Icon name="plus" size={14} /> {t('common:create')}
              </button>
            </div>
          )}
        </div>
        <div style={{ overflow: 'auto', padding: '12px 18px' }}>
          {loading ? (
            <div style={{ padding: 14, opacity: 0.6 }}>{t('userSkills.loading')}</div>
          ) : (
            <SkillPicker
              skills={catalog}
              selected={mine.filter((m) => m.level > 0).map((m) => m.skillId)}
              onChange={() => { /* contrôlé par renderItemAside (slider niveau) */ }}
              multiple
              placeholder={t('userSkills.searchPlaceholder')}
              emptyHint={
                catalog.length === 0
                  ? t('userSkills.emptyCatalog')
                  : t('userSkills.emptyNoMatch')
              }
              maxHeight={400}
              renderItemAside={(s) => {
                const lvl = levelOf(s.id);
                const has = lvl > 0;
                const tierLabel = has ? labelForLevel(lvl, levelScale) : null;
                const scaleMode =
                  orgSettings.skillsLevelInputMode === 'scale' && levelScale.length > 0;
                const draftVal = draft[s.id] ?? (has ? String(lvl) : '');
                if (scaleMode) {
                  // En mode "palier uniquement" : dropdown (vide = retire le skill).
                  const current = has ? (tierLabel ?? '') : '';
                  return (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        opacity: canEdit ? 1 : 0.6,
                      }}
                    >
                      <select
                        value={current}
                        disabled={!canEdit || busy[s.id]}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '') {
                            if (has) removeLevel(s.id);
                            return;
                          }
                          const row = levelScale.find((r) => r.label === v);
                          if (!row) return;
                          if (row.level !== lvl) setLevel(s.id, row.level);
                        }}
                        style={{
                          padding: '4px 6px',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          fontSize: 12,
                          minWidth: 130,
                        }}
                        title={t('userSkills.pickTier')}
                      >
                        <option value="">—</option>
                        {levelScale.map((r) => (
                          <option key={r.level} value={r.label}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </span>
                  );
                }
                const commit = (raw: string) => {
                  const trimmed = raw.trim();
                  if (trimmed === '' || trimmed === '0') {
                    setDraft((d) => ({ ...d, [s.id]: '' }));
                    if (has) removeLevel(s.id);
                    return;
                  }
                  const n = parseInt(trimmed, 10);
                  if (!Number.isFinite(n)) {
                    setDraft((d) => ({ ...d, [s.id]: has ? String(lvl) : '' }));
                    return;
                  }
                  const clamped = Math.max(1, Math.min(maxLevel, n));
                  setDraft((d) => ({ ...d, [s.id]: String(clamped) }));
                  if (clamped !== lvl) setLevel(s.id, clamped);
                };
                return (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      opacity: canEdit ? 1 : 0.6,
                    }}
                  >
                    <input
                      className="atext mono"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={maxLevel}
                      step={1}
                      placeholder="—"
                      value={draftVal}
                      disabled={!canEdit || busy[s.id]}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [s.id]: e.target.value }))
                      }
                      onBlur={(e) => commit(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') {
                          setDraft((d) => ({ ...d, [s.id]: has ? String(lvl) : '' }));
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      style={{
                        width: 56,
                        textAlign: 'center',
                        padding: '4px 6px',
                      }}
                      title={
                        tierLabel
                          ? t('userSkills.levelWithTier', { level: lvl, max: maxLevel, tier: tierLabel })
                          : t('userSkills.levelPlain', { max: maxLevel })
                      }
                    />
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--text-faint)',
                        minWidth: 22,
                      }}
                    >
                      /{maxLevel}
                    </span>
                    {tierLabel && (
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--text-3)',
                          fontStyle: 'italic',
                          marginLeft: 2,
                          maxWidth: 110,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={t('userSkills.configuredTier', { tier: tierLabel })}
                      >
                        {tierLabel}
                      </span>
                    )}
                  </span>
                );
              }}
            />
          )}
        </div>
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button className="btn" onClick={onClose}>
            {t('common:close')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TeamView;
