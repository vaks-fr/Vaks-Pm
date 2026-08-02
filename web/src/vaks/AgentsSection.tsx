import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDto,
  AgentCredentialDto,
  AgentRunSummaryDto,
  AgentTrustLevel,
  CreateAgentDto,
  UserDto,
  UserSkillDto,
} from '@vaks-pm/shared';
import { AGENT_TRUST_LEVELS, KNOWN_AGENT_MODELS, permissionsForCapabilities } from '@vaks-pm/shared';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { useAuth } from '../auth/AuthContext';
import { UserSkillsDialog } from './TeamView';

type Flash = (msg: string) => void;

/** Portail d'essai (marketing) — pré-rempli du licenseId. */
const TRIAL_URL = 'https://vaks-pm.com/trial';

// ---------------------------------------------------------------------------
// Section principale : liste compacte (recherche + onglets + pagination),
// modale d'édition, connecteurs d'annuaire repliables.
// ---------------------------------------------------------------------------

const AGENTS_PAGE_SIZE = 20;

export default function AgentsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const { license, refreshLicense } = useAuth();
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentDto | 'new' | null>(null);
  const [minted, setMinted] = useState<{ agentName: string; token: string } | null>(null);

  // Filtres client (la liste agents tient largement en mémoire ; si un jour
  // elle explose, basculer sur une route paginée façon /users/directory).
  const [search, setSearch] = useState('');
  const [statusTab, setStatusTab] = useState<'ACTIVE' | 'SUSPENDED'>('ACTIVE');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, caps] = await Promise.all([
        api.listAgents(),
        api.listAgentCapabilities(),
      ]);
      setAgents(list);
      setCapabilities(caps.map((c) => c.key));
      // Liste d'users (picker d'owner) chargée à part et tolérante : un « AI
      // administrator » restreint peut ne pas avoir `project:view` — dans ce cas
      // la section reste utilisable, seul le sélecteur d'owner est vide.
      const allUsers = await api.listUsers({ includeAgents: false }).catch(() => []);
      setUsers(allUsers);
      // Rafraîchit le quota (agentsUsed/agentLimit) après toute mutation d'agent.
      void refreshLicense();
    } catch (e) {
      flash(t('agents.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [flash, t, refreshLicense]);

  useEffect(() => {
    void load();
  }, [load]);

  // Recherche + onglet statut → remet en page 1.
  useEffect(() => setPage(1), [search, statusTab]);

  const counts = useMemo(
    () => ({
      active: agents.filter((a) => a.status === 'ACTIVE').length,
      suspended: agents.filter((a) => a.status === 'SUSPENDED').length,
    }),
    [agents],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents
      .filter((a) => a.status === statusTab)
      .filter(
        (a) =>
          !q ||
          `${a.name} ${a.ownerName ?? ''} ${a.ownerEmail ?? ''} ${a.model ?? ''} ${a.source}`
            .toLowerCase()
            .includes(q),
      );
  }, [agents, statusTab, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / AGENTS_PAGE_SIZE));
  const paged = filtered.slice((page - 1) * AGENTS_PAGE_SIZE, page * AGENTS_PAGE_SIZE);
  const from = filtered.length === 0 ? 0 : (page - 1) * AGENTS_PAGE_SIZE + 1;
  const to = Math.min(page * AGENTS_PAGE_SIZE, filtered.length);

  // Quota freemium : plafond effectif depuis la licence (null = illimité).
  // `used` = agents vivants (non suspendus) = onglet Actif. Le serveur reste
  // l'autorité (403 AGENT_LIMIT_REACHED) ; l'UI n'anticipe que le blocage.
  const agentLimit = license?.agentLimit ?? null;
  const agentsUsed = counts.active;
  const atCap = agentLimit != null && agentsUsed >= agentLimit;
  const trialHref = license?.organizationId
    ? `${TRIAL_URL}?licenseId=${encodeURIComponent(license.organizationId)}`
    : TRIAL_URL;

  return (
    <div>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 12 }}>
        {t('agents.intro')}
      </div>

      {/* Bandeau quota (freemium) */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          margin: '0 0 12px', padding: '8px 12px', borderRadius: 8,
          border: '1px solid var(--border)',
          background: atCap ? 'color-mix(in oklch, var(--accent) 8%, var(--surface))' : 'var(--surface)',
          fontSize: 13,
        }}
      >
        <span style={{ color: atCap ? 'var(--accent)' : 'var(--text-2)' }}>
          {agentLimit == null
            ? t('agents.quotaUnlimited', { defaultValue: 'AI agents: {{used}} (unlimited)', used: agentsUsed })
            : t('agents.quotaUsage', { defaultValue: 'AI agents: {{used}} / {{limit}} (free plan)', used: agentsUsed, limit: agentLimit })}
        </span>
        {atCap && (
          <a
            href={trialHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ marginLeft: 'auto', color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
          >
            {t('agents.quotaCta', { defaultValue: 'Unlock unlimited agents + keyless federation — free trial →' })}
          </a>
        )}
      </div>

      {/* Barre de recherche + total + bouton créer */}
      <div className="lfilter">
        <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('agents.searchPlaceholder')}
        />
        <span className="lf-count">
          {from}–{to} / {filtered.length}
        </span>
        <button
          className="btn btn-accent btn-sm"
          style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
          disabled={atCap}
          title={atCap ? t('agents.quotaReachedHint', { defaultValue: 'Free agent limit reached — upgrade to add more.' }) : undefined}
          onClick={() => setEditing('new')}
        >
          <Icon name="plus" size={14} /> {t('agents.addButton')}
        </button>
      </div>

      {/* Onglets Actif / Suspendu */}
      <div className="row gap2" style={{ margin: '4px 0 12px' }}>
        <div className="seg">
          <button
            className={'seg-btn' + (statusTab === 'ACTIVE' ? ' seg-on' : '')}
            onClick={() => setStatusTab('ACTIVE')}
          >
            {t('agents.activeCount', { count: counts.active })}
          </button>
          <button
            className={'seg-btn' + (statusTab === 'SUSPENDED' ? ' seg-on' : '')}
            onClick={() => setStatusTab('SUSPENDED')}
          >
            {t('agents.suspendedCount', { count: counts.suspended })}
          </button>
        </div>
      </div>

      <div className="dir-card">
        {loading && <div className="set-desc" style={{ padding: 16 }}>{t('common:loading')}</div>}
        {!loading && filtered.length === 0 && (
          <div className="set-desc" style={{ padding: 16 }}>
            {agents.length === 0 ? t('agents.empty') : t('agents.noMatch')}
          </div>
        )}
        {!loading && paged.map((a) => <AgentRow key={a.id} agent={a} onEdit={() => setEditing(a)} />)}
      </div>

      {/* Pagination client */}
      {pageCount > 1 && (
        <div className="row gap2" style={{ marginTop: 12, justifyContent: 'center', alignItems: 'center' }}>
          <button className="btn btn-line btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <Icon name="chevL" size={14} /> {t('users.prev')}
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{t('users.page', { page, pageCount })}</span>
          <button
            className="btn btn-line btn-sm"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            {t('users.next')} <Icon name="chevR" size={14} />
          </button>
        </div>
      )}

      {editing && (
        <AgentEditorModal
          agent={editing === 'new' ? null : editing}
          users={users}
          capabilities={capabilities}
          onClose={() => setEditing(null)}
          onChanged={load}
          onMinted={(agentName, token) => setMinted({ agentName, token })}
          flash={flash}
        />
      )}

      {minted && (
        <TokenModal agentName={minted.agentName} token={minted.token} onClose={() => setMinted(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ligne compacte (nom · owner · pills · Edit)
// ---------------------------------------------------------------------------

function TrustPill({ level }: { level: AgentTrustLevel }) {
  const { t } = useTranslation('admin');
  const colors: Record<AgentTrustLevel, string> = {
    DRAFT_ONLY: 'var(--text-3)',
    SUPERVISED: 'var(--warn, #b45309)',
    AUTONOMOUS: 'var(--ok, #3fb950)',
  };
  return (
    <span className="pill" style={{ background: 'var(--surface-2)', color: colors[level] }}>
      {t(`agents.trust.${level}`)}
    </span>
  );
}

function AgentRow({ agent: a, onEdit }: { agent: AgentDto; onEdit: () => void }) {
  const { t } = useTranslation('admin');
  const initials = a.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const tokenCount = a.tokens?.length ?? 0;
  return (
    <div className="dir-row">
      <div
        aria-hidden
        style={{
          width: 32, height: 32, borderRadius: 9, flexShrink: 0,
          display: 'grid', placeItems: 'center',
          background: 'color-mix(in oklch, var(--accent) 14%, var(--surface))',
          color: 'var(--accent)', fontWeight: 700, fontSize: 12,
        }}
      >
        {initials}
      </div>
      <div className="dir-id">
        <div className="dir-name row gap1" style={{ alignItems: 'center' }}>
          {a.name}
          <span
            className="pill"
            style={{
              background: 'color-mix(in oklch, var(--accent) 16%, var(--surface))',
              color: 'var(--accent)', fontSize: 10,
            }}
          >
            {t('agents.agentBadge', { defaultValue: 'Agent' })}
          </span>
        </div>
        <div className="dir-email">
          {t('agents.owner')} : {a.ownerName ?? a.ownerEmail ?? '—'}
        </div>
      </div>
      <div className="dir-title" style={{ color: 'var(--text-3)', fontSize: 12.5 }}>
        {a.model ? (
          <span>{a.modelProvider ? `${a.modelProvider}/` : ''}{a.model}</span>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>—</span>
        )}
      </div>
      <div className="row gap2" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        <span className="pill pill-role">{t(`agents.source.${a.source}`, { defaultValue: a.source })}</span>
        <TrustPill level={a.trustLevel} />
        {a.status === 'SUSPENDED' && (
          <span className="pill pill-status suspended">{t('agents.statusSuspended')}</span>
        )}
        {tokenCount > 0 && (
          <span className="pill" style={{ background: 'var(--surface-2)', color: 'var(--text-3)' }}>
            {t('agents.tokensCount', { count: tokenCount })}
          </span>
        )}
      </div>
      <div className="row gap2" style={{ flexShrink: 0 }}>
        <button className="btn btn-line btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={onEdit}>
          <Icon name="pencil" size={14} /> {t('common:edit')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modale d'édition — champs + jetons + zone de danger (suspend/suppression)
// ---------------------------------------------------------------------------

function AgentEditorModal({
  agent,
  users,
  capabilities,
  onClose,
  onChanged,
  onMinted,
  flash,
}: {
  agent: AgentDto | null;
  users: UserDto[];
  capabilities: string[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onMinted: (agentName: string, token: string) => void;
  flash: Flash;
}) {
  const { t, i18n } = useTranslation('admin');
  const confirm = useConfirm();
  const [name, setName] = useState(agent?.name ?? '');
  const [ownerId, setOwnerId] = useState(agent?.ownerId ?? '');
  const [trustLevel, setTrustLevel] = useState<AgentTrustLevel>(agent?.trustLevel ?? 'DRAFT_ONLY');
  const [caps, setCaps] = useState<string[]>(agent?.capabilities ?? ['read:project']);
  const [modelProvider, setModelProvider] = useState(agent?.modelProvider ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [hostingRegion, setHostingRegion] = useState(agent?.hostingRegion ?? '');
  const [maxConcurrent, setMaxConcurrent] = useState<string>(agent?.maxConcurrentTasks?.toString() ?? '');
  const [dailyRuns, setDailyRuns] = useState<string>(agent?.dailyRunBudget?.toString() ?? '');
  const [costInPerK, setCostInPerK] = useState<string>(agent?.costRateInPerKTokens?.toString() ?? '');
  const [costOutPerK, setCostOutPerK] = useState<string>(agent?.costRateOutPerKTokens?.toString() ?? '');
  const [billPerK, setBillPerK] = useState<string>(agent?.defaultBillRatePerKTokens?.toString() ?? '');
  const [dailyCost, setDailyCost] = useState<string>(agent?.dailyCostBudget?.toString() ?? '');
  const [monthlyCost, setMonthlyCost] = useState<string>(agent?.monthlyCostBudget?.toString() ?? '');
  const [tokens, setTokens] = useState(agent?.tokens ?? []);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<AgentRunSummaryDto | null>(null);
  // Compétences de l'agent (UserSkill) — ce qu'il sait faire. Le niveau encode la
  // fiabilité sur ce type de tâche ; sert au filtre `next_task` (chantier 4).
  // Édition via le MÊME dialogue que les users (`UserSkillsDialog`) — ici on
  // n'affiche qu'un résumé lecture seule + bouton d'ouverture.
  const [agentSkills, setAgentSkills] = useState<UserSkillDto[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Identifiants machine (refresh rotatif — agents headless sans plateforme).
  const [credentials, setCredentials] = useState<AgentCredentialDto[]>([]);
  const [newCredSecret, setNewCredSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    let alive = true;
    api.getAgentRuns(agent.id).then(
      (u) => alive && setUsage(u),
      () => undefined, // best-effort : le panneau usage reste masqué si l'appel échoue
    );
    api.listUserSkills(agent.id).then(
      (us) => alive && setAgentSkills(us),
      () => undefined,
    );
    api.listAgentCredentials(agent.id).then(
      (c) => alive && setCredentials(c),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [agent]);

  const issueCredential = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const r = await api.issueAgentCredential(agent.id, {});
      setNewCredSecret(r.secret); // montré une seule fois
      setCredentials(await api.listAgentCredentials(agent.id));
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revokeCredential = async (credentialId: string) => {
    if (!agent) return;
    try {
      await api.revokeAgentCredential(agent.id, credentialId);
      setCredentials(await api.listAgentCredentials(agent.id));
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const reloadSkills = async () => {
    if (agent) setAgentSkills(await api.listUserSkills(agent.id));
  };

  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(i18n.language) : '—');
  const toggleCap = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  // Modèles connus (catalogue embarqué, filtré par provider si renseigné). Sert
  // de suggestions au champ modèle ET pré-remplit les taux de coût s'ils sont
  // encore vides (l'admin garde la main : on n'écrase jamais une valeur saisie).
  const modelOptions = KNOWN_AGENT_MODELS.filter(
    (m) => !modelProvider.trim() || m.provider === modelProvider.trim(),
  );
  const applyModel = (val: string) => {
    setModel(val);
    const entry = KNOWN_AGENT_MODELS.find(
      (m) => m.model === val && (!modelProvider.trim() || m.provider === modelProvider.trim()),
    );
    if (!entry) return;
    if (!modelProvider.trim()) setModelProvider(entry.provider);
    if (!costInPerK.trim() && entry.suggestedCostInPerKTokens != null)
      setCostInPerK(String(entry.suggestedCostInPerKTokens));
    if (!costOutPerK.trim() && entry.suggestedCostOutPerKTokens != null)
      setCostOutPerK(String(entry.suggestedCostOutPerKTokens));
  };

  const save = async () => {
    if (!name.trim() || !ownerId) {
      flash(t('agents.nameOwnerRequired'));
      return;
    }
    setSaving(true);
    const dto: CreateAgentDto = {
      name: name.trim(),
      ownerId,
      trustLevel,
      capabilities: caps,
      modelProvider: modelProvider.trim() || null,
      model: model.trim() || null,
      hostingRegion: hostingRegion.trim() || null,
      maxConcurrentTasks: maxConcurrent.trim() ? Number(maxConcurrent) : null,
      dailyRunBudget: dailyRuns.trim() ? Number(dailyRuns) : null,
      costRateInPerKTokens: costInPerK.trim() ? Number(costInPerK) : null,
      costRateOutPerKTokens: costOutPerK.trim() ? Number(costOutPerK) : null,
      defaultBillRatePerKTokens: billPerK.trim() ? Number(billPerK) : null,
      dailyCostBudget: dailyCost.trim() ? Number(dailyCost) : null,
      monthlyCostBudget: monthlyCost.trim() ? Number(monthlyCost) : null,
    };
    try {
      if (agent) {
        await api.updateAgent(agent.id, dto);
        flash(t('agents.updated'));
      } else {
        await api.createAgent(dto);
        flash(t('agents.created'));
      }
      await onChanged();
      onClose();
    } catch (e) {
      flash(t('agents.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const issueToken = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const r = await api.mintAgentToken(agent.id, {});
      onMinted(agent.name, r.token);
      setTokens((prev) => [
        { id: r.id, name: `${agent.name} — token`, prefix: r.prefix, expiresAt: null, lastUsedAt: null },
        ...prev,
      ]);
      await onChanged();
    } catch (e) {
      flash(t('agents.mintFailed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (tokenId: string) => {
    if (!agent) return;
    if (
      !(await confirm({
        title: t('agents.revokeToken'),
        message: t('agents.confirmRevokeToken', { name: agent.name }),
        confirmLabel: t('agents.revokeToken'),
        danger: true,
      }))
    )
      return;
    try {
      await api.revokeAgentToken(agent.id, tokenId);
      setTokens((prev) => prev.filter((x) => x.id !== tokenId));
      flash(t('agents.tokenRevoked'));
      await onChanged();
    } catch (e) {
      flash(t('agents.actionFailed', { message: (e as Error).message }));
    }
  };

  const toggleStatus = async () => {
    if (!agent) return;
    const next = agent.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    setBusy(true);
    try {
      await api.updateAgent(agent.id, { status: next });
      flash(next === 'SUSPENDED' ? t('agents.suspended') : t('agents.reactivated'));
      await onChanged();
      onClose();
    } catch (e) {
      flash(t('agents.actionFailed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    if (
      !(await confirm({
        title: t('common:delete'),
        message: t('agents.confirmDelete', { name: agent.name }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.deleteAgent(agent.id);
      flash(t('agents.deleted'));
      await onChanged();
      onClose();
    } catch (e) {
      flash(t('agents.actionFailed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, node: ReactNode, help?: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{label}</span>
      {node}
      {help && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{help}</span>}
    </label>
  );

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'grid', placeItems: 'center', zIndex: 1090, padding: 16,
      }}
    >
      <div
        style={{
          width: '100%', maxWidth: 620, maxHeight: '88vh', overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg, 14px)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
          padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {agent ? t('agents.editTitle', { name: agent.name }) : t('agents.newTitle')}
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {field(
          t('agents.nameField'),
          <input className="td-in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />,
        )}
        {field(
          t('agents.ownerField'),
          <select className="td-in" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={{ width: '100%' }}>
            <option value="">{t('agents.ownerPlaceholder')}</option>
            {users
              .filter((u) => u.status !== 'SUSPENDED')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.email}
                </option>
              ))}
          </select>,
          t('agents.ownerHelp'),
        )}
        {field(
          t('agents.trustField'),
          <select
            className="td-in"
            value={trustLevel}
            onChange={(e) => setTrustLevel(e.target.value as AgentTrustLevel)}
            style={{ width: '100%' }}
          >
            {AGENT_TRUST_LEVELS.map((l) => (
              <option key={l} value={l}>{t(`agents.trust.${l}`)}</option>
            ))}
          </select>,
          t('agents.trustHelp'),
        )}
        {field(
          t('agents.capabilitiesField'),
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {capabilities.map((c) => {
              const on = caps.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => toggleCap(c)}
                  style={{
                    fontSize: 12, padding: '4px 10px', border: '1px solid var(--border)',
                    background: on ? 'color-mix(in oklch, var(--accent) 18%, var(--surface))' : 'var(--surface)',
                    color: on ? 'var(--accent)' : 'var(--text-2)',
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>,
          t('agents.capabilitiesHelp'),
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {field(t('agents.modelProviderField'), <input className="td-in" value={modelProvider} placeholder="anthropic" onChange={(e) => setModelProvider(e.target.value)} />)}
          {field(t('agents.modelField'), <><input className="td-in" list="vaks-agent-model-catalog" value={model} placeholder="claude-sonnet-5" onChange={(e) => applyModel(e.target.value)} /><datalist id="vaks-agent-model-catalog">{modelOptions.map((m) => (<option key={`${m.provider}/${m.model}`} value={m.model}>{m.label}</option>))}</datalist></>)}
          {field(t('agents.regionField'), <input className="td-in" value={hostingRegion} placeholder="eu" onChange={(e) => setHostingRegion(e.target.value)} />)}
          {field(t('agents.maxConcurrentField'), <input className="td-in" type="number" min={1} value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} />)}
          {field(t('agents.dailyRunsField'), <input className="td-in" type="number" min={1} value={dailyRuns} onChange={(e) => setDailyRuns(e.target.value)} />)}
          {field(t('agents.costInPerKTokensField'), <input className="td-in" type="number" min={0} step="0.001" placeholder="€" value={costInPerK} onChange={(e) => setCostInPerK(e.target.value)} />)}
          {field(t('agents.costOutPerKTokensField'), <input className="td-in" type="number" min={0} step="0.001" placeholder="€" value={costOutPerK} onChange={(e) => setCostOutPerK(e.target.value)} />)}
          {field(t('agents.billPerKTokensField'), <input className="td-in" type="number" min={0} step="0.001" placeholder="€" value={billPerK} onChange={(e) => setBillPerK(e.target.value)} />)}
          {field(t('agents.dailyCostField'), <input className="td-in" type="number" min={0} step="0.01" placeholder="€" value={dailyCost} onChange={(e) => setDailyCost(e.target.value)} />)}
          {field(t('agents.monthlyCostField'), <input className="td-in" type="number" min={0} step="0.01" placeholder="€" value={monthlyCost} onChange={(e) => setMonthlyCost(e.target.value)} />)}
        </div>

        {/* Jetons (édition seulement — un agent doit exister pour en émettre) */}
        {agent ? (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.tokensSection')}</span>
              <button className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={issueToken}>
                <Icon name="plus" size={13} /> {t('agents.mintToken')}
              </button>
            </div>
            {/* Le lien capacités → droits du jeton n'était écrit nulle part :
                on cherchait un sélecteur de scopes qui n'existe pas, et on
                minte un jeton trop pauvre sans comprendre pourquoi. */}
            <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
              {t('agents.mintScopesHint', {
                defaultValue:
                  'A token carries exactly the rights of the capabilities ticked above, frozen at issue time. Change the capabilities and the existing tokens do NOT follow: tick first, save, then issue a new token.',
              })}
              {caps.length > 0 && (
                <>
                  {' '}
                  <span style={{ color: 'var(--text-2)' }}>
                    {t('agents.mintScopesPreview', { defaultValue: 'This agent would get:' })}{' '}
                    <code style={{ fontFamily: 'var(--mono, monospace)' }}>
                      {permissionsForCapabilities(caps).join(', ') || '—'}
                    </code>
                  </span>
                </>
              )}
            </div>
            {tokens.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('agents.noTokens')}</div>
            ) : (
              tokens.map((tok) => (
                <div key={tok.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-2)' }}>
                  <code style={{ fontFamily: 'var(--mono, monospace)' }}>{tok.prefix}</code>
                  <span style={{ color: 'var(--text-3)' }}>
                    {t('agents.tokenExpires', { date: fmtDate(tok.expiresAt) })}
                    {tok.lastUsedAt ? ` · ${t('agents.tokenLastUsed', { date: fmtDate(tok.lastUsedAt) })}` : ''}
                  </span>
                  <button
                    className="btn btn-ghost"
                    onClick={() => revokeToken(tok.id)}
                    style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--danger, #f85149)' }}
                  >
                    {t('agents.revokeToken')}
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {t('agents.saveFirstForTokens')}
          </div>
        )}

        {/* Identifiants machine — refresh rotatif pour agents headless. L'agent
            l'échange contre un jeton court sur /agents/token et se renouvelle seul. */}
        {agent && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.machineCredsSection')}</span>
              <button className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={issueCredential}>
                <Icon name="plus" size={13} /> {t('agents.issueCredential')}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('agents.machineCredsHint')}</div>
            {newCredSecret && (
              <div style={{ background: 'var(--bg-warning, #3a2f12)', border: '1px solid var(--border-warning, #7a5c12)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-warning, #e3b341)' }}>{t('agents.credShownOnce')}</span>
                <code style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12, wordBreak: 'break-all' }}>{newCredSecret}</code>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(newCredSecret); flash(t('agents.copied')); }}>
                    <Icon name="copy" size={12} /> {t('agents.copy')}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setNewCredSecret(null)}>{t('common:close')}</button>
                </div>
              </div>
            )}
            {credentials.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('agents.noCredentials')}</div>
            ) : (
              credentials.map((c) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-2)' }}>
                  <code style={{ fontFamily: 'var(--mono, monospace)' }}>{c.chainId.slice(0, 8)}…</code>
                  <span style={{ color: c.revoked ? 'var(--danger, #f85149)' : 'var(--text-3)' }}>
                    {c.revoked
                      ? (c.reuseDetected ? t('agents.credReuseRevoked') : t('agents.credRevoked'))
                      : t('agents.credRotations', { count: c.rotationCount })}
                    {c.lastUsedAt ? ` · ${t('agents.tokenLastUsed', { date: fmtDate(c.lastUsedAt) })}` : ''}
                  </span>
                  {!c.revoked && (
                    <button className="btn btn-ghost" onClick={() => revokeCredential(c.id)} style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--danger, #f85149)' }}>
                      {t('agents.revokeToken')}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Usage & coût déclaratif (chantier finance agents) */}
        {agent && usage && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.usageSection')}</span>
            {usage.runCount === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('agents.usageEmpty')}</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
                  {[
                    { l: t('agents.usageRuns'), v: String(usage.runCount) },
                    { l: t('agents.usageTotalCost'), v: `€${usage.totalCost.toFixed(2)}` },
                    { l: t('agents.usageAvgPerTask'), v: usage.avgCostPerTask != null ? `€${usage.avgCostPerTask.toFixed(2)}` : '—' },
                    { l: t('agents.usageTokens'), v: (usage.totalTokensIn + usage.totalTokensOut).toLocaleString(i18n.language) },
                  ].map((s) => (
                    <div key={s.l}>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.l}</div>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflowY: 'auto' }}>
                  {usage.runs.map((r) => (
                    <div key={r.id} style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-2)', alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--text-3)' }}>{fmtDate(r.createdAt)}</span>
                      {r.model && <span>{r.model}</span>}
                      {(r.tokensIn != null || r.tokensOut != null) && (
                        <span className="mono" style={{ color: 'var(--text-3)' }}>
                          {(r.tokensIn ?? 0)}/{(r.tokensOut ?? 0)} tok
                        </span>
                      )}
                      <span className="grow truncate">{r.note ?? ''}</span>
                      {r.cost != null && <span style={{ fontWeight: 600 }}>€{r.cost.toFixed(2)}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Compétences de l'agent (ce qu'il sait faire — sert au next_task).
            Même UX que les users : résumé en chips + édition via UserSkillsDialog. */}
        {agent && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.skillsSection', { defaultValue: 'Skills' })}</span>
              <button className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSkillsOpen(true)}>
                <Icon name="edit" size={13} /> {t('agents.skillsEdit', { defaultValue: 'Edit skills' })}
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {t('agents.skillsHint', {
                defaultValue:
                  'What this agent can do. The level encodes its reliability on that kind of task, and gates which tasks it can pull (next_task).',
              })}
            </div>
            {agentSkills.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('agents.skillsEmpty', { defaultValue: 'No skill assigned yet.' })}</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {agentSkills.map((us) => (
                  <span
                    key={us.skillId}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 8px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 999,
                      fontSize: 12,
                    }}
                  >
                    {us.skill?.color && (
                      <i style={{ width: 7, height: 7, borderRadius: '50%', background: us.skill.color, display: 'inline-block' }} />
                    )}
                    {us.skill?.name ?? us.skillId}
                    <strong style={{ color: 'var(--text-2)' }}>{us.level}</strong>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          {agent && (
            <>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={toggleStatus}>
                {agent.status === 'ACTIVE' ? t('agents.suspend') : t('agents.reactivate')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={remove}
                style={{ color: 'var(--danger, #f85149)' }}
              >
                {t('common:delete')}
              </button>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            {t('common:cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? t('common:saving') : t('common:save')}
          </button>
        </div>
      </div>
      {/* Édition des skills : même dialogue que les users (recherche par
          catégorie, niveau par palier ou numérique selon les réglages org). */}
      {skillsOpen && agent && (
        <UserSkillsDialog
          user={{ id: agent.id, name: agent.name, email: '' }}
          adminOrLeadEdit
          isSelf={false}
          onClose={() => {
            setSkillsOpen(false);
            void reloadSkills();
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modale jeton — secret montré UNE seule fois
// ---------------------------------------------------------------------------

function TokenModal({ agentName, token, onClose }: { agentName: string; token: string; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      /* clipboard indisponible : l'utilisateur sélectionne à la main */
    }
  };
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'grid', placeItems: 'center', zIndex: 1100, padding: 16,
      }}
    >
      <div
        style={{
          width: '100%', maxWidth: 560, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-lg, 14px)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)', padding: 20,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15 }}>{t('agents.tokenModalTitle', { name: agentName })}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('agents.tokenModalBlurb')}</div>
        <code
          style={{
            fontFamily: 'var(--mono, monospace)', fontSize: 12.5, wordBreak: 'break-all',
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '10px 12px', userSelect: 'all',
          }}
        >
          {token}
        </code>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={copy}>
            {copied ? t('agents.copied') : t('agents.copy')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t('common:close')}
          </button>
        </div>
      </div>
    </div>
  );
}

