import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { getEmailQueue } from '../notifications/email-queue';
import { readNotificationsSettings } from '../notifications/notifications-settings';
import { renderAnnouncement, TemplateContext } from '../notifications/email-templates';
import { WatchersService } from '../automations/watchers.service';
import { AuthUser } from '../auth/current-user.decorator';
import { AnnouncementAudience, CreateAnnouncementDto } from './dto/create-announcement.dto';

interface Recipient {
  id: string;
  name: string;
  email: string;
  preferredLanguage: string | null;
}

/** Anti-spam : une annonce max par auteur × projet par fenêtre. */
const ANNOUNCE_COOLDOWN_S = 120;

/**
 * Annonces projet : communication à la demande (typiquement déclenchée via
 * l'assistant IA — tool MCP `vaks_notify_stakeholders`) vers une audience
 * résolue par rôles. Principes (validés 2026-07-18) :
 *
 * - le LLM/l'auteur ne contrôle QUE `title`/`body` — l'enveloppe, le sujet
 *   préfixé, la ligne d'attribution (résolue du principal) et l'unique lien
 *   cliquable sont serveur ;
 * - audience par rôles (`pm`/`members`/`watchers`/`sponsors`), jamais
 *   d'adresses libres (anti-exfiltration, cohérent avec la gouvernance
 *   webhooks) ;
 * - principals AGENT refusés : le canal est réservé aux humains, y compris
 *   humain-via-MCP (le PAT OAuth porte un principal HUMAN) ;
 * - persistée (`Announcement`) + auditée + webhook `project.announcement`.
 */
@Injectable()
export class AnnouncementsService {
  private readonly log = new Logger(AnnouncementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditLogService,
    private readonly watchers: WatchersService,
    private readonly tenantUrl: TenantUrlService,
  ) {}

  /** Origine publique DU TENANT (jamais `APP_URL` global — liens morts en pooled). */
  private appBase(): string {
    return this.tenantUrl.publicBaseUrl();
  }

  async create(
    orgId: string,
    projectId: string,
    caller: AuthUser,
    dto: CreateAnnouncementDto,
    viaAssistant: boolean,
  ) {
    // Canal réservé aux humains (y compris via l'assistant) — un agent
    // autonome ne publie pas de communication officielle, décision produit.
    if (caller.actorKind === 'AGENT') {
      throw new ForbiddenException(
        "Announcements are reserved for human principals (including humans via the assistant).",
      );
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, kind: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (project.kind !== 'STANDARD') {
      throw new BadRequestException('Annonces indisponibles sur un projet conteneur externe');
    }

    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, projectId, deletedAt: null },
        select: { id: true },
      });
      if (!task) throw new BadRequestException('taskId ne référence pas une tâche de ce projet');
    }

    // Cooldown distribué par auteur × projet (même connexion Redis que la
    // queue email) — filet anti double-envoi / anti-spam.
    const redis = await getEmailQueue().client;
    const cdKey = `vaks:announce:${orgId}:${projectId}:${caller.userId}`;
    const ok = await (redis as unknown as {
      set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
    }).set(cdKey, '1', 'EX', ANNOUNCE_COOLDOWN_S, 'NX');
    if (ok !== 'OK') {
      throw new HttpException(
        'Une annonce vient déjà d’être envoyée sur ce projet — réessayez dans quelques minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const author = await this.prisma.user.findUnique({
      where: { id: caller.userId },
      select: { id: true, name: true, email: true },
    });
    const authorName = author?.name ?? caller.email;

    const audiences = [...new Set(dto.audience)] as AnnouncementAudience[];
    const recipients = await this.resolveAudience(orgId, projectId, audiences, dto.taskId);
    // L'auteur ne se notifie pas lui-même.
    const finalRecipients = recipients.filter((r) => r.id !== caller.userId);

    const announcement = await this.prisma.announcement.create({
      data: {
        organizationId: orgId,
        projectId,
        authorId: caller.userId,
        authorLabel: authorName,
        actorType: 'HUMAN',
        title: dto.title,
        body: dto.body,
        audience: audiences,
        recipientCount: finalRecipients.length,
        taskId: dto.taskId ?? null,
      },
    });

    const prefs = readNotificationsSettings(await this.settings.getAll(orgId));
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    const orgName = org?.name ?? 'Vaks';
    const ctaUrl = `${this.appBase()}/projects/${projectId}`;

    // Emails — communication explicitement déclenchée par un humain : pas de
    // report quiet hours ni de suppression digest, seul le kill switch org
    // (`notif.enabled`) est respecté.
    if (prefs.enabled) {
      for (const r of finalRecipients) {
        try {
          const lang = await this.notifications.resolveRecipientLanguage(orgId, r.preferredLanguage);
          const ctx: TemplateContext = {
            recipientName: r.name,
            orgName,
            lang,
            appUrl: this.appBase(),
            branding: {
              fromName: prefs.fromName,
              accentColor: prefs.accentColor,
              logoUrl: prefs.logoUrl,
            },
          };
          const rendered = renderAnnouncement(ctx, {
            authorName,
            viaAssistant,
            projectName: project.name,
            title: dto.title,
            body: dto.body,
            ctaUrl,
          });
          await this.notifications.enqueue(orgId, r.email, 'announcement', rendered, prefs);
        } catch (err) {
          this.log.warn(`announcement mail to ${r.email} failed: ${(err as Error).message}`);
        }
      }
    }

    // Webhook (cartes Teams via format:'teams').
    void this.webhooks.dispatch(
      orgId,
      'project.announcement',
      {
        announcementId: announcement.id,
        title: dto.title,
        message: dto.body.length > 2000 ? `${dto.body.slice(0, 2000)}…` : dto.body,
        authorName,
        viaAssistant,
        projectId,
        projectName: project.name,
        audience: audiences,
        recipientCount: finalRecipients.length,
        at: new Date().toISOString(),
      },
      { projectId },
    );

    // Audit explicite (le handler porte @SkipAudit) — trace complète de qui a
    // annoncé quoi à qui.
    this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.ANNOUNCEMENT_CREATED,
      actorId: caller.userId,
      resourceType: 'project',
      resourceId: projectId,
      resourceLabel: project.name,
      detail: {
        announcementId: announcement.id,
        title: dto.title,
        audience: audiences,
        recipientCount: finalRecipients.length,
        viaAssistant,
      },
    });

    return {
      id: announcement.id,
      title: announcement.title,
      audience: audiences,
      recipientCount: finalRecipients.length,
      // Noms seulement (pas d'adresses) — suffisant pour que l'assistant
      // confirme à l'utilisateur qui a été prévenu.
      recipients: finalRecipients.map((r) => ({ id: r.id, name: r.name })),
      createdAt: announcement.createdAt,
    };
  }

  /** Historique des annonces du projet (plus récentes d'abord). */
  async list(orgId: string, projectId: string, limit = 50) {
    return this.prisma.announcement.findMany({
      where: { organizationId: orgId, projectId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        authorId: true,
        authorLabel: true,
        title: true,
        body: true,
        audience: true,
        recipientCount: true,
        taskId: true,
        createdAt: true,
      },
    });
  }

  /**
   * Résolution serveur des audiences en personnes (humains actifs uniquement,
   * dédupliqués par id). `members` = membres directs du projet ; les membres
   * hérités d'une équipe affectée ne sont pas inclus en v1.
   */
  private async resolveAudience(
    orgId: string,
    projectId: string,
    audiences: AnnouncementAudience[],
    taskId?: string,
  ): Promise<Recipient[]> {
    const wants = new Set(audiences);
    const ids = new Set<string>();

    if (wants.has('pm') || wants.has('members') || wants.has('sponsors')) {
      const members = await this.prisma.projectMember.findMany({
        where: { projectId },
        select: { userId: true, isSponsor: true, role: { select: { key: true } } },
      });
      for (const m of members) {
        if (
          wants.has('members') ||
          (wants.has('pm') && m.role.key === 'PROJECT_MANAGER') ||
          (wants.has('sponsors') && m.isSponsor)
        ) {
          ids.add(m.userId);
        }
      }
    }

    if (wants.has('watchers')) {
      const watcherIds = await this.watchers.watchersOf(orgId, { projectId, taskId });
      for (const id of watcherIds) ids.add(id);
    }

    if (!ids.size) return [];
    return this.prisma.user.findMany({
      where: {
        id: { in: [...ids] },
        organizationId: orgId,
        kind: 'HUMAN',
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true, name: true, email: true, preferredLanguage: true },
    });
  }
}
