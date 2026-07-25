import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import fs from 'fs';

// HTTPS optionnel : si un cert auto-signé est monté dans ./certs (cas de la
// démo, pour éviter l'avertissement navigateur "mot de passe en HTTP"), Vite
// sert en TLS. Sinon, on reste en HTTP simple (dev local inchangé).
const certDir = fileURLToPath(new URL('./certs', import.meta.url));
const keyPath = `${certDir}/server.key`;
const certPath = `${certDir}/server.crt`;
const https =
  fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Sépare les dépendances tierces stables dans leurs propres chunks (cache
        // navigateur longue durée, invalidés seulement quand la lib bouge). Vite 8
        // utilise Rolldown → `manualChunks` doit être une FONCTION (la forme objet
        // lève « manualChunks is not a function »).
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-router')) return 'vendor-react';
          if (id.includes('react-dom') || /[\\/]react[\\/]/.test(id) || /[\\/]scheduler[\\/]/.test(id))
            return 'vendor-react';
          if (id.includes('i18next')) return 'vendor-i18n';
          if (id.includes('socket.io') || id.includes('engine.io')) return 'vendor-realtime';
          if (id.includes('@dnd-kit')) return 'vendor-dnd';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      // Résout @vaks-pm/shared vers la source TS pour éviter l'interop CJS/ESM
      // (Rollup ne déduit pas toujours les exports nommés depuis un dist CJS).
      '@vaks-pm/shared': fileURLToPath(
        new URL('../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: true,
    port: 5173,
    https,
    // Multi-tenant : on sert sous des sous-domaines forgés (ex. demo.vaks-pm.com)
    // → autoriser tous les hosts.
    allowedHosts: true,
    // Dev multi-host : le HMR (ws) ne se connecte pas de façon fiable derrière
    // un sous-domaine forgé → on le désactive (recharger la page manuellement).
    hmr: false,
    proxy: {
      // En dev, l'app appelle /api et Vite proxy vers le conteneur api.
      // changeOrigin DOIT rester false : le backend (mode pooled) résout le
      // tenant depuis le header Host (<slug>.<baseDomain>) — le réécrire
      // casserait la résolution ("Organisation introuvable pour ce domaine").
      '/api': { target: 'http://api:3000', changeOrigin: false },
      // Temps réel (socket.io) : préserver le Host pour le routing tenant.
      '/socket.io': { target: 'http://api:3000', changeOrigin: false, ws: true },
      '/ws': { target: 'http://api:3000', changeOrigin: false, ws: true },
    },
  },
});
