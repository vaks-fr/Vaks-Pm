import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { AgentTrustIssuerDto, AgentConnectorDto } from '@vaks-pm/shared';
import { Icon } from './primitives';
import { useConfirm } from './confirm';

type Flash = (msg: string) => void;

/** Brouillon d'émetteur — surensemble éditable du DTO. */
interface Draft {
  id?: string;
  label: string;
  enabled: boolean;
  issuer: string;
  audience: string;
  discoveryUrl: string;
  jwksUri: string;
  jwksJsonText: string;
  algorithms: string;
  subjectClaim: string;
  idpSource: string;
  claimConstraintsText: string;
  requireJti: boolean;
  tokenTtlSec: number;
  autoDeclare: boolean;
  defaultOwnerId: string;
  connectorId: string | null;
}

function emptyDraft(): Draft {
  return {
    label: '',
    enabled: false,
    issuer: '',
    audience: '',
    discoveryUrl: '',
    jwksUri: '',
    jwksJsonText: '',
    algorithms: 'RS256, ES256',
    subjectClaim: 'sub',
    idpSource: '',
    claimConstraintsText: '',
    requireJti: true,
    tokenTtlSec: 3600,
    autoDeclare: false,
    defaultOwnerId: '',
    connectorId: null,
  };
}

function draftFromDto(d: AgentTrustIssuerDto): Draft {
  return {
    id: d.id,
    label: d.label,
    enabled: d.enabled,
    issuer: d.issuer,
    audience: d.audience,
    discoveryUrl: d.discoveryUrl ?? '',
    jwksUri: d.jwksUri ?? '',
    jwksJsonText: '', // jamais renvoyé en clair : vide = inchangé
    algorithms: (d.algorithms ?? []).join(', '),
    subjectClaim: d.subjectClaim,
    idpSource: d.idpSource,
    claimConstraintsText: Object.keys(d.claimConstraints ?? {}).length
      ? JSON.stringify(d.claimConstraints, null, 2)
      : '',
    requireJti: d.requireJti,
    tokenTtlSec: d.tokenTtlSec,
    autoDeclare: d.autoDeclare,
    defaultOwnerId: d.defaultOwnerId ?? '',
    connectorId: d.connectorId ?? null,
  };
}

/**
 * Section « Federated agent identity » (groupe Integrations).
 *
 * Déclare les émetteurs de confiance de la fédération d'identité des agents
 * (RFC 8693) : un agent présente le JWT de sa plateforme (Kubernetes, Entra
 * workload identity, GitHub Actions), on le vérifie contre l'émetteur déclaré,
 * on l'échange contre un jeton court. Aucun secret distribué. Deux voies de
 * création : formulaire complet, ou dérivation depuis un connecteur Entra
 * existant (snapshot pré-rempli, pas héritage).
 */
export default function AgentTrustIssuersSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [items, setItems] = useState<AgentTrustIssuerDto[]>([]);
  const [connectors, setConnectors] = useState<AgentConnectorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, conns] = await Promise.all([
        api.listAgentTrustIssuers(),
        api.listAgentConnectors().catch(() => [] as AgentConnectorDto[]),
      ]);
      setItems(list);
      setConnectors(conns);
    } catch (e) {
      flash(t('trustIssuers.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Connecteurs Entra dont on peut dériver un émetteur. */
  const derivable = connectors.filter((c) => c.provider === 'entra-agent');

  async function deriveFrom(connectorId: string) {
    try {
      const pre = await api.deriveAgentTrustIssuer(connectorId);
      setDraft({ ...emptyDraft(), ...draftFromPartial(pre) });
    } catch (e) {
      flash(t('trustIssuers.deriveFailed', { message: (e as Error).message }));
    }
  }

  function draftFromPartial(p: Partial<AgentTrustIssuerDto>): Partial<Draft> {
    return {
      label: p.label ?? '',
      issuer: p.issuer ?? '',
      audience: p.audience ?? '',
      discoveryUrl: p.discoveryUrl ?? '',
      idpSource: p.idpSource ?? '',
      subjectClaim: p.subjectClaim ?? 'sub',
      defaultOwnerId: p.defaultOwnerId ?? '',
      connectorId: p.connectorId ?? null,
    };
  }

  function buildPayload(d: Draft) {
    const algorithms = d.algorithms.split(',').map((s) => s.trim()).filter(Boolean);
    let claimConstraints: Record<string, unknown> | undefined;
    if (d.claimConstraintsText.trim()) {
      try {
        claimConstraints = JSON.parse(d.claimConstraintsText);
      } catch {
        throw new Error(t('trustIssuers.badConstraintsJson'));
      }
    }
    let jwksJson: unknown | undefined;
    if (d.jwksJsonText.trim()) {
      try {
        jwksJson = JSON.parse(d.jwksJsonText);
      } catch {
        throw new Error(t('trustIssuers.badJwksJson'));
      }
    }
    return {
      label: d.label.trim(),
      enabled: d.enabled,
      issuer: d.issuer.trim(),
      audience: d.audience.trim(),
      discoveryUrl: d.discoveryUrl.trim() || null,
      jwksUri: d.jwksUri.trim() || null,
      ...(jwksJson !== undefined ? { jwksJson } : {}),
      algorithms,
      subjectClaim: d.subjectClaim.trim() || 'sub',
      idpSource: d.idpSource.trim(),
      claimConstraints: claimConstraints ?? {},
      requireJti: d.requireJti,
      tokenTtlSec: d.tokenTtlSec,
      autoDeclare: d.autoDeclare,
      defaultOwnerId: d.defaultOwnerId.trim() || null,
      connectorId: d.connectorId,
    };
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const payload = buildPayload(draft);
      if (draft.id) await api.updateAgentTrustIssuer(draft.id, payload);
      else await api.createAgentTrustIssuer(payload);
      setDraft(null);
      await load();
      flash(t('trustIssuers.saved'));
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function test(id: string) {
    setTesting(id);
    try {
      const r = await api.testAgentTrustIssuer(id);
      flash(r.ok ? t('trustIssuers.testOk', { keys: r.keys }) : t('trustIssuers.testKo', { error: r.error }));
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setTesting(null);
    }
  }

  async function remove(it: AgentTrustIssuerDto) {
    const ok = await confirm({
      title: t('trustIssuers.deleteTitle'),
      message: t('trustIssuers.deleteMsg', { label: it.label }),
      confirmLabel: t('common:delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAgentTrustIssuer(it.id);
      await load();
      flash(t('trustIssuers.deleted'));
    } catch (e) {
      flash((e as Error).message);
    }
  }

  const connLabel = (id?: string | null) =>
    id ? connectors.find((c) => c.id === id)?.label ?? t('trustIssuers.connectorGone') : null;

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('trustIssuers.blurb')}</div>

      {!draft && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => setDraft(emptyDraft())} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="plus" size={14} /> {t('trustIssuers.add')}
          </button>
          {derivable.map((c) => (
            <button key={c.id} className="btn btn-ghost" onClick={() => void deriveFrom(c.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Icon name="zap" size={14} /> {t('trustIssuers.deriveFrom', { label: c.label })}
            </button>
          ))}
        </div>
      )}

      {draft && (
        <IssuerForm
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
          saving={saving}
          connLabel={connLabel(draft.connectorId)}
        />
      )}

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : items.length === 0 && !draft ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('trustIssuers.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((it) => (
            <div key={it.id} className="asection-card" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{it.label}</span>
                <span className="chip" style={{ fontSize: 11, background: it.enabled ? 'var(--ok-bg, #12351f)' : 'var(--surface-2)', color: it.enabled ? 'var(--ok, #3fb950)' : 'var(--text-3)' }}>
                  {it.enabled ? t('trustIssuers.enabled') : t('trustIssuers.disabled')}
                </span>
                {it.connectorId && (
                  <span className="chip" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {t('trustIssuers.viaConnector', { label: connLabel(it.connectorId) })}
                  </span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost" onClick={() => void test(it.id)} disabled={testing === it.id}>
                    {testing === it.id ? t('trustIssuers.testing') : t('trustIssuers.test')}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setDraft(draftFromDto(it))}>{t('common:edit')}</button>
                  <button className="btn btn-ghost" onClick={() => void remove(it)} style={{ color: 'var(--danger, #f85149)' }}>{t('common:delete')}</button>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', wordBreak: 'break-all' }}>
                <code>{it.issuer}</code> · aud <code>{it.audience}</code> · {it.idpSource}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {it.jwksKeyCount > 0 ? t('trustIssuers.jwksStatic', { n: it.jwksKeyCount }) : t('trustIssuers.jwksRemote')}
                {' · '}{it.algorithms.join('/')} · TTL {it.tokenTtlSec}s
                {it.lastUsedAt ? ` · ${t('trustIssuers.lastUsed', { when: new Date(it.lastUsedAt).toLocaleString() })}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{label}</span>
      {children}
      {help && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{help}</span>}
    </label>
  );
}

function IssuerForm({
  draft, setDraft, onSave, onCancel, saving, connLabel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  connLabel: string | null;
}) {
  const { t } = useTranslation('admin');
  const up = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <div className="asection-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {connLabel && (
        <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('trustIssuers.derivedNote', { label: connLabel })}</div>
      )}
      <Field label={t('trustIssuers.labelField')}>
        <input className="td-in" value={draft.label} onChange={(e) => up({ label: e.target.value })} style={{ width: '100%' }} />
      </Field>
      <Field label={t('trustIssuers.issuerField')} help={t('trustIssuers.issuerHelp')}>
        <input className="td-in" value={draft.issuer} onChange={(e) => up({ issuer: e.target.value })} style={{ width: '100%' }} placeholder="https://login.microsoftonline.com/<tid>/v2.0" />
      </Field>
      <Field label={t('trustIssuers.audienceField')} help={t('trustIssuers.audienceHelp')}>
        <input className="td-in" value={draft.audience} onChange={(e) => up({ audience: e.target.value })} style={{ width: '100%' }} placeholder="api://vaks-pm/<slug>" />
      </Field>
      <Field label={t('trustIssuers.idpSourceField')} help={t('trustIssuers.idpSourceHelp')}>
        <input className="td-in" value={draft.idpSource} onChange={(e) => up({ idpSource: e.target.value })} style={{ width: '100%' }} placeholder="entra-agent · api · k8s" />
      </Field>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, fontSize: 11.5, color: 'var(--text-3)' }}>{t('trustIssuers.keysSection')}</div>
      <Field label={t('trustIssuers.discoveryField')} help={t('trustIssuers.discoveryHelp')}>
        <input className="td-in" value={draft.discoveryUrl} onChange={(e) => up({ discoveryUrl: e.target.value })} style={{ width: '100%' }} placeholder=".../.well-known/openid-configuration" />
      </Field>
      <Field label={t('trustIssuers.jwksUriField')}>
        <input className="td-in" value={draft.jwksUri} onChange={(e) => up({ jwksUri: e.target.value })} style={{ width: '100%' }} />
      </Field>
      <Field label={t('trustIssuers.jwksJsonField')} help={t('trustIssuers.jwksJsonHelp')}>
        <textarea className="td-in" value={draft.jwksJsonText} onChange={(e) => up({ jwksJsonText: e.target.value })} style={{ width: '100%', minHeight: 70, fontFamily: 'monospace', fontSize: 11.5 }} placeholder='{ "keys": [ ... ] }' />
      </Field>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, fontSize: 11.5, color: 'var(--text-3)' }}>{t('trustIssuers.advSection')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label={t('trustIssuers.algorithmsField')}>
          <input className="td-in" value={draft.algorithms} onChange={(e) => up({ algorithms: e.target.value })} style={{ width: '100%' }} />
        </Field>
        <Field label={t('trustIssuers.subjectClaimField')} help={t('trustIssuers.subjectClaimHelp')}>
          <input className="td-in" value={draft.subjectClaim} onChange={(e) => up({ subjectClaim: e.target.value })} style={{ width: '100%' }} />
        </Field>
        <Field label={t('trustIssuers.ttlField')} help={t('trustIssuers.ttlHelp')}>
          <input className="td-in" type="number" min={300} max={3600} value={draft.tokenTtlSec} onChange={(e) => up({ tokenTtlSec: Number(e.target.value) })} style={{ width: '100%' }} />
        </Field>
        <Field label={t('trustIssuers.defaultOwnerField')} help={t('trustIssuers.defaultOwnerHelp')}>
          <input className="td-in" value={draft.defaultOwnerId} onChange={(e) => up({ defaultOwnerId: e.target.value })} style={{ width: '100%' }} placeholder="userId" />
        </Field>
      </div>
      <Field label={t('trustIssuers.constraintsField')} help={t('trustIssuers.constraintsHelp')}>
        <textarea className="td-in" value={draft.claimConstraintsText} onChange={(e) => up({ claimConstraintsText: e.target.value })} style={{ width: '100%', minHeight: 50, fontFamily: 'monospace', fontSize: 11.5 }} placeholder='{ "repository": "org/repo" }' />
      </Field>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        <input type="checkbox" checked={draft.requireJti} onChange={(e) => up({ requireJti: e.target.checked })} />
        {t('trustIssuers.requireJti')}
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        <input type="checkbox" checked={draft.autoDeclare} onChange={(e) => up({ autoDeclare: e.target.checked })} />
        {t('trustIssuers.autoDeclare')}
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => up({ enabled: e.target.checked })} />
        {t('trustIssuers.enableField')}
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? t('common:saving') : t('common:save')}</button>
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>{t('common:cancel')}</button>
      </div>
    </div>
  );
}
