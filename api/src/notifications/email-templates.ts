/**
 * Templates HTML brandés pour les emails sortants. Le rendu est volontairement
 * inline (table + style attribute) pour rester compatible avec les clients mail
 * legacy (Outlook, Gmail). Pas de moteur de template — pure fonction.
 *
 * Chaque template renvoie { subject, html, text } pour fallback texte brut.
 * Le branding (logo, accent, fromName) est lu dans `NotificationsSettings`.
 *
 * Localisation : chaque template se rend dans la langue du destinataire,
 * portée par `TemplateContext.lang` (en | fr | it | de, défaut 'en'). Seul le
 * texte humain change — structure HTML, branding, URLs et valeurs interpolées
 * restent identiques. Voir `resolveRecipientLanguage` côté service pour la
 * résolution de la langue (préférence user > défaut org > 'en').
 */

import { NotificationsSettings } from './notifications-settings';

/** Langues supportées pour le rendu des emails (axe UI). */
export type Lang = 'en' | 'fr' | 'it' | 'de';

export const EMAIL_LANGUAGES: readonly Lang[] = ['en', 'fr', 'it', 'de'];

/** Normalise une langue arbitraire ('fr-FR' → 'fr', inconnue → 'en'). */
export function normalizeEmailLang(input: string | null | undefined): Lang {
  if (!input) return 'en';
  const sub = String(input).trim().toLowerCase().split('-')[0];
  return (EMAIL_LANGUAGES as readonly string[]).includes(sub) ? (sub as Lang) : 'en';
}

/** Petit helper : sélectionne la valeur de la langue, fallback 'en'. */
function L<T>(lang: Lang, table: Record<Lang, T>): T {
  return table[lang] ?? table.en;
}

export type EmailTemplateKey =
  | 'assignment'
  | 'mention'
  | 'due'
  | 'status'
  | 'over_estimate'
  | 'digest'
  | 'skill_request'
  | 'skill_expiring'
  | 'api_token_expiry'
  | 'connector_secret_expiry'
  | 'license_offline'
  | 'password_reset'
  | 'offer'
  | 'security_alert'
  | 'backup_failed'
  | 'teams_provision_failed'
  | 'billing_export'
  | 'automation'
  | 'announcement'
  | 'test';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateContext {
  recipientName: string;
  /** URL absolue vers l'app (utilisée pour le bouton CTA). */
  appUrl: string;
  /** Nom de l'organisation, pour le footer. */
  orgName: string;
  /** Langue de rendu du destinataire (défaut 'en' si non fournie). */
  lang: Lang;
  branding: Pick<NotificationsSettings, 'fromName' | 'accentColor' | 'logoUrl'>;
}

export interface AssignmentPayload {
  actorName: string;
  taskTitle: string;
  taskUrl: string;
  projectName: string;
}

export interface MentionPayload {
  actorName: string;
  taskTitle: string;
  taskUrl: string;
  commentExcerpt: string;
}

export interface DuePayload {
  taskTitle: string;
  taskUrl: string;
  dueDate: string;
  projectName: string;
}

export interface StatusPayload {
  actorName: string;
  taskTitle: string;
  taskUrl: string;
  fromStatus: string;
  toStatus: string;
}

export interface DigestPayload {
  periodLabel: string;
  items: Array<{ title: string; url: string; subtitle: string }>;
}

/** Payload pour la relance d'expiration d'un UserSkill (J-30 / J-7 / J0). */
export interface SkillExpiringPayload {
  userName: string;
  skillName: string;
  expiresAt: string; // ISO date YYYY-MM-DD
  /** "30" / "7" / "0" — utilisé pour le ton (rappel doux vs urgent). */
  stage: 30 | 7 | 0;
  ctaUrl: string;
}

export interface SkillRequestPayload {
  requesterName: string;
  teamName: string;
  /** Libellé humain du type (Assign skill / Training / External). */
  typeLabel: string;
  /** Nom du skill (existant ou proposé). */
  skillName: string;
  /** Membre ciblé (si fourni). */
  targetName?: string;
  /** Niveau souhaité (si fourni). */
  desiredLevel?: number;
  /** Projet de contexte (si fourni). */
  projectName?: string;
  note?: string;
  /** CTA : page de l'équipe dans l'app. */
  ctaUrl: string;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(ctx: TemplateContext, body: string, preheader: string): string {
  const accent = ctx.branding.accentColor;
  const logo = ctx.branding.logoUrl
    ? `<img src="${escape(ctx.branding.logoUrl)}" alt="${escape(ctx.branding.fromName)}" style="max-height:36px;display:block" />`
    : `<span style="font-weight:600;font-size:18px;color:${accent}">${escape(ctx.branding.fromName)}</span>`;
  const sentBy = L(ctx.lang, {
    en: `Sent by ${escape(ctx.orgName)} via ${escape(ctx.branding.fromName)}.`,
    fr: `Envoyé par ${escape(ctx.orgName)} via ${escape(ctx.branding.fromName)}.`,
    it: `Inviato da ${escape(ctx.orgName)} tramite ${escape(ctx.branding.fromName)}.`,
    de: `Gesendet von ${escape(ctx.orgName)} über ${escape(ctx.branding.fromName)}.`,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(ctx.branding.fromName)}</title></head>
<body style="margin:0;background:#0b0b10;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e7e7ee">
<span style="display:none;opacity:0;visibility:hidden;height:0;width:0">${escape(preheader)}</span>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b10"><tr><td align="center" style="padding:32px 16px">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#141420;border-radius:14px;overflow:hidden">
    <tr><td style="padding:24px 28px;border-bottom:1px solid #23232f">${logo}</td></tr>
    <tr><td style="padding:28px">${body}</td></tr>
    <tr><td style="padding:20px 28px;border-top:1px solid #23232f;font-size:12px;color:#8a8a99">
      ${sentBy}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function cta(ctx: TemplateContext, label: string, url: string): string {
  return `<a href="${escape(url)}" style="display:inline-block;padding:11px 18px;background:${ctx.branding.accentColor};color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${escape(label)}</a>`;
}

export function renderAssignment(ctx: TemplateContext, p: AssignmentPayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `${p.actorName} assigned you "${p.taskTitle}"`,
      heading: 'You were assigned a task',
      body: `${escape(p.actorName)} assigned <strong>${escape(p.taskTitle)}</strong> to you in <strong>${escape(p.projectName)}</strong>.`,
      cta: 'Open task',
      text: `${p.actorName} assigned you "${p.taskTitle}" in ${p.projectName}.\n${p.taskUrl}`,
    },
    fr: {
      subject: `${p.actorName} vous a assigné « ${p.taskTitle} »`,
      heading: 'Une tâche vous a été assignée',
      body: `${escape(p.actorName)} vous a assigné <strong>${escape(p.taskTitle)}</strong> dans <strong>${escape(p.projectName)}</strong>.`,
      cta: 'Ouvrir la tâche',
      text: `${p.actorName} vous a assigné « ${p.taskTitle} » dans ${p.projectName}.\n${p.taskUrl}`,
    },
    it: {
      subject: `${p.actorName} ti ha assegnato "${p.taskTitle}"`,
      heading: "Ti è stata assegnata un'attività",
      body: `${escape(p.actorName)} ti ha assegnato <strong>${escape(p.taskTitle)}</strong> in <strong>${escape(p.projectName)}</strong>.`,
      cta: "Apri l'attività",
      text: `${p.actorName} ti ha assegnato "${p.taskTitle}" in ${p.projectName}.\n${p.taskUrl}`,
    },
    de: {
      subject: `${p.actorName} hat Ihnen „${p.taskTitle}" zugewiesen`,
      heading: 'Ihnen wurde eine Aufgabe zugewiesen',
      body: `${escape(p.actorName)} hat Ihnen <strong>${escape(p.taskTitle)}</strong> in <strong>${escape(p.projectName)}</strong> zugewiesen.`,
      cta: 'Aufgabe öffnen',
      text: `${p.actorName} hat Ihnen „${p.taskTitle}" in ${p.projectName} zugewiesen.\n${p.taskUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.taskUrl)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

export function renderMention(ctx: TemplateContext, p: MentionPayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `${p.actorName} mentioned you on "${p.taskTitle}"`,
      heading: 'You were mentioned',
      body: `${escape(p.actorName)} mentioned you in a comment on <strong>${escape(p.taskTitle)}</strong>:`,
      cta: 'View comment',
      text: `${p.actorName} mentioned you on "${p.taskTitle}":\n${p.commentExcerpt}\n${p.taskUrl}`,
    },
    fr: {
      subject: `${p.actorName} vous a mentionné sur « ${p.taskTitle} »`,
      heading: 'Vous avez été mentionné',
      body: `${escape(p.actorName)} vous a mentionné dans un commentaire sur <strong>${escape(p.taskTitle)}</strong> :`,
      cta: 'Voir le commentaire',
      text: `${p.actorName} vous a mentionné sur « ${p.taskTitle} » :\n${p.commentExcerpt}\n${p.taskUrl}`,
    },
    it: {
      subject: `${p.actorName} ti ha menzionato in "${p.taskTitle}"`,
      heading: 'Sei stato menzionato',
      body: `${escape(p.actorName)} ti ha menzionato in un commento su <strong>${escape(p.taskTitle)}</strong>:`,
      cta: 'Vedi il commento',
      text: `${p.actorName} ti ha menzionato in "${p.taskTitle}":\n${p.commentExcerpt}\n${p.taskUrl}`,
    },
    de: {
      subject: `${p.actorName} hat Sie in „${p.taskTitle}" erwähnt`,
      heading: 'Sie wurden erwähnt',
      body: `${escape(p.actorName)} hat Sie in einem Kommentar zu <strong>${escape(p.taskTitle)}</strong> erwähnt:`,
      cta: 'Kommentar ansehen',
      text: `${p.actorName} hat Sie in „${p.taskTitle}" erwähnt:\n${p.commentExcerpt}\n${p.taskUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <blockquote style="margin:0 0 20px;padding:12px 14px;background:#1c1c28;border-left:3px solid ${ctx.branding.accentColor};color:#d4d4e0;border-radius:0 6px 6px 0">${escape(p.commentExcerpt)}</blockquote>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.taskUrl)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

export function renderDue(ctx: TemplateContext, p: DuePayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `Due soon: "${p.taskTitle}"`,
      heading: 'A task is due soon',
      body: `<strong>${escape(p.taskTitle)}</strong> in <strong>${escape(p.projectName)}</strong> is due <strong>${escape(p.dueDate)}</strong>.`,
      cta: 'Open task',
      text: `"${p.taskTitle}" (${p.projectName}) is due ${p.dueDate}.\n${p.taskUrl}`,
    },
    fr: {
      subject: `Échéance proche : « ${p.taskTitle} »`,
      heading: "Une tâche arrive à échéance",
      body: `<strong>${escape(p.taskTitle)}</strong> dans <strong>${escape(p.projectName)}</strong> arrive à échéance le <strong>${escape(p.dueDate)}</strong>.`,
      cta: 'Ouvrir la tâche',
      text: `« ${p.taskTitle} » (${p.projectName}) arrive à échéance le ${p.dueDate}.\n${p.taskUrl}`,
    },
    it: {
      subject: `In scadenza: "${p.taskTitle}"`,
      heading: "Un'attività è in scadenza",
      body: `<strong>${escape(p.taskTitle)}</strong> in <strong>${escape(p.projectName)}</strong> scade il <strong>${escape(p.dueDate)}</strong>.`,
      cta: "Apri l'attività",
      text: `"${p.taskTitle}" (${p.projectName}) scade il ${p.dueDate}.\n${p.taskUrl}`,
    },
    de: {
      subject: `Bald fällig: „${p.taskTitle}"`,
      heading: 'Eine Aufgabe ist bald fällig',
      body: `<strong>${escape(p.taskTitle)}</strong> in <strong>${escape(p.projectName)}</strong> ist am <strong>${escape(p.dueDate)}</strong> fällig.`,
      cta: 'Aufgabe öffnen',
      text: `„${p.taskTitle}" (${p.projectName}) ist am ${p.dueDate} fällig.\n${p.taskUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.taskUrl)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

export function renderStatus(ctx: TemplateContext, p: StatusPayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `"${p.taskTitle}" moved to ${p.toStatus}`,
      heading: 'Task status changed',
      body: `${escape(p.actorName)} moved <strong>${escape(p.taskTitle)}</strong> from <code style="color:#fff">${escape(p.fromStatus)}</code> to <code style="color:#fff">${escape(p.toStatus)}</code>.`,
      cta: 'Open task',
      text: `${p.actorName} moved "${p.taskTitle}" from ${p.fromStatus} to ${p.toStatus}.\n${p.taskUrl}`,
    },
    fr: {
      subject: `« ${p.taskTitle} » déplacé vers ${p.toStatus}`,
      heading: 'Statut de la tâche modifié',
      body: `${escape(p.actorName)} a déplacé <strong>${escape(p.taskTitle)}</strong> de <code style="color:#fff">${escape(p.fromStatus)}</code> à <code style="color:#fff">${escape(p.toStatus)}</code>.`,
      cta: 'Ouvrir la tâche',
      text: `${p.actorName} a déplacé « ${p.taskTitle} » de ${p.fromStatus} à ${p.toStatus}.\n${p.taskUrl}`,
    },
    it: {
      subject: `"${p.taskTitle}" spostato in ${p.toStatus}`,
      heading: "Stato dell'attività modificato",
      body: `${escape(p.actorName)} ha spostato <strong>${escape(p.taskTitle)}</strong> da <code style="color:#fff">${escape(p.fromStatus)}</code> a <code style="color:#fff">${escape(p.toStatus)}</code>.`,
      cta: "Apri l'attività",
      text: `${p.actorName} ha spostato "${p.taskTitle}" da ${p.fromStatus} a ${p.toStatus}.\n${p.taskUrl}`,
    },
    de: {
      subject: `„${p.taskTitle}" verschoben nach ${p.toStatus}`,
      heading: 'Aufgabenstatus geändert',
      body: `${escape(p.actorName)} hat <strong>${escape(p.taskTitle)}</strong> von <code style="color:#fff">${escape(p.fromStatus)}</code> nach <code style="color:#fff">${escape(p.toStatus)}</code> verschoben.`,
      cta: 'Aufgabe öffnen',
      text: `${p.actorName} hat „${p.taskTitle}" von ${p.fromStatus} nach ${p.toStatus} verschoben.\n${p.taskUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.taskUrl)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

export interface OverEstimatePayload {
  /** Personne qui a saisi l'entrée de temps qui a fait basculer le total. */
  actorName: string;
  taskTitle: string;
  taskUrl: string;
  projectName: string;
  estimateHours: number;
  loggedHours: number;
  overByHours: number;
}

export function renderOverEstimate(ctx: TemplateContext, p: OverEstimatePayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `⚠ "${p.taskTitle}" went over estimate (${p.loggedHours.toFixed(1)}h vs ${p.estimateHours}h)`,
      heading: 'Estimate exceeded',
      body: `${escape(p.actorName)} logged time on <strong>${escape(p.taskTitle)}</strong> (${escape(p.projectName)}), pushing the task over its estimate.`,
      rowEstimate: 'Estimate',
      rowLogged: 'Logged',
      rowOver: 'Overrun',
      note: 'You receive this email as the <em>Project Manager</em> of the project. You can adjust the estimate or rebalance the workload from the task.',
      cta: 'Open task',
      text:
        `${p.actorName} logged time on "${p.taskTitle}" (${p.projectName}).\n` +
        `Estimate: ${p.estimateHours}h · Logged: ${p.loggedHours.toFixed(1)}h · Overrun: +${p.overByHours.toFixed(1)}h\n` +
        `${p.taskUrl}`,
    },
    fr: {
      subject: `⚠ « ${p.taskTitle} » passe au-dessus de l'estimate (${p.loggedHours.toFixed(1)}h vs ${p.estimateHours}h)`,
      heading: "Dépassement d'estimate",
      body: `${escape(p.actorName)} a loggé du temps sur <strong>${escape(p.taskTitle)}</strong> (${escape(p.projectName)}), faisant passer la tâche au-dessus de son estimate.`,
      rowEstimate: 'Estimate',
      rowLogged: 'Loggé',
      rowOver: 'Dépassement',
      note: "Vous recevez ce mail en tant que <em>Project Manager</em> du projet. Vous pouvez ajuster l'estimate ou répartir la charge depuis la tâche.",
      cta: 'Ouvrir la tâche',
      text:
        `${p.actorName} a loggé du temps sur « ${p.taskTitle} » (${p.projectName}).\n` +
        `Estimate : ${p.estimateHours}h · Loggé : ${p.loggedHours.toFixed(1)}h · Dépassement : +${p.overByHours.toFixed(1)}h\n` +
        `${p.taskUrl}`,
    },
    it: {
      subject: `⚠ "${p.taskTitle}" ha superato la stima (${p.loggedHours.toFixed(1)}h vs ${p.estimateHours}h)`,
      heading: 'Stima superata',
      body: `${escape(p.actorName)} ha registrato del tempo su <strong>${escape(p.taskTitle)}</strong> (${escape(p.projectName)}), portando l'attività oltre la sua stima.`,
      rowEstimate: 'Stima',
      rowLogged: 'Registrato',
      rowOver: 'Superamento',
      note: "Ricevi questa email in quanto <em>Project Manager</em> del progetto. Puoi modificare la stima o ridistribuire il carico dall'attività.",
      cta: "Apri l'attività",
      text:
        `${p.actorName} ha registrato del tempo su "${p.taskTitle}" (${p.projectName}).\n` +
        `Stima: ${p.estimateHours}h · Registrato: ${p.loggedHours.toFixed(1)}h · Superamento: +${p.overByHours.toFixed(1)}h\n` +
        `${p.taskUrl}`,
    },
    de: {
      subject: `⚠ „${p.taskTitle}" hat die Schätzung überschritten (${p.loggedHours.toFixed(1)}h vs ${p.estimateHours}h)`,
      heading: 'Schätzung überschritten',
      body: `${escape(p.actorName)} hat Zeit auf <strong>${escape(p.taskTitle)}</strong> (${escape(p.projectName)}) erfasst und die Aufgabe damit über ihre Schätzung gebracht.`,
      rowEstimate: 'Schätzung',
      rowLogged: 'Erfasst',
      rowOver: 'Überschreitung',
      note: 'Sie erhalten diese E-Mail als <em>Projektmanager</em> des Projekts. Sie können die Schätzung anpassen oder die Auslastung aus der Aufgabe heraus neu verteilen.',
      cta: 'Aufgabe öffnen',
      text:
        `${p.actorName} hat Zeit auf „${p.taskTitle}" (${p.projectName}) erfasst.\n` +
        `Schätzung: ${p.estimateHours}h · Erfasst: ${p.loggedHours.toFixed(1)}h · Überschreitung: +${p.overByHours.toFixed(1)}h\n` +
        `${p.taskUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">
      ${t.body}
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:#1c1c28;border-radius:8px;padding:12px 14px;color:#d4d4e0;font-size:13px">
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowEstimate)}</td><td style="padding:2px 0"><strong style="color:#fff">${p.estimateHours}h</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowLogged)}</td><td style="padding:2px 0"><strong style="color:#fff">${p.loggedHours.toFixed(1)}h</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowOver)}</td><td style="padding:2px 0"><strong style="color:${ctx.branding.accentColor}">+${p.overByHours.toFixed(1)}h</strong></td></tr>
    </table>
    <p style="margin:0 0 16px;color:#8a8a99;font-size:12px">
      ${t.note}
    </p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.taskUrl)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

export function renderDigest(ctx: TemplateContext, p: DigestPayload): RenderedEmail {
  const n = p.items.length;
  const t = L(ctx.lang, {
    en: {
      subject: `Your ${p.periodLabel} digest — ${n} item${n === 1 ? '' : 's'}`,
      heading: `Your ${escape(p.periodLabel)} digest`,
      intro: `${n} update${n === 1 ? '' : 's'} since the last digest.`,
    },
    fr: {
      subject: `Votre récapitulatif ${p.periodLabel} — ${n} élément${n === 1 ? '' : 's'}`,
      heading: `Votre récapitulatif ${escape(p.periodLabel)}`,
      intro: `${n} mise${n === 1 ? '' : 's'} à jour depuis le dernier récapitulatif.`,
    },
    it: {
      subject: `Il tuo riepilogo ${p.periodLabel} — ${n} element${n === 1 ? 'o' : 'i'}`,
      heading: `Il tuo riepilogo ${escape(p.periodLabel)}`,
      intro: `${n} aggiornament${n === 1 ? 'o' : 'i'} dall'ultimo riepilogo.`,
    },
    de: {
      subject: `Ihre ${p.periodLabel} Zusammenfassung — ${n} Eintr${n === 1 ? 'ag' : 'äge'}`,
      heading: `Ihre ${escape(p.periodLabel)} Zusammenfassung`,
      intro: `${n} Aktualisierung${n === 1 ? '' : 'en'} seit der letzten Zusammenfassung.`,
    },
  });
  const rows = p.items
    .map(
      (it) => `<tr><td style="padding:10px 0;border-bottom:1px solid #23232f">
        <a href="${escape(it.url)}" style="color:#fff;text-decoration:none;font-weight:600">${escape(it.title)}</a>
        <div style="color:#8a8a99;font-size:13px;margin-top:2px">${escape(it.subtitle)}</div>
      </td></tr>`,
    )
    .join('');
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${t.heading}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${escape(t.intro)}</p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
  const text = p.items.map((it) => `- ${it.title} — ${it.subtitle}\n  ${it.url}`).join('\n');
  return { subject: t.subject, html: shell(ctx, body, t.subject), text };
}

export function renderSkillRequest(
  ctx: TemplateContext,
  p: SkillRequestPayload,
): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `Skill request for ${p.teamName}: ${p.skillName}`,
      heading: 'New skill request',
      intro: `<strong>${escape(p.requesterName)}</strong> asks the <strong>${escape(p.teamName)}</strong> team to cover a missing competency.`,
      labelSkill: 'Skill',
      level: 'level',
      labelRequest: 'Request',
      labelFor: 'For',
      labelProject: 'Project',
      cta: 'Open team',
      teamWord: 'team',
    },
    fr: {
      subject: `Demande de compétence pour ${p.teamName} : ${p.skillName}`,
      heading: 'Nouvelle demande de compétence',
      intro: `<strong>${escape(p.requesterName)}</strong> demande à l'équipe <strong>${escape(p.teamName)}</strong> de couvrir une compétence manquante.`,
      labelSkill: 'Compétence',
      level: 'niveau',
      labelRequest: 'Demande',
      labelFor: 'Pour',
      labelProject: 'Projet',
      cta: "Ouvrir l'équipe",
      teamWord: 'équipe',
    },
    it: {
      subject: `Richiesta di competenza per ${p.teamName}: ${p.skillName}`,
      heading: 'Nuova richiesta di competenza',
      intro: `<strong>${escape(p.requesterName)}</strong> chiede al team <strong>${escape(p.teamName)}</strong> di coprire una competenza mancante.`,
      labelSkill: 'Competenza',
      level: 'livello',
      labelRequest: 'Richiesta',
      labelFor: 'Per',
      labelProject: 'Progetto',
      cta: 'Apri il team',
      teamWord: 'team',
    },
    de: {
      subject: `Kompetenzanfrage für ${p.teamName}: ${p.skillName}`,
      heading: 'Neue Kompetenzanfrage',
      intro: `<strong>${escape(p.requesterName)}</strong> bittet das Team <strong>${escape(p.teamName)}</strong>, eine fehlende Kompetenz abzudecken.`,
      labelSkill: 'Kompetenz',
      level: 'Stufe',
      labelRequest: 'Anfrage',
      labelFor: 'Für',
      labelProject: 'Projekt',
      cta: 'Team öffnen',
      teamWord: 'Team',
    },
  });
  const lines: string[] = [];
  lines.push(
    `<tr><td style="padding:6px 0;color:#8a8a99;width:120px">${escape(t.labelSkill)}</td><td style="padding:6px 0;color:#fff;font-weight:600">${escape(p.skillName)}${p.desiredLevel ? ` <span style="color:#8a8a99;font-weight:400">· ${escape(t.level)} ${p.desiredLevel}</span>` : ''}</td></tr>`,
  );
  lines.push(
    `<tr><td style="padding:6px 0;color:#8a8a99">${escape(t.labelRequest)}</td><td style="padding:6px 0;color:#e7e7ee">${escape(p.typeLabel)}</td></tr>`,
  );
  if (p.targetName)
    lines.push(
      `<tr><td style="padding:6px 0;color:#8a8a99">${escape(t.labelFor)}</td><td style="padding:6px 0;color:#e7e7ee">${escape(p.targetName)}</td></tr>`,
    );
  if (p.projectName)
    lines.push(
      `<tr><td style="padding:6px 0;color:#8a8a99">${escape(t.labelProject)}</td><td style="padding:6px 0;color:#e7e7ee">${escape(p.projectName)}</td></tr>`,
    );
  const noteBlock = p.note
    ? `<blockquote style="margin:16px 0 0;padding:12px 14px;background:#1c1c28;border-left:3px solid ${ctx.branding.accentColor};color:#d4d4e0;border-radius:0 6px 6px 0">${escape(p.note)}</blockquote>`
    : '';
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.intro}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${lines.join('')}</table>
    ${noteBlock}
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.ctaUrl)}</p>`;
  const text =
    `${p.requesterName} → ${t.teamWord} ${p.teamName}\n` +
    `${t.labelSkill}: ${p.skillName}${p.desiredLevel ? ` (${t.level} ${p.desiredLevel})` : ''}\n` +
    `${t.labelRequest}: ${p.typeLabel}\n` +
    (p.targetName ? `${t.labelFor}: ${p.targetName}\n` : '') +
    (p.projectName ? `${t.labelProject}: ${p.projectName}\n` : '') +
    (p.note ? `Note: ${p.note}\n` : '') +
    p.ctaUrl;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text };
}

export function renderSkillExpiring(
  ctx: TemplateContext,
  p: SkillExpiringPayload,
): RenderedEmail {
  const isExpired = p.stage === 0;
  const t = L(ctx.lang, {
    en: {
      headline: isExpired
        ? `⚠️ ${p.userName}: "${p.skillName}" has expired`
        : `${p.userName}: "${p.skillName}" expires in ${p.stage} day${p.stage > 1 ? 's' : ''}`,
      subject: isExpired
        ? `[Skill expired] ${p.skillName}`
        : `[Reminder] ${p.skillName} expires on ${p.expiresAt}`,
      callToAction: isExpired
        ? 'Schedule a recertification or remove the skill.'
        : `Consider scheduling the recertification before ${p.expiresAt}.`,
      verbExpired: 'has expired',
      verbExpires: 'expires',
      on: 'on',
      cta: isExpired ? 'View profile' : 'Schedule recertification',
      due: 'Due date',
    },
    fr: {
      headline: isExpired
        ? `⚠️ ${p.userName} : « ${p.skillName} » a expiré`
        : `${p.userName} : « ${p.skillName} » expire dans ${p.stage} jour${p.stage > 1 ? 's' : ''}`,
      subject: isExpired
        ? `[Compétence expirée] ${p.skillName}`
        : `[Rappel] ${p.skillName} expire le ${p.expiresAt}`,
      callToAction: isExpired
        ? 'Plannifier une recertification ou retirer la compétence.'
        : `Pensez à programmer la recertification avant le ${p.expiresAt}.`,
      verbExpired: 'a expiré',
      verbExpires: 'expire',
      on: 'le',
      cta: isExpired ? 'Voir le profil' : 'Programmer la recertification',
      due: 'Échéance',
    },
    it: {
      headline: isExpired
        ? `⚠️ ${p.userName}: "${p.skillName}" è scaduta`
        : `${p.userName}: "${p.skillName}" scade tra ${p.stage} giorn${p.stage > 1 ? 'i' : 'o'}`,
      subject: isExpired
        ? `[Competenza scaduta] ${p.skillName}`
        : `[Promemoria] ${p.skillName} scade il ${p.expiresAt}`,
      callToAction: isExpired
        ? 'Pianificare una ricertificazione o rimuovere la competenza.'
        : `Ricordati di programmare la ricertificazione prima del ${p.expiresAt}.`,
      verbExpired: 'è scaduta',
      verbExpires: 'scade',
      on: 'il',
      cta: isExpired ? 'Vedi il profilo' : 'Programma la ricertificazione',
      due: 'Scadenza',
    },
    de: {
      headline: isExpired
        ? `⚠️ ${p.userName}: „${p.skillName}" ist abgelaufen`
        : `${p.userName}: „${p.skillName}" läuft in ${p.stage} Tag${p.stage > 1 ? 'en' : ''} ab`,
      subject: isExpired
        ? `[Kompetenz abgelaufen] ${p.skillName}`
        : `[Erinnerung] ${p.skillName} läuft am ${p.expiresAt} ab`,
      callToAction: isExpired
        ? 'Planen Sie eine Rezertifizierung oder entfernen Sie die Kompetenz.'
        : `Denken Sie daran, die Rezertifizierung vor dem ${p.expiresAt} zu planen.`,
      verbExpired: 'ist abgelaufen',
      verbExpires: 'läuft ab',
      on: 'am',
      cta: isExpired ? 'Profil ansehen' : 'Rezertifizierung planen',
      due: 'Fälligkeit',
    },
  });
  const verb = isExpired ? t.verbExpired : t.verbExpires;
  const sentence = L(ctx.lang, {
    en: `The skill <strong>${escape(p.skillName)}</strong> of <strong>${escape(p.userName)}</strong> ${verb} ${t.on} <strong>${escape(p.expiresAt)}</strong>. ${escape(t.callToAction)}`,
    fr: `La compétence <strong>${escape(p.skillName)}</strong> de <strong>${escape(p.userName)}</strong> ${verb} ${t.on} <strong>${escape(p.expiresAt)}</strong>. ${escape(t.callToAction)}`,
    it: `La competenza <strong>${escape(p.skillName)}</strong> di <strong>${escape(p.userName)}</strong> ${verb} ${t.on} <strong>${escape(p.expiresAt)}</strong>. ${escape(t.callToAction)}`,
    de: `Die Kompetenz <strong>${escape(p.skillName)}</strong> von <strong>${escape(p.userName)}</strong> ${verb} ${t.on} <strong>${escape(p.expiresAt)}</strong>. ${escape(t.callToAction)}`,
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.headline)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">
      ${sentence}
    </p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.ctaUrl)}</p>`;
  const text =
    `${t.headline}\n` +
    `${t.due}: ${p.expiresAt}\n` +
    `${t.callToAction}\n` +
    p.ctaUrl;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text };
}

/** Payload du mail de réinitialisation de mot de passe (lien usage unique). */
export interface PasswordResetPayload {
  /** URL absolue tenant-aware du formulaire de reset (contient le token). */
  resetUrl: string;
  /** Durée de validité en minutes (affichée à l'utilisateur). */
  expiresMinutes: number;
}

export function renderPasswordReset(
  ctx: TemplateContext,
  p: PasswordResetPayload,
): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `Reset your ${ctx.orgName} password`,
      heading: 'Password reset',
      body: `Hi ${escape(ctx.recipientName)}, an administrator asked to reset your password. Click below to choose a new one. This link is valid for ${p.expiresMinutes} minutes and can be used once.`,
      cta: 'Choose a new password',
      note: "If you didn't expect this, you can ignore this email — your current password stays unchanged until the link is used.",
      text: `Reset your ${ctx.orgName} password (valid ${p.expiresMinutes} min, single use): ${p.resetUrl}`,
    },
    fr: {
      subject: `Réinitialisation de votre mot de passe ${ctx.orgName}`,
      heading: 'Réinitialisation du mot de passe',
      body: `Bonjour ${escape(ctx.recipientName)}, un administrateur a demandé la réinitialisation de votre mot de passe. Cliquez ci-dessous pour en choisir un nouveau. Ce lien est valide ${p.expiresMinutes} minutes et utilisable une seule fois.`,
      cta: 'Choisir un nouveau mot de passe',
      note: "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email — votre mot de passe actuel reste inchangé tant que le lien n'est pas utilisé.",
      text: `Réinitialisation de votre mot de passe ${ctx.orgName} (valide ${p.expiresMinutes} min, usage unique) : ${p.resetUrl}`,
    },
    it: {
      subject: `Reimposta la password di ${ctx.orgName}`,
      heading: 'Reimpostazione della password',
      body: `Ciao ${escape(ctx.recipientName)}, un amministratore ha richiesto la reimpostazione della tua password. Clicca qui sotto per sceglierne una nuova. Questo link è valido per ${p.expiresMinutes} minuti e può essere usato una sola volta.`,
      cta: 'Scegli una nuova password',
      note: 'Se non hai richiesto questa operazione, puoi ignorare questa email — la tua password attuale resta invariata finché il link non viene utilizzato.',
      text: `Reimposta la password di ${ctx.orgName} (valida ${p.expiresMinutes} min, uso singolo): ${p.resetUrl}`,
    },
    de: {
      subject: `Setzen Sie Ihr ${ctx.orgName}-Passwort zurück`,
      heading: 'Passwort zurücksetzen',
      body: `Hallo ${escape(ctx.recipientName)}, ein Administrator hat das Zurücksetzen Ihres Passworts angefordert. Klicken Sie unten, um ein neues zu wählen. Dieser Link ist ${p.expiresMinutes} Minuten gültig und kann einmal verwendet werden.`,
      cta: 'Neues Passwort wählen',
      note: 'Wenn Sie dies nicht erwartet haben, können Sie diese E-Mail ignorieren — Ihr aktuelles Passwort bleibt unverändert, bis der Link verwendet wird.',
      text: `Setzen Sie Ihr ${ctx.orgName}-Passwort zurück (gültig ${p.expiresMinutes} Min., einmalig nutzbar): ${p.resetUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.resetUrl)}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#8a8a99">${escape(t.note)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

/** Payload du mail d'alerte sécurité (détection brute-force & co). */
export interface SecurityAlertPayload {
  /** Compte visé (email). */
  targetEmail: string;
  /** Nombre d'échecs détectés dans la fenêtre. */
  failures: number;
  /** Taille de la fenêtre de détection, en minutes. */
  windowMinutes: number;
  /** Dernière IP source observée (peut être null). */
  ip: string | null;
}

export function renderSecurityAlert(
  ctx: TemplateContext,
  p: SecurityAlertPayload,
): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `⚠ Security alert — ${p.failures} login failures on ${p.targetEmail}`,
      heading: 'Suspicious login attempts',
      hello: `Hello ${escape(ctx.recipientName)},`,
      body: `The account <strong style="color:#fff">${escape(p.targetEmail)}</strong> recorded <strong style="color:#fff">${p.failures} login failures</strong> in ${p.windowMinutes} minute(s).`,
      rowAccount: 'Account',
      rowFailures: 'Failures',
      rowIp: 'Last IP',
      inWord: 'in',
      footer1: 'Automatic account lockout applies per your policy. Details in Admin &gt; Security &amp; Compliance &gt; Audit log.',
      footer2: `You receive this message because you are an administrator of ${escape(ctx.orgName)}. Only one alert is issued per account per hour.`,
      text: `Security alert ${ctx.orgName}: ${p.failures} login failures on ${p.targetEmail} in ${p.windowMinutes} min${p.ip ? ` (last IP ${p.ip})` : ''}. See Admin > Audit log.`,
    },
    fr: {
      subject: `⚠ Alerte sécurité — ${p.failures} échecs de connexion sur ${p.targetEmail}`,
      heading: 'Tentatives de connexion suspectes',
      hello: `Bonjour ${escape(ctx.recipientName)},`,
      body: `Le compte <strong style="color:#fff">${escape(p.targetEmail)}</strong> a enregistré <strong style="color:#fff">${p.failures} échecs de connexion</strong> en ${p.windowMinutes} minute(s).`,
      rowAccount: 'Compte',
      rowFailures: 'Échecs',
      rowIp: 'Dernière IP',
      inWord: 'en',
      footer1: "Le verrouillage automatique du compte s'applique selon votre politique. Détails dans Admin &gt; Security &amp; Compliance &gt; Journal d'audit.",
      footer2: `Vous recevez ce message car vous êtes administrateur de ${escape(ctx.orgName)}. Une seule alerte est émise par compte et par heure.`,
      text: `Alerte sécurité ${ctx.orgName} : ${p.failures} échecs de connexion sur ${p.targetEmail} en ${p.windowMinutes} min${p.ip ? ` (dernière IP ${p.ip})` : ''}. Voir Admin > Journal d'audit.`,
    },
    it: {
      subject: `⚠ Avviso di sicurezza — ${p.failures} tentativi di accesso falliti su ${p.targetEmail}`,
      heading: 'Tentativi di accesso sospetti',
      hello: `Buongiorno ${escape(ctx.recipientName)},`,
      body: `L'account <strong style="color:#fff">${escape(p.targetEmail)}</strong> ha registrato <strong style="color:#fff">${p.failures} tentativi di accesso falliti</strong> in ${p.windowMinutes} minuto/i.`,
      rowAccount: 'Account',
      rowFailures: 'Tentativi falliti',
      rowIp: 'Ultimo IP',
      inWord: 'in',
      footer1: "Il blocco automatico dell'account si applica secondo la vostra policy. Dettagli in Admin &gt; Security &amp; Compliance &gt; Registro di audit.",
      footer2: `Ricevi questo messaggio perché sei amministratore di ${escape(ctx.orgName)}. Viene emesso un solo avviso per account ogni ora.`,
      text: `Avviso di sicurezza ${ctx.orgName}: ${p.failures} tentativi di accesso falliti su ${p.targetEmail} in ${p.windowMinutes} min${p.ip ? ` (ultimo IP ${p.ip})` : ''}. Vedi Admin > Registro di audit.`,
    },
    de: {
      subject: `⚠ Sicherheitswarnung — ${p.failures} fehlgeschlagene Anmeldungen bei ${p.targetEmail}`,
      heading: 'Verdächtige Anmeldeversuche',
      hello: `Hallo ${escape(ctx.recipientName)},`,
      body: `Das Konto <strong style="color:#fff">${escape(p.targetEmail)}</strong> verzeichnete <strong style="color:#fff">${p.failures} fehlgeschlagene Anmeldungen</strong> in ${p.windowMinutes} Minute(n).`,
      rowAccount: 'Konto',
      rowFailures: 'Fehlversuche',
      rowIp: 'Letzte IP',
      inWord: 'in',
      footer1: 'Die automatische Kontosperrung erfolgt gemäß Ihrer Richtlinie. Details unter Admin &gt; Security &amp; Compliance &gt; Audit-Protokoll.',
      footer2: `Sie erhalten diese Nachricht, weil Sie Administrator von ${escape(ctx.orgName)} sind. Pro Konto wird nur eine Warnung pro Stunde ausgegeben.`,
      text: `Sicherheitswarnung ${ctx.orgName}: ${p.failures} fehlgeschlagene Anmeldungen bei ${p.targetEmail} in ${p.windowMinutes} Min${p.ip ? ` (letzte IP ${p.ip})` : ''}. Siehe Admin > Audit-Protokoll.`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.hello}</p>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#1c1c28;border-radius:8px;padding:12px 14px;color:#d4d4e0;font-size:13px">
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowAccount)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.targetEmail)}</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowFailures)}</td><td style="padding:2px 0"><strong style="color:#fff">${p.failures}</strong> ${escape(t.inWord)} ${p.windowMinutes} min</td></tr>
      ${p.ip ? `<tr><td style="padding:2px 18px 2px 0">${escape(t.rowIp)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.ip)}</strong></td></tr>` : ''}
    </table>
    <p style="margin:16px 0 0;color:#c4c4d4">${t.footer1}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#8a8a99">${t.footer2}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

/** Payload du mail d'alerte « échec de sauvegarde » envoyé aux admins. */
export interface BackupAlertPayload {
  /** Hôte ayant signalé l'échec (hostname du nœud DB). */
  host: string;
  /** Message d'erreur transmis par le script de sauvegarde. */
  message: string;
  /** Palier concerné (logical / base / wal…), optionnel. */
  tier?: string | null;
  /** Horodatage ISO de l'échec (renseigné par l'API à la réception). */
  at: string;
}

export function renderBackupAlert(
  ctx: TemplateContext,
  p: BackupAlertPayload,
): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `⛔ Backup failed — ${p.host}`,
      heading: 'A database backup failed',
      hello: `Hello ${escape(ctx.recipientName)},`,
      body: `A backup job <strong style="color:#fff">failed</strong> on host <strong style="color:#fff">${escape(p.host)}</strong>. Recent data may not be protected — check the cluster without delay.`,
      rowHost: 'Host',
      rowTier: 'Tier',
      rowWhen: 'When',
      rowError: 'Error',
      footer1: 'Host-side diagnostics: <code style="color:#fff">journalctl -u vaks-backup-logical -u vaks-backup-base</code>. The event is recorded in Admin &gt; Security &amp; Compliance &gt; Audit log.',
      footer2: `You receive this message because you are an administrator of ${escape(ctx.orgName)}.`,
      text: `Backup failed ${ctx.orgName} on ${p.host}${p.tier ? ` (tier ${p.tier})` : ''} at ${p.at}: ${p.message}. See Admin > Audit log.`,
    },
    fr: {
      subject: `⛔ Échec de sauvegarde — ${p.host}`,
      heading: "Échec d'une sauvegarde de la base",
      hello: `Bonjour ${escape(ctx.recipientName)},`,
      body: `Une tâche de sauvegarde a <strong style="color:#fff">échoué</strong> sur l'hôte <strong style="color:#fff">${escape(p.host)}</strong>. Les données récentes ne sont peut-être pas protégées — vérifiez le cluster sans attendre.`,
      rowHost: 'Hôte',
      rowTier: 'Palier',
      rowWhen: 'Quand',
      rowError: 'Erreur',
      footer1: "Diagnostic côté hôte : <code style=\"color:#fff\">journalctl -u vaks-backup-logical -u vaks-backup-base</code>. L'événement est tracé dans Admin &gt; Security &amp; Compliance &gt; Journal d'audit.",
      footer2: `Vous recevez ce message car vous êtes administrateur de ${escape(ctx.orgName)}.`,
      text: `Échec de sauvegarde ${ctx.orgName} sur ${p.host}${p.tier ? ` (palier ${p.tier})` : ''} à ${p.at} : ${p.message}. Voir Admin > Journal d'audit.`,
    },
    it: {
      subject: `⛔ Backup non riuscito — ${p.host}`,
      heading: 'Un backup del database non è riuscito',
      hello: `Buongiorno ${escape(ctx.recipientName)},`,
      body: `Un'operazione di backup <strong style="color:#fff">non è riuscita</strong> sull'host <strong style="color:#fff">${escape(p.host)}</strong>. I dati recenti potrebbero non essere protetti — controlla il cluster senza indugio.`,
      rowHost: 'Host',
      rowTier: 'Livello',
      rowWhen: 'Quando',
      rowError: 'Errore',
      footer1: "Diagnostica lato host: <code style=\"color:#fff\">journalctl -u vaks-backup-logical -u vaks-backup-base</code>. L'evento è registrato in Admin &gt; Security &amp; Compliance &gt; Registro di audit.",
      footer2: `Ricevi questo messaggio perché sei amministratore di ${escape(ctx.orgName)}.`,
      text: `Backup non riuscito ${ctx.orgName} su ${p.host}${p.tier ? ` (livello ${p.tier})` : ''} alle ${p.at}: ${p.message}. Vedi Admin > Registro di audit.`,
    },
    de: {
      subject: `⛔ Sicherung fehlgeschlagen — ${p.host}`,
      heading: 'Eine Datenbanksicherung ist fehlgeschlagen',
      hello: `Hallo ${escape(ctx.recipientName)},`,
      body: `Ein Sicherungsauftrag ist auf dem Host <strong style="color:#fff">${escape(p.host)}</strong> <strong style="color:#fff">fehlgeschlagen</strong>. Aktuelle Daten sind möglicherweise nicht geschützt — prüfen Sie den Cluster unverzüglich.`,
      rowHost: 'Host',
      rowTier: 'Stufe',
      rowWhen: 'Wann',
      rowError: 'Fehler',
      footer1: 'Host-seitige Diagnose: <code style="color:#fff">journalctl -u vaks-backup-logical -u vaks-backup-base</code>. Das Ereignis wird unter Admin &gt; Security &amp; Compliance &gt; Audit-Protokoll erfasst.',
      footer2: `Sie erhalten diese Nachricht, weil Sie Administrator von ${escape(ctx.orgName)} sind.`,
      text: `Sicherung fehlgeschlagen ${ctx.orgName} auf ${p.host}${p.tier ? ` (Stufe ${p.tier})` : ''} um ${p.at}: ${p.message}. Siehe Admin > Audit-Protokoll.`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.hello}</p>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#1c1c28;border-radius:8px;padding:12px 14px;color:#d4d4e0;font-size:13px">
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowHost)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.host)}</strong></td></tr>
      ${p.tier ? `<tr><td style="padding:2px 18px 2px 0">${escape(t.rowTier)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.tier)}</strong></td></tr>` : ''}
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowWhen)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.at)}</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0;vertical-align:top">${escape(t.rowError)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.message)}</strong></td></tr>
    </table>
    <p style="margin:16px 0 0;color:#c4c4d4">${t.footer1}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#8a8a99">${t.footer2}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

/** Payload du mail d'alerte « échec définitif de provisioning Teams » envoyé aux admins du tenant. */
export interface TeamsProvisionFailedPayload {
  /** Nom du projet concerné. */
  projectName: string;
  /** Action qui a échoué (provision / archive / unarchive / reconcile). */
  action: string;
  /** Nombre de tentatives effectuées avant l'abandon. */
  attempts: number;
  /** Message d'erreur remonté par le worker / Graph. */
  error: string;
}

export function renderTeamsProvisionFailed(
  ctx: TemplateContext,
  p: TeamsProvisionFailedPayload,
): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `⛔ Microsoft Teams provisioning failed — ${p.projectName}`,
      heading: 'Microsoft Teams provisioning failed',
      hello: `Hello ${escape(ctx.recipientName)},`,
      body: `The Microsoft Teams provisioning for project <strong style="color:#fff">${escape(p.projectName)}</strong> <strong style="color:#fff">failed</strong> after ${p.attempts} attempt${p.attempts !== 1 ? 's' : ''} and will not be retried automatically. The team may be missing or out of sync — check the configuration (Entra membership, Graph credentials) and retry manually from the project's Integrations tab.`,
      rowProject: 'Project',
      rowAction: 'Action',
      rowAttempts: 'Attempts',
      rowError: 'Error',
      footer1: 'Details are recorded in Admin &gt; Security &amp; Compliance &gt; Audit log.',
      footer2: `You receive this message because you are an administrator of ${escape(ctx.orgName)}.`,
      text: `Microsoft Teams provisioning failed for ${p.projectName} (action: ${p.action}, ${p.attempts} attempt(s)): ${p.error}. See Admin > Audit log.`,
    },
    fr: {
      subject: `⛔ Échec du provisioning Microsoft Teams — ${p.projectName}`,
      heading: 'Échec du provisioning Microsoft Teams',
      hello: `Bonjour ${escape(ctx.recipientName)},`,
      body: `Le provisioning Microsoft Teams du projet <strong style="color:#fff">${escape(p.projectName)}</strong> a <strong style="color:#fff">échoué</strong> après ${p.attempts} tentative${p.attempts !== 1 ? 's' : ''} et ne sera plus relancé automatiquement. L'équipe est peut-être absente ou désynchronisée — vérifiez la configuration (membres liés à Entra, identifiants Graph) et relancez manuellement depuis l'onglet Intégrations du projet.`,
      rowProject: 'Projet',
      rowAction: 'Action',
      rowAttempts: 'Tentatives',
      rowError: 'Erreur',
      footer1: "Le détail est tracé dans Admin &gt; Security &amp; Compliance &gt; Journal d'audit.",
      footer2: `Vous recevez ce message car vous êtes administrateur de ${escape(ctx.orgName)}.`,
      text: `Échec du provisioning Microsoft Teams pour ${p.projectName} (action : ${p.action}, ${p.attempts} tentative(s)) : ${p.error}. Voir Admin > Journal d'audit.`,
    },
    it: {
      subject: `⛔ Provisioning Microsoft Teams non riuscito — ${p.projectName}`,
      heading: 'Provisioning Microsoft Teams non riuscito',
      hello: `Buongiorno ${escape(ctx.recipientName)},`,
      body: `Il provisioning Microsoft Teams del progetto <strong style="color:#fff">${escape(p.projectName)}</strong> <strong style="color:#fff">non è riuscito</strong> dopo ${p.attempts} tentativo/i e non verrà ritentato automaticamente. Il team potrebbe mancare o essere disallineato — controlla la configurazione (membri collegati a Entra, credenziali Graph) e riprova manualmente dalla scheda Integrazioni del progetto.`,
      rowProject: 'Progetto',
      rowAction: 'Azione',
      rowAttempts: 'Tentativi',
      rowError: 'Errore',
      footer1: "I dettagli sono registrati in Admin &gt; Security &amp; Compliance &gt; Registro di audit.",
      footer2: `Ricevi questo messaggio perché sei amministratore di ${escape(ctx.orgName)}.`,
      text: `Provisioning Microsoft Teams non riuscito per ${p.projectName} (azione: ${p.action}, ${p.attempts} tentativo/i): ${p.error}. Vedi Admin > Registro di audit.`,
    },
    de: {
      subject: `⛔ Microsoft-Teams-Provisioning fehlgeschlagen — ${p.projectName}`,
      heading: 'Microsoft-Teams-Provisioning fehlgeschlagen',
      hello: `Hallo ${escape(ctx.recipientName)},`,
      body: `Das Microsoft-Teams-Provisioning für das Projekt <strong style="color:#fff">${escape(p.projectName)}</strong> ist nach ${p.attempts} Versuch(en) <strong style="color:#fff">fehlgeschlagen</strong> und wird nicht automatisch wiederholt. Das Team fehlt möglicherweise oder ist nicht synchron — prüfen Sie die Konfiguration (Entra-Mitgliedschaft, Graph-Zugangsdaten) und starten Sie es manuell im Reiter „Integrationen“ des Projekts erneut.`,
      rowProject: 'Projekt',
      rowAction: 'Aktion',
      rowAttempts: 'Versuche',
      rowError: 'Fehler',
      footer1: 'Details werden unter Admin &gt; Security &amp; Compliance &gt; Audit-Protokoll erfasst.',
      footer2: `Sie erhalten diese Nachricht, weil Sie Administrator von ${escape(ctx.orgName)} sind.`,
      text: `Microsoft-Teams-Provisioning fehlgeschlagen für ${p.projectName} (Aktion: ${p.action}, ${p.attempts} Versuch(e)): ${p.error}. Siehe Admin > Audit-Protokoll.`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.hello}</p>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#1c1c28;border-radius:8px;padding:12px 14px;color:#d4d4e0;font-size:13px">
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowProject)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.projectName)}</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowAction)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.action)}</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0">${escape(t.rowAttempts)}</td><td style="padding:2px 0"><strong style="color:#fff">${p.attempts}</strong></td></tr>
      <tr><td style="padding:2px 18px 2px 0;vertical-align:top">${escape(t.rowError)}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.error)}</strong></td></tr>
    </table>
    <p style="margin:16px 0 0;color:#c4c4d4">${t.footer1}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#8a8a99">${t.footer2}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

/** Payload du mail « offre commerciale » envoyé au contact client. */
export interface OfferPayload {
  /** Nom du projet (objet de l'offre). */
  projectName: string;
  /** Nom du client / société (peut être null si non renseigné). */
  clientName: string | null;
  /** Nom du fichier d'offre joint (affiché dans le corps). */
  attachmentName: string;
  /** Message d'introduction optionnel (sinon texte par défaut). */
  intro?: string;
}

export function renderOffer(ctx: TemplateContext, p: OfferPayload): RenderedEmail {
  const hasIntro = !!(p.intro && p.intro.trim());
  const t = L(ctx.lang, {
    en: {
      subject: `Your offer — ${p.projectName}`,
      hello: `Hello${p.clientName ? ' ' + escape(p.clientName) : ''},`,
      defaultIntroHtml: `Please find attached our offer regarding <strong>${escape(p.projectName)}</strong>. We remain at your disposal for any questions.`,
      defaultIntroText: `Please find attached our offer regarding ${p.projectName}.`,
      attachment: '📎 Attached document',
      footer: `This message was sent by ${escape(ctx.orgName)}.`,
    },
    fr: {
      subject: `Votre offre — ${p.projectName}`,
      hello: `Bonjour${p.clientName ? ' ' + escape(p.clientName) : ''},`,
      defaultIntroHtml: `Veuillez trouver ci-joint notre offre concernant <strong>${escape(p.projectName)}</strong>. Nous restons à votre disposition pour toute question.`,
      defaultIntroText: `Veuillez trouver ci-joint notre offre concernant ${p.projectName}.`,
      attachment: '📎 Document joint',
      footer: `Ce message a été envoyé par ${escape(ctx.orgName)}.`,
    },
    it: {
      subject: `La tua offerta — ${p.projectName}`,
      hello: `Buongiorno${p.clientName ? ' ' + escape(p.clientName) : ''},`,
      defaultIntroHtml: `In allegato la nostra offerta relativa a <strong>${escape(p.projectName)}</strong>. Restiamo a vostra disposizione per qualsiasi domanda.`,
      defaultIntroText: `In allegato la nostra offerta relativa a ${p.projectName}.`,
      attachment: '📎 Documento allegato',
      footer: `Questo messaggio è stato inviato da ${escape(ctx.orgName)}.`,
    },
    de: {
      subject: `Ihr Angebot — ${p.projectName}`,
      hello: `Guten Tag${p.clientName ? ' ' + escape(p.clientName) : ''},`,
      defaultIntroHtml: `Anbei finden Sie unser Angebot zu <strong>${escape(p.projectName)}</strong>. Für Fragen stehen wir Ihnen gerne zur Verfügung.`,
      defaultIntroText: `Anbei finden Sie unser Angebot zu ${p.projectName}.`,
      attachment: '📎 Angehängtes Dokument',
      footer: `Diese Nachricht wurde von ${escape(ctx.orgName)} gesendet.`,
    },
  });
  const introHtml = hasIntro ? escape(p.intro!.trim()) : t.defaultIntroHtml;
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(p.projectName)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.hello}</p>
    <p style="margin:0 0 16px;color:#c4c4d4">${introHtml}</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#1c1c28;border-radius:8px;padding:12px 14px;color:#d4d4e0;font-size:13px">
      <tr><td style="padding:2px 18px 2px 0">${t.attachment}</td><td style="padding:2px 0"><strong style="color:#fff">${escape(p.attachmentName)}</strong></td></tr>
    </table>
    <p style="margin:18px 0 0;color:#8a8a99;font-size:12px">${t.footer}</p>`;
  const helloText = L(ctx.lang, {
    en: `Hello${p.clientName ? ' ' + p.clientName : ''},`,
    fr: `Bonjour${p.clientName ? ' ' + p.clientName : ''},`,
    it: `Buongiorno${p.clientName ? ' ' + p.clientName : ''},`,
    de: `Guten Tag${p.clientName ? ' ' + p.clientName : ''},`,
  });
  const attachLabel = L(ctx.lang, {
    en: 'Attached document',
    fr: 'Document joint',
    it: 'Documento allegato',
    de: 'Angehängtes Dokument',
  });
  const text =
    `${helloText}\n\n` +
    (hasIntro ? p.intro!.trim() : t.defaultIntroText) +
    `\n\n${attachLabel}: ${p.attachmentName}\n\n${ctx.orgName}`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text };
}

export interface BillingExportPayload {
  period: string;
  rowCount: number;
  filename: string;
}

export function renderBillingExport(ctx: TemplateContext, p: BillingExportPayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `Billing export — ${p.period}`,
      heading: 'Scheduled billing export',
      hello: `Hello ${escape(ctx.recipientName)},`,
      body: `Your scheduled billing export for <strong style="color:#fff">${escape(p.period)}</strong> is attached (${p.rowCount} line${p.rowCount !== 1 ? 's' : ''}). The file is named <strong style="color:#fff">${escape(p.filename)}</strong>.`,
      footer: `You receive this message because billing exports are configured for ${escape(ctx.orgName)}.`,
      text: `Billing export ${p.period}: ${p.rowCount} rows. File: ${p.filename}.`,
    },
    fr: {
      subject: `Export facturation — ${p.period}`,
      heading: 'Export facturation planifié',
      hello: `Bonjour ${escape(ctx.recipientName)},`,
      body: `Votre export facturation planifié pour <strong style="color:#fff">${escape(p.period)}</strong> est joint (${p.rowCount} ligne${p.rowCount !== 1 ? 's' : ''}). Le fichier s'appelle <strong style="color:#fff">${escape(p.filename)}</strong>.`,
      footer: `Vous recevez ce message car des exports facturation sont configurés pour ${escape(ctx.orgName)}.`,
      text: `Export facturation ${p.period} : ${p.rowCount} lignes. Fichier : ${p.filename}.`,
    },
    it: {
      subject: `Export fatturazione — ${p.period}`,
      heading: 'Export fatturazione pianificato',
      hello: `Buongiorno ${escape(ctx.recipientName)},`,
      body: `Il tuo export fatturazione pianificato per <strong style="color:#fff">${escape(p.period)}</strong> è allegato (${p.rowCount} riga${p.rowCount !== 1 ? 'he' : ''}). Il file si chiama <strong style="color:#fff">${escape(p.filename)}</strong>.`,
      footer: `Ricevi questo messaggio perché gli export fatturazione sono configurati per ${escape(ctx.orgName)}.`,
      text: `Export fatturazione ${p.period}: ${p.rowCount} righe. File: ${p.filename}.`,
    },
    de: {
      subject: `Abrechnungsexport — ${p.period}`,
      heading: 'Geplanter Abrechnungsexport',
      hello: `Hallo ${escape(ctx.recipientName)},`,
      body: `Ihr geplanter Abrechnungsexport für <strong style="color:#fff">${escape(p.period)}</strong> ist beigefügt (${p.rowCount} Zeile${p.rowCount !== 1 ? 'n' : ''}). Die Datei heißt <strong style="color:#fff">${escape(p.filename)}</strong>.`,
      footer: `Sie erhalten diese Nachricht, weil Abrechnungsexporte für ${escape(ctx.orgName)} konfiguriert sind.`,
      text: `Abrechnungsexport ${p.period}: ${p.rowCount} Zeilen. Datei: ${p.filename}.`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.hello}</p>
    <p style="margin:0 0 16px;color:#c4c4d4">${t.body}</p>
    <p style="margin:20px 0 0;font-size:12px;color:#8a8a99">${t.footer}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}

export interface AutomationAlertPayload {
  /** Sujet complet du mail (déjà localisé — voir automations-i18n.ts). */
  subject: string;
  heading: string;
  /** Corps HTML DÉJÀ échappé (produit par automations-i18n.ts). */
  bodyHtml: string;
  text: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

/**
 * Template générique des alertes d'automatisation built-in : le shell brandé
 * standard autour d'un contenu entièrement fourni par `automations-i18n.ts`
 * (une seule entrée `EmailTemplateKey` pour toutes les règles).
 */
export function renderAutomationAlert(ctx: TemplateContext, p: AutomationAlertPayload): RenderedEmail {
  const button = p.ctaLabel && p.ctaUrl ? `<p style="margin:24px 0 0">${cta(ctx, p.ctaLabel, p.ctaUrl)}</p>` : '';
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(p.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${p.bodyHtml}</p>
    ${button}`;
  const text = p.ctaUrl ? `${p.text}\n${p.ctaUrl}` : p.text;
  return { subject: p.subject, html: shell(ctx, body, p.subject), text };
}

export interface AnnouncementPayload {
  /** Auteur résolu depuis le PRINCIPAL du jeton (jamais déclaratif). */
  authorName: string;
  /** true si la requête est passée par l'assistant (header X-Vaks-Agent). */
  viaAssistant: boolean;
  projectName: string;
  /** Titre libre (rédigé par l'humain/LLM) — le sujet reste préfixé serveur. */
  title: string;
  /** Corps libre en TEXTE BRUT : échappé au rendu, jamais interprété comme
   *  HTML/markdown, URLs laissées en texte (non linkifiées — anti-phishing). */
  body: string;
  /** CTA généré serveur (lien projet/tâche dans l'app) — seule URL cliquable. */
  ctaUrl: string;
}

/**
 * Annonce projet : contenu libre dans l'enveloppe fixe. Le serveur contrôle le
 * sujet (préfixe org/projet), la ligne d'attribution, l'échappement du corps et
 * l'unique lien cliquable ; l'auteur (humain ou via assistant) ne contrôle que
 * `title`/`body`.
 */
export function renderAnnouncement(ctx: TemplateContext, p: AnnouncementPayload): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      sentBy: p.viaAssistant
        ? `Sent by ${p.authorName} via the AI assistant — project ${p.projectName}`
        : `Sent by ${p.authorName} — project ${p.projectName}`,
      cta: 'Open the project',
      announcement: 'Announcement',
    },
    fr: {
      sentBy: p.viaAssistant
        ? `Envoyé par ${p.authorName} via l'assistant IA — projet ${p.projectName}`
        : `Envoyé par ${p.authorName} — projet ${p.projectName}`,
      cta: 'Ouvrir le projet',
      announcement: 'Annonce',
    },
    it: {
      sentBy: p.viaAssistant
        ? `Inviato da ${p.authorName} tramite l'assistente IA — progetto ${p.projectName}`
        : `Inviato da ${p.authorName} — progetto ${p.projectName}`,
      cta: 'Apri il progetto',
      announcement: 'Annuncio',
    },
    de: {
      sentBy: p.viaAssistant
        ? `Gesendet von ${p.authorName} über den KI-Assistenten — Projekt ${p.projectName}`
        : `Gesendet von ${p.authorName} — Projekt ${p.projectName}`,
      cta: 'Projekt öffnen',
      announcement: 'Ankündigung',
    },
  });
  // Sujet contrôlé serveur : les filtres de messagerie reconnaissent la source
  // quel que soit le titre rédigé.
  const subject = `[${ctx.orgName}] ${p.projectName} — ${p.title}`;
  const bodyHtml = escape(p.body).replace(/\r?\n/g, '<br />');
  const body = `
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a8a99">${escape(t.announcement)}</p>
    <h2 style="margin:0 0 8px;font-size:18px;color:#fff">${escape(p.title)}</h2>
    <p style="margin:0 0 16px;font-size:12px;color:#8a8a99">${escape(t.sentBy)}</p>
    <p style="margin:0 0 16px;color:#c4c4d4">${bodyHtml}</p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, p.ctaUrl)}</p>`;
  const text = `${t.announcement} — ${p.projectName}\n${p.title}\n${t.sentBy}\n\n${p.body}\n\n${p.ctaUrl}`;
  return { subject, html: shell(ctx, body, p.title), text };
}

export function renderTest(ctx: TemplateContext): RenderedEmail {
  const t = L(ctx.lang, {
    en: {
      subject: `Test email from ${ctx.branding.fromName}`,
      heading: 'SMTP test successful',
      body: "If you're reading this, your outbound email is working. Branding preview:",
      cta: 'Accent button',
      text: `SMTP test successful. ${ctx.appUrl}`,
    },
    fr: {
      subject: `Email de test de ${ctx.branding.fromName}`,
      heading: 'Test SMTP réussi',
      body: 'Si vous lisez ceci, votre envoi d\'emails fonctionne. Aperçu du branding :',
      cta: "Bouton d'accentuation",
      text: `Test SMTP réussi. ${ctx.appUrl}`,
    },
    it: {
      subject: `Email di prova da ${ctx.branding.fromName}`,
      heading: 'Test SMTP riuscito',
      body: 'Se stai leggendo questo, il tuo invio di email funziona. Anteprima del branding:',
      cta: 'Pulsante accento',
      text: `Test SMTP riuscito. ${ctx.appUrl}`,
    },
    de: {
      subject: `Test-E-Mail von ${ctx.branding.fromName}`,
      heading: 'SMTP-Test erfolgreich',
      body: 'Wenn Sie dies lesen, funktioniert Ihr E-Mail-Versand. Branding-Vorschau:',
      cta: 'Akzent-Schaltfläche',
      text: `SMTP-Test erfolgreich. ${ctx.appUrl}`,
    },
  });
  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${escape(t.heading)}</h2>
    <p style="margin:0 0 16px;color:#c4c4d4">${escape(t.body)}</p>
    <p style="margin:24px 0 0">${cta(ctx, t.cta, ctx.appUrl)}</p>`;
  return { subject: t.subject, html: shell(ctx, body, t.subject), text: t.text };
}
