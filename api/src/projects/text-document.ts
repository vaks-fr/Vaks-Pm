/**
 * Dépôt de documents TEXTE dans l'espace projet (lot 3).
 *
 * Extrait du controller pour être testable, et étendu de l'**upsert par nom**.
 *
 * Le problème résolu : un agent qui veut mettre à jour une note de contexte doit
 * aujourd'hui connaître son `docId` (via un listing préalable). Sans lui, il
 * reposte la note — et l'espace documents accumule des homonymes qui dégradent
 * le contexte de tous les agents suivants. La description du tool MCP
 * l'avertissait déjà en langue naturelle ; rien ne l'empêchait côté serveur.
 *
 * Pourquoi un upsert plutôt qu'une chaîne de versions (`supersedesId`) : le
 * chemin de mise à jour existant (`replaceDocumentText`) réécrit DÉJÀ le même
 * objet S3, donc l'historique du contenu y est perdu. Versionner seulement la
 * création produirait « je mets à jour → je perds l'historique / je recrée → je
 * le garde », soit l'inverse de l'intention.
 *
 * Volontairement pur (aucune dépendance Nest/Prisma) : testable en isolation.
 */

/**
 * Plafond du dépôt **texte** (route JSON). Bien plus bas que les 25 Mo du
 * multipart : ici le contenu transite dans un corps JSON, qu'on ne veut pas
 * laisser gonfler — et un transcript ou une note n'a pas besoin de plus.
 */
export const MAX_TEXT_DOC_BYTES = 1024 * 1024;

/** Extensions acceptées pour un dépôt texte → type MIME. */
export const TEXT_DOC_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  html: 'text/html',
};

/**
 * Type MIME déduit de l'extension. On ne fait **pas** confiance à un mimeType
 * fourni par l'appelant : c'est l'extension qui décide, et seuls les types
 * texte sont ouverts par cette route.
 */
export function textMimeFor(name: string): string | null {
  const ext = name.trim().toLowerCase().split('.').pop() ?? '';
  return TEXT_DOC_MIME[ext] ?? null;
}

/** Sanitisation du nom de fichier — identique à la route multipart. */
export function sanitizeDocName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Stratégie en cas d'homonyme dans le dossier cible. */
export type OnDuplicate = 'replace' | 'create';

export interface ExistingDoc {
  id: string;
  filename: string;
  folderId: string | null;
  mimeType: string;
  uploadedAt: Date | string;
}

export interface DuplicateMatch {
  /** Document à réécrire. */
  target: ExistingDoc;
  /** Nombre TOTAL d'homonymes trouvés (≥ 1). > 1 = ménage à faire côté humain. */
  duplicates: number;
}

/** Un document texte est-il remplaçable par cette route ? */
function isTextDoc(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json';
}

/**
 * Cherche l'homonyme à remplacer dans le dossier cible.
 *
 * Règles :
 *  - comparaison du nom **insensible à la casse**, cohérente avec l'unicité des
 *    noms de dossiers entre frères (`assertFolderNameFree`) ;
 *  - le dossier discrimine : `notes.md` à la racine et `notes.md` dans un
 *    sous-dossier sont deux documents distincts ;
 *  - on ne remplace **jamais** un binaire (un `rapport.pdf` déposé en multipart
 *    ne doit pas être écrasé par une note texte homonyme) ;
 *  - plusieurs homonymes préexistants → on remplace **le plus récent** et on
 *    remonte le compte. On n'en supprime aucun automatiquement : ce serait
 *    destructif et sans retour en arrière.
 */
export function findDuplicateTextDoc(
  candidates: readonly ExistingDoc[],
  filename: string,
  folderId: string | null,
  onDuplicate: OnDuplicate = 'replace',
): DuplicateMatch | null {
  if (onDuplicate === 'create') return null;

  const wanted = sanitizeDocName(filename).toLowerCase();
  const matches = candidates.filter(
    (doc) =>
      (doc.folderId ?? null) === (folderId ?? null) &&
      doc.filename.toLowerCase() === wanted &&
      isTextDoc(doc.mimeType),
  );
  if (!matches.length) return null;

  const target = matches.reduce((newest, doc) =>
    new Date(doc.uploadedAt).getTime() >= new Date(newest.uploadedAt).getTime() ? doc : newest,
  );
  return { target, duplicates: matches.length };
}

/**
 * Dossier d'atterrissage par défaut d'une note de contexte déposée SANS
 * `folderId` : le dossier « Contexte IA » racine s'il est **unique**.
 *
 * Ambigu (plusieurs) ou inexistant (zéro) → racine, comportement historique. On
 * ne crée jamais de dossier automatiquement : un agent ne doit pas provoquer un
 * effet de bord invisible dans l'arborescence du PM.
 */
export function defaultContextFolderId(
  folders: readonly { id: string; parentId: string | null; aiContext?: boolean | null }[],
): string | null {
  const roots = folders.filter((f) => !f.parentId && f.aiContext === true);
  return roots.length === 1 ? roots[0].id : null;
}
