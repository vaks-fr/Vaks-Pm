/**
 * Providers CI signataires — logique **pure** (parsing + vérification HMAC),
 * sans DB ni I/O (AGENTS_VERIFICATION.md §9.2, phase C). Spec exécutable :
 * `__tests__/ci-providers.spec.ts`.
 *
 * Principe directeur (§0) : vaks-pm ne se connecte à AUCUN CI. La seule
 * opération « active » est la **vérification d'une signature HMAC** d'un payload
 * que la CI pousse — aucun accès sortant, juste un secret partagé configuré à
 * l'avance, connecteur par connecteur.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signataires supportés en phase C. */
export const CI_PROVIDERS = ['github', 'generic'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

export function isCiProvider(v: string | null | undefined): v is CiProvider {
  return !!v && (CI_PROVIDERS as readonly string[]).includes(v);
}

/** En-tête de signature attendu selon le provider (minuscule, comme Express). */
export function signatureHeaderFor(provider: CiProvider): string {
  return provider === 'github' ? 'x-hub-signature-256' : 'x-vaks-ci-signature';
}

/**
 * Vérifie la signature `sha256=<hex>` d'un payload brut contre le secret partagé.
 * Constant-time. Renvoie `false` sur tout format inattendu (jamais de throw).
 */
export function verifyCiSignature(
  secret: string | null | undefined,
  rawBody: Buffer | string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const m = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const provided = Buffer.from(m[1], 'hex');
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret).update(body).digest();
  // timingSafeEqual exige des buffers de même longueur.
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/** Résultat CI normalisé extrait d'un payload. */
export interface ParsedCiResult {
  commitSha: string;
  conclusion: 'success' | 'failure';
  runId: string | null;
  runUrl: string | null;
  /** Dépôt d'origine (ex. "owner/repo"), quand le payload le porte — sert à lier
   *  la preuve au projet du livrable (anti-réutilisation cross-dépôt). */
  repo: string | null;
}

/** Normalise un verdict CI hétérogène → success | failure. */
function normalizeConclusion(raw: unknown): 'success' | 'failure' {
  const s = String(raw ?? '').toLowerCase();
  return s === 'success' ? 'success' : 'failure';
}

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const asStr = (v: unknown): string | null =>
  typeof v === 'string' && v.length ? v : typeof v === 'number' ? String(v) : null;

/**
 * Extrait `{ commitSha, conclusion, runId?, runUrl? }` d'un payload CI. Renvoie
 * `null` si l'événement n'est pas un verdict terminal exploitable (ex.
 * workflow en cours, status `pending`, événement sans commit) — l'appelant
 * l'ignore silencieusement (202, pas d'erreur).
 *
 * GitHub : `workflow_run` / `check_suite` (`head_sha` + `conclusion`, uniquement
 * `completed`) et `status` (`sha` + `state`). Generic : `{ commitSha,
 * conclusion, runId?, runUrl? }` à plat.
 */
export function parseCiPayload(provider: CiProvider, body: unknown): ParsedCiResult | null {
  const b = asObj(body);
  if (!b) return null;

  if (provider === 'generic') {
    const commitSha = asStr(b.commitSha ?? b.commit_sha ?? b.sha);
    const conclusionRaw = b.conclusion ?? b.status ?? b.state;
    if (!commitSha || conclusionRaw == null) return null;
    return {
      commitSha,
      conclusion: normalizeConclusion(conclusionRaw),
      runId: asStr(b.runId ?? b.run_id),
      runUrl: asStr(b.runUrl ?? b.run_url),
      repo: asStr(b.repo ?? b.repository ?? b.repoFullName ?? b.repo_full_name),
    };
  }

  // github — le dépôt est au niveau racine du payload (identique aux 3 types
  // d'événement) : `repository.full_name` (ex. "owner/repo").
  const repo = asStr(asObj(b.repository)?.full_name);
  const wr = asObj(b.workflow_run);
  const cs = asObj(b.check_suite);
  if (wr) {
    // On n'agit que sur un run TERMINÉ (sinon conclusion est null).
    if (asStr(wr.status) && asStr(wr.status) !== 'completed') return null;
    const commitSha = asStr(wr.head_sha);
    if (!commitSha || wr.conclusion == null) return null;
    return {
      commitSha,
      conclusion: normalizeConclusion(wr.conclusion),
      runId: asStr(wr.id),
      runUrl: asStr(wr.html_url),
      repo,
    };
  }
  if (cs) {
    if (asStr(cs.status) && asStr(cs.status) !== 'completed') return null;
    const commitSha = asStr(cs.head_sha);
    if (!commitSha || cs.conclusion == null) return null;
    return { commitSha, conclusion: normalizeConclusion(cs.conclusion), runId: asStr(cs.id), runUrl: null, repo };
  }
  // `status` event : { sha, state, target_url }
  if (b.state != null && b.sha != null) {
    const state = String(b.state).toLowerCase();
    if (state === 'pending') return null; // pas encore terminal
    const commitSha = asStr(b.sha);
    if (!commitSha) return null;
    return {
      commitSha,
      conclusion: state === 'success' ? 'success' : 'failure',
      runId: null,
      runUrl: asStr(b.target_url),
      repo,
    };
  }
  return null;
}
