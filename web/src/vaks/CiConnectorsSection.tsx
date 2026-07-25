import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type CiConnectorDto } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { fromCiProvider, type CiProviderDescriptorDto, type NormalizedProvider } from './connectors/types';
import { draftToPayload, emptyDraftFor, type DraftState } from './connectors/draft';
import ConnectorCard from './connectors/ConnectorCard';
import ConnectorDraftForm from './connectors/ConnectorDraftForm';
import ProviderPickerModal from './connectors/ProviderPickerModal';

type Flash = (msg: string) => void;

/** URL du webhook entrant à configurer côté CI (origine courante + provider). */
function webhookUrl(provider: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/v1/webhooks/ci/${provider}`;
}

/**
 * Section « CI verification » (groupe Integrations) — vérification des livrables
 * agents, phase C. Détient le secret partagé HMAC qui authentifie les résultats
 * CI SIGNÉS poussés vers `POST /webhooks/ci/:provider`. vaks-pm ne se connecte à
 * aucun CI : il vérifie une signature. Un connecteur par provider (github /
 * generic), secret write-only chiffré at-rest. Construit sur les primitives
 * partagées `connectors/` (le champ secret est synthétisé côté client — l'API
 * providers CI ne décrit pas de champs).
 */
export default function CiConnectorsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [providers, setProviders] = useState<NormalizedProvider[]>([]);
  const [items, setItems] = useState<CiConnectorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [provs, list] = await Promise.all([api.listCiConnectorProviders(), api.listCiConnectors()]);
      setProviders(
        (provs as CiProviderDescriptorDto[]).map((p) =>
          fromCiProvider(p, {
            secretLabel: t('ci.secretField'),
            secretHelp: t('ci.secretHelp'),
            secretPlaceholder: t('ci.secretPlaceholder'),
          }),
        ),
      );
      setItems(list);
    } catch (e) {
      flash(t('ci.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const provByKey = useMemo(() => {
    const m = new Map<string, NormalizedProvider>();
    for (const p of providers) m.set(p.key, p);
    return m;
  }, [providers]);

  /** Providers pas encore configurés (un connecteur par provider). */
  const available = useMemo(
    () => providers.filter((p) => !items.some((c) => c.provider === p.key)),
    [providers, items],
  );

  const activeDesc = draft ? provByKey.get(draft.providerKey) : undefined;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    // L'API CI attend un `secret` scalaire (pas la map `secrets` des autres familles).
    const core = draftToPayload(draft);
    const payload = {
      ...(draft.id ? {} : { provider: draft.providerKey }),
      label: core.label,
      enabled: core.enabled,
      ...(core.secrets?.secret ? { secret: core.secrets.secret } : {}),
    };
    try {
      if (draft.id) await api.updateCiConnector(draft.id, payload);
      else await api.createCiConnector(payload);
      flash(t('ci.saved'));
      setDraft(null);
      await load();
    } catch (e) {
      flash(t('ci.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: CiConnectorDto) => {
    if (
      !(await confirm({
        title: t('common:delete'),
        message: t('ci.confirmDelete', { name: c.label }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteCiConnector(c.id);
      flash(t('ci.deleted'));
      await load();
    } catch (e) {
      flash(t('ci.actionFailed', { message: (e as Error).message }));
    }
  };

  const copyUrl = async (provider: string) => {
    try {
      await navigator.clipboard.writeText(webhookUrl(provider));
      flash(t('ci.urlCopied'));
    } catch {
      /* clipboard indispo — l'URL reste sélectionnable à l'écran */
    }
  };

  const startEdit = (c: CiConnectorDto) => {
    setDraft({
      id: c.id,
      providerKey: c.provider,
      label: c.label,
      enabled: c.enabled,
      config: {},
      secrets: {},
      secretsConfigured: c.secretConfigured ? ['secret'] : [],
    });
  };

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('ci.blurb')}</div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          {items.length === 0 && !draft && (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('ci.empty')}</div>
          )}

          {items.map((c) => {
            const desc = provByKey.get(c.provider);
            const signatureHeader = desc?.meta?.signatureHeader as string | undefined;
            return (
              <ConnectorCard
                key={c.id}
                title={c.label}
                provider={desc ?? { key: c.provider, label: c.provider }}
                providerLabel={desc?.label ?? c.provider}
                status={{ on: c.enabled, onLabel: t('ci.statusActive'), offLabel: t('ci.statusDisabled') }}
                warnPill={
                  !c.secretConfigured
                    ? t('ci.noSecret')
                    : c.lastEventOk === false
                      ? t('ci.lastEventFailed')
                      : undefined
                }
                actions={[
                  { key: 'edit', label: t('common:edit'), onClick: () => startEdit(c) },
                  { key: 'delete', label: t('common:delete'), onClick: () => remove(c), danger: true },
                ]}
                meta={
                  <>
                    {/* URL du webhook à coller côté CI + en-tête de signature attendu. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <code
                        style={{
                          fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)',
                          padding: '3px 7px', borderRadius: 6, overflowWrap: 'anywhere',
                        }}
                      >
                        {webhookUrl(c.provider)}
                      </code>
                      <button className="btn btn-ghost" onClick={() => copyUrl(c.provider)} style={{ fontSize: 12 }}>
                        <Icon name="link" size={13} /> {t('ci.copyUrl')}
                      </button>
                      {signatureHeader && (
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {t('ci.signatureHeader', { header: signatureHeader })}
                        </span>
                      )}
                    </div>
                    {c.lastEventAt && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                        {t('ci.lastEvent', { date: new Date(c.lastEventAt).toLocaleString() })}
                        {c.lastEventError ? ` — ${c.lastEventError}` : ''}
                      </div>
                    )}
                  </>
                }
              />
            );
          })}

          {draft && activeDesc && (
            <ConnectorDraftForm
              provider={activeDesc}
              draft={draft}
              setDraft={(fn) => setDraft((d) => (d ? fn(d) : d))}
              saving={saving}
              onCancel={() => setDraft(null)}
              onSave={save}
              isEdit={!!draft.id}
              labels={{
                editTitle: t('ci.editTitle', { name: activeDesc.label }),
                newTitle: t('ci.newTitle', { name: activeDesc.label }),
                labelField: t('ci.labelField'),
                enableField: t('ci.enableField'),
              }}
            />
          )}

          {/* Ajout : picker cherchable (un connecteur par provider → filtré). */}
          {!draft && available.length > 0 && (
            <div>
              <button
                className="btn btn-ghost"
                onClick={() => setPicking(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="plus" size={15} /> {t('ci.addButton')}
              </button>
            </div>
          )}
        </>
      )}

      {picking && (
        <ProviderPickerModal
          providers={available}
          onPick={(p) => {
            setDraft(emptyDraftFor(p, { enabled: true }));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
