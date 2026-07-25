import { useEffect, useState } from 'react';
import { DEMO } from '../demo/config';

/**
 * Nom d'affichage de l'organisation, lu depuis l'endpoint PUBLIC
 * `/public/branding/org` (setting `orgName` éditable, fallback `Organization.name`).
 * Public → utilisable aussi sur l'écran de login (pas de token).
 * Multi-tenant : l'org est résolue côté serveur par le `Host` du sous-domaine.
 *
 * Fetch au montage du composant ; un rechargement de page reflète tout
 * changement fait dans l'admin (Organization name).
 */
export function useOrgName(fallback = 'Vaks'): string {
  const [name, setName] = useState(DEMO ? 'Acme (démo)' : fallback);
  useEffect(() => {
    if (DEMO) return; // pas de réseau en démo : le nom d'org est figé.
    let alive = true;
    fetch('/api/v1/public/branding/org')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && typeof j.name === 'string' && j.name) setName(j.name);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return name;
}
