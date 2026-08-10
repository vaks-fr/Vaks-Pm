/**
 * Point de statut projet destiné au CLIENT, rendu en PowerPoint (.pptx).
 *
 * Deux chemins de rendu :
 *   - `renderDefaultDeck(...)` : deck brandé Vaks construit en code (pptxgenjs),
 *     avec des **graphiques natifs PowerPoint** (donut avancement, donut
 *     échéances, courbe burndown) éditables dans PowerPoint.
 *   - `fillTemplateDeck(...)` : remplit un `.pptx` squelette fourni par l'org via
 *     docxtemplater (placeholders texte + boucles). Les graphiques y sont
 *     injectés comme **images** via des tags `{%progressChart}` /
 *     `{%dueChart}` / `{%burndownChart}` (module image + rasterisation SVG→PNG).
 *
 * Contenu volontairement dépouillé (livrable client) : statut éditorial,
 * avancement, jalons, prochaines étapes, risques. Aucun temps passé / agent IA /
 * skill gap / coût interne — ceux-là restent dans `report.pdf`.
 */
import PptxGenJS from 'pptxgenjs';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { Resvg } from '@resvg/resvg-js';
import { reportT, type ReportLang } from '../common/i18n/report-i18n';
import { burndownSvg, donutSvg } from '../common/charts.svg';

export interface StatusDeckModel {
  projectKey: string;
  projectName: string;
  /** Ligne client résolue (nom + société), '' si projet interne. */
  client: string;
  startDate: string;
  dueDate: string;
  reportDate: string;
  preparedBy: string;
  lang: string;
  health: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | null;
  statusSummary: string;
  progressPct: number;
  totalTasks: number;
  doneTasks: number;
  overdueTasks: number;
  milestonesDone: Array<{ name: string; date: string }>;
  milestonesUpcoming: Array<{ name: string; date: string }>;
  milestonesAtRisk: Array<{ name: string; date: string }>;
  nextSteps: Array<{ name: string; due: string; assignees: string }>;
  dueAdherence: { onTime: number; late: number; noDeadline: number; onTimePct: number; totalCompleted: number };
  burndown: { totalScope: number; points: Array<{ date: string; ideal: number; actual: number }> } | null;
}

/** Placeholders reconnus du template CLIENT_STATUS_PPTX (texte + boucles + tags image). */
export const CLIENT_STATUS_TEMPLATE_KEYS = [
  'projectKey', 'projectName', 'client', 'startDate', 'dueDate', 'reportDate',
  'preparedBy', 'health', 'statusSummary', 'progressPct', 'totalTasks',
  'doneTasks', 'overdueTasks',
  // boucles
  'milestonesDone', 'milestonesUpcoming', 'milestonesAtRisk', 'nextSteps',
  // sous-clés des boucles
  'name', 'date', 'due', 'assignees',
] as const;

const HEALTH_COLOR: Record<string, string> = {
  ON_TRACK: '16A34A',
  AT_RISK: 'D97706',
  OFF_TRACK: 'DC2626',
  NA: '6B7280',
};

const ACCENT = '4F46E5'; // indigo Vaks
const INK = '1F2937';
const MUTED = '6B7280';
const GREEN = '16A34A';
const RED = 'DC2626';
const GREY = '9CA3AF';
const LIGHT = 'E5E7EB';

function healthLabel(t: ReturnType<typeof reportT>, health: string | null): string {
  return t(`sd.health.${health ?? 'NA'}`);
}

function normLang(lang: string): ReportLang {
  const c = lang.slice(0, 2).toLowerCase();
  return (['en', 'fr', 'it', 'de'].includes(c) ? c : 'en') as ReportLang;
}

/** SVG → PNG (rasterisation serveur, sans navigateur). Largeur cible en px. */
function svgToPng(svg: string, width: number): Buffer {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'white' });
  return Buffer.from(r.render().asPng());
}

/**
 * Entrée unique : remplit le template de l'org s'il existe, sinon construit le
 * deck par défaut. Renvoie toujours un buffer `.pptx`.
 */
export async function renderStatusDeckPptx(
  model: StatusDeckModel,
  templateBuffer: Buffer | null,
): Promise<Buffer> {
  if (templateBuffer) return fillTemplateDeck(templateBuffer, model);
  return renderDefaultDeck(model);
}

// ---------------------------------------------------------------------------
// Graphiques → PNG (pour l'injection dans les templates custom)
// ---------------------------------------------------------------------------
function chartPngs(
  model: StatusDeckModel,
  t: ReturnType<typeof reportT>,
): Record<string, Buffer> {
  const remaining = Math.max(0, model.totalTasks - model.doneTasks);
  const progressSvg = donutSvg(
    [
      { label: t('sd.tasksLabel'), value: model.doneTasks, color: `#${GREEN}` },
      { label: t('sd.remaining'), value: remaining, color: `#${LIGHT}` },
    ],
    { size: 240, centerValue: `${model.progressPct}%`, centerLabel: t('sd.progress') },
  );
  const d = model.dueAdherence;
  const dueSvg = donutSvg(
    d.totalCompleted > 0
      ? [
          { label: t('da.onTime'), value: d.onTime, color: `#${GREEN}` },
          { label: t('da.late'), value: d.late, color: `#${RED}` },
          { label: t('da.noDeadline'), value: d.noDeadline, color: `#${GREY}` },
        ]
      : [{ label: t('da.noDeadline'), value: 1, color: `#${LIGHT}` }],
    { size: 240, centerValue: `${d.onTimePct}%`, centerLabel: t('donut.onTimeCenter') },
  );
  const burnSvg = burndownSvg(
    (model.burndown?.points ?? []).map((p) => ({
      date: p.date,
      idealRemainingHours: p.ideal,
      actualRemainingHours: p.actual,
    })),
    { width: 720, height: 300 },
  );
  return {
    progress: svgToPng(progressSvg, 460),
    due: svgToPng(dueSvg, 460),
    burndown: svgToPng(burnSvg, 960),
  };
}

// ---------------------------------------------------------------------------
// Chemin 1 — template custom uploadé (docxtemplater + module image)
// ---------------------------------------------------------------------------
function fillTemplateDeck(templateBuffer: Buffer, model: StatusDeckModel): Buffer {
  const t = reportT(normLang(model.lang));
  const data: Record<string, unknown> = {
    projectKey: model.projectKey,
    projectName: model.projectName,
    client: model.client || t('sd.internalProject'),
    startDate: model.startDate,
    dueDate: model.dueDate,
    reportDate: model.reportDate,
    preparedBy: model.preparedBy,
    health: healthLabel(t, model.health),
    statusSummary: model.statusSummary || t('sd.noSummary'),
    progressPct: model.progressPct,
    totalTasks: model.totalTasks,
    doneTasks: model.doneTasks,
    overdueTasks: model.overdueTasks,
    milestonesDone: model.milestonesDone,
    milestonesUpcoming: model.milestonesUpcoming,
    milestonesAtRisk: model.milestonesAtRisk,
    nextSteps: model.nextSteps,
  };
  // 1) Remplit les placeholders TEXTE + boucles.
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data);
  const filled: Buffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  // 2) Remplace les images placeholder nommées `chart:*` par les graphiques
  //    rendus côté serveur (approche indépendante de tout module tiers, qui ne
  //    supportent pas le PPTX). Best-effort : si aucun placeholder, no-op.
  try {
    return injectNamedChartImages(filled, chartPngs(model, t));
  } catch {
    return filled; // un échec d'injection ne doit pas casser l'export
  }
}

/**
 * Remplace, dans un `.pptx`, les octets des images dont le nom (Selection Pane
 * PowerPoint) vaut `chart:progress` / `chart:due` / `chart:burndown` par le PNG
 * correspondant. Le client contrôle position ET taille via l'image placeholder.
 */
function injectNamedChartImages(pptxBuffer: Buffer, pngs: Record<string, Buffer>): Buffer {
  const zip = new PizZip(pptxBuffer);
  const slidePaths = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const picRe = /<p:pic\b[\s\S]*?<\/p:pic>/g;
  for (const sp of slidePaths) {
    const xml = zip.file(sp)?.asText();
    if (!xml || !xml.includes('chart:')) continue;
    const relsPath = sp.replace(/ppt\/slides\/(slide\d+)\.xml$/, 'ppt/slides/_rels/$1.xml.rels');
    const relsXml = zip.file(relsPath)?.asText() ?? '';
    let m: RegExpExecArray | null;
    while ((m = picRe.exec(xml))) {
      const pic = m[0];
      const nameM = pic.match(/name="chart:([^"]+)"/);
      const embedM = pic.match(/r:embed="([^"]+)"/);
      if (!nameM || !embedM) continue;
      const png = pngs[nameM[1].trim().toLowerCase()];
      if (!png) continue;
      const relM = relsXml.match(new RegExp(`Id="${embedM[1]}"[^>]*Target="([^"]+)"`));
      if (!relM) continue;
      // Target relatif à ppt/slides/ (ex. "../media/image1.png").
      const target = 'ppt/slides/' + relM[1];
      const normalized = target.replace(/ppt\/slides\/\.\.\//, 'ppt/').replace(/\/\.\//g, '/');
      zip.file(normalized, png);
    }
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// Chemin 2 — deck par défaut brandé Vaks (pptxgenjs) avec charts natifs
// ---------------------------------------------------------------------------
async function renderDefaultDeck(model: StatusDeckModel): Promise<Buffer> {
  const t = reportT(normLang(model.lang));
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.author = 'Vaks Project Management';
  pptx.title = `${t('sd.deckTitle')} — ${model.projectName}`;

  const hColor = HEALTH_COLOR[model.health ?? 'NA'];
  const clientLine = model.client || t('sd.internalProject');

  // ---- Slide 1 : titre ----
  const s1 = pptx.addSlide();
  s1.background = { color: 'FFFFFF' };
  s1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.35, fill: { color: ACCENT } });
  s1.addText(t('sd.subtitle'), { x: 0.7, y: 1.3, w: 12, h: 0.5, fontSize: 16, color: MUTED, bold: true });
  s1.addText(model.projectName, { x: 0.7, y: 1.9, w: 12, h: 1.1, fontSize: 40, color: INK, bold: true });
  s1.addText(`[${model.projectKey}] · ${clientLine}`, { x: 0.7, y: 3.05, w: 12, h: 0.5, fontSize: 18, color: MUTED });
  s1.addText(healthLabel(t, model.health).toUpperCase(), {
    x: 0.7, y: 4.0, w: 4, h: 0.7, fontSize: 18, bold: true, color: 'FFFFFF',
    fill: { color: hColor }, align: 'center', valign: 'middle', rectRadius: 0.1,
  });
  s1.addText(t('sd.asOf', { date: model.reportDate }), { x: 0.7, y: 6.6, w: 8, h: 0.4, fontSize: 12, color: MUTED });
  s1.addText(`${t('sd.preparedBy')}: ${model.preparedBy}`, { x: 6, y: 6.6, w: 6.6, h: 0.4, fontSize: 12, color: MUTED, align: 'right' });

  // ---- Slide 2 : statut + résumé + KPIs ----
  const s2 = pptx.addSlide();
  slideHeader(pptx, s2, t('sd.overallStatus'));
  s2.addText(healthLabel(t, model.health), {
    x: 0.7, y: 1.3, w: 4.2, h: 0.9, fontSize: 22, bold: true, color: 'FFFFFF',
    fill: { color: hColor }, align: 'center', valign: 'middle', rectRadius: 0.1,
  });
  kpiBox(pptx, s2, 5.2, 1.3, `${model.progressPct}%`, t('sd.progress'));
  kpiBox(pptx, s2, 8.0, 1.3, `${model.doneTasks}/${model.totalTasks}`, t('sd.tasksLabel'));
  kpiBox(pptx, s2, 10.8, 1.3, `${model.overdueTasks}`, t('kpi.overdue'));
  s2.addText(t('sd.summary'), { x: 0.7, y: 2.7, w: 12, h: 0.4, fontSize: 16, bold: true, color: ACCENT });
  s2.addText(model.statusSummary || t('sd.noSummary'), {
    x: 0.7, y: 3.2, w: 11.9, h: 3.5, fontSize: 15, color: INK, valign: 'top',
    italic: !model.statusSummary,
  });

  // ---- Slide 3 : avancement & échéances (graphiques natifs) ----
  const s3 = pptx.addSlide();
  slideHeader(pptx, s3, t('sd.progressSlide'));
  // Burndown (haut, pleine largeur) ou note
  if (model.burndown && model.burndown.points.length > 1) {
    const labels = model.burndown.points.map((p) => p.date.slice(5));
    s3.addText(t('sd.burndownTitle'), { x: 0.7, y: 1.15, w: 11.9, h: 0.35, fontSize: 13, bold: true, color: INK });
    s3.addChart(
      pptx.ChartType.line,
      [
        { name: t('legend.ideal'), labels, values: model.burndown.points.map((p) => p.ideal) },
        { name: t('legend.actual'), labels, values: model.burndown.points.map((p) => p.actual) },
      ],
      {
        x: 0.7, y: 1.55, w: 11.9, h: 2.9,
        chartColors: [GREY, ACCENT], lineSmooth: false, lineSize: 2,
        showLegend: true, legendPos: 'b', legendFontSize: 9,
        catAxisLabelFontSize: 8, valAxisLabelFontSize: 8,
      },
    );
  } else {
    s3.addText(t('sd.noBurndown'), { x: 0.7, y: 1.4, w: 11.9, h: 0.5, fontSize: 13, italic: true, color: MUTED });
  }
  // Donut avancement (bas gauche)
  s3.addText(t('sd.progress'), { x: 1.0, y: 4.7, w: 4.5, h: 0.35, fontSize: 13, bold: true, color: INK, align: 'center' });
  s3.addChart(
    pptx.ChartType.doughnut,
    [{ name: t('sd.progress'), labels: [t('sd.tasksLabel'), t('sd.remaining')], values: [model.doneTasks, Math.max(0, model.totalTasks - model.doneTasks)] }],
    {
      x: 1.0, y: 5.0, w: 4.5, h: 2.2, holeSize: 55, chartColors: [GREEN, LIGHT],
      showLegend: true, legendPos: 'r', legendFontSize: 9,
      showValue: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: 9,
    },
  );
  // Donut échéances (bas droite)
  s3.addText(t('sec.dueAdherence'), { x: 7.5, y: 4.7, w: 4.5, h: 0.35, fontSize: 13, bold: true, color: INK, align: 'center' });
  if (model.dueAdherence.totalCompleted > 0) {
    s3.addChart(
      pptx.ChartType.doughnut,
      [{ name: t('sec.dueAdherence'), labels: [t('da.onTime'), t('da.late'), t('da.noDeadline')], values: [model.dueAdherence.onTime, model.dueAdherence.late, model.dueAdherence.noDeadline] }],
      {
        x: 7.5, y: 5.0, w: 4.5, h: 2.2, holeSize: 55, chartColors: [GREEN, RED, GREY],
        showLegend: true, legendPos: 'r', legendFontSize: 9,
        showValue: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: 9,
      },
    );
  } else {
    s3.addText(t('note.noCompleted'), { x: 7.5, y: 5.3, w: 4.5, h: 0.6, fontSize: 12, italic: true, color: MUTED, align: 'center' });
  }

  // ---- Slide 4 : jalons ----
  const s4 = pptx.addSlide();
  slideHeader(pptx, s4, t('sd.milestones'));
  milestoneColumn(pptx, s4, 0.7, t('sd.msDone'), model.milestonesDone, GREEN, t('sd.noMilestones'));
  milestoneColumn(pptx, s4, 5.05, t('sd.msUpcoming'), model.milestonesUpcoming, ACCENT, t('sd.noMilestones'));
  milestoneColumn(pptx, s4, 9.4, t('sd.msAtRisk'), model.milestonesAtRisk, RED, t('sd.noMilestones'));

  // ---- Slide 5 : prochaines étapes + risques ----
  const s5 = pptx.addSlide();
  slideHeader(pptx, s5, t('sd.nextSteps'));
  if (model.nextSteps.length > 0) {
    const rows: PptxGenJS.TableRow[] = [
      [cell(t('task'), true), cell(t('dueDate'), true), cell(t('assignees'), true)],
      ...model.nextSteps.map((n) => [cell(n.name), cell(n.due), cell(n.assignees || '—')]),
    ];
    s5.addTable(rows, {
      x: 0.7, y: 1.3, w: 11.9, colW: [6.9, 2, 3], fontSize: 12, color: INK,
      border: { type: 'solid', color: LIGHT, pt: 1 }, valign: 'middle',
    });
  } else {
    s5.addText(t('sd.noNextSteps'), { x: 0.7, y: 1.4, w: 11.9, h: 0.5, fontSize: 14, italic: true, color: MUTED });
  }
  const risks: string[] = [];
  if (model.overdueTasks > 0) risks.push(t('sd.riskOverdue', { n: model.overdueTasks }));
  if (model.milestonesAtRisk.length > 0) risks.push(t('sd.riskMsAtRisk', { n: model.milestonesAtRisk.length }));
  s5.addText(t('sd.risks'), { x: 0.7, y: 5.4, w: 12, h: 0.4, fontSize: 16, bold: true, color: ACCENT });
  s5.addText(
    risks.length ? risks.map((r) => ({ text: r, options: { bullet: true } })) : [{ text: t('sd.noRisks'), options: { italic: true, color: MUTED } }],
    { x: 0.9, y: 5.85, w: 11.7, h: 1.3, fontSize: 14, color: INK },
  );

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as unknown as Buffer;
}

function slideHeader(pptx: PptxGenJS, slide: PptxGenJS.Slide, title: string) {
  slide.background = { color: 'FFFFFF' };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.25, fill: { color: ACCENT } });
  slide.addText(title, { x: 0.7, y: 0.5, w: 12, h: 0.7, fontSize: 24, bold: true, color: INK });
}

function kpiBox(pptx: PptxGenJS, slide: PptxGenJS.Slide, x: number, y: number, value: string, label: string) {
  slide.addText(
    [
      { text: value + '\n', options: { fontSize: 30, bold: true, color: ACCENT } },
      { text: label, options: { fontSize: 12, color: MUTED } },
    ],
    { x, y, w: 2.6, h: 0.9, align: 'center', valign: 'middle' },
  );
}

function milestoneColumn(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  x: number,
  title: string,
  items: Array<{ name: string; date: string }>,
  color: string,
  emptyLabel: string,
) {
  slide.addText(title, { x, y: 1.3, w: 3.6, h: 0.5, fontSize: 16, bold: true, color });
  slide.addShape(pptx.ShapeType.line, { x, y: 1.85, w: 3.6, h: 0, line: { color, width: 2 } });
  if (items.length === 0) {
    slide.addText(emptyLabel, { x, y: 2.0, w: 3.6, h: 0.5, fontSize: 12, italic: true, color: MUTED });
    return;
  }
  const runs = items.slice(0, 10).map((m) => ({
    text: m.date ? `${m.name}  (${m.date})` : m.name,
    options: { bullet: true, fontSize: 13, color: INK, breakLine: true },
  }));
  slide.addText(runs, { x, y: 2.0, w: 3.6, h: 4.8, valign: 'top' });
}

function cell(text: string, header = false): PptxGenJS.TableCell {
  return {
    text,
    options: header ? { bold: true, color: 'FFFFFF', fill: { color: ACCENT }, fontSize: 12 } : {},
  };
}

// ---------------------------------------------------------------------------
// Validation d'un template CLIENT_STATUS_PPTX (avec module image pour que les
// tags `{%chart}` ne cassent pas le parse). Renvoie les tags inconnus.
// ---------------------------------------------------------------------------
export interface StatusTemplateValidation {
  ok: boolean;
  error?: string;
  unknownTags: string[];
}

export function validateStatusDeckTemplate(templateBuffer: Buffer): StatusTemplateValidation {
  const used = new Set<string>();
  try {
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    const recorder = new Proxy(
      {},
      {
        get: (_t, prop: string | symbol) => {
          if (typeof prop === 'string') used.add(prop);
          return '';
        },
        has: () => true,
      },
    );
    doc.render(recorder as Record<string, unknown>);
  } catch (e: unknown) {
    const err = e as { message?: string; properties?: { errors?: Array<{ properties?: { explanation?: string } }> } };
    const explanations = err.properties?.errors?.map((x) => x.properties?.explanation).filter(Boolean) as string[] | undefined;
    return {
      ok: false,
      error: explanations && explanations.length ? explanations.join(' ; ') : err.message || 'Template .pptx invalide ou corrompu.',
      unknownTags: [],
    };
  }
  const known = new Set<string>(CLIENT_STATUS_TEMPLATE_KEYS);
  const unknownTags = [...used].filter((t) => !known.has(t));
  return { ok: true, unknownTags };
}
