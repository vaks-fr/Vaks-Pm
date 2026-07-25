import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import {
  NotificationsService,
  EMAIL_DELIVERY_RETENTION_DAYS,
  emailDeliveryCutoff,
} from './notifications.service';
import { readNotificationsSettings, NotificationsSettings } from './notifications-settings';
import { getEmailQueue } from './email-queue';
import { renderDigest, TemplateContext, Lang } from './email-templates';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import { WebhooksService } from '../webhooks/webhooks.service';

const HOUR_MS = 60 * 60 * 1000;
const PURGE_BATCH = 5_000;

/**
 * Cron natif (setInterval) — pas de @nestjs/schedule pour rester léger.
 *
 * - Toutes les heures : check des tâches dont la due date tombe dans
 *   [now, now + dueLeadDays jours] et qui ont au moins un assignee. Envoie
 *   un rappel par assignee. Pour éviter les doublons, on ne déclenche qu'une
 *   fois par tâche (déduplication par `EmailDelivery` template=due + taskId).
 *
 * - Toutes les heures : pour chaque org dont l'heure courante = digestHour et
 *   digest != 'off', on construit un digest des updates depuis le dernier
 *   envoi (24h pour daily, 7j pour weekly) et l'envoie à chaque membre actif.
 *
 * En cluster Swarm, plusieurs instances API tournent simultanément. Pour éviter
 * les envois N fois, on prend un lock Redis simple (SETNX + TTL) avant chaque
 * tick. Si on n'obtient pas le lock, on skip.
 */
@Injectable()
export class NotificationsCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NotificationsCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
    private readonly tenantUrl: TenantUrlService,
    private readonly webhooks: WebhooksService,
  ) {}

  onModuleInit() {
    // Première exécution dans 60s pour laisser le boot terminer, puis chaque heure.
    this.timer = setInterval(() => {
      void this.tick();
    }, HOUR_MS);
    setTimeout(() => void this.tick(), 60_000);
    this.log.log('Notifications cron armé (interval 1h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposé pour test manuel (route admin). */
  async tick(): Promise<void> {
    // Lock distribué simple via BullMQ Redis (réutilise la connexion existante).
    // SET NX EX 3300 — TTL juste sous 1h pour qu'un crash libère le slot.
    const queue = getEmailQueue();
    const client = await queue.client;
    const lockKey = `vaks:notif-cron:${new Date().toISOString().slice(0, 13)}`; // par heure UTC
    // ioredis variadic SET — cast pour contourner les types qui n'autorisent que 2-3 args.
    const ok = await (client as unknown as {
      set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
    }).set(lockKey, '1', 'EX', 3300, 'NX');
    if (ok !== 'OK') {
      this.log.debug(`tick skip (lock held: ${lockKey})`);
      return;
    }

    // Multi-tenant : en mode pooled, on itère chaque base tenant dans son
    // contexte (sinon `this.prisma` ne voit que la base de base et le cron ne
    // tourne pour AUCUN tenant). En dedicated : la base courante suffit.
    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.processAllOrgs());
        } catch (err) {
          this.log.warn(`tick tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    } else {
      await this.processAllOrgs();
    }
  }

  /** Traite toutes les orgs de la base courante (contexte tenant déjà posé). */
  private async processAllOrgs(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true, name: true } });
    for (const org of orgs) {
      try {
        await this.runDueReminders(org.id);
        await this.runDigest(org.id, org.name);
        await this.runApiTokenExpiryReminders(org.id);
        await this.runConnectorSecretExpiryReminders(org.id);
        await this.purgeOldDeliveries(org.id);
      } catch (err) {
        this.log.warn(`tick org=${org.id} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Slugs des tenants (mode pooled) : énumère les bases `<db>_<slug>`. */
  private async tenantSlugs(): Promise<string[]> {
    const base = process.env.DATABASE_URL;
    if (!base) return [];
    let dbName: string;
    try {
      dbName = new URL(base).pathname.replace(/^\//, '') || 'vakspm';
    } catch {
      return [];
    }
    // `\_` = underscore littéral (sinon `_` est un joker LIKE). Backslash =
    // caractère d'échappement par défaut de LIKE en Postgres.
    const rows = await this.prisma.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${dbName}\\_%'`,
    );
    // Le suffixe (avec underscores) re-mappe vers la même base via getClient.
    return rows.map((r) => r.datname.slice(dbName.length + 1)).filter(Boolean);
  }

  // ============================================================
  // Purge du journal d'envois
  // ============================================================

  /**
   * Supprime les `EmailDelivery` sortis de la fenêtre de rétention. Lots de
   * 5000 en SQL brut (`deleteMany` n'a pas de LIMIT) pour ne pas tenir une
   * transaction longue sur une table qui n'avait jamais été purgée.
   *
   * Tourne APRÈS `runDueReminders`, qui relit ces lignes pour dédupliquer.
   */
  private async purgeOldDeliveries(orgId: string): Promise<void> {
    const cutoff = emailDeliveryCutoff();
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRawUnsafe(
        `DELETE FROM "EmailDelivery" WHERE id IN (
           SELECT id FROM "EmailDelivery"
           WHERE "organizationId" = $1 AND "queuedAt" < $2
           LIMIT ${PURGE_BATCH})`,
        orgId,
        cutoff,
      );
      total += n;
      if (n < PURGE_BATCH) break;
      await new Promise((r) => setTimeout(r, 250)); // souffle entre les lots
    }
    if (total > 0) {
      this.log.log(
        `email delivery purge org=${orgId}: ${total} row(s) older than ${EMAIL_DELIVERY_RETENTION_DAYS}d deleted`,
      );
    }
  }

  // ============================================================
  // Rappel d'expiration des jetons API
  // ============================================================

  private async runApiTokenExpiryReminders(orgId: string): Promise<void> {
    const now = new Date();
    const reminderWindowMs = 14 * 24 * HOUR_MS; // 2 semaines avant
    const horizon = new Date(now.getTime() + reminderWindowMs);
    const tokens = await this.prisma.apiToken.findMany({
      where: {
        organizationId: orgId,
        revokedAt: null,
        expiryReminderSentAt: null,
        expiresAt: { gte: now, lte: horizon },
      },
    });
    // Ignorer les jetons court-vécus / auto-renouvelés (ex. access tokens OAuth
    // MCP à TTL 1h nommés « MCP (vaks_mcpc_…) »). Leur durée de vie totale est
    // plus courte que la fenêtre de rappel : ils naissent déjà « bientôt expirés »
    // et sont rotés automatiquement → un rappel serait du spam à chaque émission.
    const remindable = tokens.filter(
      (t) => t.expiresAt && t.expiresAt.getTime() - t.createdAt.getTime() >= reminderWindowMs,
    );
    if (remindable.length === 0) return;
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));

    for (const t of remindable) {
      const exp = t.expiresAt ? t.expiresAt.toISOString().slice(0, 10) : '—';
      try {
        if (t.type === 'USER' && t.userId) {
          const u = await this.prisma.user.findFirst({
            where: { id: t.userId, organizationId: orgId, deletedAt: null, status: 'ACTIVE' },
            select: { email: true, name: true, kind: true, ownerId: true, preferredLanguage: true },
          });
          if (u && u.kind === 'AGENT') {
            // Le jeton appartient à un AGENT : son email est `@agents.invalid`,
            // que personne ne lit. On notifie son RESPONSABLE HUMAIN à la place,
            // avec le nom de l'agent pour qu'il sache lequel renouveler.
            const owner = u.ownerId
              ? await this.prisma.user.findFirst({
                  where: { id: u.ownerId, organizationId: orgId, kind: 'HUMAN', deletedAt: null, status: 'ACTIVE' },
                  select: { email: true, name: true, preferredLanguage: true },
                })
              : null;
            if (owner) {
              const lang = await this.notifications.resolveRecipientLanguage(orgId, owner.preferredLanguage);
              await this.sendExpiryMail(orgId, owner.email, owner.name, `${t.name} — ${u.name}`, exp, prefs, false, lang);
            } else {
              this.log.warn(`[api-token] jeton agent « ${t.name} » (org ${orgId}) expire le ${exp} mais aucun owner humain actif à notifier`);
            }
          } else if (u) {
            const lang = await this.notifications.resolveRecipientLanguage(orgId, u.preferredLanguage);
            await this.sendExpiryMail(orgId, u.email, u.name, t.name, exp, prefs, false, lang);
          }
        } else if (t.type === 'ORG') {
          // Trace dans les logs (exigence) + email à tous les admins globaux.
          this.log.warn(`[api-token] clé ORG « ${t.name} » (org ${orgId}) expire le ${exp}`);
          const admins = await this.prisma.user.findMany({
            where: { organizationId: orgId, isAdmin: true, deletedAt: null, status: 'ACTIVE' },
            select: { email: true, name: true, preferredLanguage: true },
          });
          for (const a of admins) {
            const lang = await this.notifications.resolveRecipientLanguage(orgId, a.preferredLanguage);
            await this.sendExpiryMail(orgId, a.email, a.name, t.name, exp, prefs, true, lang);
          }
        }
        await this.prisma.apiToken.update({
          where: { id: t.id },
          data: { expiryReminderSentAt: now },
        });
      } catch (err) {
        this.log.warn(`api-token reminder ${t.id} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Libellé localisé de la période du digest (utilisé dans le sujet/titre). */
  private digestPeriodLabel(lang: Lang, weekly: boolean): string {
    const table: Record<Lang, { weekly: string; daily: string }> = {
      en: { weekly: 'weekly', daily: 'daily' },
      fr: { weekly: 'hebdomadaire', daily: 'quotidien' },
      it: { weekly: 'settimanale', daily: 'giornaliero' },
      de: { weekly: 'wöchentliche', daily: 'tägliche' },
    };
    const row = table[lang] ?? table.en;
    return weekly ? row.weekly : row.daily;
  }

  /** Mot « échéance » localisé pour le sous-titre d'un item de digest. */
  private digestDueWord(lang: Lang): string {
    const table: Record<Lang, string> = { en: 'due', fr: 'échéance', it: 'scadenza', de: 'fällig' };
    return table[lang] ?? table.en;
  }

  private async sendExpiryMail(
    orgId: string,
    to: string,
    recipientName: string,
    tokenName: string,
    exp: string,
    prefs: NotificationsSettings,
    isOrg: boolean,
    lang: Lang = 'en',
  ): Promise<void> {
    const strings: Record<Lang, {
      subjectOrg: string;
      subjectUser: string;
      whatOrg: string;
      whatUser: string;
      hello: string;
      expires: string;
      regenerate: string;
    }> = {
      en: {
        subjectOrg: `Organization API key "${tokenName}" expires on ${exp}`,
        subjectUser: `Your API token "${tokenName}" expires on ${exp}`,
        whatOrg: `The organization API key <strong>${tokenName}</strong>`,
        whatUser: `Your API token <strong>${tokenName}</strong>`,
        hello: `Hello ${recipientName},`,
        expires: `will expire on <strong>${exp}</strong>.`,
        regenerate: 'Regenerate it before this date if integrations rely on it, otherwise the calls will be rejected.',
      },
      fr: {
        subjectOrg: `Clé API organisation « ${tokenName} » expire le ${exp}`,
        subjectUser: `Votre jeton API « ${tokenName} » expire le ${exp}`,
        whatOrg: `La clé API d'organisation <strong>${tokenName}</strong>`,
        whatUser: `Votre jeton API <strong>${tokenName}</strong>`,
        hello: `Bonjour ${recipientName},`,
        expires: `expirera le <strong>${exp}</strong>.`,
        regenerate: 'Régénérez-le avant cette date si des intégrations en dépendent, sinon les appels seront refusés.',
      },
      it: {
        subjectOrg: `La chiave API dell'organizzazione "${tokenName}" scade il ${exp}`,
        subjectUser: `Il tuo token API "${tokenName}" scade il ${exp}`,
        whatOrg: `La chiave API dell'organizzazione <strong>${tokenName}</strong>`,
        whatUser: `Il tuo token API <strong>${tokenName}</strong>`,
        hello: `Buongiorno ${recipientName},`,
        expires: `scadrà il <strong>${exp}</strong>.`,
        regenerate: 'Rigeneralo prima di questa data se delle integrazioni vi dipendono, altrimenti le chiamate verranno rifiutate.',
      },
      de: {
        subjectOrg: `Organisations-API-Schlüssel „${tokenName}" läuft am ${exp} ab`,
        subjectUser: `Ihr API-Token „${tokenName}" läuft am ${exp} ab`,
        whatOrg: `Der Organisations-API-Schlüssel <strong>${tokenName}</strong>`,
        whatUser: `Ihr API-Token <strong>${tokenName}</strong>`,
        hello: `Hallo ${recipientName},`,
        expires: `läuft am <strong>${exp}</strong> ab.`,
        regenerate: 'Erneuern Sie ihn vor diesem Datum, wenn Integrationen davon abhängen, andernfalls werden die Aufrufe abgelehnt.',
      },
    };
    const s = strings[lang] ?? strings.en;
    const subject = isOrg ? s.subjectOrg : s.subjectUser;
    const what = isOrg ? s.whatOrg : s.whatUser;
    const html =
      `<p>${s.hello}</p>` +
      `<p>${what} ${s.expires} ${s.regenerate}</p>`;
    const text = `${subject}. ${s.regenerate}`;
    await this.notifications.enqueue(orgId, to, 'api_token_expiry', { subject, html, text }, prefs);
  }

  // ============================================================
  // Rappel d'expiration des SECRETS de connecteurs (optionnel)
  // ============================================================
  // Les secrets de connecteurs tiers (Entra, ticketing, SMTP, syslog…) sont
  // gérés côté fournisseur : Vaks ne connaît pas leur expiration et ne peut donc
  // pas prévenir. Si l'admin renseigne une date d'expiration (champ OPTIONNEL),
  // on l'alerte J-14 comme pour les jetons API. Rien de mandatory : sans date,
  // rien ne se passe (comportement historique).

  /** Clés `OrgSetting` portant une date d'expiration de secret (option admin). */
  private static readonly SECRET_EXPIRY_SETTINGS: { key: string; label: string }[] = [
    { key: 'smtp.passwordExpiresAt', label: 'SMTP (mot de passe)' },
    { key: 'teamsProv.secretExpiresAt', label: 'Provisioning Teams (secret Graph)' },
    { key: 'audit.syslog.clientCertExpiresAt', label: 'Syslog SIEM (certificat client)' },
  ];

  private async runConnectorSecretExpiryReminders(orgId: string): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * 24 * HOUR_MS);
    const items: { label: string; exp: Date }[] = [];

    const scan = (
      rows: { label: string | null; config: unknown }[],
      prefix: string,
    ) => {
      for (const r of rows) {
        const cfg = (r.config ?? {}) as Record<string, unknown>;
        const raw = cfg.secretExpiresAt;
        if (typeof raw !== 'string') continue;
        const d = new Date(raw);
        if (Number.isNaN(d.getTime()) || d < now || d > horizon) continue;
        items.push({ label: `${prefix} — ${r.label ?? ''}`.trim(), exp: d });
      }
    };
    scan(
      await this.prisma.agentConnector.findMany({
        where: { organizationId: orgId },
        select: { label: true, config: true },
      }),
      "Annuaire d'agents",
    );
    scan(
      await this.prisma.ticketingConnector.findMany({
        where: { organizationId: orgId },
        select: { label: true, config: true },
      }),
      'Ticketing',
    );
    scan(
      await this.prisma.fileSourceConnector.findMany({
        where: { organizationId: orgId },
        select: { label: true, config: true },
      }),
      'Source de fichiers',
    );

    const all = await this.settings.getAll(orgId);
    for (const { key, label } of NotificationsCronService.SECRET_EXPIRY_SETTINGS) {
      const raw = all[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const d = new Date(raw.trim());
      if (Number.isNaN(d.getTime()) || d < now || d > horizon) continue;
      items.push({ label, exp: d });
    }

    if (items.length === 0) return;
    const prefs = readNotificationsSettings(all);
    const admins = await this.prisma.user.findMany({
      where: { organizationId: orgId, isAdmin: true, deletedAt: null, status: 'ACTIVE' },
      select: { email: true, name: true, preferredLanguage: true },
    });
    if (admins.length === 0) return;

    for (const item of items) {
      const exp = item.exp.toISOString().slice(0, 10);
      // Dédup (façon due-reminders) : déjà alerté pour ce connecteur récemment ?
      const already = await this.prisma.emailDelivery.findFirst({
        where: {
          organizationId: orgId,
          template: 'connector_secret_expiry',
          subject: { contains: item.label },
          queuedAt: { gte: new Date(now.getTime() - 13 * 24 * HOUR_MS) },
        },
        select: { id: true },
      });
      if (already) continue;
      this.log.warn(`[connector-secret] « ${item.label} » (org ${orgId}) — secret expire le ${exp}`);
      for (const a of admins) {
        const lang = await this.notifications.resolveRecipientLanguage(orgId, a.preferredLanguage);
        await this.sendConnectorSecretExpiryMail(orgId, a.email, a.name, item.label, exp, prefs, lang);
      }
    }
  }

  private async sendConnectorSecretExpiryMail(
    orgId: string,
    to: string,
    recipientName: string,
    connectorLabel: string,
    exp: string,
    prefs: NotificationsSettings,
    lang: Lang = 'en',
  ): Promise<void> {
    const strings: Record<Lang, { subject: string; hello: string; body: string }> = {
      en: {
        subject: `Connector secret "${connectorLabel}" expires on ${exp}`,
        hello: `Hello ${recipientName},`,
        body: `The secret for the connector <strong>${connectorLabel}</strong> will expire on <strong>${exp}</strong>. Renew it on the provider's side and update it in Vaks PM before this date, otherwise this connector will stop working.`,
      },
      fr: {
        subject: `Le secret du connecteur « ${connectorLabel} » expire le ${exp}`,
        hello: `Bonjour ${recipientName},`,
        body: `Le secret du connecteur <strong>${connectorLabel}</strong> expirera le <strong>${exp}</strong>. Renouvelez-le côté fournisseur et mettez-le à jour dans Vaks PM avant cette date, sinon ce connecteur cessera de fonctionner.`,
      },
      it: {
        subject: `Il segreto del connettore "${connectorLabel}" scade il ${exp}`,
        hello: `Ciao ${recipientName},`,
        body: `Il segreto del connettore <strong>${connectorLabel}</strong> scadrà il <strong>${exp}</strong>. Rinnovalo lato fornitore e aggiornalo in Vaks PM prima di questa data, altrimenti il connettore smetterà di funzionare.`,
      },
      de: {
        subject: `Das Geheimnis des Konnektors „${connectorLabel}" läuft am ${exp} ab`,
        hello: `Hallo ${recipientName},`,
        body: `Das Geheimnis des Konnektors <strong>${connectorLabel}</strong> läuft am <strong>${exp}</strong> ab. Erneuern Sie es beim Anbieter und aktualisieren Sie es in Vaks PM vor diesem Datum, sonst funktioniert dieser Konnektor nicht mehr.`,
      },
    };
    const s = strings[lang] ?? strings.en;
    const html = `<p>${s.hello}</p><p>${s.body}</p>`;
    const text = `${s.subject}.`;
    await this.notifications.enqueue(orgId, to, 'connector_secret_expiry', { subject: s.subject, html, text }, prefs);
  }

  // ============================================================
  // Due-date reminders
  // ============================================================

  private async runDueReminders(orgId: string): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled || !prefs.onDueDate) return;

    const now = new Date();
    const horizon = new Date(now.getTime() + prefs.dueLeadDays * 24 * HOUR_MS);
    const tasks = await this.prisma.task.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        dueDate: { gte: now, lte: horizon },
        status: { notIn: ['DONE'] },
        assignees: { some: {} },
      },
      include: { assignees: true, project: { select: { id: true, name: true } } },
    });

    for (const t of tasks) {
      // Dédup : déjà envoyé un rappel pour cette tâche au cours du lead time ?
      const since = new Date(now.getTime() - prefs.dueLeadDays * 24 * HOUR_MS);
      const already = await this.prisma.emailDelivery.findFirst({
        where: {
          organizationId: orgId,
          template: 'due',
          subject: { contains: t.title },
          queuedAt: { gte: since },
        },
        select: { id: true },
      });
      if (already) continue;

      const dueLabel = t.dueDate ? t.dueDate.toISOString().slice(0, 10) : 'soon';
      for (const a of t.assignees) {
        await this.notifications.notifyDue(orgId, a.userId, t.id, dueLabel);
      }

      // Miroir webhook du rappel (les canaux Teams reçoivent l'échéance comme
      // les autres alertes d'automatisation — même event, kind `due_soon`).
      // Gouverné par les mêmes settings `notif.*` que le mail, et couvert par
      // la même déduplication : pas de clé `automations.*` dédiée.
      void this.webhooks.dispatch(
        orgId,
        'automation.alert',
        {
          kind: 'due_soon',
          title: 'A task is due soon',
          message: `"${t.title}" (${t.project.name}) is due ${dueLabel}.`,
          taskId: t.id,
          projectId: t.project.id,
          url: null,
          at: new Date().toISOString(),
        },
        { projectId: t.project.id },
      );
    }
  }

  // ============================================================
  // Digest daily/weekly
  // ============================================================

  private async runDigest(orgId: string, orgName: string): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled || prefs.digest === 'off') return;

    const currentHour = new Date().getUTCHours();
    if (currentHour !== prefs.digestHour) return;

    // Weekly = lundi uniquement.
    if (prefs.digest === 'weekly' && new Date().getUTCDay() !== 1) return;

    const sinceMs = prefs.digest === 'weekly' ? 7 * 24 * HOUR_MS : 24 * HOUR_MS;
    const since = new Date(Date.now() - sinceMs);

    const users = await this.prisma.user.findMany({
      // kind HUMAN : pas de digest pour les agents IA (@agents.invalid).
      where: { organizationId: orgId, deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
      select: { id: true, name: true, email: true, preferredLanguage: true },
    });

    for (const u of users) {
      // Items du digest user = tâches assignées modifiées depuis `since`.
      const items = await this.prisma.task.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          updatedAt: { gte: since },
          assignees: { some: { userId: u.id } },
        },
        select: { id: true, title: true, status: true, dueDate: true },
        take: 20,
        orderBy: { updatedAt: 'desc' },
      });
      if (items.length === 0) continue;

      const lang = await this.notifications.resolveRecipientLanguage(orgId, u.preferredLanguage);
      const ctx: TemplateContext = {
        recipientName: u.name,
        orgName,
        lang,
        // Origine du tenant courant : le cron pose le contexte via
        // `tenantCtx.run` en pooled → jamais l'APP_URL global.
        appUrl: this.tenantUrl.publicBaseUrl(),
        branding: {
          fromName: prefs.fromName,
          accentColor: prefs.accentColor,
          logoUrl: prefs.logoUrl,
        },
      };
      const isWeekly = prefs.digest === 'weekly';
      const periodLabel = this.digestPeriodLabel(lang, isWeekly);
      const dueWord = this.digestDueWord(lang);
      const rendered = renderDigest(ctx, {
        periodLabel,
        items: items.map((t) => ({
          title: t.title,
          url: `${ctx.appUrl.replace(/\/+$/, '')}/tasks/${t.id}`,
          subtitle: `${t.status}${t.dueDate ? ` · ${dueWord} ${t.dueDate.toISOString().slice(0, 10)}` : ''}`,
        })),
      });
      // Délégation au service (création EmailDelivery + embed CID logo + enqueue BullMQ).
      await this.notifications.enqueue(orgId, u.email, 'digest', rendered, prefs);
    }
  }
}
