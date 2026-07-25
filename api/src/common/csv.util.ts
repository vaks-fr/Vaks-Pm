import type { Response } from 'express';

/**
 * Neutralise l'injection de formule tableur (CSV/Excel/Sheets) : une cellule
 * commençant par `= + - @` ou une tabulation/CR est interprétée comme formule
 * par Excel/LibreOffice. On préfixe d'une apostrophe pour forcer le texte.
 * Valeurs attaquant-contrôlées (noms de tâches/clients, commentaires, libellés
 * d'audit) → ne doivent jamais exécuter à l'ouverture du fichier.
 */
export function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** Échappe une cellule CSV (RFC 4180 : guillemets doublés si nécessaire). */
function esc(v: unknown): string {
  const raw = v === null || v === undefined ? '' : String(v);
  const s = neutralizeFormula(raw);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Construit un CSV (préfixé d'un BOM UTF-8 pour qu'Excel lise les accents). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  return '﻿' + lines.join('\r\n');
}

/** Pose les en-têtes de téléchargement et renvoie le CSV. */
export function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.send(csv);
}

/**
 * Parse un CSV générique (virgule, guillemets doubles RFC 4180, BOM toléré).
 * Renvoie une ligne = un objet `{ header: valeur }` ; les en-têtes sont trimés.
 * `line` est le numéro de ligne 1-based dans le fichier (utile pour les erreurs).
 */
export function parseCsvRows(input: string): Array<{ line: number; row: Record<string, string> }> {
  const text = input.replace(/^﻿/, '');
  const lines: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') {
        buf += '""';
        i++;
      } else {
        inQuote = !inQuote;
        buf += ch;
      }
      continue;
    }
    if (!inQuote && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length) lines.push(buf);
  if (lines.length === 0) return [];

  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          q = !q;
        }
        continue;
      }
      if (!q && ch === ',') {
        out.push(cell);
        cell = '';
        continue;
      }
      cell += ch;
    }
    out.push(cell);
    return out;
  };

  const headers = splitRow(lines[0]).map((h) => h.trim());
  const rows: Array<{ line: number; row: Record<string, string> }> = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitRow(lines[i]);
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      if (headers[c]) row[headers[c]] = (cells[c] ?? '').trim();
    }
    rows.push({ line: i + 1, row });
  }
  return rows;
}
