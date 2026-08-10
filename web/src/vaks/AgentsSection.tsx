import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDto,
  AgentCredentialDto,
  AgentRunSummaryDto,
  AgentTrustLevel,
  CreateAgentDto,
  ModelCatalogDto,
  UserDto,
  UserSkillDto,
} from '@vaks-pm/shared';
import { AGENT_TRUST_LEVELS, KNOWN_AGENT_MODELS, permissionsForCapabilities, billingUnitForProvider } from '@vaks-pm/shared';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useAuth } from '../auth/AuthContext';
import { AgentEditorModal } from './AgentEditorModal';

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

  // ⚠️ Deps VIDES volontaires. `load` appelle `refreshLicense()` (→ setLicense),
  // ce qui re-render tout consommateur `useAuth` — dont AdminPanel, qui recrée la
  // prop `flash` inline. Si `flash`/`refreshLicense`/`t` étaient dans les deps,
  // `load` changerait d'identité à chaque appel et `useEffect([load])` bouclerait
  // à l'infini (symptôme : liste qui recharge en boucle + rate-limit). On fige
  // donc `load` : les refs capturées au montage suffisent (flash = juste un toast
  // d'erreur, refreshLicense est idempotent). eslint-disable assumé.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, []);

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
// Prix catalogue (Lot 2 AGENT_COST_UNITS) — feed opt-in, mode d'application,
// taux USD→EUR, synchro manuelle. Air-gap : feed off par défaut.
// ---------------------------------------------------------------------------

export function ModelPricingPanel({ flash, onApplied }: { flash: Flash; onApplied?: () => void }) {
  const { t, i18n } = useTranslation('admin');
  const [cat, setCat] = useState<ModelCatalogDto | null>(null);
  const [feedEnabled, setFeedEnabled] = useState(false);
  const [applyMode, setApplyMode] = useState<'off' | 'all' | 'per_agent'>('off');
  const [usdRate, setUsdRate] = useState('0.92');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.getModelCatalog();
      setCat(c);
      setFeedEnabled(c.feedEnabled);
      setApplyMode(c.applyMode);
      setUsdRate(String(c.usdToEurRate));
    } catch {
      /* AI-admin restreint sans accès : panneau simplement absent. */
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!cat) return null;

  const save = async () => {
    setSaving(true);
    try {
      await api.putAgentPolicies({
        'agents.pricing.feedEnabled': feedEnabled,
        'agents.pricing.applyMode': applyMode,
        'agents.pricing.usdToEurRate': Number(usdRate) || 0.92,
      });
      flash(t('agents.pricing.saved'));
      await load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncModelPricing();
      if (!r.enabled) flash(t('agents.pricing.syncDisabled'));
      else if (r.error) flash(t('agents.pricing.syncFailed', { message: r.error }));
      else flash(t('agents.pricing.syncDone', { upserted: r.upserted, applied: r.applied }));
      await load();
      onApplied?.();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const lastSync = cat.lastSyncAt ? new Date(cat.lastSyncAt).toLocaleString(i18n.language) : null;

  return (
    <div style={{ margin: '0 0 12px', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div className="row gap2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('agents.pricing.title')}</span>
        {lastSync && (
          <span className="pill" style={{ fontSize: 10, background: 'var(--surface-2)', color: cat.lastSyncOk === false ? '#b45309' : 'var(--text-3)' }}>
            {cat.lastSyncOk === false
              ? t('agents.pricing.lastSyncFailed')
              : t('agents.pricing.lastSync', { date: lastSync })}
          </span>
        )}
        <button className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} disabled={syncing || !feedEnabled} onClick={sync}>
          <Icon name="refresh" size={13} /> {syncing ? t('agents.pricing.syncing') : t('agents.pricing.syncNow')}
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', margin: '4px 0 8px' }}>{t('agents.pricing.blurb')}</div>
      <div className="row gap2" style={{ alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
        <label className="row gap1" style={{ alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={feedEnabled} onChange={(e) => setFeedEnabled(e.target.checked)} />
          <span>{t('agents.pricing.feedEnabled')}</span>
        </label>
        <label className="row gap1" style={{ alignItems: 'center' }}>
          <span>{t('agents.pricing.applyMode')}</span>
          <select className="td-in" style={{ width: 'auto' }} value={applyMode} onChange={(e) => setApplyMode(e.target.value as 'off' | 'all' | 'per_agent')}>
            <option value="off">{t('agents.pricing.mode.off')}</option>
            <option value="all">{t('agents.pricing.mode.all')}</option>
            <option value="per_agent">{t('agents.pricing.mode.per_agent')}</option>
          </select>
        </label>
        <label className="row gap1" style={{ alignItems: 'center' }} title={t('agents.pricing.usdHint')}>
          <span>{t('agents.pricing.usdRate')}</span>
          <input className="td-in" type="number" min={0.1} max={10} step="0.01" style={{ width: 80 }} value={usdRate} onChange={(e) => setUsdRate(e.target.value)} />
        </label>
        <button className="btn btn-accent btn-sm" disabled={saving} onClick={save}>{t('common:save')}</button>
      </div>
      {/* Mention prestataires tiers / réseau (récupération liste + prix externes). */}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5, maxWidth: 720 }}>
        {t('agents.pricing.externalNotice')}
      </div>
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
        <div className="dir-email mono">{a.email}</div>
        <div className="dir-email">
          {t('agents.owner')} : {a.ownerName ?? a.ownerEmail ?? '—'}
        </div>
      </div>
      <div className="dir-title row gap1" style={{ color: 'var(--text-3)', fontSize: 12.5, alignItems: 'center', flexWrap: 'wrap' }}>
        {a.model ? (
          <span>{a.modelProvider ? `${a.modelProvider}/` : ''}{a.model}</span>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>—</span>
        )}
        {a.billingUnit === 'credits' && (
          <span className="pill" style={{ background: 'var(--surface-2)', color: 'var(--text-3)', fontSize: 10 }}>
            {t('agents.unitCredits')}
          </span>
        )}
        {a.priceDrift && (
          <span className="pill" title={t('agents.driftHint')} style={{ background: 'color-mix(in oklch, #f59e0b 20%, var(--surface))', color: '#b45309', fontSize: 10 }}>
            {t('agents.driftBadge')}
          </span>
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

