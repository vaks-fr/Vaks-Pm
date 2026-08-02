/**
 * Sorties structurées d'un livrable (lot B) — partie PURE (vitest).
 *
 * Problème résolu : une tâche aval devait relire tout le texte du livrable amont
 * (stocké sur S3) pour y retrouver deux ou trois variables — un endpoint, un
 * numéro de version, un nom de schéma. C'est exactement le genre de lecture où
 * un modèle invente. On offre donc un canal explicite : un dictionnaire PLAT
 * clé → scalaire, produit par l'auteur, relu tel quel par les tâches aval.
 *
 * Volontairement pauvre en types : pas d'objets imbriqués, pas de tableaux. Ce
 * canal transporte des *faits* (« l'API est là », « la version est celle-ci »),
 * pas des documents — le document, c'est le livrable. Une structure profonde
 * finirait par être re-parsée, donc par ré-ouvrir le problème qu'on ferme ici.
 */

/** Valeur admise : scalaire uniquement. `null` = « je sais que c'est vide ». */
export type StructuredOutputValue = string | number | boolean | null;
export type StructuredOutputs = Record<string, StructuredOutputValue>;

export const MAX_OUTPUT_KEYS = 50;
export const MAX_KEY_LENGTH = 64;
export const MAX_VALUE_LENGTH = 2000;
/** Plafond global sérialisé — borne ce qui repartira dans CHAQUE work-context aval. */
export const MAX_OUTPUTS_BYTES = 16 * 1024;

/** Clé exploitable par une machine : lettres/chiffres/`_`/`-`/`.`, pas d'espace. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class StructuredOutputsError extends Error {}

/**
 * Valide et normalise un dictionnaire de sorties. Lève `StructuredOutputsError`
 * avec un message actionnable (l'agent doit pouvoir se corriger seul) plutôt que
 * de rogner silencieusement — une sortie tronquée sans le dire vaut moins que
 * pas de sortie du tout.
 *
 * `undefined`/`null` → `null` (le champ n'est pas fourni) ; `{}` → `null` aussi
 * (un dictionnaire vide n'a rien à transmettre).
 */
export function normalizeStructuredOutputs(raw: unknown): StructuredOutputs | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StructuredOutputsError(
      'structuredOutputs doit être un objet plat { clé: valeur } (pas un tableau).',
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length > MAX_OUTPUT_KEYS) {
    throw new StructuredOutputsError(
      `structuredOutputs : ${entries.length} clés (maximum ${MAX_OUTPUT_KEYS}).`,
    );
  }

  const out: StructuredOutputs = {};
  for (const [key, value] of entries) {
    const k = key.trim();
    if (!k || k.length > MAX_KEY_LENGTH || !KEY_RE.test(k)) {
      throw new StructuredOutputsError(
        `structuredOutputs : clé invalide « ${key.slice(0, 80)} » (lettres, chiffres, . _ - ; ${MAX_KEY_LENGTH} caractères max).`,
      );
    }
    if (value === null) {
      out[k] = null;
    } else if (typeof value === 'boolean') {
      out[k] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new StructuredOutputsError(`structuredOutputs : « ${k} » n'est pas un nombre fini.`);
      }
      out[k] = value;
    } else if (typeof value === 'string') {
      if (value.length > MAX_VALUE_LENGTH) {
        throw new StructuredOutputsError(
          `structuredOutputs : « ${k} » dépasse ${MAX_VALUE_LENGTH} caractères. Ce canal transporte des valeurs, pas des documents — mettez le contenu dans le livrable.`,
        );
      }
      out[k] = value;
    } else {
      throw new StructuredOutputsError(
        `structuredOutputs : « ${k} » doit être une chaîne, un nombre, un booléen ou null (pas d'objet ni de tableau imbriqué).`,
      );
    }
  }

  const size = Buffer.byteLength(JSON.stringify(out), 'utf-8');
  if (size > MAX_OUTPUTS_BYTES) {
    throw new StructuredOutputsError(
      `structuredOutputs : ${size} octets (maximum ${MAX_OUTPUTS_BYTES}).`,
    );
  }
  return out;
}

/** Relecture défensive de ce qui a été stocké (colonne Json librement typée). */
export function readStructuredOutputs(raw: unknown): StructuredOutputs | null {
  try {
    return normalizeStructuredOutputs(raw);
  } catch {
    return null;
  }
}
