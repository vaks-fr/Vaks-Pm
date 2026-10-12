/* ============================================================
   Vaks — Démo statique 100% navigateur : configuration du mode.
   ----------------------------------------------------------------
   `DEMO` est un flag de BUILD (constant folding Vite) : en build normal
   il vaut `false` → tout le code du dossier `demo/` (importé dynamiquement
   ou derrière `if (DEMO)`) est tree-shaké, zéro impact sur le bundle prod.
   Activé via `.env.demo` (`VITE_DEMO=1`) chargé par `vite --mode demo`.
   ============================================================ */

/** Vrai uniquement dans le build démo (`vite build --mode demo`). */
export const DEMO: boolean = import.meta.env.VITE_DEMO === '1';

/** Version du schéma de state persisté en localStorage. Bumper invalide le
 *  cache visiteur (re-seed propre) quand la forme du store change. */
export const DEMO_STATE_VERSION = 7;

/** Clé localStorage du state sandbox. */
export const DEMO_STATE_KEY = 'vaks-demo-state';

/** Latence artificielle (ms) pour un rendu réaliste des chargements. */
export const DEMO_LATENCY_MS = 90;

/** Clé localStorage mémorisant la langue choisie à l'entrée dans la démo. */
export const DEMO_LANG_KEY = 'vaks-demo-lang';

const DEMO_SUPPORTED_LANGS = ['en', 'fr', 'it', 'de'] as const;

/** Locale de formatage (BCP47) dérivée de la langue de la démo. */
export const DEMO_LOCALE_BY_LANG: Record<string, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  it: 'it-IT',
  de: 'de-DE',
};

/**
 * Langue d'entrée de la démo, dérivée du site d'origine. Le lien « Démo live »
 * du site vitrine porte `?lang=fr|en|…` selon la langue de la page ; on la
 * mémorise en localStorage pour qu'elle survive à la navigation interne (SPA,
 * plus de query string). Retourne `null` si aucun indice → le mock garde son
 * défaut et `resolveLanguage` peut retomber sur la détection navigateur.
 */
export function resolveDemoLanguage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q && (DEMO_SUPPORTED_LANGS as readonly string[]).includes(q)) {
      window.localStorage.setItem(DEMO_LANG_KEY, q);
      return q;
    }
    const stored = window.localStorage.getItem(DEMO_LANG_KEY);
    if (stored && (DEMO_SUPPORTED_LANGS as readonly string[]).includes(stored)) return stored;
  } catch {
    // localStorage indisponible (mode privé strict) → pas d'indice.
  }
  return null;
}
