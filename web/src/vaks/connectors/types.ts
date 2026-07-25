/* ============================================================
   Primitives connecteurs — modèle normalisé.
   Les trois familles de connecteurs (ticketing, annuaires d'agents,
   CI) exposent des descripteurs de providers presque identiques mais
   keyés différemment (`source` / `provider` / `id`). On normalise ici
   vers un modèle unique consommé par le picker, la carte et le
   formulaire partagés — les APIs serveur ne changent pas.
   ============================================================ */
import type { ConnectorFieldDescriptorDto, ConnectorProviderDescriptorDto } from '@vaks-pm/shared';

/**
 * Types de champ élargis. `toggle` / `segmented` / `select` n'existent pas dans
 * le DTO API (`ConnectorFieldType`) : ils servent aux providers décrits côté
 * UI uniquement (ex. la section Collaboration spaces) — aucun changement API.
 */
export type NormalizedFieldType =
  | 'text'
  | 'url'
  | 'password'
  | 'textarea'
  | 'multiselect'
  | 'toggle'
  | 'segmented'
  | 'select';

export interface NormalizedField extends Omit<ConnectorFieldDescriptorDto, 'type' | 'default'> {
  type: NormalizedFieldType;
  default?: string | string[] | boolean;
  /**
   * Masque le champ selon l'état courant du draft (ex. clé de compte de service
   * inutile en mode Workload Identity). Reçoit les valeurs non-secrètes saisies.
   */
  hidden?: (config: Record<string, unknown>) => boolean;
}

/** Descripteur de provider normalisé (clé unifiée quel que soit le backend). */
export interface NormalizedProvider {
  /** Clé stable du provider : `source` (ticketing), `provider` (agents), `id` (CI). */
  key: string;
  label: string;
  blurb?: string;
  /** Couleur de marque (hex) pour la tuile monogramme. */
  accent?: string;
  /** Monogramme court (≤ 3 car.) à défaut de wordmark. */
  short?: string;
  fields: NormalizedField[];
  /** Données spécifiques au domaine (ex. `signatureHeader` des connecteurs CI). */
  meta?: Record<string, unknown>;
}

/** Descripteur provider des annuaires d'agents (`GET /admin/agent-connectors/providers`). */
export interface AgentProviderDescriptorDto {
  provider: string;
  label: string;
  blurb: string;
  accent?: string;
  short?: string;
  fields: ConnectorFieldDescriptorDto[];
}

/** Descripteur provider CI (`GET` providers CI — minimal, sans champs de config). */
export interface CiProviderDescriptorDto {
  id: string;
  label: string;
  signatureHeader: string;
}

export function fromTicketingProvider(p: ConnectorProviderDescriptorDto): NormalizedProvider {
  return { key: p.source, label: p.label, blurb: p.blurb, accent: p.accent, short: p.short, fields: p.fields };
}

/** Descripteur d'une source de fichiers (`.../filesource-connectors/providers`). */
export function fromFileSourceProvider(
  p: ConnectorProviderDescriptorDto & { managedElsewhere?: boolean },
): NormalizedProvider {
  return {
    key: p.source,
    label: p.label,
    blurb: p.blurb,
    accent: p.accent,
    short: p.short,
    fields: p.fields,
    meta: { managedElsewhere: !!p.managedElsewhere },
  };
}

export function fromAgentProvider(p: AgentProviderDescriptorDto): NormalizedProvider {
  return { key: p.provider, label: p.label, blurb: p.blurb, accent: p.accent, short: p.short, fields: p.fields };
}

/**
 * Les providers CI n'exposent pas de descripteurs de champs : on synthétise
 * l'unique champ secret HMAC (write-only) et on transporte `signatureHeader`
 * en `meta` pour l'affichage de la carte.
 */
export function fromCiProvider(
  p: CiProviderDescriptorDto,
  labels: { secretLabel: string; secretHelp?: string; secretPlaceholder?: string },
): NormalizedProvider {
  return {
    key: p.id,
    label: p.label,
    fields: [
      {
        key: 'secret',
        label: labels.secretLabel,
        type: 'password',
        required: true,
        secret: true,
        placeholder: labels.secretPlaceholder,
        help: labels.secretHelp,
      },
    ],
    meta: { signatureHeader: p.signatureHeader },
  };
}
