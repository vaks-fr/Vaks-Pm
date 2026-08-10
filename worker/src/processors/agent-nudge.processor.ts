import { createHmac } from 'crypto';
import { AgentNudgeJob } from '../queues';
import { safeFetch } from '../safe-fetch';
import { internalHeaders } from '../internal-headers';

/**
 * Worker BullMQ pour la file `agent-nudge`. POST un **nudge** (signal léger sans
 * autorité) vers l'URL de callback du provider (Copilot Studio / Power Automate,
 * n8n, runner custom). Version slim de `webhook.processor.ts` : pas de carte
 * Teams, un seul format de body.
 *
 * En-têtes (mêmes conventions que le webhook générique) :
 *   - X-Vaks-Event      : nom de l'event (task.assigned, …)
 *   - X-Vaks-Delivery   : id AgentNudgeDelivery (idempotence côté receveur)
 *   - X-Vaks-Signature  : `sha256=<hex>` HMAC(secret, body)
 *   - X-Vaks-Timestamp  : epoch seconds
 *
 * 2xx = success, le reste = retry (BullMQ, backoff exp côté producteur). Timeout
 * 10 s par essai. POST via `safeFetch` (anti-SSRF : DNS pinné + re-validation
 * des redirects).
 */

const TIMEOUT_MS = 10_000;
const BODY_SNIPPET_MAX = 1000;

interface NudgeConfig {
  id: string;
  callbackUrl: string;
  secret: string;
  active: boolean;
}

async function fetchConfig(
  id: string,
  tenantSlug?: string | null,
): Promise<NudgeConfig | null> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const res = await fetch(`${base}/api/v1/internal/agent-nudges/${id}`, {
    headers: internalHeaders(tenantSlug),
  });
  if (!res.ok) return null;
  // L'endpoint renvoie `null` (corps vide, HTTP 200) si introuvable.
  const txt = await res.text();
  if (!txt) return null;
  return JSON.parse(txt) as NudgeConfig;
}

async function reportDelivery(
  deliveryId: string,
  body: {
    status: 'SUCCESS' | 'FAILED';
    responseStatus?: number | null;
    responseBody?: string | null;
    error?: string | null;
    attemptCount: number;
  },
  tenantSlug?: string | null,
): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...internalHeaders(tenantSlug),
  };
  try {
    await fetch(`${base}/api/v1/internal/agent-nudges/deliveries/${deliveryId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort observability */
  }
}

export async function processAgentNudge(job: AgentNudgeJob, attempt: number): Promise<void> {
  const cfg = await fetchConfig(job.subscriptionId, job.tenantSlug);
  if (!cfg) {
    await reportDelivery(
      job.deliveryId,
      { status: 'FAILED', error: 'Souscription introuvable (supprimée ?)', attemptCount: attempt },
      job.tenantSlug,
    );
    return; // pas de retry — la conf n'existe plus
  }
  if (!cfg.active) {
    await reportDelivery(
      job.deliveryId,
      { status: 'FAILED', error: 'Souscription inactive', attemptCount: attempt },
      job.tenantSlug,
    );
    return;
  }

  // Nudge minimal, sans autorité : l'agent tire et claim ensuite avec son PAT.
  const bodyObj = {
    event: job.event,
    taskId: job.taskId,
    projectId: job.projectId,
    agentId: job.agentId,
    agentEmail: job.agentEmail,
    agentName: job.agentName,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = 'sha256=' + createHmac('sha256', cfg.secret).update(bodyStr).digest('hex');
  // Identité de l'agent aussi en headers → le provider peut brancher un seul
  // flow sur `X-Vaks-Agent-Email` (Switch) sans parser le body.
  const agentHeaders: Record<string, string> = { 'X-Vaks-Agent-Id': job.agentId };
  if (job.agentEmail) agentHeaders['X-Vaks-Agent-Email'] = job.agentEmail;
  if (job.agentName) agentHeaders['X-Vaks-Agent-Name'] = encodeURIComponent(job.agentName);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(cfg.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Vaks-PM-Nudge/1.0',
        'X-Vaks-Event': job.event,
        'X-Vaks-Delivery': job.deliveryId,
        'X-Vaks-Signature': sig,
        'X-Vaks-Timestamp': ts,
        ...agentHeaders,
      },
      body: bodyStr,
      signal: ctrl.signal,
    }, job.allowedInternalCidrs);
    const snippet = await safeReadSnippet(res);
    if (res.ok) {
      await reportDelivery(
        job.deliveryId,
        { status: 'SUCCESS', responseStatus: res.status, responseBody: snippet, attemptCount: attempt },
        job.tenantSlug,
      );
    } else {
      const msg = `HTTP ${res.status}`;
      await reportDelivery(
        job.deliveryId,
        {
          status: 'FAILED',
          responseStatus: res.status,
          responseBody: snippet,
          error: msg,
          attemptCount: attempt,
        },
        job.tenantSlug,
      );
      throw new Error(msg);
    }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    const msg = aborted ? `Timeout après ${TIMEOUT_MS}ms` : (err as Error).message;
    if (aborted || !(err as Error).message?.startsWith('HTTP ')) {
      await reportDelivery(
        job.deliveryId,
        { status: 'FAILED', error: msg, attemptCount: attempt },
        job.tenantSlug,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadSnippet(res: Response): Promise<string | null> {
  try {
    const txt = await res.text();
    if (!txt) return null;
    return txt.length > BODY_SNIPPET_MAX ? txt.slice(0, BODY_SNIPPET_MAX) + '…' : txt;
  } catch {
    return null;
  }
}
