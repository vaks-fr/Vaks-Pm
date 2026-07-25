import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ApiTokenDto } from '../api/client';
import { Icon } from './primitives';
import type { NormalizedProvider } from './connectors/types';
import type { DraftState } from './connectors/draft';
import ConnectorCard from './connectors/ConnectorCard';
import ConnectorDraftForm from './connectors/ConnectorDraftForm';
import ProviderPickerModal from './connectors/ProviderPickerModal';
import InboundConnectorCard from './connectors/InboundConnectorCard';
import DocumentSourcesSection from './DocumentSourcesSection';
import { useConfirm } from './confirm';

type Flash = (msg: string) => void;

/** Clé synthétique du « provider » inbound dans le picker. */
const INBOUND_COLLAB_KEY = '__inbound_collab_spaces';
const INBOUND_COLLAB_PREFIX = 'inbound:collab-spaces:';
const INBOUND_COLLAB_SCOPES = ['collab:link'];

/**
 * Descripteur d'un fournisseur de provisioning **sortant** (Vaks crée l'espace) :
 * étend `NormalizedProvider` avec ce que chaque fournisseur a de spécifique —
 * sa clé d'activation OrgSetting, sa condition « configuré », son test de
 * connexion et, en option, un bloc meta libre sur sa carte (ex. ligne tenant
 * Teams). Ce type reste local au fichier : les autres familles de connecteurs
 * (ticketing, agents, CI) n'en ont pas besoin.
 */
interface CollabProvider extends NormalizedProvider {
  enabledKey: string;
  isConfigured: (values: Record<string, unknown>) => boolean;
  onTest: () => Promise<{ ok: boolean; message: string }>;
  confirmDeleteMessage: string;
  cardMeta?: (values: Record<string, unknown>) => ReactNode;
  /**
   * Provisionne l'espace d'un projet **déjà actif**, sans transition de statut.
   * Le hook automatique ne se déclenche qu'à l'entrée en ACTIVE ; un aller-retour
   * de statut aurait des effets de bord (autre provisioning, notifications,
   * webhooks). Optionnel : un fournisseur sans cette action n'affiche pas le bloc.
   */
  onProvision?: (projectId: string) => Promise<{ status: string; reason?: string; channelId?: string }>;
}

/**
 * Section « Collaboration spaces » (groupe Integrations) — ex-« Microsoft Teams
 * — provisioning ». Re-skin UI uniquement pour Teams : les clés OrgSetting
 * `teams.provisioning.*`, le modèle `Project.msTeam*`, le worker et le flag de
 * licence `teams-provisioning` sont INCHANGÉS. La config d'un fournisseur vit
 * désormais dans sa carte ; Microsoft Teams, **Slack** et **Google Chat**
 * sont disponibles — un futur fournisseur s'ajouterait de la même façon au
 * tableau `PROVIDERS`.
 *
 * En bas, la carte inbound « espaces déclarés » : un outil externe qui gère
 * lui-même l'espace vient déclarer le lien avec une clé scopée `collab:link`.
 */
export default function CollabSpacesSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  // Plusieurs cartes de fournisseur peuvent être configurées en même temps
  // (Teams ET Slack) : l'état de test est donc keyé par provider, pas partagé.
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [picking, setPicking] = useState(false);
  const [inboundKeys, setInboundKeys] = useState<ApiTokenDto[]>([]);
  const [inboundAdded, setInboundAdded] = useState(false);
  // « Provisionner maintenant » (projet déjà actif) : id saisi + état, par provider.
  const [provisionProjectId, setProvisionProjectId] = useState<Record<string, string>>({});
  const [provisioningKey, setProvisioningKey] = useState<string | null>(null);
  const [provisionResults, setProvisionResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  // Sous-bloc « lecture documentaire SharePoint » (réutilise l'identité Teams —
  // rapatrié depuis l'ancienne section « Document sources »).
  const [spDraft, setSpDraft] = useState<DraftState | null>(null);
  const [spSaving, setSpSaving] = useState(false);
  const [spProjectId, setSpProjectId] = useState('');
  const [spTesting, setSpTesting] = useState(false);
  const [spTestResult, setSpTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Génération de la clé WIF (mode sans clé de compte de service). Partagé entre
  // Google Chat et Google Drive : l'état est keyé par préfixe de clés OrgSetting.
  const [wifGenerating, setWifGenerating] = useState<string | null>(null);
  const [wifResult, setWifResult] = useState<
    { prefix: string; keyId: string; issuer: string; jwks: unknown } | null
  >(null);

  const generateWifKey = useCallback(
    async (prefix: string) => {
      setWifGenerating(prefix);
      try {
        const r =
          prefix === 'gdrive.provisioning'
            ? await api.generateGoogleDriveWifKey()
            : await api.generateGoogleChatWifKey();
        setWifResult({ prefix, ...r });
        // Reflète le nouveau kid/issuer/JWKS dans les valeurs affichées sans recharger.
        setValues((v) => ({
          ...v,
          [`${prefix}.wifKeyId`]: r.keyId,
          [`${prefix}.wifIssuer`]: r.issuer,
          [`${prefix}.wifJwksPublic`]: JSON.stringify(r.jwks),
          [`${prefix}.wifSigningKeySet`]: true,
        }));
        flash(t('collab.gchat.wif.generated'));
      } catch (e) {
        flash((e as Error).message);
      } finally {
        setWifGenerating(null);
      }
    },
    [flash, t],
  );

  /**
   * Panneau WIF partagé (génération de clé + issuer + JWKS à copier). Affiché à
   * la fois sous le formulaire de configuration (setup initial) et sur la carte
   * d'un fournisseur déjà configuré. Les valeurs fraîchement générées (wifResult)
   * priment sur celles chargées, pour un affichage immédiat sans rechargement.
   */
  const renderWifPanel = useCallback((prefix: string) => {
    // Seul le résultat fraîchement généré POUR CE fournisseur prime.
    const mine = wifResult?.prefix === prefix ? wifResult : null;
    const generating = wifGenerating === prefix;
    const keyId = mine?.keyId ?? values[`${prefix}.wifKeyId`];
    const issuer = mine?.issuer ?? values[`${prefix}.wifIssuer`];
    const jwks = mine ? JSON.stringify(mine.jwks, null, 2) : values[`${prefix}.wifJwksPublic`];
    const hasKey = !!keyId || values[`${prefix}.wifSigningKeySet`] === true;
    return (
      <div style={{ display: 'grid', gap: 6, marginTop: 8, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('collab.gchat.wif.help')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" disabled={generating} onClick={() => generateWifKey(prefix)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="key" size={14} />{' '}
            {generating ? t('common:loading') : hasKey ? t('collab.gchat.wif.regenerate') : t('collab.gchat.wif.generate')}
          </button>
          {keyId ? (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>kid: <code>{String(keyId)}</code></span>
          ) : null}
        </div>
        {issuer ? (
          <label style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {t('collab.gchat.wif.issuer')}
            <input className="td-in" readOnly value={String(issuer)} onFocus={(e) => e.currentTarget.select()}
              style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: 11 }} />
          </label>
        ) : null}
        {jwks ? (
          <label style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {t('collab.gchat.wif.jwks')}
            <textarea className="td-in" readOnly rows={6} value={String(jwks)} onFocus={(e) => e.currentTarget.select()}
              style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: 10.5 }} />
          </label>
        ) : null}
      </div>
    );
  }, [wifResult, values, wifGenerating, generateWifKey, t]);

  /**
   * Descripteurs des fournisseurs. Les `key` des champs sont EXACTEMENT les clés
   * OrgSetting existantes — la carte n'est qu'une autre façon de les éditer.
   */
  const PROVIDERS: CollabProvider[] = useMemo(
    () => [
      {
        key: 'msteams',
        label: 'Microsoft Teams',
        blurb: t('collab.msteams.blurb'),
        accent: '#6264A7',
        short: 'MT',
        enabledKey: 'teams.provisioning.enabled',
        isConfigured: (v) => !!v['teams.provisioning.clientId'],
        onTest: () => api.testTeamsProvisioning(),
        confirmDeleteMessage: t('collab.confirmDeleteTeams'),
        cardMeta: (v) => (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {t('collab.tenantLine', {
              tenant: String(v['teams.provisioning.tenantId'] ?? '—'),
              pattern: String(v['teams.provisioning.namePattern'] ?? '—'),
            })}
          </div>
        ),
        fields: [
          { key: 'teams.provisioning.tenantId', label: t('setting.teamsProvTenantId.label'), type: 'text', required: true, secret: false, help: t('setting.teamsProvTenantId.desc'), placeholder: '72f988bf-86f1-41af-91ab-2d7cd011db47' },
          { key: 'teams.provisioning.clientId', label: t('setting.teamsProvClientId.label'), type: 'text', required: true, secret: false, help: t('setting.teamsProvClientId.desc'), placeholder: '00000000-0000-0000-0000-000000000000' },
          { key: 'teams.provisioning.clientSecret', label: t('setting.teamsProvClientSecret.label'), type: 'password', required: false, secret: true, help: t('setting.teamsProvClientSecret.desc') },
          { key: 'teams.provisioning.certThumbprint', label: t('setting.teamsProvCertThumbprint.label'), type: 'text', required: false, secret: false, help: t('setting.teamsProvCertThumbprint.desc'), placeholder: 'A1B2C3D4E5F6…' },
          { key: 'teams.provisioning.privateKey', label: t('setting.teamsProvPrivateKey.label'), type: 'textarea', required: false, secret: true, help: t('setting.teamsProvPrivateKey.desc'), placeholder: '-----BEGIN PRIVATE KEY-----' },
          { key: 'teams.provisioning.namePattern', label: t('setting.teamsProvNamePattern.label'), type: 'text', required: false, secret: false, help: t('setting.teamsProvNamePattern.desc') },
          { key: 'teams.provisioning.channels', label: t('setting.teamsProvChannels.label'), type: 'text', required: false, secret: false, help: t('setting.teamsProvChannels.desc') },
          {
            key: 'teams.provisioning.channelLayout', label: t('setting.teamsProvChannelLayout.label'), type: 'segmented',
            required: false, secret: false, help: t('setting.teamsProvChannelLayout.desc'),
            options: [
              { value: 'post', label: t('setting.teamsProvChannelLayout.post') },
              { value: 'chat', label: t('setting.teamsProvChannelLayout.chat') },
            ],
          },
          {
            key: 'teams.provisioning.visibility', label: t('setting.teamsProvVisibility.label'), type: 'segmented',
            required: false, secret: false, help: t('setting.teamsProvVisibility.desc'),
            options: [{ value: 'private', label: 'private' }, { value: 'public', label: 'public' }],
          },
          {
            key: 'teams.provisioning.membership', label: t('setting.teamsProvMembership.label'), type: 'select',
            required: false, secret: false, help: t('setting.teamsProvMembership.desc'),
            options: [
              { value: 'assigned_teams', label: 'assigned_teams' },
              { value: 'project_members', label: 'project_members' },
              { value: 'both', label: 'both' },
            ],
          },
          { key: 'teams.provisioning.removeOnLeave', label: t('setting.teamsProvRemoveOnLeave.label'), type: 'toggle', required: false, secret: false, help: t('setting.teamsProvRemoveOnLeave.desc') },
          { key: 'teams.provisioning.archiveOnClose', label: t('setting.teamsProvArchiveOnClose.label'), type: 'toggle', required: false, secret: false, help: t('setting.teamsProvArchiveOnClose.desc') },
        ],
      },
      {
        key: 'slack',
        label: 'Slack',
        blurb: t('collab.slack.blurb'),
        accent: '#4A154B',
        short: 'SL',
        enabledKey: 'slack.provisioning.enabled',
        // Le bot token est write-only (jamais ré-émis) : `…Set` est le seul signal
        // fiable qu'une configuration existe (comme les secrets Teams/SharePoint).
        isConfigured: (v) => v['slack.provisioning.botTokenSet'] === true,
        onTest: () => api.testSlackProvisioning(),
        onProvision: (projectId) => api.provisionSlackForProject(projectId),
        confirmDeleteMessage: t('collab.confirmDeleteSlack'),
        fields: [
          {
            key: 'slack.provisioning.botToken', label: t('collab.slack.field.botToken.label'),
            type: 'password', required: true, secret: true, help: t('collab.slack.field.botToken.help'),
            placeholder: 'xoxb-…',
          },
          {
            key: 'slack.provisioning.channelPrefix', label: t('collab.slack.field.channelPrefix.label'),
            type: 'text', required: false, secret: false, help: t('collab.slack.field.channelPrefix.help'),
            placeholder: 'proj-',
          },
          {
            key: 'slack.provisioning.visibility', label: t('collab.slack.field.visibility.label'), type: 'segmented',
            required: false, secret: false, help: t('collab.slack.field.visibility.help'),
            options: [{ value: 'private', label: 'private' }, { value: 'public', label: 'public' }],
          },
          {
            key: 'slack.provisioning.invite', label: t('collab.slack.field.invite.label'),
            type: 'toggle', required: false, secret: false, help: t('collab.slack.field.invite.help'),
          },
        ],
      },
      {
        key: 'gchat',
        label: 'Google Chat',
        blurb: t('collab.gchat.blurb'),
        accent: '#00AC47',
        short: 'GC',
        enabledKey: 'gchat.provisioning.enabled',
        // Configuré = clé SA posée (mode sa_key) OU clé WIF générée (mode wif).
        // Les deux secrets sont write-only : les `…Set` sont le signal fiable.
        isConfigured: (v) =>
          v['gchat.provisioning.privateKeySet'] === true || v['gchat.provisioning.wifSigningKeySet'] === true,
        onTest: () => api.testGoogleChatProvisioning(),
        confirmDeleteMessage: t('collab.confirmDeleteGchat'),
        // Le panneau WIF (clé/JWKS) ne s'affiche QUE pendant l'édition (sous le
        // formulaire), jamais sur la carte repliée — rien de sensible au repos.
        fields: [
          {
            key: 'gchat.provisioning.authMode', label: t('collab.gchat.field.authMode.label'), type: 'segmented',
            required: false, secret: false, help: t('collab.gchat.field.authMode.help'),
            options: [
              { value: 'sa_key', label: t('collab.gchat.field.authMode.saKey') },
              { value: 'wif', label: t('collab.gchat.field.authMode.wif') },
            ],
          },
          {
            key: 'gchat.provisioning.serviceAccountEmail', label: t('collab.gchat.field.serviceAccountEmail.label'),
            type: 'text', required: true, secret: false, help: t('collab.gchat.field.serviceAccountEmail.help'),
            placeholder: 'chat-bot@my-project.iam.gserviceaccount.com',
          },
          {
            key: 'gchat.provisioning.privateKey', label: t('collab.gchat.field.privateKey.label'),
            type: 'textarea', required: false, secret: true, help: t('collab.gchat.field.privateKey.help'),
            placeholder: '-----BEGIN PRIVATE KEY-----',
            // Inutile en mode Workload Identity (aucune clé de compte de service).
            hidden: (c) => c['gchat.provisioning.authMode'] === 'wif',
          },
          {
            key: 'gchat.provisioning.wifAudience', label: t('collab.gchat.field.wifAudience.label'),
            type: 'text', required: false, secret: false, help: t('collab.gchat.field.wifAudience.help'),
            placeholder: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vaks/providers/vaks',
            // Spécifique au mode Workload Identity.
            hidden: (c) => c['gchat.provisioning.authMode'] !== 'wif',
          },
          {
            key: 'gchat.provisioning.subjectEmail', label: t('collab.gchat.field.subjectEmail.label'),
            type: 'text', required: true, secret: false, help: t('collab.gchat.field.subjectEmail.help'),
            placeholder: 'admin@yourcompany.com',
          },
          {
            key: 'gchat.provisioning.spacePrefix', label: t('collab.gchat.field.spacePrefix.label'),
            type: 'text', required: false, secret: false, help: t('collab.gchat.field.spacePrefix.help'),
            placeholder: 'proj-',
          },
          {
            key: 'gchat.provisioning.invite', label: t('collab.gchat.field.invite.label'),
            type: 'toggle', required: false, secret: false, help: t('collab.gchat.field.invite.help'),
          },
        ],
      },
      {
        key: 'gdrive',
        label: 'Google Drive',
        blurb: t('collab.gdrive.blurb'),
        accent: '#1a73e8',
        short: 'GD',
        enabledKey: 'gdrive.provisioning.enabled',
        // Un secret posé suffit, mais l'email du compte de service suffit AUSSI
        // (précédent Teams/clientId) : sans ça, un fournisseur enregistré en mode
        // WIF avant d'avoir généré sa clé resterait invisible — donc impossible à
        // rouvrir pour justement générer la clé. Impasse observée en recette.
        isConfigured: (v) =>
          v['gdrive.provisioning.privateKeySet'] === true ||
          v['gdrive.provisioning.wifSigningKeySet'] === true ||
          !!v['gdrive.provisioning.serviceAccountEmail'],
        onTest: () => api.testGoogleDriveProvisioning(),
        confirmDeleteMessage: t('collab.confirmDeleteGdrive'),
        fields: [
          {
            key: 'gdrive.provisioning.authMode', label: t('collab.gchat.field.authMode.label'), type: 'segmented',
            required: false, secret: false, help: t('collab.gdrive.field.authMode.help'),
            options: [
              { value: 'sa_key', label: t('collab.gchat.field.authMode.saKey') },
              { value: 'wif', label: t('collab.gchat.field.authMode.wif') },
            ],
          },
          {
            key: 'gdrive.provisioning.serviceAccountEmail', label: t('collab.gchat.field.serviceAccountEmail.label'),
            type: 'text', required: true, secret: false, help: t('collab.gdrive.field.serviceAccountEmail.help'),
            placeholder: 'drive-provisioner@my-project.iam.gserviceaccount.com',
          },
          {
            key: 'gdrive.provisioning.privateKey', label: t('collab.gchat.field.privateKey.label'),
            type: 'textarea', required: false, secret: true, help: t('collab.gchat.field.privateKey.help'),
            placeholder: '-----BEGIN PRIVATE KEY-----',
            hidden: (c) => c['gdrive.provisioning.authMode'] === 'wif',
          },
          {
            key: 'gdrive.provisioning.wifAudience', label: t('collab.gchat.field.wifAudience.label'),
            type: 'text', required: false, secret: false, help: t('collab.gchat.field.wifAudience.help'),
            placeholder: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vaks/providers/vaks',
            hidden: (c) => c['gdrive.provisioning.authMode'] !== 'wif',
          },
          {
            key: 'gdrive.provisioning.subjectEmail', label: t('collab.gchat.field.subjectEmail.label'),
            type: 'text', required: true, secret: false, help: t('collab.gdrive.field.subjectEmail.help'),
            placeholder: 'admin@yourcompany.com',
          },
          {
            key: 'gdrive.provisioning.drivePrefix', label: t('collab.gdrive.field.drivePrefix.label'),
            type: 'text', required: false, secret: false, help: t('collab.gdrive.field.drivePrefix.help'),
            placeholder: 'Projet ',
          },
          {
            key: 'gdrive.provisioning.memberRole', label: t('collab.gdrive.field.memberRole.label'), type: 'segmented',
            required: false, secret: false, help: t('collab.gdrive.field.memberRole.help'),
            options: [
              { value: 'reader', label: t('collab.gdrive.field.memberRole.reader') },
              { value: 'writer', label: t('collab.gdrive.field.memberRole.writer') },
            ],
          },
          {
            key: 'gdrive.provisioning.invite', label: t('collab.gdrive.field.invite.label'),
            type: 'toggle', required: false, secret: false, help: t('collab.gdrive.field.invite.help'),
          },
        ],
      },
    ],
    [t],
  );

  /**
   * Descripteur du sous-bloc SharePoint (contexte documentaire lu par les agents
   * ET les membres humains). Les credentials Graph viennent de l'identité Teams
   * ci-dessus — seuls le modèle d'identité et, en `selected_granter`, l'app lecteur
   * sont saisis. Clés OrgSetting `teams.provisioning.sharepoint*` inchangées.
   */
  const SP_PROVIDER: NormalizedProvider = useMemo(
    () => ({
      key: 'sharepoint',
      label: 'SharePoint',
      blurb: t('collab.spBlurb'),
      accent: '#0364B8',
      short: 'SP',
      fields: [
        {
          key: 'teams.provisioning.sharepoint.identityMode', label: t('docsources.field.identityMode.label'),
          type: 'select', required: false, secret: false, help: t('docsources.field.identityMode.help'),
          options: [
            { value: 'read_all', label: t('docsources.field.identityMode.readAll') },
            { value: 'selected_granter', label: t('docsources.field.identityMode.selectedGranter') },
          ],
        },
        { key: 'teams.provisioning.reader.clientId', label: t('docsources.field.readerClientId.label'), type: 'text', required: false, secret: false, help: t('docsources.field.readerClientId.help'), placeholder: '00000000-0000-0000-0000-000000000000' },
        { key: 'teams.provisioning.reader.clientSecret', label: t('docsources.field.readerClientSecret.label'), type: 'password', required: false, secret: true, help: t('docsources.field.readerClientSecret.help') },
        { key: 'teams.provisioning.reader.certThumbprint', label: t('docsources.field.readerCertThumbprint.label'), type: 'text', required: false, secret: false, help: t('docsources.field.readerCertThumbprint.help'), placeholder: 'A1B2C3D4E5F6…' },
        { key: 'teams.provisioning.reader.privateKey', label: t('docsources.field.readerPrivateKey.label'), type: 'textarea', required: false, secret: true, help: t('docsources.field.readerPrivateKey.help'), placeholder: '-----BEGIN PRIVATE KEY-----' },
      ],
    }),
    [t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, orgKeys] = await Promise.all([
        api.getAdminSettings(),
        api.listOrgApiTokens().catch(() => [] as ApiTokenDto[]),
      ]);
      setValues(s as Record<string, unknown>);
      setInboundKeys(
        orgKeys.filter(
          (k) =>
            k.name.startsWith(INBOUND_COLLAB_PREFIX) &&
            k.scopes.length === 1 &&
            k.scopes[0] === INBOUND_COLLAB_SCOPES[0],
        ),
      );
    } catch (e) {
      flash(t('collab.loadFailed', { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Fournisseurs déjà configurés (une carte chacun) vs proposables (picker). */
  const configuredProviders = useMemo(() => PROVIDERS.filter((p) => p.isConfigured(values)), [PROVIDERS, values]);
  // SharePoint dépend spécifiquement de l'identité Teams (pas « un provider
  // quelconque ») : ce booléen reste dédié, distinct de `configuredProviders`.
  const teamsConfigured = !!values['teams.provisioning.clientId'];
  const showInbound = inboundAdded || inboundKeys.length > 0;

  /** Entrée synthétique du picker pour la déclaration entrante. */
  const inboundProvider: NormalizedProvider = useMemo(
    () => ({
      key: INBOUND_COLLAB_KEY,
      label: t('collab.inbound.title'),
      blurb: t('collab.inbound.blurb'),
      accent: '#e8590c',
      short: 'API',
      fields: [],
    }),
    [t],
  );

  /** Fournisseurs proposables : ceux pas encore configurés + l'API entrante. */
  const pickerProviders = useMemo(() => {
    const outbound = PROVIDERS.filter((p) => !p.isConfigured(values));
    return showInbound ? outbound : [...outbound, inboundProvider];
  }, [PROVIDERS, values, showInbound, inboundProvider]);

  const SP_ENABLED_KEY = 'teams.provisioning.sharepointContext.enabled';
  const spEnabled = values[SP_ENABLED_KEY] === true;
  /** SharePoint a-t-il une config à effacer ? (activé, app lecteur, mode, ou secret posé) */
  const spConfigured =
    spEnabled ||
    !!values['teams.provisioning.reader.clientId'] ||
    !!values['teams.provisioning.sharepoint.identityMode'] ||
    values['teams.provisioning.reader.clientSecretSet'] === true ||
    values['teams.provisioning.reader.privateKeySet'] === true;

  /** Ouvre l'éditeur d'un fournisseur, pré-rempli depuis les settings courants. */
  const startEdit = (p: CollabProvider) => {
    setSpDraft(null); // un seul éditeur ouvert à la fois
    const config: Record<string, unknown> = {};
    const secretsConfigured: string[] = [];
    for (const f of p.fields) {
      if (f.secret) {
        // `<clé>Set` = booléen « un secret est déjà enregistré » (jamais la valeur).
        if (values[`${f.key}Set`] === true) secretsConfigured.push(f.key);
        continue;
      }
      config[f.key] = values[f.key] ?? '';
    }
    setDraft({
      id: p.key,
      providerKey: p.key,
      label: p.label,
      enabled: values[p.enabledKey] === true,
      config,
      secrets: {},
      secretsConfigured,
    });
  };

  const activeDesc = draft ? PROVIDERS.find((p) => p.key === draft.providerKey) : undefined;
  const activeConfigured = activeDesc ? activeDesc.isConfigured(values) : false;

  const save = async () => {
    if (!draft || !activeDesc) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { [activeDesc.enabledKey]: draft.enabled };
      for (const f of activeDesc.fields) {
        if (f.secret) {
          // Secret envoyé UNIQUEMENT si saisi (vide = conserver l'existant).
          const v = (draft.secrets[f.key] ?? '').trim();
          if (v) body[f.key] = v;
        } else {
          body[f.key] = draft.config[f.key] ?? '';
        }
      }
      await api.putAdminSettings(body as never);
      flash(t('collab.saved'));
      setDraft(null);
      await load();
    } catch (e) {
      flash(t('collab.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  /** Provisionne l'espace d'un projet déjà actif (id saisi sur la carte). */
  const runProvision = async (p: CollabProvider) => {
    const id = (provisionProjectId[p.key] ?? '').trim();
    if (!id || !p.onProvision) return;
    setProvisioningKey(p.key);
    try {
      const r = await p.onProvision(id);
      const msg =
        r.status === 'done'
          ? t('collab.provisionDone', { id: r.channelId ?? '' })
          : t('collab.provisionSkipped', { reason: r.reason ?? r.status });
      setProvisionResults((prev) => ({ ...prev, [p.key]: { ok: r.status === 'done', message: msg } }));
      flash(msg);
    } catch (e) {
      const msg = t('collab.provisionFailed', { message: (e as Error).message });
      setProvisionResults((prev) => ({ ...prev, [p.key]: { ok: false, message: msg } }));
      flash(msg);
    } finally {
      setProvisioningKey(null);
    }
  };

  const runTest = async (p: CollabProvider) => {
    setTestingKey(p.key);
    try {
      const r = await p.onTest();
      setTestResults((prev) => ({ ...prev, [p.key]: r }));
      flash(r.ok ? t('collab.testOk') : t('collab.testFailed', { message: r.message }));
    } catch (e) {
      flash(t('collab.testFailed', { message: (e as Error).message }));
    } finally {
      setTestingKey(null);
    }
  };

  /**
   * « Supprime » un fournisseur stocké en OrgSetting = renvoie toutes ses clés
   * de config à vide (le backend `upsertMany` traite `''` comme un effacement,
   * secrets chiffrés inclus) + coupe son toggle d'activation. Pas d'entité en
   * base : c'est une remise à zéro de la config, réversible par une nouvelle saisie.
   */
  const clearProviderBody = (fields: NormalizedProvider['fields'], enabledKey: string) => {
    const body: Record<string, unknown> = { [enabledKey]: false };
    for (const f of fields) body[f.key] = ''; // '' = effacement (secret compris)
    return body;
  };

  /** Supprime un fournisseur de « Collaboration spaces » (config sortante uniquement). */
  const removeProvider = async (p: CollabProvider) => {
    if (
      !(await confirm({
        title: t('common:delete'),
        message: p.confirmDeleteMessage,
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    setSaving(true);
    try {
      await api.putAdminSettings(clearProviderBody(p.fields, p.enabledKey) as never);
      flash(t('collab.deleted'));
      setDraft(null);
      setTestResults((prev) => {
        const { [p.key]: _dropped, ...rest } = prev;
        return rest;
      });
      await load();
    } catch (e) {
      flash(t('collab.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  /** Supprime le connecteur documentaire SharePoint (app lecteur + mode d'identité). */
  const removeSharepoint = async () => {
    if (
      !(await confirm({
        title: t('common:delete'),
        message: t('collab.confirmDeleteSharepoint'),
        confirmLabel: t('common:delete'),
        danger: true,
      }))
    )
      return;
    setSpSaving(true);
    try {
      await api.putAdminSettings(clearProviderBody(SP_PROVIDER.fields, SP_ENABLED_KEY) as never);
      flash(t('collab.deleted'));
      setSpDraft(null);
      setSpTestResult(null);
      await load();
    } catch (e) {
      flash(t('docsources.saveFailed', { message: (e as Error).message }));
    } finally {
      setSpSaving(false);
    }
  };

  /** Ouvre l'éditeur du sous-bloc SharePoint, pré-rempli depuis les settings. */
  const startSpEdit = () => {
    setDraft(null); // un seul éditeur ouvert à la fois
    const config: Record<string, unknown> = {};
    const secretsConfigured: string[] = [];
    for (const f of SP_PROVIDER.fields) {
      if (f.secret) {
        if (values[`${f.key}Set`] === true) secretsConfigured.push(f.key);
        continue;
      }
      config[f.key] = values[f.key] ?? '';
    }
    setSpDraft({
      id: 'sharepoint', providerKey: 'sharepoint', label: SP_PROVIDER.label,
      enabled: spEnabled, config, secrets: {}, secretsConfigured,
    });
  };

  const saveSp = async () => {
    if (!spDraft) return;
    setSpSaving(true);
    try {
      const body: Record<string, unknown> = { [SP_ENABLED_KEY]: spDraft.enabled };
      for (const f of SP_PROVIDER.fields) {
        if (f.secret) {
          const v = (spDraft.secrets[f.key] ?? '').trim();
          if (v) body[f.key] = v; // vide = conserver le secret existant
        } else {
          body[f.key] = spDraft.config[f.key] ?? '';
        }
      }
      await api.putAdminSettings(body as never);
      flash(t('docsources.saved'));
      setSpDraft(null);
      await load();
    } catch (e) {
      flash(t('docsources.saveFailed', { message: (e as Error).message }));
    } finally {
      setSpSaving(false);
    }
  };

  const runSpTest = async () => {
    const id = spProjectId.trim();
    if (!id) return;
    setSpTesting(true);
    setSpTestResult(null);
    try {
      const r = await api.testSharePointFileSource(id);
      setSpTestResult({ ok: r.ok, message: r.message });
    } catch (e) {
      setSpTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setSpTesting(false);
    }
  };

  /**
   * Formulaire d'édition d'un fournisseur (+ panneau WIF pour Google Chat).
   * Rendu INLINE — juste sous la carte éditée pour un fournisseur configuré,
   * ou en bas pour l'ajout d'un nouveau fournisseur (pas encore de carte). Sans
   * ça, éditer une carte ouvrait l'éditeur tout en bas de la page (mauvais UX).
   */
  const collabDraftForm =
    draft && activeDesc ? (
      <>
        <ConnectorDraftForm
          provider={activeDesc}
          draft={draft}
          setDraft={(fn) => setDraft((d) => (d ? fn(d) : d))}
          saving={saving}
          onCancel={() => setDraft(null)}
          onSave={save}
          isEdit={activeConfigured}
          hideLabel
          labels={{
            editTitle: t('collab.editTitle', { name: activeDesc.label }),
            newTitle: t('collab.newTitle', { name: activeDesc.label }),
            labelField: '',
            enableField: t('collab.enableField'),
          }}
        />
        {/* Panneau Workload Identity : sous le formulaire Google Chat en mode
            « wif ». Générer la clé ne dépend d'aucune config préalable. */}
        {(draft.providerKey === 'gchat' || draft.providerKey === 'gdrive') &&
          draft.config[`${draft.providerKey}.provisioning.authMode`] === 'wif' && (
            <div className="asection-card" style={{ padding: '12px 14px' }}>
              <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--text-2)', marginBottom: 2 }}>
                Workload Identity Federation
              </div>
              {renderWifPanel(`${draft.providerKey}.provisioning`)}
            </div>
          )}
      </>
    ) : null;
  // Le draft cible-t-il un fournisseur déjà affiché en carte ? (→ rendu inline)
  const draftHasCard = !!draft && configuredProviders.some((cp) => cp.key === draft.providerKey);

  return (
    <div className="asection-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('collab.intro')}</div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('common:loading')}</div>
      ) : (
        <>
          {configuredProviders.length === 0 && !draft && (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('collab.empty')}</div>
          )}

          {/* Une carte par fournisseur configuré (Teams et/ou Slack aujourd'hui). */}
          {configuredProviders.map((p) => {
            const result = testResults[p.key];
            return (
              <div key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <ConnectorCard
                title={p.label}
                provider={p}
                status={{
                  on: values[p.enabledKey] === true,
                  onLabel: t('collab.statusEnabled'),
                  offLabel: t('collab.statusDisabled'),
                }}
                actions={[
                  {
                    key: 'test',
                    label: testingKey === p.key ? t('collab.testing') : t('collab.test'),
                    onClick: () => runTest(p),
                    disabled: testingKey === p.key,
                  },
                  { key: 'edit', label: t('common:edit'), onClick: () => startEdit(p) },
                  { key: 'delete', label: t('common:delete'), onClick: () => removeProvider(p), disabled: saving, danger: true },
                ]}
                meta={p.cardMeta?.(values)}
              >
                {result && (
                  <div style={{ fontSize: 12, color: result.ok ? 'var(--ok, #3fb950)' : 'var(--danger, #f85149)' }}>
                    {result.message}
                  </div>
                )}

                {/* Provisionner un projet DÉJÀ actif : le hook automatique ne se
                    déclenche qu'à l'entrée en ACTIVE. Affiché seulement si le
                    fournisseur est configuré ET activé. */}
                {p.onProvision && p.isConfigured(values) && values[p.enabledKey] === true && (
                  <div
                    style={{
                      marginTop: 4, paddingTop: 10, borderTop: '1px dashed var(--border)',
                      display: 'flex', flexDirection: 'column', gap: 8,
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{t('collab.provisionHelp')}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        className="td-in"
                        value={provisionProjectId[p.key] ?? ''}
                        onChange={(e) =>
                          setProvisionProjectId((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                        placeholder={t('collab.provisionProjectIdPlaceholder')}
                        style={{ flex: '1 1 260px', minWidth: 0, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
                      />
                      <button
                        className="btn btn-ghost"
                        onClick={() => runProvision(p)}
                        disabled={provisioningKey === p.key || !(provisionProjectId[p.key] ?? '').trim()}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <Icon name="plus" size={14} />{' '}
                        {provisioningKey === p.key ? t('common:loading') : t('collab.provisionNow')}
                      </button>
                    </div>
                    {provisionResults[p.key] && (
                      <div
                        style={{
                          fontSize: 12,
                          color: provisionResults[p.key].ok ? 'var(--ok, #3fb950)' : 'var(--danger, #f85149)',
                        }}
                      >
                        {provisionResults[p.key].message}
                      </div>
                    )}
                  </div>
                )}
              </ConnectorCard>
                {/* Éditeur inline : juste sous la carte du fournisseur édité. */}
                {draft?.providerKey === p.key && collabDraftForm}
              </div>
            );
          })}

          {/* ---- Carte autonome : lecture documentaire SharePoint ----
              Rendue INDÉPENDAMMENT de la config du provisioning Teams sortant :
              le contexte documentaire réutilise l'identité Graph de Teams mais se
              configure et se teste séparément. (Auparavant imbriqué dans la carte
              Teams, donc invisible tant que Teams n'était pas configuré — régression.) */}
          <ConnectorCard
            title={SP_PROVIDER.label}
            provider={SP_PROVIDER}
            status={{ on: spEnabled, onLabel: t('docsources.statusEnabled'), offLabel: t('docsources.statusDisabled') }}
            actions={
              spConfigured
                ? [
                    { key: 'configure', label: t('collab.spConfigure'), onClick: startSpEdit },
                    { key: 'delete', label: t('common:delete'), onClick: removeSharepoint, disabled: spSaving, danger: true },
                  ]
                : [{ key: 'configure', label: t('collab.spConfigure'), onClick: startSpEdit }]
            }
            meta={<div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{t('collab.spBlurb')}</div>}
          >
            {!teamsConfigured && (
              <div style={{ fontSize: 11.5, color: 'var(--warn, #d29922)', lineHeight: 1.5 }}>
                {t('collab.spNeedsTeams')}
              </div>
            )}

            {/* Outil de test : lit un document du site de l'équipe d'un projet. */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="td-in"
                value={spProjectId}
                onChange={(e) => setSpProjectId(e.target.value)}
                placeholder={t('docsources.sp.projectIdPlaceholder')}
                style={{ flex: '1 1 240px', minWidth: 0, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
              />
              <button
                className="btn btn-ghost"
                onClick={runSpTest}
                disabled={spTesting || !spProjectId.trim()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Icon name="shield" size={14} /> {spTesting ? t('common:loading') : t('docsources.sp.test')}
              </button>
            </div>
            {spTestResult && (
              <div
                className="pill"
                style={{
                  alignSelf: 'flex-start', background: 'var(--surface-2)',
                  color: spTestResult.ok ? 'var(--ok, #3fb950)' : 'var(--danger, #f85149)',
                  maxWidth: '100%', whiteSpace: 'normal', lineHeight: 1.4,
                }}
              >
                {spTestResult.ok ? '✓ ' : '✕ '}
                {spTestResult.message}
              </div>
            )}
          </ConnectorCard>

          {spDraft && (
            <ConnectorDraftForm
              provider={SP_PROVIDER}
              draft={spDraft}
              setDraft={(fn) => setSpDraft((d) => (d ? fn(d) : d))}
              saving={spSaving}
              onCancel={() => setSpDraft(null)}
              onSave={saveSp}
              isEdit
              hideLabel
              labels={{
                editTitle: t('docsources.editTitle', { name: SP_PROVIDER.label }),
                newTitle: t('docsources.editTitle', { name: SP_PROVIDER.label }),
                labelField: '',
                enableField: t('docsources.enableField'),
              }}
            />
          )}

          {/* Ajout d'un NOUVEAU fournisseur (pas encore de carte) : l'éditeur
              s'affiche ici, au-dessus du bouton « Ajouter ». Un fournisseur déjà
              configuré est édité INLINE sous sa carte (voir la boucle ci-dessus). */}
          {draft && !draftHasCard && collabDraftForm}

          {!draft && (
            <div>
              <button
                className="btn btn-ghost"
                onClick={() => setPicking(true)}
                disabled={pickerProviders.length === 0}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              >
                <Icon name="plus" size={15} /> {t('collab.addButton')}
              </button>
            </div>
          )}

          {/* ---- Inbound : un outil externe déclare l'espace qu'il a créé ---- */}
          {showInbound && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4, color: 'var(--text-2)' }}>
                {t('collab.inboundHeading')}
              </div>
              <InboundConnectorCard
                tile={inboundProvider}
                title={t('collab.inbound.title')}
                blurb={t('collab.inbound.blurb')}
                endpoints={[
                  { method: 'PUT', path: '/api/v1/projects/{projectId}/collab-spaces/{provider}', desc: t('collab.inbound.epPut') },
                  { method: 'GET', path: '/api/v1/projects/{projectId}/collab-spaces', desc: t('collab.inbound.epGet') },
                  { method: 'DELETE', path: '/api/v1/projects/{projectId}/collab-spaces/{provider}', desc: t('collab.inbound.epDelete') },
                ]}
                scopes={INBOUND_COLLAB_SCOPES}
                purposePrefix={INBOUND_COLLAB_PREFIX}
                keys={inboundKeys}
                onMint={(dto) =>
                  api.createOrgApiToken({
                    name: `${INBOUND_COLLAB_PREFIX}${dto.label || dto.expiresAt}`,
                    scopes: INBOUND_COLLAB_SCOPES,
                    expiresAt: dto.expiresAt,
                  })
                }
                onRevoke={(id) => api.deleteOrgApiToken(id)}
                onChanged={load}
                onDismiss={() => setInboundAdded(false)}
                flash={flash}
              />
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('collab.inbound.triggerHint')}</div>
            </>
          )}

          {/* ---- Sources documentaires autonomes (Google Drive / S3 / WebDAV) ----
              Ex-section « Document sources », rapatriée ici. Ne rend rien tant
              qu'aucune source à connecteur autonome n'existe (SharePoint est déjà
              porté par la carte Teams ci-dessus). */}
          <DocumentSourcesSection embedded flash={flash} />
        </>
      )}

      {picking && (
        <ProviderPickerModal
          providers={pickerProviders}
          onPick={(p) => {
            setPicking(false);
            if (p.key === INBOUND_COLLAB_KEY) {
              setInboundAdded(true);
              return;
            }
            // Le picker partagé travaille en `NormalizedProvider` ; à ce point
            // (clé ≠ inbound) `p` vient forcément de `PROVIDERS` (un `CollabProvider`).
            startEdit(p as CollabProvider);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
