/* ============================================================
   Admin Panel schema — every settable parameter, grouped by area.
   Ported from the design's admin-data.js. Values are local-only
   (no persistence backend yet); changing them surfaces a save-bar
   but does not call the API. Real wiring will land per-feature.
   ============================================================ */

export type ControlType =
  | 'toggle'
  | 'select'
  | 'segmented'
  | 'text'
  | 'number'
  | 'color'
  | 'action'
  | 'info'
  | 'workdays'
  | 'country'
  /** Champ secret write-only : saisi en clair, chiffré at-rest côté serveur,
   *  jamais ré-affiché. L'état « configuré » vient du booléen `<id>Set`. */
  | 'secret';

export type SpecialKind =
  | 'userlist'
  | 'teamlist'
  | 'rolelist'
  | 'storage'
  | 'license'
  | 'doctemplates'
  | 'projectpolicy'
  | 'webhooklist'
  | 'orgapikeys'
  | 'customfields'
  | 'customstatuses'
  | 'skillslist'
  | 'skillsimport'
  | 'skillslevelscale'
  | 'auditlog'
  /** Clés de chiffrement at-rest : provider KEK actif + rotation KEK/DEK (DORA). */
  | 'cryptokeys'
  /** Bundle de diagnostic in-app + procédure des logs hôtes (support). */
  | 'diagnostics'
  /** Journal des envois d'emails (EmailDelivery) — statut/erreur SMTP. */
  | 'emaildeliveries'
  | 'mcp'
  | 'ssoidp'
  /** Liste des connecteurs externes de ticketing (ServiceNow, Jira, …). */
  | 'ticketingconnectors'
  /** Agents IA : identités, jetons (chantier agents 1). */
  | 'agentlist'
  /** Policies de gouvernance des agents (chantier agents 3). */
  | 'agentpolicies'
  | 'agentruns'
  /** Connecteurs d'annuaire d'agents (Entra Agent ID, …) — groupe Integrations. */
  | 'agentconnectors'
  /** Connecteurs CI signataires (vérification des livrables agents — phase C). */
  | 'ciconnectors'
  /** Émetteurs de confiance pour la fédération d'identité des agents (RFC 8693). */
  | 'agenttrustissuers'
  /** Liste org-wide des connexions IA actives (vue admin). */
  | 'aiconnections'
  /** Espaces de collaboration (Teams aujourd'hui, Slack/Google ensuite). */
  | 'collabspaces'
  /** Liste inline des sessions navigateur actives (refresh tokens). */
  | 'sessions';

export interface AdminSetting {
  id: string;
  label: string;
  desc?: string;
  type: ControlType;
  value?: unknown;
  options?: string[];
  /** Libellés d'affichage parallèles à `options` (la valeur stockée reste `options[i]`). */
  optionLabels?: string[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  mono?: boolean;
  placeholder?: string;
  badge?: string;
  actionLabel?: string;
  danger?: boolean;
  ok?: boolean;
  kw?: string;
}

export interface AdminSection {
  title: string;
  blurb?: string;
  badge?: string;
  nav?: boolean;
  navIcon?: string;
  kind?: SpecialKind;
  /** Si renseigné, section premium gated par cette feature de licence (ex. 'teams-provisioning').
   *  Le renderer peut afficher un état verrouillé/CTA quand la feature n'est pas active. */
  feature?: string;
  /** Sous-sections d'une entrée de menu (nav). Quand renseigné, la page de la
   *  sous-section rend chaque enfant comme une carte titrée, dans l'ordre.
   *  Le conteneur lui-même ne porte ni `settings` ni `kind` (juste title/blurb/
   *  navIcon pour le menu et l'en-tête). Permet de regrouper plusieurs cartes
   *  sous une seule entrée de menu. */
  children?: AdminSection[];
  settings?: AdminSetting[];
  storage?: { name: string; used: number; total: number; unit: string }[];
  license?: { name: string; used: number; total: number; unit: string }[];
}

export interface AdminGroup {
  id: string;
  label: string;
  icon: string;
  blurb?: string;
  badge?: string;
  sections: AdminSection[];
}

const accents = ['#d9604c', '#6d5efc', '#2f7ef0', '#0fae96', '#e8590c', '#e64980'];

export const ADMIN_GROUPS: AdminGroup[] = [
  {
    id: 'identity',
    label: 'Users & Identity',
    icon: 'users',
    blurb: 'Local accounts, roles and external identity providers.',
    sections: [
      {
        title: 'Accounts',
        settings: [
          { id: 'defaultRole', label: 'Default role for new users', desc: 'Role assigned when a member is created or invited.', type: 'select', options: ['Member', 'Manager', 'Team leader', 'Admin'], value: 'Member' },
          { id: 'bulkImport', label: 'Bulk import users', desc: 'Provision many accounts at once from a CSV file.', type: 'action', actionLabel: 'Import CSV' },
        ],
      },
      { title: 'Users', kind: 'userlist', nav: true, navIcon: 'user', blurb: 'Everyone with an account — search, roles and status.' },
      { title: 'Agents', kind: 'agentlist', nav: true, navIcon: 'zap', blurb: 'AI agent identities: owner, trust level, capabilities, tokens and directory sync. Separate from human members — agents never consume a seat.' },
      { title: 'Teams', kind: 'teamlist', nav: true, navIcon: 'users', blurb: 'Working groups, their leads and members.' },
      { title: 'Roles', kind: 'rolelist', nav: true, navIcon: 'shield', blurb: 'System roles available in this organization and the permissions they grant.' },
    ],
  },
  {
    id: 'aiAgentManagement',
    label: 'AI Agent Management',
    icon: 'bot',
    blurb: 'Govern your AI agents and audit what they cost: policy rules that gate reviews and transitions, and the full usage & cost ledger.',
    sections: [
      { title: 'Policies', kind: 'agentpolicies', nav: true, navIcon: 'shield', blurb: 'Governance rules for AI agents: require review, deny or notify based on labels, trust level, estimate or transition — plus review backpressure.' },
      { title: 'Usage & cost ledger', kind: 'agentruns', nav: true, navIcon: 'coins', blurb: 'Every run declared by an AI agent: cost, tokens, model, project and task. The audit log of AI consumption — filter by agent, project or period, flag suspicious declarations, export to CSV.' },
    ],
  },
  {
    id: 'org',
    label: 'Organization',
    icon: 'settings',
    blurb: 'Tenant profile, localization and contracted working time.',
    sections: [
      {
        title: 'Profile',
        settings: [
          { id: 'orgName', label: 'Organization name', desc: 'Shown in the sidebar, emails and exports.', type: 'text', value: 'Vaks' },
          { id: 'org.logoUrl', label: 'Organization logo', desc: 'PNG, JPEG, SVG, WebP or GIF — max 1 MB. Used in the sidebar, exports, and as the default logo for outbound email notifications. Upload replaces the previous logo immediately.', type: 'action', actionLabel: 'Upload logo' },
          { id: 'locale', label: 'Default locale (formatting)', desc: 'Date & number formatting for new users (BCP47 region). Separate from the UI language below.', type: 'select', options: ['en-GB', 'en-US', 'fr-FR', 'de-DE', 'es-ES'], value: 'en-GB' },
          { id: 'i18n.defaultLanguage', label: 'Default UI language', desc: 'Interface language for users who have not picked their own. Each user can override it from the language selector in the top bar.', type: 'select', options: ['en', 'fr', 'it', 'de'], value: 'en' },
        ],
      },
      {
        title: 'License',
        kind: 'license',
        nav: true,
        navIcon: 'flag',
        badge: 'Enterprise',
        blurb: 'Your license: covered enterprise features, expiry, and import of a new license file. Core features always stay free.',
      },
      {
        title: 'Document templates',
        kind: 'doctemplates',
        nav: true,
        navIcon: 'paperclip',
        blurb: 'Word templates used when exporting documents (project charter, etc.).',
      },
      {
        title: 'Project management',
        kind: 'projectpolicy',
        nav: true,
        navIcon: 'board',
        blurb: 'Who is allowed to create billable and non-billable projects.',
      },
      {
        title: 'Working time',
        settings: [
          { id: 'hoursPerDay', label: 'Hours per working day', desc: 'Capacity baseline per person, per day. Applies to every user that has no custom schedule.', type: 'number', unit: 'h', value: 8, min: 1, max: 24, step: 0.5 },
          {
            id: 'defaultWorkDays',
            label: 'Default working days',
            desc: 'Days of the week users work on by default. Days that are off carry zero capacity in the workload and timeline grids.',
            type: 'workdays',
            value: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
          },
          { id: 'weekStart', label: 'Week starts on', desc: 'First column of the workload & timeline grids.', type: 'segmented', options: ['Monday', 'Sunday'], value: 'Monday' },
          {
            id: 'autoplan.concentration',
            label: 'Auto-plan concentration',
            desc: 'Default for the "how many people per task" trade-off when auto-plan assigns tasks. Focus favors fewer people; spread restores the historical one-person-per-task behavior. Overridable per run.',
            type: 'segmented',
            options: ['focus', 'balanced', 'spread'],
            value: 'balanced',
          },
          {
            id: 'holidays.defaultCountry',
            label: 'Default holiday country',
            desc: "Pays par défaut utilisé pour la liste des jours fériés affichée dans Workload et Timeline. Chaque utilisateur peut surcharger ce pays dans sa fiche pour appliquer les fériés de son propre pays.",
            type: 'country',
            value: 'FR',
          },
        ],
      },
      {
        title: 'Finance',
        settings: [
          {
            id: 'finance.fiscalYearStartMonth',
            label: "Fiscal year start month",
            desc: "Mois où démarre l'exercice fiscal. Utilisé par la finance globale pour les filtres par trimestre / semestre / exercice.",
            type: 'select',
            value: '1',
            options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
            optionLabels: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
          },
        ],
      },
      {
        title: 'Scheduled billing export',
        blurb: 'Automatically email a billing export (CSV or XLSX) to a list of recipients on a weekly or monthly schedule. The export covers the previous full period (last week or last month).',
        settings: [
          { id: 'billing.export.enabled', label: 'Enable scheduled export', type: 'toggle', value: false },
          { id: 'billing.export.frequency', label: 'Frequency', type: 'select', value: 'monthly', options: ['weekly', 'monthly'], optionLabels: ['Weekly', 'Monthly'] },
          { id: 'billing.export.weekDay', label: 'Day of week (weekly)', desc: '1 = Monday … 7 = Sunday. The export covers the previous Mon–Sun week.', type: 'number', value: 1, min: 1, max: 7 },
          { id: 'billing.export.monthDay', label: 'Day of month (monthly)', desc: 'Day 1–28. The export covers the previous full calendar month.', type: 'number', value: 1, min: 1, max: 28 },
          { id: 'billing.export.hour', label: 'Send hour (UTC)', desc: 'Hour 0–23 UTC at which the cron fires.', type: 'number', value: 7, min: 0, max: 23 },
          { id: 'billing.export.format', label: 'File format', type: 'select', value: 'xlsx', options: ['csv', 'xlsx'], optionLabels: ['CSV', 'XLSX'] },
          { id: 'billing.export.recipients', label: 'Recipients', type: 'text', desc: 'Comma-separated email addresses.', placeholder: 'finance@acme.com, cfo@acme.com' },
          { id: 'billingExportSendNow', label: 'Send now', desc: 'Immediately send the billing export for the previous period to the configured recipients.', type: 'action', actionLabel: 'Send now' },
        ],
      },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: 'link',
    blurb: 'AI connectors, outbound email, webhooks and API tokens.',
    sections: [
      {
        title: 'Single sign-on',
        kind: 'ssoidp',
        nav: true,
        navIcon: 'user',
        badge: 'Module',
        blurb: 'Federate sign-in with your identity provider (Microsoft Entra ID via OIDC). JIT provisioning, account linking and role mapping.',
      },
      {
        title: 'Email (SMTP)',
        nav: true,
        navIcon: 'inbox',
        blurb: 'Relay used for outbound notifications. The password can be entered here (encrypted at rest) or mounted at deploy time via the SMTP_PASSWORD secret.',
        settings: [
          { id: 'smtp.host', label: 'SMTP host', desc: 'Company relay for outbound mail.', type: 'text', value: 'smtp.internal', mono: true },
          { id: 'smtp.port', label: 'SMTP port', desc: 'Usually 587 for STARTTLS, 465 for SSL/TLS, 25 for none.', type: 'number', value: 587, min: 1, max: 65535 },
          { id: 'smtp.encryption', label: 'Encryption', desc: 'Transport security for the relay.', type: 'segmented', options: ['none', 'starttls', 'ssl'], value: 'starttls' },
          { id: 'smtp.authMode', label: 'Authentication', desc: 'Anonymous = no login (internal relay). Password = SASL with SMTP_PASSWORD from the docker secret.', type: 'segmented', options: ['anonymous', 'password'], value: 'anonymous' },
          { id: 'smtp.user', label: 'SMTP username', desc: 'Only used when authentication = password. Set the matching password below, or leave it to the SMTP_PASSWORD deploy secret.', type: 'text', value: '', mono: true },
          { id: 'smtp.password', label: 'SMTP password', desc: 'Only used when authentication = password. Stored encrypted at rest (AES-256-GCM) and never shown again — leave empty to keep the current password. If left unset, the relay falls back to the SMTP_PASSWORD deploy secret.', type: 'secret', value: '', mono: true },
          { id: 'smtp.test', label: 'Connection test', desc: 'Send a real "test" email to your address using the current settings.', type: 'action', actionLabel: 'Send test email' },
        ],
      },
      {
        title: 'AI connector (MCP)',
        kind: 'mcp',
        feature: 'mcp',
        nav: true,
        navIcon: 'zap',
        blurb: 'Expose this organization to AI clients (Claude, ChatGPT, Copilot Studio…) over MCP. Opt-in, scoped to your tenant.',
      },
      {
        title: 'External connectors',
        kind: 'ticketingconnectors',
        nav: true,
        navIcon: 'link',
        badge: 'Module',
        blurb: 'Connect external ticketing systems (ServiceNow, Jira…) so users can log time against their tickets in the timesheet. Service-account auth, encrypted at rest.',
      },
      {
        title: 'Agent directories',
        kind: 'agentconnectors',
        nav: true,
        navIcon: 'zap',
        badge: 'Module',
        blurb: 'Import AI agent identities from an external platform (Microsoft Entra Agent ID). Synced agents arrive read-only and without a token — a human activates them. Encrypted at rest.',
      },
      {
        title: 'CI verification',
        kind: 'ciconnectors',
        nav: true,
        navIcon: 'shield',
        badge: 'Module',
        blurb: 'Receive signed CI results (GitHub Actions or a generic HMAC signer) as proof for agent deliverables. vaks-pm never connects out — CI pushes a signed result, we verify the HMAC. Shared secret encrypted at rest.',
      },
      {
        title: 'Federated agent identity',
        kind: 'agenttrustissuers',
        nav: true,
        navIcon: 'key',
        badge: 'Module',
        blurb: "Let agents authenticate with the token their own platform issues (Kubernetes, Entra workload identity, GitHub Actions) — no secret to distribute or rotate. Declare a trusted issuer; agents exchange their platform JWT for a short-lived token. Public-key crypto, nothing stored.",
      },
      {
        title: 'Webhooks',
        nav: true,
        navIcon: 'branch',
        blurb: 'Outbound HTTP callbacks fired on task / comment / project events. Each delivery is signed (HMAC-SHA256) so the receiver can verify authenticity.',
        children: [
      {
        title: 'Governance',
        blurb: 'Who may create a webhook, and the destination guardrails (domain allowlist, Entra tenant pinning).',
        settings: [
          {
            id: 'webhooks.managePolicy',
            label: 'Qui peut créer un webhook',
            desc: "Au-delà de l'Org Admin (qui peut toujours). 'project_manager' = un PM branche SON projet / un lead SON équipe en self-service ; 'portfolio_manager' = réservé aux PM de portefeuille ; 'admin' = admin uniquement.",
            type: 'select',
            options: ['admin', 'portfolio_manager', 'project_manager'],
            value: 'project_manager',
          },
          {
            id: 'webhooks.domainAllowlist',
            label: 'Domaines autorisés (allowlist)',
            desc: "Liste de domaines cibles autorisés, séparés par des virgules ou espaces (ex. webhook.office.com, hooks.slack.com). Vide = tout hôte public autorisé. La protection anti-SSRF (loopback / IP privées) s'applique dans tous les cas.",
            type: 'text',
            value: '',
            placeholder: 'webhook.office.com, hooks.slack.com',
            mono: true,
          },
          {
            id: 'webhooks.entraTenantAllowlist',
            label: 'Tenants Entra ID autorisés (Teams)',
            desc: "GUID du/des locataires Microsoft autorisés comme destination. À récupérer dans Azure Portal → Microsoft Entra ID → Vue d'ensemble → « ID de locataire ». Quand renseigné, un webhook vers Teams (*.webhook.office.com, tenant en …@<tenantId>/…) ou Power Automate environnement Default (*.environment.api.powerplatform.com, tenant encodé dans le host) n'est accepté que si son tenant est dans la liste — anti-fuite vers un locataire étranger. Les environnements Power Platform custom ne peuvent pas être vérifiés (refusés si l'allowlist est active). Vide = aucune restriction Entra.",
            type: 'text',
            value: '',
            placeholder: '72f988bf-86f1-41af-91ab-2d7cd011db47',
            mono: true,
          },
        ],
      },
          {
            title: 'Endpoints',
            kind: 'webhooklist',
            blurb: 'Registered endpoints and their recent deliveries.',
          },
        ],
      },
      {
        // Ex-« Microsoft Teams — provisioning ». Généralisée en espaces de
        // collaboration (Teams aujourd'hui, Slack/Google ensuite) : la config
        // vit désormais DANS la carte du fournisseur. Les clés OrgSetting
        // (`teams.provisioning.*`), le modèle `Project.msTeam*`, le worker et le
        // flag de licence sont INCHANGÉS — c'est un re-skin UI.
        //
        // Les sources documentaires vivent AUSSI ici : SharePoint (identité Teams)
        // comme sous-bloc de la carte Teams, et les connecteurs autonomes
        // (Google Drive/S3/WebDAV) rendus en bas par `CollabSpacesSection` —
        // l'ancienne section « Document sources » a été fusionnée ici.
        title: 'Collaboration spaces',
        kind: 'collabspaces',
        nav: true,
        navIcon: 'users',
        feature: 'teams-provisioning',
        blurb:
          "Automatically create a collaboration space when a project becomes ACTIVE, and invite its members. Microsoft Teams is available today; the space can also be created by an external tool that declares it back to Vaks. Document sources agents can read (SharePoint, and standalone connectors as they ship) are configured here too. Credentials are encrypted at rest and never shown again.",
      },
      {
        title: 'Clés API organisation',
        nav: true,
        navIcon: 'key',
        blurb: "Clés d'API au niveau organisation (identité service, lecture seule). Pour les intégrations qui consomment l'API publique sans agir au nom d'un utilisateur. Le secret n'est affiché qu'une fois.",
        children: [
          {
            title: 'API',
            settings: [
              { id: 'apiVersion', label: 'Public API version', desc: 'Versioned REST API consumed by the web app and integrations.', type: 'info', value: 'v1', mono: true },
            ],
          },
          {
            title: 'Organization keys',
            kind: 'orgapikeys',
            blurb: 'Service-identity keys for server-to-server access. The secret is shown only once.',
          },
        ],
      },
    ],
  },
  {
    id: 'security',
    label: 'Security & Compliance',
    icon: 'shield',
    blurb: 'Authentication hardening, password policy, sessions and audit.',
    sections: [
      {
        title: 'Authentication',
        nav: true,
        navIcon: 'lock',
        blurb: 'Sign-in hardening — MFA, SSO enforcement, idle timeout and lockout — and the password policy.',
        children: [
          {
            title: 'Sign-in & sessions',
            settings: [
              { id: 'security.requireMfa', label: 'Require MFA for local accounts', desc: 'Every local-password member must enrol an authenticator (TOTP). Break-glass accounts always have MFA on.', type: 'toggle', value: false },
              { id: 'security.ssoOnly', label: 'Require SSO (disable local password sign-in)', desc: 'Members must sign in through an identity provider. Local password sign-in is refused for everyone EXCEPT break-glass accounts (per-user toggle in the user list). ⚠ Make sure at least one admin has break-glass enabled WITH a password set before turning this on, or you may lock yourself out.', type: 'toggle', value: false },
              { id: 'sessionTimeout', label: 'Session idle timeout', desc: 'Sign a member out after this much inactivity. Set to 0 to disable (members are never signed out for being idle).', type: 'number', unit: 'min', value: 60, min: 0, max: 1440, step: 5 },
              { id: 'security.lockoutMaxAttempts', label: 'Lockout threshold', desc: 'Lock the account after this many consecutive failed sign-ins.', type: 'number', unit: 'attempts', value: 5, min: 3, max: 20 },
              { id: 'security.lockoutDurationMinutes', label: 'Lockout duration', desc: 'How long the account stays locked after the threshold is reached.', type: 'number', unit: 'min', value: 15, min: 1, max: 1440 },
            ],
          },
          {
            title: 'Password policy',
            settings: [
              { id: 'pwMinLength', label: 'Minimum length', desc: 'Shortest acceptable password.', type: 'number', unit: 'chars', value: 12, min: 6, max: 64 },
              { id: 'pwComplexity', label: 'Complexity', desc: 'Required mix of character classes.', type: 'segmented', options: ['Low', 'Medium', 'High'], value: 'High' },
              { id: 'pwExpiry', label: 'Password expiry', desc: 'Force a change after this many days · 0 = never.', type: 'number', unit: 'days', value: 90, min: 0, max: 365 },
              { id: 'pwHistory', label: 'Prevent reuse', desc: 'Block the last N passwords from being reused.', type: 'number', unit: 'last', value: 5, min: 0, max: 24 },
              { id: 'security.checkCommonPasswords', label: 'Block common passwords', desc: 'Reject passwords from a built-in list of the most leaked passwords (offline, ~500 entries). Recommended on.', type: 'toggle', value: true },
            ],
          },
        ],
      },
      {
        title: 'Active connections',
        nav: true,
        navIcon: 'clock',
        blurb: 'Who and what is connected right now — AI clients and signed-in browser sessions.',
        children: [
          {
            title: 'AI connections',
            kind: 'aiconnections',
            blurb: "Every user's AI client currently connected to this organization. Disconnect to cut access immediately.",
          },
          {
            title: 'Signed-in sessions',
            kind: 'sessions',
            blurb: 'Active browser sessions across the org. Revoke one, or force a logout of everyone.',
          },
        ],
      },
      {
        title: "Journal d'audit",
        kind: 'auditlog',
        nav: true,
        navIcon: 'list',
        blurb: "Trace append-only de qui a fait quoi, quand : connexions (réussies et échouées), MFA, jetons API, changements de rôles, settings, webhooks et toutes les mutations. Export JSON Lines / CEF. Aucune suppression possible — seule la purge de rétention efface.",
      },
      {
        title: 'Encryption keys',
        kind: 'cryptokeys',
        nav: true,
        navIcon: 'key',
        blurb: "Chiffrement at-rest : provider de KEK actif (keyring local, KMS ou HSM), distribution des DEK par clé, et rotation des clés (KEK = re-wrap sans toucher aux données, DEK = re-chiffrement des secrets).",
      },
      {
        title: "SIEM / Forwarding syslog",
        nav: true,
        navIcon: 'arrowRight',
        blurb: "Envoi temps réel du journal d'audit vers un collecteur externe, alertes de sécurité temps réel et rétention du journal.",
        children: [
      {
        title: 'Forwarding syslog',
        blurb: "Envoi temps réel du journal d'audit vers un collecteur externe (Splunk, Graylog, Wazuh…) en syslog RFC 5424 sur TCP ou TLS, framing octet-counting. Livraison at-least-once (retries automatiques) — dédupliquer par champ id côté SIEM.",
        settings: [
          { id: 'audit.syslog.enabled', label: 'Forwarder vers un SIEM', desc: "Kill switch. Quand désactivé, le journal reste consultable dans l'app mais rien n'est envoyé.", type: 'toggle', value: false },
          { id: 'audit.syslog.host', label: 'Hôte du collecteur', desc: 'Nom DNS ou IP du récepteur syslog.', type: 'text', value: '', placeholder: 'siem.internal', mono: true },
          { id: 'audit.syslog.port', label: 'Port', desc: '6514 = syslog-TLS standard, 514 = TCP brut usuel.', type: 'number', value: 6514, min: 1, max: 65535 },
          { id: 'audit.syslog.protocol', label: 'Transport', desc: 'TLS recommandé — le journal contient des données sensibles (IPs, emails).', type: 'segmented', options: ['tls', 'tcp'], value: 'tls' },
          { id: 'audit.syslog.caPem', label: 'CA du collecteur (PEM)', desc: "Certificat CA à faire confiance si le collecteur présente un certificat interne / auto-signé. Vide = magasin système.", type: 'text', value: '', placeholder: '-----BEGIN CERTIFICATE-----', mono: true },
          { id: 'audit.syslog.clientCertPem', label: 'Certificat client mTLS (PEM)', desc: "Pour les collecteurs qui exigent l'authentification mutuelle. Le certificat (public) vit ici ; la CLÉ PRIVÉE est montée sur le worker via le secret Swarm `syslog_client_key` — jamais en base. Une seule clé par déploiement. Vide = pas de mTLS.", type: 'text', value: '', placeholder: '-----BEGIN CERTIFICATE-----', mono: true },
          { id: 'audit.syslog.minSeverity', label: 'Sévérité minimale', desc: 'INFO = tout (y compris chaque mutation) ; CRITICAL = uniquement les événements de sécurité.', type: 'segmented', options: ['INFO', 'WARNING', 'CRITICAL'], value: 'INFO' },
          { id: 'audit.syslog.test', label: 'Test de connexion', desc: "Envoie un message audit.test au collecteur avec la configuration ENREGISTRÉE (sauvegarder d'abord). Le résultat s'affiche ici après quelques secondes.", type: 'action', actionLabel: 'Tester la connexion' },
        ],
      },
      {
        title: 'Alertes de sécurité',
        blurb: "Détection temps réel sur le journal d'audit. Quand le seuil est franchi : email à tous les admins + webhook `audit.alert` (Teams, automation, SIEM push). Une alerte max par compte et par heure.",
        settings: [
          { id: 'audit.alerts.loginFailures.enabled', label: 'Alerte brute-force', desc: 'Alerter quand un même compte accumule des échecs de connexion. Recommandé activé.', type: 'toggle', value: true },
          { id: 'audit.alerts.loginFailures.threshold', label: "Seuil d'échecs", desc: "Nombre d'échecs de connexion sur un même compte qui déclenche l'alerte.", type: 'number', unit: 'échecs', value: 5, min: 3, max: 50 },
          { id: 'audit.alerts.loginFailures.windowMinutes', label: 'Fenêtre de détection', desc: 'Les échecs sont comptés sur cette fenêtre glissante.', type: 'number', unit: 'min', value: 10, min: 1, max: 120 },
        ],
      },
      {
        title: 'Rétention du journal',
        settings: [
          { id: 'audit.retentionDays', label: 'Rétention des entrées d\'audit', desc: 'Les entrées plus anciennes sont purgées par un cron quotidien. Seul mécanisme de suppression du journal.', type: 'number', unit: 'days', value: 365, min: 30, max: 3650 },
          { id: 'audit.archive.enabled', label: 'Archiver avant purge', desc: "Exporte les entrées en JSONL gzip vers le stockage objet (Garage) AVANT leur suppression — rétention froide illimitée pour la conformité. Fail-safe : si l'archivage échoue, la purge est sautée.", type: 'toggle', value: false },
        ],
      },
        ],
      },
      {
        title: 'Support & diagnostics',
        kind: 'diagnostics',
        nav: true,
        navIcon: 'gauge',
        blurb: 'Generates a diagnostic snapshot (DB/Redis/storage health, job queues, redacted settings, recent errors) to send us in case of an incident. The procedure also indicates which infrastructure logs (Docker, reverse proxy, HA database) to collect on the hosts.',
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications & Email',
    icon: 'bell',
    blurb: "Branded templates and the org's default notification preferences. Per-user overrides come later — these defaults apply to everyone.",
    sections: [
      {
        title: 'Master switch',
        blurb: 'Stops every outbound notification in one click. Useful during incidents or SMTP migrations — no need to toggle each event below.',
        settings: [
          { id: 'notif.enabled', label: 'Enable email notifications', desc: 'Kill switch. When off, no email is sent regardless of the preferences below.', type: 'toggle', value: true },
        ],
      },
      {
        title: 'Sender identity',
        settings: [
          { id: 'notif.logoUrl', label: 'Email header logo', desc: 'Override URL of the logo shown at the top of every notification email. Leave empty to inherit the organization logo (Organization → Profile). Falls back to the From name as text if both are empty.', type: 'text', value: '', placeholder: 'Inherits org logo if empty', mono: true },
          { id: 'notif.accentColor', label: 'Template accent colour', desc: 'Buttons and links in outbound email.', type: 'color', options: accents, value: '#d9604c' },
          { id: 'notif.fromName', label: 'From name', desc: 'Display name on outbound notifications.', type: 'text', value: 'Vaks Notifications' },
          { id: 'notif.fromAddress', label: 'From address', desc: 'The email shown to recipients. Must be on a domain accepted by your SMTP relay.', type: 'text', value: 'no-reply@vaks-pm.local', mono: true },
          { id: 'notif.replyTo', label: 'Reply-to address', desc: 'Where replies go (e.g. a real inbox or support address). Leave empty to let replies bounce off the From address.', type: 'text', value: '', placeholder: 'support@company.com', mono: true },
          { id: 'notif.preview', label: 'Preview template', desc: 'Render an assignment email with the branding above (opens in a new tab).', type: 'action', actionLabel: 'Open preview' },
        ],
      },
      {
        title: 'Default preferences',
        settings: [
          { id: 'notif.onAssignment', label: 'On assignment', desc: 'Email a member when a task is assigned to them.', type: 'toggle', value: true },
          { id: 'notif.onMention', label: 'On @mention', desc: "Email a member when they're mentioned in a comment.", type: 'toggle', value: true },
          { id: 'notif.onDueDate', label: 'On approaching due date', desc: 'Remind assignees before a task is due.', type: 'toggle', value: true },
          { id: 'notif.dueLeadDays', label: 'Due-date lead time', desc: 'Days before the due date when the reminder is sent.', type: 'number', unit: 'days', value: 1, min: 0, max: 30 },
          { id: 'notif.onStatusChange', label: 'On status change', desc: 'Notify watchers when a task moves columns.', type: 'toggle', value: false },
          { id: 'notif.onOverEstimate', label: 'On estimate overrun', desc: 'Email the project managers when the cumulative logged time on a task crosses its estimate (one mail per crossing).', type: 'toggle', value: false },
        ],
      },
      {
        title: 'Delivery cadence',
        blurb: 'Bundle non-urgent notifications and prevent night-time pings.',
        settings: [
          { id: 'notif.digest', label: 'Email digest', desc: 'Bundled summary instead of per-event mail.', type: 'select', options: ['off', 'daily', 'weekly'], value: 'off' },
          { id: 'notif.digestHour', label: 'Digest delivery hour', desc: 'Hour (0-23, UTC for now) at which the daily/weekly digest is dispatched.', type: 'number', unit: 'h', value: 8, min: 0, max: 23 },
          { id: 'notif.quietHoursStart', label: 'Quiet hours start', desc: 'Hour (0-23, UTC) — no email is sent from this time. Leave empty to disable quiet hours.', type: 'number', unit: 'h', value: 0, min: 0, max: 23 },
          { id: 'notif.quietHoursEnd', label: 'Quiet hours end', desc: 'Hour (0-23, UTC) — emails resume from this time.', type: 'number', unit: 'h', value: 0, min: 0, max: 23 },
        ],
      },
      {
        title: 'Deliveries',
        kind: 'emaildeliveries',
        nav: true,
        navIcon: 'inbox',
        blurb: "Journal des derniers envois d'emails : statut (en file / envoyé / échec), template, destinataire et erreur SMTP. Lecture seule — utile pour diagnostiquer un problème de notification.",
      },
    ],
  },
  {
    id: 'automations',
    label: 'Automations',
    icon: 'refresh',
    blurb: 'Built-in automation rules shipped with the product. Enable each rule and tune its thresholds — alerts go out by email and to any Teams-format webhook subscribed to `automation.alert`. Every automatic action is recorded in the audit log as SYSTEM.',
    sections: [
      {
        title: 'Automation engine',
        blurb: 'Global switch and schedule. Daily rules run once a day at the hour below (UTC). Alerts respect the notification quiet hours — avoid placing the daily hour inside them.',
        settings: [
          { id: 'automations.enabled', label: 'Enable automations', desc: 'Kill switch for the whole engine. When off, no rule runs and nothing is sent.', type: 'toggle', value: true },
          { id: 'automations.dailyHour', label: 'Daily run hour', desc: 'Hour (0-23, UTC) at which the daily rules are evaluated.', type: 'number', unit: 'h', value: 7, min: 0, max: 23 },
        ],
      },
      {
        title: 'Task hygiene',
        blurb: 'Keeps the boards honest: dormant, overdue, stalled or unassigned tasks are flagged to the right people once a day (one alert per task per week).',
        settings: [
          { id: 'automations.onHoldDormant.enabled', label: 'Dormant on-hold tasks', desc: 'Alert the project managers when a task has been on hold without any movement.', type: 'toggle', value: true },
          { id: 'automations.onHoldDormant.days', label: 'Dormant after', desc: 'Days on hold without update before the alert.', type: 'number', unit: 'days', value: 5, min: 1, max: 90 },
          { id: 'automations.overdue.enabled', label: 'Overdue tasks', desc: 'Alert the assignees and the project managers when a task passes its due date without being done.', type: 'toggle', value: true },
          { id: 'automations.overdue.graceDays', label: 'Grace period', desc: 'Days past the due date before the alert fires.', type: 'number', unit: 'days', value: 0, min: 0, max: 30 },
          { id: 'automations.inProgressInactive.enabled', label: 'Stalled in-progress tasks', desc: 'Nudge the assignees when an in-progress task shows no activity.', type: 'toggle', value: true },
          { id: 'automations.inProgressInactive.days', label: 'Stalled after', desc: 'Days without activity before the nudge.', type: 'number', unit: 'days', value: 7, min: 1, max: 90 },
          { id: 'automations.unassignedStale.enabled', label: 'Unassigned tasks', desc: 'Alert the project managers when a to-do task still has no assignee.', type: 'toggle', value: true },
          { id: 'automations.unassignedStale.days', label: 'Unassigned after', desc: 'Days since creation before the alert.', type: 'number', unit: 'days', value: 3, min: 1, max: 60 },
          { id: 'automations.externalBlockedStale.enabled', label: 'Blocked by an external provider', desc: 'Alert the assignees and the project managers when a task stays flagged as blocked by an external provider.', type: 'toggle', value: true },
          { id: 'automations.externalBlockedStale.days', label: 'Blocked for', desc: 'Days flagged as blocked by an external provider before the alert.', type: 'number', unit: 'days', value: 5, min: 1, max: 90 },
        ],
      },
      {
        title: 'Deadlines',
        blurb: 'Milestones that will not land on time. The due-date reminder itself lives under Notifications & Email.',
        settings: [
          { id: 'automations.milestoneAtRisk.enabled', label: 'Milestones at risk', desc: 'Alert the project managers when a milestone is approaching while some of its predecessors are still unfinished.', type: 'toggle', value: true },
          { id: 'automations.milestoneAtRisk.days', label: 'Look ahead', desc: 'Days before the milestone date to start checking.', type: 'number', unit: 'days', value: 7, min: 1, max: 60 },
          { id: 'automations.autoplanOverflow.enabled', label: 'Plan overflows a deadline', desc: 'Alert the project managers when an applied auto-plan cannot fit some tasks before their due date. Only fires on apply, never on preview.', type: 'toggle', value: false },
        ],
      },
      {
        title: 'Workload',
        blurb: 'Capacity signals based on real availability (work schedule, time off and holidays deducted). Alerts go to the team leads of the person concerned.',
        settings: [
          { id: 'automations.overload.enabled', label: 'Overloaded people', desc: "Alert the team leads when someone's allocations exceed their capacity next week.", type: 'toggle', value: true },
          { id: 'automations.overload.thresholdPct', label: 'Overload threshold', desc: 'Percentage of available capacity above which the alert fires.', type: 'number', unit: '%', value: 100, min: 50, max: 300 },
          { id: 'automations.underload.enabled', label: 'Spare capacity', desc: 'Alert the team leads when someone is under-allocated — useful for staffing upcoming work.', type: 'toggle', value: false },
          { id: 'automations.underload.thresholdPct', label: 'Underload threshold', desc: 'Percentage of available capacity below which the alert fires.', type: 'number', unit: '%', value: 50, min: 0, max: 100 },
          { id: 'automations.underload.weeks', label: 'Look-ahead window', desc: 'Number of weeks considered when measuring under-allocation.', type: 'number', unit: 'weeks', value: 2, min: 1, max: 12 },
          { id: 'automations.utilization.enabled', label: 'Billable utilization', desc: 'Alert the team leads when someone logs too little of their time on billable projects. Measured per person on the finished week — billability is a project property, so a per-project ratio would always be 100% or 0%.', type: 'toggle', value: false },
          { id: 'automations.utilization.thresholdPct', label: 'Utilization target', desc: 'Share of logged time expected on billable projects.', type: 'number', unit: '%', value: 60, min: 0, max: 100 },
          { id: 'automations.timeOffConflict.enabled', label: 'Time off vs plan', desc: 'Alert the project managers when approved time off overlaps allocations already planned — the plan goes stale the moment the leave is entered.', type: 'toggle', value: true },
          { id: 'automations.allocationWindowMissed.enabled', label: 'Allocated but never started', desc: 'Alert the allocated people and the project managers when a task had time allocated for it, but its planned window closed and it never left To do. Based on status, not on logged time — an empty timesheet is the normal case without daily entries.', type: 'toggle', value: true },
          { id: 'automations.allocationWindowMissed.graceDays', label: 'Grace period', desc: 'Days after the window closes before the alert fires.', type: 'number', unit: 'days', value: 1, min: 0, max: 30 },
        ],
      },
      {
        title: 'Timesheet',
        blurb: 'Weekly checks run on the finished week, on the day and hour set below.',
        settings: [
          { id: 'automations.timesheetReminder.enabled', label: 'Timesheet reminder', desc: 'Remind people whose timesheet covers less than the target share of their capacity.', type: 'toggle', value: true },
          { id: 'automations.timesheetReminder.thresholdPct', label: 'Completeness target', desc: 'Share of the expected capacity below which the reminder is sent.', type: 'number', unit: '%', value: 80, min: 0, max: 100 },
          { id: 'automations.timesheetReminder.weekday', label: 'Weekly run day', desc: 'Day the weekly rules run — 1 = Monday … 7 = Sunday.', type: 'number', value: 5, min: 1, max: 7 },
          { id: 'automations.timesheetReminder.hour', label: 'Weekly run hour', desc: 'Hour (0-23, UTC) the weekly rules run.', type: 'number', unit: 'h', value: 16, min: 0, max: 23 },
          { id: 'automations.overtime.enabled', label: 'High overtime', desc: 'Alert the team leads when someone declares a lot of overtime in a week.', type: 'toggle', value: false },
          { id: 'automations.overtime.hoursPerWeek', label: 'Overtime threshold', desc: 'Declared overtime hours in a single week above which the alert fires.', type: 'number', unit: 'h', value: 5, min: 1, max: 40 },
        ],
      },
      {
        // Titre distinct de la section « Finance » du groupe Organisation :
        // les maps i18n sont keyées par le titre anglais (cf. SECTION_KEY).
        title: 'Budget alerts',
        blurb: 'Budget signals on active projects that have a budget set. Alerts go to the project managers.',
        settings: [
          { id: 'automations.budgetThreshold.enabled', label: 'Budget thresholds', desc: 'Alert when the actual cost of a project crosses a share of its budget.', type: 'toggle', value: true },
          { id: 'automations.budgetThreshold.tiers', label: 'Thresholds', desc: 'Comma-separated percentages, e.g. "80,100". One alert per threshold crossed. Five maximum.', type: 'text', value: '80,100', mono: true, placeholder: '80,100' },
          { id: 'automations.forecastOverrun.enabled', label: 'Forecast overrun', desc: 'Alert when the projected cost at completion exceeds the budget, even though the actual spend is still within it.', type: 'toggle', value: true },
        ],
      },
      {
        title: 'Skills',
        blurb: 'Checked when a task is created, not on a schedule.',
        settings: [
          { id: 'automations.skillGapOnCreate.enabled', label: 'Missing skill on new tasks', desc: 'Alert the project managers when a task requires a skill that nobody on the project covers (direct members and members of assigned teams, expired skills excluded).', type: 'toggle', value: true },
        ],
      },
      {
        title: 'AI agents',
        blurb: 'Cost and review signals for AI agents. Note: tasks an agent keeps failing are already handled by the poison-task escalation under Agent policies — it removes the agent rather than just warning.',
        settings: [
          { id: 'automations.agentBudget.enabled', label: 'Agent budget running out', desc: 'Warn before agents get blocked. The daily, monthly, per-project and per-task caps are enforced at claim time; this alerts at the threshold below so the cap can be raised in time.', type: 'toggle', value: true },
          { id: 'automations.agentBudget.thresholdPct', label: 'Budget warning threshold', desc: 'Share of an agent budget above which the warning fires.', type: 'number', unit: '%', value: 80, min: 10, max: 100 },
          { id: 'automations.deliverableStale.enabled', label: 'Deliverables awaiting review', desc: 'Nudge the project managers when a submitted deliverable has been waiting for review — the work stays blocked until someone reviews it.', type: 'toggle', value: true },
          { id: 'automations.deliverableStale.hours', label: 'Waiting for', desc: 'Hours a deliverable may sit in review before the nudge.', type: 'number', unit: 'h', value: 24, min: 1, max: 336 },
        ],
      },
      {
        title: 'Projects',
        blurb: 'Whole-project signals, alerted to the project managers.',
        settings: [
          { id: 'automations.projectEndSoon.enabled', label: 'Projects ending with open work', desc: 'Alert when an active project reaches its end date while tasks are still open.', type: 'toggle', value: true },
          { id: 'automations.projectEndSoon.days', label: 'Look ahead', desc: 'Days before the project end date to start checking.', type: 'number', unit: 'days', value: 7, min: 1, max: 60 },
          { id: 'automations.projectInactive.enabled', label: 'Idle active projects', desc: 'Alert when an active project shows no activity at all — no task update, no logged time, no comment.', type: 'toggle', value: false },
          { id: 'automations.projectInactive.days', label: 'Idle after', desc: 'Days without any activity before the alert.', type: 'number', unit: 'days', value: 14, min: 1, max: 180 },
        ],
      },
    ],
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: 'zap',
    blurb: "Compétences référencées dans l'organisation. Les skills servent à orienter l'assignation des tâches et l'auto-plan vers les bons profils.",
    sections: [
      {
        title: 'Settings',
        settings: [
          {
            id: 'skills.maxLevel',
            label: 'Niveau maximum',
            desc: "Borne supérieure du niveau qu'un utilisateur peut atteindre sur un skill (1..N). Utilisé partout : éditeur de niveau utilisateur, niveau souhaité par tâche, scoring des suggestions et de l'auto-plan.",
            type: 'number',
            unit: 'lvl',
            value: 10,
            min: 1,
            max: 100,
            step: 1,
          },
          {
            id: 'skills.selfEditEnabled',
            label: 'Auto-édition par les utilisateurs',
            desc: "Si activé, chaque utilisateur peut modifier ses propres niveaux de skills. Sinon, seuls les Org Admins et les Team Leads des équipes de l'utilisateur peuvent le faire.",
            type: 'toggle',
            value: false,
          },
          {
            id: 'skills.catalogWriteMode',
            label: 'Qui peut créer un skill',
            desc: "Détermine qui peut ajouter, renommer ou supprimer un skill du catalogue. Chaque niveau inclut tous les précédents.",
            type: 'select',
            options: ['admin', 'portfolio_manager', 'team_lead', 'everyone'],
            value: 'admin',
          },
        ],
      },
      {
        title: 'Lifecycle — montée en compétence à la clôture',
        settings: [
          {
            id: 'skills.autoBumpOnProjectClose',
            label: 'Auto-bump à la clôture d\'un projet',
            desc: "Si activé, à chaque passage d'un projet en COMPLETED, les UserSkill des participants sont incrémentés sur les ProjectSkill du projet (créés si absents). L'historique de compétences se construit naturellement au fil des projets — c'est la fonction métier qui rend Skills utile en ESN.",
            type: 'toggle',
            value: true,
          },
          {
            id: 'skills.autoBumpDelta',
            label: 'Niveaux ajoutés par projet clôturé',
            desc: 'Capé par le niveau maximum. Garder à 1 sauf cas particulier (un projet = +1 niveau).',
            type: 'number',
            unit: 'lvl',
            value: 1,
            min: 1,
            max: 10,
            step: 1,
          },
        ],
      },
      {
        title: 'Lifecycle — décrémentation par inactivité (decay)',
        settings: [
          {
            id: 'skills.decayEnabled',
            label: 'Décrémentation automatique des skills inutilisés',
            desc: "Si activé, un cron quotidien décrémente les UserSkill non touchés depuis la période choisie. Modélise l'oubli / perte de pratique. Lorsque le niveau atteint 0, le skill est retiré de l'utilisateur. Option opt-in (désactivée par défaut).",
            type: 'toggle',
            value: false,
          },
          {
            id: 'skills.decayPeriodDays',
            label: 'Période d\'inactivité avant décrémentation',
            desc: "Nombre de jours sans mise à jour d'un UserSkill avant qu'il ne soit décrémenté. Défaut 365 (un an).",
            type: 'number',
            unit: 'days',
            value: 365,
            min: 30,
            max: 3650,
            step: 30,
          },
          {
            id: 'skills.decayDelta',
            label: 'Niveaux retirés par période',
            desc: 'Combien de niveaux sont retirés à chaque cycle de decay. Garder à 1 (le skill descend doucement, on ne saute pas d\'un niveau).',
            type: 'number',
            unit: 'lvl',
            value: 1,
            min: 1,
            max: 10,
            step: 1,
          },
        ],
      },
      {
        title: 'Catalogue',
        kind: 'skillslist',
        nav: true,
        navIcon: 'list',
        blurb: 'Référentiel des skills disponibles. Renommer ou supprimer un skill impacte toutes les tâches et utilisateurs qui le référencent.',
      },
      {
        title: 'Import en masse (CSV)',
        kind: 'skillsimport',
        nav: true,
        navIcon: 'download',
        blurb: 'Import bulk de niveaux utilisateur via CSV `email,skill,level[,category]` (4ᵉ colonne catégorie optionnelle). Crée les skills manquants en option. Idempotent.',
      },
      {
        title: 'Grille de niveaux',
        kind: 'skillslevelscale',
        nav: true,
        navIcon: 'sort',
        blurb: "Donne un libellé sémantique à chaque niveau (ex. 1=Découverte, 3=Autonome, 5=Senior, 7=Expert). Org-wide — appliqué à toutes les vues qui affichent un niveau (compétences user, niveau requis sur les tâches).",
      },
    ],
  },
  {
    id: 'customization',
    label: 'Customization',
    icon: 'sliders',
    blurb: 'Tailor Vaks to your process: define custom fields on tasks and projects.',
    sections: [
      {
        title: 'Custom fields',
        kind: 'customfields',
        nav: true,
        navIcon: 'list',
        blurb: 'Add your own fields to tasks and projects (reference, environment, sign-off…). A field can be restricted to specific projects.',
      },
      {
        title: 'Custom fields governance',
        blurb: 'Who may create and edit custom field definitions.',
        settings: [
          { id: 'customFields.writeMode', label: 'Who can manage custom fields', desc: 'A custom field shapes your data model, so the default is admin-only. Each level includes the previous ones.', type: 'select', options: ['admin', 'portfolio_manager', 'team_lead', 'everyone'], value: 'admin' },
        ],
      },
      {
        title: 'Custom Status',
        kind: 'customstatuses',
        nav: true,
        navIcon: 'flag',
        blurb: 'Add sub-statuses under the built-in statuses (e.g. “Client validation” under In review, “Waiting on client” under On hold). Shown on the board inside the parent column. A sub-status can be restricted to specific projects.',
      },
      {
        title: 'Custom Status governance',
        blurb: 'Who may create and edit sub-statuses.',
        settings: [
          { id: 'customStatuses.writeMode', label: 'Who can manage sub-statuses', desc: 'Sub-statuses shape every project board, so the default is admin-only. Each level includes the previous ones.', type: 'select', options: ['admin', 'portfolio_manager', 'team_lead', 'everyone'], value: 'admin' },
        ],
      },
    ],
  },
  {
    id: 'data',
    label: 'Data Management',
    icon: 'download',
    blurb: 'Soft-delete cleanup and GDPR data portability.',
    sections: [
      {
        title: 'Retention & cleanup',
        settings: [
          { id: 'autoPurge', label: 'Auto-purge soft-deleted records', desc: 'When ON, a background job permanently erases trashed items older than the grace period below. OFF by default — nothing is auto-deleted until you enable it.', type: 'toggle', value: false },
          { id: 'purgeAfter', label: 'Purge after', desc: 'Grace period before auto-purge erases soft-deleted data. Only applies to automatic purge — the manual "Purge now" button ignores it.', type: 'number', unit: 'years', value: 10, min: 1, max: 30 },
          { id: 'purgeNow', label: 'Purge now', desc: 'Erase all soft-deleted records immediately.', type: 'action', actionLabel: 'Purge records', danger: true },
        ],
      },
      {
        title: 'Portability',
        settings: [
          { id: 'exportData', label: 'Export organization data', desc: 'Full machine-readable export for GDPR / portability.', type: 'action', actionLabel: 'Export data' },
        ],
      },
    ],
  },
];
