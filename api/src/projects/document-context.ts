/**
 * Exposition « Contexte IA » de l'espace documents d'un projet (lot 3).
 *
 * Avant : un booléen `aiContext` par FICHIER. Les notes de contexte se
 * mélangeaient aux offres et aux pièces jointes, et il fallait cocher chaque
 * document un par un.
 *
 * Maintenant : on peut marquer un DOSSIER, et l'exposition devient une UNION —
 * `doc.aiContext` **ou** « le document est dans un dossier IA (ou l'un de ses
 * descendants) ».
 *
 * L'héritage est **calculé à la lecture, jamais dénormalisé**. La raison est
 * `deleteFolder` : il remonte documents ET sous-dossiers au parent en une
 * transaction. Avec un drapeau effectif stocké, il faudrait recalculer tout le
 * sous-arbre déplacé là, plus dans `updateFolder`, plus au basculement du
 * drapeau — trois chemins d'écriture à garder synchrones sur un `parentId`
 * scalaire SANS clé étrangère, où la donnée peut déjà être orpheline. Calculé
 * à la lecture, le résultat est juste par construction.
 *
 * Volontairement pur (aucune dépendance Nest/Prisma) : testable en isolation.
 */

/** Forme minimale d'un dossier pour le calcul (liste plate, comme `listFolders`). */
export interface FolderNode {
  id: string;
  parentId: string | null;
  aiContext?: boolean | null;
}

/**
 * Identifiants des dossiers EFFECTIVEMENT « contexte IA » : ceux marqués, plus
 * toute leur descendance.
 *
 * Implémenté en parcours en largeur sur une table d'adjacence construite en
 * mémoire — pas de récursion SQL, pas de N+1 : un projet a des dizaines de
 * dossiers, pas des dizaines de milliers.
 *
 * Robuste aux données abîmées, ce que le modèle autorise (`parentId` est un
 * scalaire sans FK) :
 *  - un cycle `A → B → A` termine (chaque nœud n'est visité qu'une fois) ;
 *  - un `parentId` orphelin est traité comme une racine (le dossier existe, son
 *    parent a disparu) — il n'hérite de rien mais reste marquable lui-même.
 */
export function effectiveAiFolderIds(folders: readonly FolderNode[]): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const siblings = childrenByParent.get(folder.parentId);
    if (siblings) siblings.push(folder.id);
    else childrenByParent.set(folder.parentId, [folder.id]);
  }

  const effective = new Set<string>();
  const queue: string[] = folders.filter((f) => f.aiContext === true).map((f) => f.id);
  for (const id of queue) effective.add(id);

  // File d'attente parcourue par index : `queue` grandit pendant l'itération.
  for (let i = 0; i < queue.length; i += 1) {
    for (const childId of childrenByParent.get(queue[i]) ?? []) {
      if (effective.has(childId)) continue; // déjà vu → coupe les cycles
      effective.add(childId);
      queue.push(childId);
    }
  }

  return effective;
}

/** Un document est-il exposé aux agents ? (drapeau propre OU dossier hérité) */
export function isDocumentAiContext(
  doc: { aiContext?: boolean | null; folderId?: string | null },
  aiFolderIds: ReadonlySet<string>,
): boolean {
  if (doc.aiContext === true) return true;
  return !!doc.folderId && aiFolderIds.has(doc.folderId);
}

/** D'où vient l'exposition — sert à afficher « hérité » et à griser le toggle. */
export function documentAiSource(
  doc: { aiContext?: boolean | null; folderId?: string | null },
  aiFolderIds: ReadonlySet<string>,
): 'own' | 'folder' | null {
  if (doc.aiContext === true) return 'own';
  if (doc.folderId && aiFolderIds.has(doc.folderId)) return 'folder';
  return null;
}

/**
 * Date de fraîcheur d'un document : dernière réécriture du CONTENU si elle a eu
 * lieu, sinon le dépôt initial.
 *
 * Corrige au passage un mensonge de l'ancien modèle : `replaceDocumentText` ne
 * touchait que `sizeBytes`, donc une note mise à jour affichait encore la date
 * de son premier dépôt.
 */
export function resolveDocFreshness(doc: {
  uploadedAt: Date | string;
  contentUpdatedAt?: Date | string | null;
}): Date {
  const fresh = doc.contentUpdatedAt ? new Date(doc.contentUpdatedAt) : null;
  if (fresh && !Number.isNaN(fresh.getTime())) return fresh;
  return new Date(doc.uploadedAt);
}
