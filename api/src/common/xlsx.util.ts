import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { neutralizeFormula } from './csv.util';

/** Une feuille du classeur : en-têtes + lignes (matrice, comme le CSV). */
export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: unknown[][];
  /** Largeurs de colonnes forcées (sinon auto d'après le contenu). */
  widths?: number[];
}

const HEADER_FILL = 'FF1E293B'; // slate-800
const HEADER_FONT = 'FFFFFFFF';
const ZEBRA_FILL = 'FFF1F5F9'; // slate-100

/** Nettoie un nom de feuille (Excel : ≤31 chars, sans `[]:*?/\`). */
function safeSheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

/**
 * Construit un classeur XLSX stylé (en-tête sombre figé, autofilter, zébrures,
 * largeurs auto, format nombre sur les colonnes numériques). Renvoie un Buffer.
 */
export async function buildXlsx(
  sheets: XlsxSheet[],
  meta?: { creator?: string; title?: string },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta?.creator ?? 'Vaks PM';
  wb.created = new Date();
  if (meta?.title) wb.title = meta.title;

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(safeSheetName(sheet.name), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const headerRow = ws.addRow(sheet.headers);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: HEADER_FONT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    });

    for (const row of sheet.rows) {
      const r = ws.addRow(
        row.map((v) =>
          v === null || v === undefined
            ? ''
            : // Anti-injection de formule : seules les chaînes sont à risque.
              typeof v === 'string'
              ? neutralizeFormula(v)
              : (v as ExcelJS.CellValue),
        ),
      );
      if ((r.number - 1) % 2 === 0) {
        r.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL } };
        });
      }
    }

    // Largeurs : forcées sinon estimées d'après le contenu (cap 60).
    sheet.headers.forEach((header, c) => {
      const col = ws.getColumn(c + 1);
      if (sheet.widths?.[c]) {
        col.width = sheet.widths[c];
      } else {
        let max = String(header).length;
        for (const row of sheet.rows) {
          const len = String(row[c] ?? '').length;
          if (len > max) max = len;
        }
        col.width = Math.min(60, Math.max(10, max + 2));
      }
    });

    if (sheet.rows.length || sheet.headers.length) {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.headers.length },
      };
    }
  }

  // writeBuffer renvoie un Buffer ou un ArrayBuffer selon la version → on normalise.
  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

/** Pose les en-têtes de téléchargement et renvoie le classeur XLSX. */
export function sendXlsx(res: Response, filename: string, buf: Buffer): void {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}
