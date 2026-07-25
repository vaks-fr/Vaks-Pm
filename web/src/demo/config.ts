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
export const DEMO_STATE_VERSION = 5;

/** Clé localStorage du state sandbox. */
export const DEMO_STATE_KEY = 'vaks-demo-state';

/** Latence artificielle (ms) pour un rendu réaliste des chargements. */
export const DEMO_LATENCY_MS = 90;
