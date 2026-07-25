/**
 * Seam annuaire d'agents IA (provider-agnostic) — AGENTS_ARCHITECTURE.md
 * chantier 1. Un « provider » sait uniquement : se décrire (champs de config
 * pour l'UI admin), tester sa connexion, et énumérer les identités d'agents de
 * la plateforme. Tout le reste (upsert vaks, owner, jetons, audit) est
 * générique et keyé sur `(idpSource, externalId)`.
 *
 * Entra Agent ID est la première implémentation ; ajouter Bedrock AgentCore /
 * Vertex AI = écrire une classe `AgentDirectoryProvider` de plus + l'enregistrer
 * dans la registry. Il n'existe PAS de « SCIM agents » standard.
 */
import type {
  ConnectorFieldDescriptor,
  ConnectorTestResult,
  ProviderContext,
} from '../ticketing/ticket-provider.types';

export type { ConnectorFieldDescriptor, ConnectorTestResult, ProviderContext };

/** Carte d'identité d'un type de plateforme d'agents, consommée par l'UI admin. */
export interface AgentProviderDescriptor {
  /** Slug du provider ('entra-agent', …). == idpSource des agents importés. */
  provider: string;
  label: string;
  blurb: string;
  accent?: string;
  short?: string;
  fields: ConnectorFieldDescriptor[];
}

/** Une identité d'agent énumérée sur la plateforme distante (non persistée). */
export interface RemoteAgent {
  /** Clé stable côté plateforme (object ID Entra, ARN Bedrock, resource name Vertex). */
  externalId: string;
  displayName: string;
  /** Compte actif côté plateforme ; false ⇒ suspension vaks (jamais de suppression). */
  enabled: boolean;
  /** Email/UPN de l'owner natif si la plateforme en expose un (Entra : owner/sponsor). */
  ownerEmail?: string;
  /** Profil modèle si connu de la plateforme. */
  modelProvider?: string;
  model?: string;
}

/** Le contrat provider — volontairement étroit. */
export interface AgentDirectoryProvider {
  readonly provider: string;
  readonly label: string;
  describe(): AgentProviderDescriptor;
  testConnection(ctx: ProviderContext): Promise<ConnectorTestResult>;
  /** Énumère les identités d'agents (bornée côté impl — pas de pagination infinie). */
  listAgents(ctx: ProviderContext): Promise<RemoteAgent[]>;
}
