/* ============================================================
   Vaks — Admin Panel (gated on isAdmin via Workspace).
   Ported from the design's AdminPanel.jsx. Settings are local
   for now — saving updates the in-memory baseline. Users + teams
   are loaded live from the API; everything else is the schema
   shipped in admin-schema.ts.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Icon, Avatar, BrandMark } from './primitives';
import { useConfirm } from './confirm';
import { api, saveBlob } from '../api/client';
import { ConfirmDialog } from './projects/shared';
import type {
  UserDto,
  TeamWithMembersDto,
  RoleDto,
  UserDirectoryRowDto,
  UserImportResultDto,
  PasswordPolicyDto,
} from '@vaks-pm/shared';
import {
  validatePassword,
  passwordRules,
  isValidEmail,
  examplePassword,
} from '../lib/passwordPolicy';
import { useAuth } from '../auth/AuthContext';
import { useFormat } from '../lib/format';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import {
  ADMIN_GROUPS,
  type AdminGroup,
  type AdminSection,
  type AdminSetting,
} from './admin-schema';
import './admin.css';
import ActiveSessionsPanel from './ActiveSessionsPanel';
import WebhooksSection from './WebhooksSection';
import AuditLogSection from './AuditLogSection';
import EncryptionKeysSection from './EncryptionKeysSection';
import DiagnosticsSection from './DiagnosticsSection';
import EmailDeliveriesSection from './EmailDeliveriesSection';
import SsoSection from './SsoSection';
import TicketingConnectorsSection from './TicketingConnectorsSection';
import AgentsSection from './AgentsSection';
import AgentPoliciesSection from './AgentPoliciesSection';
import AgentRunsSection from './AgentRunsSection';
import AgentConnectorsSection from './AgentConnectorsSection';
import CiConnectorsSection from './CiConnectorsSection';
import AgentTrustIssuersSection from './AgentTrustIssuersSection';
import CollabSpacesSection from './CollabSpacesSection';
import McpSection from './McpSection';
import OrgAiConnectionsSection from './OrgAiConnectionsSection';
import LicenseSection from './LicenseSection';
import ApiTokensSection from './ApiTokensSection';
import SkillsSection from './SkillsSection';
import CustomFieldsSection from './CustomFieldsSection';
import CustomStatusesSection from './CustomStatusesSection';
import {
  SkillsImportSection,
  SkillsLevelScaleSection,
} from './SkillGapSection';

const EDITABLE = new Set(['toggle', 'select', 'segmented', 'text', 'number', 'color', 'workdays', 'country', 'secret']);

/* ------------------------------------------------------------ i18n maps
   Schema setting ids carry dots ('org.logoUrl', 'smtp.host') — map each to
   the camelCase key suffix used in admin.json (setting.<suffix>.label/.desc/
   .action). Same idea for group ids and section titles. */
const SETTING_KEY: Record<string, string> = {
  defaultRole: 'defaultRole',
  bulkImport: 'bulkImport',
  orgName: 'orgName',
  'org.logoUrl': 'orgLogoUrl',
  locale: 'locale',
  'i18n.defaultLanguage': 'defaultLanguage',
  hoursPerDay: 'hoursPerDay',
  defaultWorkDays: 'defaultWorkDays',
  weekStart: 'weekStart',
  'autoplan.concentration': 'autoplanConcentration',
  'holidays.defaultCountry': 'holidayCountry',
  'finance.fiscalYearStartMonth': 'fiscalYearStart',
  aiEnabled: 'aiEnabled',
  suggestTasks: 'suggestTasks',
  suggestAssignees: 'suggestAssignees',
  'smtp.host': 'smtpHost',
  'smtp.port': 'smtpPort',
  'smtp.encryption': 'smtpEncryption',
  'smtp.authMode': 'smtpAuthMode',
  'smtp.user': 'smtpUser',
  'smtp.password': 'smtpPassword',
  'smtp.test': 'smtpTest',
  apiVersion: 'apiVersion',
  apiTokens: 'apiTokens',
  'webhooks.managePolicy': 'webhooksManagePolicy',
  'webhooks.domainAllowlist': 'webhooksDomainAllowlist',
  'webhooks.entraTenantAllowlist': 'webhooksEntraTenantAllowlist',
  // NB : les settings `teams.provisioning.*` ne sont plus rendus comme un
  // formulaire plat (ils vivent dans la carte de CollabSpacesSection), donc plus
  // besoin de les mapper ici. ⚠️ Les clés i18n `setting.teamsProv*.label/desc`
  // restent, elles, UTILISÉES par cette carte — ne pas les supprimer.
  'security.requireMfa': 'requireMfa',
  'security.ssoOnly': 'ssoOnly',
  sessionTimeout: 'sessionTimeout',
  'security.lockoutMaxAttempts': 'lockoutMaxAttempts',
  'security.lockoutDurationMinutes': 'lockoutDuration',
  activeSessions: 'activeSessions',
  forceLogout: 'forceLogout',
  pwMinLength: 'pwMinLength',
  pwComplexity: 'pwComplexity',
  pwExpiry: 'pwExpiry',
  pwHistory: 'pwHistory',
  'security.checkCommonPasswords': 'checkCommonPasswords',
  'audit.syslog.enabled': 'syslogEnabled',
  'audit.syslog.host': 'syslogHost',
  'audit.syslog.port': 'syslogPort',
  'audit.syslog.protocol': 'syslogProtocol',
  'audit.syslog.caPem': 'syslogCaPem',
  'audit.syslog.clientCertPem': 'syslogClientCertPem',
  'audit.syslog.minSeverity': 'syslogMinSeverity',
  'audit.syslog.test': 'syslogTest',
  'audit.alerts.loginFailures.enabled': 'alertsLoginFailuresEnabled',
  'audit.alerts.loginFailures.threshold': 'alertsLoginFailuresThreshold',
  'audit.alerts.loginFailures.windowMinutes': 'alertsLoginFailuresWindow',
  'audit.retentionDays': 'retentionDays',
  'audit.archive.enabled': 'archiveEnabled',
  'notif.enabled': 'notifEnabled',
  'notif.logoUrl': 'notifLogoUrl',
  'notif.accentColor': 'notifAccentColor',
  'notif.fromName': 'notifFromName',
  'notif.fromAddress': 'notifFromAddress',
  'notif.replyTo': 'notifReplyTo',
  'notif.preview': 'notifPreview',
  'notif.onAssignment': 'notifOnAssignment',
  'notif.onMention': 'notifOnMention',
  'notif.onDueDate': 'notifOnDueDate',
  'notif.dueLeadDays': 'notifDueLeadDays',
  'notif.onStatusChange': 'notifOnStatusChange',
  'notif.onOverEstimate': 'notifOnOverEstimate',
  'notif.digest': 'notifDigest',
  'notif.digestHour': 'notifDigestHour',
  'notif.quietHoursStart': 'notifQuietHoursStart',
  'notif.quietHoursEnd': 'notifQuietHoursEnd',
  'skills.maxLevel': 'skillsMaxLevel',
  'skills.selfEditEnabled': 'skillsSelfEditEnabled',
  'skills.catalogWriteMode': 'skillsCatalogWriteMode',
  'skills.autoBumpOnProjectClose': 'skillsAutoBumpOnProjectClose',
  'skills.autoBumpDelta': 'skillsAutoBumpDelta',
  'skills.decayEnabled': 'skillsDecayEnabled',
  'skills.decayPeriodDays': 'skillsDecayPeriodDays',
  'skills.decayDelta': 'skillsDecayDelta',
  autoPurge: 'autoPurge',
  purgeAfter: 'purgeAfter',
  purgeNow: 'purgeNow',
  exportData: 'exportData',
  'billing.export.enabled': 'billingExportEnabled',
  'billing.export.frequency': 'billingExportFrequency',
  'billing.export.weekDay': 'billingExportWeekDay',
  'billing.export.monthDay': 'billingExportMonthDay',
  'billing.export.hour': 'billingExportHour',
  'billing.export.format': 'billingExportFormat',
  'billing.export.recipients': 'billingExportRecipients',
  billingExportSendNow: 'billingExportSendNow',
  'customFields.writeMode': 'customFieldsWriteMode',
  'customStatuses.writeMode': 'customStatusesWriteMode',
  'automations.enabled': 'automationsEnabled',
  'automations.dailyHour': 'automationsDailyHour',
  'automations.onHoldDormant.enabled': 'autoOnHoldDormantEnabled',
  'automations.onHoldDormant.days': 'autoOnHoldDormantDays',
  'automations.overdue.enabled': 'autoOverdueEnabled',
  'automations.overdue.graceDays': 'autoOverdueGraceDays',
  'automations.inProgressInactive.enabled': 'autoInProgressInactiveEnabled',
  'automations.inProgressInactive.days': 'autoInProgressInactiveDays',
  'automations.unassignedStale.enabled': 'autoUnassignedStaleEnabled',
  'automations.unassignedStale.days': 'autoUnassignedStaleDays',
  'automations.externalBlockedStale.enabled': 'autoExternalBlockedStaleEnabled',
  'automations.externalBlockedStale.days': 'autoExternalBlockedStaleDays',
  'automations.milestoneAtRisk.enabled': 'autoMilestoneAtRiskEnabled',
  'automations.milestoneAtRisk.days': 'autoMilestoneAtRiskDays',
  'automations.overload.enabled': 'autoOverloadEnabled',
  'automations.overload.thresholdPct': 'autoOverloadThreshold',
  'automations.underload.enabled': 'autoUnderloadEnabled',
  'automations.underload.thresholdPct': 'autoUnderloadThreshold',
  'automations.underload.weeks': 'autoUnderloadWeeks',
  'automations.utilization.enabled': 'autoUtilizationEnabled',
  'automations.utilization.thresholdPct': 'autoUtilizationThreshold',
  'automations.timesheetReminder.enabled': 'autoTimesheetReminderEnabled',
  'automations.timesheetReminder.thresholdPct': 'autoTimesheetReminderThreshold',
  'automations.timesheetReminder.weekday': 'autoTimesheetReminderWeekday',
  'automations.timesheetReminder.hour': 'autoTimesheetReminderHour',
  'automations.overtime.enabled': 'autoOvertimeEnabled',
  'automations.overtime.hoursPerWeek': 'autoOvertimeHours',
  'automations.budgetThreshold.enabled': 'autoBudgetThresholdEnabled',
  'automations.budgetThreshold.tiers': 'autoBudgetThresholdTiers',
  'automations.forecastOverrun.enabled': 'autoForecastOverrunEnabled',
  'automations.projectEndSoon.enabled': 'autoProjectEndSoonEnabled',
  'automations.projectEndSoon.days': 'autoProjectEndSoonDays',
  'automations.projectInactive.enabled': 'autoProjectInactiveEnabled',
  'automations.projectInactive.days': 'autoProjectInactiveDays',
  'automations.autoplanOverflow.enabled': 'autoAutoplanOverflowEnabled',
  'automations.timeOffConflict.enabled': 'autoTimeOffConflictEnabled',
  'automations.allocationWindowMissed.enabled': 'autoAllocationWindowMissedEnabled',
  'automations.allocationWindowMissed.graceDays': 'autoAllocationWindowMissedGraceDays',
  'automations.skillGapOnCreate.enabled': 'autoSkillGapEnabled',
  'automations.agentBudget.enabled': 'autoAgentBudgetEnabled',
  'automations.agentBudget.thresholdPct': 'autoAgentBudgetThreshold',
  'automations.deliverableStale.enabled': 'autoDeliverableStaleEnabled',
  'automations.deliverableStale.hours': 'autoDeliverableStaleHours',
};
const GROUP_KEY: Record<string, string> = {
  identity: 'identity',
  aiAgentManagement: 'aiAgentManagement',
  org: 'org',
  integrations: 'integrations',
  security: 'security',
  notifications: 'notifications',
  automations: 'automations',
  skills: 'skills',
  customization: 'customization',
  data: 'data',
};
/** Section title (English, as it appears in admin-schema) → key suffix. */
const SECTION_KEY: Record<string, string> = {
  Accounts: 'accounts',
  Users: 'users',
  Agents: 'agents',
  Policies: 'agentPolicies',
  'Usage & cost ledger': 'agentRuns',
  Teams: 'teams',
  Roles: 'roles',
  'Single sign-on': 'sso',
  Profile: 'profile',
  License: 'license',
  'Document templates': 'docTemplates',
  'Project management': 'projectMgmt',
  'Working time': 'workingTime',
  Finance: 'finance',
  'Scheduled billing export': 'billingExportSchedule',
  'AI connectors (MCP)': 'aiConnectors',
  'Agent directories': 'agentDirectories',
  'CI verification': 'ciVerification',
  'Federated agent identity': 'agentTrustIssuers',
  'Email (SMTP)': 'smtp',
  API: 'api',
  'Webhooks — gouvernance': 'webhooksGovernance',
  Governance: 'webhookGovernance',
  Endpoints: 'webhookEndpoints',
  Webhooks: 'webhooks',
  'Collaboration spaces': 'collabSpaces',
  'Clés API organisation': 'orgApiKeys',
  'Organization keys': 'orgKeys',
  Authentication: 'authentication',
  'Sign-in & sessions': 'signInSessions',
  'Password policy': 'passwordPolicy',
  'Support & diagnostics': 'diagnostics',
  'Active connections': 'activeConnections',
  'AI connections': 'aiConnections',
  'Signed-in sessions': 'signedInSessions',
  "Journal d'audit": 'auditLog',
  'Encryption keys': 'encryptionKeys',
  'SIEM / Forwarding syslog': 'siem',
  'Forwarding syslog': 'forwardingSyslog',
  'Alertes de sécurité': 'securityAlerts',
  'Rétention du journal': 'logRetention',
  'Master switch': 'masterSwitch',
  'Automation engine': 'automationEngine',
  'Task hygiene': 'automationTaskHygiene',
  Deadlines: 'automationDeadlines',
  Workload: 'automationWorkload',
  Timesheet: 'automationTimesheet',
  'Budget alerts': 'automationBudget',
  Skills: 'automationSkills',
  'AI agents': 'automationAgents',
  Projects: 'automationProjects',
  'Sender identity': 'senderIdentity',
  'Default preferences': 'defaultPreferences',
  'Delivery cadence': 'deliveryCadence',
  Settings: 'skillsSettings',
  'Lifecycle — montée en compétence à la clôture': 'skillsLifecycleClose',
  'Lifecycle — décrémentation par inactivité (decay)': 'skillsLifecycleDecay',
  Catalogue: 'skillsCatalog',
  'Custom fields': 'customFieldsSection',
  'Custom fields governance': 'customFieldsGovernance',
  'Custom Status': 'customStatusesSection',
  'Custom Status governance': 'customStatusesGovernance',
  'Import en masse (CSV)': 'skillsImport',
  'Grille de niveaux': 'skillsLevelScale',
  'Retention & cleanup': 'retentionCleanup',
  Portability: 'portability',
};

/** Réglages stockés en HEURE UTC — on affiche l'équivalent local (chantier #15). */
const UTC_HOUR_SETTINGS = new Set([
  'notif.digestHour',
  'notif.quietHoursStart',
  'notif.quietHoursEnd',
  'automations.dailyHour',
  'automations.timesheetReminder.hour',
]);
/** Nom du fuseau local résolu (ex. "Europe/Paris"). */
const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
})();
/** Convertit une heure UTC (0-23) en libellé "HHh" dans le fuseau local du navigateur. */
function localHourLabel(utcHour: number): string {
  if (!Number.isFinite(utcHour)) return '—';
  const offsetH = -new Date().getTimezoneOffset() / 60; // ex. +2 pour UTC+2
  const local = ((Math.round(utcHour) + offsetH) % 24 + 24) % 24;
  // Gère les décalages à la demi-heure (Inde, etc.).
  const h = Math.floor(local);
  const m = Math.round((local - h) * 60);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/** Cache process-wide pour la liste des pays — la lib date-holidays côté API
 * renvoie ~140 entrées, inutile de re-fetcher à chaque montage. */
let COUNTRY_CACHE: { code: string; name: string }[] | null = null;
/** True quand le cache pays a été rempli par le fallback hardcodé (service holidays
 *  down) plutôt que par l'API — sert à afficher un avertissement (chantier #17). */
let COUNTRY_DEGRADED = false;
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export type DayKey = typeof DAY_KEYS[number];
export type WorkDaysVal = Record<DayKey, boolean>;
const DEFAULT_WORKDAYS: WorkDaysVal = {
  mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false,
};

export function colorFromKey(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}

/**
 * Teinte stable dérivée d'un *id utilisateur* (UUID). Mod appliqué **à la fin**
 * sur un accumulateur 32 bits — **doit rester identique** à `hueFromId` de
 * `api.ts`, `MembersView`, `WorkloadView` pour que l'avatar d'un user ait la
 * même couleur partout. NE PAS utiliser `colorFromKey` (mod par itération,
 * réservé aux clés projet courtes) pour des ids utilisateur.
 */
export function hueFromId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/** Sections d'un groupe, en aplatissant les conteneurs nav (title/blurb + enfants).
 *  Les `settings` vivent soit directement sur une section, soit sur ses enfants —
 *  cette fonction renvoie toutes les sections porteuses de settings (top-level +
 *  enfants), pour l'indexation/recherche/dirty-tracking. */
function flatSections(g: AdminGroup): AdminSection[] {
  const out: AdminSection[] = [];
  for (const sec of g.sections) {
    out.push(sec);
    if (sec.children) out.push(...sec.children);
  }
  return out;
}

function buildIndex() {
  const initial: Record<string, unknown> = {};
  const flat: Array<AdminSetting & { group: AdminGroup; section: string }> = [];
  ADMIN_GROUPS.forEach((g) =>
    flatSections(g).forEach((sec) =>
      (sec.settings || []).forEach((s) => {
        if (EDITABLE.has(s.type)) initial[s.id] = s.value;
        flat.push({ ...s, group: g, section: sec.title });
      }),
    ),
  );
  return { initial, flat };
}

/* ------------------------------------------------------------ controls */

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      className={'tgl' + (value ? ' tgl-on' : '')}
      onClick={() => onChange(!value)}
    />
  );
}

function Sel({
  value,
  options,
  labels,
  onChange,
}: {
  value: string;
  options: string[];
  labels?: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="asel">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o, i) => (
          <option key={o} value={o}>
            {labels?.[i] ?? o}
          </option>
        ))}
      </select>
      <span className="asel-chev">
        <Icon name="chevDown" size={15} />
      </span>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o}
          className={'seg-btn' + (value === o ? ' seg-on' : '')}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function TextInput({
  value,
  placeholder,
  mono,
  onChange,
}: {
  value: string;
  placeholder?: string;
  mono?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <input
      className={'atext' + (mono ? ' mono' : '')}
      value={value}
      placeholder={placeholder || ''}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  );
}

/** Champ secret write-only : input password. Quand un secret est déjà
 *  configuré côté serveur (`configured`), le placeholder l'indique et la valeur
 *  reste vide tant que l'utilisateur ne saisit rien (= ne pas écraser). */
function SecretInput({
  value,
  configured,
  mono,
  onChange,
}: {
  value: string;
  configured?: boolean;
  mono?: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <input
      type="password"
      className={'atext' + (mono ? ' mono' : '')}
      value={value}
      placeholder={configured ? t('secretConfigured') : t('secretEnter')}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="new-password"
      spellCheck={false}
    />
  );
}

function NumberInput({
  value,
  unit,
  min = 0,
  max = 9999,
  step = 1,
  onChange,
}: {
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation('common');
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="anum">
      <button
        className="anum-btn"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        aria-label={t('stepper.decrease')}
      >
        –
      </button>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(clamp(v));
          else if (e.target.value === '') onChange(min);
        }}
      />
      <button
        className="anum-btn"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        aria-label={t('stepper.increase')}
      >
        +
      </button>
      {unit && <span className="anum-unit">{unit}</span>}
    </div>
  );
}

function ColorInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="acolor">
      {options.map((c) => (
        <button
          key={c}
          className={'acolor-sw' + (value === c ? ' on' : '')}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={c}
          title={c}
        />
      ))}
    </div>
  );
}

function Action({
  label,
  danger,
  badge,
  onAct,
}: {
  label: string;
  danger?: boolean;
  badge?: string;
  onAct: () => void;
}) {
  return (
    <div className="row gap3">
      {badge && <span className="set-badge">{badge}</span>}
      <button
        className={'btn btn-sm ' + (danger ? 'btn-danger' : 'btn-line')}
        onClick={onAct}
      >
        <Icon name="settings" size={15} />
        {label}
      </button>
    </div>
  );
}

function Workdays({
  value,
  onChange,
}: {
  value: WorkDaysVal;
  onChange: (v: WorkDaysVal) => void;
}) {
  const v = { ...DEFAULT_WORKDAYS, ...(value || {}) };
  return (
    <div className="seg" style={{ flexWrap: 'wrap' }}>
      {DAY_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={'seg-btn' + (v[k] ? ' seg-on' : '')}
          onClick={() => onChange({ ...v, [k]: !v[k] })}
          title={DAY_SHORT[k]}
          style={{ minWidth: 44 }}
        >
          {DAY_SHORT[k]}
        </button>
      ))}
    </div>
  );
}

function InfoView({ value, mono, ok }: { value: string; mono?: boolean; ok?: boolean }) {
  return (
    <span className={'ainfo' + (mono ? ' mono' : '')}>
      {ok && <span className="ainfo-dot" />}
      {value}
    </span>
  );
}

function CountrySelect({
  value,
  onChange,
  includeInherit,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Si true, ajoute une option "— Use organization default —" mappée sur ''. */
  includeInherit?: boolean;
}) {
  const { t } = useTranslation('admin');
  const [list, setList] = useState<{ code: string; name: string }[]>(
    () => COUNTRY_CACHE ?? [],
  );
  const [degraded, setDegraded] = useState(COUNTRY_DEGRADED);
  useEffect(() => {
    if (COUNTRY_CACHE) {
      setDegraded(COUNTRY_DEGRADED);
      return;
    }
    api
      .listHolidayCountries()
      .then((r) => {
        COUNTRY_CACHE = r.countries;
        COUNTRY_DEGRADED = false;
        setList(r.countries);
        setDegraded(false);
      })
      .catch(() => {
        // Fallback minimal — pas bloquant si l'API est down, mais on le SIGNALE :
        // la liste est dégradée (6 pays au lieu de ~140), l'admin doit savoir
        // que le service holidays est indisponible.
        const fallback = [
          { code: 'FR', name: 'France' },
          { code: 'LU', name: 'Luxembourg' },
          { code: 'BE', name: 'Belgium' },
          { code: 'DE', name: 'Germany' },
          { code: 'GB', name: 'United Kingdom' },
          { code: 'US', name: 'United States' },
        ];
        COUNTRY_CACHE = fallback;
        COUNTRY_DEGRADED = true;
        setList(fallback);
        setDegraded(true);
      });
  }, []);
  return (
    <div>
      <div className="asel">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {includeInherit && (
            <option value="">{t('country.useOrgDefault')}</option>
          )}
          {list.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} ({c.code})
            </option>
          ))}
        </select>
        <span className="asel-chev">
          <Icon name="chevDown" size={15} />
        </span>
      </div>
      {degraded && (
        <div
          className="md-span"
          style={{
            color: 'var(--warn, #b45309)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 4,
          }}
        >
          <Icon name="warn" size={13} />
          {t('country.degraded')}
        </div>
      )}
    </div>
  );
}

function Control({
  s,
  value,
  configured,
  onChange,
  onAct,
}: {
  s: AdminSetting;
  value: unknown;
  configured?: boolean;
  onChange: (v: unknown) => void;
  onAct: () => void;
}) {
  switch (s.type) {
    case 'toggle':
      return <Toggle value={!!value} onChange={(v) => onChange(v)} />;
    case 'secret':
      return (
        <SecretInput
          value={String(value ?? '')}
          configured={configured}
          mono={s.mono}
          onChange={onChange}
        />
      );
    case 'select':
      return <Sel value={String(value ?? '')} options={s.options || []} labels={s.optionLabels} onChange={onChange} />;
    case 'segmented':
      return <Segmented value={String(value ?? '')} options={s.options || []} onChange={onChange} />;
    case 'text':
      return (
        <TextInput
          value={String(value ?? '')}
          placeholder={s.placeholder}
          mono={s.mono}
          onChange={onChange}
        />
      );
    case 'number':
      return (
        <NumberInput
          value={Number(value ?? 0)}
          unit={s.unit}
          min={s.min}
          max={s.max}
          step={s.step}
          onChange={(v) => onChange(v)}
        />
      );
    case 'color':
      return <ColorInput value={String(value ?? '')} options={s.options || []} onChange={onChange} />;
    case 'workdays':
      return (
        <Workdays
          value={(value as WorkDaysVal) ?? DEFAULT_WORKDAYS}
          onChange={(v) => onChange(v)}
        />
      );
    case 'country':
      return (
        <CountrySelect
          value={String(value ?? '')}
          onChange={(v) => onChange(v)}
        />
      );
    case 'info':
      return <InfoView value={String(s.value ?? '')} mono={s.mono} ok={s.ok} />;
    case 'action':
      return <Action label={s.actionLabel || s.label} danger={s.danger} badge={s.badge} onAct={onAct} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------ user list */

interface ScheduleSummary {
  isDefault: boolean;
  hoursPerWeek: number;
  daysOn: DayKey[];
  raw: import('@vaks-pm/shared').WorkScheduleDto | null;
}

export function summarizeSchedule(s: import('@vaks-pm/shared').WorkScheduleDto): ScheduleSummary {
  const perDay: Record<DayKey, number> = {
    mon: s.hoursMon, tue: s.hoursTue, wed: s.hoursWed,
    thu: s.hoursThu, fri: s.hoursFri, sat: s.hoursSat, sun: s.hoursSun,
  };
  const daysOn = DAY_KEYS.filter((k) => perDay[k] > 0);
  const hoursPerWeek = DAY_KEYS.reduce((a, k) => a + perDay[k], 0);
  return { isDefault: !!s.isDefault, hoursPerWeek, daysOn, raw: s };
}

export function UserScheduleModal({
  user,
  initial,
  onClose,
  onSaved,
  flash,
}: {
  user: UserDto;
  initial: import('@vaks-pm/shared').WorkScheduleDto | null;
  onClose: () => void;
  onSaved: (s: import('@vaks-pm/shared').WorkScheduleDto) => void;
  flash: (msg: string) => void;
}) {
  const { t } = useTranslation('admin');
  // If no schedule yet, prefill with the inherited (default) shape.
  const init = initial ?? {
    id: '', userId: user.id, effectiveFrom: '',
    hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, hoursSat: 0, hoursSun: 0,
    occupancyPct: 100, isDefault: true,
  };
  const [hours, setHours] = useState<number>(
    () => {
      const nonZero = DAY_KEYS.map((k) => (init as any)[`hours${k[0].toUpperCase() + k.slice(1)}`] as number).find((v) => v > 0);
      return nonZero ?? 8;
    },
  );
  const [days, setDays] = useState<WorkDaysVal>(() => ({
    mon: init.hoursMon > 0, tue: init.hoursTue > 0, wed: init.hoursWed > 0,
    thu: init.hoursThu > 0, fri: init.hoursFri > 0, sat: init.hoursSat > 0, sun: init.hoursSun > 0,
  }));
  const [occupancyPct, setOccupancy] = useState(init.occupancyPct ?? 100);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const next = await api.putWorkSchedule(user.id, {
        hoursMon: days.mon ? hours : 0,
        hoursTue: days.tue ? hours : 0,
        hoursWed: days.wed ? hours : 0,
        hoursThu: days.thu ? hours : 0,
        hoursFri: days.fri ? hours : 0,
        hoursSat: days.sat ? hours : 0,
        hoursSun: days.sun ? hours : 0,
        occupancyPct,
      });
      onSaved({ ...next, isDefault: false });
      flash(t('users.scheduleUpdated', { name: user.name }));
      onClose();
    } catch (e) {
      flash(t('panel.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setSaving(true);
    try {
      await api.deleteWorkSchedule(user.id);
      const fresh = await api.getWorkSchedule(user.id);
      onSaved(fresh);
      flash(t('users.followsOrgDefaults', { name: user.name }));
      onClose();
    } catch (e) {
      flash(t('users.resetFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  const totalHrs = DAY_KEYS.filter((k) => days[k]).length * hours;

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div className="md-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="md-head">
          <Avatar
            user={{
              id: user.id, name: user.name,
              short: user.name.split(' ')[0],
              initials: user.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
              role: '', hue: hueFromId(user.id), online: false,
            }}
            size={38}
            title={false}
          />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('users.scheduleEyebrow')}</div>
            <div className="md-title truncate">{user.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <div className="md-field">
            <div className="md-label">{t('users.workingDays')}</div>
            <Workdays value={days} onChange={setDays} />
            <div className="md-span">
              <Trans
                t={t}
                i18nKey="users.daysPerWeek"
                count={DAY_KEYS.filter((k) => days[k]).length}
                values={{ count: DAY_KEYS.filter((k) => days[k]).length, hours: totalHrs }}
                components={[<b />]}
              />
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.hoursPerWorkingDay')}</div>
            <NumberInput value={hours} unit="h" min={0} max={24} step={0.5} onChange={setHours} />
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.targetOccupancy')}</div>
            <NumberInput value={occupancyPct} unit="%" min={0} max={150} step={5} onChange={setOccupancy} />
            <div className="md-span">{t('users.occupancyHint')}</div>
          </div>
          {init.isDefault && (
            <div className="md-span" style={{ color: 'var(--text-3)' }}>
              {t('users.inheritsDefault')}
            </div>
          )}
        </div>
        <div className="md-foot">
          <div className="md-foot-meta">
            {init.isDefault ? t('users.noCustomSchedule') : t('users.customScheduleSet')}
          </div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            {!init.isDefault && (
              <button className="btn btn-line btn-sm" onClick={resetToDefault} disabled={saving}>
                {t('users.resetToOrgDefault')}
              </button>
            )}
            <button className="btn btn-accent" onClick={save} disabled={saving}>
              {saving ? t('common:saving') : t('users.saveSchedule')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ user editor */

type UserEditMode = { kind: 'create' } | { kind: 'edit'; user: UserDto };

function UserEditModal({
  mode,
  onClose,
  onSaved,
  onDeleted,
  flash,
}: {
  mode: UserEditMode;
  onClose: () => void;
  onSaved: (u: UserDto) => void;
  onDeleted: (id: string) => void;
  flash: (m: string) => void;
}) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const init = mode.kind === 'edit' ? mode.user : null;
  const [name, setName] = useState(init?.name ?? '');
  const [email, setEmail] = useState(init?.email ?? '');
  const [timezone, setTimezone] = useState(init?.timezone ?? 'UTC');
  const [status, setStatus] = useState<'ACTIVE' | 'SUSPENDED'>(init?.status ?? 'ACTIVE');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmAnon, setConfirmAnon] = useState(false);
  // Org-scoped roles only — they're the ones assigned via Membership.
  // Project-scoped roles (PROJECT_MANAGER, etc.) are managed per-project in
  // the Projects panel and aren't selectable here.
  const [orgRoles, setOrgRoles] = useState<RoleDto[]>([]);
  const initialRoleKey =
    init?.roleKey ?? (init?.isAdmin ? 'ORG_ADMIN' : 'ORG_MEMBER');
  const [roleKey, setRoleKey] = useState(initialRoleKey);
  // Grant orthogonal « AI administrator » (Membership.isAgentAdmin) : accorde
  // agent:manage par-dessus le rôle org, empilable, sans consommer le slot.
  const [isAgentAdmin, setIsAgentAdmin] = useState<boolean>(!!init?.isAgentAdmin);
  // Siège de licence. Création : `true` par défaut (user « normal »). Édition :
  // valeur courante du compte (false = admin-only / parqué, pas d'accès dashboard).
  const [licensed, setLicensed] = useState<boolean>(init?.licensed ?? true);
  const [countryCode, setCountryCode] = useState<string>(init?.countryCode ?? '');
  const [employeeId, setEmployeeId] = useState<string>(init?.employeeId ?? '');
  // Security (edit-only, derived from the user record). Optimistic update on
  // toggle / reset — admin endpoints don't return the full user.
  const [mfaEnabled, setMfaEnabled] = useState<boolean>(!!init?.mfaEnabled);
  const [allowLocalLogin, setAllowLocalLogin] = useState<boolean>(!!init?.allowLocalLogin);
  const [securityBusy, setSecurityBusy] = useState(false);
  // Password policy (validation amont, miroir du serveur).
  const [policy, setPolicy] = useState<PasswordPolicyDto | null>(null);

  useEffect(() => {
    api
      .listRoles()
      .then((all) => setOrgRoles(all.filter((r) => r.scope === 'ORG')))
      .catch(() => setOrgRoles([]));
    api.getPasswordPolicy().then(setPolicy).catch(() => setPolicy(null));
  }, []);

  const emailInvalid = email.trim().length > 0 && !isValidEmail(email);
  const pwErrors = password && policy ? validatePassword(password, policy) : [];

  async function save() {
    if (!name.trim() || !email.trim()) {
      flash(t('users.nameEmailRequired'));
      return;
    }
    if (emailInvalid) {
      flash(t('users.enterValidEmail'));
      return;
    }
    if (password && pwErrors.length) {
      flash(t('users.passwordNotMeetPolicy'));
      return;
    }
    setSaving(true);
    try {
      if (mode.kind === 'create') {
        const created = await api.createUser({
          name: name.trim(),
          email: email.trim(),
          password: password || undefined,
          timezone,
          status,
          roleKey,
          licensed,
          employeeId: employeeId.trim() || undefined,
        });
        // Le create-user endpoint actuel ne pose pas encore countryCode ; si
        // l'admin l'a renseigné à la création, on fait un patch immédiat.
        let final = created;
        if (countryCode) {
          try {
            final = await api.updateUser(created.id, { countryCode });
          } catch {
            /* non bloquant : le user est créé sans country */
          }
        }
        onSaved(final);
        flash(t('users.created', { name: final.name }));
      } else {
        const patch: Parameters<typeof api.updateUser>[1] = {};
        if (name.trim() !== init!.name) patch.name = name.trim();
        if (email.trim() !== init!.email) patch.email = email.trim();
        if (roleKey !== initialRoleKey) patch.roleKey = roleKey;
        if (isAgentAdmin !== !!init!.isAgentAdmin) patch.isAgentAdmin = isAgentAdmin;
        if (timezone !== init!.timezone) patch.timezone = timezone;
        if (status !== (init!.status ?? 'ACTIVE')) patch.status = status;
        if (licensed !== (init!.licensed ?? true)) patch.licensed = licensed;
        if (password) patch.password = password;
        if ((init!.countryCode ?? '') !== countryCode) {
          patch.countryCode = countryCode || null;
        }
        if ((init!.employeeId ?? '') !== employeeId.trim()) {
          patch.employeeId = employeeId.trim() || null;
        }
        const updated = Object.keys(patch).length
          ? await api.updateUser(init!.id, patch)
          : init!;
        onSaved(updated);
        flash(t('users.updated', { name: updated.name }));
      }
      onClose();
    } catch (e) {
      flash(t('panel.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (mode.kind !== 'edit') return;
    if (!(await confirm({ title: t('common:delete'), message: t('users.deleteConfirm', { name: init!.name }), confirmLabel: t('common:delete'), danger: true }))) return;
    setSaving(true);
    try {
      await api.deleteUser(init!.id);
      onDeleted(init!.id);
      flash(t('users.deleted', { name: init!.name }));
      onClose();
    } catch (e) {
      flash(t('users.failed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function anonymize() {
    if (mode.kind !== 'edit') return;
    setSaving(true);
    try {
      const res = await api.anonymizeUser(init!.id);
      flash(res.alreadyAnonymized ? t('users.alreadyAnonymized') : t('users.anonymized', { name: init!.name }));
      setConfirmAnon(false);
      onDeleted(init!.id); // retire de la liste active (compte désormais pseudonymisé/suspendu)
      onClose();
    } catch (e) {
      flash(t('users.failed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function unlock() {
    if (mode.kind !== 'edit') return;
    setSaving(true);
    try {
      const updated = await api.unlockUser(init!.id);
      // Merge : l'endpoint unlock ne renvoie pas roleKey/roleName/isAgentAdmin
      // (dérivés de la membership) — on préserve ceux de la ligne courante.
      onSaved({ ...init!, ...updated });
      flash(
        updated.wasLocked
          ? t('users.unlocked', { name: init!.name })
          : t('users.notLocked', { name: init!.name }),
      );
      onClose();
    } catch (e) {
      flash(t('users.failed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  async function exportData() {
    if (mode.kind !== 'edit') return;
    setSaving(true);
    try {
      const data = await api.exportUserData(init!.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      saveBlob(blob, `gdpr-export-${init!.id}.json`);
      flash(t('users.exportDone'));
    } catch (e) {
      flash(t('users.failed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <div className="md-overlay" onMouseDown={onClose}>
      <div className="md-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="md-head">
          <div className="anav-mark" style={{ width: 38, height: 38 }}>
            <Icon name="user" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{mode.kind === 'create' ? t('users.addUser') : t('users.editUser')}</div>
            <div className="md-title truncate">{mode.kind === 'create' ? t('users.newAccount') : init!.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <div className="md-field">
            <div className="md-label">{t('users.fullName')}</div>
            <input
              className="atext"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: '100%' }}
              placeholder="Jane Smith"
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.email')}</div>
            <input
              className="atext mono"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                width: '100%',
                borderColor: emailInvalid ? 'var(--danger, #e5484d)' : undefined,
              }}
              placeholder="jane@vaks-pm.local"
              type="email"
            />
            {emailInvalid && (
              <div className="md-span" style={{ color: 'var(--danger, #e5484d)' }}>
                {t('users.invalidEmail')}
              </div>
            )}
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.organizationRole')}</div>
            <div className="asel" style={{ width: '100%' }}>
              <select
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
                style={{ width: '100%' }}
              >
                {orgRoles.length === 0 && (
                  <option value={roleKey}>{t('users.loading')}</option>
                )}
                {orgRoles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
              <span className="asel-chev">
                <Icon name="chevDown" size={15} />
              </span>
            </div>
            <div className="md-span">
              {roleKey === 'ORG_ADMIN'
                ? t('users.roleAdminDesc')
                : roleKey === 'PORTFOLIO_MANAGER'
                  ? t('users.rolePortfolioDesc')
                  : t('users.roleMemberDesc')}
            </div>
          </div>
          {/* Grant orthogonal « AI administrator » : empilable par-dessus n'importe
              quel rôle org (un ORG_ADMIN l'a déjà via son rôle). Édition seulement. */}
          {mode.kind !== 'create' && roleKey !== 'ORG_ADMIN' && (
            <div className="md-field">
              <div className="md-label">{t('users.agentAdmin', { defaultValue: 'AI administrator' })}</div>
              <div className="seg">
                <button
                  type="button"
                  className={'seg-btn' + (isAgentAdmin ? ' seg-on' : '')}
                  onClick={() => setIsAgentAdmin(true)}
                >
                  {t('users.agentAdminOn', { defaultValue: 'Granted' })}
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (!isAgentAdmin ? ' seg-on' : '')}
                  onClick={() => setIsAgentAdmin(false)}
                >
                  {t('users.agentAdminOff', { defaultValue: 'None' })}
                </button>
              </div>
              <div className="md-span">
                {t('users.agentAdminDesc', {
                  defaultValue:
                    'Can manage all AI agents org-wide (identities, tokens, directories, policies) without full admin rights. Stacks on the org role above.',
                })}
              </div>
            </div>
          )}
          <div className="md-field">
            <div className="md-label">{t('users.status')}</div>
            <div className="seg">
              <button
                type="button"
                className={'seg-btn' + (status === 'ACTIVE' ? ' seg-on' : '')}
                onClick={() => setStatus('ACTIVE')}
              >
                {t('users.statusActive')}
              </button>
              <button
                type="button"
                className={'seg-btn' + (status === 'SUSPENDED' ? ' seg-on' : '')}
                onClick={() => setStatus('SUSPENDED')}
              >
                {t('users.statusSuspended')}
              </button>
            </div>
          </div>
          {mode.kind === 'edit' &&
            init?.lockedUntil &&
            new Date(init.lockedUntil) > new Date() && (
              <div
                className="md-field"
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: '1px solid color-mix(in oklch, var(--warn, #b45309) 40%, var(--border))',
                  background: 'color-mix(in oklch, var(--warn, #b45309) 8%, transparent)',
                }}
              >
                <div
                  className="md-label"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warn, #b45309)' }}
                >
                  <Icon name="lock" size={15} /> {t('users.lockedTitle')}
                </div>
                <div className="md-span" style={{ marginBottom: 12 }}>
                  {t('users.lockedHint', {
                    until: new Date(init.lockedUntil).toLocaleString(),
                  })}
                </div>
                <div className="row">
                  <button
                    className="btn btn-sm"
                    onClick={unlock}
                    disabled={saving}
                    style={{
                      border: '1px solid color-mix(in oklch, var(--warn, #b45309) 45%, var(--border))',
                      color: 'var(--warn, #b45309)',
                      background: 'color-mix(in oklch, var(--warn, #b45309) 12%, transparent)',
                    }}
                  >
                    <Icon name="unlock" size={14} /> {t('users.unlockUser')}
                  </button>
                </div>
              </div>
            )}
          <div className="md-field">
            <div className="md-label">{t('users.seat')}</div>
            <div className="seg">
              <button
                type="button"
                className={'seg-btn' + (licensed ? ' seg-on' : '')}
                onClick={() => setLicensed(true)}
              >
                {t('users.seatLicensed')}
              </button>
              <button
                type="button"
                className={'seg-btn' + (!licensed ? ' seg-on' : '')}
                onClick={() => setLicensed(false)}
              >
                {t('users.seatNone')}
              </button>
            </div>
            <div className="md-span">
              {licensed ? t('users.seatLicensedDesc') : t('users.seatNoneDesc')}
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.timezone')}</div>
            <input
              className="atext mono"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={{ width: '100%' }}
              placeholder="Europe/Paris"
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.employeeId')}</div>
            <input
              className="atext mono"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              style={{ width: '100%' }}
              placeholder="EMP-00123"
            />
            <div className="md-span">
              {t('users.employeeIdHint')}
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">{t('users.countryHolidays')}</div>
            <CountrySelect
              value={countryCode}
              onChange={setCountryCode}
              includeInherit
            />
            <div className="md-span">
              <Trans t={t} i18nKey="users.countryHint" components={[<strong />, <strong />, <em />]} />
            </div>
          </div>
          <div className="md-field">
            <div className="md-label">
              {mode.kind === 'create' ? t('users.initialPasswordOptional') : t('users.setPasswordOptional')}
            </div>
            <input
              className="atext mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%' }}
              placeholder={policy ? t('users.minLengthPlaceholder', { count: policy.minLength }) : t('users.minLengthFallback')}
              type="password"
              autoComplete="new-password"
            />
            {/* Checklist policy live — n'apparaît que pendant la saisie. */}
            {password && policy && (
              <div className="md-span" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {passwordRules(policy).map((r) => {
                  const ok = r.test(password);
                  return (
                    <span
                      key={r.labelKey}
                      style={{ color: ok ? 'var(--accent)' : 'var(--text-faint)' }}
                    >
                      {ok ? '✓' : '○'} {t(`common:${r.labelKey}`, r.params)}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="md-span">
              {t('users.passwordLocalHint')}
            </div>
          </div>

          {/* Reset par lien email — l'admin ne connaît jamais le mot de passe (#3). */}
          {mode.kind === 'edit' && (
            <div className="md-field">
              <div className="md-label">{t('users.passwordResetLink')}</div>
              <button
                type="button"
                className="btn btn-line btn-sm"
                disabled={securityBusy}
                onClick={async () => {
                  if (
                    !(await confirm({ title: t('common:confirm'), message: t('users.resetLinkConfirm', { email: init!.email }) }))
                  )
                    return;
                  setSecurityBusy(true);
                  try {
                    await api.sendUserPasswordReset(init!.id);
                    flash(t('users.resetLinkSent'));
                  } catch (e) {
                    flash(t('users.failed', { message: (e as Error).message }));
                  } finally {
                    setSecurityBusy(false);
                  }
                }}
              >
                <Icon name="inbox" size={14} /> {t('users.sendResetLink')}
              </button>
              <div className="md-span">
                {t('users.resetLinkHint')}
              </div>
            </div>
          )}

          {mode.kind === 'edit' && (
            <>
              <div className="md-field">
                <div className="md-label">{t('users.identitySource')}</div>
                <div className="row gap2">
                  <span className="pill pill-role">
                    {init!.authProvider ?? 'LOCAL'}
                  </span>
                  {init!.idpSource && (
                    <span className="pill pill-role" style={{ textTransform: 'uppercase' }}>
                      {init!.idpSource}
                    </span>
                  )}
                  {init!.authProvider && init!.authProvider !== 'LOCAL' && (
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {t('users.provisionedVia', { provider: init!.authProvider })}
                    </span>
                  )}
                </div>
              </div>
              {/* External ID = clé stable de l'IdP (objectId Entra / id SCIM).
                  Affiché en lecture seule : c'est l'IdP qui en est propriétaire,
                  un admin ne doit pas le modifier à la main. */}
              {(init!.externalId || (init!.authProvider && init!.authProvider !== 'LOCAL')) && (
                <div className="md-field">
                  <div className="md-label">{t('users.externalIdManaged')}</div>
                  <input
                    className="atext mono"
                    value={init!.externalId ?? '—'}
                    readOnly
                    disabled
                    style={{ width: '100%' }}
                  />
                  <div className="md-span">
                    {t('users.externalIdHint')}
                  </div>
                </div>
              )}
              <div className="md-field">
                <div className="md-label">{t('users.breakGlass')}</div>
                <div className="row gap2" style={{ alignItems: 'center' }}>
                  <button
                    type="button"
                    className={'seg-btn' + (allowLocalLogin ? ' seg-on' : '')}
                    onClick={async () => {
                      const next = !allowLocalLogin;
                      if (next && !(await confirm({ title: t('common:confirm'), message: t('users.breakGlassConfirm'), danger: true }))) return;
                      setSecurityBusy(true);
                      try {
                        const r = await api.setUserBreakGlass(init!.id, next);
                        setAllowLocalLogin(next);
                        if (!next) flash(t('users.breakGlassDisabled'));
                        else if (r.setupLinkSent)
                          flash(t('users.breakGlassEnabledLinkSent'));
                        else if (r.passwordSetupNeeded)
                          flash(t('users.breakGlassEnabledNoPassword'));
                        else flash(t('users.breakGlassEnabled'));
                      } catch (e) {
                        flash(t('users.failed', { message: (e as Error).message }));
                      } finally {
                        setSecurityBusy(false);
                      }
                    }}
                    disabled={securityBusy}
                  >
                    {allowLocalLogin ? t('users.enabled') : t('users.disabled')}
                  </button>
                </div>
                <div className="md-span">
                  {t('users.breakGlassHint')}
                </div>
              </div>
              <div className="md-field">
                <div className="md-label">{t('users.twoFactor')}</div>
                <div className="row gap2" style={{ alignItems: 'center' }}>
                  <span className="pill pill-role">
                    {mfaEnabled ? t('users.enabled') : t('users.disabled')}
                  </span>
                  {mfaEnabled && (
                    <button
                      type="button"
                      className="btn btn-line btn-sm"
                      disabled={securityBusy}
                      onClick={async () => {
                        if (!(await confirm({ title: t('common:confirm'), message: t('users.resetMfaConfirm', { name: init!.name }), danger: true }))) return;
                        setSecurityBusy(true);
                        try {
                          await api.adminResetMfa(init!.id);
                          setMfaEnabled(false);
                          flash(t('users.mfaReset'));
                        } catch (e) {
                          flash(t('users.mfaResetFailed', { message: (e as Error).message }));
                        } finally {
                          setSecurityBusy(false);
                        }
                      }}
                    >
                      {t('users.resetMfa')}
                    </button>
                  )}
                </div>
                <div className="md-span">
                  {t('users.twoFactorHint')}
                </div>
              </div>
            </>
          )}

          {mode.kind === 'edit' && (
            <div
              className="md-field"
              style={{
                marginTop: 6,
                padding: '14px 16px',
                borderRadius: 12,
                border: '1px solid color-mix(in oklch, var(--accent) 30%, var(--border))',
                background: 'color-mix(in oklch, var(--accent) 6%, transparent)',
              }}
            >
              <div
                className="md-label"
                style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)' }}
              >
                <Icon name="shield" size={15} /> {t('users.gdprSection')}
              </div>
              <div className="md-span" style={{ marginBottom: 12 }}>
                {t('users.gdprSectionHint')}
              </div>
              <div className="row gap2" style={{ flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => setConfirmAnon(true)}
                  disabled={saving || init?.status !== 'SUSPENDED'}
                  title={init?.status !== 'SUSPENDED' ? t('users.anonymizeRequiresSuspended') : undefined}
                  style={{
                    border: '1px solid color-mix(in oklch, var(--accent) 45%, var(--border))',
                    color: 'var(--accent)',
                    background: 'color-mix(in oklch, var(--accent) 12%, transparent)',
                  }}
                >
                  <Icon name="shield" size={14} /> {t('users.anonymize')}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={exportData}
                  disabled={saving}
                >
                  <Icon name="download" size={14} /> {t('users.exportData')}
                </button>
              </div>
              {init?.status !== 'SUSPENDED' && (
                <div className="md-span" style={{ marginTop: 8 }}>
                  {t('users.anonymizeRequiresSuspended')}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="md-foot">
          <div className="md-foot-meta">
            {mode.kind === 'edit' && (
              <button
                className="btn btn-danger btn-sm"
                onClick={remove}
                disabled={saving}
              >
                <Icon name="x" size={14} /> {t('users.deleteUser')}
              </button>
            )}
          </div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {t('common:cancel')}
            </button>
            <button className="btn btn-accent" onClick={save} disabled={saving}>
              {saving ? t('common:saving') : mode.kind === 'create' ? t('users.createUser') : t('users.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
    {confirmAnon && mode.kind === 'edit' && (
      <ConfirmDialog
        icon="shield"
        tone="accent"
        eyebrow={t('users.anonymize')}
        title={init!.name}
        confirmLabel={t('users.anonymize')}
        busyLabel={t('common:saving')}
        busy={saving}
        onConfirm={anonymize}
        onCancel={() => setConfirmAnon(false)}
      >
        <p style={{ margin: 0 }}>{t('users.anonymizeConfirm', { name: init!.name })}</p>
      </ConfirmDialog>
    )}
    </>
  );
}

/* ============================ CSV import (users) ============================ */

const CSV_TEMPLATE =
  'email,name,role,timezone,employeeId,countryCode\n' +
  'jane@acme.com,Jane Smith,ORG_MEMBER,Europe/Paris,EMP-001,FR\n' +
  'bob@acme.com,Bob Lee,Portfolio Manager,UTC,EMP-002,LU';

function UserImportModal({
  onClose,
  flash,
  onImported,
}: {
  onClose: () => void;
  flash: (m: string) => void;
  onImported: () => void;
}) {
  const { t } = useTranslation('admin');
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<UserImportResultDto | null>(null);
  const [committed, setCommitted] = useState(false);

  const runDryRun = async () => {
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const res = await api.importUsers(csv, false);
      setPreview(res);
      setCommitted(false);
    } catch (e) {
      flash(t('userImport.previewFailed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview || preview.willCreate === 0) return;
    setBusy(true);
    try {
      const res = await api.importUsers(csv, true);
      setPreview(res);
      setCommitted(true);
      flash(t('userImport.importedCount', { count: res.created }));
      onImported();
    } catch (e) {
      flash(t('userImport.importFailed', { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const badge = (r: import('@vaks-pm/shared').UserImportRowDto) => {
    const color =
      r.action === 'create'
        ? 'var(--accent)'
        : r.action === 'skip-existing'
          ? 'var(--text-faint)'
          : 'var(--danger, #e5484d)';
    const label =
      r.action === 'create'
        ? committed ? t('userImport.badgeCreated') : t('userImport.badgeWillCreate')
        : r.action === 'skip-existing'
          ? t('userImport.badgeExists')
          : t('userImport.badgeError');
    return (
      <span className="mono" style={{ color, fontSize: 11, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    );
  };

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(820px, 94vw)' }}
      >
        <div className="md-head">
          <div className="anav-mark" style={{ width: 38, height: 38 }}>
            <Icon name="users" size={20} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('userImport.title')}</div>
            <div className="md-title truncate">{t('userImport.heading')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body">
          <div className="md-span" style={{ marginBottom: 8 }}>
            <Trans
              t={t}
              i18nKey="userImport.columnsHelp"
              components={[
                <span className="mono" />,
                <span className="mono" />,
                <span className="mono" />,
                <span className="mono" />,
                <span className="mono" />,
                <span className="mono" />,
                <strong />,
              ]}
            />
          </div>
          <div className="row gap2" style={{ marginBottom: 8 }}>
            <button
              className="btn btn-line btn-sm"
              onClick={() => setCsv(CSV_TEMPLATE)}
              type="button"
            >
              {t('userImport.insertSample')}
            </button>
            <label className="btn btn-line btn-sm" style={{ cursor: 'pointer' }}>
              {t('userImport.loadFile')}
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    setCsv(String(reader.result ?? ''));
                    setPreview(null);
                  };
                  reader.readAsText(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <textarea
            className="atext mono"
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
            }}
            placeholder="email,name,role&#10;jane@acme.com,Jane Smith,ORG_MEMBER"
            spellCheck={false}
            style={{ width: '100%', minHeight: 130, resize: 'vertical' }}
          />
          {preview && (
            <div style={{ marginTop: 12 }}>
              <div
                className="row gap2"
                style={{ flexWrap: 'wrap', fontSize: 13, marginBottom: 8 }}
              >
                <span className="pill pill-role">{t('userImport.rows', { count: preview.total })}</span>
                <span style={{ color: 'var(--accent)' }}>
                  {committed ? t('userImport.created', { count: preview.created }) : t('userImport.willCreate', { count: preview.willCreate })}
                </span>
                {preview.skipped > 0 && (
                  <span style={{ color: 'var(--text-faint)' }}>{t('userImport.existingSkipped', { count: preview.skipped })}</span>
                )}
                {preview.invalid > 0 && (
                  <span style={{ color: 'var(--danger, #e5484d)' }}>{t('userImport.errors', { count: preview.invalid })}</span>
                )}
              </div>
              <div
                className="dir-card"
                style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }}
              >
                {preview.rows.map((r) => (
                  <div
                    key={r.line}
                    className="row gap2"
                    style={{
                      padding: '6px 10px',
                      borderBottom: '1px solid var(--border)',
                      alignItems: 'center',
                    }}
                  >
                    <span className="mono" style={{ color: 'var(--text-faint)', width: 28 }}>
                      {r.line}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }} className="truncate">
                      <strong>{r.email || '—'}</strong>{' '}
                      <span style={{ color: 'var(--text-3)' }}>{r.name}</span>
                      {r.roleKey && (
                        <span className="mono" style={{ color: 'var(--text-faint)' }}>
                          {' · '}{r.roleKey}
                        </span>
                      )}
                      {r.error && (
                        <span style={{ color: 'var(--danger, #e5484d)' }}> — {r.error}</span>
                      )}
                    </span>
                    {badge(r)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="md-foot">
          <button className="btn btn-line" onClick={onClose}>
            {committed ? t('common:close') : t('common:cancel')}
          </button>
          {!committed && (
            <>
              <button
                className="btn btn-line"
                onClick={runDryRun}
                disabled={busy || !csv.trim()}
              >
                {busy ? t('userImport.checking') : t('userImport.preview')}
              </button>
              <button
                className="btn btn-accent"
                onClick={commit}
                disabled={busy || !preview || preview.willCreate === 0}
              >
                {preview ? t('userImport.importN', { count: preview.willCreate }) : t('userImport.import')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const USERS_PAGE_SIZE = 50;

function UserList({
  flash,
  roles,
  roleFilter,
  onRoleFilterChange,
  onUsersChanged,
}: {
  flash: (m: string) => void;
  roles: RoleDto[];
  /** Filtre rôle externe (clic sur une carte rôle — chantier #5). */
  roleFilter?: string;
  onRoleFilterChange?: (key: string) => void;
  /** Bubble vers le parent pour rafraîchir la liste légère (TeamList, compteurs nav). */
  onUsersChanged: (next: UserDto[] | ((prev: UserDto[]) => UserDto[])) => void;
}) {
  const { t } = useTranslation('admin');
  const { license } = useAuth();
  // ----- Filtres serveur (recherche débouncée + statut + rôle) -----
  const [f, setF] = useState('');
  const [dSearch, setDSearch] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'SUSPENDED'>('ACTIVE');
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const roleKey = roleFilter ?? '';

  const [data, setData] = useState<UserDirectoryRowDto[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<{ active: number; suspended: number }>({
    active: 0,
    suspended: 0,
  });
  const [loading, setLoading] = useState(true);

  const [scheduleByUser, setScheduleByUser] = useState<Record<string, import('@vaks-pm/shared').WorkScheduleDto>>({});
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [userEdit, setUserEdit] = useState<UserEditMode | null>(null);

  // Debounce de la saisie de recherche → évite une requête par frappe.
  useEffect(() => {
    const id = setTimeout(() => setDSearch(f.trim()), 280);
    return () => clearTimeout(id);
  }, [f]);

  // Tout changement de filtre ramène à la première page.
  useEffect(() => setPage(1), [dSearch, status, roleKey]);

  // Fetch serveur paginé : schedules batchés dans la réponse (plus de N+1).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listUsersDirectory({
        search: dSearch || undefined,
        status,
        role: roleKey || undefined,
        page,
        pageSize: USERS_PAGE_SIZE,
      })
      .then((res) => {
        if (cancelled) return;
        setData(res.items);
        setTotal(res.total);
        setCounts(res.counts);
        const map: Record<string, import('@vaks-pm/shared').WorkScheduleDto> = {};
        for (const u of res.items) if (u.schedule) map[u.id] = u.schedule;
        setScheduleByUser((prev) => ({ ...prev, ...map }));
      })
      .catch(() => {
        if (!cancelled) {
          setData([]);
          setTotal(0);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [dSearch, status, roleKey, page, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const roleName = roles.find((r) => r.key === roleKey)?.name;

  const renderRow = (u: UserDto) => {
    const initials = u.name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    const sched = scheduleByUser[u.id];
    const sum = sched ? summarizeSchedule(sched) : null;
    return (
      <div className="dir-row" key={u.id}>
        <Avatar
          user={{
            id: u.id, name: u.name,
            short: u.name.split(' ')[0],
            initials, role: '', hue: hueFromId(u.id), online: false,
          }}
          size={32}
          title={false}
        />
        <div className="dir-id">
          <div className="dir-name">{u.name}</div>
          <div className="dir-email">{u.email}</div>
        </div>
        <div className="dir-title">
          {sum ? (
            <span>
              {sum.isDefault ? (
                <span style={{ color: 'var(--text-faint)' }}>{t('users.defaultPrefix')}</span>
              ) : (
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{t('users.customPrefix')}</span>
              )}
              {sum.daysOn.map((k) => DAY_SHORT[k]).join(' · ') || t('users.noWorkingDay')}
              {' · '}
              <span className="mono">{t('users.hoursPerWeekShort', { hours: sum.hoursPerWeek })}</span>
            </span>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>{t('users.loading')}</span>
          )}
        </div>
        <div className="row gap2" style={{ justifyContent: 'center' }}>
          <span className="pill pill-role" title={u.roleKey ?? undefined}>
            {u.roleName ?? (u.isAdmin ? t('users.orgAdmin') : t('users.orgMember'))}
          </span>
          {u.status === 'SUSPENDED' && (
            <span className="pill pill-status suspended">{t('users.suspendedPill')}</span>
          )}
          {u.status !== 'SUSPENDED' && u.licensed === false && (
            <span
              className="pill pill-status"
              title={u.isAdmin ? t('users.adminOnlyPillHint') : t('users.noSeatPillHint')}
            >
              {u.isAdmin ? t('users.adminOnlyPill') : t('users.noSeatPill')}
            </span>
          )}
        </div>
        <div className="row gap2" style={{ flexShrink: 0 }}>
          <button
            className="btn btn-line btn-sm"
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => setUserEdit({ kind: 'edit', user: u })}
          >
            <Icon name="pencil" size={14} /> {t('users.edit')}
          </button>
          <button
            className="btn btn-line btn-sm"
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => setEditing(u)}
          >
            <Icon name="cal" size={14} /> {t('users.schedule')}
          </button>
        </div>
      </div>
    );
  };

  const from = total === 0 ? 0 : (page - 1) * USERS_PAGE_SIZE + 1;
  const to = Math.min(page * USERS_PAGE_SIZE, total);
  const pageCount = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));

  return (
    <div>
      <div className="lfilter">
        <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
        <input
          value={f}
          onChange={(e) => setF(e.target.value)}
          placeholder={t('users.searchPlaceholder')}
        />
        <span className="lf-count">
          {from}–{to} / {total}
        </span>
        <button
          className="btn btn-accent btn-sm"
          style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
          onClick={() => setUserEdit({ kind: 'create' })}
        >
          <Icon name="plus" size={14} /> {t('users.newUser')}
        </button>
      </div>
      {/* Onglets de statut + filtre rôle. Comptes serveur indépendants de la page. */}
      <div className="row gap2" style={{ margin: '4px 0 12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="seg">
          <button
            className={'seg-btn' + (status === 'ACTIVE' ? ' seg-on' : '')}
            onClick={() => setStatus('ACTIVE')}
          >
            {t('users.activeCount', { count: counts.active })}
          </button>
          <button
            className={'seg-btn' + (status === 'SUSPENDED' ? ' seg-on' : '')}
            onClick={() => setStatus('SUSPENDED')}
          >
            {t('users.suspendedCount', { count: counts.suspended })}
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {license && typeof license.seatsUsed === 'number' && (
          <span
            className="pill pill-role"
            title={t('users.seatsUsedHint')}
            style={
              license.maxUsers != null && license.seatsUsed >= license.maxUsers
                ? { color: 'var(--danger, #dc2626)', fontWeight: 700 }
                : undefined
            }
          >
            {license.maxUsers != null
              ? t('users.seatsUsedOfMax', { used: license.seatsUsed, max: license.maxUsers })
              : t('users.seatsUsedUnlimited', { used: license.seatsUsed })}
          </span>
        )}
        {roleKey && (
          <span className="row gap1" style={{ fontSize: 13, color: 'var(--text-2)' }}>
            <Trans t={t} i18nKey="users.roleLabel" values={{ role: roleName ?? roleKey }} components={[<strong />]} />
            <button
              className="btn btn-line btn-sm"
              style={{ padding: '2px 8px' }}
              onClick={() => onRoleFilterChange?.('')}
              title={t('users.clearRoleFilter')}
            >
              <Icon name="x" size={12} /> {t('users.clear')}
            </button>
          </span>
        )}
      </div>
      {status === 'SUSPENDED' && (
        <div className="set-desc" style={{ marginBottom: 10, color: 'var(--text-faint)' }}>
          {t('users.suspendedNote')}
        </div>
      )}
      <div className="dir-card">
        {loading && (
          <div className="set-desc" style={{ padding: '16px' }}>
            {t('users.loading')}
          </div>
        )}
        {!loading && data.length === 0 && (
          <div className="set-desc" style={{ padding: '16px' }}>
            {t('users.noMatch')}
          </div>
        )}
        {!loading && data.map(renderRow)}
      </div>
      {/* Pagination serveur */}
      {pageCount > 1 && (
        <div className="row gap2" style={{ marginTop: 12, justifyContent: 'center', alignItems: 'center' }}>
          <button
            className="btn btn-line btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <Icon name="chevL" size={14} /> {t('users.prev')}
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {t('users.page', { page, pageCount })}
          </span>
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
        <UserScheduleModal
          user={editing}
          initial={scheduleByUser[editing.id] ?? null}
          onClose={() => setEditing(null)}
          onSaved={(s) => setScheduleByUser((m) => ({ ...m, [editing.id]: s }))}
          flash={flash}
        />
      )}
      {userEdit && (
        <UserEditModal
          mode={userEdit}
          onClose={() => setUserEdit(null)}
          onSaved={(u) => {
            reload();
            onUsersChanged((prev) =>
              prev.some((p) => p.id === u.id) ? prev.map((p) => (p.id === u.id ? u : p)) : [...prev, u],
            );
          }}
          onDeleted={(id) => {
            reload();
            onUsersChanged((prev) => prev.filter((p) => p.id !== id));
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

/* ============================ Document templates ============================ */

/** Référence des placeholders disponibles par type de document (chantier #7).
 *  Doit rester synchronisé avec `fillCharterTemplate` côté API (`charter-docx.ts`).
 *  Les libellés sont résolus via `t('ph.<token>')`. */
const TEMPLATE_PLACEHOLDERS: Record<string, string[]> = {
  CHARTER: [
    'projectKey', 'projectName', 'description', 'client', 'draftDate',
    'projectPurpose', 'objectives', 'scopeIn', 'scopeOut', 'deliverables',
    'milestones', 'stakeholders', 'sponsor', 'assumptions', 'constraints',
    'risks', 'budgetEstimate', 'successCriteria',
  ],
};

function TemplatePlaceholders({
  kind,
  flash,
}: {
  kind: string;
  flash: (msg: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  const list = TEMPLATE_PLACEHOLDERS[kind] ?? [];
  if (list.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        className="row gap1"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'var(--accent)', fontWeight: 600, fontSize: 12.5,
        }}
      >
        <Icon name={open ? 'chevDown' : 'chevR'} size={14} />
        {t('docTemplates.placeholdersReference', { count: list.length })}
      </button>
      {open && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 6,
            marginTop: 8,
          }}
        >
          {list.map((token) => (
            <button
              key={token}
              type="button"
              title={t('docTemplates.clickToCopy')}
              onClick={() => {
                navigator.clipboard
                  ?.writeText(`{${token}}`)
                  .then(() => flash(t('docTemplates.copied', { token: `{${token}}` })))
                  .catch(() => {});
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                padding: '6px 8px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <code className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
                {'{'}{token}{'}'}
              </code>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t(`ph.${token}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentTemplatesSection({
  flash,
}: {
  flash: (msg: string, warn?: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const fmt = useFormat();
  const [items, setItems] = useState<import('@vaks-pm/shared').DocumentTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingKind, setUploadingKind] = useState<string | null>(null);

  const refresh = React.useCallback(() => {
    setLoading(true);
    api
      .listDocumentTemplates()
      .then((rows) => setItems(rows))
      .catch((e) => flash(t('docTemplates.loadFailed', { message: (e as Error).message }), true))
      .finally(() => setLoading(false));
  }, [flash, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const KINDS: Array<{
    kind: import('@vaks-pm/shared').DocumentTemplateKind;
    label: string;
    desc: string;
  }> = [
    {
      kind: 'CHARTER',
      label: t('docTemplates.charterLabel'),
      desc: t('docTemplates.charterDesc'),
    },
  ];

  async function upload(kind: import('@vaks-pm/shared').DocumentTemplateKind, file: File) {
    setUploadingKind(kind);
    try {
      const next = await api.uploadDocumentTemplate(kind, file);
      const unknown = (next as { unknownTags?: string[] }).unknownTags ?? [];
      if (unknown.length) {
        flash(
          t('docTemplates.uploadedWithUnknown', {
            count: unknown.length,
            tags: unknown.map((tk) => `{${tk}}`).join(', '),
          }),
          true,
        );
      } else {
        flash(t('docTemplates.uploaded', { filename: next.filename }));
      }
      refresh();
    } catch (e) {
      flash((e as Error).message, true);
    } finally {
      setUploadingKind(null);
    }
  }

  async function download(kind: import('@vaks-pm/shared').DocumentTemplateKind) {
    try {
      const { blob, filename } = await api.downloadDocumentTemplate(kind);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      flash(t('docTemplates.downloadFailed', { message: (e as Error).message }), true);
    }
  }

  async function reset(kind: import('@vaks-pm/shared').DocumentTemplateKind) {
    if (!(await confirm({ title: t('common:confirm'), message: t('docTemplates.resetConfirm'), danger: true }))) return;
    try {
      await api.resetDocumentTemplate(kind);
      flash(t('docTemplates.reverted'));
      refresh();
    } catch (e) {
      flash((e as Error).message, true);
    }
  }

  if (loading) return <div className="md-empty">{t('docTemplates.loading')}</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {KINDS.map((k) => {
        const tpl = items.find((it) => it.kind === k.kind);
        const busy = uploadingKind === k.kind;
        return (
          <div key={k.kind} className="asection-card" style={{ padding: 14 }}>
            <div className="md-label" style={{ fontSize: 14 }}>{k.label}</div>
            <div className="md-span" style={{ marginBottom: 10 }}>{k.desc}</div>
            <TemplatePlaceholders kind={k.kind} flash={flash} />
            {tpl ? (
              <div
                className="md-member"
                style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: 10 }}
              >
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="md-member-name truncate">{tpl.filename}</div>
                  <div className="md-member-role">
                    {t('docTemplates.sizeUploaded', {
                      size: (tpl.sizeBytes / 1024).toFixed(1),
                      date: fmt.dateTime(tpl.uploadedAt),
                    })}
                    {tpl.uploadedBy ? t('docTemplates.uploadedBy', { name: tpl.uploadedBy.name }) : ''}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => download(k.kind)}>
                  {t('docTemplates.download')}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => reset(k.kind)}>
                  {t('docTemplates.resetToDefault')}
                </button>
              </div>
            ) : (
              <div className="md-span" style={{ color: 'var(--text-3)' }}>
                {t('docTemplates.usingDefault')}
              </div>
            )}
            <div className="row gap2" style={{ marginTop: 10 }}>
              <label
                className="btn btn-accent"
                style={{ cursor: busy ? 'wait' : 'pointer' }}
              >
                {busy ? t('docTemplates.uploading') : tpl ? t('docTemplates.replaceTemplate') : t('docTemplates.uploadTemplate')}
                <input
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(k.kind, f);
                    e.target.value = '';
                  }}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RoleList({
  roles,
  counts,
  onPickRole,
}: {
  roles: RoleDto[];
  /** Nombre d'utilisateurs org par roleKey (chantier #5). */
  counts: Record<string, number>;
  /** Clic sur une carte rôle org → ouvre la liste users filtrée. */
  onPickRole: (roleKey: string) => void;
}) {
  const { t } = useTranslation('admin');
  const orgRoles = roles.filter((r) => r.scope === 'ORG');
  const projectRoles = roles.filter((r) => r.scope === 'PROJECT');
  const group = (title: string, blurb: string, list: RoleDto[], clickable: boolean) => (
    <div className="asection">
      <div className="asection-title">{title}</div>
      <div className="set-desc" style={{ padding: '0 2px 10px' }}>{blurb}</div>
      <div className="asection-card">
        {list.map((r) => {
          const n = counts[r.key] ?? 0;
          return (
          <div
            className="set-row"
            key={r.id}
            style={{
              gridTemplateColumns: '1fr auto',
              cursor: clickable && n > 0 ? 'pointer' : undefined,
            }}
            onClick={clickable && n > 0 ? () => onPickRole(r.key) : undefined}
            title={clickable && n > 0 ? t('roles.viewUsersTitle', { count: n }) : undefined}
          >
            <div className="set-info">
              <div className="set-label">
                {r.name}
                <span className="set-badge mono">{r.key}</span>
                {r.isSystem && <span className="badge-soft">{t('roles.system')}</span>}
              </div>
              <div className="set-desc" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {r.permissions.length === 0 && <em>{t('roles.noPermissions')}</em>}
                {r.permissions.sort().map((p) => (
                  <span
                    key={p}
                    className="mono"
                    style={{
                      fontSize: 11,
                      padding: '2px 7px',
                      borderRadius: 'var(--r-pill)',
                      background: 'var(--surface-2)',
                      color: 'var(--text-2)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
            {clickable && (
              <div className="set-info" style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                <span
                  className="pill pill-role"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {t('roles.userCount', { count: n })}
                </span>
                {n > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4 }}>
                    {t('roles.view')}
                  </span>
                )}
              </div>
            )}
          </div>
          );
        })}
        {list.length === 0 && (
          <div className="set-desc" style={{ padding: '16px' }}>{t('roles.noRolesInScope')}</div>
        )}
      </div>
    </div>
  );
  return (
    <div>
      {group(
        t('roles.orgScope'),
        t('roles.orgScopeBlurb'),
        orgRoles,
        true,
      )}
      {group(
        t('roles.projectScope'),
        t('roles.projectScopeBlurb'),
        projectRoles,
        false,
      )}
    </div>
  );
}

/* ===================== Password policy live example ===================== */

function PasswordPolicyExample({
  minLength,
  complexity,
}: {
  minLength: number;
  complexity: 'Low' | 'Medium' | 'High';
}) {
  const { t } = useTranslation('admin');
  // On ne consomme que minLength + complexity ; les autres champs n'influent
  // pas sur la forme d'un mot de passe valide. Cast partiel volontaire.
  const policy = {
    minLength,
    complexity,
    historyCount: 0,
    expiryDays: 0,
    checkCommonPasswords: false,
  } as import('@vaks-pm/shared').PasswordPolicyDto;
  const example = examplePassword(policy);
  const rules = passwordRules(policy);
  return (
    <div
      className="asection-card"
      style={{ marginTop: 10, padding: '14px 16px' }}
    >
      <div className="set-label" style={{ marginBottom: 8 }}>
        {t('passwordExample.liveExample')}
        <span className="set-badge">{t('passwordExample.reflectsSettings')}</span>
      </div>
      <div className="row gap2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
          {t('passwordExample.validLooksLike')}
        </span>
        <code
          className="mono"
          style={{
            fontSize: 14,
            padding: '4px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-pill)',
            color: 'var(--accent)',
          }}
        >
          {example}
        </code>
      </div>
      <div
        className="md-span"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }}
      >
        {rules.map((r) => (
          <span key={r.labelKey} style={{ color: 'var(--text-2)' }}>
            ✓ {t(`common:${r.labelKey}`, r.params)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ============================ Project policy ========================= */

type PolicyMode = 'everyone' | 'roles' | 'teams';
interface ProjectPolicyDto {
  mode: PolicyMode;
  roleKeys: string[];
  teamIds: string[];
}

const DEFAULT_BILLABLE_POLICY: ProjectPolicyDto = {
  mode: 'roles',
  roleKeys: ['ORG_ADMIN', 'PORTFOLIO_MANAGER'],
  teamIds: [],
};
const DEFAULT_NON_BILLABLE_POLICY: ProjectPolicyDto = {
  mode: 'everyone',
  roleKeys: [],
  teamIds: [],
};

function normalizePolicy(raw: unknown, fallback: ProjectPolicyDto): ProjectPolicyDto {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;
  const mode = (['everyone', 'roles', 'teams'] as const).find((m) => m === o.mode) ?? fallback.mode;
  const roleKeys = Array.isArray(o.roleKeys)
    ? (o.roleKeys.filter((k) => typeof k === 'string') as string[])
    : [];
  const teamIds = Array.isArray(o.teamIds)
    ? (o.teamIds.filter((k) => typeof k === 'string') as string[])
    : [];
  return { mode, roleKeys, teamIds };
}

/** Liste paginée (10/page) des personnes réellement autorisées par une policy.
 *  Composant top-level (état de page stable) : on affiche une liste simple
 *  nom + email plutôt qu'un nuage de pastilles, lisible même à 200+ personnes. */
const EFFECTIVE_PAGE_SIZE = 10;
function EffectivePeople({ people }: { people: UserDto[] }) {
  const { t } = useTranslation('admin');
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  // Recherche par nom / email — évite de paginer sur des dizaines de pages.
  const q = filter.trim().toLowerCase();
  const shown = q
    ? people.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q))
    : people;
  const pageCount = Math.max(1, Math.ceil(shown.length / EFFECTIVE_PAGE_SIZE));
  // Si la liste rétrécit (changement de policy OU filtre), on reborne.
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * EFFECTIVE_PAGE_SIZE;
  const slice = shown.slice(start, start + EFFECTIVE_PAGE_SIZE);
  if (people.length === 0) {
    return <em className="set-desc">{t('projectPolicy.nobody')}</em>;
  }
  // Le champ de recherche n'apparaît que quand ça vaut le coup (liste paginée).
  const showSearch = people.length > EFFECTIVE_PAGE_SIZE;
  return (
    <div>
      {showSearch && (
        <div className="lfilter" style={{ margin: '0 0 8px' }}>
          <Icon name="search" size={14} style={{ color: 'var(--text-3)' }} />
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
            placeholder={t('projectPolicy.searchPlaceholder', { defaultValue: 'Search people…' })}
            style={{ minWidth: 160 }}
          />
        </div>
      )}
      {slice.length === 0 ? (
        <em className="set-desc">{t('projectPolicy.noMatch', { defaultValue: 'No match.' })}</em>
      ) : (
      <div className="asection-card" style={{ padding: 0 }}>
        {slice.map((u) => (
          <div
            key={u.id}
            className="dir-row"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 12px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="dir-name truncate" style={{ fontSize: 13 }}>{u.name}</div>
              <div className="dir-email truncate">{u.email}</div>
            </div>
          </div>
        ))}
      </div>
      )}
      {pageCount > 1 && (
        <div className="row gap2" style={{ marginTop: 8, justifyContent: 'center', alignItems: 'center' }}>
          <button
            className="btn btn-line btn-sm"
            disabled={safePage <= 1}
            onClick={() => setPage(Math.max(1, safePage - 1))}
          >
            <Icon name="chevL" size={13} /> {t('projectPolicy.prev')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {t('projectPolicy.page', { page: safePage, pageCount })}
          </span>
          <button
            className="btn btn-line btn-sm"
            disabled={safePage >= pageCount}
            onClick={() => setPage(Math.min(pageCount, safePage + 1))}
          >
            {t('projectPolicy.next')} <Icon name="chevR" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectPolicySection({
  roles,
  teams,
  users,
  flash,
}: {
  roles: RoleDto[];
  teams: TeamWithMembersDto[];
  users: UserDto[];
  flash: (msg: string) => void;
}) {
  const { t } = useTranslation('admin');
  const [billable, setBillable] = useState<ProjectPolicyDto>(DEFAULT_BILLABLE_POLICY);
  const [nonBillable, setNonBillable] = useState<ProjectPolicyDto>(DEFAULT_NON_BILLABLE_POLICY);
  const [baseline, setBaseline] = useState<{ b: ProjectPolicyDto; n: ProjectPolicyDto } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getAdminSettings()
      .then((s) => {
        if (!alive) return;
        const b = normalizePolicy((s as Record<string, unknown>)['projectCreation.billable'], DEFAULT_BILLABLE_POLICY);
        const n = normalizePolicy((s as Record<string, unknown>)['projectCreation.nonBillable'], DEFAULT_NON_BILLABLE_POLICY);
        setBillable(b);
        setNonBillable(n);
        setBaseline({ b, n });
      })
      .catch((e) => flash(t('projectPolicy.loadFailed', { message: (e as Error).message })))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [flash, t]);

  const activeUsers = useMemo(
    () => users.filter((u) => u.status !== 'SUSPENDED'),
    [users],
  );

  const orgRoles = roles.filter((r) => r.scope === 'ORG');
  const dirty =
    !!baseline &&
    (JSON.stringify(baseline.b) !== JSON.stringify(billable) ||
      JSON.stringify(baseline.n) !== JSON.stringify(nonBillable));

  const save = async () => {
    setSaving(true);
    try {
      await api.putAdminSettings({
        'projectCreation.billable': billable,
        'projectCreation.nonBillable': nonBillable,
      });
      setBaseline({ b: billable, n: nonBillable });
      flash(t('projectPolicy.saved'));
    } catch (e) {
      flash(t('projectPolicy.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!baseline) return;
    setBillable(baseline.b);
    setNonBillable(baseline.n);
  };

  if (loading) {
    return <div className="set-desc" style={{ padding: 16 }}>{t('projectPolicy.loading')}</div>;
  }

  /**
   * Résout, côté client, l'ensemble des personnes réellement autorisées par une
   * policy — pour l'aperçu « qui peut quoi ». Approximation fidèle aux règles
   * serveur : admins toujours OK ; en billable, Portfolio Managers toujours OK.
   * En mode per-team non-billable, la résolution ignore l'override par-user
   * (non disponible côté UI) — signalé dans le libellé.
   */
  const resolveAllowed = (policy: ProjectPolicyDto, kind: 'billable' | 'nonBillable'): UserDto[] => {
    const allowed = new Map<string, UserDto>();
    const add = (u: UserDto) => allowed.set(u.id, u);
    for (const u of activeUsers) {
      const rk = u.roleKey ?? (u.isAdmin ? 'ORG_ADMIN' : 'ORG_MEMBER');
      // Admins : bypass total.
      if (u.isAdmin || rk === 'ORG_ADMIN') { add(u); continue; }
      // Portfolio Managers : toujours autorisés pour le billable.
      if (kind === 'billable' && rk === 'PORTFOLIO_MANAGER') { add(u); continue; }
      if (policy.mode === 'everyone') { add(u); continue; }
      if (policy.mode === 'roles' && policy.roleKeys.includes(rk)) { add(u); continue; }
    }
    if (policy.mode === 'teams') {
      const teamSet = new Set(policy.teamIds);
      for (const tm of teams) {
        if (!teamSet.has(tm.id)) continue;
        for (const m of tm.members) {
          const u = activeUsers.find((x) => x.id === m.userId);
          if (u) add(u);
        }
      }
    }
    return [...allowed.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  const Card = ({
    title,
    blurb,
    value,
    onChange,
    kind,
  }: {
    title: string;
    blurb: string;
    value: ProjectPolicyDto;
    onChange: (next: ProjectPolicyDto) => void;
    kind: 'billable' | 'nonBillable';
  }) => {
    const allowed = resolveAllowed(value, kind);
    return (
    <div className="asection-card" style={{ padding: 16, display: 'grid', gap: 14 }}>
      <div>
        <div className="set-label" style={{ fontSize: 15 }}>{title}</div>
        <div className="set-desc" style={{ marginTop: 4 }}>{blurb}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['everyone', 'roles', 'teams'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange({ ...value, mode: m })}
            className="seg-btn"
            style={{
              padding: '6px 12px',
              borderRadius: 'var(--r-pill)',
              border: '1px solid ' + (value.mode === m ? 'var(--accent)' : 'var(--border)'),
              background: value.mode === m ? 'var(--accent-soft)' : 'var(--surface-2)',
              color: value.mode === m ? 'var(--accent)' : 'var(--text-1)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {m === 'everyone' ? t('projectPolicy.everyone') : m === 'roles' ? t('projectPolicy.perRole') : t('projectPolicy.perTeam')}
          </button>
        ))}
      </div>
      {value.mode === 'roles' && (
        <div>
          <div className="set-desc" style={{ marginBottom: 8 }}>{t('projectPolicy.allowedRoles')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {orgRoles.map((r) => {
              // Portfolio Manager bypasses the billable policy entirely —
              // the chip is shown as always-on and locked to avoid implying
              // it can be turned off.
              const locked = kind === 'billable' && r.key === 'PORTFOLIO_MANAGER';
              const on = locked || value.roleKeys.includes(r.key);
              return (
                <button
                  key={r.id}
                  type="button"
                  disabled={locked}
                  title={locked ? t('projectPolicy.alwaysHint') : undefined}
                  onClick={() =>
                    onChange({
                      ...value,
                      roleKeys: on
                        ? value.roleKeys.filter((k) => k !== r.key)
                        : [...value.roleKeys, r.key],
                    })
                  }
                  style={{
                    padding: '4px 10px',
                    borderRadius: 'var(--r-pill)',
                    border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                    background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                    color: on ? 'var(--accent)' : 'var(--text-1)',
                    cursor: locked ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    opacity: locked ? 0.8 : 1,
                  }}
                >
                  {r.name}{locked ? t('projectPolicy.always') : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {value.mode === 'teams' && (
        <div>
          <div className="set-desc" style={{ marginBottom: 8 }}>{t('projectPolicy.allowedTeams')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {teams.length === 0 && <em className="set-desc">{t('projectPolicy.noTeams')}</em>}
            {teams.map((tm) => {
              const on = value.teamIds.includes(tm.id);
              return (
                <button
                  key={tm.id}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...value,
                      teamIds: on
                        ? value.teamIds.filter((id) => id !== tm.id)
                        : [...value.teamIds, tm.id],
                    })
                  }
                  style={{
                    padding: '4px 10px',
                    borderRadius: 'var(--r-pill)',
                    border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                    background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                    color: on ? 'var(--accent)' : 'var(--text-1)',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  {tm.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* Aperçu résolu : qui peut réellement créer (chantier #8). */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
          marginTop: 2,
        }}
      >
        <div className="set-desc" style={{ marginBottom: 6 }}>
          {t('projectPolicy.effective', { count: allowed.length })}
          {kind === 'nonBillable' && value.mode === 'teams' && (
            <span style={{ color: 'var(--warn, #b45309)' }}>
              {t('projectPolicy.overridesNote')}
            </span>
          )}
        </div>
        <EffectivePeople people={allowed} />
      </div>
    </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card
        kind="billable"
        title={t('projectPolicy.billableTitle')}
        blurb={t('projectPolicy.billableBlurb')}
        value={billable}
        onChange={setBillable}
      />
      <Card
        kind="nonBillable"
        title={t('projectPolicy.nonBillableTitle')}
        blurb={t('projectPolicy.nonBillableBlurb')}
        value={nonBillable}
        onChange={setNonBillable}
      />
      {dirty && (
        <div className="savebar">
          <span className="savebar-text">{t('projectPolicy.unsaved')}</span>
          <button className="btn btn-line btn-sm" onClick={discard} disabled={saving}>
            {t('projectPolicy.discard')}
          </button>
          <button className="btn btn-accent btn-sm" onClick={save} disabled={saving}>
            <Icon name="check" size={15} /> {saving ? t('projectPolicy.saving') : t('projectPolicy.saveChanges')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================== Teams ================================ */

const TEAM_COLOR_SWATCHES = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#a855f7', '#ec4899', '#14b8a6',
];

function teamInitials(name: string) {
  // 3 lettres : initiales des 3 premiers mots si possible, sinon les 3
  // premières lettres du nom (sans espaces) pour les mono-mots.
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  }
  return (words[0] ?? '').slice(0, 3).toUpperCase();
}

function TeamEditModal({
  mode,
  users,
  isAdmin,
  onClose,
  onSaved,
  onDeleted,
  flash,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; team: TeamWithMembersDto };
  users: UserDto[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (t: TeamWithMembersDto) => void;
  onDeleted: (id: string) => void;
  flash: (m: string) => void;
}) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const isEdit = mode.kind === 'edit';
  const init = isEdit ? mode.team : null;
  const readOnlySource = init && init.source !== 'LOCAL';

  const [name, setName] = useState(init?.name ?? '');
  const [displayName, setDisplayName] = useState(init?.displayName ?? '');
  const [description, setDescription] = useState(init?.description ?? '');
  const [color, setColor] = useState(init?.color ?? TEAM_COLOR_SWATCHES[0]);
  const [canCreateNonBillable, setCanCreateNonBillable] = useState<boolean>(
    (init as unknown as { canCreateNonBillableProject?: boolean } | null)?.canCreateNonBillableProject ?? false,
  );
  const [autoLicense, setAutoLicense] = useState<boolean>(
    (init as unknown as { autoLicense?: boolean } | null)?.autoLicense ?? false,
  );
  const [members, setMembers] = useState<TeamWithMembersDto['members']>(
    init?.members ?? [],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [saving, setSaving] = useState(false);

  // La case « projets non-facturables » de l'équipe et les overrides par membre
  // ne servent QUE lorsque la policy org « Non-billable projects » est en mode
  // « Per team » — sinon le mode (everyone/roles) décide seul. On masque donc ces
  // contrôles hors mode per-team pour éviter d'exposer une option qui n'a aucun
  // effet (la policy elle-même se règle dans Admin > Project management).
  const [nbPerTeam, setNbPerTeam] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getAdminSettings()
      .then((s) => {
        if (!alive) return;
        const n = normalizePolicy(
          (s as Record<string, unknown>)['projectCreation.nonBillable'],
          DEFAULT_NON_BILLABLE_POLICY,
        );
        setNbPerTeam(n.mode === 'teams');
      })
      .catch(() => {
        if (alive) setNbPerTeam(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  // Recherche serveur débouncée (remplace le filtre client + slice(0,12)) :
  // scale à des orgs de 200+ users. includeSchedule=false → pas de batch inutile.
  const [pickerResults, setPickerResults] = useState<UserDto[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());
  const [addingMembers, setAddingMembers] = useState(false);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    setPickerLoading(true);
    const t = setTimeout(() => {
      api
        .listUsersDirectory({
          search: pickerQ.trim() || undefined,
          status: 'ACTIVE',
          pageSize: 50,
          includeSchedule: false,
        })
        .then((res) => {
          if (!cancelled) setPickerResults(res.items as UserDto[]);
        })
        .catch(() => {
          if (!cancelled) setPickerResults([]);
        })
        .finally(() => !cancelled && setPickerLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pickerOpen, pickerQ]);

  // Exclut les membres déjà dans l'équipe.
  const eligible = useMemo(
    () => pickerResults.filter((u) => !memberIds.has(u.id)),
    [pickerResults, memberIds],
  );

  async function saveTeamFields() {
    if (!name.trim()) {
      flash(t('teams.nameRequired'));
      return null;
    }
    if (mode.kind === 'create') {
      const created = await api.createTeam({
        name: name.trim(),
        description: description.trim() || null,
        color,
      });
      // Si un flag a été activé à la création, on patche tout de suite.
      if (canCreateNonBillable || autoLicense) {
        await api.updateTeam(created.id, {
          ...(canCreateNonBillable ? { canCreateNonBillableProject: true } : {}),
          ...(autoLicense ? { autoLicense: true } : {}),
        } as Parameters<typeof api.updateTeam>[1]);
      }
      return { ...created, members: [] as TeamWithMembersDto['members'] };
    }
    const patch: Parameters<typeof api.updateTeam>[1] = {};
    if (name.trim() !== init!.name) patch.name = name.trim();
    const nextDisp = displayName.trim() || null;
    if (nextDisp !== (init!.displayName ?? null)) {
      (patch as Record<string, unknown>).displayName = nextDisp;
    }
    const nextDesc = description.trim() || null;
    if (nextDesc !== (init!.description ?? null)) patch.description = nextDesc;
    if (color !== (init!.color ?? null)) patch.color = color;
    const initFlag = (init as unknown as { canCreateNonBillableProject?: boolean }).canCreateNonBillableProject ?? false;
    if (canCreateNonBillable !== initFlag) {
      (patch as Record<string, unknown>).canCreateNonBillableProject = canCreateNonBillable;
    }
    const initAuto = (init as unknown as { autoLicense?: boolean }).autoLicense ?? false;
    if (autoLicense !== initAuto) {
      (patch as Record<string, unknown>).autoLicense = autoLicense;
    }
    if (Object.keys(patch).length === 0) return init!;
    const updated = await api.updateTeam(init!.id, patch);
    return { ...init!, ...updated, members: init!.members };
  }

  async function save() {
    setSaving(true);
    try {
      const teamBase = await saveTeamFields();
      if (!teamBase) return;
      // Refresh full team (cheap) so we get the canonical member list.
      const full = isEdit
        ? await api.getTeam(teamBase.id)
        : { ...teamBase, members } as TeamWithMembersDto;
      onSaved(full);
      flash(mode.kind === 'create' ? t('teams.created', { name: full.name }) : t('teams.updated', { name: full.name }));
      onClose();
    } catch (e) {
      flash(t('teams.saveFailed', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  }

  /** Ajoute plusieurs membres sélectionnés en une fois (boucle côté client —
   *  pas d'endpoint bulk pour l'instant). */
  async function addSelectedMembers() {
    if (!isEdit) {
      flash(t('teams.createFirst'));
      return;
    }
    const ids = [...pickerSelected];
    if (ids.length === 0) return;
    setAddingMembers(true);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const m = await api.addTeamMember(init!.id, { userId: id, isLead: false });
        setMembers((prev) =>
          prev.some((p) => p.userId === m.userId)
            ? prev
            : [...prev, { userId: m.userId, isLead: m.isLead, user: m.user }],
        );
        ok++;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    setAddingMembers(false);
    setPickerSelected(new Set());
    setPickerQ('');
    if (ok) flash(t('teams.membersAdded', { count: ok }));
    if (errors.length) flash(t('teams.membersFailed', { count: errors.length, first: errors[0] }));
  }

  async function toggleLead(userId: string, current: boolean) {
    if (!isEdit) return;
    try {
      const m = await api.updateTeamMember(init!.id, userId, { isLead: !current });
      setMembers((prev) =>
        prev.map((p) => (p.userId === userId ? { ...p, isLead: m.isLead } : p)),
      );
    } catch (e) {
      flash((e as Error).message);
    }
  }

  async function removeMember(userId: string) {
    if (!isEdit) return;
    try {
      await api.removeTeamMember(init!.id, userId);
      setMembers((prev) => prev.filter((p) => p.userId !== userId));
    } catch (e) {
      flash((e as Error).message);
    }
  }

  async function setMemberOverride(userId: string, next: boolean | null) {
    if (!isEdit) return;
    try {
      const m = await api.updateTeamMember(init!.id, userId, { canCreateNonBillableProject: next });
      setMembers((prev) =>
        prev.map((p) =>
          p.userId === userId
            ? { ...p, user: { ...p.user, canCreateNonBillableProject: m.user.canCreateNonBillableProject ?? next } }
            : p,
        ),
      );
    } catch (e) {
      flash((e as Error).message);
    }
  }

  async function deleteTeam() {
    if (!isEdit) return;
    if (!isAdmin) {
      flash(t('teams.onlyAdminDelete'));
      return;
    }
    const syncedNote = readOnlySource
      ? t('teams.syncedNote', { source: init!.source })
      : '';
    if (
      !(await confirm({
        title: t('common:confirm'),
        message: t('teams.archiveConfirm', { name: init!.name, syncedNote }),
        danger: true,
      }))
    )
      return;
    setSaving(true);
    try {
      await api.deleteTeam(init!.id);
      onDeleted(init!.id);
      flash(t('teams.archived'));
      onClose();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div
        className="md-card"
        style={{ width: 'min(640px, 92vw)' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="md-head">
          <div
            className="team-mark"
            style={{ background: color, width: 38, height: 38, fontSize: 14 }}
          >
            {teamInitials(name || 'Team')}
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">
              {isEdit ? t('teams.editTeam') : t('teams.newTeam')}
              {readOnlySource && (
                <span className="badge-soft" style={{ marginLeft: 8 }}>
                  {init!.source} · {t('teams.synced')}
                </span>
              )}
            </div>
            <div className="md-title truncate">{name || t('teams.newTeamName')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="md-body">
          <div className="md-field">
            <div className="md-label">
              {readOnlySource ? t('teams.nameSynced') : t('teams.name')}
            </div>
            <input
              className="atext"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: '100%' }}
              placeholder="Backend platform"
              disabled={!!readOnlySource}
            />
            {readOnlySource && (
              <div className="set-desc" style={{ marginTop: 4 }}>
                {t('teams.nameSyncedHint', { source: init!.source })}
              </div>
            )}
          </div>
          {isEdit && (
            <div className="md-field">
              <div className="md-label">{t('teams.displayName')}</div>
              <input
                className="atext"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{ width: '100%' }}
                placeholder={name || t('teams.displayNamePlaceholder')}
              />
              <div className="set-desc" style={{ marginTop: 4 }}>
                {t('teams.displayNameHint')}
              </div>
            </div>
          )}
          {/* External ID = clé stable du groupe côté IdP (objectId Entra / id
              SCIM). Lecture seule : propriété de l'IdP, jamais éditée à la main. */}
          {isEdit && (init!.externalId || readOnlySource) && (
            <div className="md-field">
              <div className="md-label">{t('teams.externalIdManaged')}</div>
              <input
                className="atext mono"
                value={init!.externalId ?? '—'}
                readOnly
                disabled
                style={{ width: '100%' }}
              />
              <div className="set-desc" style={{ marginTop: 4 }}>
                {t('teams.externalIdHint')}
              </div>
            </div>
          )}
          <div className="md-field">
            <div className="md-label">{t('teams.description')}</div>
            <input
              className="atext"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%' }}
              placeholder={t('teams.optional')}
            />
          </div>
          <div className="md-field">
            <div className="md-label">{t('teams.color')}</div>
            <ColorInput
              value={color}
              options={TEAM_COLOR_SWATCHES}
              onChange={(c) => setColor(c)}
            />
          </div>

          {nbPerTeam && (
          <div className="md-field">
            <div className="md-label">{t('teams.nonBillableProjects')}</div>
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                background: 'var(--surface-2)',
                cursor: readOnlySource ? 'default' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={canCreateNonBillable}
                disabled={!!readOnlySource}
                onChange={(e) => setCanCreateNonBillable(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <div>
                <div style={{ fontSize: 13 }}>{t('teams.membersCanCreateNonBillable')}</div>
                <div className="set-desc" style={{ marginTop: 2 }}>
                  {t('teams.nonBillableHint')}
                </div>
              </div>
            </label>
          </div>
          )}

          {isAdmin && (
            <div className="md-field">
              <div className="md-label">{t('teams.autoLicenseTitle')}</div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--surface-2)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={autoLicense}
                  onChange={(e) => setAutoLicense(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <div style={{ fontSize: 13 }}>{t('teams.autoLicenseLabel')}</div>
                  <div className="set-desc" style={{ marginTop: 2 }}>
                    {t('teams.autoLicenseHint')}
                  </div>
                </div>
              </label>
            </div>
          )}

          {isEdit && (
            <div className="md-field">
              <div className="md-label">
                {t('teams.membersWithCount')} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {members.length}</span>
              </div>
              {readOnlySource && (
                <div className="md-span" style={{ color: 'var(--text-3)' }}>
                  {t('teams.membersSyncedNote', { source: init!.source })}
                </div>
              )}
              <div
                className="asection-card"
                style={{ marginTop: 6, padding: 0, maxHeight: 280, overflowY: 'auto' }}
              >
                {members.length === 0 && (
                  <div className="set-desc" style={{ padding: 12 }}>
                    {t('teams.noMemberYet')}
                  </div>
                )}
                {members.map((m) => {
                  const u = m.user as typeof m.user & { canCreateNonBillableProject?: boolean | null };
                  const override = u.canCreateNonBillableProject ?? null;
                  const initials = u.name
                    .split(' ')
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase();
                  const overrideBtn = (val: boolean | null, label: string, hint: string) => {
                    const on = override === val;
                    return (
                      <button
                        key={String(val)}
                        type="button"
                        onClick={() => setMemberOverride(m.userId, val)}
                        disabled={!!readOnlySource}
                        title={hint}
                        style={{
                          padding: '2px 8px',
                          fontSize: 11,
                          borderRadius: 'var(--r-pill)',
                          border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                          background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                          color: on ? 'var(--accent)' : 'var(--text-2)',
                          cursor: readOnlySource ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {label}
                      </button>
                    );
                  };
                  return (
                    <div
                      className="dir-row"
                      key={m.userId}
                      style={{
                        display: 'flex',
                        gridTemplateColumns: 'none',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 12px',
                        flexWrap: 'wrap',
                        rowGap: 8,
                      }}
                    >
                      <Avatar
                        user={{
                          id: u.id, name: u.name,
                          short: u.name.split(' ')[0],
                          initials, role: '', hue: hueFromId(u.id), online: false,
                        }}
                        size={28}
                        title={false}
                      />
                      <div className="dir-id" style={{ flex: '1 1 0', minWidth: 0 }}>
                        <div
                          className="dir-name"
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {u.name}
                        </div>
                        <div
                          className="dir-email"
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {u.email}
                        </div>
                      </div>
                      <div className="row gap2" style={{ flexShrink: 0, marginLeft: 'auto' }}>
                        <button
                          className={'btn btn-sm ' + (m.isLead ? 'btn-accent' : 'btn-line')}
                          onClick={() => toggleLead(m.userId, m.isLead)}
                          disabled={!!readOnlySource}
                          title={t('teams.teamManagerTitle')}
                        >
                          {m.isLead ? t('teams.teamManager') : t('teams.promoteToManager')}
                        </button>
                        <button
                          className="btn btn-line btn-sm"
                          onClick={() => removeMember(m.userId)}
                          disabled={!!readOnlySource}
                          aria-label={t('common:remove')}
                        >
                          <Icon name="x" size={13} />
                        </button>
                      </div>
                      {nbPerTeam && (
                      <div
                        style={{
                          flexBasis: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginLeft: 36,
                        }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {t('teams.nonBillableProjectsLabel')}
                        </span>
                        {overrideBtn(null, t('teams.inherit'), t('teams.inheritHint'))}
                        {overrideBtn(true, t('teams.allow'), t('teams.allowHint'))}
                        {overrideBtn(false, t('teams.block'), t('teams.blockHint'))}
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!readOnlySource && (
                <div style={{ marginTop: 8 }}>
                  {!pickerOpen ? (
                    <button
                      className="btn btn-line btn-sm"
                      onClick={() => setPickerOpen(true)}
                    >
                      <Icon name="plus" size={14} /> {t('teams.addMember')}
                    </button>
                  ) : (
                    <div className="asection-card" style={{ padding: 8 }}>
                      <div className="lfilter" style={{ marginBottom: 4 }}>
                        <Icon name="search" size={14} style={{ color: 'var(--text-3)' }} />
                        <input
                          autoFocus
                          value={pickerQ}
                          onChange={(e) => setPickerQ(e.target.value)}
                          placeholder={t('teams.searchUser')}
                        />
                        <button
                          className="icon-btn"
                          onClick={() => {
                            setPickerOpen(false);
                            setPickerQ('');
                          }}
                          aria-label={t('teams.closePicker')}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                        {pickerLoading && (
                          <div className="set-desc" style={{ padding: 8 }}>
                            {t('teams.searching')}
                          </div>
                        )}
                        {!pickerLoading && eligible.length === 0 && (
                          <div className="set-desc" style={{ padding: 8 }}>
                            {t('teams.noResult')}
                          </div>
                        )}
                        {!pickerLoading && eligible.map((u) => {
                          const checked = pickerSelected.has(u.id);
                          return (
                          <button
                            key={u.id}
                            className="dir-row"
                            style={{
                              width: '100%', textAlign: 'left',
                              padding: '8px 10px', cursor: 'pointer',
                              border: 'none',
                              background: checked ? 'var(--accent-soft, var(--surface-2))' : 'transparent',
                            }}
                            onClick={() =>
                              setPickerSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(u.id)) next.delete(u.id);
                                else next.add(u.id);
                                return next;
                              })
                            }
                          >
                            <span
                              aria-hidden
                              style={{
                                width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                                border: '1.5px solid ' + (checked ? 'var(--accent)' : 'var(--border)'),
                                background: checked ? 'var(--accent)' : 'transparent',
                                display: 'inline-grid', placeItems: 'center', color: '#fff',
                              }}
                            >
                              {checked && <Icon name="check" size={11} />}
                            </span>
                            <Avatar
                              user={{
                                id: u.id, name: u.name,
                                short: u.name.split(' ')[0],
                                initials: u.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
                                role: '', hue: hueFromId(u.id), online: false,
                              }}
                              size={24}
                              title={false}
                            />
                            <div className="dir-id">
                              <div className="dir-name">{u.name}</div>
                              <div className="dir-email">{u.email}</div>
                            </div>
                          </button>
                          );
                        })}
                      </div>
                      {pickerSelected.size > 0 && (
                        <div
                          className="row gap2"
                          style={{ marginTop: 8, justifyContent: 'flex-end', alignItems: 'center' }}
                        >
                          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                            {t('teams.selected', { count: pickerSelected.size })}
                          </span>
                          <button
                            className="btn btn-accent btn-sm"
                            disabled={addingMembers}
                            onClick={addSelectedMembers}
                          >
                            {addingMembers ? t('teams.adding') : t('teams.addMembers', { count: pickerSelected.size })}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!isEdit && (
            <div className="md-span" style={{ color: 'var(--text-3)' }}>
              {t('teams.afterCreateNote')}
            </div>
          )}
        </div>

        <div className="md-foot">
          <div className="md-foot-meta">
            {isEdit && isAdmin && (
              <button
                className="btn btn-danger btn-sm"
                onClick={deleteTeam}
                disabled={saving}
              >
                <Icon name="x" size={14} /> {t('teams.archiveTeam')}
              </button>
            )}
          </div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {t('teams.cancel')}
            </button>
            <button
              className="btn btn-accent"
              onClick={save}
              disabled={saving}
            >
              {saving ? t('teams.saving') : isEdit ? t('teams.save') : t('teams.createTeam')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamList({
  teams,
  users,
  isAdmin,
  flash,
  onTeamsChanged,
}: {
  teams: TeamWithMembersDto[];
  users: UserDto[];
  isAdmin: boolean;
  flash: (m: string) => void;
  onTeamsChanged: (next: TeamWithMembersDto[] | ((prev: TeamWithMembersDto[]) => TeamWithMembersDto[])) => void;
}) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const [f, setF] = useState('');
  const ff = f.trim().toLowerCase();
  const rows = teams.filter((tm) => !ff || tm.name.toLowerCase().includes(ff));
  const [edit, setEdit] = useState<
    { kind: 'create' } | { kind: 'edit'; team: TeamWithMembersDto } | null
  >(null);

  // Équipes archivées (soft-deleted) — chargées à la demande (admin only).
  type ArchivedTeam = Awaited<ReturnType<typeof api.listArchivedTeams>>[number];
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<ArchivedTeam[] | null>(null);
  const [archLoading, setArchLoading] = useState(false);
  const [archBusy, setArchBusy] = useState<string | null>(null);

  async function loadArchived() {
    setArchLoading(true);
    try {
      setArchived(await api.listArchivedTeams());
    } catch (e) {
      flash(t('teams.loadArchivedFailed', { message: (e as Error).message }));
    } finally {
      setArchLoading(false);
    }
  }

  async function restoreTeam(id: string, name: string) {
    setArchBusy(id);
    try {
      await api.restoreTeam(id);
      const full = await api.getTeam(id);
      onTeamsChanged((prev) =>
        prev.some((p) => p.id === id) ? prev : [...prev, full],
      );
      setArchived((prev) => (prev ?? []).filter((tm) => tm.id !== id));
      flash(t('teams.restored', { name }));
    } catch (e) {
      flash(t('teams.restoreFailed', { message: (e as Error).message }));
    } finally {
      setArchBusy(null);
    }
  }

  async function purgeTeam(id: string, name: string) {
    if (
      !(await confirm({ title: t('common:delete'), message: t('teams.purgeConfirm', { name }), confirmLabel: t('common:delete'), danger: true }))
    )
      return;
    setArchBusy(id);
    try {
      await api.purgeTeam(id);
      setArchived((prev) => (prev ?? []).filter((tm) => tm.id !== id));
      flash(t('teams.purged', { name }));
    } catch (e) {
      flash(t('teams.purgeFailed', { message: (e as Error).message }));
    } finally {
      setArchBusy(null);
    }
  }

  return (
    <div>
      <div className="lfilter">
        <Icon name="search" size={15} style={{ color: 'var(--text-3)' }} />
        <input
          value={f}
          onChange={(e) => setF(e.target.value)}
          placeholder={t('teams.filterPlaceholder')}
        />
        <span className="lf-count">
          {rows.length}/{teams.length}
        </span>
        {isAdmin && (
          <button
            className="btn btn-accent btn-sm"
            style={{ marginLeft: 8, whiteSpace: 'nowrap' }}
            onClick={() => setEdit({ kind: 'create' })}
          >
            <Icon name="plus" size={14} /> {t('teams.newTeam')}
          </button>
        )}
      </div>
      {!isAdmin && (
        <div className="set-desc" style={{ padding: '6px 2px 10px' }}>
          <Trans t={t} i18nKey="teams.onlyAdminCreateNote" components={[<em />]} />
        </div>
      )}
      <div className="team-grid">
        {rows.map((tm) => {
          const hue = colorFromKey(tm.id);
          const accent = tm.color ?? `oklch(0.6 0.15 ${hue})`;
          const leadCount = tm.members.filter((m) => m.isLead).length;
          const extra = Math.max(0, tm.members.length - 6);
          return (
            <button
              key={tm.id}
              type="button"
              className="team-card"
              data-readonly={tm.source !== 'LOCAL' ? 'true' : undefined}
              onClick={() => setEdit({ kind: 'edit', team: tm })}
              style={{ ['--team-color' as 'color']: accent }}
              title={t('teams.openTeam', { name: tm.name })}
            >
              <div className="team-top">
                <div className="team-mark" style={{ background: accent }}>
                  {teamInitials(tm.name)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="team-name truncate">
                    <span className="truncate">{tm.name}</span>
                    {tm.source !== 'LOCAL' && (
                      <span className="badge-soft" title={t('teams.syncedFrom', { source: tm.source })}>
                        {tm.source}
                      </span>
                    )}
                  </div>
                  <div className="team-meta">
                    {t('teams.memberCount', { count: tm.members.length })}
                    {leadCount > 0 && (
                      <>
                        {' · '}
                        <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>
                          {t('teams.managerCount', { count: leadCount })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {tm.members.length === 0 ? (
                <div className="team-empty-members">{t('teams.noMemberOnCard')}</div>
              ) : (
                <div className="team-avatars">
                  {tm.members.slice(0, 6).map((m) => (
                    <Avatar
                      key={m.userId}
                      user={{
                        id: m.userId,
                        name: m.user.name,
                        short: m.user.name.split(' ')[0],
                        initials: m.user.name
                          .split(' ')
                          .map((w) => w[0])
                          .join('')
                          .slice(0, 2)
                          .toUpperCase(),
                        role: '',
                        hue: hueFromId(m.userId),
                        online: false,
                      }}
                      size={26}
                      title={false}
                    />
                  ))}
                  {extra > 0 && <span className="team-avatars-more">+{extra}</span>}
                </div>
              )}
            </button>
          );
        })}
        {rows.length === 0 && (
          <div className="set-desc" style={{ padding: '16px', gridColumn: '1 / -1' }}>
            {t('teams.noTeamYet')}
          </div>
        )}
      </div>

      {isAdmin && (
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              if (next && archived === null) loadArchived();
            }}
          >
            <Icon name={showArchived ? 'chevDown' : 'arrowRight'} size={14} />
            {t('teams.archivedTeams')}
            {archived !== null && archived.length > 0 && (
              <span className="badge-soft" style={{ marginLeft: 6 }}>{archived.length}</span>
            )}
          </button>
          {showArchived && (
            <div style={{ marginTop: 10 }}>
              {archLoading ? (
                <div className="set-desc" style={{ padding: 8 }}>{t('teams.loadingArchived')}</div>
              ) : !archived || archived.length === 0 ? (
                <div className="set-desc" style={{ padding: 8 }}>{t('teams.noArchivedTeam')}</div>
              ) : (
                <div className="asection-card" style={{ padding: 0 }}>
                  {archived.map((tm) => (
                    <div
                      key={tm.id}
                      className="dir-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 12px',
                        borderBottom: '1px solid var(--border)',
                      }}
                    >
                      <div className="team-mark" style={{ background: tm.color ?? 'var(--surface-3)', width: 30, height: 30, fontSize: 12 }}>
                        {teamInitials(tm.name)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="dir-name truncate">
                          {tm.name}
                          {tm.source !== 'LOCAL' && (
                            <span className="badge-soft" style={{ marginLeft: 6 }}>{tm.source}</span>
                          )}
                        </div>
                        <div className="dir-email">
                          {t('teams.memberCount', { count: tm._count.members })}
                          {tm.deletedAt && t('teams.archivedOn', { date: new Date(tm.deletedAt).toLocaleDateString() })}
                        </div>
                      </div>
                      <div className="row gap2" style={{ flexShrink: 0 }}>
                        <button
                          className="btn btn-line btn-sm"
                          onClick={() => restoreTeam(tm.id, tm.name)}
                          disabled={archBusy === tm.id}
                        >
                          <Icon name="refresh" size={13} /> {t('teams.restore')}
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => purgeTeam(tm.id, tm.name)}
                          disabled={archBusy === tm.id}
                        >
                          <Icon name="x" size={13} /> {t('teams.deletePermanently')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {edit && (
        <TeamEditModal
          mode={edit}
          users={users}
          isAdmin={isAdmin}
          onClose={() => setEdit(null)}
          onSaved={(tm) =>
            onTeamsChanged((prev) =>
              prev.some((p) => p.id === tm.id)
                ? prev.map((p) => (p.id === tm.id ? tm : p))
                : [...prev, tm],
            )
          }
          onDeleted={(id) => onTeamsChanged((prev) => prev.filter((p) => p.id !== id))}
          flash={flash}
        />
      )}
    </div>
  );
}


/* ------------------------------------------------------------ main */

export interface AdminPanelProps {
  onExit: () => void;
  /** Compte « admin-only » sans siège de licence : pas de dashboard. Le bouton
   *  « retour » devient une déconnexion et un bandeau l'explique. */
  lockedNoSeat?: boolean;
  /** Mode restreint « AI administrator » : l'utilisateur a le grant `agent:manage`
   *  mais pas les droits admin org — on n'expose QUE les sections agents. */
  agentAdminOnly?: boolean;
}

/** Sections réservées à l'« AI administrator » (mode restreint). */
const AGENT_SECTION_KINDS = new Set(['agentlist', 'agentconnectors', 'agentpolicies', 'agentruns', 'ciconnectors', 'agenttrustissuers']);

export function AdminPanel({ onExit, lockedNoSeat, agentAdminOnly }: AdminPanelProps) {
  const { t } = useTranslation('admin');
  const confirm = useConfirm();
  const { isAdmin, refreshOrgSettings } = useAuth();
  const { initial, flat } = useMemo(buildIndex, []);

  // Resolvers schema → traduction (fallback sur le texte EN du schéma).
  const settingLabel = useCallback(
    (s: AdminSetting) => {
      const k = SETTING_KEY[s.id];
      return k ? t(`setting.${k}.label`, { defaultValue: s.label }) : s.label;
    },
    [t],
  );
  const settingDesc = useCallback(
    (s: AdminSetting) => {
      const k = SETTING_KEY[s.id];
      const d = k ? t(`setting.${k}.desc`, { defaultValue: s.desc ?? '' }) : s.desc;
      return d || undefined;
    },
    [t],
  );
  const settingAction = useCallback(
    (s: AdminSetting) => {
      const k = SETTING_KEY[s.id];
      const fallback = s.actionLabel || s.label;
      return k && s.actionLabel
        ? t(`setting.${k}.action`, { defaultValue: fallback })
        : fallback;
    },
    [t],
  );
  const sectionTitle = useCallback(
    (sec: AdminSection) => {
      const k = SECTION_KEY[sec.title];
      return k ? t(`section.${k}.title`, { defaultValue: sec.title }) : sec.title;
    },
    [t],
  );
  const sectionBlurb = useCallback(
    (sec: AdminSection) => {
      const k = SECTION_KEY[sec.title];
      return k ? t(`section.${k}.blurb`, { defaultValue: sec.blurb ?? '' }) : sec.blurb;
    },
    [t],
  );
  const groupLabel = useCallback(
    (g: AdminGroup) => {
      const k = GROUP_KEY[g.id];
      return k ? t(`group.${k}.label`, { defaultValue: g.label }) : g.label;
    },
    [t],
  );
  const groupBlurb = useCallback(
    (g: AdminGroup) => {
      const k = GROUP_KEY[g.id];
      return k ? t(`group.${k}.blurb`, { defaultValue: g.blurb ?? '' }) : g.blurb;
    },
    [t],
  );
  // Groupes visibles : en mode « AI administrator » restreint, on ne garde que
  // les sections agents (identités, connecteurs d'annuaire, policies) et on jette
  // les groupes qui n'en contiennent aucune.
  const GROUPS = useMemo(() => {
    if (!agentAdminOnly) return ADMIN_GROUPS;
    return ADMIN_GROUPS.map((g) => ({
      ...g,
      sections: g.sections.filter((s) => AGENT_SECTION_KINDS.has(s.kind ?? '')),
    })).filter((g) => g.sections.length > 0);
  }, [agentAdminOnly]);

  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [baseline, setBaseline] = useState<Record<string, unknown>>(initial);
  const [active, setActive] = useState(GROUPS[0].id);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [users, setUsers] = useState<UserDto[]>([]);
  const [teams, setTeams] = useState<TeamWithMembersDto[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  // Filtre rôle partagé : un clic sur une carte rôle (RoleList) ouvre la section
  // Users pré-filtrée (chantier #5).
  const [userRoleFilter, setUserRoleFilter] = useState('');

  useEffect(() => {
    api.listUsers().then(setUsers).catch(() => setUsers([]));
    api.listRoles().then(setRoles).catch(() => setRoles([]));
    api
      .listTeams()
      .then((list) =>
        Promise.all(list.map((tm) => api.getTeam(tm.id))).then((teamsFull) =>
          setTeams(teamsFull as TeamWithMembersDto[]),
        ),
      )
      .catch(() => setTeams([]));
    // Hydrate persisted settings from the org-scoped store, falling back to
    // the schema defaults when the DB has no row for a key yet.
    api
      .getAdminSettings()
      .then((srv) => {
        const merged: Record<string, unknown> = { ...initial };
        for (const [k, v] of Object.entries(srv || {})) {
          if (v !== undefined && v !== null) merged[k] = v;
        }
        setValues(merged);
        setBaseline(merged);
      })
      .catch(() => {
        // Keep schema defaults; just leave the panel usable.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const flash = (msg: string) => setToast(msg);

  const dirtyIds = useMemo(
    () =>
      Object.keys(values).filter(
        (k) => JSON.stringify(values[k]) !== JSON.stringify(baseline[k]),
      ),
    [values, baseline],
  );
  const dirtySet = useMemo(() => new Set(dirtyIds), [dirtyIds]);

  const dirtyByGroup = useMemo(() => {
    const m: Record<string, number> = {};
    ADMIN_GROUPS.forEach((g) => {
      let n = 0;
      flatSections(g).forEach((sec) =>
        (sec.settings || []).forEach((s) => {
          if (dirtySet.has(s.id)) n++;
        }),
      );
      if (n) m[g.id] = n;
    });
    return m;
  }, [dirtySet]);

  // Compteur d'utilisateurs ACTIFS par roleKey — aligné sur le filtre par défaut
  // de la liste (Active), pour que le badge de la carte rôle et la liste ouverte
  // affichent le même nombre.
  const roleCounts = useMemo(() => {
    const m: Record<string, number> = {};
    const activeIds = new Set<string>();
    for (const u of users) {
      if (u.status === 'SUSPENDED') continue;
      activeIds.add(u.id);
      const k = u.roleKey ?? (u.isAdmin ? 'ORG_ADMIN' : 'ORG_MEMBER');
      m[k] = (m[k] ?? 0) + 1;
    }
    // TEAM_MANAGER n'est pas un rôle Membership : il est dérivé du flag
    // TeamMember.isLead. On compte donc les leads d'équipe ACTIFS distincts.
    const leadIds = new Set<string>();
    for (const tm of teams) {
      for (const mm of tm.members) {
        if (mm.isLead && activeIds.has(mm.userId)) leadIds.add(mm.userId);
      }
    }
    m['TEAM_MANAGER'] = leadIds.size;
    return m;
  }, [users, teams]);

  const activeGroup = GROUPS.find((g) => g.id === active) || GROUPS[0];

  const setVal = useCallback(
    (id: string, v: unknown) => setValues((p) => ({ ...p, [id]: v })),
    [],
  );

  const save = async () => {
    // Send only changed keys to keep payloads small and avoid clobbering
    // values that were updated in another tab.
    const patch: Record<string, unknown> = {};
    for (const id of dirtyIds) patch[id] = values[id];
    try {
      await api.putAdminSettings(patch);
      // Les champs secret (write-only) sont vidés après envoi : on ne garde
      // jamais le secret en clair en mémoire, et on bascule le booléen `…Set`
      // pour afficher l'état « configuré ». Un secret effacé (envoyé vide) →
      // `…Set` repasse à false.
      const next = { ...values };
      ADMIN_GROUPS.forEach((g) =>
        flatSections(g).forEach((sec) =>
          (sec.settings || []).forEach((s) => {
            if (s.type === 'secret' && s.id in patch) {
              next[`${s.id}Set`] = String(patch[s.id] ?? '').length > 0;
              next[s.id] = '';
            }
          }),
        ),
      );
      setValues(next);
      setBaseline(next);
      // Pousse les settings publics (locale, weekStart, hoursPerDay) à tous
      // les consumers — TimelineView / WorkloadView se rerendent.
      refreshOrgSettings().catch(() => { /* non bloquant */ });
      flash(t('panel.saved', { count: dirtyIds.length }));
    } catch (e) {
      flash(t('panel.saveFailed', { message: (e as Error).message }));
    }
  };
  const discard = () => setValues(baseline);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const hit = flat.filter((s) => {
      const hay = [
        s.label,
        s.desc,
        settingLabel(s),
        settingDesc(s),
        s.kw,
        s.group.label,
        groupLabel(s.group),
        s.section,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
    const byGroup: Array<{ group: AdminGroup; items: typeof hit }> = [];
    hit.forEach((s) => {
      let bucket = byGroup.find((b) => b.group.id === s.group.id);
      if (!bucket) {
        bucket = { group: s.group, items: [] };
        byGroup.push(bucket);
      }
      bucket.items.push(s);
    });
    return { count: hit.length, byGroup };
  }, [q, flat, settingLabel, settingDesc, groupLabel]);

  function goGroup(id: string) {
    setActive(id);
    setActiveSection(null);
    setQuery('');
    setDrawer(false);
  }
  function goSection(groupId: string, title: string) {
    setActive(groupId);
    setActiveSection(title);
    setQuery('');
    setDrawer(false);
  }

  async function handleAction(s: AdminSetting) {
    if (s.id === 'org.logoUrl') {
      // Sélecteur de fichier natif — l'API valide mime/size, on transmet brut.
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/svg+xml,image/webp,image/gif';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const r = await api.uploadOrgLogo(file);
          // Met à jour la valeur locale ET la baseline pour pas marquer "dirty".
          setValues((p) => ({ ...p, 'org.logoUrl': r.url }));
          setBaseline((p) => ({ ...p, 'org.logoUrl': r.url }));
          flash(t('panel.logoUploaded', { size: Math.round(r.sizeBytes / 1024) }));
        } catch (e) {
          flash(t('panel.uploadFailed', { message: (e as Error).message }));
        }
      };
      input.click();
      return;
    }
    if (s.id === 'smtp.test') {
      try {
        await api.sendNotificationsTest();
        flash(t('panel.testEmailQueued'));
      } catch (e) {
        flash(t('panel.testFailed', { message: (e as Error).message }));
      }
      return;
    }
    if (s.id === 'audit.syslog.test') {
      try {
        const before = (values['audit.syslog.lastTest'] ?? null) as { at?: string } | null;
        await api.testAuditSyslog();
        flash(t('panel.syslogTestSent'));
        // Poll du résultat écrit par le worker (audit.syslog.lastTest).
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const all = await api.getAdminSettings();
          const lt = all['audit.syslog.lastTest'] as
            | { ok?: boolean; error?: string; at?: string }
            | undefined;
          if (lt?.at && lt.at !== before?.at) {
            flash(
              lt.ok
                ? t('panel.syslogTestOk')
                : t('panel.syslogTestFail', { error: lt.error || t('panel.syslogTestUnknownError') }),
            );
            return;
          }
        }
        flash(t('panel.syslogNoResponse'));
      } catch (e) {
        flash(t('panel.syslogTestImpossible', { message: (e as Error).message }));
      }
      return;
    }
    if (s.id === 'bulkImport') {
      setImportOpen(true);
      return;
    }
    if (s.id === 'forceLogout' || s.id === 'activeSessions') {
      // Les deux ouvrent désormais le même panneau (la force-logout y est aussi
      // accessible via un bouton — pas de raison de duppliquer un confirm ici).
      setSessionsOpen(true);
      return;
    }
    if (s.id === 'notif.preview') {
      try {
        const r = await api.previewNotificationTemplate('assignment');
        // Sécurité : on ouvre l'aperçu via un blob: (origine opaque), pas
        // document.write dans une fenêtre same-origin. Si un champ de branding
        // était reflété sans échappement, le script ne s'exécuterait pas sur
        // l'origine de l'app (pas d'accès au localStorage / tokens).
        const blob = new Blob([r.html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (e) {
        flash(t('panel.previewFailed', { message: (e as Error).message }));
      }
      return;
    }
    if (s.id === 'billingExportSendNow') {
      try {
        const r = await api.sendBillingExportNow();
        if (r.skipped) {
          flash(t('panel.billingExportSkipped'));
        } else {
          flash(t('panel.billingExportSent', { count: r.sent }));
        }
      } catch (e) {
        flash(t('panel.billingExportFailed', { message: (e as Error).message }));
      }
      return;
    }
    if (s.id === 'purgeNow') {
      try {
        // Aperçu du volume avant de demander confirmation.
        const preview = await api.getDataPurgePreview();
        if (preview.total === 0) {
          flash(t('panel.purgeNothing'));
          return;
        }
        const ok = await confirm({
          title: t('panel.purgeConfirmTitle'),
          message: t('panel.purgeConfirmMsg', { count: preview.total }),
          confirmLabel: t('panel.purgeConfirmBtn'),
          danger: true,
        });
        if (!ok) return;
        const r = await api.purgeSoftDeleted();
        flash(t('panel.purgeDone', { count: r.total }));
      } catch (e) {
        flash(t('panel.purgeFailed', { message: (e as Error).message }));
      }
      return;
    }
    if (s.id === 'exportData') {
      try {
        await api.exportOrgData();
        flash(t('panel.exportReady'));
      } catch (e) {
        flash(t('panel.exportFailed', { message: (e as Error).message }));
      }
      return;
    }
    flash(t('panel.notWired', { label: settingAction(s) }));
  }

  // ⚠️ Ne pas redéclarer ces helpers comme composants React imbriqués :
  // à chaque render d'AdminPanel, la fonction `Row` aurait une nouvelle
  // identité et React unmount/remount tout le sous-arbre → les <input> text
  // perdent le focus après chaque keystroke. On les expose comme de simples
  // fonctions qui retournent du JSX et on les appelle avec `{renderRow(s)}`.
  const renderRow = (s: AdminSetting) => {
    const dirty = dirtySet.has(s.id);
    // Preview pour le logo org : la valeur est l'URL publique servie par l'API.
    // On l'affiche en miniature à gauche du bouton, et on remplace le label
    // "Upload logo" par "Replace logo" quand un logo est déjà en place.
    const isOrgLogo = s.id === 'org.logoUrl' && s.type === 'action';
    // L'URL stockée embarque `APP_URL` (http://localhost en dev) — depuis le
    // navigateur, "localhost" pointe sur la machine de l'user, pas l'API. On
    // garde uniquement le path (`/api/v1/public/...`) pour le rendu, le
    // navigateur le résout sur l'origin actuelle (même host que le panel).
    const rawLogoUrl = isOrgLogo && typeof values[s.id] === 'string' ? (values[s.id] as string) : '';
    const logoUrl = rawLogoUrl
      ? rawLogoUrl.startsWith('http')
        ? (() => { try { const u = new URL(rawLogoUrl); return u.pathname + u.search; } catch { return rawLogoUrl; } })()
        : rawLogoUrl
      : '';
    // Le Control consomme label/actionLabel/placeholder — on lui passe la
    // version traduite (et le label « Replace logo » quand un logo est posé).
    const tLabel = settingLabel(s);
    const tDesc = settingDesc(s);
    const tAction = isOrgLogo && logoUrl ? t('panel.replaceLogo') : settingAction(s);
    const overriddenSetting: AdminSetting = {
      ...s,
      label: tLabel,
      actionLabel: tAction,
    };
    const orgNameStr =
      typeof values.orgName === 'string' && values.orgName.trim()
        ? (values.orgName as string)
        : t('panel.organization');
    const accentStr =
      typeof values['notif.accentColor'] === 'string'
        ? (values['notif.accentColor'] as string)
        : '#d9604c';
    return (
      <>
      <div className={'set-row' + (dirty ? ' is-dirty' : '')}>
        <div className="set-info">
          <div className="set-label">
            {tLabel}
            {s.badge && s.type !== 'action' && <span className="set-badge">{s.badge}</span>}
            {dirty && <span className="set-changed">{t('panel.changed')}</span>}
          </div>
          {tDesc && <div className="set-desc">{tDesc}</div>}
          {UTC_HOUR_SETTINGS.has(s.id) && (
            <div className="set-desc" style={{ color: 'var(--accent)', marginTop: 2 }}>
              {t('panel.localInYourTz', { hour: localHourLabel(Number(values[s.id])), tz: LOCAL_TZ })}
            </div>
          )}
        </div>
        <div className="set-control" style={isOrgLogo ? { display: 'flex', gap: 12, alignItems: 'center' } : undefined}>
          {isOrgLogo && logoUrl && (
            <img
              src={logoUrl}
              alt={t('panel.orgLogoAlt')}
              style={{
                maxHeight: 40,
                maxWidth: 120,
                borderRadius: 6,
                background: '#fff',
                padding: 4,
                objectFit: 'contain',
              }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <Control
            s={overriddenSetting}
            value={values[s.id]}
            configured={s.type === 'secret' ? !!values[`${s.id}Set`] : undefined}
            onChange={(v) => setVal(s.id, v)}
            onAct={() => handleAction(s)}
          />
          {isOrgLogo && logoUrl && (
            <button
              type="button"
              className="md-btn ghost"
              onClick={async () => {
                if (!(await confirm({ title: t('common:confirm'), message: t('panel.removeLogoConfirm'), danger: true }))) return;
                try {
                  await api.removeOrgLogo();
                  setValues((p) => ({ ...p, 'org.logoUrl': '' }));
                  setBaseline((p) => ({ ...p, 'org.logoUrl': '' }));
                  flash(t('panel.logoRemoved'));
                } catch (e) {
                  flash(t('panel.removeFailed', { message: (e as Error).message }));
                }
              }}
              title={t('panel.removeLogoTitle')}
            >
              {t('panel.remove')}
            </button>
          )}
        </div>
      </div>
      {isOrgLogo && logoUrl && (
        <div className="asection-card" style={{ marginTop: 8, padding: 14 }}>
          <div className="set-label" style={{ marginBottom: 10 }}>
            {t('panel.previewInContext')}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {/* Mock header app */}
            <div style={{ flex: '1 1 240px', minWidth: 220 }}>
              <div className="md-span" style={{ marginBottom: 4 }}>{t('panel.appSidebar')}</div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                }}
              >
                <img
                  src={logoUrl}
                  alt=""
                  style={{ height: 26, maxWidth: 90, objectFit: 'contain' }}
                />
                <strong style={{ fontSize: 14 }}>{orgNameStr}</strong>
              </div>
            </div>
            {/* Mock entête email */}
            <div style={{ flex: '1 1 240px', minWidth: 220 }}>
              <div className="md-span" style={{ marginBottom: 4 }}>{t('panel.emailHeader')}</div>
              <div
                style={{
                  borderRadius: 10,
                  overflow: 'hidden',
                  border: '1px solid var(--border)',
                  background: '#141420',
                }}
              >
                <div style={{ padding: '14px 16px', borderBottom: '1px solid #23232f' }}>
                  <img
                    src={logoUrl}
                    alt=""
                    style={{ maxHeight: 30, maxWidth: 120, objectFit: 'contain' }}
                  />
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '7px 14px',
                      background: accentStr,
                      color: '#fff',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {t('panel.openTask')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      </>
    );
  };

  const renderSpecialSection = (sec: AdminSection) => {
    if (sec.kind === 'userlist')
      return (
        <UserList
          flash={flash}
          roles={roles}
          roleFilter={userRoleFilter}
          onRoleFilterChange={setUserRoleFilter}
          onUsersChanged={setUsers}
        />
      );
    if (sec.kind === 'teamlist')
      return (
        <TeamList
          teams={teams}
          users={users}
          isAdmin={isAdmin}
          flash={flash}
          onTeamsChanged={setTeams}
        />
      );
    if (sec.kind === 'rolelist')
      return (
        <RoleList
          roles={roles}
          counts={roleCounts}
          onPickRole={(key) => {
            setUserRoleFilter(key);
            goSection('identity', 'Users');
          }}
        />
      );
    if (sec.kind === 'doctemplates') return <DocumentTemplatesSection flash={flash} />;
    if (sec.kind === 'projectpolicy')
      return <ProjectPolicySection roles={roles} teams={teams} users={users} flash={flash} />;
    if (sec.kind === 'webhooklist') return <WebhooksSection flash={flash} />;
    if (sec.kind === 'auditlog') return <AuditLogSection flash={flash} />;
    if (sec.kind === 'cryptokeys') return <EncryptionKeysSection flash={flash} />;
    if (sec.kind === 'diagnostics') return <DiagnosticsSection flash={flash} />;
    if (sec.kind === 'emaildeliveries') return <EmailDeliveriesSection flash={flash} />;
    if (sec.kind === 'ssoidp') return <SsoSection flash={flash} roles={roles} />;
    if (sec.kind === 'ticketingconnectors') return <TicketingConnectorsSection flash={flash} />;
    if (sec.kind === 'agentlist') return <AgentsSection flash={flash} />;
    if (sec.kind === 'agentpolicies') return <AgentPoliciesSection flash={flash} />;
    if (sec.kind === 'agentruns') return <AgentRunsSection flash={flash} />;
    if (sec.kind === 'agentconnectors') return <AgentConnectorsSection flash={flash} />;
    if (sec.kind === 'ciconnectors') return <CiConnectorsSection flash={flash} />;
    if (sec.kind === 'agenttrustissuers') return <AgentTrustIssuersSection flash={flash} />;
    if (sec.kind === 'collabspaces') return <CollabSpacesSection flash={flash} />;
    if (sec.kind === 'mcp') return <McpSection flash={flash} />;
    if (sec.kind === 'aiconnections') return <OrgAiConnectionsSection flash={flash} />;
    if (sec.kind === 'sessions') return <ActiveSessionsPanel embedded />;
    if (sec.kind === 'license') return <LicenseSection flash={flash} />;
    if (sec.kind === 'orgapikeys') return <ApiTokensSection mode="org" flash={flash} />;
    if (sec.kind === 'customfields') return <CustomFieldsSection flash={flash} />;
    if (sec.kind === 'customstatuses') return <CustomStatusesSection flash={flash} />;
    if (sec.kind === 'skillslist') return <SkillsSection flash={flash} />;
    if (sec.kind === 'skillsimport') return <SkillsImportSection flash={flash} />;
    if (sec.kind === 'skillslevelscale') return <SkillsLevelScaleSection flash={flash} />;
    const rows = sec.storage || sec.license || [];
    return (
      <div className="usage-card">
        {rows.map((r) => {
          const pct = Math.round((r.used / r.total) * 100);
          const cls = pct >= 90 ? 'over' : pct >= 75 ? 'warn' : '';
          return (
            <div className="usage-row" key={r.name}>
              <div className="usage-head">
                <span className="usage-name">{r.name}</span>
                <span className="usage-val">
                  {r.used} / {r.total} {r.unit} · {pct}%
                </span>
              </div>
              <div className="usage-bar">
                <div className={'usage-fill ' + cls} style={{ width: pct + '%' }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderSection = (sec: AdminSection, bare?: boolean) => (
    <div className="asection">
      {!bare && (
        <div className="asection-title">
          {sectionTitle(sec)}
          {sec.badge && <span className="badge-soft">{sec.badge}</span>}
        </div>
      )}
      {sec.kind ? (
        renderSpecialSection(sec)
      ) : (
        <div className="asection-card">
          {sec.settings!.map((s) => (
            <React.Fragment key={s.id}>{renderRow(s)}</React.Fragment>
          ))}
        </div>
      )}
      {/* Aperçu vivant de la password policy (chantier #13) — reflète les
          réglages COURANTS (même non sauvegardés). */}
      {sec.title === 'Password policy' && (
        <PasswordPolicyExample
          minLength={Number(values.pwMinLength) || 8}
          complexity={
            (values.pwComplexity as 'Low' | 'Medium' | 'High') ?? 'High'
          }
        />
      )}
    </div>
  );

  const navKids = (g: AdminGroup) => g.sections.filter((s) => s.nav);

  return (
    <div className="admin">
      <div className={'anav-scrim' + (drawer ? ' show' : '')} onClick={() => setDrawer(false)} />
      <aside className={'anav' + (drawer ? ' anav-open' : '')}>
        <div className="anav-brand">
          <div className="anav-mark anav-brand-mark">
            <BrandMark size={20} />
          </div>
          <div className="anav-name">
            {typeof values.orgName === 'string' && values.orgName.trim()
              ? (values.orgName as string)
              : t('panel.organization')}
          </div>
        </div>
        <button className="anav-back" onClick={onExit}>
          <Icon name="chevL" size={16} />{' '}
          {lockedNoSeat ? t('panel.logout') : t('panel.backToWorkspace')}
        </button>
        {lockedNoSeat && (
          <div
            className="set-desc"
            style={{ margin: '4px 12px 8px', color: 'var(--text-faint)', fontSize: 12 }}
          >
            {t('panel.adminOnlyBanner')}
          </div>
        )}

        <div className="anav-section">{t('panel.configuration')}</div>
        <nav className="anav-list">
          {GROUPS.map((g) => {
            const kids = navKids(g);
            const expanded = active === g.id && kids.length > 0;
            return (
              <React.Fragment key={g.id}>
                <button
                  className={'anav-item' + (active === g.id && !activeSection ? ' anav-on' : '')}
                  onClick={() => goGroup(g.id)}
                >
                  <Icon name={g.icon} size={18} />
                  <span className="anav-ilabel truncate">{groupLabel(g)}</span>
                  {dirtyByGroup[g.id] ? (
                    <span className="anav-dirty" title={t('panel.unsavedTitle', { count: dirtyByGroup[g.id] })} />
                  ) : kids.length > 0 ? (
                    <Icon name="chevDown" size={15} className={'anav-chev' + (expanded ? ' open' : '')} />
                  ) : null}
                </button>
                {expanded && (
                  <div className="anav-sub">
                    {kids.map((k) => (
                      <button
                        key={k.title}
                        className={'anav-subitem' + (activeSection === k.title ? ' anav-on' : '')}
                        onClick={() => goSection(g.id, k.title)}
                      >
                        <Icon name={k.navIcon || 'list'} size={15} />
                        <span className="anav-ilabel truncate">{sectionTitle(k)}</span>
                        {/* Pastille de comptage réservée aux listes de personnes /
                            groupes / rôles — ailleurs (SSO, webhooks, clés API,
                            audit, skills…) le nombre n'a pas de sens (restait à 0). */}
                        {k.kind === 'userlist' ? (
                          <span className="anav-count">{users.length}</span>
                        ) : k.kind === 'teamlist' ? (
                          <span className="anav-count">{teams.length}</span>
                        ) : k.kind === 'rolelist' ? (
                          <span className="anav-count">{roles.length}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </nav>
        {/* Pied : badge ADMIN à gauche, marque produit à droite. */}
        <div className="anav-foot">
          <span className="anav-tag">{t('panel.adminTag')}</span>
          <span className="anav-powered">
            <BrandMark size={12} />
            {t('panel.poweredBy')}
          </span>
        </div>
      </aside>

      <div className="amain">
        <header className="atop">
          <button className="icon-btn anav-burger" onClick={() => setDrawer(true)} aria-label={t('common:menu')}>
            <Icon name="list" size={20} />
          </button>
          <div className="atop-meta">
            <div className="atop-title">{agentAdminOnly ? t('panel.agentAdminTitle', { defaultValue: 'AI agent administration' }) : t('panel.title')}</div>
            <div className="atop-sub">{t('panel.subtitle', { count: GROUPS.length })}</div>
          </div>
          <div className="grow" />
          {/* La recherche indexe tous les settings (org:manage) — masquée en mode
              restreint pour confiner la navigation aux sections agents. */}
          {!agentAdminOnly && (
            <div className="asearch">
              <Icon name="search" size={16} style={{ color: 'var(--text-3)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('panel.searchAll')}
              />
              {query && (
                <button className="asearch-clear" onClick={() => setQuery('')} aria-label={t('panel.clear')}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          )}
          <LanguageSwitcher />
        </header>

        <main className="acontent">
          <div
            className={
              'awrap' +
              (!results &&
              activeSection &&
              ['userlist', 'agentruns'].includes(
                activeGroup.sections.find((s) => s.title === activeSection)?.kind ?? '',
              )
                ? ' awrap--wide'
                : '')
            }
          >
            {results ? (
              results.count === 0 ? (
                <div className="sres-empty">
                  <div className="se-icon">
                    <Icon name="search" size={24} />
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 15 }}>
                    {t('panel.noMatch', { query })}
                  </div>
                  <div style={{ marginTop: 4 }}>{t('panel.noMatchHint')}</div>
                </div>
              ) : (
                <>
                  <div className="sres-head">
                    <Trans
                      t={t}
                      i18nKey="panel.matchCount"
                      count={results.count}
                      values={{ count: results.count, query }}
                      components={[<b />]}
                    />
                  </div>
                  {results.byGroup.map((b) => (
                    <div className="sres-group" key={b.group.id}>
                      <button className="sres-glabel" onClick={() => goGroup(b.group.id)}>
                        <Icon name={b.group.icon} size={14} /> {groupLabel(b.group)}
                      </button>
                      <div className="asection-card">
                        {b.items.map((s) => (
                          <React.Fragment key={s.id}>{renderRow(s)}</React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )
            ) : (
              (() => {
                const sub = activeSection
                  ? activeGroup.sections.find((s) => s.title === activeSection)
                  : null;
                return (
                  <>
                    <div className="agroup-head">
                      {sub && (
                        <button
                          className="agroup-up"
                          onClick={() => goGroup(activeGroup.id)}
                          title={t('panel.backTo', { label: groupLabel(activeGroup) })}
                        >
                          <Icon name="chevL" size={18} />
                        </button>
                      )}
                      <div className="agroup-icon">
                        <Icon name={sub ? sub.navIcon || activeGroup.icon : activeGroup.icon} size={24} />
                      </div>
                      <div>
                        <h1 className="agroup-h1">
                          {sub ? sectionTitle(sub) : groupLabel(activeGroup)}
                          {!sub && activeGroup.badge && <span className="badge-soft">{activeGroup.badge}</span>}
                        </h1>
                        <p className="agroup-blurb">{sub ? (sectionBlurb(sub) || groupLabel(activeGroup)) : groupBlurb(activeGroup)}</p>
                      </div>
                    </div>
                    {sub ? (
                      sub.children ? (
                        sub.children.map((c, i) => (
                          <React.Fragment key={i}>{renderSection(c)}</React.Fragment>
                        ))
                      ) : (
                        renderSection(sub, true)
                      )
                    ) : (
                      activeGroup.sections
                        .filter((s) => !s.nav)
                        .map((sec, i) => (
                          <React.Fragment key={i}>{renderSection(sec)}</React.Fragment>
                        ))
                    )}
                  </>
                );
              })()
            )}
          </div>
        </main>
      </div>

      {dirtyIds.length > 0 && (
        <div className="savebar">
          <span className="savebar-text">
            <Trans
              t={t}
              i18nKey="panel.unsavedChanges"
              count={dirtyIds.length}
              values={{ count: dirtyIds.length }}
              components={[<b />]}
            />
          </span>
          <button className="btn btn-line btn-sm" onClick={discard}>
            {t('panel.discard')}
          </button>
          <button className="btn btn-accent btn-sm" onClick={save}>
            <Icon name="check" size={15} /> {t('panel.saveChanges')}
          </button>
        </div>
      )}

      {toast && (
        <div className="atoast">
          <span className="at-dot">
            <Icon name="check" size={16} />
          </span>
          {toast}
        </div>
      )}

      {sessionsOpen && <ActiveSessionsPanel onClose={() => setSessionsOpen(false)} />}
      {importOpen && (
        <UserImportModal
          onClose={() => setImportOpen(false)}
          flash={flash}
          onImported={() => {
            // Rafraîchit la liste légère (compteurs nav + picker TeamList).
            api.listUsers().then(setUsers).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
