import { Injectable, Logger } from '@nestjs/common';
import type { EmailDelivery, EmailDeliveryStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { S3Service } from '../storage/s3.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import {
  NotificationsSettings,
  SmtpSettings,
  isQuietHour,
  readNotificationsSettings,
  readSmtpSettings,
} from './notifications-settings';
import {
  EmailTemplateKey,
  OverEstimatePayload,
  RenderedEmail,
  SkillRequestPayload,
  SkillExpiringPayload,
  TemplateContext,
  renderAssignment,
  renderDue,
  renderMention,
  renderOverEstimate,
  renderSkillRequest,
  renderSkillExpiring,
  renderStatus,
  renderTest,
  renderPasswordReset,
  renderOffer,
  renderSecurityAlert,
  SecurityAlertPayload,
  renderBackupAlert,
  BackupAlertPayload,
  renderTeamsProvisionFailed,
  TeamsProvisionFailedPayload,
  renderBillingExport,
  Lang,
  EMAIL_LANGUAGES,
  normalizeEmailLang,
} from './email-templates';
import { EmailJobData, getEmailQueue } from './email-queue';
import {
  USER_NOTIFICATION_EVENT,
  type InboxNotificationDto,
  type InboxListDto,
  type UserNotificationKind,
} from '@vaks-pm/shared';
import { EventsGateway } from '../realtime/events.gateway';

/**
 * Rétention de la boîte de réception in-app (`Notification`). Une notif lue
 * n'a plus de valeur passé quelques semaines ; une non lue est gardée bien plus
 * longtemps (l'utilisateur ne s'est jamais connecté). Purgé par
 * `NotificationsCronService`.
 */
export const INBOX_READ_RETENTION_DAYS = 30;
export const INBOX_UNREAD_RETENTION_DAYS = 180;

/** Payload d'entrée d'une notification durable (voir `persistAndPush`). */
export interface InboxInput {
  kind: UserNotificationKind;
  /** Rendu serveur (automations/admin/annonces) — sinon le front rend via `meta`. */
  title?: string;
  body?: string;
  taskId?: string | null;
  projectId?: string | null;
  url?: string | null;
  /** actorName, fromStatus, toStatus, taskTitle, excerpt, automationKind… */
  meta?: Record<string, unknown>;
}

/**
 * Rétention du journal d'envois. `EmailDelivery` est un outil de debug, pas une
 * piste d'audit (le journal d'audit, lui, a sa propre rétention configurable) :
 * au-delà de 30 jours les lignes n'ont plus de valeur et la table grossit sans
 * borne. Purgé par `NotificationsCronService`, et le listing ne regarde jamais
 * au-delà.
 *
 * ⚠️ La déduplication des rappels d'échéance (`runDueReminders`) relit les
 * `EmailDelivery` sur `notif.dueLeadDays` jours en arrière — clampé à 30 dans
 * `notifications-settings.ts`. Baisser cette rétention sous 30 j réenverrait
 * des rappels en double : baisser le clamp d'abord.
 */
export const EMAIL_DELIVERY_RETENTION_DAYS = 30;

const DELIVERY_STATUSES: EmailDeliveryStatus[] = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'];

/** Borne basse de la fenêtre de rétention (listing + purge partagent le calcul). */
export function emailDeliveryCutoff(now = Date.now()): Date {
  return new Date(now - EMAIL_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Cursor keyset `<queuedAt ms>|<id>` — opaque côté client. */
function decodeDeliveryCursor(cursor?: string): { queuedAt: Date; id: string } | null {
  if (!cursor) return null;
  const [ms, ...rest] = cursor.split('|');
  const t = Number(ms);
  const id = rest.join('|');
  if (!Number.isFinite(t) || !id) return null;
  return { queuedAt: new Date(t), id };
}

/**
 * Orchestrateur des notifications email.
 *
 * Contrats :
 * - Toute méthode `notify*` est fire-and-forget côté appelant : on swallow les
 *   erreurs de rendu/queue pour ne JAMAIS faire planter la mutation métier
 *   (création tâche, commentaire, etc.). Les erreurs SMTP sont gérées par le
 *   worker BullMQ (retries + EmailDelivery.status = FAILED).
 * - Les préférences org (kill switch, type d'event, quiet hours) sont
 *   appliquées AVANT enqueue. Un job qui n'est pas censé partir aujourd'hui
 *   crée une ligne EmailDelivery avec status = SKIPPED + raison, pour audit.
 * - Le branding (logo, accent, fromName, fromAddress, replyTo) est résolu une
 *   seule fois par batch et injecté dans le job pour que le worker n'ait pas à
 *   relire la DB.
 *
 * Les hooks (assignment, mention, due, status) construisent leur payload puis
 * appellent `dispatch`. Pas de batching ici — le digest est un chemin séparé
 * (voir `digestPending`).
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly s3: S3Service,
    private readonly tenant: TenantContext,
    private readonly tenantUrl: TenantUrlService,
    private readonly events: EventsGateway,
  ) {}

  /**
   * Notification in-app (cloche haut-droite) poussée à l'utilisateur cible via
   * la room `user:<id>`. Fire-and-forget : ne doit jamais faire échouer une
   * `notify*`. Émise en parallèle de l'email, mais AVANT les quiet hours /
   * digest (l'in-app est instantané et passif) — elle reste toutefois soumise
   * aux mêmes toggles par-event (`isAllowed`) et opt-out user que l'email, car
   * l'émission n'a lieu qu'après ces garde-fous dans chaque `notify*`.
   */
  private pushInApp(userId: string, payload: Record<string, unknown>): void {
    try {
      this.events.emitToUser(userId, USER_NOTIFICATION_EVENT, payload);
    } catch (err) {
      this.log.warn(`pushInApp failed: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // Boîte de réception in-app durable (cloche).
  // Un seul chokepoint (`persistAndPush`) : crée la ligne `Notification` PUIS
  // pousse le DTO en temps réel sur la room `user:<id>`. Tous les `notify*` et
  // le chokepoint d'automatisation passent par là → la cloche survit au refresh
  // et à l'utilisateur hors-ligne, avec la même couverture que les emails.
  // ==========================================================================

  /** Ligne `Notification` → DTO envoyé au front (WS et REST partagent la forme). */
  private toInboxDto(row: {
    id: string;
    kind: string;
    title: string | null;
    body: string | null;
    taskId: string | null;
    projectId: string | null;
    url: string | null;
    meta: unknown;
    readAt: Date | null;
    createdAt: Date;
  }): InboxNotificationDto {
    const meta = (row.meta && typeof row.meta === 'object' ? row.meta : {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return {
      id: row.id,
      kind: row.kind as UserNotificationKind,
      title: row.title ?? undefined,
      body: row.body ?? undefined,
      taskId: row.taskId ?? undefined,
      projectId: row.projectId ?? undefined,
      url: row.url ?? undefined,
      taskTitle: str(meta.taskTitle),
      actorName: str(meta.actorName),
      excerpt: str(meta.excerpt),
      fromStatus: str(meta.fromStatus),
      toStatus: str(meta.toStatus),
      createdAt: row.createdAt.toISOString(),
      read: row.readAt != null,
    };
  }

  /**
   * Persiste une notification durable pour un destinataire puis la pousse en
   * temps réel. Fire-and-forget : swallow toute erreur (ne doit jamais faire
   * échouer la mutation métier ni l'envoi email). N'émet vers un agent que si
   * jamais (les agents sont notifiés via leur owner ; ici on ne persiste que
   * pour des humains — l'appelant a déjà résolu des destinataires humains).
   */
  async persistAndPush(orgId: string, userId: string, input: InboxInput): Promise<void> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          organizationId: orgId,
          userId,
          kind: input.kind,
          title: input.title ?? null,
          body: input.body ?? null,
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          url: input.url ?? null,
          meta: (input.meta ?? undefined) as never,
        },
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          taskId: true,
          projectId: true,
          url: true,
          meta: true,
          readAt: true,
          createdAt: true,
        },
      });
      this.pushInApp(userId, this.toInboxDto(row) as unknown as Record<string, unknown>);
    } catch (err) {
      this.log.warn(`persistAndPush(${input.kind}) failed: ${(err as Error).message}`);
    }
  }

  /** Cursor keyset `<createdAt ms>|<id>` (opaque côté client). */
  private decodeInboxCursor(cursor?: string): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    const [ms, ...rest] = cursor.split('|');
    const t = Number(ms);
    const id = rest.join('|');
    if (!Number.isFinite(t) || !id) return null;
    return { createdAt: new Date(t), id };
  }

  /**
   * Liste paginée (keyset, plus récentes d'abord) de la boîte de réception de
   * l'utilisateur, + compteur global de non-lues (indépendant de la page).
   */
  async listInbox(
    orgId: string,
    userId: string,
    cursor?: string,
    limit = 30,
  ): Promise<InboxListDto> {
    const take = Math.min(Math.max(1, limit), 100);
    const cur = this.decodeInboxCursor(cursor);
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          organizationId: orgId,
          userId,
          ...(cur
            ? {
                OR: [
                  { createdAt: { lt: cur.createdAt } },
                  { createdAt: cur.createdAt, id: { lt: cur.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          taskId: true,
          projectId: true,
          url: true,
          meta: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({
        where: { organizationId: orgId, userId, readAt: null },
      }),
    ]);
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toInboxDto(r)),
      unreadCount,
      nextCursor: hasMore && last ? `${last.createdAt.getTime()}|${last.id}` : null,
    };
  }

  /** Nombre de non-lues (pastille). */
  async unreadInboxCount(orgId: string, userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { organizationId: orgId, userId, readAt: null },
    });
  }

  /**
   * Marque des notifications comme lues (pastille éteinte). Sans `ids`, marque
   * TOUTES les non-lues de l'utilisateur (ouverture de la cloche). Scopé au
   * user courant : jamais celles d'un autre.
   */
  async markInboxRead(orgId: string, userId: string, ids?: string[]): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: {
        organizationId: orgId,
        userId,
        readAt: null,
        ...(ids && ids.length ? { id: { in: ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  /** Supprime (dismiss) une notification de l'utilisateur courant. */
  async dismissInbox(orgId: string, userId: string, id: string): Promise<{ dismissed: boolean }> {
    const res = await this.prisma.notification.deleteMany({
      where: { organizationId: orgId, userId, id },
    });
    return { dismissed: res.count > 0 };
  }

  /** Purge de rétention (appelée par le cron). Renvoie le nombre supprimé. */
  async purgeInbox(now = Date.now()): Promise<number> {
    const readCutoff = new Date(now - INBOX_READ_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const unreadCutoff = new Date(now - INBOX_UNREAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const res = await this.prisma.notification.deleteMany({
      where: {
        OR: [
          { readAt: { not: null, lt: readCutoff } },
          { readAt: null, createdAt: { lt: unreadCutoff } },
        ],
      },
    });
    return res.count;
  }

  /**
   * Charge le logo org depuis MinIO et renvoie payload prêt à attacher inline
   * + URL d'origine (pour réécrire le HTML). Retourne null si pas de logo
   * configuré ou si le blob est introuvable — le mail partira sans logo.
   *
   * Mis en cache mémoire 60 s pour éviter de relire MinIO à chaque mail.
   */
  private logoCache: { orgId: string; expectedUrl: string; at: number; data: { url: string; base64: string; mime: string } | null } | null = null;
  private async loadInlineLogo(orgId: string, expectedUrl: string): Promise<{ url: string; base64: string; mime: string } | null> {
    const now = Date.now();
    if (
      this.logoCache &&
      this.logoCache.orgId === orgId &&
      this.logoCache.expectedUrl === expectedUrl &&
      now - this.logoCache.at < 60_000
    ) {
      return this.logoCache.data;
    }
    let data: { url: string; base64: string; mime: string } | null = null;
    try {
      const all = await this.settings.getAll(orgId);
      const url = typeof all['org.logoUrl'] === 'string' ? (all['org.logoUrl'] as string) : '';
      const key = typeof all['org.logoKey'] === 'string' ? (all['org.logoKey'] as string) : '';
      const mime = typeof all['org.logoMime'] === 'string' ? (all['org.logoMime'] as string) : 'image/png';
      if (url && key) {
        const buf = await this.s3.getObjectBuffer(this.s3.buckets.branding, key);
        data = { url, base64: buf.toString('base64'), mime };
      }
    } catch (err) {
      this.log.warn(`loadInlineLogo failed: ${(err as Error).message}`);
    }
    this.logoCache = { orgId, expectedUrl, at: now, data };
    return data;
  }

  /** Snapshot complet (notifications + SMTP) pour l'UI admin. */
  async getOrgSettings(orgId: string): Promise<{
    notifications: NotificationsSettings;
    smtp: SmtpSettings;
    /** Indique si `SMTP_PASSWORD` est configuré côté worker (env var). */
    smtpPasswordConfigured: boolean;
  }> {
    const all = await this.settings.getAll(orgId);
    return {
      notifications: readNotificationsSettings(all),
      smtp: readSmtpSettings(all),
      // L'API ne peut pas savoir si le worker a un mot de passe (variable d'env
      // côté autre conteneur). On expose néanmoins l'info via API si elle est
      // posée sur l'API aussi (compose monte le même secret).
      smtpPasswordConfigured: Boolean(process.env.SMTP_PASSWORD),
    };
  }

  /**
   * Hook tâche assignée. `recipientUserId` = nouvel assignee.
   * `actorUserId` peut être null pour les actions système.
   */
  async notifyAssignment(
    orgId: string,
    actorUserId: string | null,
    recipientUserId: string,
    taskId: string,
  ): Promise<void> {
    try {
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      // Gate in-app (cloche) : kill switch + toggle par-event, MAIS pas le digest
      // ni les quiet hours (ceux-ci ne concernent que la remise email). En mode
      // digest, l'email est différé mais la cloche notifie en temps réel.
      if (!prefs.enabled || !prefs.onAssignment) return;
      if (actorUserId === recipientUserId) return;
      if (await this.userOptedOut(orgId, recipientUserId, 'assignment')) return;

      const [recipient, actor, task, org] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: recipientUserId } }),
        actorUserId ? this.prisma.user.findUnique({ where: { id: actorUserId } }) : null,
        this.prisma.task.findUnique({
          where: { id: taskId },
          include: { project: { select: { name: true, key: true } } },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId } }),
      ]);
      if (!recipient || !task || !org) return;

      await this.persistAndPush(orgId, recipientUserId, {
        kind: 'assignment',
        taskId: task.id,
        projectId: task.projectId,
        url: this.taskUrl(task.id),
        meta: { taskTitle: task.title, actorName: actor?.name ?? undefined },
      });

      // Email : soumis en plus au digest/quiet hours.
      if (!this.isAllowed(prefs, 'onAssignment', orgId)) return;
      const lang = await this.resolveRecipientLanguage(orgId, recipient.preferredLanguage);
      const ctx = this.buildContext(prefs, recipient.name, org.name, lang);
      const rendered = renderAssignment(ctx, {
        actorName: actor?.name ?? 'A teammate',
        taskTitle: task.title,
        taskUrl: this.taskUrl(task.id),
        projectName: task.project.name,
      });
      await this.enqueue(orgId, recipient.email, 'assignment', rendered, prefs);
    } catch (err) {
      this.log.warn(`notifyAssignment failed: ${(err as Error).message}`);
    }
  }

  async notifyMention(
    orgId: string,
    actorUserId: string,
    recipientUserId: string,
    taskId: string,
    commentBody: string,
  ): Promise<void> {
    try {
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      // Voir notifyAssignment : in-app = kill switch + toggle, sans digest/quiet.
      if (!prefs.enabled || !prefs.onMention) return;
      if (actorUserId === recipientUserId) return;
      if (await this.userOptedOut(orgId, recipientUserId, 'mention')) return;

      const [recipient, actor, task, org] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: recipientUserId } }),
        this.prisma.user.findUnique({ where: { id: actorUserId } }),
        this.prisma.task.findUnique({
          where: { id: taskId },
          select: { id: true, title: true, projectId: true },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId } }),
      ]);
      if (!recipient || !actor || !task || !org) return;

      await this.persistAndPush(orgId, recipientUserId, {
        kind: 'mention',
        taskId: task.id,
        projectId: task.projectId,
        url: this.taskUrl(task.id),
        meta: {
          taskTitle: task.title,
          actorName: actor.name,
          excerpt: commentBody.slice(0, 140),
        },
      });

      if (!this.isAllowed(prefs, 'onMention', orgId)) return;
      const lang = await this.resolveRecipientLanguage(orgId, recipient.preferredLanguage);
      const ctx = this.buildContext(prefs, recipient.name, org.name, lang);
      const rendered = renderMention(ctx, {
        actorName: actor.name,
        taskTitle: task.title,
        taskUrl: this.taskUrl(task.id),
        commentExcerpt: commentBody.slice(0, 280),
      });
      await this.enqueue(orgId, recipient.email, 'mention', rendered, prefs);
    } catch (err) {
      this.log.warn(`notifyMention failed: ${(err as Error).message}`);
    }
  }

  /**
   * Notifie par email un ensemble de destinataires (typiquement les leads
   * d'une équipe) qu'une demande de compétence a été émise. Best-effort :
   * respecte le kill switch (`prefs.enabled`) mais pas de toggle par-event
   * (une demande est une action explicite, toujours pertinente).
   */
  /**
   * Notifie l'expiration prochaine (ou passée) d'un UserSkill aux
   * destinataires (le user lui-même + ses leads d'équipe).
   * Best-effort, respecte le kill switch global.
   */
  /** Titre/corps localisés de la notif in-app « compétence bientôt expirée ». */
  private inboxSkillExpiringText(
    lang: Lang,
    skillName: string,
    expiresAt: string,
    stage: 30 | 7 | 0,
  ): { title: string; body: string } {
    const T: Record<Lang, { title: string; expired: string; soon: (d: string) => string }> = {
      en: { title: 'Skill expiring', expired: 'has expired', soon: (d) => `expires on ${d}` },
      fr: { title: 'Compétence bientôt expirée', expired: 'a expiré', soon: (d) => `expire le ${d}` },
      it: { title: 'Competenza in scadenza', expired: 'è scaduta', soon: (d) => `scade il ${d}` },
      de: { title: 'Fähigkeit läuft ab', expired: 'ist abgelaufen', soon: (d) => `läuft am ${d} ab` },
    };
    const m = T[lang] ?? T.en;
    return {
      title: m.title,
      body: `${skillName} ${stage === 0 ? m.expired : m.soon(expiresAt)}`,
    };
  }

  async notifySkillExpiring(
    orgId: string,
    recipients: Array<{ email: string; name: string; preferredLanguage?: string | null; userId?: string }>,
    data: Omit<SkillExpiringPayload, 'ctaUrl'> & { ctaUrl?: string },
  ): Promise<void> {
    try {
      if (recipients.length === 0) return;
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      if (!prefs.enabled) return;
      const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
      if (!org) return;
      const ctaUrl = data.ctaUrl ?? `${this.tenantUrl.publicBaseUrl()}/`;
      for (const r of recipients) {
        const lang = await this.resolveRecipientLanguage(orgId, r.preferredLanguage);
        if (r.userId) {
          const txt = this.inboxSkillExpiringText(lang, data.skillName, data.expiresAt, data.stage);
          await this.persistAndPush(orgId, r.userId, {
            kind: 'skill_expiring',
            title: txt.title,
            body: txt.body,
            url: ctaUrl,
            meta: { skillName: data.skillName },
          });
        }
        const ctx = this.buildContext(prefs, r.name, org.name, lang);
        const rendered = renderSkillExpiring(ctx, { ...data, ctaUrl });
        await this.enqueue(orgId, r.email, 'skill_expiring', rendered, prefs);
      }
    } catch (err) {
      this.log.warn(`notifySkillExpiring failed: ${(err as Error).message}`);
    }
  }

  /** Titre/corps localisés de la notif in-app « demande de compétence ». */
  private inboxSkillRequestText(
    lang: Lang,
    requesterName: string,
    skillName: string,
    projectName?: string,
  ): { title: string; body: string } {
    const T: Record<Lang, { title: string; body: (r: string, s: string, p?: string) => string }> = {
      en: {
        title: 'Skill request',
        body: (r, s, p) => `${r} is requesting the “${s}” skill${p ? ` for ${p}` : ''}`,
      },
      fr: {
        title: 'Demande de compétence',
        body: (r, s, p) => `${r} demande la compétence « ${s} »${p ? ` pour ${p}` : ''}`,
      },
      it: {
        title: 'Richiesta di competenza',
        body: (r, s, p) => `${r} richiede la competenza «${s}»${p ? ` per ${p}` : ''}`,
      },
      de: {
        title: 'Kompetenzanfrage',
        body: (r, s, p) => `${r} fordert die Kompetenz „${s}“ an${p ? ` für ${p}` : ''}`,
      },
    };
    const m = T[lang] ?? T.en;
    return { title: m.title, body: m.body(requesterName, skillName, projectName) };
  }

  async notifySkillRequest(
    orgId: string,
    recipients: Array<{ email: string; name: string; preferredLanguage?: string | null; userId?: string }>,
    data: Omit<SkillRequestPayload, 'ctaUrl'> & { ctaUrl?: string },
  ): Promise<void> {
    try {
      if (recipients.length === 0) return;
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      if (!prefs.enabled) return;
      const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
      if (!org) return;
      const ctaUrl = data.ctaUrl ?? `${this.tenantUrl.publicBaseUrl()}/`;
      for (const r of recipients) {
        const lang = await this.resolveRecipientLanguage(orgId, r.preferredLanguage);
        if (r.userId) {
          const txt = this.inboxSkillRequestText(
            lang,
            data.requesterName,
            data.skillName,
            data.projectName,
          );
          await this.persistAndPush(orgId, r.userId, {
            kind: 'skill_request',
            title: txt.title,
            body: txt.body,
            url: ctaUrl,
            meta: { skillName: data.skillName, teamName: data.teamName },
          });
        }
        const ctx = this.buildContext(prefs, r.name, org.name, lang);
        const rendered = renderSkillRequest(ctx, { ...data, ctaUrl });
        await this.enqueue(orgId, r.email, 'skill_request', rendered, prefs);
      }
    } catch (err) {
      this.log.warn(`notifySkillRequest failed: ${(err as Error).message}`);
    }
  }

  async notifyStatusChange(
    orgId: string,
    actorUserId: string | null,
    recipientUserIds: string[],
    taskId: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    try {
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      // In-app = kill switch + toggle ; email = en plus digest/quiet (calculé
      // une fois, invariant de boucle).
      if (!prefs.enabled || !prefs.onStatusChange) return;
      const emailAllowed = this.isAllowed(prefs, 'onStatusChange', orgId);
      const targets = recipientUserIds.filter((id) => id !== actorUserId);
      if (targets.length === 0) return;

      const [recipients, actor, task, org] = await Promise.all([
        this.prisma.user.findMany({ where: { id: { in: targets } } }),
        actorUserId ? this.prisma.user.findUnique({ where: { id: actorUserId } }) : null,
        this.prisma.task.findUnique({
          where: { id: taskId },
          select: { id: true, title: true, projectId: true },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId } }),
      ]);
      if (!task || !org || recipients.length === 0) return;

      // Opt-outs chargés en UNE requête (au lieu d'un findUnique par
      // destinataire). Fail-open : en cas d'erreur, personne n'est opté out —
      // sémantique identique à `userOptedOut` (pas de ligne ⇒ non opté out).
      const optOut = new Map<string, boolean>();
      try {
        const prefRows = await this.prisma.userNotificationPref.findMany({
          where: { organizationId: orgId, userId: { in: recipients.map((r) => r.id) } },
        });
        for (const p of prefRows) optOut.set(p.userId, (p as Record<string, unknown>).statusChange === false);
      } catch { /* fail-open */ }

      // Défaut de langue org résolu UNE fois (réutilisé pour tout destinataire
      // sans préférence valide) au lieu d'un getDefaultLanguage par destinataire.
      const orgLang = emailAllowed ? await this.resolveRecipientLanguage(orgId, null) : ('en' as Lang);

      for (const r of recipients) {
        if (optOut.get(r.id)) continue;
        await this.persistAndPush(orgId, r.id, {
          kind: 'status',
          taskId: task.id,
          projectId: task.projectId,
          url: this.taskUrl(task.id),
          meta: {
            taskTitle: task.title,
            actorName: actor?.name ?? undefined,
            fromStatus,
            toStatus,
          },
        });
        if (!emailAllowed) continue;
        const lang = await this.resolveRecipientLanguage(orgId, r.preferredLanguage, orgLang);
        const ctx = this.buildContext(prefs, r.name, org.name, lang);
        const rendered = renderStatus(ctx, {
          actorName: actor?.name ?? 'A teammate',
          taskTitle: task.title,
          taskUrl: this.taskUrl(task.id),
          fromStatus,
          toStatus,
        });
        await this.enqueue(orgId, r.email, 'status', rendered, prefs);
      }
    } catch (err) {
      this.log.warn(`notifyStatusChange failed: ${(err as Error).message}`);
    }
  }

  /**
   * Appelé par TimeEntriesService.create/update quand le cumul d'heures
   * loggées sur une tâche passe au-dessus de son estimate. Notifie les
   * PROJECT_MANAGER du projet (un mail par PM, sauf l'acteur lui-même).
   * Idempotence : le caller décide si on notifie une seule fois par
   * "franchissement" (loggedBefore ≤ estimate, loggedAfter > estimate).
   */
  async notifyOverEstimate(
    orgId: string,
    actorUserId: string,
    taskId: string,
    loggedHours: number,
  ): Promise<void> {
    try {
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      if (!this.isAllowed(prefs, 'onOverEstimate', orgId)) return;

      const [task, org, actor] = await Promise.all([
        this.prisma.task.findUnique({
          where: { id: taskId },
          include: { project: { select: { id: true, name: true } } },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId } }),
        this.prisma.user.findUnique({ where: { id: actorUserId } }),
      ]);
      if (!task || !org || !actor || task.estimateHours == null) return;

      // Tous les PROJECT_MANAGER du projet sauf l'acteur (on ne se notifie pas).
      const pmMembers = await this.prisma.projectMember.findMany({
        where: {
          projectId: task.project.id,
          role: { key: 'PROJECT_MANAGER' },
        },
        select: {
          user: { select: { id: true, name: true, email: true, preferredLanguage: true } },
        },
      });
      const recipients = pmMembers
        .map((m) => m.user)
        .filter((u) => u && u.id !== actorUserId);
      if (recipients.length === 0) return;

      const overByHours = Math.max(0, loggedHours - task.estimateHours);
      for (const recipient of recipients) {
        await this.persistAndPush(orgId, recipient.id, {
          kind: 'over_estimate',
          taskId: task.id,
          projectId: task.project.id,
          url: this.taskUrl(task.id),
          meta: {
            taskTitle: task.title,
            actorName: actor.name,
            estimateHours: task.estimateHours,
            loggedHours,
            overByHours,
          },
        });
        const lang = await this.resolveRecipientLanguage(orgId, recipient.preferredLanguage);
        const ctx = this.buildContext(prefs, recipient.name, org.name, lang);
        const payload: OverEstimatePayload = {
          actorName: actor.name,
          taskTitle: task.title,
          taskUrl: this.taskUrl(task.id),
          projectName: task.project.name,
          estimateHours: task.estimateHours,
          loggedHours,
          overByHours,
        };
        const rendered = renderOverEstimate(ctx, payload);
        await this.enqueue(orgId, recipient.email, 'over_estimate', rendered, prefs);
      }
    } catch (err) {
      this.log.warn(`notifyOverEstimate failed: ${(err as Error).message}`);
    }
  }

  /** Appelé par le cron horaire pour le rappel due-date. */
  async notifyDue(
    orgId: string,
    recipientUserId: string,
    taskId: string,
    dueDate: string,
  ): Promise<void> {
    try {
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
      if (!this.isAllowed(prefs, 'onDueDate', orgId)) return;
      if (await this.userOptedOut(orgId, recipientUserId, 'dueReminder')) return;

      const [recipient, task, org] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: recipientUserId } }),
        this.prisma.task.findUnique({
          where: { id: taskId },
          include: { project: { select: { name: true } } },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId } }),
      ]);
      if (!recipient || !task || !org) return;

      await this.persistAndPush(orgId, recipientUserId, {
        kind: 'due',
        taskId: task.id,
        projectId: task.projectId,
        url: this.taskUrl(task.id),
        meta: { taskTitle: task.title, dueDate },
      });

      const lang = await this.resolveRecipientLanguage(orgId, recipient.preferredLanguage);
      const ctx = this.buildContext(prefs, recipient.name, org.name, lang);
      const rendered = renderDue(ctx, {
        taskTitle: task.title,
        taskUrl: this.taskUrl(task.id),
        dueDate,
        projectName: task.project.name,
      });
      await this.enqueue(orgId, recipient.email, 'due', rendered, prefs);
    } catch (err) {
      this.log.warn(`notifyDue failed: ${(err as Error).message}`);
    }
  }

  /**
   * Envoi de test depuis l'admin (bouton "Send test"). Court-circuite les
   * préférences (kill switch, quiet hours) pour permettre la validation manuelle.
   */
  async sendTest(orgId: string, toAddress: string, recipientName: string): Promise<{ deliveryId: string }> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    // L'admin déclencheur reçoit le test : sa préférence si on la connaît,
    // sinon le défaut org.
    const me = await this.prisma.user
      .findFirst({ where: { organizationId: orgId, email: toAddress }, select: { preferredLanguage: true } })
      .catch(() => null);
    const lang = await this.resolveRecipientLanguage(orgId, me?.preferredLanguage);
    const ctx = this.buildContext(prefs, recipientName, org?.name ?? 'Vaks', lang);
    const rendered = renderTest(ctx);
    // Réutilise `enqueue` pour bénéficier de l'embed CID logo, du suivi
    // EmailDelivery et de tout futur enrichissement (signature DKIM custom,
    // headers, etc.). Le test mail court-circuite uniquement les préférences
    // (kill switch, quiet hours) — ce qui se fait avant l'appel ici.
    const delivery = await this.createDelivery(orgId, toAddress, rendered.subject, 'test');
    // On utilise une variante d'enqueue qui ne re-crée pas la ligne EmailDelivery
    // (déjà créée juste au-dessus pour pouvoir retourner l'id immédiatement).
    await this.enqueueRendered(orgId, toAddress, rendered, prefs, delivery.id);
    return { deliveryId: delivery.id };
  }

  // ============================================================
  // Préférences de notification par utilisateur (#14, self-service)
  // ============================================================

  /** Lit les overrides de l'utilisateur (null = hérite du défaut org). */
  async getUserPrefs(orgId: string, userId: string) {
    const row = await this.prisma.userNotificationPref.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
    });
    return {
      assignment: row?.assignment ?? null,
      mention: row?.mention ?? null,
      dueReminder: row?.dueReminder ?? null,
      statusChange: row?.statusChange ?? null,
    };
  }

  /** Upsert des overrides de l'utilisateur. `null` efface l'override (hérite). */
  async setUserPrefs(
    orgId: string,
    userId: string,
    dto: {
      assignment?: boolean | null;
      mention?: boolean | null;
      dueReminder?: boolean | null;
      statusChange?: boolean | null;
    },
  ) {
    const data = {
      assignment: dto.assignment ?? null,
      mention: dto.mention ?? null,
      dueReminder: dto.dueReminder ?? null,
      statusChange: dto.statusChange ?? null,
    };
    await this.prisma.userNotificationPref.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      create: { organizationId: orgId, userId, ...data },
      update: data,
    });
    return this.getUserPrefs(orgId, userId);
  }

  /**
   * Envoie le mail de réinitialisation de mot de passe (lien usage unique).
   * Bypass des préférences/quiet-hours (mail transactionnel de sécurité).
   */
  async sendPasswordReset(
    orgId: string,
    to: string,
    recipientName: string,
    resetUrl: string,
    expiresMinutes: number,
  ): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const target = await this.prisma.user
      .findFirst({ where: { organizationId: orgId, email: to }, select: { preferredLanguage: true } })
      .catch(() => null);
    const lang = await this.resolveRecipientLanguage(orgId, target?.preferredLanguage);
    const ctx = this.buildContext(prefs, recipientName, org?.name ?? 'Vaks', lang);
    const rendered = renderPasswordReset(ctx, { resetUrl, expiresMinutes });
    await this.enqueue(orgId, to, 'password_reset', rendered, prefs);
  }

  /** Titre localisé des alertes admin de la cloche (le corps reste technique). */
  private inboxAdminTitle(lang: Lang, key: 'security' | 'backup'): string {
    const T: Record<Lang, Record<'security' | 'backup', string>> = {
      en: { security: 'Security alert', backup: 'Backup failed' },
      fr: { security: 'Alerte sécurité', backup: 'Échec de sauvegarde' },
      it: { security: 'Avviso di sicurezza', backup: 'Backup non riuscito' },
      de: { security: 'Sicherheitswarnung', backup: 'Sicherung fehlgeschlagen' },
    };
    return (T[lang] ?? T.en)[key];
  }

  /**
   * Persiste une alerte admin dans la cloche du destinataire, résolu depuis son
   * adresse email au sein de l'org (les `send*Alert` sont appelés par adresse,
   * bouclés par l'appelant). Best-effort.
   */
  private async persistAdminAlert(
    orgId: string,
    to: string,
    lang: Lang,
    key: 'security' | 'backup',
    body: string,
  ): Promise<void> {
    try {
      const u = await this.prisma.user.findFirst({
        where: { organizationId: orgId, email: to, kind: 'HUMAN', deletedAt: null },
        select: { id: true },
      });
      if (!u) return;
      await this.persistAndPush(orgId, u.id, {
        kind: 'admin_alert',
        title: this.inboxAdminTitle(lang, key),
        body,
        url: `${this.tenantUrl.publicBaseUrl()}/`,
        meta: { alert: key },
      });
    } catch {
      /* fail-open */
    }
  }

  /**
   * Alerte sécurité aux admins (détection brute-force depuis le journal
   * d'audit). Transactionnel critique → respecte le kill switch org
   * (`notif.enabled`) mais pas les quiet hours ni les préférences par event.
   */
  async sendSecurityAlert(
    orgId: string,
    to: string,
    recipientName: string,
    payload: SecurityAlertPayload,
    recipientLanguage?: string | null,
  ): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled) return;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const lang = await this.resolveRecipientLanguage(orgId, recipientLanguage);
    await this.persistAdminAlert(
      orgId,
      to,
      lang,
      'security',
      `${payload.failures} failed logins on ${payload.targetEmail} in ${payload.windowMinutes} min${payload.ip ? ` (last IP ${payload.ip})` : ''}`,
    );
    const ctx = this.buildContext(prefs, recipientName, org?.name ?? 'Vaks', lang);
    const rendered = renderSecurityAlert(ctx, payload);
    await this.enqueue(orgId, to, 'security_alert', rendered, prefs);
  }

  /**
   * Alerte aux admins : une sauvegarde de la base a échoué (signalée par le
   * script host via `/ops/backup-alert`). Transactionnel critique → respecte
   * le kill switch org (`notif.enabled`) mais pas les quiet hours.
   */
  async sendBackupAlert(
    orgId: string,
    to: string,
    recipientName: string,
    payload: BackupAlertPayload,
    recipientLanguage?: string | null,
  ): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled) return;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const lang = await this.resolveRecipientLanguage(orgId, recipientLanguage);
    await this.persistAdminAlert(
      orgId,
      to,
      lang,
      'backup',
      `${payload.host}${payload.tier ? ` (${payload.tier})` : ''}: ${payload.message}`,
    );
    const ctx = this.buildContext(prefs, recipientName, org?.name ?? 'Vaks', lang);
    const rendered = renderBackupAlert(ctx, payload);
    await this.enqueue(orgId, to, 'backup_failed', rendered, prefs);
  }

  /**
   * Alerte aux admins du tenant : le provisioning Microsoft Teams d'un projet a
   * échoué DÉFINITIVEMENT (retries BullMQ épuisés, ou cas non-retryable connu
   * d'avance). Transactionnel critique → respecte le kill switch org
   * (`notif.enabled`) mais pas les quiet hours.
   */
  async sendTeamsProvisionFailedAlert(
    orgId: string,
    to: string,
    recipientName: string,
    payload: TeamsProvisionFailedPayload,
    recipientLanguage?: string | null,
  ): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled) return;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const lang = await this.resolveRecipientLanguage(orgId, recipientLanguage);
    const ctx = this.buildContext(prefs, recipientName, org?.name ?? 'Vaks', lang);
    const rendered = renderTeamsProvisionFailed(ctx, payload);
    await this.enqueue(orgId, to, 'teams_provision_failed', rendered, prefs);
  }

  /**
   * Envoie l'offre commerciale au contact client, avec le document d'offre en
   * pièce jointe. Mail transactionnel déclenché manuellement par un PM →
   * bypass des quiet hours, mais respecte le kill switch org (`notif.enabled`).
   * Si les notifications sont coupées org-wide, on crée une ligne SKIPPED et on
   * retourne `skipped: true` pour que l'appelant le signale à l'UI.
   */
  /** Envoie l'export facturation planifié à un destinataire externe (pièce jointe CSV/XLSX).
   *  Bypass des quiet hours (planifié) ; respecte le kill switch org. */
  async sendBillingExportEmail(
    orgId: string,
    to: string,
    data: { period: string; rowCount: number; filename: string },
    attachment: { filename: string; contentType: string; contentBase64: string },
  ): Promise<void> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled) return;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const lang = await this.resolveRecipientLanguage(orgId, null);
    const ctx = this.buildContext(prefs, to, org?.name ?? 'Vaks', lang);
    const rendered = renderBillingExport(ctx, data);
    const delivery = await this.createDelivery(orgId, to, rendered.subject, 'billing_export');
    await this.enqueueRendered(orgId, to, rendered, prefs, delivery.id, [attachment]);
  }

  async sendOfferEmail(
    orgId: string,
    to: string,
    recipientName: string,
    data: { projectName: string; clientName: string | null; intro?: string },
    attachment: { filename: string; contentType: string; contentBase64: string },
  ): Promise<{ deliveryId: string; skipped: boolean }> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    if (!prefs.enabled) {
      const delivery = await this.createDelivery(
        orgId,
        to,
        `Votre offre — ${data.projectName}`,
        'offer',
        'SKIPPED',
        'notifications disabled (notif.enabled = false)',
      );
      return { deliveryId: delivery.id, skipped: true };
    }
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    // Contact client externe (pas un User) → langue = défaut org.
    const lang = await this.resolveRecipientLanguage(orgId, null);
    const ctx = this.buildContext(prefs, recipientName, org?.name ?? 'Vaks', lang);
    const rendered = renderOffer(ctx, {
      projectName: data.projectName,
      clientName: data.clientName,
      attachmentName: attachment.filename,
      intro: data.intro,
    });
    const delivery = await this.createDelivery(orgId, to, rendered.subject, 'offer');
    await this.enqueueRendered(orgId, to, rendered, prefs, delivery.id, [attachment]);
    return { deliveryId: delivery.id, skipped: false };
  }

  /**
   * Rendu HTML d'un template, pour le bouton "Preview template" dans l'UI.
   * `lang` optionnel : permet de prévisualiser une langue précise ; à défaut,
   * le défaut org est utilisé.
   */
  async preview(orgId: string, key: EmailTemplateKey, lang?: string): Promise<RenderedEmail> {
    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const resolvedLang = await this.resolveRecipientLanguage(orgId, lang ?? null);
    const ctx = this.buildContext(prefs, 'Alex Doe', org?.name ?? 'Vaks', resolvedLang);
    const dummyTaskUrl = this.taskUrl('00000000-0000-0000-0000-000000000000');
    switch (key) {
      case 'assignment':
        return renderAssignment(ctx, {
          actorName: 'Sam Lee',
          taskTitle: 'Wire OIDC discovery doc',
          taskUrl: dummyTaskUrl,
          projectName: 'Platform 2026',
        });
      case 'mention':
        return renderMention(ctx, {
          actorName: 'Sam Lee',
          taskTitle: 'Wire OIDC discovery doc',
          taskUrl: dummyTaskUrl,
          commentExcerpt: 'Can you double-check the issuer URL once the tenant is provisioned?',
        });
      case 'due':
        return renderDue(ctx, {
          taskTitle: 'Wire OIDC discovery doc',
          taskUrl: dummyTaskUrl,
          dueDate: 'tomorrow',
          projectName: 'Platform 2026',
        });
      case 'status':
        return renderStatus(ctx, {
          actorName: 'Sam Lee',
          taskTitle: 'Wire OIDC discovery doc',
          taskUrl: dummyTaskUrl,
          fromStatus: 'In progress',
          toStatus: 'Review',
        });
      case 'over_estimate':
        return renderOverEstimate(ctx, {
          actorName: 'Sam Lee',
          taskTitle: 'Wire OIDC discovery doc',
          taskUrl: dummyTaskUrl,
          projectName: 'Platform 2026',
          estimateHours: 8,
          loggedHours: 11.5,
          overByHours: 3.5,
        });
      case 'skill_request':
        return renderSkillRequest(ctx, {
          requesterName: 'Sam Lee',
          teamName: 'Cloud & Infra',
          typeLabel: 'Training / upskilling',
          skillName: 'Azure Kubernetes Service (AKS)',
          targetName: 'Jordan Pike',
          desiredLevel: 6,
          projectName: 'Platform 2026',
          note: 'Needed for the Q3 migration; nobody on the assigned teams covers AKS yet.',
          ctaUrl: ctx.appUrl + '/',
        });
      case 'test':
      default:
        return renderTest(ctx);
    }
  }

  /**
   * Liste des envois pour debug (admin-only). Fenêtre bornée à la rétention
   * (`EMAIL_DELIVERY_RETENTION_DAYS`) et pagination keyset `queuedAt,id` —
   * même contrat que le journal d'audit : repasser `nextCursor` tel quel
   * (null = fin). `counts` = répartition par statut sur toute la fenêtre (pas
   * seulement la page), pour que les compteurs des filtres restent justes.
   */
  async listDeliveries(
    orgId: string,
    opts: { status?: string; cursor?: string; pageSize?: number } = {},
  ): Promise<{
    items: EmailDelivery[];
    nextCursor: string | null;
    counts: Record<string, number>;
    retentionDays: number;
  }> {
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
    const since = emailDeliveryCutoff();
    const status =
      opts.status && DELIVERY_STATUSES.includes(opts.status as EmailDeliveryStatus)
        ? (opts.status as EmailDeliveryStatus)
        : undefined;

    const where: Record<string, unknown> = { organizationId: orgId };
    if (status) where.status = status;
    const cursor = decodeDeliveryCursor(opts.cursor);
    where.AND = cursor
      ? [
          { queuedAt: { gte: since } },
          {
            OR: [
              { queuedAt: { lt: cursor.queuedAt } },
              { queuedAt: cursor.queuedAt, id: { lt: cursor.id } },
            ],
          },
        ]
      : [{ queuedAt: { gte: since } }];

    const rows = await this.prisma.emailDelivery.findMany({
      where: where as never,
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
    });
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items[items.length - 1];

    const grouped = await this.prisma.emailDelivery.groupBy({
      by: ['status'],
      where: { organizationId: orgId, queuedAt: { gte: since } },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;

    return {
      items,
      nextCursor: hasMore && last ? `${last.queuedAt.getTime()}|${last.id}` : null,
      counts,
      retentionDays: EMAIL_DELIVERY_RETENTION_DAYS,
    };
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Override **par utilisateur** (#14) : renvoie `true` si l'utilisateur a
   * explicitement désactivé cet événement (`UserNotificationPref.<field> =
   * false`). Sémantique opt-out : le défaut org décide d'abord (`isAllowed`),
   * puis l'utilisateur peut couper un événement qui le concerne. Best-effort —
   * en cas d'erreur de lecture on n'opte PAS out (on continue d'envoyer).
   */
  private async userOptedOut(
    orgId: string,
    userId: string,
    field: 'assignment' | 'mention' | 'dueReminder' | 'statusChange',
  ): Promise<boolean> {
    try {
      const row = await this.prisma.userNotificationPref.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      if (!row) return false;
      return (row as Record<string, unknown>)[field] === false;
    } catch {
      return false;
    }
  }

  private isAllowed(
    prefs: NotificationsSettings,
    key: 'onAssignment' | 'onMention' | 'onDueDate' | 'onStatusChange' | 'onOverEstimate',
    orgId: string,
  ): boolean {
    if (!prefs.enabled) return false;
    if (!prefs[key]) return false;
    // En mode digest, les events temps réel sont absorbés dans le récapitulatif.
    // onDueDate est exempté : il est déjà dédupliqué par EmailDelivery et n'a
    // pas de résumé équivalent dans le digest.
    const DIGEST_SUPPRESSED: typeof key[] = ['onAssignment', 'onMention', 'onStatusChange', 'onOverEstimate'];
    if (prefs.digest !== 'off' && DIGEST_SUPPRESSED.includes(key)) {
      this.log.debug(`digest mode active — suppressing immediate ${key} (org=${orgId})`);
      return false;
    }
    // Quiet hours appliquées au moment de l'enqueue. Pour les events temps réel
    // (assign/mention/status), c'est OK : un mail envoyé "tout de suite" lit
    // l'heure courante. Pour le due-date cron, c'est aussi correct (cron tourne
    // toutes les heures). On lit l'heure UTC pour rester simple — un raffinement
    // futur lira `organization.timezone`.
    const hour = new Date().getUTCHours();
    if (isQuietHour(hour, prefs.quietHoursStart, prefs.quietHoursEnd)) {
      this.log.debug(`quiet hour skip (org=${orgId})`);
      return false;
    }
    return true;
  }

  private buildContext(
    prefs: NotificationsSettings,
    recipientName: string,
    orgName: string,
    lang: Lang = 'en',
  ): TemplateContext {
    return {
      recipientName,
      orgName,
      lang,
      appUrl: this.tenantUrl.publicBaseUrl(),
      branding: {
        fromName: prefs.fromName,
        accentColor: prefs.accentColor,
        logoUrl: prefs.logoUrl,
      },
    };
  }

  /**
   * Résout la langue de rendu pour un destinataire :
   *   préférence utilisateur (si valide) > défaut org > 'en'.
   * Normalise ('fr-FR' → 'fr', langue inconnue → 'en'). Best-effort : en cas
   * d'erreur de lecture du défaut org, retombe sur 'en'.
   *
   * @param preferredLanguage `User.preferredLanguage` (null/undefined = hérite).
   */
  async resolveRecipientLanguage(
    orgId: string,
    preferredLanguage: string | null | undefined,
    orgDefault?: Lang,
  ): Promise<Lang> {
    if (preferredLanguage) {
      const sub = String(preferredLanguage).trim().toLowerCase().split('-')[0];
      if ((EMAIL_LANGUAGES as readonly string[]).includes(sub)) return sub as Lang;
    }
    // Défaut org pré-résolu par l'appelant → évite un `getDefaultLanguage` par
    // destinataire dans une boucle de notification.
    if (orgDefault) return orgDefault;
    try {
      const def = await this.settings.getDefaultLanguage(orgId);
      return normalizeEmailLang(def);
    } catch {
      return 'en';
    }
  }

  private taskUrl(taskId: string): string {
    return this.tenantUrl.taskUrl(taskId);
  }

  private async createDelivery(
    orgId: string,
    to: string,
    subject: string,
    template: EmailTemplateKey,
    status: 'QUEUED' | 'SKIPPED' = 'QUEUED',
    error: string | null = null,
  ) {
    return this.prisma.emailDelivery.create({
      data: {
        organizationId: orgId,
        toAddress: to,
        subject,
        template,
        status,
        error,
      },
    });
  }

  /**
   * Enqueue d'un mail déjà rendu (utilisé par les hooks privés ET par le cron
   * pour le digest). Crée une ligne EmailDelivery et délègue à
   * `enqueueRendered` pour l'embed CID + BullMQ.
   */
  async enqueue(
    orgId: string,
    to: string,
    template: EmailTemplateKey,
    rendered: RenderedEmail,
    prefs: NotificationsSettings,
  ): Promise<void> {
    // Jamais d'email vers un compte agent IA (adresse synthétique non
    // routable `@agents.invalid`) — chokepoint unique pour tous les hooks.
    // Chantier 2 : rerouter vers l'owner de l'agent.
    if (to.toLowerCase().endsWith('@agents.invalid')) {
      this.log.debug(`[notifications] skip email to agent account ${to}`);
      return;
    }
    const delivery = await this.createDelivery(orgId, to, rendered.subject, template);
    await this.enqueueRendered(orgId, to, rendered, prefs, delivery.id);
  }

  /**
   * Variante d'enqueue qui prend un `deliveryId` déjà créé. Sert au chemin
   * `sendTest` qui doit retourner l'id immédiatement à l'admin.
   *
   * Gère l'embed CID du logo : si `prefs.logoUrl` pointe vers notre asset S3,
   * on lit le blob, on swap l'URL dans le HTML par `cid:vaks-org-logo`, et on
   * attache l'image inline au job BullMQ. Le destinataire voit l'image sans
   * dépendre de la résolvabilité d'`APP_URL`.
   */
  private async enqueueRendered(
    orgId: string,
    to: string,
    rendered: RenderedEmail,
    prefs: NotificationsSettings,
    deliveryId: string,
    attachments?: EmailJobData['attachments'],
  ): Promise<void> {
    let html = rendered.html;
    // Conf SMTP résolue PAR TENANT (on est dans le contexte tenant ici) —
    // transport seulement. SÉCURITÉ : le mot de passe n'est JAMAIS mis dans le
    // job (Redis sans auth + persistant + jobs failed conservés) ; le worker le
    // récupère déchiffré via `GET /internal/notifications/smtp` (overlay +
    // X-Worker-Token, scopé tenant par `X-Tenant-Slug`).
    const all = await this.settings.getAll(orgId);
    const smtpCfg = readSmtpSettings(all);
    let smtp: EmailJobData['smtp'];
    if (smtpCfg.host) {
      smtp = {
        host: smtpCfg.host,
        port: smtpCfg.port,
        encryption: smtpCfg.encryption,
        authMode: smtpCfg.authMode,
        user: smtpCfg.user,
        password: null,
      };
    }
    const inlineImages: NonNullable<EmailJobData['inlineImages']> = [];
    const logo = prefs.logoUrl ? await this.loadInlineLogo(orgId, prefs.logoUrl) : null;
    if (logo && prefs.logoUrl === logo.url) {
      const cid = 'vaks-org-logo';
      // Le HTML contient l'URL escaped — voir email-templates.escape(). Le `?` et `&`
      // sont préservés par escape() (`escape` ne touche ni l'un ni l'autre), donc on
      // peut faire un split/join littéral sur l'URL stockée.
      html = html.split(logo.url).join(`cid:${cid}`);
      inlineImages.push({
        cid,
        base64: logo.base64,
        contentType: logo.mime,
        filename: `logo.${extFromMime(logo.mime)}`,
      });
    }

    await getEmailQueue().add('send', {
      organizationId: orgId,
      // Slug tenant (pooled) → header `X-Tenant-Slug` sur le callback worker→API
      // de mise à jour du statut EmailDelivery. Sans ça, le PATCH tape la base de
      // base et la ligne reste QUEUED à jamais (bug routing pooled). Null en dedicated.
      tenantSlug: this.tenant.currentSlug(),
      deliveryId,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html,
      fromName: prefs.fromName,
      fromAddress: prefs.fromAddress,
      replyTo: prefs.replyTo ?? undefined,
      smtp,
      inlineImages: inlineImages.length > 0 ? inlineImages : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });
  }
}

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/svg+xml': return 'svg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'bin';
  }
}
