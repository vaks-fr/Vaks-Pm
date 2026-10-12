// Noms des files BullMQ partagés entre l'API (producteur) et le worker (consommateur).
export const QUEUES = {
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  AGENT_NUDGE: 'agent-nudge',
  AUDIT_SYSLOG: 'audit-syslog',
  TEAMS: 'teams',
  EXPORT: 'export',
} as const;

/**
 * Job d'export long (rapport PDF, classeur XLSX, export RGPD…).
 *
 * Le worker ne **rend rien** : le rendu a besoin de la base et des utilitaires
 * `pdf.util`/`xlsx.util` de l'API, or le worker est sans DB par contrat (cf.
 * `TeamsJob`). Il se contente de déclencher `POST /internal/exports/run` avec un
 * timeout long ; c'est la route API qui calcule, écrit l'artefact dans Garage et
 * met à jour l'état du job.
 *
 * Ce que ça achète : les retries et la backpressure de BullMQ, et surtout la
 * sortie du rendu long du chemin de requête (donc du timeout Traefik). Ce que ça
 * n'achète **pas** : le CPU reste sur l'API — l'isoler demanderait une image de
 * rendu séparée avec accès DB, non rentable sur ce cluster.
 */
export interface ExportJob {
  jobId: string;
  organizationId: string;
  /** Slug tenant (pooled) → header `X-Tenant-Slug` sur l'appel interne. */
  tenantSlug?: string | null;
}

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

/**
 * Nudge sortant vers un agent IA (chantier « réveil sur assignation »). Le
 * worker relit la conf de la souscription via `/internal/agent-nudges/:id`, POST
 * un signal léger `{ event, taskId, projectId, agentId }` signé HMAC vers le
 * callback du provider, puis rapporte l'issue. Shape dupliqué volontairement
 * (pas de dépendance partagée, comme `WebhookJob`).
 */
export interface AgentNudgeJob {
  deliveryId: string;
  subscriptionId: string;
  organizationId: string;
  event: string;
  taskId: string | null;
  projectId: string | null;
  agentId: string;
  /** Email/nom de l'agent — relayés en body + headers `X-Vaks-Agent-*` pour le
   *  dispatch côté provider (un seul flow qui branche sur l'email). */
  agentEmail: string | null;
  agentName: string | null;
  /** CIDR internes approuvés (mode on-prem) → autorisent les IP privées matchantes
   *  côté safe-fetch. Vides / absents = anti-SSRF strict. Déjà gatés côté API. */
  allowedInternalCidrs?: string[];
  /** Slug tenant (pooled) → header `X-Tenant-Slug` sur les appels internes. */
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
   * n'est PLUS transporté par le job (secret hors Redis) : le worker le lit via
   * la route interne `/internal/notifications/smtp` (chiffré at-rest côté API) ;
   * à défaut, fallback sur l'env `SMTP_PASSWORD` (Swarm secret).
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
