/* ============================================================
   Vaks — Axe « langue d'interface » (distinct de la locale de formatage)
   ----------------------------------------------------------------
   `orgSettings.locale` (BCP47, ex. "fr-FR") pilote UNIQUEMENT le
   formatage dates/nombres (`useFormat`). La langue de l'UI (quel
   fichier de traduction charger) est un axe SÉPARÉ : seul le
   sous-tag de langue compte ("fr-FR" → "fr").
   ============================================================ */

export const SUPPORTED_LANGUAGES = ['en', 'fr', 'it', 'de'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Langue de repli universelle. */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export function isSupportedLanguage(x: unknown): x is SupportedLanguage {
  return typeof x === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(x);
}

/** "fr-FR" → "fr" ; langue non supportée (ex. "es") → null. */
export function languageFromLocale(locale: string | undefined | null): SupportedLanguage | null {
  if (!locale) return null;
  const sub = locale.toLowerCase().split('-')[0];
  return isSupportedLanguage(sub) ? sub : null;
}
