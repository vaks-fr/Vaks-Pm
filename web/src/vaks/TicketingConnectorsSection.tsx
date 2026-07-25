import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ConnectorProviderDescriptorDto,
  ConnectorTestResultDto,
  TicketingConnectorDto,
  UpsertTicketingConnectorDto,
} from '@vaks-pm/shared';
import { api, type ApiTokenDto } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { fromTicketingProvider, type NormalizedProvider } from './connectors/types';
import { draftFromExisting, draftToPayload, emptyDraftFor, type DraftState } from './connectors/draft';
import ConnectorCard from './connectors/ConnectorCard';
import ConnectorDraftForm from './connectors/ConnectorDraftForm';
import ProviderPickerModal from './connectors/ProviderPickerModal';
import InboundConnectorCard from './connectors/InboundConnectorCard';

type Flash = (msg: string) => void;

/** Clé synthétique du « provider » inbound dans le picker (pas un vrai connecteur). */
const INBOUND_TIMEOFF_KEY = '__inbound_timeoff_sync';
/** Convention de nommage des clés org de cette carte. */
const INBOUND_TIMEOFF_PREFIX = 'inbound:timeoff-sync:';
/** Scopes FIXES de la clé RH (moindre privilège : absences uniquement). */
const INBOUND_TIMEOFF_SCOPES = ['timeoff:write'];

/**
 * Section « External connectors » (groupe Integrations) : connecteurs de
 * ticketing sortants (ServiceNow, …) + carte inbound « sync RH / absences »
 * (un SIRH pousse les congés via une clé org scopée `timeoff:write`).
 * Construit sur les primitives partagées `connectors/`.
 */
export default function TicketingConnectorsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('integrations');
  const confirm = useConfirm();
  const [providers, setProviders] = useState<NormalizedProvider[]>([]);
  const [items, setItems] = useState<TicketingConnectorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, ConnectorTestResultDto>>({});
  const [picking, setPicking] = useState(false);
  // Carte inbound « sync RH » : jamais affichée d'office — soit des clés
  // existent déjà, soit l'admin l'a ajoutée depuis le picker.
  const [inboundKeys, setInboundKeys] = useState<ApiTokenDto[]>([]);
  const [inboundAdded, setInboundAdded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [provs, list, orgKeys] = await Promise.all([
        api.listConnectorProviders(),
        api.listTicketingConnectors(),
        api.listOrgApiTokens().catch(() => [] as ApiTokenDto[]),
      ]);
      setProviders((provs as ConnectorProviderDescriptorDto[]).map(fromTicketingProvider));
      setItems(list);
      // Filtre purpose + scopes EXACTS (ceinture-bretelles contre une collision
      // de nom avec une clé créée à la main dans « Organization keys »).
      setInboundKeys(
        orgKeys.filter(
          (k) =>
            k.name.startsWith(INBOUND_TIMEOFF_PREFIX) &&
            k.scopes.length === 1 &&
            k.scopes[0] === INBOUND_TIMEOFF_SCOPES[0],
        ),
      );
    } catch (e) {
      flash(t('connectors.loadFailed', { message: (e as Error).message }));
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

  // Types de fournisseurs pas encore configurés (1 connecteur par type / org).
  const available = useMemo(() => {
    const used = new Set(items.map((i) => i.source));
    return providers.filter((p) => !used.has(p.key));
  }, [providers, items]);

  const activeDesc = draft ? descByKey.get(draft.providerKey) : undefined;

  // La carte inbound est visible dès qu'une clé existe, ou après ajout explicite.
  const showInbound = inboundAdded || inboundKeys.length > 0;

  /** Entrée synthétique du picker pour l'API entrante (pas un connecteur sortant). */
  const inboundProvider: NormalizedProvider = useMemo(
    () => ({
      key: INBOUND_TIMEOFF_KEY,
      label: t('connectors.inbound.timeoffSync.title'),
      blurb: t('connectors.inbound.timeoffSync.blurb'),
      accent: '#0fae96',
      short: 'RH',
      fields: [],
    }),
    [t],
  );

  /** Providers proposés : les types non configurés + l'API entrante si pas déjà posée. */
  const pickerProviders = useMemo(
    () => (showInbound ? available : [...available, inboundProvider]),
    [available, showInbound, inboundProvider],
  );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: UpsertTicketingConnectorDto = {
        ...(draft.id ? {} : { source: draft.providerKey }),
        ...draftToPayload(draft),
      };
      if (draft.id) {
        await api.updateTicketingConnector(draft.id, payload);
        flash(t('connectors.updated'));
      } else {
        await api.createTicketingConnector(payload);
        flash(t('connectors.created'));
      }
      setDraft(null);
      await load();
    } catch (e) {
      flash(t('connectors.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (c: TicketingConnectorDto) => {
    try {
      await api.updateTicketingConnector(c.id, { enabled: !c.enabled });
      flash(!c.enabled ? t('connectors.enabled') : t('connectors.disabled'));
      await load();
    } catch (e) {
      flash(t('connectors.toggleFailed', { message: (e as Error).message }));
    }
  };

  const remove = async (c: TicketingConnectorDto) => {
    if (
      !(await confirm({
        title: t('common:delete'),
        message: t('connectors.confirmDelete', { name: c.label }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteTicketingConnector(c.id);
      flash(t('connectors.deleted'));
      await load();
    } catch (e) {
      flash(t('connectors.deleteFailed', { message: (e as Error).message }));
    }
  };

  const test = async (c: TicketingConnectorDto) => {
    try {
      const r = await api.testTicketingConnector(c.id);
      setTestResult((prev) => ({ ...prev, [c.id]: r }));
      flash(r.ok ? t('connectors.testOk') : t('connectors.testIssues'));
      await load(); // rafraîchit lastTestAt/Ok
    } catch (e) {
      flash(t('connectors.testFailed', { message: (e as Error).message }));
    }
  };

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('connectors.intro')}</div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          {/* Liste des connecteurs configurés */}
          {items.length === 0 && !draft && (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('connectors.empty')}</div>
          )}

          {items.map((c) => {
            const desc = descByKey.get(c.source);
            const tr = testResult[c.id];
            return (
              <ConnectorCard
                key={c.id}
                title={c.label}
                providerLabel={desc?.label ?? c.source}
                status={{
                  on: c.enabled,
                  onLabel: t('connectors.statusEnabled'),
                  offLabel: t('connectors.statusDisabled'),
                }}
                warnPill={c.lastTestOk === false ? t('connectors.lastTestFailed') : undefined}
                actions={[
                  { key: 'test', label: t('connectors.test'), onClick: () => test(c) },
                  {
                    key: 'toggle',
                    label: c.enabled ? t('connectors.disable') : t('connectors.enable'),
                    onClick: () => toggleEnabled(c),
                  },
                  { key: 'edit', label: t('common:edit'), onClick: () => setDraft(draftFromExisting(c, c.source)) },
                  { key: 'delete', label: t('common:delete'), onClick: () => remove(c), danger: true },
                ]}
              >
                {tr && (
                  <div style={{ fontSize: 12, color: tr.ok ? 'var(--ok, #3fb950)' : 'var(--danger, #f85149)' }}>
                    {tr.ok ? tr.detail ?? t('connectors.testOk') : tr.error ?? t('connectors.testIssues')}
                  </div>
                )}
              </ConnectorCard>
            );
          })}

          {/* Éditeur (création / édition) */}
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
                editTitle: t('connectors.editTitle', { name: activeDesc.label }),
                newTitle: t('connectors.newTitle', { name: activeDesc.label }),
                labelField: t('connectors.labelField'),
                enableField: t('connectors.enableField'),
              }}
            />
          )}

          {/* Ajout : ouvre la modale de choix du type de fournisseur */}
          {!draft && (
            <div>
              <button
                className="btn btn-ghost"
                onClick={() => setPicking(true)}
                disabled={pickerProviders.length === 0}
                title={pickerProviders.length === 0 ? t('connectors.allConfigured') : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="plus" size={15} /> {t('connectors.addButton')}
              </button>
            </div>
          )}

          {/* ---- Inbound : systèmes externes qui POUSSENT vers Vaks ----
              Ajoutée depuis le picker (ou déjà posée si des clés existent) —
              jamais affichée d'office. Section full-admin (org:manage garanti)
              → endpoints org génériques + convention de nommage. */}
          {showInbound && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4, color: 'var(--text-2)' }}>
                {t('connectors.inboundHeading')}
              </div>
              <InboundConnectorCard
                tile={inboundProvider}
                title={t('connectors.inbound.timeoffSync.title')}
                blurb={t('connectors.inbound.timeoffSync.blurb')}
                endpoints={[
                  { method: 'POST', path: '/api/v1/time-offs/bulk-upsert', desc: t('connectors.inbound.timeoffSync.epBulk') },
                  { method: 'POST', path: '/api/v1/time-offs/import-csv', desc: t('connectors.inbound.timeoffSync.epCsv') },
                ]}
                scopes={INBOUND_TIMEOFF_SCOPES}
                purposePrefix={INBOUND_TIMEOFF_PREFIX}
                keys={inboundKeys}
                onMint={(dto) =>
                  api.createOrgApiToken({
                    name: `${INBOUND_TIMEOFF_PREFIX}${dto.label || dto.expiresAt}`,
                    scopes: INBOUND_TIMEOFF_SCOPES,
                    expiresAt: dto.expiresAt,
                  })
                }
                onRevoke={(id) => api.deleteOrgApiToken(id)}
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
            // simplement sa carte (pas de formulaire de draft).
            if (p.key === INBOUND_TIMEOFF_KEY) {
              setInboundAdded(true);
              return;
            }
            setDraft(emptyDraftFor(p));
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
