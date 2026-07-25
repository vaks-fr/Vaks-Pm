/**
 * Seam « source de fichiers » (provider-agnostic) : expose en LECTURE des
 * documents stockés hors de vaks-pm (SharePoint de la team provisionnée, plus
 * tard Google Drive, S3 générique, WebDAV…) comme contexte de travail des
 * agents IA. Proxy LIVE : on liste/lit à la demande et on sert le texte extrait,
 * jamais de copie dans S3.
 *
 * Un provider sait uniquement : se décrire (champs de config pour l'UI admin),
 * tester sa connexion, lister un dossier, et récupérer le blob d'un item. Tout
 * le reste (gates, cache, extraction de texte, audit, tenancy) est générique.
 *
 * SharePoint est la première implémentation ; ajouter Google Drive / S3 = écrire
 * une classe `FileSourceProvider` de plus + l'enregistrer dans la registry.
 * Mêmes structures de descripteur que le seam ticketing (réutilisées verbatim).
 */

/** Type d'un champ de config rendu par l'UI admin générique. */
export type ConnectorFieldType = 'text' | 'url' | 'password' | 'textarea' | 'multiselect' | 'select';

/** Descripteur d'un champ de config propre à une source. */
export interface ConnectorFieldDescriptor {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required: boolean;
  /** Secret → stocké chiffré dans `secretEnc`, jamais renvoyé à l'UI. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  helpUrl?: string;
  options?: { value: string; label: string }[];
  default?: string | string[];
  /**
   * Visibilité conditionnelle : le champ n'est rendu que si la config porte
   * `field === equals` (à défaut de valeur, on retombe sur le `default` du champ
   * référencé — un connecteur créé avant l'ajout du sélecteur reste cohérent).
   * Purement UI : le serveur ne s'en sert pas pour valider.
   */
  showIf?: { field: string; equals: string };
}

/** Carte d'identité d'un type de source, consommée par l'UI admin. */
export interface ProviderDescriptor {
  source: string; // 'sharepoint'
  label: string; // 'Microsoft SharePoint'
  blurb: string;
  accent?: string;
  short?: string;
  fields: ConnectorFieldDescriptor[];
  /**
   * `true` = la source n'utilise pas de connecteur chiffré (config/secret via
   * un autre canal, ex. SharePoint qui réutilise l'identité Graph du provisioning
   * Teams). L'UI affiche une carte de statut plutôt qu'un formulaire de secrets.
   */
  managedElsewhere?: boolean;
}

/** Résultat d'un test de connexion. */
export interface ConnectorTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

/** Un item de drive (fichier ou dossier), non persisté. */
export interface FileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  mimeType?: string;
  lastModified?: string;
  /** Lien sortant (webUrl) affiché à l'humain, jamais suivi côté serveur. */
  webUrl?: string;
}

/** Résultat paginé d'un listing de dossier. */
export interface FileListResult {
  items: FileEntry[];
  /** Curseur opaque pour la page suivante (wrap de `@odata.nextLink`), ou null. */
  nextCursor?: string | null;
}

/**
 * Contexte résolu par tenant, passé au provider à chaque opération live.
 * `config`/`secret` = pour les providers à connecteur (google/s3/webdav).
 * `project` = coordonnées de la source rattachée au projet courant (SharePoint :
 * site/drive de la team provisionnée). `orgId`/`projectId` pour le cache.
 */
export interface FileSourceContext {
  orgId: string;
  projectId: string;
  config: Record<string, unknown>;
  secret: Record<string, string>;
  project?: {
    msTeamId?: string | null;
    msTeamSiteId?: string | null;
    msTeamDriveId?: string | null;
    /**
     * Drive partagé Google provisionné pour ce projet (`ProjectCollabSpace`
     * provider `gdrive`). Quand il existe, il prime sur la racine org du
     * connecteur — un drive par projet, comme le site SharePoint d'une team.
     */
    gdriveId?: string | null;
  };
}

/** Le contrat source — volontairement étroit. */
export interface FileSourceProvider {
  readonly source: string;
  readonly label: string;
  describe(): ProviderDescriptor;
  testConnection(ctx: FileSourceContext): Promise<ConnectorTestResult>;
  /** Liste un dossier (racine si `folderId` absent), paginé. */
  list(ctx: FileSourceContext, opts: { folderId?: string; cursor?: string }): Promise<FileListResult>;
  /** Récupère le blob binaire + métadonnées d'un item (le texte est extrait par l'appelant). */
  fetch(ctx: FileSourceContext, itemId: string): Promise<{ meta: FileEntry; buffer: Buffer }>;
}

/**
 * Codes d'erreur machine renvoyés par les endpoints de lecture (champ `code`,
 * à la `BINARY_DOCUMENT` des context-documents). Le provider jette une
 * `FileSourceError` ; le controller la mappe en statut HTTP.
 */
export type FileSourceErrorCode =
  | 'FS_DISABLED'
  | 'FS_FORBIDDEN'
  | 'FS_SOURCE_UNAVAILABLE'
  | 'FS_GRANT_PENDING'
  | 'FS_ITEM_NOT_FOUND'
  | 'FS_FILE_TOO_LARGE'
  | 'FS_UNSUPPORTED_FORMAT'
  | 'FS_THROTTLED'
  | 'FS_AUTH_FAILED';

export class FileSourceError extends Error {
  constructor(
    readonly code: FileSourceErrorCode,
    message: string,
    /** Métadonnées optionnelles (item pour 413/415, retryAfter pour 429). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FileSourceError';
  }
}
