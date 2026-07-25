import { Worker, Job, ConnectionOptions } from 'bullmq';
import { URL } from 'url';
import { QUEUES, EmailJob, WebhookJob, AuditSyslogJob, TeamsJob } from './queues';
import { processEmail } from './processors/email.processor';
import { processWebhook } from './processors/webhook.processor';
import { processAuditSyslog } from './processors/audit-syslog.processor';
import { processTeams } from './processors/teams.processor';

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
    await processTeams(job.data);
  },
  { connection },
);

for (const w of [emailWorker, webhookWorker, auditSyslogWorker, teamsWorker]) {
  w.on('completed', (job) => console.log(`[${w.name}] job ${job.id} OK`));
  w.on('failed', (job, err) => console.error(`[${w.name}] job ${job?.id} KO: ${err.message}`));
}

console.log('Worker BullMQ démarré (files: email, webhook, audit-syslog, teams).');

async function shutdown() {
  await Promise.all([
    emailWorker.close(),
    webhookWorker.close(),
    auditSyslogWorker.close(),
    teamsWorker.close(),
  ]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
