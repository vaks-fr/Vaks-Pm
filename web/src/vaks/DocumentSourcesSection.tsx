import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type FileSourceConnectorDto, type FileSourceProviderDto, type UpsertFileSourceConnectorDto } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { fromFileSourceProvider, type NormalizedProvider } from './connectors/types';
import { draftFromExisting, draftToPayload, emptyDraftFor, type DraftState } from './connectors/draft';
import ConnectorCard from './connectors/ConnectorCard';
import ConnectorDraftForm from './connectors/ConnectorDraftForm';
import ProviderPickerModal from './connectors/ProviderPickerModal';

type Flash = (msg: string) => void;

/** Résultat d'un test de connecteur (`.../:id/test`). */
interface FsTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

/**
 * Section « Document sources » (groupe Integrations) — sources de fichiers
 * externes **autonomes** lues par les agents IA (proxy live, aucune copie).
 * Chaque source est un connecteur chiffré at-rest (Google Drive, S3, WebDAV…),
 * édité via les primitives partagées `connectors/`.
 *
 * ⚠️ **SharePoint n'est PAS ici** : lié à l'identité Teams, sa config vit sous
 * « Collaboration spaces ». Cette section ne montre que les sources à connecteur
 * autonome (filtrées sur `!managedElsewhere`).
 *
 * Embarquée en bas de `CollabSpacesSection` (`embedded`) : en mode embarqué elle
 * ne rend ni carte enveloppe ni intro, et rien tant qu'aucune source autonome
 * n'est disponible (tous les providers `managedElsewhere`).
 */
export default function DocumentSourcesSection({
  flash,
  embedded = false,
}: {
  flash: Flash;
  embedded?: boolean;
}) {
  const { t } = useTranslation(['admin', 'integrations', 'common']);
  const confirm = useConfirm();
  // Descripteurs bruts conservés : ils portent `showIf` (visibilité conditionnelle),
  // perdu par la normalisation. Sert à construire le formulaire filtré.
  const [rawProviders, setRawProviders] = useState<FileSourceProviderDto[]>([]);
  const [providers, setProviders] = useState<NormalizedProvider[]>([]);
  const [items, setItems] = useState<FileSourceConnectorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, FsTestResult>>({});
  const [picking, setPicking] = useState(false);
  // Génération de clé WIF (mode Workload Identity Federation, sans clé de compte de service).
  const [wifGenerating, setWifGenerating] = useState(false);
  const [wifResult, setWifResult] = useState<{ keyId: string; issuer: string; jwks: unknown } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [provs, list] = await Promise.all([
        api.listFileSourceProviders(),
        api.listFileSourceConnectors(),
      ]);
      // SharePoint (managedElsewhere) se configure sous « Collaboration spaces ».
      const standalone = (provs as FileSourceProviderDto[]).filter((p) => !p.managedElsewhere);
      setRawProviders(standalone);
      setProviders(standalone.map(fromFileSourceProvider));
      setItems(list);
    } catch (e) {
      flash(t('admin:docsources.loadFailed', { message: (e as Error).message }));
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

  // Types de sources pas encore configurées (1 connecteur par type / org).
  const available = useMemo(() => {
    const used = new Set(items.map((i) => i.source));
    return providers.filter((p) => !used.has(p.key));
  }, [providers, items]);

  const activeDesc = draft ? descByKey.get(draft.providerKey) : undefined;

  /**
   * Descripteur du formulaire : mêmes champs, moins ceux masqués par `showIf`
   * (ex. la clé de compte de service disparaît en mode WIF, et inversement).
   * La valeur de référence retombe sur le `default` du champ référencé quand la
   * config ne la porte pas — un connecteur créé avant le sélecteur reste correct.
   */
  const formDesc = useMemo(() => {
    if (!draft) return undefined;
    const raw = rawProviders.find((p) => p.source === draft.providerKey);
    if (!raw) return activeDesc;
    const valueOf = (key: string): string => {
      const v = draft.config[key];
      if (typeof v === 'string' && v) return v;
      const d = raw.fields.find((f) => f.key === key)?.default;
      return typeof d === 'string' ? d : '';
    };
    return fromFileSourceProvider({
      ...raw,
      fields: raw.fields.filter((f) => !f.showIf || valueOf(f.showIf.field) === f.showIf.equals),
    });
  }, [draft, rawProviders, activeDesc]);

  // Réinitialise le JWKS fraîchement généré quand on change de connecteur édité.
  useEffect(() => {
    setWifResult(null);
  }, [draft?.id]);

  /** Génère (ou régénère) la paire de clés WIF du connecteur en édition. */
  const generateWif = async () => {
    if (!draft?.id) return;
    setWifGenerating(true);
    try {
      const r = await api.generateFileSourceWifKey(draft.id);
      setWifResult(r);
      setDraft((d) =>
        d
          ? {
              ...d,
              config: { ...d.config, wifKeyId: r.keyId, wifIssuer: r.issuer, wifJwksPublic: JSON.stringify(r.jwks) },
              secretsConfigured: d.secretsConfigured.includes('wifSigningKey')
                ? d.secretsConfigured
                : [...d.secretsConfigured, 'wifSigningKey'],
            }
          : d,
      );
      flash(t('admin:docsources.wif.generated'));
    } catch (e) {
      flash(t('admin:docsources.wif.generateFailed', { message: (e as Error).message }));
    } finally {
      setWifGenerating(false);
    }
  };

  /** Panneau WIF (génération de clé + issuer + JWKS à copier), affiché en mode wif. */
  const wifPanel = () => {
    if (!draft || draft.config.authMode !== 'wif') return null;
    const issuer = wifResult?.issuer ?? (typeof draft.config.wifIssuer === 'string' ? draft.config.wifIssuer : '');
    const jwks = wifResult
      ? JSON.stringify(wifResult.jwks, null, 2)
      : typeof draft.config.wifJwksPublic === 'string'
        ? draft.config.wifJwksPublic
        : '';
    const hasKey = !!wifResult || draft.secretsConfigured.includes('wifSigningKey');
    return (
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('admin:docsources.wif.help')}</div>
        {!draft.id ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('admin:docsources.wif.saveFirst')}</div>
        ) : (
          <>
            <div>
              <button type="button" className="btn btn-ghost" disabled={wifGenerating} onClick={generateWif}>
                {wifGenerating
                  ? t('common:loading')
                  : hasKey
                    ? t('admin:docsources.wif.regenerate')
                    : t('admin:docsources.wif.generate')}
              </button>
            </div>
            {issuer && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t('admin:docsources.wif.issuer')}</span>
                <input className="td-in" readOnly value={issuer} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%' }} />
              </label>
            )}
            {jwks && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{t('admin:docsources.wif.jwks')}</span>
                <textarea
                  className="td-in"
                  readOnly
                  rows={6}
                  value={jwks}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
                />
              </label>
            )}
          </>
        )}
      </div>
    );
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: UpsertFileSourceConnectorDto = {
        ...(draft.id ? {} : { source: draft.providerKey }),
        ...draftToPayload(draft),
      };
      if (draft.id) {
        await api.updateFileSourceConnector(draft.id, payload);
        flash(t('integrations:connectors.updated'));
      } else {
        await api.createFileSourceConnector(payload);
        flash(t('integrations:connectors.created'));
      }
      setDraft(null);
      await load();
    } catch (e) {
      flash(t('integrations:connectors.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (c: FileSourceConnectorDto) => {
    try {
      await api.updateFileSourceConnector(c.id, { enabled: !c.enabled });
      flash(!c.enabled ? t('integrations:connectors.enabled') : t('integrations:connectors.disabled'));
      await load();
    } catch (e) {
      flash(t('integrations:connectors.toggleFailed', { message: (e as Error).message }));
    }
  };

  const remove = async (c: FileSourceConnectorDto) => {
    if (
      !(await confirm({
        title: t('common:delete'),
        message: t('integrations:connectors.confirmDelete', { name: c.label }),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteFileSourceConnector(c.id);
      flash(t('integrations:connectors.deleted'));
      await load();
    } catch (e) {
      flash(t('integrations:connectors.deleteFailed', { message: (e as Error).message }));
    }
  };

  const test = async (c: FileSourceConnectorDto) => {
    try {
      const r = await api.testFileSourceConnector(c.id);
      setTestResult((prev) => ({ ...prev, [c.id]: r }));
      flash(r.ok ? t('integrations:connectors.testOk') : t('integrations:connectors.testIssues'));
      await load(); // rafraîchit lastTestAt/Ok
    } catch (e) {
      flash(t('integrations:connectors.testFailed', { message: (e as Error).message }));
    }
  };

  // Embarqué : rien à afficher tant qu'aucune source autonome n'est disponible.
  if (embedded && !loading && providers.length === 0 && !draft) return null;

  const body = (
    <>
      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          {embedded && (
            <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4, color: 'var(--text-2)' }}>
              {t('admin:docsources.embeddedHeading')}
            </div>
          )}

          {items.length === 0 && !draft && (
            <div style={{ color: 'var(--text-3)', fontSize: 13, lineHeight: 1.5 }}>
              {t('admin:docsources.emptyIndependent')}
            </div>
          )}

          {items.map((c) => {
            const desc = descByKey.get(c.source);
            const tr = testResult[c.id];
            return (
              <ConnectorCard
                key={c.id}
                title={c.label}
                provider={desc}
                providerLabel={desc?.label ?? c.source}
                status={{
                  on: c.enabled,
                  onLabel: t('admin:docsources.statusEnabled'),
                  offLabel: t('admin:docsources.statusDisabled'),
                }}
                warnPill={c.lastTestOk === false ? t('integrations:connectors.lastTestFailed') : undefined}
                actions={[
                  { key: 'test', label: t('integrations:connectors.test'), onClick: () => test(c) },
                  {
                    key: 'toggle',
                    label: c.enabled ? t('integrations:connectors.disable') : t('integrations:connectors.enable'),
                    onClick: () => toggleEnabled(c),
                  },
                  { key: 'edit', label: t('common:edit'), onClick: () => setDraft(draftFromExisting(c, c.source)) },
                  { key: 'delete', label: t('common:delete'), onClick: () => remove(c), danger: true },
                ]}
              >
                {tr && (
                  <div style={{ fontSize: 12, color: tr.ok ? 'var(--ok, #3fb950)' : 'var(--danger, #f85149)' }}>
                    {tr.ok ? tr.detail ?? t('integrations:connectors.testOk') : tr.error ?? t('integrations:connectors.testIssues')}
                  </div>
                )}
              </ConnectorCard>
            );
          })}

          {draft && formDesc && (
            <ConnectorDraftForm
              showSecretExpiry
              provider={formDesc}
              draft={draft}
              setDraft={(fn) => setDraft((d) => (d ? fn(d) : d))}
              saving={saving}
              onCancel={() => setDraft(null)}
              onSave={save}
              isEdit={!!draft.id}
              extraFields={wifPanel()}
              labels={{
                editTitle: t('admin:docsources.editTitle', { name: formDesc.label }),
                newTitle: t('admin:docsources.editTitle', { name: formDesc.label }),
                labelField: t('integrations:connectors.labelField'),
                enableField: t('admin:docsources.enableField'),
              }}
            />
          )}

          {!draft && (
            <div>
              <button
                className="btn btn-ghost"
                onClick={() => setPicking(true)}
                disabled={available.length === 0}
                title={available.length === 0 ? t('integrations:connectors.allConfigured') : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="plus" size={15} /> {t('integrations:connectors.addButton')}
              </button>
            </div>
          )}
        </>
      )}

      {picking && (
        <ProviderPickerModal
          providers={available}
          onPick={(p) => {
            setPicking(false);
            setDraft(emptyDraftFor(p));
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );

  // Embarqué : rendu inline (la carte enveloppe est celle de CollabSpacesSection).
  if (embedded) return body;

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('admin:docsources.blurb')}</div>
      {body}
    </div>
  );
}
