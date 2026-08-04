import { createHmac } from 'crypto';
import { WebhookJob } from '../queues';
import { safeFetch } from '../safe-fetch';
import { internalHeaders } from '../internal-headers';

/**
 * Worker BullMQ pour la file `webhook`. POST le payload au receveur externe
 * avec :
 *   - X-Vaks-Event       : nom de l'event (task.created, …)
 *   - X-Vaks-Delivery    : id WebhookDelivery (idempotence côté receveur)
 *   - X-Vaks-Signature   : `sha256=<hex>` HMAC(secret, body)
 *   - X-Vaks-Timestamp   : epoch seconds, à inclure dans la vérification si on
 *                          ajoute une anti-replay côté receveur (futur)
 *
 * Retries gérés par BullMQ via `attempts` + `backoff exponential` côté
 * producteur (api/src/webhooks/webhook-queue.ts).
 *
 * On considère 2xx = success, le reste = retry. Timeout 10 s par essai.
 */

const TIMEOUT_MS = 10_000;
const BODY_SNIPPET_MAX = 1000;

interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  active: boolean;
  /** 'raw' (enveloppe Vaks) ou 'teams' (Adaptive Card). */
  format?: string;
}

async function fetchWebhookConfig(
  id: string,
  tenantSlug?: string | null,
): Promise<WebhookConfig | null> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const res = await fetch(`${base}/api/v1/internal/webhooks/${id}`, {
    headers: internalHeaders(tenantSlug),
  });
  if (!res.ok) return null;
  // L'endpoint renvoie `null` (corps vide, HTTP 200) si le webhook est
  // introuvable → `res.json()` jetterait "Unexpected end of JSON input".
  const txt = await res.text();
  if (!txt) return null;
  return JSON.parse(txt) as WebhookConfig;
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
    await fetch(`${base}/api/v1/internal/webhooks/deliveries/${deliveryId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort observability */
  }
}

const EVENT_LABELS: Record<string, string> = {
  'task.created': '🆕 Tâche créée',
  'task.updated': '✏️ Tâche mise à jour',
  'task.moved': '↔️ Tâche déplacée',
  'task.deleted': '🗑️ Tâche supprimée',
  'task.assigned': '👤 Tâche assignée',
  'task.unassigned': '👤 Tâche désassignée',
  'task.completed': '✅ Tâche terminée',
  'comment.created': '💬 Nouveau commentaire',
  'project.created': '📁 Projet créé',
  'project.updated': '📁 Projet mis à jour',
  'project.announcement': '📣 Annonce projet',
  'skill_request.created': '🎓 Demande de compétence',
  'skill_request.acknowledged': '🎓 Demande de compétence — prise en compte',
  'skill_request.resolved': '🎓 Demande de compétence — résolue',
  'skill_request.rejected': '🎓 Demande de compétence — refusée',
  'skill_request.reminded': '🎓 Demande de compétence — rappel',
  'audit.alert': '🚨 Alerte sécurité',
  'automation.alert': '⚙️ Automatisation',
  ping: '✅ Test webhook',
};

// Libellés par règle d'automatisation (payload `automation.alert`, champ `kind`).
// Complétés au fil des lots (BUILTIN_AUTOMATIONS.md).
const AUTOMATION_KIND_LABELS: Record<string, string> = {
  on_hold_dormant: '⏸️ Tâche en pause dormante',
  overdue: '⏰ Tâche en retard',
  in_progress_inactive: '🐌 Tâche au point mort',
  unassigned_stale: '👤 Tâche sans assigné',
  external_blocked_stale: '🔗 Bloquée par un prestataire externe',
  due_soon: '📅 Échéance proche',
  milestone_at_risk: '🚩 Jalon à risque',
  overload: '🔥 Surcharge',
  underload: '🌤️ Capacité disponible',
  low_utilization: '📉 Occupation facturable basse',
  timesheet_incomplete: '🕗 Timesheet incomplète',
  overtime_high: '⚠️ Heures supplémentaires élevées',
  budget_threshold: '💶 Palier de budget franchi',
  forecast_overrun: '📈 Prévisionnel au-dessus du budget',
  project_inactive: '💤 Projet inactif',
  project_end_soon: '🏁 Fin de projet proche',
  skill_gap: '🎓 Compétence manquante',
  parent_ready: '✅ Tâche parente prête à revoir',
  agent_budget: "🤖 Budget d'agent IA",
  agent_run_anomaly: '🕵️ Déclaration de coût agent suspecte',
  agent_blocked: '🆘 Agent IA bloqué',
  deliverable_stale: '📄 Livrable en attente de revue',
  timeoff_conflict: '🌴 Congé vs plan de charge',
  autoplan_overflow: '📐 Plan hors échéance',
  // Lot 4.3 auto-plan (2026-08-02) — allocation dont la fenêtre est passée, tâche jamais sortie de TODO
  allocation_window_missed: '🗓️ Allouée mais jamais démarrée',
  // Feed sponsor (2026-07-18)
  milestone_reached: '🏆 Jalon atteint',
  project_status_changed: '📁 Statut du projet modifié',
  sponsor_budget: '💶 Palier de budget franchi',
  // Sous-statuts (Custom Status, 2026-07-19)
  sub_status_entered: '🏷️ Tâche entrée dans un sous-statut',
};

function fact(title: string, value: unknown): { title: string; value: string } | null {
  if (value === null || value === undefined || value === '') return null;
  return { title, value: String(value) };
}

/**
 * Construit un message Teams (Adaptive Card) à partir de l'event + payload.
 * Format consommé directement par « Post card in a chat or channel »
 * (Power Automate) : objet `{ type: 'message', attachments: [adaptive card] }`.
 */
function buildTeamsMessage(event: string, payload: unknown): unknown {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const label =
    event === 'automation.alert'
      ? AUTOMATION_KIND_LABELS[String(p.kind)] ?? EVENT_LABELS[event]
      : EVENT_LABELS[event] ?? event;
  const headline =
    // Alerte d'automatisation : `message` = la phrase complète (title = juste le heading).
    (event === 'automation.alert' ? p.message || p.title : undefined) ||
    p.title ||
    p.name ||
    p.message ||
    (typeof p.body === 'string' ? p.body.slice(0, 200) : '') ||
    label;

  const facts = [
    fact('Statut', p.status),
    fact('Priorité', p.priority),
    fact(
      'Assigné à',
      Array.isArray(p.assignees)
        ? p.assignees.map((a: any) => a?.user?.name || a?.name || a?.userId).filter(Boolean).join(', ')
        : undefined,
    ),
    fact('Auteur', p.author?.name || p.authorName),
    fact('Échéance', typeof p.dueDate === 'string' ? p.dueDate.slice(0, 10) : undefined),
    fact('Équipe', p.team?.name),
    fact('Compétence', p.skill?.name || p.proposedName),
    fact('Projet', p.project?.name),
  ].filter(Boolean) as Array<{ title: string; value: string }>;

  const body: unknown[] = [
    { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: label, wrap: true },
    { type: 'TextBlock', text: String(headline), wrap: true, spacing: 'None', isSubtle: true },
  ];
  if (facts.length) body.push({ type: 'FactSet', facts });

  // Pas d'Action.OpenUrl : l'app n'a pas (encore) de deep-link tâche/projet et
  // APP_URL n'est pas garanti côté worker → un lien serait mort. À rebrancher
  // quand un vrai schéma de deep-link SPA + APP_URL résolvable existeront.
  const card: Record<string, unknown> = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body,
  };

  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}

export async function processWebhook(job: WebhookJob, attempt: number): Promise<void> {
  const cfg = await fetchWebhookConfig(job.webhookId, job.tenantSlug);
  if (!cfg) {
    await reportDelivery(
      job.deliveryId,
      {
        status: 'FAILED',
        error: 'Webhook config introuvable (supprimé ?)',
        attemptCount: attempt,
      },
      job.tenantSlug,
    );
    return; // pas de retry — la conf n'existe plus
  }
  if (!cfg.active) {
    await reportDelivery(
      job.deliveryId,
      {
        status: 'FAILED',
        error: 'Webhook inactif',
        attemptCount: attempt,
      },
      job.tenantSlug,
    );
    return;
  }

  const bodyObj =
    cfg.format === 'teams'
      ? buildTeamsMessage(job.event, job.payload)
      : {
          event: job.event,
          deliveryId: job.deliveryId,
          organizationId: job.organizationId,
          at: new Date().toISOString(),
          payload: job.payload,
        };
  const bodyStr = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = 'sha256=' + createHmac('sha256', cfg.secret).update(bodyStr).digest('hex');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // safeFetch : re-valide l'URL + résout le DNS + suit les redirects
    // manuellement (un 302 vers une IP interne / metadata cloud est bloqué).
    // La validation à la création ne suffit pas (DNS-rebinding entre-temps).
    const res = await safeFetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Vaks-PM-Webhook/1.0',
        'X-Vaks-Event': job.event,
        'X-Vaks-Delivery': job.deliveryId,
        'X-Vaks-Signature': sig,
        'X-Vaks-Timestamp': ts,
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    const snippet = await safeReadSnippet(res);
    if (res.ok) {
      await reportDelivery(
        job.deliveryId,
        {
          status: 'SUCCESS',
          responseStatus: res.status,
          responseBody: snippet,
          attemptCount: attempt,
        },
        job.tenantSlug,
      );
    } else {
      // 4xx/5xx → fail + retry. On marque FAILED maintenant (sera ré-écrasé en
      // PENDING par le prochain attempt si BullMQ relance).
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
    // Si on n'a pas déjà reporté (cas réseau / abort), on rapporte ici.
    if (aborted || !(err as Error).message?.startsWith('HTTP ')) {
      await reportDelivery(
        job.deliveryId,
        {
          status: 'FAILED',
          error: msg,
          attemptCount: attempt,
        },
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
