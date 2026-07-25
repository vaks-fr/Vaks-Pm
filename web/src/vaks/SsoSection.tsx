import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  IdentityProviderDto,
  IdpRoleMapping,
  IdpTestResultDto,
  RoleDto,
  UpsertIdentityProviderDto,
} from '@vaks-pm/shared';
import { api, type ApiTokenDto } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import { useAuth } from '../auth/AuthContext';

/** Durée de vie d'un jeton SCIM = ~2 ans (plafond serveur), moins 1 j de marge. */
const SCIM_TOKEN_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000 - 86_400_000;

type Flash = (msg: string) => void;

/** État d'édition d'un provider (création ou édition d'un existant). */
interface DraftState {
  id: string | null; // null = création
  type: 'OIDC' | 'SAML';
  slug: string;
  displayName: string;
  enabled: boolean;
  // ---- SAML ----
  samlEntryPoint: string;
  samlIssuer: string;
  /** true = l'admin a saisi un entityID custom ; false = identifier généré par défaut. */
  customSamlIssuer: boolean;
  samlIdpCert: string;
  oidcDiscoveryUrl: string;
  /** Tenant Entra (Directory ID, domaine, common…) — pilote la discovery URL. */
  entraTenantId: string;
  /** true = saisie d'une discovery URL custom (IdP non-Entra) au lieu du tenant. */
  customDiscovery: boolean;
  oidcClientId: string;
  /** Mode d'authentification au token endpoint : secret partagé ou certificat. */
  authMode: 'secret' | 'cert';
  /** Saisie write-only ; jamais préremplie depuis le serveur. */
  clientSecret: string;
  /** État serveur : un secret est-il déjà enregistré pour ce provider ? */
  secretConfigured: boolean;
  /** Clé privée PEM (mode certificat) — write-only, jamais préremplie. */
  privateKey: string;
  /** Empreinte du certificat (x5t) — non-secret. */
  certThumbprint: string;
  /** État serveur : une clé privée est-elle déjà enregistrée ? */
  certConfigured: boolean;
  oidcScopes: string;
  jitProvisioning: boolean;
  syncRolesOnLogin: boolean;
  defaultRoleKey: string;
  linkStrategy: 'link' | 'reject';
  /** Clé de rapprochement d'un compte local : 'upn' (défaut, sûr) | 'email'. */
  linkMatchKey: 'upn' | 'email';
  roleMappings: IdpRoleMapping[];
}

/** Indices des mappings dont le `match` est en doublon (vide ignoré). */
function duplicateMappingIdx(mappings: IdpRoleMapping[]): Set<number> {
  const seen = new Map<string, number>();
  const dups = new Set<number>();
  mappings.forEach((m, i) => {
    const key = m.match.trim();
    if (!key) return;
    if (seen.has(key)) {
      dups.add(seen.get(key)!);
      dups.add(i);
    } else {
      seen.set(key, i);
    }
  });
  return dups;
}

const BLANK_DRAFT: DraftState = {
  id: null,
  type: 'OIDC',
  slug: 'entra',
  displayName: 'Microsoft Entra ID',
  enabled: false,
  samlEntryPoint: '',
  samlIssuer: '',
  customSamlIssuer: false,
  samlIdpCert: '',
  oidcDiscoveryUrl: '',
  entraTenantId: '',
  customDiscovery: false,
  oidcClientId: '',
  authMode: 'secret',
  clientSecret: '',
  secretConfigured: false,
  privateKey: '',
  certThumbprint: '',
  certConfigured: false,
  oidcScopes: 'openid, profile, email',
  jitProvisioning: true,
  syncRolesOnLogin: false,
  defaultRoleKey: 'ORG_MEMBER',
  linkStrategy: 'link',
  linkMatchKey: 'upn',
  roleMappings: [],
};

function toDraft(p: IdentityProviderDto): DraftState {
  return {
    id: p.id,
    type: p.type,
    slug: p.slug,
    displayName: p.displayName,
    enabled: p.enabled,
    samlEntryPoint: p.samlEntryPoint ?? '',
    samlIssuer: p.samlIssuer ?? '',
    // Un entityID explicitement enregistré → mode custom ; null → généré.
    customSamlIssuer: !!p.samlIssuer,
    samlIdpCert: p.samlIdpCert ?? '',
    oidcDiscoveryUrl: p.oidcDiscoveryUrl ?? '',
    // Si l'URL existante est une URL Entra → on extrait le tenant et on reste
    // en mode « tenant » ; sinon (URL custom) on passe en mode avancé.
    entraTenantId: tenantFromDiscovery(p.oidcDiscoveryUrl) ?? '',
    customDiscovery: !!(p.oidcDiscoveryUrl && !tenantFromDiscovery(p.oidcDiscoveryUrl)),
    oidcClientId: p.oidcClientId ?? '',
    authMode: p.certAuthConfigured ? 'cert' : 'secret',
    clientSecret: '',
    secretConfigured: p.clientSecretConfigured,
    privateKey: '',
    certThumbprint: p.oidcCertThumbprint ?? '',
    certConfigured: p.certAuthConfigured,
    oidcScopes: (p.oidcScopes ?? []).join(', '),
    jitProvisioning: p.jitProvisioning,
    syncRolesOnLogin: p.syncRolesOnLogin,
    defaultRoleKey: p.defaultRoleKey ?? 'ORG_MEMBER',
    linkStrategy: (p.linkStrategy === 'reject' ? 'reject' : 'link'),
    linkMatchKey: (p.linkMatchKey === 'email' ? 'email' : 'upn'),
    roleMappings: Array.isArray(p.roleMappings) ? p.roleMappings : [],
  };
}

function draftToPayload(d: DraftState): UpsertIdentityProviderDto {
  const payload: UpsertIdentityProviderDto = {
    type: d.type,
    slug: d.slug.trim(),
    displayName: d.displayName.trim(),
    enabled: d.enabled,
    jitProvisioning: d.jitProvisioning,
    syncRolesOnLogin: d.syncRolesOnLogin,
    defaultRoleKey: d.defaultRoleKey || null,
    roleMappings: d.roleMappings
      .map((m) => ({ match: m.match.trim(), roleKey: m.roleKey }))
      .filter((m) => m.match && m.roleKey),
  };
  if (d.type === 'SAML') {
    payload.samlEntryPoint = d.samlEntryPoint.trim() || null;
    // null = identifier généré par défaut côté serveur (URL des métadonnées).
    payload.samlIssuer = d.customSamlIssuer && d.samlIssuer.trim() ? d.samlIssuer.trim() : null;
    payload.samlIdpCert = d.samlIdpCert.trim() || null;
  } else {
    payload.oidcDiscoveryUrl = d.oidcDiscoveryUrl.trim() || null;
    payload.oidcClientId = d.oidcClientId.trim() || null;
    payload.oidcScopes = d.oidcScopes
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (d.authMode === 'cert') {
      // Clé privée envoyée UNIQUEMENT si saisie (sinon inchangée) ; empreinte toujours.
      if (d.privateKey.trim()) payload.oidcPrivateKey = d.privateKey.trim();
      payload.oidcCertThumbprint = d.certThumbprint.trim() || null;
    } else {
      // Secret envoyé UNIQUEMENT si l'utilisateur en a saisi un (sinon inchangé).
      if (d.clientSecret.trim()) payload.oidcClientSecret = d.clientSecret.trim();
    }
  }
  return payload;
}

/** URL de callback à enregistrer côté IdP (par sous-domaine), selon le protocole.
 *  OIDC → redirect_uri ; SAML → ACS (Assertion Consumer Service) URL. */
function callbackUrl(slug: string, type: 'OIDC' | 'SAML' = 'OIDC'): string {
  const s = slug.trim() || 'entra';
  const proto = type === 'SAML' ? 'saml' : 'oidc';
  return `${window.location.origin}/api/v1/auth/${proto}/${s}/callback`;
}

/** URL des métadonnées SP SAML (endpoint XML — sert à l'export fichier). */
function samlMetadataUrl(slug: string): string {
  const s = slug.trim() || 'entra';
  return `${window.location.origin}/api/v1/auth/saml/${s}/metadata`;
}

/** entityID SP par défaut = base de l'endpoint SAML (sans /callback ni /metadata).
 *  Doit matcher `SamlClientService.defaultEntityId` côté serveur. */
function samlEntityId(slug: string): string {
  const s = slug.trim() || 'entra';
  return `${window.location.origin}/api/v1/auth/saml/${s}`;
}

/** Emballe une base64 brute en bloc PEM CERTIFICATE (lignes de 64 car.). */
function pemWrap(b64: string): string {
  const body = b64.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

/**
 * Normalise un fichier de certificat (Entra « Certificate (Base64) » = .cer) en
 * PEM. Gère 3 formats : PEM (en-têtes présents), base64 brut, ou DER binaire.
 */
async function certFileToPem(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  if (text.includes('BEGIN CERTIFICATE')) return text.trim();
  const stripped = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(stripped) && stripped.length > 100) {
    return pemWrap(stripped); // base64 brut
  }
  // DER binaire → base64
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return pemWrap(btoa(bin));
}

/** Discovery URL Entra dérivée du tenant (Directory ID, domaine, common…). */
function entraDiscovery(tenant: string): string {
  const t = tenant.trim();
  return t ? `https://login.microsoftonline.com/${t}/v2.0` : '';
}

/** Extrait le tenant d'une discovery URL Entra (null si URL non-Entra). */
function tenantFromDiscovery(url: string | null): string | null {
  const m = /login\.microsoftonline\.com\/([^/]+)\/v2\.0/i.exec(url ?? '');
  return m ? m[1] : null;
}

export default function SsoSection({ flash, roles }: { flash: Flash; roles: RoleDto[] }) {
  const [items, setItems] = useState<IdentityProviderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, IdpTestResultDto>>({});

  const { t } = useTranslation('integrations');
  const confirm = useConfirm();
  const { hasFeature } = useAuth();
  const ssoLicensed = hasFeature('sso-oidc') || hasFeature('sso-saml');
  const scimLicensed = hasFeature('scim');

  // --- Jeton de provisioning SCIM (clé d'org scopée `scim:provision`) ---------
  const [scimTokens, setScimTokens] = useState<ApiTokenDto[]>([]);
  const [scimSecret, setScimSecret] = useState<string | null>(null);
  const [scimBusy, setScimBusy] = useState(false);

  const loadScim = useCallback(async () => {
    try {
      const all = await api.listOrgApiTokens();
      setScimTokens(all.filter((tok) => !tok.revoked && tok.scopes.includes('scim:provision')));
    } catch {
      /* non bloquant : si la liste échoue, on n'affiche juste pas le statut */
    }
  }, []);

  const issueScimToken = async (rotate: boolean) => {
    setScimBusy(true);
    try {
      // Rotation = révoquer les jetons SCIM existants avant d'en émettre un neuf.
      if (rotate) {
        for (const tok of scimTokens) await api.deleteOrgApiToken(tok.id);
      }
      const created = await api.createOrgApiToken({
        name: 'SCIM provisioning',
        scopes: ['scim:provision'],
        expiresAt: new Date(Date.now() + SCIM_TOKEN_TTL_MS).toISOString(),
      });
      setScimSecret(created.token);
      await loadScim();
      flash(t(rotate ? 'sso.scim.tokenRotated' : 'sso.scim.tokenCreated'));
    } catch (e) {
      flash(t('sso.scim.tokenFailed', { message: (e as Error).message }));
    } finally {
      setScimBusy(false);
    }
  };

  const revokeScimToken = async () => {
    if (
      !(await confirm({
        title: t('sso.scim.revoke'),
        message: t('sso.scim.revokeConfirm'),
        confirmLabel: t('sso.scim.revoke'),
        danger: true,
      }))
    ) {
      return;
    }
    setScimBusy(true);
    try {
      for (const tok of scimTokens) await api.deleteOrgApiToken(tok.id);
      setScimSecret(null);
      await loadScim();
      flash(t('sso.scim.tokenRevoked'));
    } catch (e) {
      flash(t('sso.scim.tokenFailed', { message: (e as Error).message }));
    } finally {
      setScimBusy(false);
    }
  };

  const orgRoles = roles.filter((r) => r.scope === 'ORG');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.listIdentityProviders());
    } catch (e) {
      flash(t('sso.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
    void loadScim();
  }, [load, loadScim]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload = draftToPayload(draft);
      if (draft.id) {
        await api.updateIdentityProvider(draft.id, payload);
        flash(t('sso.providerUpdated'));
      } else {
        await api.createIdentityProvider(payload);
        flash(t('sso.providerCreated'));
      }
      setDraft(null);
      await load();
    } catch (e) {
      flash(t('sso.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (p: IdentityProviderDto) => {
    try {
      await api.updateIdentityProvider(p.id, { enabled: !p.enabled });
      flash(!p.enabled ? t('sso.providerEnabled') : t('sso.providerDisabled'));
      await load();
    } catch (e) {
      flash(t('sso.toggleFailed', { message: (e as Error).message }));
    }
  };

  const remove = async (p: IdentityProviderDto) => {
    if (!(await confirm({ title: t('common:delete'), message: t('sso.confirmDelete', { name: p.displayName }), confirmLabel: t('common:delete'), danger: true }))) {
      return;
    }
    try {
      await api.deleteIdentityProvider(p.id);
      flash(t('sso.providerDeleted'));
      await load();
    } catch (e) {
      flash(t('sso.deleteFailed', { message: (e as Error).message }));
    }
  };

  const test = async (p: IdentityProviderDto) => {
    try {
      const r = await api.testIdentityProvider(p.id);
      setTestResult((prev) => ({ ...prev, [p.id]: r }));
      flash(r.ok ? t('sso.connectionOk') : t('sso.connectionIssues'));
    } catch (e) {
      flash(t('sso.testFailed', { message: (e as Error).message }));
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => flash(t('sso.copied')),
      () => {/* ignore */},
    );
  };

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
        <Trans t={t} i18nKey="sso.intro" components={{ 0: <strong /> }} />
      </div>

      {!ssoLicensed && (
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            border: '1px solid color-mix(in oklch, oklch(0.70 0.14 80) 45%, var(--border))',
            background: 'color-mix(in oklch, oklch(0.70 0.14 80) 14%, var(--surface))',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--text-2)',
          }}
        >
          <span aria-hidden>🔒</span>
          <div>
            <strong>{t('sso.licenseTitle')}</strong>{' '}
            <Trans t={t} i18nKey="sso.licenseBody" components={{ 0: <strong /> }} />
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          {/* Liste des providers */}
          {items.length === 0 && !draft && (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
              {t('sso.noProviders')}
            </div>
          )}
          {items.map((p) => {
            const tr = testResult[p.id];
            return (
              <div
                key={p.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md, 10px)',
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontWeight: 600 }}>{p.displayName}</span>
                  <span className="pill pill-role">{p.type}</span>
                  <span
                    className="pill"
                    style={{
                      background: p.enabled ? 'var(--ok-bg, #1c3329)' : 'var(--surface-2)',
                      color: p.enabled ? 'var(--ok, #3fb950)' : 'var(--text-3)',
                    }}
                  >
                    {p.enabled ? t('sso.enabled') : t('sso.disabled')}
                  </span>
                  {p.type === 'OIDC' && !p.clientSecretConfigured && !p.certAuthConfigured && (
                    <span className="pill" style={{ background: 'var(--surface-2)', color: 'var(--warn, #b45309)' }}>
                      {t('sso.secretMissing')}
                    </span>
                  )}
                  {p.type === 'SAML' && !p.samlIdpCert && (
                    <span className="pill" style={{ background: 'var(--surface-2)', color: 'var(--warn, #b45309)' }}>
                      {t('sso.certificateMissing')}
                    </span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" onClick={() => test(p)} style={{ fontSize: 12 }}>
                      {t('sso.test')}
                    </button>
                    <button className="btn btn-ghost" onClick={() => toggleEnabled(p)} style={{ fontSize: 12 }}>
                      {p.enabled ? t('sso.disable') : t('sso.enable')}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setDraft(toDraft(p))} style={{ fontSize: 12 }}>
                      <Icon name="pencil" size={14} /> {t('common:edit')}
                    </button>
                    <button className="btn btn-ghost" onClick={() => remove(p)} style={{ fontSize: 12, color: 'var(--c-over, #e5484d)' }}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {p.type === 'SAML' ? t('sso.acsReplyUrl') : t('sso.redirectUriRegister')}
                  <code
                    style={{ marginLeft: 6, cursor: 'pointer' }}
                    title={t('sso.copy')}
                    onClick={() => copy(callbackUrl(p.slug, p.type))}
                  >
                    {callbackUrl(p.slug, p.type)}
                  </code>
                  {p.type === 'SAML' && (
                    <>
                      {'  ·  '}{t('sso.entityIdLabel')}
                      <code
                        style={{ cursor: 'pointer' }}
                        title={t('sso.copy')}
                        onClick={() => copy(p.samlIssuer || samlEntityId(p.slug))}
                      >
                        {p.samlIssuer || samlEntityId(p.slug)}
                      </code>
                    </>
                  )}
                </div>
                {tr && (
                  <div style={{ fontSize: 12, color: tr.ok ? 'var(--ok, #3fb950)' : 'var(--warn, #b45309)' }}>
                    {tr.ok
                      ? p.type === 'SAML'
                        ? t('sso.testOkSaml')
                        : t('sso.testOkOidc', { issuer: tr.issuer ?? '?' })
                      : p.type === 'SAML'
                        ? t('sso.testSamlDetail', {
                            entryPoint: tr.entryPointConfigured ? t('sso.statusOk') : t('sso.statusMissing'),
                            certificate: tr.idpCertConfigured ? t('sso.statusOk') : t('sso.statusMissing'),
                            error: tr.error ? ' · ' + tr.error : '',
                          })
                        : t('sso.testOidcDetail', {
                            discovery: tr.discoveryOk ? t('sso.statusOk') : t('sso.statusFailed'),
                            clientId: tr.clientIdConfigured ? t('sso.statusOk') : t('sso.statusMissing'),
                            secret: tr.clientSecretConfigured ? t('sso.statusOk') : t('sso.statusMissing'),
                            error: tr.error ? ' · ' + tr.error : '',
                          })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Bouton "ajouter" */}
          {!draft && (
            <div>
              <button className="btn btn-accent" onClick={() => setDraft({ ...BLANK_DRAFT })}>
                <Icon name="plus" size={15} /> {t('sso.addProvider')}
              </button>
            </div>
          )}

          {/* Éditeur */}
          {draft && (
            <ProviderEditor
              draft={draft}
              setDraft={setDraft}
              orgRoles={orgRoles}
              saving={saving}
              onSave={save}
              onCancel={() => setDraft(null)}
              copy={copy}
              t={t}
            />
          )}

          {/* SCIM provisioning (org-wide) */}
          {!draft && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md, 10px)',
                padding: 14,
                marginTop: 4,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t('sso.scim.title')} <span className="pill pill-role">SCIM 2.0</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 8 }}>
                <Trans
                  t={t}
                  i18nKey="sso.scim.intro"
                  components={{ 0: <strong />, 1: <strong />, 2: <code />, 3: <strong />, 4: <strong /> }}
                />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px' }}>
                <strong>{t('sso.scim.mappingsTitle')}</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  <li>
                    <Trans t={t} i18nKey="sso.scim.mappingExternalId" components={{ 0: <code />, 1: <code />, 2: <code /> }} />
                  </li>
                  <li>
                    <Trans t={t} i18nKey="sso.scim.mappingEmployee" components={{ 0: <code />, 1: <code />, 2: <code /> }} />
                  </li>
                </ul>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('sso.scim.tenantUrl')}
                <code style={{ cursor: 'pointer' }} title={t('sso.copy')} onClick={() => copy(`${window.location.origin}/api/v1/scim/v2`)}>
                  {`${window.location.origin}/api/v1/scim/v2`}
                </code>
              </div>

              {/* Jeton secret (bearer) que l'IdP présente — clé d'org scim:provision */}
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>
                  {t('sso.scim.secretTokenTitle')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 8 }}>
                  {t('sso.scim.secretTokenHint')}
                </div>

                {!scimLicensed && (
                  <div style={{ fontSize: 12, color: 'var(--warn, #b45309)' }}>
                    🔒 {t('sso.scim.licenseRequired')}
                  </div>
                )}

                {scimLicensed && scimSecret && (
                  <div
                    style={{
                      border: '1px solid color-mix(in oklch, oklch(0.70 0.16 145) 45%, var(--border))',
                      background: 'color-mix(in oklch, oklch(0.70 0.16 145) 12%, var(--surface))',
                      borderRadius: 'var(--r-sm)',
                      padding: '8px 10px',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>
                      {t('sso.scim.secretShownOnce')}
                    </div>
                    <code
                      style={{ cursor: 'pointer', wordBreak: 'break-all', fontSize: 12 }}
                      title={t('sso.copy')}
                      onClick={() => copy(scimSecret)}
                    >
                      {scimSecret}
                    </code>
                  </div>
                )}

                {scimLicensed && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {scimTokens.length > 0 ? (
                      <>
                        <span className="pill" style={{ background: 'var(--ok-bg, #1c3329)', color: 'var(--ok, #3fb950)' }}>
                          {t('sso.scim.tokenActive')}
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                          <code>{scimTokens[0].prefix}…</code>
                          {scimTokens[0].expiresAt && (
                            <> · {t('sso.scim.tokenExpires', { date: new Date(scimTokens[0].expiresAt).toLocaleDateString() })}</>
                          )}
                        </span>
                        <button className="btn btn-line btn-sm" disabled={scimBusy} onClick={() => void issueScimToken(true)}>
                          {t('sso.scim.rotate')}
                        </button>
                        <button className="btn btn-line btn-sm" disabled={scimBusy} onClick={() => void revokeScimToken()}>
                          {t('sso.scim.revoke')}
                        </button>
                      </>
                    ) : (
                      <button className="btn btn-accent btn-sm" disabled={scimBusy} onClick={() => void issueScimToken(false)}>
                        {t('sso.scim.generateToken')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProviderEditor({
  draft,
  setDraft,
  orgRoles,
  saving,
  onSave,
  onCancel,
  copy,
  t,
}: {
  draft: DraftState;
  setDraft: (d: DraftState) => void;
  orgRoles: RoleDto[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  copy: (s: string) => void;
  t: TFunction<'integrations'>;
}) {
  const set = <K extends keyof DraftState>(k: K, v: DraftState[K]) => setDraft({ ...draft, [k]: v });
  const field = (label: string, node: ReactNode, hint?: string) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>{label}</div>
      {node}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{hint}</div>}
    </label>
  );
  const input = (k: keyof DraftState, placeholder?: string, mono?: boolean) => (
    <div className="searchbox" style={{ width: '100%' }}>
      <input
        value={String(draft[k] ?? '')}
        onChange={(e) => set(k, e.target.value as never)}
        placeholder={placeholder}
        style={mono ? { fontFamily: 'monospace', fontSize: 12 } : undefined}
      />
    </div>
  );
  /**
   * Champ en lecture seule pour une valeur GÉNÉRÉE (URLs de callback/metadata,
   * identifier par défaut). Apparence d'un champ éditable mais grisé + bouton
   * « Copy » à droite. Le texte reste sélectionnable manuellement.
   */
  const copyField = (value: string) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
      <div
        className="searchbox"
        style={{ flex: 1, minWidth: 0, background: 'var(--surface-2)', borderColor: 'var(--border)' }}
      >
        <input
          value={value}
          readOnly
          tabIndex={-1}
          title={value}
          style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-3)', cursor: 'default' }}
        />
      </div>
      <button
        type="button"
        className="btn btn-line btn-sm"
        title={t('sso.editor.copyToClipboard')}
        onClick={() => copy(value)}
        style={{ flexShrink: 0 }}
      >
        <Icon name="paperclip" size={13} /> {t('sso.copy')}
      </button>
    </div>
  );
  /** Télécharge les métadonnées SP (XML) — l'endpoint est public, le provider
   *  doit être enregistré (sinon 404). Fichier `vaks-sp-metadata-<slug>.xml`. */
  const downloadMetadata = async (slug: string) => {
    try {
      const res = await fetch(samlMetadataUrl(slug), { credentials: 'omit' });
      const xml = await res.text();
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vaks-sp-metadata-${slug}.xml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* endpoint public ; échec réseau silencieux */
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const next = [...draft.roleMappings];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set('roleMappings', next);
  };
  const dupIdx = duplicateMappingIdx(draft.roleMappings);
  const hasDup = dupIdx.size > 0;

  return (
    <div
      style={{
        border: '1px solid var(--accent)',
        borderRadius: 'var(--r-md, 10px)',
        padding: 16,
        marginTop: 4,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 12 }}>
        {draft.id
          ? t('sso.editor.editTitle', { type: draft.type })
          : t('sso.editor.newTitle', { type: draft.type })}
      </div>

      {!draft.id &&
        field(
          t('sso.editor.protocol'),
          <div style={{ display: 'flex', gap: 8 }}>
            {(['OIDC', 'SAML'] as const).map((proto) => (
              <button
                key={proto}
                type="button"
                className={'btn btn-sm ' + (draft.type === proto ? 'btn-accent' : 'btn-line')}
                onClick={() => set('type', proto)}
              >
                {proto}
              </button>
            ))}
          </div>,
          t('sso.editor.protocolHint'),
        )}

      {field(
        t('sso.editor.slug'),
        input('slug', 'entra'),
        draft.id
          ? t('sso.editor.slugHintImmutable')
          : t('sso.editor.slugHint'),
      )}
      {field(t('sso.editor.displayName'), input('displayName', 'Microsoft Entra ID'), t('sso.editor.displayNameHint'))}

      {draft.type === 'SAML' ? (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3)', margin: '4px 0 8px' }}>
            {t('sso.editor.samlGeneratedIntro')}
          </div>
          {field(
            t('sso.editor.acsReplyGenerated'),
            copyField(callbackUrl(draft.slug, 'SAML')),
            t('sso.editor.acsReplyHint'),
          )}
          {/* Identifier (entityID) : généré par défaut (base de l'endpoint SAML,
              PAS l'URL de métadonnées), mais personnalisable. */}
          {!draft.customSamlIssuer
            ? field(
                t('sso.editor.spEntityId'),
                <>
                  {copyField(samlEntityId(draft.slug))}
                  <div style={{ fontSize: 11, marginTop: 4 }}>
                    <button
                      type="button"
                      style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}
                      onClick={() => setDraft({ ...draft, customSamlIssuer: true, samlIssuer: samlEntityId(draft.slug) })}
                    >
                      {t('sso.editor.useCustomIdentifier')}
                    </button>
                  </div>
                </>,
                t('sso.editor.spEntityIdHint'),
              )
            : field(
                t('sso.editor.spEntityIdCustom'),
                <>
                  {input('samlIssuer', samlEntityId(draft.slug), true)}
                  <div style={{ fontSize: 11, marginTop: 4 }}>
                    <button
                      type="button"
                      style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}
                      onClick={() => setDraft({ ...draft, customSamlIssuer: false, samlIssuer: '' })}
                    >
                      {t('sso.editor.backToGenerated')}
                    </button>
                  </div>
                </>,
                t('sso.editor.spEntityIdCustomHint'),
              )}
          {/* Métadonnées SP : EXPORT fichier XML (Entra: "Upload metadata file").
              Disponible une fois le provider enregistré. */}
          {field(
            t('sso.editor.spMetadata'),
            draft.id ? (
              <button type="button" className="btn btn-line btn-sm" onClick={() => downloadMetadata(draft.slug)}>
                <Icon name="download" size={13} /> {t('sso.editor.exportSpMetadata')}
              </button>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('sso.editor.saveFirstMetadata')}
              </div>
            ),
            t('sso.editor.spMetadataHint'),
          )}
          {field(
            t('sso.editor.idpSignOnUrl'),
            input('samlEntryPoint', 'https://login.microsoftonline.com/<tenant>/saml2', true),
            t('sso.editor.idpSignOnUrlHint'),
          )}
          {field(
            t('sso.editor.idpSigningCert'),
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <label className="btn btn-line btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
                  <Icon name="paperclip" size={13} /> {t('sso.editor.uploadCertFile')}
                  <input
                    type="file"
                    accept=".cer,.crt,.pem,.txt,application/x-x509-ca-cert,application/pkix-cert"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        set('samlIdpCert', await certFileToPem(f));
                      } catch {
                        /* lecture impossible — l'utilisateur peut coller à la main */
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
                {draft.samlIdpCert.includes('BEGIN CERTIFICATE') && (
                  <span style={{ fontSize: 11, color: 'var(--ok, #3fb950)' }}>
                    <Icon name="check" size={12} /> {t('sso.editor.certificateLoaded')}
                  </span>
                )}
              </div>
              <textarea
                value={draft.samlIdpCert}
                onChange={(e) => set('samlIdpCert', e.target.value)}
                placeholder={t('sso.editor.certPlaceholder')}
                rows={6}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 8, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
              />
            </>,
            t('sso.editor.idpSigningCertHint'),
          )}
        </>
      ) : (
      <>
      {field(
        t('sso.editor.redirectUriGenerated'),
        copyField(callbackUrl(draft.slug)),
        t('sso.editor.redirectUriHint'),
      )}

      {!draft.customDiscovery ? (
        <>
          {field(
            t('sso.editor.directoryTenantId'),
            <div className="searchbox" style={{ width: '100%' }}>
              <input
                value={draft.entraTenantId}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    entraTenantId: e.target.value,
                    oidcDiscoveryUrl: entraDiscovery(e.target.value),
                  })
                }
                placeholder={t('sso.editor.directoryTenantPlaceholder')}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>,
            t('sso.editor.directoryTenantHint'),
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '-6px 0 12px' }}>
            {t('sso.editor.discoveryUrlLabel')}
            <code>{draft.entraTenantId.trim() ? entraDiscovery(draft.entraTenantId) : '—'}</code>
            {'  ·  '}
            <button
              type="button"
              className="linklike"
              style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}
              onClick={() => set('customDiscovery', true)}
            >
              {t('sso.editor.useCustomDiscovery')}
            </button>
          </div>
        </>
      ) : (
        <>
          {field(
            t('sso.editor.oidcDiscoveryUrl'),
            input('oidcDiscoveryUrl', 'https://idp.example.com/.well-known/openid-configuration', true),
            t('sso.editor.oidcDiscoveryUrlHint'),
          )}
          <div style={{ fontSize: 11, margin: '-6px 0 12px' }}>
            <button
              type="button"
              style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}
              onClick={() =>
                setDraft({
                  ...draft,
                  customDiscovery: false,
                  oidcDiscoveryUrl: entraDiscovery(draft.entraTenantId),
                })
              }
            >
              {t('sso.editor.backToTenant')}
            </button>
          </div>
        </>
      )}
      {field(t('sso.editor.clientId'), input('oidcClientId', '00000000-0000-0000-0000-000000000000', true))}
      {field(
        t('sso.editor.authMode'),
        <div style={{ display: 'flex', gap: 8 }}>
          {(['secret', 'cert'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={draft.authMode === m ? 'btn btn-sm' : 'btn btn-sm btn-ghost'}
              onClick={() => set('authMode', m)}
            >
              {t(m === 'secret' ? 'sso.editor.authModeSecret' : 'sso.editor.authModeCert')}
            </button>
          ))}
        </div>,
        t('sso.editor.authModeHint'),
      )}
      {draft.authMode === 'secret'
        ? field(
            t('sso.editor.clientSecret'),
            <div className="searchbox" style={{ width: '100%' }}>
              <input
                type="password"
                value={draft.clientSecret}
                onChange={(e) => set('clientSecret', e.target.value)}
                placeholder={draft.secretConfigured ? t('sso.editor.clientSecretSetPlaceholder') : t('sso.editor.clientSecretPlaceholder')}
                autoComplete="new-password"
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>,
            draft.secretConfigured
              ? t('sso.editor.clientSecretHintSet')
              : t('sso.editor.clientSecretHint'),
          )
        : (
          <>
            {field(
              t('sso.editor.certThumbprint'),
              input('certThumbprint', 'A1B2C3D4E5F6…'),
              t('sso.editor.certThumbprintHint'),
            )}
            {field(
              t('sso.editor.privateKey'),
              <textarea
                value={draft.privateKey}
                onChange={(e) => set('privateKey', e.target.value)}
                placeholder={draft.certConfigured ? t('sso.editor.privateKeySetPlaceholder') : '-----BEGIN PRIVATE KEY-----'}
                rows={5}
                autoComplete="off"
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              />,
              draft.certConfigured
                ? t('sso.editor.privateKeyHintSet')
                : t('sso.editor.privateKeyHint'),
            )}
          </>
        )}
      {field(t('sso.editor.scopes'), input('oidcScopes', 'openid, profile, email'), t('sso.editor.scopesHint'))}
      </>
      )}

      {field(
        t('sso.editor.defaultRole'),
        <select
          value={draft.defaultRoleKey}
          onChange={(e) => set('defaultRoleKey', e.target.value)}
          className="select"
          style={{ width: '100%' }}
        >
          {orgRoles.map((r) => (
            <option key={r.key} value={r.key}>{r.name}</option>
          ))}
        </select>,
        t('sso.editor.defaultRoleHint'),
      )}

      {field(
        t('sso.editor.unknownUser'),
        <select
          value={draft.jitProvisioning ? 'create' : 'refuse'}
          onChange={(e) => set('jitProvisioning', e.target.value === 'create')}
          className="select"
          style={{ width: '100%' }}
        >
          <option value="create">{t('sso.editor.unknownUserCreate')}</option>
          <option value="refuse">{t('sso.editor.unknownUserRefuse')}</option>
        </select>,
        t('sso.editor.unknownUserHint'),
      )}

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={draft.syncRolesOnLogin}
          onChange={(e) => set('syncRolesOnLogin', e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          {t('sso.editor.authoritativeRoles')}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {t('sso.editor.authoritativeRolesHint')}
          </div>
        </span>
      </label>

      {/* Role mappings */}
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginTop: 12, marginBottom: 6 }}>
        {t('sso.editor.roleMappings')}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
        <Trans t={t} i18nKey="sso.editor.roleMappingsHint" components={{ 0: <strong />, 1: <strong /> }} />
      </div>
      {draft.roleMappings.map((m, i) => {
        const isDup = dupIdx.has(i);
        return (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <button
                className="btn btn-ghost"
                title={t('sso.editor.moveUp')}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                style={{ padding: '0 5px', height: 15, lineHeight: '15px', fontSize: 11, opacity: i === 0 ? 0.3 : 1 }}
              >
                ↑
              </button>
              <button
                className="btn btn-ghost"
                title={t('sso.editor.moveDown')}
                disabled={i === draft.roleMappings.length - 1}
                onClick={() => move(i, 1)}
                style={{ padding: '0 5px', height: 15, lineHeight: '15px', fontSize: 11, opacity: i === draft.roleMappings.length - 1 ? 0.3 : 1 }}
              >
                ↓
              </button>
            </div>
            <div className="searchbox" style={{ flex: 1, borderColor: isDup ? 'var(--c-over, #e5484d)' : undefined }}>
              <input
                value={m.match}
                placeholder={t('sso.editor.mappingMatchPlaceholder')}
                onChange={(e) => {
                  const next = [...draft.roleMappings];
                  next[i] = { ...m, match: e.target.value };
                  set('roleMappings', next);
                }}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>
            <select
              value={m.roleKey}
              className="select"
              onChange={(e) => {
                const next = [...draft.roleMappings];
                next[i] = { ...m, roleKey: e.target.value };
                set('roleMappings', next);
              }}
            >
              {orgRoles.map((r) => (
                <option key={r.key} value={r.key}>{r.name}</option>
              ))}
            </select>
            <button
              className="btn btn-ghost"
              onClick={() => set('roleMappings', draft.roleMappings.filter((_, j) => j !== i))}
              style={{ color: 'var(--c-over, #e5484d)' }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
      {hasDup && (
        <div style={{ fontSize: 11.5, color: 'var(--c-over, #e5484d)', marginBottom: 8 }}>
          {t('sso.editor.duplicateWarning')}
        </div>
      )}
      <button
        className="btn btn-ghost"
        style={{ fontSize: 12, marginBottom: 14 }}
        onClick={() =>
          set('roleMappings', [
            ...draft.roleMappings,
            { match: '', roleKey: orgRoles[0]?.key ?? 'ORG_MEMBER' },
          ])
        }
      >
        <Icon name="plus" size={13} /> {t('sso.editor.addMapping')}
      </button>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        {t('sso.editor.enabledLogin')}
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-accent" disabled={saving || hasDup} onClick={onSave}>
          {saving ? t('common:saving') : t('sso.editor.saveProvider')}
        </button>
        <button className="btn btn-ghost" disabled={saving} onClick={onCancel}>
          {t('common:cancel')}
        </button>
        {hasDup && (
          <span style={{ fontSize: 11.5, color: 'var(--c-over, #e5484d)' }}>
            {t('sso.editor.resolveDuplicates')}
          </span>
        )}
      </div>
    </div>
  );
}
