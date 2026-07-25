import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { CHART_COLORS } from './charts.svg';

const INK = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const ACCENT = '#2563eb';
const ZEBRA = '#f8fafc';

/**
 * Largeur utile d'une page A4 (595.28pt) marges 40pt comprises ≈ 515pt.
 * Les graphiques SVG doivent être générés **à cette largeur** puis rendus 1:1
 * (sans rescale) : c'est la seule façon de garantir que la hauteur réservée
 * dans le flux corresponde exactement à ce que `svg-to-pdfkit` dessine.
 */
export const PDF_CONTENT_WIDTH = 515;

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
}

export interface PdfTableColumn {
  header: string;
  /** Largeur relative (poids). */
  width: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * Petit wrapper au-dessus de PDFKit pour produire un **rapport mis en forme**
 * (en-tête de page, cartes KPI, tables zébrées paginées, graphiques SVG).
 *
 * Le PDF est mis en page en flux vertical via `doc.y`. La pagination des tables
 * est gérée explicitement (saut de page + ré-affichage de l'en-tête de table).
 */
export class PdfReport {
  readonly doc: PDFKit.PDFDocument;
  private readonly buffers: Buffer[] = [];
  private readonly done: Promise<Buffer>;
  private readonly title: string;

  constructor(title: string) {
    this.title = title;
    this.doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      bufferPages: true,
      info: { Title: title, Author: 'Vaks PM' },
    });
    this.done = new Promise<Buffer>((resolve) => {
      this.doc.on('data', (c: Buffer) => this.buffers.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(this.buffers)));
    });
  }

  private get left(): number {
    return this.doc.page.margins.left;
  }
  private get contentWidth(): number {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }
  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Saute une page si moins de `need` points restent avant le bas. */
  private ensure(need: number): void {
    if (this.doc.y + need > this.bottom) this.doc.addPage();
  }

  // ---- En-tête de rapport (titre + sous-titre + période + date) ----
  header(subtitle: string, period?: { from: string; to: string }): this {
    const d = this.doc;
    d.fillColor(ACCENT).fontSize(9).font('Helvetica-Bold').text('VAKS PM', this.left, 34);
    d.fillColor(INK).fontSize(20).font('Helvetica-Bold').text(this.title, this.left, 48);
    d.moveDown(0.2);
    d.fillColor(MUTED).fontSize(11).font('Helvetica').text(subtitle);
    const meta: string[] = [];
    if (period) meta.push(`Période : du ${period.from} au ${period.to}`);
    meta.push(`Généré le ${new Date().toISOString().slice(0, 10)}`);
    d.fillColor(MUTED).fontSize(9).text(meta.join('   ·   '));
    d.moveTo(this.left, d.y + 6)
      .lineTo(this.left + this.contentWidth, d.y + 6)
      .strokeColor(BORDER)
      .lineWidth(1)
      .stroke();
    d.y += 16;
    return this;
  }

  // ---- Ligne de cartes KPI ----
  kpis(items: Kpi[]): this {
    if (items.length === 0) return this;
    const d = this.doc;
    const gap = 10;
    const cols = Math.min(items.length, 5);
    const cardW = (this.contentWidth - gap * (cols - 1)) / cols;
    const cardH = 56;
    this.ensure(cardH + 10);
    const top = d.y;
    items.slice(0, cols).forEach((kpi, i) => {
      const x = this.left + i * (cardW + gap);
      d.roundedRect(x, top, cardW, cardH, 6).fillAndStroke('#ffffff', BORDER);
      d.fillColor(MUTED).fontSize(8).font('Helvetica').text(kpi.label.toUpperCase(), x + 8, top + 8, { width: cardW - 16 });
      d.fillColor(INK).fontSize(17).font('Helvetica-Bold').text(kpi.value, x + 8, top + 20, { width: cardW - 16, ellipsis: true });
      if (kpi.hint) d.fillColor(MUTED).fontSize(7.5).font('Helvetica').text(kpi.hint, x + 8, top + 42, { width: cardW - 16, ellipsis: true });
    });
    d.y = top + cardH + 14;
    return this;
  }

  // ---- Titre de section ----
  section(title: string): this {
    this.doc.y += 8; // respiration au-dessus du titre
    this.ensure(34);
    const d = this.doc;
    d.fillColor(INK).fontSize(13).font('Helvetica-Bold').text(title, this.left, d.y);
    d.y += 6;
    return this;
  }

  /** Paragraphe d'aide / note grisée. */
  note(text: string): this {
    this.doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(text, this.left, this.doc.y, { width: this.contentWidth });
    this.doc.y += 4;
    return this;
  }

  // ---- Graphique SVG ----
  chart(svg: string, width: number, height: number, centered = false): this {
    this.ensure(height + 12);
    const x = centered ? this.left + (this.contentWidth - width) / 2 : this.left;
    SVGtoPDF(this.doc, svg, x, this.doc.y, { width, height, assumePt: true });
    this.doc.y += height + 12;
    return this;
  }

  // ---- Table zébrée paginée ----
  table(columns: PdfTableColumn[], rows: (string | number)[][]): this {
    const d = this.doc;
    const totalWeight = columns.reduce((s, c) => s + c.width, 0);
    const widths = columns.map((c) => (this.contentWidth * c.width) / totalWeight);
    const xs: number[] = [];
    let acc = this.left;
    for (const w of widths) {
      xs.push(acc);
      acc += w;
    }
    const rowH = 18;
    const pad = 5;

    const drawHeader = () => {
      const top = d.y;
      d.rect(this.left, top, this.contentWidth, rowH).fill('#1e293b');
      d.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
      columns.forEach((c, i) => {
        d.text(c.header, xs[i] + pad, top + 5, { width: widths[i] - pad * 2, align: c.align ?? 'left', ellipsis: true });
      });
      d.y = top + rowH;
    };

    this.ensure(rowH * 2);
    drawHeader();

    rows.forEach((row, ri) => {
      if (d.y + rowH > this.bottom) {
        d.addPage();
        drawHeader();
      }
      const top = d.y;
      if (ri % 2 === 1) d.rect(this.left, top, this.contentWidth, rowH).fill(ZEBRA);
      d.fillColor(INK).fontSize(8.5).font('Helvetica');
      columns.forEach((c, i) => {
        const v = row[i];
        d.fillColor(INK).text(v === null || v === undefined ? '' : String(v), xs[i] + pad, top + 5, {
          width: widths[i] - pad * 2,
          align: c.align ?? 'left',
          ellipsis: true,
        });
      });
      d.y = top + rowH;
    });
    d.moveTo(this.left, d.y).lineTo(this.left + this.contentWidth, d.y).strokeColor(BORDER).lineWidth(0.5).stroke();
    d.y += 12;
    return this;
  }

  /** Légende inline (pastilles colorées + libellés). */
  legend(items: Array<{ label: string; color: string }>): this {
    const d = this.doc;
    this.ensure(16);
    let x = this.left;
    const y = d.y;
    for (const it of items) {
      d.roundedRect(x, y + 1, 9, 9, 2).fill(it.color);
      d.fillColor(MUTED).fontSize(8.5).font('Helvetica').text(it.label, x + 13, y, { continued: false });
      x += 13 + d.widthOfString(it.label) + 16;
    }
    d.y = y + 16;
    return this;
  }

  /** Numéros de page en pied (après tout le contenu). */
  private paginate(): void {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const y = this.doc.page.height - 28;
      this.doc
        .fillColor(MUTED)
        .fontSize(8)
        .font('Helvetica')
        .text(`${this.title}  ·  page ${i - range.start + 1}/${range.count}`, this.left, y, {
          width: this.contentWidth,
          align: 'center',
          lineBreak: false,
        });
    }
  }

  /** Finalise le document et renvoie le Buffer. */
  async finish(): Promise<Buffer> {
    this.paginate();
    this.doc.end();
    return this.done;
  }
}

/** Pose les en-têtes de téléchargement et renvoie le PDF. */
export function sendPdf(res: Response, filename: string, buf: Buffer): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

export { CHART_COLORS };
