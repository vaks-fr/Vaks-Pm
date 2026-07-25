import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as os from 'node:os';
import { AuditSyslogEntry, AuditSyslogJob } from '../queues';

/**
 * Worker BullMQ pour la file `audit-syslog` : forward des entrées du journal
 * d'audit vers un collecteur SIEM en **syslog RFC 5424** sur TCP brut ou TLS,
 * avec **framing octet-counting RFC 6587** (`<len> <msg>`), le seul framing
 * fiable pour des messages contenant des retours ligne potentiels.
 *
 * - Connexions poolées par cible (host:port:protocol), fermées après 60 s
 *   d'inactivité — un batch réutilise la connexion du précédent.
 * - Reconnexion = retries BullMQ (attempts 5, backoff exponentiel, conf côté
 *   producteur `api/src/audit-logs/audit-syslog-queue.ts`). Livraison
 *   at-least-once : l'`id` d'entrée (UUID) permet le dédoublonnage côté SIEM.
 * - Job `test: true` (bouton admin) : envoie un message `audit.test` puis
 *   rapporte le résultat à l'API (`/internal/audit/syslog-test-result`).
 */

const WRITE_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 60_000;

// PRI RFC 5424 = facility * 8 + severity. Facility 13 = log audit.
const FACILITY = 13;
const SYSLOG_SEVERITY: Record<string, number> = { CRITICAL: 2, WARNING: 4, INFO: 6 };

interface PooledConn {
  socket: net.Socket;
  idleTimer: NodeJS.Timeout;
}

const pool = new Map<string, PooledConn>();

function poolKey(cfg: AuditSyslogJob['config']): string {
  return `${cfg.host}:${cfg.port}:${cfg.protocol}`;
}

function closeConn(key: string): void {
  const c = pool.get(key);
  if (!c) return;
  pool.delete(key);
  clearTimeout(c.idleTimer);
  c.socket.destroy();
}

/**
 * Clé privée mTLS, montée comme secret Swarm sur le worker (jamais en DB ni
 * dans les jobs). Contenu vide ou « none » = pas de clé (secret placeholder).
 */
function readClientKey(): string | undefined {
  const file = process.env.SYSLOG_CLIENT_KEY_FILE ?? '/run/secrets/syslog_client_key';
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return v && v !== 'none' ? v : undefined;
  } catch {
    return undefined;
  }
}

function connect(cfg: AuditSyslogJob['config']): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    let socket: net.Socket;
    if (cfg.protocol === 'tls') {
      // mTLS : actif uniquement si cert (settings org) ET clé (secret) présents.
      const clientKey = cfg.clientCertPem ? readClientKey() : undefined;
      socket = tls.connect(
        {
          host: cfg.host,
          port: cfg.port,
          ca: cfg.caPem || undefined,
          cert: clientKey ? cfg.clientCertPem : undefined,
          key: clientKey,
          rejectUnauthorized: cfg.rejectUnauthorized !== false,
          timeout: WRITE_TIMEOUT_MS,
        },
        () => {
          socket.off('error', onError);
          resolve(socket);
        },
      );
    } else {
      socket = net.connect({ host: cfg.host, port: cfg.port, timeout: WRITE_TIMEOUT_MS }, () => {
        socket.off('error', onError);
        resolve(socket);
      });
    }
    socket.once('error', onError);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Timeout de connexion à ${cfg.host}:${cfg.port}`));
    });
  });
}

async function getConn(cfg: AuditSyslogJob['config']): Promise<net.Socket> {
  const key = poolKey(cfg);
  const existing = pool.get(key);
  if (existing && !existing.socket.destroyed) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => closeConn(key), IDLE_CLOSE_MS);
    existing.idleTimer.unref();
    return existing.socket;
  }
  if (existing) closeConn(key);
  const socket = await connect(cfg);
  socket.setTimeout(0); // le timeout de connexion ne s'applique pas au steady-state
  socket.on('error', () => closeConn(key));
  socket.on('close', () => closeConn(key));
  const idleTimer = setTimeout(() => closeConn(key), IDLE_CLOSE_MS);
  idleTimer.unref();
  pool.set(key, { socket, idleTimer });
  return socket;
}

function writeAll(socket: net.Socket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timeout d’écriture syslog'));
    }, WRITE_TIMEOUT_MS);
    socket.write(data, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Valeur de champ d'en-tête RFC 5424 : pas d'espace ni de contrôle, NILVALUE sinon. */
function hdr(v: string | null | undefined, max = 48): string {
  const clean = (v ?? '').replace(/[^\x21-\x7e]/g, '');
  return clean ? clean.slice(0, max) : '-';
}

/** Échappement des valeurs de SD-PARAM (RFC 5424 §6.3.3). */
function sdEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/]/g, '\\]');
}

function buildMessage(job: AuditSyslogJob, entry: AuditSyslogEntry): string {
  const pri = FACILITY * 8 + (SYSLOG_SEVERITY[entry.severity] ?? 6);
  const sd =
    `[vaks@32473 org="${sdEscape(job.organizationId)}"` +
    (job.tenantSlug ? ` tenant="${sdEscape(job.tenantSlug)}"` : '') +
    ` outcome="${entry.outcome}"]`;
  const msg = JSON.stringify(entry);
  return (
    `<${pri}>1 ${entry.createdAt} ${hdr(os.hostname())} ${hdr(job.config.appName)} ` +
    `${process.pid} ${hdr(entry.action)} ${sd} ${msg}`
  );
}

/** Framing octet-counting RFC 6587 : `<longueur-en-octets> SP <message>`. */
function frame(msg: string): string {
  return `${Buffer.byteLength(msg, 'utf8')} ${msg}`;
}

function internalHeaders(tenantSlug?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = process.env.WORKER_API_TOKEN;
  if (token) headers['X-Worker-Token'] = token;
  if (tenantSlug) headers['X-Tenant-Slug'] = tenantSlug;
  return headers;
}

async function reportTestResult(job: AuditSyslogJob, ok: boolean, error?: string): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  try {
    await fetch(`${base}/api/v1/internal/audit/syslog-test-result`, {
      method: 'POST',
      headers: internalHeaders(job.tenantSlug),
      body: JSON.stringify({ organizationId: job.organizationId, ok, error: error ?? null }),
    });
  } catch {
    /* best-effort : le badge UI restera sur l'état précédent */
  }
}

/** Signale à l'API la perte TERMINALE d'un lot (toutes les tentatives BullMQ
 *  épuisées) → compteur + badge dans l'admin. Best-effort. */
async function reportTerminalFailure(job: AuditSyslogJob, error: string): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  try {
    await fetch(`${base}/api/v1/internal/audit/syslog-failure`, {
      method: 'POST',
      headers: internalHeaders(job.tenantSlug),
      body: JSON.stringify({
        organizationId: job.organizationId,
        error: error.slice(0, 500),
        entryCount: job.entries.length,
      }),
    });
  } catch {
    /* best-effort */
  }
}

export async function processAuditSyslog(
  job: AuditSyslogJob,
  attempt = 1,
  maxAttempts = 5,
): Promise<void> {
  if (job.test) {
    const entry: AuditSyslogEntry = {
      id: 'test',
      createdAt: new Date().toISOString(),
      action: 'audit.test',
      severity: 'INFO',
      outcome: 'SUCCESS',
      actorType: 'SYSTEM',
      detail: { message: 'Test de connexion SIEM depuis Vaks PM' },
    };
    try {
      const socket = await getConn(job.config);
      await writeAll(socket, frame(buildMessage(job, entry)));
      await reportTestResult(job, true);
    } catch (err) {
      closeConn(poolKey(job.config));
      await reportTestResult(job, false, (err as Error).message);
      // Pas de throw : un test échoué ne doit pas être retenté 5 fois — le
      // résultat (badge rouge + message) est déjà rapporté à l'admin.
    }
    return;
  }

  if (!job.entries.length) return;
  const payload = job.entries.map((e) => frame(buildMessage(job, e))).join('');
  try {
    const socket = await getConn(job.config);
    await writeAll(socket, payload);
  } catch (err) {
    // Connexion morte → on la jette et on laisse BullMQ retenter le batch.
    closeConn(poolKey(job.config));
    const e = err instanceof Error ? err : new Error(String(err));
    // Dernière tentative : le lot est définitivement perdu → on le signale à
    // l'API (compteur + badge admin) AVANT de rethrow.
    if (attempt >= maxAttempts) {
      await reportTerminalFailure(job, e.message);
    }
    throw e;
  }
}
