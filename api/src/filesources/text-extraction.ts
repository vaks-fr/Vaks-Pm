import { FileSourceError } from './file-source-provider.types';

/**
 * Extraction de texte des documents servis aux agents IA. Sortie plafonnée
 * (comme `getContextDocument`) : les agents reçoivent du texte exploitable, pas
 * le binaire. Formats bureautiques courants supportés ; le reste renvoie
 * `FS_UNSUPPORTED_FORMAT` (métadonnées seules).
 *
 * Les libs lourdes (mammoth, pdf-parse) sont importées en **lazy** pour ne pas
 * alourdir le démarrage de l'API. exceljs est déjà une dép (exports XLSX).
 */

/** Cap de la sortie texte (identique au précédent context-documents). */
export const TEXT_CAP_BYTES = 64 * 1024;
/** Cap de la taille du fichier téléchargé/extrait (borne le coût CPU/mémoire). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Cap du nombre de lignes lues d'un classeur avant le cap texte. */
const XLSX_ROW_CAP = 2000;

/** Vrai si le type/nom correspond à du texte lisible tel quel. */
export function isTextLike(mimeType: string, filename: string): boolean {
  const mt = mimeType.toLowerCase();
  // Les types OOXML (docx/xlsx/pptx) contiennent « xml » dans « openxmlformats » —
  // ce ne sont PAS du texte : on les exclut avant le test de sous-chaîne.
  if (/officedocument|ms-?word|ms-?excel|ms-?powerpoint|application\/pdf/.test(mt)) return false;
  return (
    /^text\//.test(mt) ||
    /^application\/(json|xml|.*\+xml|x-yaml|yaml|.*\+yaml|javascript|.*\+json)$/.test(mt) ||
    /\.(md|markdown|txt|csv|json|log|yml|yaml|xml|html?|ts|js)$/i.test(filename)
  );
}

/** Extension basse-casse (sans point) d'un nom de fichier, ou ''. */
function ext(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Extrait le texte d'un blob selon son type. Renvoie `{ content, truncated }`
 * (content déjà plafonné à `TEXT_CAP_BYTES`). Jette `FileSourceError` :
 *  - `FS_FILE_TOO_LARGE` si le buffer dépasse `MAX_FILE_BYTES` ;
 *  - `FS_UNSUPPORTED_FORMAT` si aucun extracteur ne convient.
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ content: string; truncated: boolean }> {
  if (buffer.length > MAX_FILE_BYTES) {
    throw new FileSourceError('FS_FILE_TOO_LARGE', 'Fichier trop volumineux pour l’extraction de texte.', {
      sizeBytes: buffer.length,
      maxBytes: MAX_FILE_BYTES,
    });
  }

  const e = ext(filename);
  let raw: string;

  if (isTextLike(mimeType, filename)) {
    raw = buffer.toString('utf-8');
  } else if (e === 'docx' || /officedocument\.wordprocessingml/.test(mimeType)) {
    raw = await extractDocx(buffer);
  } else if (e === 'xlsx' || /officedocument\.spreadsheetml/.test(mimeType)) {
    raw = await extractXlsx(buffer);
  } else if (e === 'pdf' || /application\/pdf/.test(mimeType)) {
    raw = await extractPdf(buffer);
  } else {
    throw new FileSourceError('FS_UNSUPPORTED_FORMAT', 'Type de document non lisible en texte.', {
      mimeType,
      filename,
    });
  }

  return capText(raw);
}

/** Plafonne le texte à `TEXT_CAP_BYTES` (octets UTF-8), flag `truncated`. */
export function capText(raw: string): { content: string; truncated: boolean } {
  const buf = Buffer.from(raw, 'utf-8');
  if (buf.length <= TEXT_CAP_BYTES) return { content: raw, truncated: false };
  // Coupe à la frontière d'octet ; on retire un éventuel caractère multi-octet tronqué.
  const content = buf.subarray(0, TEXT_CAP_BYTES).toString('utf-8').replace(/�+$/, '');
  return { content, truncated: true };
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return value ?? '';
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // Import du lib interne (pas de l'index) : l'index de pdf-parse exécute un bloc
  // « debug » qui lit un PDF de test si `!module.parent` — à éviter.
  const mod = (await import('pdf-parse/lib/pdf-parse.js')) as any;
  const pdfParse = mod.default ?? mod;
  const data = await pdfParse(buffer);
  return data?.text ?? '';
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new (ExcelJS as any).Workbook();
  await wb.xlsx.load(buffer);
  const lines: string[] = [];
  let rows = 0;
  for (const ws of wb.worksheets) {
    lines.push(`# ${ws.name}`);
    // eslint-disable-next-line @typescript-eslint/no-loop-func
    ws.eachRow({ includeEmpty: false }, (row: any) => {
      if (rows >= XLSX_ROW_CAP) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        const v = cell?.text ?? cell?.value ?? '';
        cells.push(v == null ? '' : String(v));
      });
      lines.push(cells.join('\t'));
      rows++;
    });
    if (rows >= XLSX_ROW_CAP) {
      lines.push('… (classeur tronqué)');
      break;
    }
  }
  return lines.join('\n');
}
