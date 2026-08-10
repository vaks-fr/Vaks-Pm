import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDto,
  AgentCredentialDto,
  AgentRunSummaryDto,
  AgentTrustLevel,
  CreateAgentDto,
  ModelCatalogEntryDto,
  UserDto,
  UserSkillDto,
} from '@vaks-pm/shared';
import {
  AGENT_TRUST_LEVELS,
  KNOWN_AGENT_MODELS,
  permissionsForCapabilities,
  billingUnitForProvider,
} from '@vaks-pm/shared';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { UserSkillsDialog } from './TeamView';
import { ProviderLogo, brandOf } from './agent-providers';

type Flash = (msg: string) => void;

/** Étapes du wizard de création (dans l'ordre). */
const WIZARD_STEPS = ['provider', 'model', 'caps', 'cost'] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];
/** Onglets de la fiche à l'édition. */
const EDIT_TABS = ['model', 'access', 'caps', 'cost', 'tokens', 'skills'] as const;
type EditTab = (typeof EDIT_TABS)[number];

/**
 * Fiche agent — **wizard à la création** (Provider → Modèle+accès → Capacités →
 * Coût/hosting → Créer, façon « Add a tool » de Copilot) et **onglets à
 * l'édition** (comme la carte projet). Jetons et Skills ne sont disponibles
 * qu'à l'édition (ils exigent que l'agent existe).
 */
export function AgentEditorModal({
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
  const isEdit = !!agent;

  const [name, setName] = useState(agent?.name ?? '');
  const [ownerId, setOwnerId] = useState(agent?.ownerId ?? '');
  const [ownerSearch, setOwnerSearch] = useState('');
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [trustLevel, setTrustLevel] = useState<AgentTrustLevel>(agent?.trustLevel ?? 'DRAFT_ONLY');
  const [caps, setCaps] = useState<string[]>(agent?.capabilities ?? ['read:project']);
  const [modelProvider, setModelProvider] = useState(agent?.modelProvider ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [modelMode, setModelMode] = useState<'known' | 'custom'>(() => {
    const known = KNOWN_AGENT_MODELS.some(
      (m) => m.provider === (agent?.modelProvider ?? '') && m.model === (agent?.model ?? ''),
    );
    return agent?.model && !known ? 'custom' : 'known';
  });
  const [providerSearch, setProviderSearch] = useState('');
  // Catalogue de modèles (DB via API : seed air-gap + sync OpenRouter). Fallback
  // sur le catalogue embarqué shared si l'API échoue (le picker reste utilisable).
  const [catalog, setCatalog] = useState<ModelCatalogEntryDto[]>(() =>
    KNOWN_AGENT_MODELS.map((m) => ({
      provider: m.provider, model: m.model, label: m.label,
      unit: m.unit ?? billingUnitForProvider(m.provider),
      costInPerKUnits: m.suggestedCostInPerKTokens ?? null,
      costOutPerKUnits: m.suggestedCostOutPerKTokens ?? null,
      source: 'builtin',
    })),
  );
  const [hostingRegion, setHostingRegion] = useState(agent?.hostingRegion ?? '');
  const [maxConcurrent, setMaxConcurrent] = useState<string>(agent?.maxConcurrentTasks?.toString() ?? '');
  const [dailyRuns, setDailyRuns] = useState<string>(agent?.dailyRunBudget?.toString() ?? '');
  const [costInPerK, setCostInPerK] = useState<string>(agent?.costRateInPerKTokens?.toString() ?? '');
  const [costOutPerK, setCostOutPerK] = useState<string>(agent?.costRateOutPerKTokens?.toString() ?? '');
  const [billPerK, setBillPerK] = useState<string>(agent?.defaultBillRatePerKTokens?.toString() ?? '');
  const [followCatalog, setFollowCatalog] = useState<boolean>(agent?.followCatalogPricing ?? false);
  const [dailyCost, setDailyCost] = useState<string>(agent?.dailyCostBudget?.toString() ?? '');
  const [monthlyCost, setMonthlyCost] = useState<string>(agent?.monthlyCostBudget?.toString() ?? '');
  const [tokens, setTokens] = useState(agent?.tokens ?? []);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<AgentRunSummaryDto | null>(null);
  const [agentSkills, setAgentSkills] = useState<UserSkillDto[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [credentials, setCredentials] = useState<AgentCredentialDto[]>([]);
  const [newCredSecret, setNewCredSecret] = useState<string | null>(null);

  // Navigation : étape (création) ou onglet (édition).
  const [step, setStep] = useState<WizardStep>('provider');
  const [tab, setTab] = useState<EditTab>('model');

  useEffect(() => {
    if (!agent) return;
    let alive = true;
    api.getAgentRuns(agent.id).then((u) => alive && setUsage(u), () => undefined);
    api.listUserSkills(agent.id).then((us) => alive && setAgentSkills(us), () => undefined);
    api.listAgentCredentials(agent.id).then((c) => alive && setCredentials(c), () => undefined);
    return () => { alive = false; };
  }, [agent]);

  // Catalogue de modèles depuis l'API (seed air-gap + sync OpenRouter). Bascule
  // en mode « Autre modèle » si l'agent porte un modèle absent du catalogue.
  useEffect(() => {
    let alive = true;
    api.getModelCatalog().then((c) => {
      if (!alive || !c.entries?.length) return;
      setCatalog(c.entries);
      // Détermine le mode une fois le vrai catalogue chargé (dans les deux sens).
      if (agent?.model) {
        const known = c.entries.some((e) => e.provider === agent.modelProvider && e.model === agent.model);
        setModelMode(known ? 'known' : 'custom');
      }
    }, () => undefined);
    return () => { alive = false; };
  }, [agent]);

  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(i18n.language) : '—');
  const toggleCap = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const modelOptions = catalog.filter(
    (m) => !modelProvider.trim() || m.provider === modelProvider.trim(),
  );
  const isCredits = billingUnitForProvider(modelProvider.trim() || null) === 'credits';
  const applyModel = (val: string) => {
    setModel(val);
    const entry = catalog.find(
      (m) => m.model === val && (!modelProvider.trim() || m.provider === modelProvider.trim()),
    );
    if (!entry) return;
    if (!modelProvider.trim()) setModelProvider(entry.provider);
    if (!costInPerK.trim() && entry.costInPerKUnits != null) setCostInPerK(String(entry.costInPerKUnits));
    if (!costOutPerK.trim() && entry.costOutPerKUnits != null) setCostOutPerK(String(entry.costOutPerKUnits));
  };

  const save = async (): Promise<boolean> => {
    if (!name.trim() || !ownerId) {
      flash(t('agents.nameOwnerRequired'));
      return false;
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
      costRateOutPerKTokens: isCredits ? null : costOutPerK.trim() ? Number(costOutPerK) : null,
      defaultBillRatePerKTokens: billPerK.trim() ? Number(billPerK) : null,
      followCatalogPricing: followCatalog,
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
      return true;
    } catch (e) {
      flash(t('agents.saveFailed', { message: (e as Error).message }));
      return false;
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
    if (!(await confirm({ title: t('agents.revokeToken'), message: t('agents.confirmRevokeToken', { name: agent.name }), confirmLabel: t('agents.revokeToken'), danger: true }))) return;
    try {
      await api.revokeAgentToken(agent.id, tokenId);
      setTokens((prev) => prev.filter((x) => x.id !== tokenId));
      flash(t('agents.tokenRevoked'));
      await onChanged();
    } catch (e) {
      flash(t('agents.actionFailed', { message: (e as Error).message }));
    }
  };

  const issueCredential = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      const r = await api.issueAgentCredential(agent.id, {});
      setNewCredSecret(r.secret);
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
    if (!(await confirm({ title: t('common:delete'), message: t('agents.confirmDelete', { name: agent.name }), confirmLabel: t('common:delete'), danger: true }))) return;
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

  // ---------- Fragments réutilisés (wizard + onglets) ----------

  const catalogProviders = [...new Set(catalog.map((c) => c.provider))];
  const providersFiltered = catalogProviders.filter(
    (p) => !providerSearch.trim() || brandOf(p).label.toLowerCase().includes(providerSearch.trim().toLowerCase()),
  );

  const providerGrid = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ position: 'relative' }}>
        <Icon name="search" size={15} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }} />
        <input
          className="td-in"
          style={{ width: '100%', paddingLeft: 32 }}
          placeholder={t('agents.providerSearch')}
          value={providerSearch}
          onChange={(e) => setProviderSearch(e.target.value)}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
        {providersFiltered.map((p) => {
          const on = modelMode === 'known' && modelProvider === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => { setModelMode('known'); setModelProvider(p); setModel(''); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
                cursor: 'pointer', textAlign: 'left',
                border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                background: on ? 'color-mix(in oklch, var(--accent) 12%, var(--surface))' : 'var(--surface)',
              }}
            >
              <ProviderLogo provider={p} size={24} />
              <span style={{ fontWeight: 600, fontSize: 13, color: on ? 'var(--accent)' : 'var(--text-1)' }}>{brandOf(p).label}</span>
              {on && <Icon name="check" size={15} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setModelMode('custom')}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10,
            cursor: 'pointer', textAlign: 'left',
            border: '1px dashed ' + (modelMode === 'custom' ? 'var(--accent)' : 'var(--border)'),
            background: modelMode === 'custom' ? 'color-mix(in oklch, var(--accent) 12%, var(--surface))' : 'var(--surface)',
          }}
        >
          <span style={{ width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: 'var(--text-2)' }}>
            <Icon name="plus" size={15} />
          </span>
          <span style={{ fontWeight: 600, fontSize: 13, color: modelMode === 'custom' ? 'var(--accent)' : 'var(--text-1)' }}>{t('agents.modelCustom')}</span>
          {modelMode === 'custom' && <Icon name="check" size={15} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
        </button>
      </div>
    </div>
  );

  const modelSelect = modelMode === 'custom' ? (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      {field(t('agents.modelProviderField'), <input className="td-in" value={modelProvider} placeholder="anthropic" onChange={(e) => setModelProvider(e.target.value)} />)}
      {field(t('agents.modelFieldCustom'), <input className="td-in" value={model} placeholder="claude-sonnet-5" onChange={(e) => setModel(e.target.value)} />)}
    </div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="row gap1" style={{ alignItems: 'center' }}>
        {modelProvider && <ProviderLogo provider={modelProvider} size={18} />}
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {modelProvider ? brandOf(modelProvider).label : t('agents.modelPickProviderFirst')}
        </span>
      </div>
      <select className="td-in" value={model} disabled={!modelProvider} onChange={(e) => applyModel(e.target.value)} style={{ width: '100%' }}>
        <option value="">{modelProvider ? t('agents.modelPickModel') : t('agents.modelPickProviderFirst')}</option>
        {modelOptions.map((m) => (<option key={`${m.provider}/${m.model}`} value={m.model}>{m.label}</option>))}
      </select>
    </div>
  );

  const ownerPicker = (() => {
    const ownerList = users.filter((u) => u.status !== 'SUSPENDED');
    const selectedOwner = ownerList.find((u) => u.id === ownerId);
    const q = ownerSearch.trim().toLowerCase();
    const matched = q ? ownerList.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q)) : ownerList;
    const shown = matched.slice(0, 10);
    const extra = matched.length - shown.length;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t('agents.ownerField')}</span>
        <div style={{ position: 'relative' }}>
          <input
            className="td-in"
            style={{ width: '100%' }}
            value={ownerOpen ? ownerSearch : selectedOwner ? `${selectedOwner.name} — ${selectedOwner.email}` : ''}
            placeholder={t('agents.ownerSearchPlaceholder')}
            onFocus={() => { setOwnerOpen(true); setOwnerSearch(''); }}
            onChange={(e) => { setOwnerSearch(e.target.value); setOwnerOpen(true); }}
            onBlur={() => window.setTimeout(() => setOwnerOpen(false), 150)}
          />
          {ownerOpen && (
            <div style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, maxHeight: 260, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
              {shown.length === 0 && <div style={{ padding: 8, fontSize: 12.5, color: 'var(--text-3)' }}>{t('agents.ownerNoMatch')}</div>}
              {shown.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setOwnerId(u.id); setOwnerOpen(false); setOwnerSearch(''); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 12.5, border: 'none', background: u.id === ownerId ? 'var(--surface-2)' : 'transparent', color: 'var(--text-1)', cursor: 'pointer' }}
                >
                  <span style={{ fontWeight: 600 }}>{u.name}</span>{' '}
                  <span style={{ color: 'var(--text-3)' }}>— {u.email}</span>
                </button>
              ))}
              {extra > 0 && <div style={{ padding: '6px 10px', fontSize: 11.5, color: 'var(--text-3)' }}>{t('agents.ownerMoreResults', { count: extra })}</div>}
            </div>
          )}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('agents.ownerHelp')}</span>
      </div>
    );
  })();

  const identityFrag = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {field(t('agents.nameField'), <input className="td-in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />)}
      {ownerPicker}
      {field(
        t('agents.trustField'),
        <select className="td-in" value={trustLevel} onChange={(e) => setTrustLevel(e.target.value as AgentTrustLevel)} style={{ width: '100%' }}>
          {AGENT_TRUST_LEVELS.map((l) => (<option key={l} value={l}>{t(`agents.trust.${l}`)}</option>))}
        </select>,
        t('agents.trustHelp'),
      )}
    </div>
  );

  const capsFrag = field(
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
            style={{ fontSize: 12, padding: '4px 10px', border: '1px solid var(--border)', background: on ? 'color-mix(in oklch, var(--accent) 18%, var(--surface))' : 'var(--surface)', color: on ? 'var(--accent)' : 'var(--text-2)' }}
          >
            {c}
          </button>
        );
      })}
    </div>,
    t('agents.capabilitiesHelp'),
  );

  const costFrag = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {field(t('agents.regionField'), <input className="td-in" value={hostingRegion} placeholder="eu" onChange={(e) => setHostingRegion(e.target.value)} />)}
        {field(t('agents.maxConcurrentField'), <input className="td-in" type="number" min={1} value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} />)}
        {field(t('agents.dailyRunsField'), <input className="td-in" type="number" min={1} value={dailyRuns} onChange={(e) => setDailyRuns(e.target.value)} />)}
        {field(t(isCredits ? 'agents.costInPerKCreditsField' : 'agents.costInPerKTokensField'), <input className="td-in" type="number" min={0} step="0.001" placeholder="€" value={costInPerK} onChange={(e) => setCostInPerK(e.target.value)} />)}
        {!isCredits && field(t('agents.costOutPerKTokensField'), <input className="td-in" type="number" min={0} step="0.001" placeholder="€" value={costOutPerK} onChange={(e) => setCostOutPerK(e.target.value)} />)}
        {field(t(isCredits ? 'agents.billPerKCreditsField' : 'agents.billPerKTokensField'), <input className="td-in" type="number" min={0} step="0.001" placeholder="€" value={billPerK} onChange={(e) => setBillPerK(e.target.value)} />)}
        {field(t('agents.dailyCostField'), <input className="td-in" type="number" min={0} step="0.01" placeholder="€" value={dailyCost} onChange={(e) => setDailyCost(e.target.value)} />)}
        {field(t('agents.monthlyCostField'), <input className="td-in" type="number" min={0} step="0.01" placeholder="€" value={monthlyCost} onChange={(e) => setMonthlyCost(e.target.value)} />)}
      </div>
      <div className="row gap2" style={{ alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
        <label className="row gap1" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={followCatalog} onChange={(e) => setFollowCatalog(e.target.checked)} />
          <span>{t('agents.followCatalog')}</span>
        </label>
        {agent?.priceDrift && (
          <span className="pill" style={{ background: 'color-mix(in oklch, #f59e0b 20%, var(--surface))', color: '#b45309', fontSize: 10 }}>{t('agents.driftBadge')}</span>
        )}
        {agent?.catalogPrice && (
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={busy}
            onClick={async () => {
              if (!agent) return;
              setBusy(true);
              try {
                await api.applyAgentCatalogPrice(agent.id);
                if (agent.catalogPrice) {
                  setCostInPerK(String(agent.catalogPrice.costInPerKUnits));
                  setCostOutPerK(agent.catalogPrice.costOutPerKUnits != null ? String(agent.catalogPrice.costOutPerKUnits) : '');
                }
                flash(t('agents.catalogApplied'));
                await onChanged();
              } catch (e) {
                flash((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('agents.applyCatalog')}
          </button>
        )}
      </div>
    </div>
  );

  const tokensFrag = agent ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Jetons API */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.tokensSection')}</span>
          <button className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={issueToken}>
            <Icon name="plus" size={13} /> {t('agents.mintToken')}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
          {t('agents.mintScopesHint')}
          {caps.length > 0 && (
            <> <span style={{ color: 'var(--text-2)' }}>{t('agents.mintScopesPreview')}{' '}
              <code style={{ fontFamily: 'var(--mono, monospace)' }}>{permissionsForCapabilities(caps).join(', ') || '—'}</code>
            </span></>
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
              <button className="btn btn-ghost" onClick={() => revokeToken(tok.id)} style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--danger, #f85149)' }}>{t('agents.revokeToken')}</button>
            </div>
          ))
        )}
      </div>

      {/* Identifiants machine (refresh rotatif) */}
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
                {c.revoked ? (c.reuseDetected ? t('agents.credReuseRevoked') : t('agents.credRevoked')) : t('agents.credRotations', { count: c.rotationCount })}
                {c.lastUsedAt ? ` · ${t('agents.tokenLastUsed', { date: fmtDate(c.lastUsedAt) })}` : ''}
              </span>
              {!c.revoked && (
                <button className="btn btn-ghost" onClick={() => revokeCredential(c.id)} style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--danger, #f85149)' }}>{t('agents.revokeToken')}</button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Usage & coût déclaratif */}
      {usage && (
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
                      <span className="mono" style={{ color: 'var(--text-3)' }}>{(r.tokensIn ?? 0)}/{(r.tokensOut ?? 0)} tok</span>
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
    </div>
  ) : null;

  const skillsFrag = agent ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.skillsSection', { defaultValue: 'Skills' })}</span>
        <button className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSkillsOpen(true)}>
          <Icon name="edit" size={13} /> {t('agents.skillsEdit', { defaultValue: 'Edit skills' })}
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('agents.skillsHint')}</div>
      {agentSkills.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('agents.skillsEmpty', { defaultValue: 'No skill assigned yet.' })}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {agentSkills.map((us) => (
            <span key={us.skillId} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 999, fontSize: 12 }}>
              {us.skill?.color && <i style={{ width: 7, height: 7, borderRadius: '50%', background: us.skill.color, display: 'inline-block' }} />}
              {us.skill?.name ?? us.skillId}
              <strong style={{ color: 'var(--text-2)' }}>{us.level}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  ) : null;

  // ---------- Navigation (wizard / onglets) ----------

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const canNext =
    step === 'provider' ? modelMode === 'custom' || !!modelProvider :
    step === 'model' ? !!name.trim() && !!ownerId :
    true;
  const wizardTitles: Record<WizardStep, string> = {
    provider: t('agents.wizardProvider'),
    model: t('agents.wizardModel'),
    caps: t('agents.wizardCaps'),
    cost: t('agents.wizardCost'),
  };
  const tabTitles: Record<EditTab, string> = {
    model: t('agents.tabModel'),
    access: t('agents.tabAccess'),
    caps: t('agents.tabCaps'),
    cost: t('agents.tabCost'),
    tokens: t('agents.tabTokens'),
    skills: t('agents.tabSkills'),
  };

  const wizardBody: Record<WizardStep, ReactNode> = {
    provider: providerGrid,
    model: <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{modelSelect}{identityFrag}</div>,
    caps: capsFrag,
    cost: costFrag,
  };
  const tabBody: Record<EditTab, ReactNode> = {
    model: <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{providerGrid}{modelSelect}</div>,
    access: identityFrag,
    caps: capsFrag,
    cost: costFrag,
    tokens: tokensFrag,
    skills: skillsFrag,
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', zIndex: 1090, padding: 16 }}
    >
      <div style={{ width: '100%', maxWidth: 640, height: 'min(88vh, 680px)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg, 14px)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {agent ? t('agents.editTitle', { name: agent.name }) : t('agents.newTitle')}
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* Progression (création) ou onglets (édition) */}
        {isEdit ? (
          <div className="row gap1" style={{ flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 4, flexShrink: 0 }}>
            {EDIT_TABS.map((tk) => {
              const on = tab === tk;
              return (
                <button
                  key={tk}
                  type="button"
                  onClick={() => setTab(tk)}
                  style={{ fontSize: 12.5, padding: '6px 10px', border: 'none', borderBottom: '2px solid ' + (on ? 'var(--accent)' : 'transparent'), background: 'transparent', color: on ? 'var(--accent)' : 'var(--text-2)', fontWeight: on ? 600 : 400, cursor: 'pointer' }}
                >
                  {tabTitles[tk]}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="row gap2" style={{ alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
            {WIZARD_STEPS.map((sk, i) => {
              const on = step === sk;
              const done = i < stepIndex;
              return (
                <span key={sk} className="row gap1" style={{ alignItems: 'center', fontSize: 12, color: on ? 'var(--accent)' : done ? 'var(--text-2)' : 'var(--text-3)' }}>
                  <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700, background: on ? 'var(--accent)' : done ? 'var(--surface-2)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--text-2)', border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)') }}>
                    {done ? '✓' : i + 1}
                  </span>
                  {wizardTitles[sk]}
                  {i < WIZARD_STEPS.length - 1 && <span style={{ color: 'var(--text-faint)', marginLeft: 4 }}>›</span>}
                </span>
              );
            })}
          </div>
        )}

        {/* Corps — seule zone qui scrolle ; la fenêtre garde une taille fixe. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          {isEdit ? tabBody[tab] : wizardBody[step]}
        </div>

        {/* Footer */}
        {isEdit ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 12, flexShrink: 0 }}>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={toggleStatus}>
              {agent!.status === 'ACTIVE' ? t('agents.suspend') : t('agents.reactivate')}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={remove} style={{ color: 'var(--danger, #f85149)' }}>{t('common:delete')}</button>
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>{t('common:cancel')}</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? t('common:saving') : t('common:save')}</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 12, flexShrink: 0 }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>{t('common:cancel')}</button>
            <span style={{ flex: 1 }} />
            {stepIndex > 0 && (
              <button className="btn btn-ghost" disabled={saving} onClick={() => setStep(WIZARD_STEPS[stepIndex - 1])}>{t('agents.wizardBack')}</button>
            )}
            {stepIndex < WIZARD_STEPS.length - 1 ? (
              <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(WIZARD_STEPS[stepIndex + 1])}>{t('agents.wizardNext')}</button>
            ) : (
              <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? t('common:saving') : t('agents.createButton')}</button>
            )}
          </div>
        )}
      </div>

      {skillsOpen && agent && (
        <UserSkillsDialog
          user={{ id: agent.id, name: agent.name, email: '' }}
          adminOrLeadEdit
          isSelf={false}
          onClose={() => { setSkillsOpen(false); void reloadSkills(); }}
          flash={flash}
        />
      )}
    </div>
  );
}
