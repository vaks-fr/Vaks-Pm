/**
 * Seam fournisseur de ticketing (provider-agnostic). Un « provider » sait
 * uniquement : se décrire (champs de config pour l'UI admin), tester sa
 * connexion, et — plus tard — transformer une requête de recherche en liste de
 * tickets candidats. Tout le reste (stockage, idempotence, timesheet) est
 * générique et keyé sur `(source, key)`.
 *
 * ServiceNow est la première implémentation ; ajouter Jira/Zendesk = écrire une
 * classe `TicketProvider` de plus + l'enregistrer dans la registry. Aucun autre
 * fichier (endpoint, picker, upsert, schéma) ne change.
 */

/** Type d'un champ de config rendu par l'UI admin générique. */
export type ConnectorFieldType =
  | 'text'
  | 'url'
  | 'password'
  | 'textarea'
  | 'multiselect';

/** Descripteur d'un champ de config propre à un fournisseur. */
export interface ConnectorFieldDescriptor {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required: boolean;
  /** Secret → stocké chiffré dans `secretEnc`, jamais renvoyé à l'UI. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Lien de documentation externe affiché à côté de l'aide (ex. syntaxe de filtre). */
  helpUrl?: string;
  /** Options pour `multiselect`. */
  options?: { value: string; label: string }[];
  default?: string | string[];
}

/** Carte d'identité d'un type de fournisseur, consommée par l'UI admin. */
export interface ProviderDescriptor {
  source: string; // 'servicenow'
  label: string; // 'ServiceNow'
  blurb: string;
  /** Couleur de marque (hex) pour la tuile/logo de la carte « Select ». */
  accent?: string;
  /** Monogramme court (≤ 3 car.) affiché dans la tuile à défaut de logo. */
  short?: string;
  fields: ConnectorFieldDescriptor[];
}

/** Un ticket candidat renvoyé par une recherche (non persisté). */
export interface TicketCandidate {
  key: string; // INC0010023 / PROJ-123
  title: string;
  url?: string;
  status?: string;
  meta?: Record<string, string>;
}

/** Contexte résolu par tenant : config non-secrète + secrets déchiffrés. */
export interface ProviderContext {
  config: Record<string, unknown>;
  secret: Record<string, string>;
}

/** Requête de recherche générique (traduite par le provider en natif). */
export interface TicketSearchQuery {
  q: string;
  userEmail: string;
  limit: number;
}

/** Résultat d'un test de connexion. */
export interface ConnectorTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

/** Le contrat fournisseur — volontairement étroit. */
export interface TicketProvider {
  readonly source: string;
  readonly label: string;
  describe(): ProviderDescriptor;
  testConnection(ctx: ProviderContext): Promise<ConnectorTestResult>;
  /** Recherche live → candidats (implémentée à l'incrément suivant). */
  search?(ctx: ProviderContext, q: TicketSearchQuery): Promise<TicketCandidate[]>;
}
