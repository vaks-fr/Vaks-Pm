import nodemailer, { Transporter } from 'nodemailer';
import { EmailJob } from '../queues';
import { SmtpConfig, getSmtpConfig, invalidateSmtpCache, reportDelivery } from '../smtp-config';

let transporter: Transporter | null = null;
let lastSig: string | null = null;

/**
 * Construit (ou réutilise) un transporter nodemailer. Si la conf SMTP courante
 * diffère du dernier transporter créé, on en recrée un (signature = host+port+
 * encryption+authMode+user). Évite de re-créer la connexion à chaque mail tout
 * en restant réactif aux changements de conf admin (cache TTL 60s).
 *
 * Mode `anonymous` : pas d'`auth` passé à nodemailer → SMTP sans authentification
 * (relais d'entreprise qui acceptent le trafic interne sans login). C'est un
 * cas fréquent on-premise.
 */
function buildTransporter(cfg: SmtpConfig): Transporter {
  // Le mot de passe fait partie de la signature : un changement de mot de passe
  // (ou un job d'un autre tenant avec un mot de passe différent) doit recréer le
  // transporter. La signature reste en mémoire, jamais journalisée.
  const sig = `${cfg.host}|${cfg.port}|${cfg.encryption}|${cfg.authMode}|${cfg.user ?? ''}|${cfg.password ?? ''}`;
  if (transporter && sig === lastSig) return transporter;
  const secure = cfg.encryption === 'ssl';
  const requireTLS = cfg.encryption === 'starttls';
  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure,
    requireTLS,
    auth:
      cfg.authMode === 'password' && cfg.user
        ? { user: cfg.user, pass: cfg.password ?? '' }
        : undefined,
  });
  lastSig = sig;
  return transporter;
}

export async function processEmail(job: EmailJob): Promise<void> {
  // Conf globale (fallback dev/legacy) — fournit aussi les défauts From/Reply-To
  // et le mot de passe d'env (Swarm secret). En pooled, le producteur (API)
  // attache `job.smtp` résolu pour le BON tenant : on la fait primer pour les
  // champs de transport, en gardant l'env comme fallback de mot de passe.
  const base = await getSmtpConfig();
  const cfg: SmtpConfig =
    job.smtp && job.smtp.host
      ? {
          ...base,
          host: job.smtp.host,
          port: job.smtp.port,
          encryption: job.smtp.encryption,
          authMode: job.smtp.authMode,
          user: job.smtp.user,
          password: job.smtp.password || base.password || null,
        }
      : base;
  // Pas de SMTP configuré → on logge et on marque la livraison comme FAILED
  // (avec raison claire) pour que l'admin voie le souci dans le journal.
  if (!cfg.host) {
    console.log(`[email:nohost] -> ${job.to} | ${job.subject}`);
    if (job.deliveryId) await reportDelivery(job.deliveryId, 'FAILED', 'SMTP host not configured', job.tenantSlug);
    return;
  }
  // Si auth password attendu mais SMTP_PASSWORD absent → log clair côté ops.
  if (cfg.authMode === 'password' && cfg.user && !cfg.password) {
    const msg = 'SMTP_PASSWORD env var missing (Swarm secret not mounted on worker)';
    console.error(`[email:noauth] ${msg}`);
    if (job.deliveryId) await reportDelivery(job.deliveryId, 'FAILED', msg, job.tenantSlug);
    return;
  }

  const fromName = job.fromName ?? cfg.fromName;
  const fromAddress = job.fromAddress ?? cfg.fromAddress;
  const replyTo = job.replyTo ?? cfg.replyTo ?? undefined;

  // CID inline attachments (logo org…) — nodemailer transforme chaque entrée
  // avec `cid` en `Content-Disposition: inline` + `Content-ID`, et le HTML
  // peut référencer via `<img src="cid:xxx">`. Aucune URL publique requise.
  const attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
    cid?: string;
  }> = (job.inlineImages ?? []).map((img) => ({
    filename: img.filename ?? `${img.cid}.bin`,
    content: Buffer.from(img.base64, 'base64'),
    cid: img.cid,
    contentType: img.contentType,
  }));

  // Pièces jointes « fichier » (offre commerciale…) : pas de `cid` → nodemailer
  // les traite en Content-Disposition: attachment.
  for (const att of job.attachments ?? []) {
    attachments.push({
      filename: att.filename,
      content: Buffer.from(att.contentBase64, 'base64'),
      contentType: att.contentType,
    });
  }

  try {
    await buildTransporter(cfg).sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: job.to,
      subject: job.subject,
      text: job.text,
      html: job.html,
      replyTo,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    if (job.deliveryId) await reportDelivery(job.deliveryId, 'SENT', undefined, job.tenantSlug);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[email:fail] ${job.to} | ${msg}`);
    // Invalide le cache : un host/port changé entre temps doit être repris au
    // prochain retry BullMQ sans attendre 60 s.
    invalidateSmtpCache();
    if (job.deliveryId) await reportDelivery(job.deliveryId, 'FAILED', msg, job.tenantSlug);
    throw err; // pour que BullMQ déclenche le retry
  }
}
