/* ============================================================
   Vaks — Démo statique : handler réseau (faux backend en mémoire).
   ----------------------------------------------------------------
   Point d'entrée unique appelé par `fetchWithRefresh` (client.ts) quand
   DEMO=true. Parse (méthode, path, query, body), dispatch via `resolve()`
   et emballe le résultat dans un VRAI objet `Response` — toute la logique
   aval de client.ts (request : 204/JSON/ApiError, downloadFile : blob +
   Content-Disposition, multipartUpload) marche donc inchangée.
   ============================================================ */
import { DEMO_LATENCY_MS } from './config';
import { resolve, DemoHttpError, type DemoResult } from './routes';

const jsonHeaders = { 'Content-Type': 'application/json' };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Découpe le path en (chemin, query object). */
function parseUrl(pathWithQuery: string): { path: string; query: Record<string, string> } {
  const qIdx = pathWithQuery.indexOf('?');
  if (qIdx < 0) return { path: pathWithQuery, query: {} };
  const path = pathWithQuery.slice(0, qIdx);
  const query: Record<string, string> = {};
  const usp = new URLSearchParams(pathWithQuery.slice(qIdx + 1));
  usp.forEach((v, k) => {
    query[k] = v;
  });
  return { path, query };
}

/** Extrait le corps de la requête (JSON, FormData multipart, ou vide). */
async function parseBody(init: RequestInit): Promise<unknown> {
  const b = init.body;
  if (b == null) return undefined;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return b;
    }
  }
  if (typeof FormData !== 'undefined' && b instanceof FormData) return b;
  return b;
}

/** Emballe un résultat métier en `Response`. `undefined` ⇒ 204 No Content. */
function toResponse(result: DemoResult): Response {
  if (result === undefined) return new Response(null, { status: 204 });
  if (result instanceof Response) return result;
  return new Response(JSON.stringify(result), { status: 200, headers: jsonHeaders });
}

/** Emballe une erreur au format attendu par `extractError` (NestJS-like). */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ statusCode: status, message }), {
    status,
    headers: jsonHeaders,
  });
}

export async function demoHandler(pathWithQuery: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const { path, query } = parseUrl(pathWithQuery);
  const body = await parseBody(init);

  if (DEMO_LATENCY_MS > 0) await sleep(DEMO_LATENCY_MS);

  try {
    const result = await resolve(method, path, query, body);
    return toResponse(result);
  } catch (e) {
    if (e instanceof DemoHttpError) return errorResponse(e.status, e.message);
    // Filet : jamais laisser une exception casser l'UI — 500 lisible.
    const msg = e instanceof Error ? e.message : 'Demo backend error';
    // eslint-disable-next-line no-console
    console.error('[demo] handler error on', method, path, e);
    return errorResponse(500, msg);
  }
}
