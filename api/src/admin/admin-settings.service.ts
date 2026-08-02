import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { normalizeAgentPolicies } from '@vaks-pm/shared';
import { normalizeAgentBrief } from '../agents/context/agent-brief';
import type { LicenseFeature } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import {
  AUDIT_ACTIONS,
  SECURITY_SETTING_PREFIXES,
  severityForAction,
} from '../audit-logs/audit-actions';
import { auditDiff } from '../audit-logs/audit-sanitize';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { LicenseService } from '../licensing/license.service';
import { validateAutomationSettings } from '../automations/automations-settings';
import type { EntraCredential } from '../common/entra/client-assertion';

/**
 * Settings « secret » : stockés chiffrés at-rest sous une clé `…Enc`, alimentés
 * via une clé write-only en clair (`plainKey`), jamais ré-émis dans les lectures
 * admin (remplacés par un booléen `…Set`). Même philosophie que
 * `IdentityProvider.oidcClientSecretEnc`.
 */
export const SECRET_SETTINGS: { plainKey: string; encKey: string; setKey: string }[] = [
  {
    plainKey: 'teams.provisioning.clientSecret',
    encKey: 'teams.provisioning.clientSecretEnc',
    setKey: 'teams.provisioning.clientSecretSet',
  },
  {
    // Secret de l'app « lecteur » SharePoint (mode d'identité `selected_granter`).
    // App minimale scopée `Sites.Selected` par laquelle transitent les lectures
    // agents ; le grant `read` lui est posé par l'app de provisioning (FullControl).
    plainKey: 'teams.provisioning.reader.clientSecret',
    encKey: 'teams.provisioning.reader.clientSecretEnc',
    setKey: 'teams.provisioning.reader.clientSecretSet',
  },
  {
    // Clé privée PKCS#8 (PEM) de l'app de provisioning en mode **certificat**
    // (private_key_jwt). Alternative secretless au client secret : renseignée
    // avec `teams.provisioning.certThumbprint`, elle prend le pas sur le secret.
    plainKey: 'teams.provisioning.privateKey',
    encKey: 'teams.provisioning.privateKeyEnc',
    setKey: 'teams.provisioning.privateKeySet',
  },
  {
    // Clé privée PKCS#8 (PEM) de l'app « lecteur » SharePoint en mode certificat.
    plainKey: 'teams.provisioning.reader.privateKey',
    encKey: 'teams.provisioning.reader.privateKeyEnc',
    setKey: 'teams.provisioning.reader.privateKeySet',
  },
  {
    // Mot de passe du relais SMTP, saisi depuis l'admin (write-only, chiffré
    // at-rest, jamais ré-affiché). Résolu par tenant à l'enqueue et transmis au
    // worker dans le job email. Fallback : secret Swarm `SMTP_PASSWORD`.
    plainKey: 'smtp.password',
    encKey: 'smtp.passwordEnc',
    setKey: 'smtp.passwordSet',
  },
  {
    // Bot token Slack (`xoxb-…`) du provisioning d'espaces de collaboration :
    // crée un canal à l'activation du projet et invite les membres. Write-only,
    // chiffré at-rest, résolu par tenant côté service.
    plainKey: 'slack.provisioning.botToken',
    encKey: 'slack.provisioning.botTokenEnc',
    setKey: 'slack.provisioning.botTokenSet',
  },
  {
    // Clé privée PKCS#8 (PEM) du compte de service Google Chat (provisioning
    // d'espaces de collaboration, 3ᵉ fournisseur) — signe l'assertion
    // JWT-bearer échangée contre un jeton d'accès (délégation domain-wide,
    // impersonation `gchat.provisioning.subjectEmail`). Write-only, chiffrée
    // at-rest, résolue par tenant côté service.
    plainKey: 'gchat.provisioning.privateKey',
    encKey: 'gchat.provisioning.privateKeyEnc',
    setKey: 'gchat.provisioning.privateKeySet',
  },
  {
    // Clé privée RS256 (PKCS#8 PEM) que NOUS détenons en mode Workload Identity
    // Federation (Google Chat sans clé de compte de service). Signe le JWT OIDC
    // self-issued présenté à STS ; Google n'en connaît que le JWKS public collé
    // dans la config du pool. Générée par l'app (bouton admin), jamais saisie à
    // la main, chiffrée at-rest, jamais ré-affichée. Le JWKS public, lui, n'est
    // pas secret et est exposé en clair (`gchat.provisioning.wifJwksPublic`).
    plainKey: 'gchat.provisioning.wifSigningKey',
    encKey: 'gchat.provisioning.wifSigningKeyEnc',
    setKey: 'gchat.provisioning.wifSigningKeySet',
  },
  {
    // Clé privée PKCS#8 (PEM) du compte de service Google Drive (provisioning
    // d'un Drive partagé par projet, 4ᵉ fournisseur). Namespace distinct de
    // Google Chat : un client peut provisionner des Drives sans activer Chat.
    // Write-only, chiffrée at-rest, résolue par tenant côté service.
    plainKey: 'gdrive.provisioning.privateKey',
    encKey: 'gdrive.provisioning.privateKeyEnc',
    setKey: 'gdrive.provisioning.privateKeySet',
  },
  {
    // Clé privée RS256 que NOUS détenons en mode Workload Identity Federation
    // pour le provisioning Drive (générée par le bouton admin, jamais saisie).
    // Le JWKS public correspondant (`gdrive.provisioning.wifJwksPublic`) n'est
    // pas secret et reste exposé en clair.
    plainKey: 'gdrive.provisioning.wifSigningKey',
    encKey: 'gdrive.provisioning.wifSigningKeyEnc',
    setKey: 'gdrive.provisioning.wifSigningKeySet',
  },
];

/** Langues d'interface supportées (axe distinct de la locale de formatage). */
const SUPPORTED_LANGUAGES = ['en', 'fr', 'it', 'de'];

/**
 * Settings genéres org-scopés (key/value JSON). Stockage générique pour
 * le panneau d'administration. Quelques clés ont une sémantique forte et
 * sont consommées par d'autres modules :
 *   - hoursPerDay      (number)   capacité par défaut d'un jour ouvré
 *   - defaultWorkDays  (object)   { mon..sun: boolean } — défaut Mon-Fri
 * Les autres clés sont du transport pur (UI ↔ DB).
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly licenses: LicenseService,
  ) {}

  /**
   * Gate licence des toggles premium **opt-in** (OFF par défaut) : on ne peut
   * pas *activer* le forwarder SIEM (`siem-export`) ni l'archivage froid
   * (`audit-advanced`) sans le droit correspondant. 403 `LICENSE_FEATURE_DISABLED`.
   * Les features toujours-actives (ancre d'intégrité, alerting brute-force) sont
   * gatées au **runtime** (cron / service), pas ici. Ne bloque jamais la
   * *désactivation* ni les écritures qui ne touchent pas au toggle.
   */
  private async assertLicensedToggles(values: Record<string, unknown>): Promise<void> {
    const truthy = (v: unknown) => v === true || v === 'true';
    const gated: { key: string; feature: LicenseFeature }[] = [
      { key: 'audit.syslog.enabled', feature: 'siem-export' },
      { key: 'audit.archive.enabled', feature: 'audit-advanced' },
    ];
    for (const g of gated) {
      if (g.key in values && truthy(values[g.key]) && !(await this.licenses.hasFeature(g.feature))) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'LICENSE_FEATURE_DISABLED',
          message:
            `Activer ce réglage requiert une licence active (« ${g.feature} »). ` +
            `Contactez votre éditeur pour l'activer.`,
          feature: g.feature,
        });
      }
    }
  }

  /** Validation du réglage `customFields.writeMode` (mêmes modes que skills). */
  private validateCustomFieldSettings(values: Record<string, unknown>) {
    for (const key of ['customFields.writeMode', 'customStatuses.writeMode'] as const) {
      if (key in values) {
        const v = values[key];
        if (v != null && v !== '' && !['admin', 'portfolio_manager', 'team_lead', 'everyone'].includes(String(v))) {
          throw new BadRequestException(`${key} invalide : ${String(v)}`);
        }
      }
    }
  }

  private tokenize(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  /**
   * Validation forte des réglages webhooks.* AVANT persistance : un GUID Entra
   * malformé ou un domaine invalide est rejeté avec un message clair, plutôt
   * que silencieusement ignoré à la lecture (fausse impression de sécurité).
   */
  private validateWebhookSettings(values: Record<string, unknown>) {
    if ('webhooks.managePolicy' in values) {
      const v = values['webhooks.managePolicy'];
      if (v != null && v !== '' && !['admin', 'portfolio_manager', 'project_manager'].includes(String(v))) {
        throw new BadRequestException(`webhooks.managePolicy invalide : ${String(v)}`);
      }
    }
    if ('webhooks.entraTenantAllowlist' in values) {
      const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const bad = this.tokenize(values['webhooks.entraTenantAllowlist']).filter((t) => !GUID.test(t));
      if (bad.length) {
        throw new BadRequestException(
          `Tenant Entra invalide (GUID 8-4-4-4-12 attendu) : ${bad.join(', ')}`,
        );
      }
    }
    if ('webhooks.domainAllowlist' in values) {
      const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
      const bad = this.tokenize(values['webhooks.domainAllowlist'])
        .map((d) => d.replace(/^\*\./, ''))
        .filter((d) => !HOST.test(d));
      if (bad.length) {
        throw new BadRequestException(`Domaine invalide : ${bad.join(', ')}`);
      }
    }
  }

  /**
   * Validation forte des réglages audit.* (SIEM/syslog + rétention) AVANT
   * persistance — même philosophie que validateWebhookSettings.
   */
  private validateAuditSettings(values: Record<string, unknown>) {
    if ('audit.syslog.host' in values) {
      const v = String(values['audit.syslog.host'] ?? '').trim();
      const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
      const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
      if (v && !HOST.test(v) && !IPV4.test(v)) {
        throw new BadRequestException(`Hôte syslog invalide : ${v}`);
      }
    }
    if ('audit.syslog.port' in values && values['audit.syslog.port'] != null && values['audit.syslog.port'] !== '') {
      const n = Number(values['audit.syslog.port']);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new BadRequestException(`Port syslog invalide : ${String(values['audit.syslog.port'])}`);
      }
    }
    if ('audit.syslog.protocol' in values) {
      const v = values['audit.syslog.protocol'];
      if (v != null && v !== '' && !['tcp', 'tls'].includes(String(v))) {
        throw new BadRequestException(`Protocole syslog invalide : ${String(v)} (tcp|tls)`);
      }
    }
    if ('audit.syslog.minSeverity' in values) {
      const v = values['audit.syslog.minSeverity'];
      if (v != null && v !== '' && !['INFO', 'WARNING', 'CRITICAL'].includes(String(v))) {
        throw new BadRequestException(`Sévérité minimale invalide : ${String(v)}`);
      }
    }
    if ('audit.syslog.caPem' in values) {
      const v = String(values['audit.syslog.caPem'] ?? '').trim();
      if (v && !v.includes('-----BEGIN CERTIFICATE-----')) {
        throw new BadRequestException('CA invalide : un certificat PEM est attendu');
      }
    }
    if ('audit.syslog.clientCertPem' in values) {
      const v = String(values['audit.syslog.clientCertPem'] ?? '').trim();
      if (v && !v.includes('-----BEGIN CERTIFICATE-----')) {
        throw new BadRequestException('Certificat client invalide : un certificat PEM est attendu');
      }
    }
    if ('audit.retentionDays' in values && values['audit.retentionDays'] != null && values['audit.retentionDays'] !== '') {
      const n = Number(values['audit.retentionDays']);
      if (!Number.isInteger(n) || n < 30 || n > 3650) {
        throw new BadRequestException('Rétention du journal d’audit : entre 30 et 3650 jours');
      }
    }
    if ('audit.alerts.loginFailures.threshold' in values && values['audit.alerts.loginFailures.threshold'] != null && values['audit.alerts.loginFailures.threshold'] !== '') {
      const n = Number(values['audit.alerts.loginFailures.threshold']);
      if (!Number.isInteger(n) || n < 3 || n > 50) {
        throw new BadRequestException('Seuil d’alerte brute-force : entre 3 et 50 échecs');
      }
    }
    if ('audit.alerts.loginFailures.windowMinutes' in values && values['audit.alerts.loginFailures.windowMinutes'] != null && values['audit.alerts.loginFailures.windowMinutes'] !== '') {
      const n = Number(values['audit.alerts.loginFailures.windowMinutes']);
      if (!Number.isInteger(n) || n < 1 || n > 120) {
        throw new BadRequestException('Fenêtre d’alerte brute-force : entre 1 et 120 minutes');
      }
    }
  }

  /**
   * Validation forte des réglages agents.* (moteur de policies, chantier 3).
   * `agents.policies` est **normalisé en place** (règles malformées rejetées avec
   * un message clair, jamais persistées silencieusement) ; le seuil de
   * backpressure est borné [0, 1000].
   */
  private validateAgentSettings(values: Record<string, unknown>) {
    if ('agents.policies' in values) {
      const raw = values['agents.policies'];
      if (raw != null) {
        if (!Array.isArray(raw)) {
          throw new BadRequestException('agents.policies doit être un tableau de règles.');
        }
        const normalized = normalizeAgentPolicies(raw);
        if (normalized.length !== raw.length) {
          throw new BadRequestException(
            `agents.policies : ${raw.length - normalized.length} règle(s) invalide(s) ` +
              `(action inconnue, condition manquante ou vide).`,
          );
        }
        // Persiste la version normalisée (canonique) plutôt que le brut posté.
        values['agents.policies'] = normalized as unknown;
      }
    }
    if ('agents.briefDefault' in values) {
      const raw = values['agents.briefDefault'];
      if (raw != null && raw !== '') {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          throw new BadRequestException(
            'agents.briefDefault doit être un objet { role, outputConventions, deliveryTarget, outOfScope }.',
          );
        }
        // Persiste la version normalisée : clés inconnues jetées, champs trimés
        // et capés. Un brief tout-vide devient `null` plutôt qu'un objet creux.
        values['agents.briefDefault'] = normalizeAgentBrief(raw) as unknown;
      }
    }
    if (
      'agents.backpressure.maxPendingReviews' in values &&
      values['agents.backpressure.maxPendingReviews'] != null &&
      values['agents.backpressure.maxPendingReviews'] !== ''
    ) {
      const n = Number(values['agents.backpressure.maxPendingReviews']);
      if (!Number.isInteger(n) || n < 0 || n > 1000) {
        throw new BadRequestException(
          'agents.backpressure.maxPendingReviews : entier entre 0 (illimité) et 1000.',
        );
      }
      values['agents.backpressure.maxPendingReviews'] = n;
    }
    // Bail d'exécution (lot A) : minutes. `0` = désactivé (choix explicite) ;
    // sinon borné [5, 1440] — un bail d'une minute faucherait un agent au
    // travail, un bail d'une semaine ne libère jamais rien.
    if (
      'agents.executionLeaseMinutes' in values &&
      values['agents.executionLeaseMinutes'] != null &&
      values['agents.executionLeaseMinutes'] !== ''
    ) {
      const n = Number(values['agents.executionLeaseMinutes']);
      if (!Number.isInteger(n) || n < 0 || n > 1440 || (n > 0 && n < 5)) {
        throw new BadRequestException(
          'agents.executionLeaseMinutes : 0 (désactivé) ou entier entre 5 et 1440 minutes.',
        );
      }
      values['agents.executionLeaseMinutes'] = n;
    }
  }

  /**
   * Validation forte des réglages teams.provisioning.* (provisioning Microsoft
   * Teams) AVANT persistance — GUID tenant/app, enums membership/visibility.
   */
  private validateTeamsProvisioningSettings(values: Record<string, unknown>) {
    const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const k of ['teams.provisioning.tenantId', 'teams.provisioning.clientId']) {
      if (k in values) {
        const v = String(values[k] ?? '').trim();
        if (v && !GUID.test(v)) {
          throw new BadRequestException(`${k} invalide : GUID Entra 8-4-4-4-12 attendu`);
        }
      }
    }
    if ('teams.provisioning.visibility' in values) {
      const v = values['teams.provisioning.visibility'];
      if (v != null && v !== '' && !['private', 'public'].includes(String(v))) {
        throw new BadRequestException(`teams.provisioning.visibility invalide : ${String(v)} (private|public)`);
      }
    }
    if ('teams.provisioning.membership' in values) {
      const v = values['teams.provisioning.membership'];
      if (v != null && v !== '' && !['assigned_teams', 'project_members', 'both'].includes(String(v))) {
        throw new BadRequestException(`teams.provisioning.membership invalide : ${String(v)}`);
      }
    }
    if ('teams.provisioning.channelLayout' in values) {
      const v = values['teams.provisioning.channelLayout'];
      if (v != null && v !== '' && !['post', 'chat'].includes(String(v))) {
        throw new BadRequestException(
          `teams.provisioning.channelLayout invalide : ${String(v)} (post|chat)`,
        );
      }
    }
    if ('teams.provisioning.namePattern' in values) {
      const v = String(values['teams.provisioning.namePattern'] ?? '').trim();
      // Teams limite le displayName à 256 caractères ; on garde une marge pour le rendu.
      if (v.length > 240) {
        throw new BadRequestException('teams.provisioning.namePattern trop long (max 240 caractères)');
      }
    }
    // Contexte documentaire SharePoint pour les agents IA.
    if ('teams.provisioning.sharepoint.identityMode' in values) {
      const v = values['teams.provisioning.sharepoint.identityMode'];
      if (v != null && v !== '' && !['read_all', 'selected_granter'].includes(String(v))) {
        throw new BadRequestException(
          `teams.provisioning.sharepoint.identityMode invalide : ${String(v)} (read_all|selected_granter)`,
        );
      }
    }
    if ('teams.provisioning.reader.clientId' in values) {
      const v = String(values['teams.provisioning.reader.clientId'] ?? '').trim();
      if (v && !GUID.test(v)) {
        throw new BadRequestException('teams.provisioning.reader.clientId invalide : GUID Entra attendu');
      }
    }
  }

  /**
   * Config résolue du provisioning Microsoft Teams (feature premium
   * `teams-provisioning`). Le **client secret** n'est PAS renvoyé ici : il vit
   * dans l'OrgSetting `teams.provisioning.clientSecretEnc`, **chiffré at-rest**
   * (AES-256-GCM, par tenant — cf. SECRET_SETTINGS) et se lit via
   * `getDecryptedSecret('teams.provisioning.clientSecret')`. (Il n'y a PAS de
   * secret Swarm `msgraph_client_secret` : cette piste v1 a été abandonnée.)
   */
  async getTeamsProvisioningConfig(orgId: string): Promise<TeamsProvisioningConfig> {
    const all = await this.getAll(orgId);
    const str = (k: string, d = '') => {
      const v = all[k];
      return typeof v === 'string' ? v.trim() : d;
    };
    const membership = String(all['teams.provisioning.membership'] ?? 'both');
    const visibility = String(all['teams.provisioning.visibility'] ?? 'private');
    return {
      enabled: all['teams.provisioning.enabled'] === true,
      tenantId: str('teams.provisioning.tenantId'),
      clientId: str('teams.provisioning.clientId'),
      namePattern: str('teams.provisioning.namePattern') || '[PROJECT] - {{project.name}}',
      channels: this.tokenize(all['teams.provisioning.channels']).slice(0, 20),
      channelLayout: String(all['teams.provisioning.channelLayout'] ?? 'post') === 'chat' ? 'chat' : 'post',
      visibility: visibility === 'public' ? 'public' : 'private',
      membership: ['assigned_teams', 'project_members', 'both'].includes(membership)
        ? (membership as TeamsProvisioningConfig['membership'])
        : 'both',
      removeOnLeave: all['teams.provisioning.removeOnLeave'] === true,
      archiveOnClose: all['teams.provisioning.archiveOnClose'] !== false,
    };
  }

  /**
   * Config du contexte documentaire SharePoint (lecture du drive de la team
   * provisionnée par les agents IA). Réutilise l'identité Graph du provisioning
   * Teams (`tenantId`/`clientId`/client secret). `identityMode` :
   *  - `read_all`         : l'app provisioning porte `Sites.Read.All` (lecture large
   *                         côté Graph, filtrage réel par vaks-pm) ;
   *  - `selected_granter` : app « lecteur » minimale (`Sites.Selected`) + l'app
   *                         provisioning (`Sites.FullControl.All`) pose le grant.
   */
  async getSharePointContextConfig(orgId: string): Promise<SharePointContextConfig> {
    const all = await this.getAll(orgId);
    const str = (k: string, d = '') => {
      const v = all[k];
      return typeof v === 'string' ? v.trim() : d;
    };
    const mode = String(all['teams.provisioning.sharepoint.identityMode'] ?? 'read_all');
    return {
      enabled: all['teams.provisioning.sharepointContext.enabled'] === true,
      identityMode: mode === 'selected_granter' ? 'selected_granter' : 'read_all',
      readerClientId: str('teams.provisioning.reader.clientId'),
    };
  }

  /**
   * Résout la credential Entra (secret OU certificat) d'une app registration
   * Graph. La **présence d'une clé privée** (+ empreinte) sous `<prefix>.privateKey`
   * fait basculer en `private_key_jwt` (secretless) ; à défaut on retombe sur le
   * client secret `<prefix>.clientSecret`. `prefix` = `teams.provisioning` ou
   * `teams.provisioning.reader`. Jette si une clé privée est posée sans empreinte.
   */
  async resolveGraphCredential(
    orgId: string,
    tenantId: string,
    clientId: string,
    prefix: 'teams.provisioning' | 'teams.provisioning.reader',
  ): Promise<EntraCredential> {
    const privateKeyPem = await this.getDecryptedSecret(orgId, `${prefix}.privateKey`);
    if (privateKeyPem) {
      const thumbprint = String((await this.getValue(orgId, `${prefix}.certThumbprint`)) ?? '').trim();
      if (!thumbprint) {
        throw new BadRequestException(
          `${prefix}.certThumbprint requis : renseignez l'empreinte du certificat Entra avec la clé privée.`,
        );
      }
      return { tenantId, clientId, authMethod: 'client_assertion', privateKeyPem, thumbprint };
    }
    const clientSecret = await this.getDecryptedSecret(orgId, `${prefix}.clientSecret`);
    return { tenantId, clientId, authMethod: 'client_secret', clientSecret };
  }

  /**
   * Contexte de LECTURE Google Drive, dérivé de la config de PROVISIONING
   * (`gdrive.provisioning.*`). Google Drive est `managedElsewhere` : la lecture
   * (scope `drive.readonly` ⊂ `drive`) réutilise l'identité qui a créé les Shared
   * Drives par projet — **aucun connecteur « Document source » séparé à
   * configurer**. Renvoie `config`/`secret` au format exact attendu par
   * `GoogleDriveProvider` (recompose le blob JSON `serviceAccountKey` en sa_key,
   * puisque le provisioning stocke email + clé PEM séparément).
   */
  async getGoogleDriveReadContext(
    orgId: string,
  ): Promise<{ enabled: boolean; hasCredential: boolean; config: Record<string, unknown>; secret: Record<string, string> }> {
    const all = await this.getAll(orgId);
    const str = (k: string) => (typeof all[k] === 'string' ? (all[k] as string).trim() : '');
    const enabled = all['gdrive.provisioning.enabled'] === true;
    const authMode = all['gdrive.provisioning.authMode'] === 'wif' ? 'wif' : 'sa_key';
    const subject = str('gdrive.provisioning.subjectEmail');
    const serviceAccountEmail = str('gdrive.provisioning.serviceAccountEmail');

    if (authMode === 'wif') {
      const wifSigningKey = await this.getDecryptedSecret(orgId, 'gdrive.provisioning.wifSigningKey');
      return {
        enabled,
        hasCredential: !!(wifSigningKey && serviceAccountEmail && subject),
        config: {
          authMode: 'wif',
          serviceAccountEmail,
          impersonateSubject: subject,
          wifAudience: str('gdrive.provisioning.wifAudience'),
          wifIssuer: str('gdrive.provisioning.wifIssuer'),
          wifKeyId: str('gdrive.provisioning.wifKeyId'),
        },
        secret: wifSigningKey ? { wifSigningKey } : {},
      };
    }

    // sa_key : recompose le JSON `{ client_email, private_key }` attendu par le provider.
    const privateKeyPem = await this.getDecryptedSecret(orgId, 'gdrive.provisioning.privateKey');
    const serviceAccountKey =
      privateKeyPem && serviceAccountEmail
        ? JSON.stringify({ client_email: serviceAccountEmail, private_key: privateKeyPem })
        : '';
    return {
      enabled,
      hasCredential: !!serviceAccountKey,
      config: { authMode: 'sa_key', impersonateSubject: subject },
      secret: serviceAccountKey ? { serviceAccountKey } : {},
    };
  }

  /**
   * Config de l'alerte brute-force (journal d'audit) : N échecs de login sur
   * un même compte en X minutes → email admins + webhook `audit.alert`.
   * Activée par défaut (sécurité opt-out).
   */
  async getAuditAlertLoginFailures(
    orgId: string,
  ): Promise<{ enabled: boolean; threshold: number; windowMinutes: number }> {
    const all = await this.getAll(orgId);
    const enabled = all['audit.alerts.loginFailures.enabled'] !== false;
    const t = Number(all['audit.alerts.loginFailures.threshold']);
    const w = Number(all['audit.alerts.loginFailures.windowMinutes']);
    return {
      enabled,
      threshold: Number.isInteger(t) && t >= 3 && t <= 50 ? t : 5,
      windowMinutes: Number.isInteger(w) && w >= 1 && w <= 120 ? w : 10,
    };
  }

  /** Config de l'export facturation planifié. */
  async getBillingExportSchedule(orgId: string): Promise<{
    enabled: boolean;
    frequency: 'weekly' | 'monthly';
    weekDay: number;   // 1=Lun … 7=Dim
    monthDay: number;  // 1–28
    hour: number;      // 0–23 UTC
    format: 'csv' | 'xlsx';
    recipients: string[];
  }> {
    const all = await this.getAll(orgId);
    const freq = String(all['billing.export.frequency'] ?? 'monthly');
    const weekDay = Math.max(1, Math.min(7, Number(all['billing.export.weekDay']) || 1));
    const monthDay = Math.max(1, Math.min(28, Number(all['billing.export.monthDay']) || 1));
    const hour = Math.max(0, Math.min(23, Number(all['billing.export.hour']) || 7));
    const rawRec = String(all['billing.export.recipients'] ?? '');
    const recipients = rawRec.split(',').map((e) => e.trim()).filter((e) => e.includes('@'));
    return {
      enabled: all['billing.export.enabled'] === true,
      frequency: freq === 'weekly' ? 'weekly' : 'monthly',
      weekDay,
      monthDay,
      hour,
      format: all['billing.export.format'] === 'csv' ? 'csv' : 'xlsx',
      recipients,
    };
  }

  /** Rétention du journal d'audit en jours (clamp 30–3650, défaut 365). */
  async getAuditRetentionDays(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'audit.retentionDays');
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 30 && n <= 3650) return Math.floor(n);
    return 365;
  }

  /**
   * Auto-purge des enregistrements soft-deleted activée ? (Data Management)
   * Défaut : **`false`** (OFF) — rien n'est jamais effacé automatiquement tant
   * qu'un admin n'active pas explicitement l'option (produit auto-hébergé :
   * la suppression définitive automatique est un opt-in). Le bouton manuel
   * « Purge now » reste toujours disponible.
   */
  async getAutoPurgeEnabled(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'autoPurge');
    return v === true;
  }

  /**
   * Délai de grâce avant qu'un enregistrement soft-deleted soit définitivement
   * effacé par le cron d'auto-purge. Stocké en **années** dans `OrgSetting`
   * (borné 1–30, défaut 10) ; renvoyé en **jours** pour le calcul du cutoff.
   * N'affecte QUE l'auto-purge — la purge manuelle ignore ce délai.
   */
  async getPurgeAfterDays(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'purgeAfter');
    const years = typeof v === 'number' ? v : parseInt(String(v), 10);
    const y = Number.isFinite(years) && years >= 1 && years <= 30 ? Math.floor(years) : 10;
    return y * 365;
  }

  /** Retourne tous les settings sous forme d'objet `{ key: value }`. Inclut les
   *  valeurs chiffrées `…Enc` — usage **interne** uniquement (accessors). Pour
   *  une lecture exposée à l'admin, utiliser `getAllForAdmin`. */
  async getAll(orgId: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.orgSetting.findMany({
      where: { organizationId: orgId },
    });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value as unknown;
    return out;
  }

  /** Lecture destinée au panneau admin : masque les secrets chiffrés (`…Enc`
   *  retiré, remplacé par un booléen `…Set`). Le secret en clair n'existe jamais
   *  en lecture. */
  async getAllForAdmin(orgId: string): Promise<Record<string, unknown>> {
    const all = await this.getAll(orgId);
    for (const s of SECRET_SETTINGS) {
      const hasEnc = typeof all[s.encKey] === 'string' && (all[s.encKey] as string).length > 0;
      delete all[s.encKey];
      delete all[s.plainKey];
      all[s.setKey] = hasEnc;
    }
    return all;
  }

  /** Déchiffre un secret stocké at-rest (ex. client secret Graph). Renvoie `''`
   *  si non configuré. Usage interne (provisioning worker). */
  async getDecryptedSecret(orgId: string, plainKey: string): Promise<string> {
    const spec = SECRET_SETTINGS.find((s) => s.plainKey === plainKey);
    if (!spec) return '';
    const v = await this.getValue(orgId, spec.encKey);
    if (typeof v !== 'string' || !v) return '';
    try {
      return await this.tenantCrypto.decrypt(orgId, v);
    } catch {
      return '';
    }
  }

  /** Upsert multiple settings en une fois. `actor` = trace d'audit (optionnel
   *  pour les écritures internes type branding/holidays — actor SYSTEM). */
  async upsertMany(
    orgId: string,
    values: Record<string, unknown>,
    actor?: { id?: string; email?: string },
  ) {
    this.validateWebhookSettings(values);
    this.validateAuditSettings(values);
    this.validateTeamsProvisioningSettings(values);
    this.validateAgentSettings(values);
    this.validateMcpSettings(values);
    validateAutomationSettings(values);
    this.validateCustomFieldSettings(values);
    await this.assertLicensedToggles(values);
    // Secrets : on ne persiste JAMAIS la valeur en clair. Une clé `plainKey`
    // présente est chiffrée vers `encKey` (chaîne vide = effacement) puis retirée
    // du lot. Les booléens `…Set`/`…Enc` éventuellement postés sont ignorés.
    for (const s of SECRET_SETTINGS) {
      delete values[s.setKey];
      delete values[s.encKey];
      if (s.plainKey in values) {
        const raw = values[s.plainKey];
        delete values[s.plainKey];
        const plain = typeof raw === 'string' ? raw.trim() : '';
        values[s.encKey] = plain ? await this.tenantCrypto.encrypt(orgId, plain) : '';
      }
    }
    const entries = Object.entries(values);
    // Snapshot AVANT pour le diff d'audit (uniquement les clés modifiées).
    const beforeRows = await this.prisma.orgSetting.findMany({
      where: { organizationId: orgId, key: { in: entries.map(([k]) => k) } },
    });
    const before: Record<string, unknown> = {};
    for (const r of beforeRows) before[r.key] = r.value as unknown;
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.orgSetting.upsert({
          where: { organizationId_key: { organizationId: orgId, key } },
          // Prisma JsonNull vs DbNull : on accepte null comme "valeur explicite null".
          update: { value: value as never },
          create: { organizationId: orgId, key, value: value as never },
        }),
      ),
    );
    const diff = auditDiff(before, values, entries.map(([k]) => k));
    if (diff) {
      // WARNING par défaut ; CRITICAL si la modification touche une clé de
      // sécurité (security.* / audit.* / smtp.* / sso.*).
      const touchesSecurity = entries.some(([k]) =>
        SECURITY_SETTING_PREFIXES.some((p) => k.startsWith(p)),
      );
      const severity = touchesSecurity
        ? 'CRITICAL'
        : severityForAction(AUDIT_ACTIONS.SETTINGS_UPDATED);
      const entry = {
        organizationId: orgId,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        severity,
        actorType: (actor?.id ? 'USER' : 'SYSTEM') as 'USER' | 'SYSTEM',
        actorId: actor?.id ?? null,
        actorLabel: actor?.email ?? null,
        resourceType: 'orgSetting',
        detail: diff,
      };
      if (severity === 'CRITICAL') void this.audit.logNow(entry);
      else void this.audit.log(entry);
    }
    return this.getAll(orgId);
  }

  /**
   * Locale par défaut de l'organisation (BCP47). Sert notamment au parsing
   * des dates dans les imports CSV. Valeurs reconnues :
   *   en-GB, en-US, fr-FR, de-DE, es-ES
   * Défaut : en-GB (format DD/MM/YYYY).
   */
  async getDefaultLocale(orgId: string): Promise<string> {
    const v = await this.getValue(orgId, 'locale');
    const allowed = ['en-GB', 'en-US', 'fr-FR', 'de-DE', 'es-ES'];
    if (typeof v === 'string' && allowed.includes(v)) return v;
    return 'en-GB';
  }

  /**
   * Langue d'INTERFACE par défaut de l'org ('en'|'fr'|'it'|'de'). Distincte de
   * `locale` (formatage dates/nombres). Stockée sous `i18n.defaultLanguage`.
   * Défaut : dérivée de la locale (`fr-FR` → `fr`), sinon `en`.
   */
  async getDefaultLanguage(orgId: string): Promise<string> {
    const v = await this.getValue(orgId, 'i18n.defaultLanguage');
    if (typeof v === 'string' && SUPPORTED_LANGUAGES.includes(v)) return v;
    const locale = await this.getValue(orgId, 'locale');
    if (typeof locale === 'string') {
      const sub = locale.toLowerCase().split('-')[0];
      if (SUPPORTED_LANGUAGES.includes(sub)) return sub;
    }
    return 'en';
  }

  /**
   * Langues d'interface activées (sous-ensemble des supportées) — pilote les
   * options du sélecteur de langue. Stockée sous `i18n.enabledLanguages`.
   * Défaut : toutes les langues supportées.
   */
  async getEnabledLanguages(orgId: string): Promise<string[]> {
    const v = await this.getValue(orgId, 'i18n.enabledLanguages');
    if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === 'string' && SUPPORTED_LANGUAGES.includes(x));
      if (list.length) return [...new Set(list)];
    }
    return [...SUPPORTED_LANGUAGES];
  }

  /**
   * Idle timeout des sessions, en minutes. **Aligné sur le défaut de l'UI**
   * (`admin-schema.ts` → `sessionTimeout: 60`) : si l'admin n'a jamais édité le
   * réglage, la clé n'existe pas en DB (l'AdminPanel n'envoie que les valeurs
   * modifiées) — la valeur affichée (60) doit malgré tout faire foi côté
   * serveur, sinon le logout par inactivité ne se déclenche jamais.
   *
   * Une valeur **explicite** 0 désactive le timeout. Bornée [0, 1440] comme l'UI.
   */
  async getSessionIdleTimeoutMinutes(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'sessionTimeout');
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      return Math.min(1440, Math.floor(v));
    }
    return 60; // défaut produit (la clé absente = jamais sauvegardée, pas "désactivé").
  }

  /**
   * Devise de l'organisation (code ISO 4217, ex. `EUR`, `USD`, `GBP`). Sert au
   * formatage de tous les montants finance (budget, taux, coûts). Défaut `EUR`.
   * Stocké sous la clé `finance.currency`.
   */
  async getCurrency(orgId: string): Promise<string> {
    const v = await this.getValue(orgId, 'finance.currency');
    if (typeof v === 'string' && /^[A-Z]{3}$/.test(v)) return v;
    return 'EUR';
  }

  /**
   * Mois de début d'exercice fiscal (1 = janvier … 12 = décembre). Défaut 1.
   * Stocké sous la clé `finance.fiscalYearStartMonth`. Sert aux filtres période
   * (trimestre / semestre / exercice) de la finance globale.
   */
  async getFiscalYearStartMonth(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'finance.fiscalYearStartMonth');
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 12) return Math.floor(n);
    return 1;
  }

  /** Accesseurs typés pour les settings consommés par d'autres modules. */
  async getHoursPerDay(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'hoursPerDay');
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (Number.isFinite(n) && n > 0) return n;
    return 8; // défaut codé en dur si la clé n'a pas été initialisée.
  }

  /**
   * Premier jour de la semaine pour l'affichage (timeline / workload).
   * Stocké comme 'Monday' | 'Sunday' (legacy strings du schéma UI), exposé
   * normalisé en 'monday' | 'sunday'.
   */
  async getWeekStart(orgId: string): Promise<'monday' | 'sunday'> {
    const v = await this.getValue(orgId, 'weekStart');
    if (typeof v === 'string' && v.toLowerCase() === 'sunday') return 'sunday';
    return 'monday';
  }

  /**
   * Curseur de concentration de l'auto-plan (Lot 2.2, AUTOPLAN_IMPROVEMENTS.md
   * §2.2) : défaut org, surchargeable par run (`AutoplanRequestDto.concentration`).
   * Stocké sous la clé `autoplan.concentration`. Défaut `balanced` (comportement
   * du lot 1b) si non initialisée.
   */
  async getAutoplanConcentration(orgId: string): Promise<'focus' | 'balanced' | 'spread'> {
    const v = await this.getValue(orgId, 'autoplan.concentration');
    if (v === 'focus' || v === 'balanced' || v === 'spread') return v;
    return 'balanced';
  }

  /** Retourne 7 booléens [mon..sun]. Défaut Mon-Fri. */
  async getDefaultWorkDays(orgId: string): Promise<boolean[]> {
    const v = await this.getValue(orgId, 'defaultWorkDays');
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return [
        bool(o.mon, true),
        bool(o.tue, true),
        bool(o.wed, true),
        bool(o.thu, true),
        bool(o.fri, true),
        bool(o.sat, false),
        bool(o.sun, false),
      ];
    }
    return [true, true, true, true, true, false, false];
  }

  /**
   * Lit la policy de création d'un type de projet (billable / non-billable).
   * Clés stockées :
   *   - `projectCreation.billable`    → { mode, roleKeys[], teamIds[] }
   *   - `projectCreation.nonBillable` → idem
   * Mode :
   *   - 'everyone' : tout user authentifié peut créer ce type de projet.
   *   - 'roles'    : seuls les users dont le rôle org est dans roleKeys[].
   *   - 'teams'    : seuls les users membres d'une équipe de teamIds[] et
   *                  dont l'override `User.canCreateNonBillableProject` (ou
   *                  `Team.canCreateNonBillableProject` pour mode billable)
   *                  est résolu à true.
   * Défaut si non initialisée :
   *   - billable    : 'roles' avec ['ORG_ADMIN','PORTFOLIO_MANAGER']
   *   - nonBillable : 'everyone'
   */
  async getProjectCreationPolicy(
    orgId: string,
    kind: 'billable' | 'nonBillable',
  ): Promise<ProjectCreationPolicy> {
    const key = kind === 'billable' ? 'projectCreation.billable' : 'projectCreation.nonBillable';
    const v = await this.getValue(orgId, key);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const mode = ['everyone', 'roles', 'teams'].includes(String(o.mode))
        ? (String(o.mode) as ProjectCreationPolicyMode)
        : (kind === 'billable' ? 'roles' : 'everyone');
      const roleKeys = Array.isArray(o.roleKeys)
        ? (o.roleKeys.filter((k) => typeof k === 'string') as string[])
        : [];
      const teamIds = Array.isArray(o.teamIds)
        ? (o.teamIds.filter((k) => typeof k === 'string') as string[])
        : [];
      return { mode, roleKeys, teamIds };
    }
    return kind === 'billable'
      ? { mode: 'roles', roleKeys: ['ORG_ADMIN', 'PORTFOLIO_MANAGER'], teamIds: [] }
      : { mode: 'everyone', roleKeys: [], teamIds: [] };
  }

  /**
   * Niveau max autorisé sur un UserSkill (1..maxLevel). Stocké sous la clé
   * `skills.maxLevel`. Borné [1, 100] côté serveur ; défaut 10 si absent.
   */
  async getSkillsMaxLevel(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'skills.maxLevel');
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 100) return Math.floor(n);
    return 10;
  }

  /**
   * Si vrai, un utilisateur peut éditer ses propres skills. Sinon, seuls
   * les Org Admins et les Team Leads des équipes de l'user peuvent le faire.
   * Défaut : false (politique restrictive — l'admin assume).
   */
  async getSkillsSelfEditEnabled(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'skills.selfEditEnabled');
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return false;
  }

  /**
   * Qui peut créer / renommer / supprimer un skill du catalogue org.
   * Cumulatif (chaque niveau inclut tous les précédents) :
   *   - 'admin'             : Org Admins uniquement
   *   - 'portfolio_manager' : + rôle PORTFOLIO_MANAGER
   *   - 'team_lead'         : + leads d'au moins une équipe (défaut)
   *   - 'everyone'          : tout utilisateur authentifié
   *
   * Défaut = 'team_lead' : la gestion du catalogue de compétences est
   * déléguée aux leads d'équipe ; l'Org Admin se réserve l'organisationnel.
   */
  async getSkillsCatalogWriteMode(orgId: string): Promise<SkillsCatalogWriteMode> {
    const v = await this.getValue(orgId, 'skills.catalogWriteMode');
    if (
      v === 'admin' ||
      v === 'portfolio_manager' ||
      v === 'team_lead' ||
      v === 'everyone'
    )
      return v;
    return 'team_lead';
  }

  /**
   * Qui peut créer/éditer/supprimer une définition de champ personnalisé.
   * Mêmes 4 modes que le catalogue skills ; défaut `admin` (plus restrictif que
   * skills : un champ custom structure le modèle de données, pas juste un tag).
   */
  async getCustomFieldsWriteMode(orgId: string): Promise<SkillsCatalogWriteMode> {
    const v = await this.getValue(orgId, 'customFields.writeMode');
    if (v === 'admin' || v === 'portfolio_manager' || v === 'team_lead' || v === 'everyone') return v;
    return 'admin';
  }

  /** Qui peut gérer les sous-statuts (Custom Status). Mêmes modes que les
   *  champs personnalisés, défaut `admin`. */
  async getCustomStatusesWriteMode(orgId: string): Promise<SkillsCatalogWriteMode> {
    const v = await this.getValue(orgId, 'customStatuses.writeMode');
    if (v === 'admin' || v === 'portfolio_manager' || v === 'team_lead' || v === 'everyone') return v;
    return 'admin';
  }

  // ---------- Skills lifecycle (auto-bump à la clôture + decay annuel) ----------

  /**
   * À la clôture d'un projet (`status` → COMPLETED), monte d'autant de niveaux
   * les UserSkill des participants sur les ProjectSkill du projet. Défaut true
   * — c'est la principale fonction métier qui rend Skills utile en ESN
   * (l'historique de compétences se construit naturellement).
   */
  async getSkillsAutoBumpEnabled(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'skills.autoBumpOnProjectClose');
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return true;
  }

  /** Niveaux ajoutés par participant à la clôture (capé par maxLevel). Défaut 1. */
  async getSkillsAutoBumpDelta(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'skills.autoBumpDelta');
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10) return Math.floor(n);
    return 1;
  }

  /**
   * Si vrai, un cron quotidien décrémente les UserSkill non touchés depuis
   * `skills.decayPeriodDays`. Modélise l'oubli / la perte de pratique. Défaut
   * false — option opt-in (peut sembler punitif si l'utilisateur ne l'attend
   * pas).
   */
  async getSkillsDecayEnabled(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'skills.decayEnabled');
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return false;
  }

  /** Période d'inactivité au bout de laquelle on décrémente. Défaut 365 jours. */
  async getSkillsDecayPeriodDays(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'skills.decayPeriodDays');
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 30 && n <= 3650) return Math.floor(n);
    return 365;
  }

  /** Combien de niveaux retirer à chaque période. Défaut 1. */
  async getSkillsDecayDelta(orgId: string): Promise<number> {
    const v = await this.getValue(orgId, 'skills.decayDelta');
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10) return Math.floor(n);
    return 1;
  }

  /**
   * Grille de référence des niveaux : `[{ level, label }]` triée par level
   * croissant. Affichée sous le slider de niveau pour donner une sémantique
   * partagée à 1/3/5/7/… (ex. 1=Découverte, 3=Autonome, 5=Senior, 7=Expert).
   * Vide par défaut → l'UI tombe sur les nombres bruts.
   */
  async getSkillsLevelScale(
    orgId: string,
  ): Promise<Array<{ level: number; label: string }>> {
    const v = await this.getValue(orgId, 'skills.levelScale');
    if (!Array.isArray(v)) return [];
    const out: Array<{ level: number; label: string }> = [];
    for (const it of v) {
      if (!it || typeof it !== 'object') continue;
      const lvl = (it as { level: unknown }).level;
      const lbl = (it as { label: unknown }).label;
      const n = typeof lvl === 'number' ? lvl : parseInt(String(lvl), 10);
      if (Number.isFinite(n) && n >= 1 && typeof lbl === 'string' && lbl.trim()) {
        out.push({ level: Math.floor(n), label: lbl.trim() });
      }
    }
    return out.sort((a, b) => a.level - b.level);
  }

  /**
   * Mode de saisie du niveau de skill dans l'UI :
   *   - 'number' : input/stepper numérique 1..maxLevel (défaut, historique).
   *   - 'scale'  : dropdown des libellés de la grille (Découverte/Autonome/…).
   *                Le chiffre stocké en base reste celui du palier choisi, mais
   *                il n'est plus exposé à l'utilisateur — il choisit un palier.
   *                Fallback silencieux en 'number' si la grille est vide.
   * S'applique au niveau requis sur tâche (TaskDetail) ET au niveau d'un
   * UserSkill dans le dialog équipe.
   */
  async getSkillsLevelInputMode(orgId: string): Promise<'number' | 'scale'> {
    const v = await this.getValue(orgId, 'skills.levelInputMode');
    return v === 'scale' ? 'scale' : 'number';
  }

  // ---------- Webhooks (gouvernance) ----------

  /**
   * Qui peut créer/gérer des webhooks (au-delà de l'Org Admin, qui peut
   * toujours) :
   *   - 'admin'             : Org Admin uniquement.
   *   - 'portfolio_manager' : + rôle PORTFOLIO_MANAGER.
   *   - 'project_manager'   : + PROJECT_MANAGER sur SON projet / lead sur SON
   *                           équipe (self-service encadré, défaut).
   *
   * Défaut = 'project_manager' : un PM branche son projet à son canal Teams en
   * autonomie, sans pouvoir toucher les webhooks ORG (réservés à l'admin).
   */
  async getWebhookManagePolicy(orgId: string): Promise<WebhookManagePolicy> {
    const v = await this.getValue(orgId, 'webhooks.managePolicy');
    if (v === 'admin' || v === 'portfolio_manager' || v === 'project_manager') return v;
    return 'project_manager';
  }

  /**
   * Allowlist de domaines autorisés comme cible de webhook (ex.
   * ['webhook.office.com', 'hooks.slack.com']). Vide = tout hôte public
   * autorisé (la protection anti-SSRF reste appliquée dans tous les cas). Un
   * sous-domaine matche si l'hôte est égal OU se termine par `.<domaine>`.
   */
  async getWebhookDomainAllowlist(orgId: string): Promise<string[]> {
    const v = await this.getValue(orgId, 'webhooks.domainAllowlist');
    const raw = Array.isArray(v)
      ? v
      : typeof v === 'string'
        ? v.split(/[\s,]+/)
        : [];
    return raw
      .map((d) => String(d).trim().toLowerCase().replace(/^\*\./, ''))
      .filter(Boolean);
  }

  /**
   * Allowlist de tenants **Entra ID** (Azure AD), par GUID. Quand non vide, un
   * webhook ciblant un Incoming Webhook Teams (`*.webhook.office.com`) n'est
   * accepté que si le GUID de tenant porté par l'URL (`…@<tenantId>/…`) est dans
   * la liste. Anti-dataleak : empêche d'envoyer vers le Teams d'un locataire
   * Microsoft non autorisé. Les entrées non-GUID sont ignorées.
   */
  async getWebhookEntraTenantAllowlist(orgId: string): Promise<string[]> {
    const v = await this.getValue(orgId, 'webhooks.entraTenantAllowlist');
    const raw = Array.isArray(v)
      ? v
      : typeof v === 'string'
        ? v.split(/[\s,]+/)
        : [];
    const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    return raw
      .map((d) => String(d).trim().toLowerCase())
      .filter((d) => GUID.test(d));
  }

  // ---------- MCP (connecteur IA, phase 11) ----------

  /**
   * Connecteur MCP activé pour l'org. **Opt-in strict** : désactivé par défaut.
   * Tant que l'admin n'a pas explicitement basculé ce réglage, la façade OAuth
   * refuse d'émettre un jeton MCP (cf. `OAuthService.consent`) — l'IA ne peut
   * donc rien faire, quel que soit le client branché. Réglage **par tenant**
   * (clé `OrgSetting` isolée dans la base du tenant).
   */
  async getMcpEnabled(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'mcp.enabled');
    if (typeof v === 'boolean') return v;
    return v === 'true' || v === 1 || v === '1';
  }

  /**
   * Si vrai, les jetons MCP se voient accorder les scopes d'écriture (bornés par
   * le RBAC de l'utilisateur). Défaut false — lecture seule. Consommé par
   * `OAuthService.computeScopes`.
   */
  async getMcpAllowWrites(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'mcp.allowWrites');
    if (typeof v === 'boolean') return v;
    return v === 'true' || v === 1 || v === '1';
  }

  async getMcpAllowFinance(orgId: string): Promise<boolean> {
    const v = await this.getValue(orgId, 'mcp.allowFinance');
    if (typeof v === 'boolean') return v;
    return v === 'true' || v === 1 || v === '1';
  }

  /**
   * Politique de confirmation des actions MCP destructrices.
   *
   * ⚠️ Défaut **`destructive`**, et non `off` comme les autres réglages MCP
   * (`mcp.enabled`, `mcp.allowWrites` sont en opt-in strict). La distinction est
   * volontaire : ceux-là gatent une **capacité** — l'opt-in strict est le bon
   * réflexe — tandis que celui-ci est un **garde-fou**, et un garde-fou livré
   * éteint est un garde-fou que personne n'a. Le pire cas est un aller-retour
   * supplémentaire et un message lisible, pas un échec.
   */
  async getMcpConfirmPolicy(orgId: string): Promise<'off' | 'destructive' | 'all_writes'> {
    const v = await this.getValue(orgId, 'mcp.confirmPolicy');
    return v === 'off' || v === 'destructive' || v === 'all_writes' ? v : 'destructive';
  }

  /**
   * Quotas d'appel **par tool MCP**, en appels/minute : `{ "<tool>": n, "*": n }`.
   * `*` sert de défaut pour les tools non listés. Vide = aucun plafond (seul le
   * palier par jeton d'`ApiThrottlerGuard` s'applique alors).
   */
  async getMcpToolQuotas(orgId: string): Promise<Record<string, number>> {
    const v = await this.getValue(orgId, 'mcp.toolQuotas');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) out[k] = n;
    }
    return out;
  }

  /**
   * Validation des réglages `mcp.*`.
   *
   * ⚠️ `upsertMany` n'a **aucune allowlist de clés** : n'importe quelle clé
   * postée est persistée. Ce validateur est donc la seule chose qui empêche un
   * quota mal orthographié (`vaks_lst_projects`) d'être accepté sans rien
   * borner — un plafond qu'on croit posé et qui ne s'applique jamais.
   */
  private validateMcpSettings(values: Record<string, unknown>) {
    if ('mcp.confirmPolicy' in values && values['mcp.confirmPolicy'] != null) {
      const p = values['mcp.confirmPolicy'];
      if (p !== 'off' && p !== 'destructive' && p !== 'all_writes') {
        throw new BadRequestException(
          'mcp.confirmPolicy doit valoir "off", "destructive" ou "all_writes".',
        );
      }
    }
    if ('mcp.toolQuotas' in values && values['mcp.toolQuotas'] != null) {
      const raw = values['mcp.toolQuotas'];
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException('mcp.toolQuotas doit être un objet { "<tool>": nombre }.');
      }
      const normalized: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^(vaks_[a-z0-9_]{1,60}|\*)$/.test(k)) {
          throw new BadRequestException(
            `mcp.toolQuotas : clé invalide « ${k} » (attendu un nom de tool vaks_… ou « * »).`,
          );
        }
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 100000) {
          throw new BadRequestException(
            `mcp.toolQuotas : valeur invalide pour « ${k} » (entier attendu entre 1 et 100000).`,
          );
        }
        normalized[k] = n;
      }
      // Persiste la forme normalisée (même parti pris que `agents.policies`).
      values['mcp.toolQuotas'] = normalized;
    }
  }

  private async getValue(orgId: string, key: string): Promise<unknown> {
    const row = await this.prisma.orgSetting.findUnique({
      where: { organizationId_key: { organizationId: orgId, key } },
    });
    return row?.value;
  }
}

export type SkillsCatalogWriteMode =
  | 'admin'
  | 'portfolio_manager'
  | 'team_lead'
  | 'everyone';

export type WebhookManagePolicy = 'admin' | 'portfolio_manager' | 'project_manager';

export type ProjectCreationPolicyMode = 'everyone' | 'roles' | 'teams';
export interface ProjectCreationPolicy {
  mode: ProjectCreationPolicyMode;
  roleKeys: string[];
  teamIds: string[];
}

/** Config résolue du provisioning Microsoft Teams (secret exclu — Swarm). */
export interface TeamsProvisioningConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  namePattern: string;
  channels: string[];
  /** Disposition des channels créés : `post` = Publications, `chat` = Fils de discussion. */
  channelLayout: 'post' | 'chat';
  visibility: 'private' | 'public';
  membership: 'assigned_teams' | 'project_members' | 'both';
  removeOnLeave: boolean;
  archiveOnClose: boolean;
}

/** Config du contexte documentaire SharePoint (agents IA). */
export interface SharePointContextConfig {
  enabled: boolean;
  identityMode: 'read_all' | 'selected_granter';
  readerClientId: string;
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return def;
}
