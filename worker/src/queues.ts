// Noms des files BullMQ partagés entre l'API (producteur) et le worker (consommateur).
export const QUEUES = {
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  WORKLOAD_RECALC: 'workload-recalc',
  AUDIT_SYSLOG: 'audit-syslog',
  TEAMS: 'teams',
} as const;

/**
 * Job de provisioning Microsoft Teams. Stateless : le worker ne lit aucune conf
 * ni secret — il récupère un **contexte complet** (token Graph minté par l'API,
 * config, membres résolus) via `GET /internal/teams-provisioning/...`, exécute
 * les appels Graph, puis rapporte le résultat. Le client secret ne quitte
 * jamais l'API (chiffré at-rest, déchiffré juste pour minter le token app).
 */
export interface TeamsJob {
  action: 'provision' | 'archive' | 'unarchive' | 'reconcile';
  projectId: string;
  organizationId: string;
  /** Slug tenant (pooled) → header `X-Tenant-Slug` sur les appels internes. */
  tenantSlug?: string | null;
}

export interface WebhookJob {
  deliveryId: string;
  webhookId: string;
  organizationId: string;
  event: string;
  payload: unknown;
  /** Slug du tenant (mode pooled) — renvoyé à l'API en header `X-Tenant-Slug`
   *  pour router les appels internes vers la base du tenant. */
  tenantSlug?: string | null;
}

/** Config syslog snapshotée par l'API au moment de l'enqueue (worker stateless,
 *  pas d'accès DB ni de lecture de conf — tout est dans le job). */
export interface AuditSyslogConfig {
  host: string;
  port: number;
  protocol: 'tcp' | 'tls';
  /** CA PEM custom (auto-signé / interne). Absent = store système. */
  caPem?: string;
  /** Certificat client mTLS (public) ; la clé privée est lue localement via
   *  SYSLOG_CLIENT_KEY_FILE (secret Swarm), jamais transportée dans le job. */
  clientCertPem?: string;
  rejectUnauthorized: boolean;
  appName: string;
}

/** Entrée d'audit sérialisée pour le forward SIEM (shape stable côté worker,
 *  dupliquée volontairement — pas de dépendance partagée, comme EmailJob). */
export interface AuditSyslogEntry {
  id: string;
  createdAt: string;
  action: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  outcome: 'SUCCESS' | 'FAILURE';
  actorType: string;
  actorId?: string | null;
  actorLabel?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabel?: string | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  detail?: unknown;
}

export interface AuditSyslogJob {
  organizationId: string;
  tenantSlug?: string | null;
  config: AuditSyslogConfig;
  entries: AuditSyslogEntry[];
  /** Job de test (bouton admin) : envoie un message `audit.test` puis POST le
   *  résultat à /internal/audit/syslog-test-result. */
  test?: boolean;
}

export interface EmailJob {
  /** Org émettrice — pour MAJ EmailDelivery et pour cache SMTP par-org futur. */
  organizationId?: string;
  /** Slug tenant (pooled) → header `X-Tenant-Slug` sur le callback de MAJ statut. */
  tenantSlug?: string | null;
  /** ID de la ligne EmailDelivery à mettre à jour (status/error/sentAt). */
  deliveryId?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Override From / Reply-To, fournis par le producteur (API). */
  fromName?: string;
  fromAddress?: string;
  replyTo?: string;
  /**
   * Conf SMTP de transport résolue par tenant côté API (host/port/encryption/
   * authMode/user + mot de passe déchiffré). Quand fournie (host non vide), le
   * worker l'utilise telle quelle au lieu de sa conf globale. Le mot de passe
   * peut venir d'ici (saisi dans l'admin, chiffré at-rest) ; à défaut, fallback
   * sur l'env `SMTP_PASSWORD` (Swarm secret).
   */
  smtp?: {
    host: string;
    port: number;
    encryption: 'none' | 'starttls' | 'ssl';
    authMode: 'anonymous' | 'password';
    user: string | null;
    password: string | null;
  };
  /**
   * Images à embarquer inline dans le mail (CID attachments). Le HTML doit
   * référencer chacune via `<img src="cid:<cid>">`. Utilisé pour le logo org
   * afin que les destinataires voient l'image sans avoir besoin que `APP_URL`
   * soit résolvable depuis leur client mail.
   */
  inlineImages?: Array<{
    cid: string;
    /** Données binaires en base64 (sans préfixe data:). */
    base64: string;
    contentType: string;
    filename?: string;
  }>;
  /**
   * Pièces jointes « fichier » (non inline) — ex. l'offre commerciale jointe
   * à l'email envoyé au client. Contenu en base64, remappé en attachment
   * nodemailer (`content` Buffer) côté processor.
   */
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType: string;
  }>;
}
