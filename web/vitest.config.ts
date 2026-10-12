import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

/**
 * Vitest config for the web test suite (logique pure uniquement — pas de
 * composants). Reprend l'alias `@vaks-pm/shared` du `vite.config.ts` de dev :
 * résout vers la SOURCE TS (pas `dist/`) pour éviter un dist périmé/absent et
 * l'interop CJS/ESM. `environment: 'node'` par défaut — une future spec qui
 * touche le DOM l'annule localement via `// @vitest-environment jsdom`
 * (nécessite alors d'ajouter `jsdom` aux devDeps, pas fait ici : aucune spec
 * de cette slice n'en a besoin).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@vaks-pm/shared': fileURLToPath(
        new URL('../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
