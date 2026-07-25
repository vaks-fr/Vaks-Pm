/**
 * Règles PURES des champs personnalisés (aucune I/O, aucune dépendance Nest) —
 * surface testée en vitest. Le service enveloppe ces fonctions pour lever des
 * `BadRequestException`.
 */

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox';

/** Normalise une liste d'options : trim, dédup insensible à la casse, ordre gardé. */
export function cleanOptions(options?: string[] | null): string[] {
  if (!options) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const t = String(o).trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/**
 * Une définition `select` est-elle valide ? (au moins une option après nettoyage).
 * Retourne un message d'erreur ou null.
 */
export function optionsError(type: string, options?: string[] | null): string | null {
  if (type === 'select' && cleanOptions(options).length === 0) {
    return 'Une liste déroulante requiert au moins une option.';
  }
  return null;
}

/**
 * La valeur (déjà trimmée, non vide) est-elle cohérente avec le type ?
 * Retourne un message d'erreur ou null.
 */
export function valueError(type: FieldType, options: string[], value: string): string | null {
  switch (type) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : `Valeur numérique invalide : « ${value} »`;
    case 'date':
      return isValidDate(value);
    case 'checkbox':
      return value === 'true' || value === 'false'
        ? null
        : 'La valeur d’une case à cocher doit être "true" ou "false".';
    case 'select':
      return options.includes(value) ? null : `« ${value} » n’est pas une option valide de ce champ.`;
    case 'text':
    default:
      return null;
  }
}

function isValidDate(value: string): string | null {
  return Number.isNaN(Date.parse(value)) ? `Date invalide : « ${value} »` : null;
}
