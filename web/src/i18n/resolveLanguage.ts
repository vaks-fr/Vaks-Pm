/* ============================================================
   Vaks — Résolution de la langue d'interface
   ----------------------------------------------------------------
   Ordre canonique (identique côté serveur pour les emails) :
     user.preferredLanguage
       > org i18n.defaultLanguage
       > languageFromLocale(orgSettings.locale)
       > détection navigateur
       > 'en'
   La liste `enabledLanguages` (configurée par l'admin) restreint les
   candidats : une langue non activée est ignorée.
   ============================================================ */
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  isSupportedLanguage,
  languageFromLocale,
} from './languageFromLocale';

export interface LanguageInputs {
  /** Préférence explicite de l'utilisateur (profil). */
  userPreferred?: string | null;
  /** Langue par défaut de l'org (`OrgSetting i18n.defaultLanguage`). */
  orgDefault?: string | null;
  /** Locale de formatage de l'org (BCP47) — on en dérive la langue. */
  orgLocale?: string | null;
  /** Langues activées par l'admin ; vide/absent → toutes les supportées. */
  enabledLanguages?: string[] | null;
}

function detectBrowser(): SupportedLanguage[] {
  if (typeof navigator === 'undefined') return [];
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  return list
    .map((l) => languageFromLocale(l))
    .filter((x): x is SupportedLanguage => x !== null);
}

export function resolveLanguage(inp: LanguageInputs): SupportedLanguage {
  const enabled = (inp.enabledLanguages ?? []).filter(isSupportedLanguage);
  const allowed: SupportedLanguage[] = enabled.length ? enabled : [...SUPPORTED_LANGUAGES];

  const pick = (cand: string | null | undefined): SupportedLanguage | null =>
    isSupportedLanguage(cand) && allowed.includes(cand) ? cand : null;

  const candidates: Array<SupportedLanguage | null> = [
    pick(inp.userPreferred),
    pick(inp.orgDefault),
    pick(languageFromLocale(inp.orgLocale)),
    ...detectBrowser().map(pick),
  ];

  for (const c of candidates) if (c) return c;
  return allowed.includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : allowed[0];
}
