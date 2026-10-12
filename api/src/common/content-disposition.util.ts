/**
 * Construit une valeur d'en-tête `Content-Disposition` sûre pour un nom de
 * fichier quelconque, **y compris avec des caractères non-ASCII** (accents,
 * emoji, cyrillique…).
 *
 * Le piège résolu : Node rejette toute valeur d'en-tête HTTP hors ISO-8859-1
 * (`TypeError [ERR_INVALID_CHAR]`). Un `filename="rétro.md"` posé brut faisait
 * donc crasher la route de download en 500. La parade normalisée (RFC 6266
 * §4.1 + RFC 5987) : émettre DEUX paramètres —
 *   - `filename="..."`  : repli ASCII pur pour les vieux clients ;
 *   - `filename*=UTF-8''...` : nom réel, chaque octet non sûr percent-encodé.
 * Les clients récents (tous les navigateurs actuels) préfèrent `filename*` et
 * restituent l'accent ; les autres retombent sur l'ASCII.
 */

/**
 * Percent-encode conforme RFC 5987. `encodeURIComponent` couvre déjà tout le
 * non-ASCII ; on encode EN PLUS `!'()*` qu'il laisse passer mais que la grammaire
 * `filename*` interdit. Sur-encoder est toujours valide, donc on ne cherche pas
 * à préserver les `attr-char` optionnels (`^` `|` `~`…).
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Repli ASCII : on remplace tout octet hors [0x20–0x7E] (et les guillemets /
 * antislash qui casseraient le quoting) par `_`. Jamais vide.
 */
function asciiFallback(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').trim();
  return ascii || 'download';
}

/**
 * @param filename nom réel du fichier (peut contenir n'importe quel caractère).
 * @param disposition `attachment` (téléchargement) ou `inline` (aperçu navigateur).
 */
export function contentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const fallback = asciiFallback(filename);
  const encoded = encodeRfc5987(filename);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
