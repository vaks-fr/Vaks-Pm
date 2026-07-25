/**
 * Génère un document Word (.docx) à partir d'un ProjectCharter rempli.
 *
 * Deux modes :
 *   - `buildCharterDocx(...)` : génère le template par défaut (en-tête + 13
 *     sections PMBOK) en code, sans fichier externe.
 *   - `fillCharterTemplate(templateBuffer, ...)` : remplit un template `.docx`
 *     uploadé par l'organisation. Les placeholders attendus sont
 *     `{projectKey}`, `{projectName}`, `{client}`, `{draftDate}`,
 *     `{projectPurpose}`, `{objectives}`, `{scopeIn}`, `{scopeOut}`,
 *     `{deliverables}`, `{milestones}`, `{stakeholders}`, `{sponsor}`,
 *     `{assumptions}`, `{constraints}`, `{risks}`, `{budgetEstimate}`,
 *     `{successCriteria}`.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  TextRun,
} from 'docx';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

interface CharterInput {
  project: {
    key: string;
    name: string;
    description: string | null;
    client?: { name: string; company: string | null } | null;
    createdAt: Date | string;
  };
  charter: {
    projectPurpose: string | null;
    objectives: string | null;
    scopeIn: string | null;
    scopeOut: string | null;
    deliverables: string | null;
    milestones: string | null;
    stakeholders: string | null;
    sponsor: string | null;
    assumptions: string | null;
    constraints: string | null;
    risks: string | null;
    budgetEstimate: string | null;
    successCriteria: string | null;
  };
}

const SECTIONS: Array<{ key: keyof CharterInput['charter']; label: string }> = [
  { key: 'projectPurpose', label: '1. Project purpose' },
  { key: 'objectives', label: '2. Objectives (SMART)' },
  { key: 'scopeIn', label: '3. In scope' },
  { key: 'scopeOut', label: '4. Out of scope' },
  { key: 'deliverables', label: '5. Key deliverables' },
  { key: 'milestones', label: '6. Key milestones' },
  { key: 'stakeholders', label: '7. Stakeholders' },
  { key: 'sponsor', label: '8. Executive sponsor' },
  { key: 'assumptions', label: '9. Assumptions' },
  { key: 'constraints', label: '10. Constraints' },
  { key: 'risks', label: '11. Initial risks' },
  { key: 'budgetEstimate', label: '12. Budget estimate' },
  { key: 'successCriteria', label: '13. Success criteria / KPIs' },
];

function bodyParagraphs(text: string | null): Paragraph[] {
  if (!text || text.trim() === '') {
    return [
      new Paragraph({
        children: [
          new TextRun({ text: '(not provided)', italics: true, color: '888888' }),
        ],
        spacing: { after: 160 },
      }),
    ];
  }
  return text
    .split(/\r?\n/)
    .map(
      (line) =>
        new Paragraph({
          children: [new TextRun({ text: line })],
          spacing: { after: 80 },
        }),
    );
}

export async function buildCharterDocx(input: CharterInput): Promise<Buffer> {
  const { project, charter } = input;
  const created =
    typeof project.createdAt === 'string'
      ? new Date(project.createdAt)
      : project.createdAt;

  const clientLine = project.client
    ? `${project.client.name}${project.client.company ? ` (${project.client.company})` : ''}`
    : 'Internal project';

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'PROJECT CHARTER', bold: true, size: 36 }),
      ],
      spacing: { after: 200 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: project.name, size: 28 })],
      spacing: { after: 80 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: `[${project.key}] · ${clientLine}`, color: '666666' }),
      ],
      spacing: { after: 80 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Drafted on ${created.toISOString().slice(0, 10)}`,
          italics: true,
          color: '888888',
          size: 20,
        }),
      ],
      spacing: { after: 400 },
    }),
  ];

  if (project.description) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: project.description, italics: true })],
        spacing: { after: 240 },
      }),
    );
  }

  for (const s of SECTIONS) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: s.label, bold: true })],
        spacing: { before: 200, after: 80 },
      }),
    );
    for (const p of bodyParagraphs(charter[s.key])) children.push(p);
  }

  // Signature block
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: 'Approval', bold: true })],
      spacing: { before: 400, after: 160 },
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Sponsor: ___________________________   Date: __________' })],
      spacing: { after: 240 },
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Client representative: ___________________________   Date: __________' })],
      spacing: { after: 80 },
    }),
  );

  const doc = new Document({
    creator: 'Vaks Project Management',
    title: `Project charter — ${project.name}`,
    sections: [
      {
        properties: { page: { size: { orientation: PageOrientation.PORTRAIT } } },
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

/**
 * Remplit un template `.docx` fourni par l'organisation. Le template doit
 * contenir les placeholders au format docxtemplater `{key}` (ou `{key}` dans
 * un même bloc text). Valeurs vides → chaîne vide (pas de "not provided").
 */
export function fillCharterTemplate(
  templateBuffer: Buffer,
  input: CharterInput,
): Buffer {
  const { project, charter } = input;
  const created =
    typeof project.createdAt === 'string'
      ? new Date(project.createdAt)
      : project.createdAt;
  const clientLine = project.client
    ? `${project.client.name}${project.client.company ? ` (${project.client.company})` : ''}`
    : 'Internal project';

  const data: Record<string, string> = {
    projectKey: project.key,
    projectName: project.name,
    description: project.description ?? '',
    client: clientLine,
    draftDate: created.toISOString().slice(0, 10),
    projectPurpose: charter.projectPurpose ?? '',
    objectives: charter.objectives ?? '',
    scopeIn: charter.scopeIn ?? '',
    scopeOut: charter.scopeOut ?? '',
    deliverables: charter.deliverables ?? '',
    milestones: charter.milestones ?? '',
    stakeholders: charter.stakeholders ?? '',
    sponsor: charter.sponsor ?? '',
    assumptions: charter.assumptions ?? '',
    constraints: charter.constraints ?? '',
    risks: charter.risks ?? '',
    budgetEstimate: charter.budgetEstimate ?? '',
    successCriteria: charter.successCriteria ?? '',
  };

  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Placeholders reconnus du template CHARTER (= clés de `data` ci-dessus). */
export const CHARTER_TEMPLATE_KEYS = [
  'projectKey', 'projectName', 'description', 'client', 'draftDate',
  'projectPurpose', 'objectives', 'scopeIn', 'scopeOut', 'deliverables',
  'milestones', 'stakeholders', 'sponsor', 'assumptions', 'constraints',
  'risks', 'budgetEstimate', 'successCriteria',
] as const;

export interface TemplateValidationResult {
  ok: boolean;
  /** Message d'erreur si le template est cassé (zip invalide, balise non fermée…). */
  error?: string;
  /** Tags présents dans le template mais inconnus du modèle de données (non bloquant). */
  unknownTags: string[];
}

/**
 * Valide un template `.docx` docxtemplater **sans le persister** :
 * 1. parse le zip + le moteur (échoue sur docx corrompu / balise non fermée) ;
 * 2. effectue un rendu à blanc en enregistrant les tags réellement référencés
 *    (via un Proxy qui renvoie '' pour tout) ;
 * 3. signale les tags inconnus du modèle (faute de frappe probable) — non bloquant.
 *
 * `knownKeys` = placeholders supportés pour ce `kind` (CHARTER pour l'instant).
 */
export function validateDocxTemplate(
  templateBuffer: Buffer,
  knownKeys: readonly string[],
): TemplateValidationResult {
  const used = new Set<string>();
  try {
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    // Proxy : chaque accès de tag est enregistré, et renvoie '' pour que le
    // rendu n'échoue jamais sur une valeur manquante — on ne veut détecter que
    // les ERREURS DE SYNTAXE (balises mal formées), pas les valeurs absentes.
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
    // docxtemplater empile les erreurs de balise dans `properties.errors`.
    const err = e as { message?: string; properties?: { errors?: Array<{ properties?: { explanation?: string } }> } };
    const explanations = err.properties?.errors
      ?.map((x) => x.properties?.explanation)
      .filter(Boolean) as string[] | undefined;
    return {
      ok: false,
      error:
        explanations && explanations.length
          ? explanations.join(' ; ')
          : err.message || 'Template .docx invalide ou corrompu.',
      unknownTags: [],
    };
  }
  const known = new Set(knownKeys);
  const unknownTags = [...used].filter((t) => !known.has(t));
  return { ok: true, unknownTags };
}
