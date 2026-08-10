import { Worker, Job, ConnectionOptions } from 'bullmq';
import { URL } from 'url';
import { QUEUES, EmailJob, WebhookJob, AgentNudgeJob, AuditSyslogJob, TeamsJob, ExportJob } from './queues';
import { processEmail } from './processors/email.processor';
import { processWebhook } from './processors/webhook.processor';
import { processAgentNudge } from './processors/agent-nudge.processor';
import { processAuditSyslog } from './processors/audit-syslog.processor';
import { processTeams } from './processors/teams.processor';
import { processExport } from './processors/export.processor';

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://redis:6379');
const connection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
  username: redisUrl.username || undefined,
  maxRetriesPerRequest: null,
};

const emailWorker = new Worker(
  QUEUES.EMAIL,
  async (job: Job<EmailJob>) => {
    await processEmail(job.data);
  },
  { connection },
);

// Files prévues pour les phases suivantes (webhooks, recalcul de charge).
const webhookWorker = new Worker(
  QUEUES.WEBHOOK,
  async (job: Job<WebhookJob>) => {
    await processWebhook(job.data, job.attemptsMade + 1);
  },
  { connection },
);

// Nudge sortant vers les agents IA (réveil sur assignation / boucle de revue).
const agentNudgeWorker = new Worker(
  QUEUES.AGENT_NUDGE,
  async (job: Job<AgentNudgeJob>) => {
    await processAgentNudge(job.data, job.attemptsMade + 1);
  },
  { connection },
);

// Forward du journal d'audit vers le SIEM (syslog RFC 5424 TCP/TLS).
const auditSyslogWorker = new Worker(
  QUEUES.AUDIT_SYSLOG,
  async (job: Job<AuditSyslogJob>) => {
    // attempts = nb de tentatives BullMQ configuré côté producteur (défaut 5) ;
    // sert au processor pour signaler la PERTE TERMINALE d'un lot à l'API.
    const maxAttempts = job.opts.attempts ?? 5;
    await processAuditSyslog(job.data, job.attemptsMade + 1, maxAttempts);
  },
  { connection },
);

// Provisioning Microsoft Teams (Graph) — création/archivage d'équipe à l'activation projet.
const teamsWorker = new Worker(
  QUEUES.TEAMS,
  async (job: Job<TeamsJob>) => {
    // attempts = nb de tentatives BullMQ configuré côté producteur (défaut 5) ;
    // sert au processor pour marquer `terminal:true` à l'épuisement des retries.
    const maxAttempts = job.opts.attempts ?? 5;
    await processTeams(job.data, job.attemptsMade + 1, maxAttempts);
  },
  { connection },
);

// Exports longs (PDF/XLSX/RGPD) : le worker ne fait que déclencher le rendu
// côté API. Concurrence bornée à 2 — un rendu PDF consomme de la mémoire dans
// le conteneur API, en lancer dix en parallèle le ferait tomber en OOM.
const exportWorker = new Worker(
  QUEUES.EXPORT,
  async (job: Job<ExportJob>) => {
    await processExport(job.data);
  },
  { connection, concurrency: 2 },
);

for (const w of [emailWorker, webhookWorker, agentNudgeWorker, auditSyslogWorker, teamsWorker, exportWorker]) {
  w.on('completed', (job) => console.log(`[${w.name}] job ${job.id} OK`));
  w.on('failed', (job, err) => console.error(`[${w.name}] job ${job?.id} KO: ${err.message}`));
}

console.log('Worker BullMQ démarré (files: email, webhook, agent-nudge, audit-syslog, teams, export).');

async function shutdown() {
  await Promise.all([
    emailWorker.close(),
    webhookWorker.close(),
    agentNudgeWorker.close(),
    auditSyslogWorker.close(),
    teamsWorker.close(),
    exportWorker.close(),
  ]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
