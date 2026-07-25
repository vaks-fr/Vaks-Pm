/* ============================================================
   Primitives connecteurs — état d'édition (draft) partagé.
   Fonctions pures (testables) extraites de TicketingConnectorsSection :
   création d'un draft vierge depuis un descripteur, hydratation depuis
   un connecteur existant, sérialisation en payload (secrets envoyés
   seulement si non vides = « conserver l'actuel » en édition).
   ============================================================ */
import type { NormalizedProvider } from './types';

/** État d'édition d'un connecteur (création ou édition). */
export interface DraftState {
  id: string | null; // null = création
  /** Clé du provider (source / provider / id selon la famille). */
  providerKey: string;
  label: string;
  enabled: boolean;
  /** Valeurs des champs non secrets. */
  config: Record<string, unknown>;
  /** Valeurs des champs secrets saisies (vide = inchangé en édition). */
  secrets: Record<string, string>;
  /** Champs secrets déjà renseignés côté serveur. */
  secretsConfigured: string[];
}

export function emptyDraftFor(desc: NormalizedProvider, opts?: { enabled?: boolean }): DraftState {
  const config: Record<string, unknown> = {};
  for (const f of desc.fields) {
    if (f.secret) continue;
    if (f.type === 'multiselect') config[f.key] = Array.isArray(f.default) ? f.default : [];
    else if (f.default != null) config[f.key] = f.default;
  }
  return {
    id: null,
    providerKey: desc.key,
    label: desc.label,
    enabled: opts?.enabled ?? false,
    config,
    secrets: {},
    secretsConfigured: [],
  };
}

/** Hydrate un draft depuis un connecteur existant (forme commune aux 3 familles). */
export function draftFromExisting(c: {
  id: string;
  label: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  secretsConfigured?: string[];
}, providerKey: string): DraftState {
  return {
    id: c.id,
    providerKey,
    label: c.label,
    enabled: c.enabled,
    config: { ...(c.config ?? {}) },
    secrets: {},
    secretsConfigured: c.secretsConfigured ?? [],
  };
}

/**
 * Cœur commun du payload : label, enabled, config, et les secrets NON vides
 * uniquement (vide = conserver la valeur actuelle côté serveur). Chaque section
 * y ajoute ses spécificités (clé provider à la création, defaultOwnerId, …).
 */
export function draftToPayload(d: DraftState): {
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.secrets)) if (v.trim()) secrets[k] = v.trim();
  return {
    label: d.label,
    enabled: d.enabled,
    config: d.config,
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
}
