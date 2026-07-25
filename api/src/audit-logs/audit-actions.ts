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
  // Opérations / infrastructure (signalées par les scripts host via /ops/*)
  BACKUP_FAILED: 'backup.failed',
  // Diagnostic / support (bundle exporté par un admin)
  ADMIN_DIAGNOSTICS_EXPORTED: 'admin.diagnostics.exported',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS] | string;
