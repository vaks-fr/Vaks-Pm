/**
 * Vocabulaire des actions d'audit posées par les hooks explicites. Les
 * mutations capturées par l'interceptor global utilisent un nom dérivé de la
 * route (`<segment>.<create|update|delete>`) et ne passent pas par cette liste.
 * Convention hiérarchique `domaine.objet.evenement` — les filtres UI/API font
 * un startsWith, donc "auth." matche tout le domaine.
 */
export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCESS: 'auth.login.success',
  AUTH_LOGIN_FAILURE: 'auth.login.failure',
  AUTH_MFA_SUCCESS: 'auth.mfa.success',
  AUTH_MFA_FAILURE: 'auth.mfa.failure',
  AUTH_MFA_ENROLLED: 'auth.mfa.enrolled',
  AUTH_MFA_DISABLED: 'auth.mfa.disabled',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  // SSO / identité fédérée (phase 10)
  AUTH_SSO_LOGIN: 'auth.sso.login',
  AUTH_SSO_FAILURE: 'auth.sso.failure',
  USER_PROVISIONED_SSO: 'user.provisioned.sso',
  USER_LINKED_SSO: 'user.linked.sso',
  IDP_CREATED: 'idp.created',
  IDP_UPDATED: 'idp.updated',
  IDP_DELETED: 'idp.deleted',
  API_TOKEN_CREATED: 'apiToken.created',
  API_TOKEN_REVOKED: 'apiToken.revoked',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  USER_UNLOCKED: 'user.unlocked',
  USER_DELETED: 'user.deleted',
  USER_ROLE_CHANGED: 'user.role.changed',
  USER_ADMIN_TOGGLED: 'user.admin.toggled',
  // Grant orthogonal « AI administrator » (Membership.isAgentAdmin → agent:manage).
  USER_AGENT_ADMIN_TOGGLED: 'user.agent_admin.toggled',
  // Sièges de licence (open-core) — attribution/retrait nominatif d'un siège.
  USER_SEAT_GRANTED: 'user.seat.granted',
  USER_SEAT_REVOKED: 'user.seat.revoked',
  // RGPD — anonymisation (pseudonymisation irréversible) & portabilité
  USER_ANONYMIZED: 'user.anonymized',
  USER_DATA_EXPORTED: 'user.data_exported',
  CLIENT_ANONYMIZED: 'client.anonymized',
  CONTACT_ANONYMIZED: 'contact.anonymized',
  SETTINGS_UPDATED: 'settings.updated',
  // Data management — purge du soft-delete (irréversible) & export org (portabilité)
  DATA_PURGED: 'data.purged',
  ORG_DATA_EXPORTED: 'org.data_exported',
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',
  CONNECTOR_CREATED: 'connector.created',
  CONNECTOR_UPDATED: 'connector.updated',
  CONNECTOR_DELETED: 'connector.deleted',
  // Connecteurs CI signataires (vérification des livrables agents — phase C)
  CI_CONNECTOR_CREATED: 'ci_connector.created',
  CI_CONNECTOR_UPDATED: 'ci_connector.updated',
  CI_CONNECTOR_DELETED: 'ci_connector.deleted',
  CI_WEBHOOK_REJECTED: 'ci_webhook.rejected',
  CI_RESULT_RECEIVED: 'ci_result.received',
  ATTACHMENT_DOWNLOADED: 'attachment.downloaded',
  // Rotation des clés de chiffrement (DORA — toutes CRITICAL)
  CRYPTO_KEK_ROTATED: 'crypto.kek.rotated',
  CRYPTO_DEK_ROTATED: 'crypto.dek.rotated',
  // Opérations admin de sécurité (toutes CRITICAL)
  SECURITY_FORCE_LOGOUT_ALL: 'security.forceLogoutAll',
  SECURITY_SESSION_REVOKED: 'security.session.revoked',
  SECURITY_PASSWORD_RESET_LINK: 'security.password.resetLink',
  SECURITY_BREAK_GLASS_TOGGLED: 'security.breakGlass.toggled',
  // Alerting (détection brute-force & co)
  AUDIT_ALERT: 'audit.alert',
  AUDIT_TEST: 'audit.test',
  // Automatisations built-in (actorType SYSTEM — BUILTIN_AUTOMATIONS.md)
  AUTOMATION_ALERT: 'automation.alert',
  AUTOMATION_MUTATION: 'automation.mutation',
  // Auto-plan — levée CIBLÉE du gel du passé (Lot 4.2, « Libérer cette
  // journée ») : un user, un jour, geste explicite du PM. Distinct de la
  // capture générique de /workload/autoplan (l'interceptor loggue déjà la
  // requête) — celle-ci trace spécifiquement le contournement de la règle de
  // gel, pour qu'il reste repérable dans le journal sans dépouiller le detail.
  WORKLOAD_UNFREEZE_DAY: 'workload.autoplan.unfreeze_day',
  // Annonce projet (audience résolue serveur — hook explicite, @SkipAudit)
  ANNOUNCEMENT_CREATED: 'project.announcement.created',
  // Agents IA (chantier 1 — toutes logCritical, @SkipAudit sur les handlers)
  AGENT_CREATED: 'agent.created',
  AGENT_UPDATED: 'agent.updated',
  AGENT_COST_UPDATED: 'agent.cost_updated',
  AGENT_SUSPENDED: 'agent.suspended',
  AGENT_REACTIVATED: 'agent.reactivated',
  AGENT_TOKEN_ISSUED: 'agent.token_issued',
  AGENT_TOKEN_REVOKED: 'agent.token_revoked',
  AGENT_SYNCED: 'agent.synced',
  // Fédération d'identité (RFC 8693). L'échange RÉUSSI est en INFO à dessein :
  // il se produit une fois par heure et par agent, et noierait les entrées
  // CRITICAL s'il était promu. Les REFUS, eux, sont en WARNING — c'est ce qu'on
  // veut voir passer dans le SIEM.
  AGENT_FEDERATION_EXCHANGED: 'agent.federation.exchanged',
  AGENT_FEDERATION_DENIED: 'agent.federation.denied',
  // CRUD des émetteurs de confiance : déclarer qui peut attester d'un agent est
  // une décision de sécurité de premier ordre → CRITICAL.
  AGENT_TRUST_ISSUER_CREATED: 'agent.trust_issuer.created',
  AGENT_TRUST_ISSUER_UPDATED: 'agent.trust_issuer.updated',
  AGENT_TRUST_ISSUER_DELETED: 'agent.trust_issuer.deleted',
  // Auto-authentification des agents headless (refresh rotatif → jeton court).
  // Émission/révocation du credential durable = CRITICAL (acte humain) ; le
  // refresh réussi = INFO (continu) ; les refus = WARNING.
  AGENT_CREDENTIAL_ISSUED: 'agent.credential.issued',
  AGENT_CREDENTIAL_REVOKED: 'agent.credential.revoked',
  AGENT_SELF_AUTH_REFRESHED: 'agent.self_auth.refreshed',
  AGENT_SELF_AUTH_DENIED: 'agent.self_auth.denied',
  // Transition de statut refusée par la matrice (chantier 2 ; WARNING). En mode
  // observation = simplement tracée ; en enforce = accompagne un 409.
  TASK_TRANSITION_OBSERVED: 'task.transition.observed',
  // Bail d'exécution échu (lot A) : l'agent n'a plus donné signe de vie, la
  // tâche est rendue au vivier. Signal de fiabilité de la flotte d'agents, pas
  // un incident de sécurité → WARNING.
  AGENT_LEASE_EXPIRED: 'agent.task.lease_expired',
  // Enveloppe de coût consommée EN COURS de tâche (coupe-circuit lot A).
  // WARNING quand on se contente d'alerter, CRITICAL quand la tâche est
  // effectivement retirée à l'agent (sévérité posée à l'appel).
  AGENT_BUDGET_EXCEEDED: 'agent.budget_exceeded',
  // Opérations / infrastructure (signalées par les scripts host via /ops/*)
  BACKUP_FAILED: 'backup.failed',
  // Provisioning Microsoft Teams : retries BullMQ épuisés (ou cas non-retryable
  // connu d'avance, ex. aucun membre lié à Entra) → échec DÉFINITIF et
  // silencieux jusqu'ici, alerté aux admins du tenant (WARNING).
  TEAMS_PROVISION_FAILED: 'teams.provision.failed',
  // Diagnostic / support (bundle exporté par un admin)
  ADMIN_DIAGNOSTICS_EXPORTED: 'admin.diagnostics.exported',
  // Garde-fou de confirmation MCP (WARNING) : le défi émis sur une action
  // destructrice, et le refus d'un jeton invalide/rejoué/dépareillé. L'action
  // confirmée, elle, est déjà couverte par la capture générique des mutations —
  // le rapport défis/actions donne directement le taux d'abandon des agents.
  MCP_CONFIRM_CHALLENGED: 'mcp.confirm_challenged',
  MCP_CONFIRM_REJECTED: 'mcp.confirm_rejected',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS] | string;

// Type-only (effacé à la compilation) → pas de cycle d'import runtime avec
// audit-log.service, qui reste la source du type.
import type { AuditSeverity } from './audit-log.service';

/**
 * Politique de sévérité du journal d'audit — **source de vérité unique**
 * (revue 2026-07-26). Principe :
 *  - INFO     : opération réussie, routinière, fort volume (login réussi,
 *               logout, refresh de token, CRUD métier, export de ses propres
 *               données, attribution de siège).
 *  - WARNING  : déviation ou signal de sécurité sans incident (échec de login,
 *               permission refusée, création de user/webhook/connecteur, export
 *               de données d'autrui, échec SSO/MFA).
 *  - CRITICAL : irréversible, élévation de privilège, changement de credential
 *               ou d'état de sécurité, incident confirmé (rôle/admin, suppression
 *               ou suspension de compte, anonymisation, purge, MFA, mot de passe,
 *               rotation de clés, tokens, actions security.*, alerte brute-force).
 *
 * Un `outcome:'FAILURE'` remonte automatiquement un INFO à WARNING
 * (cf. `severityForAction`) : un échec est au minimum un signal.
 *
 * Actions absentes de la table : héritent d'INFO (mutations CRUD via
 * l'interceptor, avec bump WARNING sur 401/403). Les hooks `logCritical()`
 * écrivent en CRITICAL immédiat *par construction* — ils couvrent les domaines
 * toujours-critiques non listés ici (crypto.*, apiToken.*, security.*, agent.*,
 * client/contact.anonymized, SCIM…).
 */
export const AUDIT_SEVERITY: Record<string, AuditSeverity> = {
  // — Authentification : routine = INFO ; les échecs passent WARNING via l'outcome —
  [AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS]: 'INFO',
  [AUDIT_ACTIONS.AUTH_LOGIN_FAILURE]: 'WARNING',
  [AUDIT_ACTIONS.AUTH_LOGOUT]: 'INFO',
  [AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED]: 'INFO',
  [AUDIT_ACTIONS.AUTH_SSO_LOGIN]: 'INFO',
  [AUDIT_ACTIONS.AUTH_SSO_FAILURE]: 'WARNING',
  [AUDIT_ACTIONS.AUTH_MFA_SUCCESS]: 'INFO',
  [AUDIT_ACTIONS.AUTH_MFA_FAILURE]: 'WARNING',
  // Changements d'état de sécurité du compte → CRITICAL.
  [AUDIT_ACTIONS.AUTH_MFA_ENROLLED]: 'CRITICAL',
  [AUDIT_ACTIONS.AUTH_MFA_DISABLED]: 'CRITICAL',
  [AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED]: 'CRITICAL',
  // — Utilisateurs —
  [AUDIT_ACTIONS.USER_CREATED]: 'WARNING',
  [AUDIT_ACTIONS.USER_UPDATED]: 'INFO',
  [AUDIT_ACTIONS.USER_SUSPENDED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_REACTIVATED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_UNLOCKED]: 'WARNING',
  [AUDIT_ACTIONS.USER_DELETED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_ROLE_CHANGED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_ADMIN_TOGGLED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_AGENT_ADMIN_TOGGLED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_SEAT_GRANTED]: 'INFO',
  [AUDIT_ACTIONS.USER_SEAT_REVOKED]: 'INFO',
  [AUDIT_ACTIONS.USER_ANONYMIZED]: 'CRITICAL',
  [AUDIT_ACTIONS.USER_DATA_EXPORTED]: 'WARNING',
  [AUDIT_ACTIONS.USER_PROVISIONED_SSO]: 'WARNING',
  [AUDIT_ACTIONS.USER_LINKED_SSO]: 'WARNING',
  // — Données / organisation —
  [AUDIT_ACTIONS.DATA_PURGED]: 'CRITICAL',
  [AUDIT_ACTIONS.ORG_DATA_EXPORTED]: 'WARNING',
  // settings.updated : WARNING par défaut, remonté à CRITICAL au call-site si la
  // modification touche une clé de sécurité (cf. SECURITY_SETTING_PREFIXES).
  [AUDIT_ACTIONS.SETTINGS_UPDATED]: 'WARNING',
  // — Intégrations : configuration visible et réversible, gouvernée (allowlist) —
  [AUDIT_ACTIONS.WEBHOOK_CREATED]: 'WARNING',
  [AUDIT_ACTIONS.WEBHOOK_UPDATED]: 'WARNING',
  [AUDIT_ACTIONS.WEBHOOK_DELETED]: 'WARNING',
  [AUDIT_ACTIONS.CONNECTOR_CREATED]: 'WARNING',
  [AUDIT_ACTIONS.CONNECTOR_UPDATED]: 'WARNING',
  [AUDIT_ACTIONS.CONNECTOR_DELETED]: 'WARNING',
  // — Boucle d'exécution des agents (lot A) —
  [AUDIT_ACTIONS.AGENT_LEASE_EXPIRED]: 'WARNING',
  [AUDIT_ACTIONS.AGENT_BUDGET_EXCEEDED]: 'WARNING',
  // — Provisioning Microsoft Teams —
  [AUDIT_ACTIONS.TEAMS_PROVISION_FAILED]: 'WARNING',
  // — Auto-plan : contournement explicite (mais borné) du gel du passé —
  [AUDIT_ACTIONS.WORKLOAD_UNFREEZE_DAY]: 'WARNING',
};

/** Préfixes de clés `OrgSetting` dont la modification est CRITICAL. */
export const SECURITY_SETTING_PREFIXES = ['security.', 'audit.', 'smtp.', 'sso.'];

/**
 * Sévérité d'une action selon `AUDIT_SEVERITY`. Un échec relève au minimum d'un
 * WARNING. Défaut INFO pour les actions non répertoriées.
 */
export function severityForAction(
  action: string,
  outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS',
): AuditSeverity {
  const base = AUDIT_SEVERITY[action] ?? 'INFO';
  if (outcome === 'FAILURE' && base === 'INFO') return 'WARNING';
  return base;
}
