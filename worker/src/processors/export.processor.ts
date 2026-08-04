import { ExportJob } from '../queues';
import { internalHeaders } from '../internal-headers';

/**
 * Worker BullMQ pour la file `export`.
 *
 * Déclencheur, et rien d'autre : il appelle `POST /internal/exports/run` et
 * laisse l'API faire le rendu (elle seule a la base et les utilitaires PDF/XLSX
 * — le worker est stateless par contrat). Son intérêt est ailleurs : BullMQ
 * apporte les retries avec backoff, une limite de concurrence, et la survie du
 * job à un rolling update de l'API.
 *
 * Timeout volontairement long : un rapport PDF sur un gros projet est
 * précisément ce qu'on sort du chemin de requête.
 */
const TIMEOUT_MS = 15 * 60_000;

export async function processExport(job: ExportJob): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/v1/internal/exports/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalHeaders(job.tenantSlug) },
      body: JSON.stringify({ jobId: job.jobId, organizationId: job.organizationId }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      // On relance : BullMQ retentera. L'API marque le job FAILED de son côté
      // quand elle a pu statuer — ici on ne sait que « l'appel a échoué ».
      throw new Error(`export run HTTP ${res.status}${txt ? ` — ${txt.slice(0, 300)}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
