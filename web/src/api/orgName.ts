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
  return useOrgBrand(fallback).name;
}

/**
 * Marque de l'organisation (nom + logo custom), lue depuis l'endpoint PUBLIC
 * `/public/branding/org`. Comme `useOrgName` mais expose aussi `logoUrl` — utile
 * sur l'écran de login (pas de token) pour afficher le logo client en tête.
 * `logoUrl` vide → l'UI retombe sur le BrandMark Vaks.
 */
export function useOrgBrand(fallback = 'Vaks'): { name: string; logoUrl: string } {
  const [brand, setBrand] = useState<{ name: string; logoUrl: string }>({
    name: DEMO ? 'Acme (démo)' : fallback,
    logoUrl: '',
  });
  useEffect(() => {
    if (DEMO) return; // pas de réseau en démo : la marque est figée.
    let alive = true;
    fetch('/api/v1/public/branding/org')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        setBrand({
          name: typeof j.name === 'string' && j.name ? j.name : fallback,
          logoUrl: typeof j.logoUrl === 'string' ? j.logoUrl : '',
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [fallback]);
  return brand;
}
