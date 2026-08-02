import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentConnectorDto, ConnectorTestResultDto, UserDto } from '@vaks-pm/shared';
import { api, type ApiTokenDto } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import {
  fromAgentProvider,
  type AgentProviderDescriptorDto,
  type NormalizedProvider,
} from './connectors/types';
import { draftFromExisting, draftToPayload, emptyDraftFor, type DraftState } from './connectors/draft';
import ConnectorCard from './connectors/ConnectorCard';
import ConnectorDraftForm from './connectors/ConnectorDraftForm';
import ProviderPickerModal from './connectors/ProviderPickerModal';
import InboundConnectorCard from './connectors/InboundConnectorCard';

type Flash = (msg: string) => void;

/** Clé synthétique du « provider » inbound dans le picker (pas un vrai annuaire). */
const INBOUND_REGISTRATION_KEY = '__inbound_agent_registration';
/** Convention de nommage des clés org de cette carte (miroir du serveur). */
const INBOUND_REGISTRATION_PREFIX = 'inbound:agent-registration:';

/**
 * Section « Agent directories » (groupe Integrations) : importe les identités
 * d'agents IA depuis une plateforme externe (Microsoft Entra Agent ID, …).
 * Construit sur les primitives partagées `connectors/` (picker cherchable,
 * carte, formulaire). Les agents synchronisés arrivent DRAFT_ONLY sans jeton.
 * En bas : carte inbound « enregistrement d'agents » (une plateforme sans
 * connecteur déclare ses agents via `POST /agents` avec une clé dédiée).
 * Autonome : charge sa propre liste d'utilisateurs pour l'owner par défaut.
 */
export default function AgentConnectorsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [providers, setProviders] = useState<NormalizedProvider[]>([]);
  const [items, setItems] = useState<AgentConnectorDto[]>([]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  // Champ hors descripteur : owner humain par défaut des agents importés.
  const [defaultOwnerId, setDefaultOwnerId] = useState('');
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, ConnectorTestResultDto>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // Carte inbound « enregistrement d'agents » : ne s'affiche PAS d'office —
  // soit des clés existent déjà, soit l'admin l'a ajoutée depuis le picker.
  const [inboundKeys, setInboundKeys] = useState<ApiTokenDto[]>([]);
  const [inboundAdded, setInboundAdded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [provs, list, keys] = await Promise.all([
        api.listAgentConnectorProviders(),
        api.listAgentConnectors(),
        api.listAgentRegistrationKeys().catch(() => [] as ApiTokenDto[]),
      ]);
      setProviders((provs as AgentProviderDescriptorDto[]).map(fromAgentProvider));
      setItems(list);
      setInboundKeys(keys);
      // Picker `defaultOwnerId` : chargé à part et tolérant (un « AI administrator »
      // restreint peut ne pas avoir `project:view`) — la section reste utilisable.
      const allUsers = await api.listUsers({ includeAgents: false }).catch(() => []);
      setUsers(allUsers);
    } catch (e) {
      flash(t('agents.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const descByKey = useMemo(() => {
    const m = new Map<string, NormalizedProvider>();
    for (const p of providers) m.set(p.key, p);
    return m;
  }, [providers]);

  const activeDesc = draft ? descByKey.get(draft.providerKey) : undefined;

  // La carte inbound est visible dès qu'une clé existe, ou après ajout explicite.
  const showInbound = inboundAdded || inboundKeys.length > 0;

  /** Entrée synthétique du picker pour l'API entrante (pas un annuaire réel). */
  const inboundProvider: NormalizedProvider = useMemo(
    () => ({
      key: INBOUND_REGISTRATION_KEY,
      label: t('agents.inbound.registration.title'),
      blurb: t('agents.inbound.registration.blurb'),
      accent: '#6d5efc',
      short: 'API',
      fields: [],
    }),
    [t],
  );

  /** Providers proposés : les annuaires réels + l'API entrante si pas déjà posée. */
  const pickerProviders = useMemo(
    () => (showInbound ? providers : [...providers, inboundProvider]),
    [providers, showInbound, inboundProvider],
  );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const payload = {
      ...(draft.id ? {} : { provider: draft.providerKey }),
      ...draftToPayload(draft),
      defaultOwnerId: defaultOwnerId || null,
    };
    try {
      if (draft.id) await api.updateAgentConnector(draft.id, payload);
      else await api.createAgentConnector(payload);
      flash(t('agents.connectorSaved'));
      setDraft(null);
      await load();
    } catch (e) {
      flash(t('agents.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: AgentConnectorDto) => {
    if (
      !(await confirm({
        title: t('common:delete'),
        message: t('agents.confirmDeleteConnector', { name: c.label }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteAgentConnector(c.id);
      flash(t('agents.connectorDeleted'));
      await load();
    } catch (e) {
      flash(t('agents.actionFailed', { message: (e as Error).message }));
    }
  };

  const test = async (c: AgentConnectorDto) => {
    try {
      const r = await api.testAgentConnector(c.id);
      setTestResult((prev) => ({ ...prev, [c.id]: r }));
      flash(r.ok ? t('agents.testOk') : t('agents.testFailedShort'));
    } catch (e) {
      flash(t('agents.actionFailed', { message: (e as Error).message }));
    }
  };

  const sync = async (c: AgentConnectorDto) => {
    setSyncing(c.id);
    try {
      const r = await api.syncAgentConnector(c.id);
      if (r.ok) {
        flash(t('agents.syncDone', { created: r.created, updated: r.updated, suspended: r.suspended }));
        // Débordement du plafond d'agents : le sync n'échoue pas, il rapporte les
        // identités non créées faute de place (freemium).
        if (r.skippedOverLimit && r.skippedOverLimit > 0) {
          flash(
            t('agents.syncOverLimit', {
              defaultValue:
                '{{count}} agent(s) not created — free agent limit reached. Upgrade to add more.',
              count: r.skippedOverLimit,
            }),
          );
        }
      } else {
        flash(t('agents.syncFailed', { message: r.error ?? '?' }));
      }
      await load();
    } catch (e) {
      flash(t('agents.syncFailed', { message: (e as Error).message }));
    } finally {
      setSyncing(null);
    }
  };

  const startEdit = (c: AgentConnectorDto) => {
    setDefaultOwnerId(c.defaultOwnerId ?? '');
    setDraft(draftFromExisting(c, c.provider));
  };

  /** Sélecteur d'owner par défaut — champ propre à cette famille de connecteurs. */
  const ownerField = (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t('agents.defaultOwnerField')}</span>
      <select
        className="td-in"
        value={defaultOwnerId}
        onChange={(e) => setDefaultOwnerId(e.target.value)}
        style={{ width: '100%' }}
      >
        <option value="">{t('agents.ownerPlaceholder')}</option>
        {users
          .filter((u) => u.status !== 'SUSPENDED')
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} — {u.email}
            </option>
          ))}
      </select>
      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('agents.defaultOwnerHelp')}</span>
    </label>
  );

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('agents.connectorsBlurb')}</div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          {items.length === 0 && !draft && (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('agents.connectorsEmpty')}</div>
          )}

          {items.map((c) => {
            const tr = testResult[c.id];
            return (
              <ConnectorCard
                key={c.id}
                title={c.label}
                provider={descByKey.get(c.provider) ?? { key: c.provider, label: c.provider }}
                providerLabel={descByKey.get(c.provider)?.label ?? c.provider}
                status={{ on: c.enabled, onLabel: t('agents.statusActive'), offLabel: t('agents.statusSuspended') }}
                warnPill={c.lastSyncOk === false ? t('agents.lastSyncFailed') : undefined}
                actions={[
                  { key: 'test', label: t('agents.test'), onClick: () => test(c) },
                  {
                    key: 'sync',
                    label: syncing === c.id ? t('agents.syncing') : t('agents.syncNow'),
                    onClick: () => sync(c),
                    disabled: syncing === c.id || !c.enabled,
                  },
                  { key: 'edit', label: t('common:edit'), onClick: () => startEdit(c) },
                  { key: 'delete', label: t('common:delete'), onClick: () => remove(c), danger: true },
                ]}
                meta={
                  c.lastSyncAt ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                      {t('agents.lastSync', { date: new Date(c.lastSyncAt).toLocaleString() })}
                      {c.lastSyncError ? ` — ${c.lastSyncError}` : ''}
                    </div>
                  ) : undefined
                }
              >
                {tr && (
                  <div style={{ fontSize: 12, color: tr.ok ? 'var(--ok, #3fb950)' : 'var(--danger, #f85149)' }}>
                    {tr.ok ? tr.detail ?? t('agents.testOk') : tr.error ?? t('agents.testFailedShort')}
                  </div>
                )}
              </ConnectorCard>
            );
          })}

          {draft && activeDesc && (
            <ConnectorDraftForm
              showSecretExpiry
              provider={activeDesc}
              draft={draft}
              setDraft={(fn) => setDraft((d) => (d ? fn(d) : d))}
              saving={saving}
              onCancel={() => setDraft(null)}
              onSave={save}
              isEdit={!!draft.id}
              labels={{
                editTitle: t('agents.connectorEditTitle', { name: activeDesc.label }),
                newTitle: t('agents.connectorNewTitle', { name: activeDesc.label }),
                labelField: t('agents.connectorLabelField'),
                enableField: t('agents.connectorEnableField'),
              }}
              extraFields={ownerField}
            />
          )}

          {/* Ajout : picker cherchable (plusieurs connecteurs par provider autorisés
              → on ne filtre PAS les providers déjà utilisés, contrairement au ticketing). */}
          {!draft && (
            <div>
              <button
                className="btn btn-ghost"
                onClick={() => setPicking(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="plus" size={15} /> {t('agents.addDirectory')}
              </button>
            </div>
          )}

          {/* ---- Inbound : une plateforme externe déclare ses agents ----
              Ajoutée depuis le picker (ou déjà posée si des clés existent) —
              jamais affichée d'office. Endpoints dédiés `agent:manage` (un
              AI-admin n'a pas org:manage) : scopes hardcodés côté serveur,
              révocation bornée au purpose. */}
          {showInbound && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4, color: 'var(--text-2)' }}>
                {t('agents.inboundHeading')}
              </div>
              <InboundConnectorCard
                tile={inboundProvider}
                title={t('agents.inbound.registration.title')}
                blurb={t('agents.inbound.registration.blurb')}
                endpoints={[
                  { method: 'POST', path: '/api/v1/agents', desc: t('agents.inbound.registration.epRegister') },
                ]}
                scopes={['agent:manage']}
                purposePrefix={INBOUND_REGISTRATION_PREFIX}
                keys={inboundKeys}
                onMint={(dto) => api.createAgentRegistrationKey(dto)}
                onRevoke={(id) => api.revokeAgentRegistrationKey(id)}
                onChanged={load}
                onDismiss={() => setInboundAdded(false)}
                flash={flash}
              />
            </>
          )}
        </>
      )}

      {picking && (
        <ProviderPickerModal
          providers={pickerProviders}
          onPick={(p) => {
            setPicking(false);
            // L'API entrante n'est pas un connecteur à configurer : on révèle
            // simplement sa carte (le formulaire de draft ne la concerne pas).
            if (p.key === INBOUND_REGISTRATION_KEY) {
              setInboundAdded(true);
              return;
            }
            setDefaultOwnerId('');
            setDraft(emptyDraftFor(p));
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
