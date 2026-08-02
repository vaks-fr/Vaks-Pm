import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { LicenseService } from '../licensing/license.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { GraphService } from './graph.service';
import { getTeamsQueue } from './teams-queue';
import { SharePointProvider } from '../filesources/providers/sharepoint.provider';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

const FEATURE = 'teams-provisioning' as const;

type Action = 'provision' | 'archive' | 'unarchive' | 'reconcile';

interface ProvisionMember {
  objectId: string;
  owner?: boolean;
}

export interface ProvisionContext {
  token: string;
  teamName: string;
  description?: string;
  visibility: 'private' | 'public';
  channels: string[];
  /** Disposition à appliquer aux channels créés : `post` (Publications) / `chat` (Fils de discussion). */
  channelLayout: 'post' | 'chat';
  existingTeamId: string | null;
  members: ProvisionMember[];
  membersSkipped: number;
  /** Reconcile : retirer de Teams les membres qui ne sont plus désirés (opt-in). */
  removeOnLeave: boolean;
}

export interface ProvisionResult {
  action: Action;
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  teamId?: string | null;
  /** Lien « ouvrir l'équipe dans Teams » (propriété `webUrl` du team Graph). */
  webUrl?: string | null;
  membersAdded?: number;
  membersSkipped?: number;
  error?: string | null;
  /** Échec DÉFINITIF (retries épuisés / cas non-retryable) — déclenche l'alerte
   *  admins-tenant dans `applyResult`. */
  terminal?: boolean;
  /** Numéro de la tentative ayant produit ce résultat (informatif, pour l'email/audit). */
  attempts?: number;
}

@Injectable()
export class TeamsProvisioningService {
  private readonly logger = new Logger(TeamsProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly licenses: LicenseService,
    private readonly tenantCtx: TenantContext,
    private readonly graph: GraphService,
    private readonly moduleRef: ModuleRef,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
  ) {}

  /** Lève si la feature premium n'est pas active dans la licence du tenant. */
  private async assertFeature(): Promise<void> {
    if (!(await this.licenses.hasFeature(FEATURE))) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'LICENSE_FEATURE_DISABLED',
        message: 'Le provisioning Microsoft Teams requiert une licence active.',
        feature: FEATURE,
      });
    }
  }

  private renderName(pattern: string, p: { name: string; key: string; id: string; clientName: string | null }): string {
    return pattern
      .replace(/\{\{\s*project\.name\s*\}\}/g, p.name)
      .replace(/\{\{\s*project\.key\s*\}\}/g, p.key)
      .replace(/\{\{\s*project\.id\s*\}\}/g, p.id)
      .replace(/\{\{\s*client\.name\s*\}\}/g, p.clientName ?? '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 256);
  }

  /**
   * Enqueue une opération de provisioning. Gate licence + config activée ;
   * idempotent sur `msTeamId` (provision déjà faite → skip, sauf `force`).
   * Renvoie un statut lisible pour l'UI (`queued` / `skipped` / `disabled`).
   */
  async enqueue(
    orgId: string,
    projectId: string,
    action: Action,
    opts: { force?: boolean } = {},
  ): Promise<{ status: 'queued' | 'skipped'; reason?: string }> {
    await this.assertFeature();
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.enabled) {
      throw new BadRequestException('Le provisioning Microsoft Teams est désactivé (admin).');
    }
    if (!cfg.tenantId || !cfg.clientId) {
      throw new BadRequestException('Configuration Graph incomplète (tenantId / clientId).');
    }
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, kind: true, msTeamId: true, msTeamStatus: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (project.kind !== 'STANDARD') {
      throw new BadRequestException('Provisioning indisponible sur un projet externe.');
    }

    if (action === 'provision' && project.msTeamId && !opts.force) {
      return { status: 'skipped', reason: 'Équipe déjà provisionnée' };
    }
    if ((action === 'archive' || action === 'unarchive') && !project.msTeamId) {
      return { status: 'skipped', reason: 'Aucune équipe associée' };
    }

    await this.pushJob(orgId, projectId, action);
    return { status: 'queued' };
  }

  /** Met PENDING (provision) puis enqueue le job. Partagé manuel ↔ auto-trigger. */
  private async pushJob(orgId: string, projectId: string, action: Action): Promise<void> {
    if (action === 'provision') {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { msTeamStatus: 'PENDING' },
      });
    }
    await getTeamsQueue().add(action, {
      action,
      projectId,
      organizationId: orgId,
      tenantSlug: this.tenantCtx.currentSlug(),
    });
    this.logger.log(`Teams job queued: action=${action} project=${projectId} org=${orgId}`);
  }

  /**
   * Point d'entrée **best-effort** appelé par `ProjectsService.update()` à chaque
   * changement de statut projet. Silencieux (jamais d'exception remontée — il ne
   * doit pas casser une mise à jour de projet) :
   *  - entrée en ACTIVE → provision (ou unarchive si l'équipe était archivée) ;
   *  - entrée dans un statut FERMÉ (COMPLETED/ARCHIVED) avec une équipe encore
   *    active → archive (si `archiveOnClose`).
   * L'archivage se décide sur l'ÉTAT RÉEL de l'équipe (`msTeamStatus === 'ACTIVE'`),
   * pas sur la transition exacte : ainsi COMPLETED → ARCHIVED **rattrape** un
   * archivage manqué au premier passage ACTIVE → COMPLETED (sans quoi l'équipe
   * resterait orpheline à jamais). Idempotent : provision skip si `msTeamId` déjà
   * posé ; archive skip si l'équipe est déjà ARCHIVED.
   */
  async onProjectStatusChanged(
    orgId: string,
    projectId: string,
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    if (!(await this.licenses.hasFeature(FEATURE))) return;
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.enabled || !cfg.tenantId || !cfg.clientId) return;

    const CLOSED = new Set(['COMPLETED', 'ARCHIVED']);
    const entering = newStatus === 'ACTIVE' && oldStatus !== 'ACTIVE';
    const closing = CLOSED.has(newStatus);
    if (!entering && !closing) return;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { kind: true, msTeamId: true, msTeamStatus: true },
    });
    if (!project || project.kind !== 'STANDARD') return;

    if (entering) {
      if (project.msTeamId && project.msTeamStatus === 'ARCHIVED') {
        await this.pushJob(orgId, projectId, 'unarchive');
      } else if (!project.msTeamId) {
        await this.pushJob(orgId, projectId, 'provision');
      }
      // équipe déjà active → rien
    } else if (
      closing &&
      cfg.archiveOnClose &&
      project.msTeamId &&
      project.msTeamStatus === 'ACTIVE'
    ) {
      await this.pushJob(orgId, projectId, 'archive');
    }
  }

  /**
   * Best-effort : ré-synchronise la membership Teams d'UN projet après un
   * changement de membres (ajout/retrait membre, affectation/retrait d'équipe).
   * No-op si le projet n'a pas d'équipe provisionnée et active.
   */
  async enqueueReconcileForProject(orgId: string, projectId: string): Promise<void> {
    if (!(await this.licenses.hasFeature(FEATURE))) return;
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.enabled) return;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { msTeamId: true, msTeamStatus: true },
    });
    if (!project?.msTeamId || project.msTeamStatus !== 'ACTIVE') return;
    await this.pushJob(orgId, projectId, 'reconcile');
  }

  /**
   * Best-effort : un changement de composition d'une ÉQUIPE impacte tous les
   * projets provisionnés qui l'incluent (modes `assigned_teams`/`both`). On
   * enqueue une reconcile pour chacun.
   */
  async enqueueReconcileForTeam(orgId: string, teamId: string): Promise<void> {
    if (!(await this.licenses.hasFeature(FEATURE))) return;
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.enabled || cfg.membership === 'project_members') return;
    const links = await this.prisma.projectTeam.findMany({
      where: {
        teamId,
        project: {
          organizationId: orgId,
          deletedAt: null,
          msTeamId: { not: null },
          msTeamStatus: 'ACTIVE',
        },
      },
      select: { projectId: true },
    });
    for (const l of links) await this.pushJob(orgId, l.projectId, 'reconcile');
  }

  /**
   * Filet de sécurité (cron) : enqueue une reconcile pour TOUS les projets
   * provisionnés actifs de la base tenant courante (rattrape les events manqués
   * / la dérive). Le contexte tenant est déjà posé par le cron.
   */
  async reconcileAllProvisioned(): Promise<number> {
    if (!(await this.licenses.hasFeature(FEATURE))) return 0;
    const projects = await this.prisma.project.findMany({
      where: { msTeamId: { not: null }, msTeamStatus: 'ACTIVE', deletedAt: null },
      select: { id: true, organizationId: true },
    });
    let n = 0;
    const enabledByOrg = new Map<string, boolean>();
    for (const p of projects) {
      let enabled = enabledByOrg.get(p.organizationId);
      if (enabled === undefined) {
        enabled = (await this.settings.getTeamsProvisioningConfig(p.organizationId)).enabled;
        enabledByOrg.set(p.organizationId, enabled);
      }
      if (!enabled) continue;
      await this.pushJob(p.organizationId, p.id, 'reconcile');
      n++;
    }
    return n;
  }

  /**
   * Contexte complet consommé par le worker (token Graph minté ici, config,
   * membres résolus en objectId Entra). Appelé via l'endpoint interne.
   */
  async buildContext(orgId: string, projectId: string, action: Action): Promise<ProvisionContext> {
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    const cred = await this.settings.resolveGraphCredential(orgId, cfg.tenantId, cfg.clientId, 'teams.provisioning');
    const token = await this.graph.getAppToken(cred);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: { id: true, name: true, key: true, msTeamId: true, client: { select: { name: true } } },
    });
    if (!project) throw new NotFoundException('Projet introuvable');

    const teamName = this.renderName(cfg.namePattern, {
      name: project.name,
      key: project.key,
      id: project.id,
      clientName: project.client?.name ?? null,
    });

    // archive/unarchive : on n'a besoin que de l'existingTeamId + token.
    if (action === 'archive' || action === 'unarchive') {
      return {
        token,
        teamName,
        visibility: cfg.visibility,
        channels: [],
        channelLayout: cfg.channelLayout,
        existingTeamId: project.msTeamId,
        members: [],
        membersSkipped: 0,
        removeOnLeave: cfg.removeOnLeave,
      };
    }

    // provision ET reconcile résolvent l'ensemble des membres désirés. La
    // reconcile ne (re)crée pas les channels (channels vides) — uniquement la
    // membership ; la provision les crée.
    const { members, skipped } = await this.resolveMembers(projectId, cfg.membership);
    return {
      token,
      teamName,
      description: `Projet ${project.name}`,
      visibility: cfg.visibility,
      channels: action === 'provision' ? cfg.channels : [],
      channelLayout: cfg.channelLayout,
      existingTeamId: project.msTeamId,
      members,
      membersSkipped: skipped,
      removeOnLeave: cfg.removeOnLeave,
    };
  }

  /**
   * Résout l'ensemble des membres à inviter selon le mode admin. Ne retient que
   * les utilisateurs ACTIVE liés à Entra (`externalId`). Les comptes locaux sont
   * comptés dans `skipped` (non invitables). Désigne un owner (lead d'équipe en
   * priorité) — obligatoire pour une création app-only.
   */
  private async resolveMembers(
    projectId: string,
    mode: 'assigned_teams' | 'project_members' | 'both',
  ): Promise<{ members: ProvisionMember[]; skipped: number }> {
    // userId -> { externalId, isLead }
    const map = new Map<string, { externalId: string | null; isLead: boolean }>();
    const skippedUsers = new Set<string>();

    const consider = (userId: string, externalId: string | null, status: string, isLead: boolean) => {
      if (status !== 'ACTIVE') return;
      if (!externalId) {
        skippedUsers.add(userId);
        return;
      }
      const cur = map.get(userId);
      if (cur) cur.isLead = cur.isLead || isLead;
      else map.set(userId, { externalId, isLead });
    };

    if (mode === 'project_members' || mode === 'both') {
      const pms = await this.prisma.projectMember.findMany({
        where: { projectId },
        select: { user: { select: { id: true, externalId: true, status: true } } },
      });
      for (const pm of pms) consider(pm.user.id, pm.user.externalId, pm.user.status, false);
    }
    if (mode === 'assigned_teams' || mode === 'both') {
      const pts = await this.prisma.projectTeam.findMany({
        where: { projectId },
        select: {
          team: {
            select: {
              members: {
                select: { isLead: true, user: { select: { id: true, externalId: true, status: true } } },
              },
            },
          },
        },
      });
      for (const pt of pts) {
        for (const tm of pt.team.members) {
          consider(tm.user.id, tm.user.externalId, tm.user.status, tm.isLead);
        }
      }
    }

    const entries = [...map.entries()];
    // Owner = premier lead lié à Entra, sinon premier membre.
    const ownerId = entries.find(([, v]) => v.isLead)?.[0] ?? entries[0]?.[0];
    const members: ProvisionMember[] = entries.map(([, v]) => ({
      objectId: v.externalId as string,
      owner: false,
    }));
    if (ownerId) {
      const owner = members.find((m) => m.objectId === map.get(ownerId)!.externalId);
      if (owner) owner.owner = true;
    }
    return { members, skipped: skippedUsers.size };
  }

  /**
   * Ensemble des `userId` vaks qui font partie de la team Microsoft provisionnée
   * pour ce projet, selon le mode de membership configuré (`project_members` /
   * `assigned_teams` / `both`) — **exactement le set que `resolveMembers` invite**.
   * Ne retient que les users ACTIVE liés à Entra (`externalId`) : un compte local
   * n'est jamais invité, donc n'a pas accès au SharePoint côté Microsoft non plus.
   *
   * Sert à gater la visibilité HUMAINE des documents SharePoint : seul un membre
   * réellement invité dans la team voit le drive dans vaks (aucune exposition
   * nouvelle — il y a déjà accès côté Microsoft).
   */
  async resolveMemberUserIds(orgId: string, projectId: string): Promise<Set<string>> {
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    const ids = new Set<string>();
    const add = (userId: string, externalId: string | null, status: string) => {
      if (status !== 'ACTIVE' || !externalId) return;
      ids.add(userId);
    };
    if (cfg.membership === 'project_members' || cfg.membership === 'both') {
      const pms = await this.prisma.projectMember.findMany({
        where: { projectId },
        select: { user: { select: { id: true, externalId: true, status: true } } },
      });
      for (const pm of pms) add(pm.user.id, pm.user.externalId, pm.user.status);
    }
    if (cfg.membership === 'assigned_teams' || cfg.membership === 'both') {
      const pts = await this.prisma.projectTeam.findMany({
        where: { projectId },
        select: {
          team: {
            select: { members: { select: { user: { select: { id: true, externalId: true, status: true } } } } },
          },
        },
      });
      for (const pt of pts) {
        for (const tm of pt.team.members) add(tm.user.id, tm.user.externalId, tm.user.status);
      }
    }
    return ids;
  }

  /** Persiste le résultat d'une opération worker + journal. */
  async applyResult(orgId: string, projectId: string, r: ProvisionResult): Promise<void> {
    const data: Record<string, unknown> = {};
    if (r.action === 'provision') {
      if (r.status === 'FAILED') {
        data.msTeamStatus = 'FAILED';
      } else {
        if (r.teamId) data.msTeamId = r.teamId;
        data.msTeamStatus = 'ACTIVE';
        data.msTeamProvisionedAt = new Date();
      }
    } else if (r.action === 'archive' && r.status !== 'FAILED') {
      data.msTeamStatus = 'ARCHIVED';
    } else if (r.action === 'unarchive' && r.status !== 'FAILED') {
      data.msTeamStatus = 'ACTIVE';
    }
    if (Object.keys(data).length) {
      await this.prisma.project.updateMany({
        where: { id: projectId, organizationId: orgId },
        data: data as never,
      });
    }

    // Échec DÉFINITIF (retries BullMQ épuisés / cas non-retryable) : jusqu'ici
    // silencieux (console.error worker) — alerte les admins du tenant. L'état
    // FAILED ci-dessus est déjà écrit ; cette étape est best-effort en plus.
    if (r.status === 'FAILED' && r.terminal === true) {
      await this.alertProvisionFailed(orgId, projectId, r);
    }

    // Espace de collaboration : à un provisioning réussi, on inscrit/actualise
    // la ligne `ProjectCollabSpace` (source `provisioned`) — l'équipe Teams
    // apparaît alors dans l'onglet Intégrations du projet, à côté des espaces
    // déclarés par un outil externe, et le garde-fou 409 (un tiers ne détourne
    // pas un espace géré par Vaks) devient actif. Best-effort : ne doit jamais
    // faire échouer la persistance du résultat.
    if (r.action === 'provision' && r.status !== 'FAILED' && r.teamId) {
      await this.upsertProvisionedCollabSpace(orgId, projectId, r.teamId, r.webUrl ?? null);
    }

    await this.prisma.msTeamProvisionLog.create({
      data: {
        organizationId: orgId,
        projectId,
        action: r.action,
        status: r.status,
        teamId: r.teamId ?? null,
        membersAdded: r.membersAdded ?? 0,
        membersSkipped: r.membersSkipped ?? 0,
        error: r.error ?? null,
      },
    });

    // Provisioning réussi → résout le site SharePoint et pose le grant lecteur
    // (contexte documentaire des agents IA). Best-effort, jamais bloquant :
    // `resolveAndGrant` ne jette pas ; un échec laisse `msSpGrantStatus=FAILED`.
    // ⚠️ Le site SharePoint d'un groupe est créé de façon ASYNCHRONE par Microsoft
    // (secondes → minutes) : la résolution immédiate hit quasi toujours un 404
    // (site pas encore prêt). On tente quand même tout de suite (cas rare où il
    // existe déjà), puis on planifie des reconcile différés pour rattraper ; et le
    // cron de reconcile (6 h) retente tant que le grant n'est pas GRANTED.
    if (r.action === 'provision' && r.status !== 'FAILED' && r.teamId) {
      try {
        const sharepoint = this.moduleRef.get(SharePointProvider, { strict: false });
        void sharepoint.resolveAndGrant(orgId, projectId, r.teamId);
      } catch {
        /* provider indisponible : ignoré */
      }
      // Retry différés : le site est rarement prêt dans la seconde. Idempotents
      // (early-return si déjà GRANTED). Reconcile réutilisé tel quel (aucune modif
      // worker) — sa branche ci-dessous relance la résolution SharePoint.
      await this.scheduleSharePointRetry(orgId, projectId, 90_000);
      await this.scheduleSharePointRetry(orgId, projectId, 600_000);
    }

    // Reconcile → rattrape une résolution SharePoint jamais aboutie (le site
    // n'était pas prêt au provisioning). Best-effort, uniquement si le projet veut
    // le contexte documentaire et que le grant n'est pas encore posé.
    if (r.action === 'reconcile' && r.status !== 'FAILED') {
      await this.retrySharePointIfPending(orgId, projectId);
    }
  }

  /**
   * Alerte les admins du tenant qu'un provisioning Teams a échoué DÉFINITIVEMENT
   * (retries BullMQ épuisés, ou cas non-retryable connu d'avance) — jusqu'ici
   * silencieux (juste un `console.error` côté worker). Triple effet, calqué sur
   * `AuditAlertsService`/`BackupAlertService` :
   *   1. cooldown Redis PAR PROJET (1h) pour ne pas spammer un projet qui
   *      re-échoue à chaque déclenchement de provisioning ;
   *   2. email à chaque admin du tenant (`isAdmin` actif) ;
   *   3. entrée d'audit WARNING `teams.provision.failed`.
   * Fail-open intégral : une erreur ici ne doit jamais faire échouer
   * `applyResult` (l'état FAILED est déjà écrit avant cet appel).
   */
  private async alertProvisionFailed(
    orgId: string,
    projectId: string,
    r: ProvisionResult,
  ): Promise<void> {
    try {
      const redis = await getTeamsQueue().client;
      const ok = await (redis as unknown as {
        set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
      }).set(`vaks:teams-alert:${projectId}`, '1', 'EX', 3600, 'NX');
      if (ok !== 'OK') return;

      const project = await this.prisma.project.findFirst({
        where: { id: projectId, organizationId: orgId },
        select: { name: true },
      });
      const projectName = project?.name ?? projectId;
      const error = r.error ?? 'Erreur inconnue';
      const attempts = r.attempts ?? 1;

      const admins = await this.prisma.user.findMany({
        where: { organizationId: orgId, isAdmin: true, deletedAt: null, status: 'ACTIVE' },
        select: { email: true, name: true, preferredLanguage: true },
      });
      for (const a of admins) {
        try {
          await this.notifications.sendTeamsProvisionFailedAlert(
            orgId,
            a.email,
            a.name,
            { projectName, action: r.action, attempts, error },
            a.preferredLanguage,
          );
        } catch (err) {
          this.logger.warn(`teams provision failed mail to ${a.email} failed: ${(err as Error).message}`);
        }
      }

      void this.audit.logNow({
        organizationId: orgId,
        action: AUDIT_ACTIONS.TEAMS_PROVISION_FAILED,
        severity: 'WARNING',
        actorType: 'SYSTEM',
        resourceType: 'project',
        resourceId: projectId,
        resourceLabel: projectName,
        detail: { error, attempts, action: r.action },
      });

      this.logger.warn(
        `Alerte teams.provision.failed org=${orgId} project=${projectId} action=${r.action} attempts=${attempts}`,
      );
    } catch (err) {
      // Fail-open : l'alerting ne casse jamais applyResult.
      this.logger.error(`alertProvisionFailed failed: ${(err as Error).message}`);
    }
  }

  /**
   * Inscrit (ou actualise) l'espace de collaboration provisionné pour ce projet.
   * Idempotent sur `(org, projet, provider='msteams')`. `source='provisioned'`
   * marque un espace géré par Vaks — protégé du détournement par un tiers.
   * URL = `webUrl` du team quand disponible, sinon un deeplink de repli.
   */
  private async upsertProvisionedCollabSpace(
    orgId: string,
    projectId: string,
    teamId: string,
    webUrl: string | null,
  ): Promise<void> {
    const url = webUrl || `https://teams.microsoft.com/l/team/conversations?groupId=${teamId}`;
    try {
      const existing = await this.prisma.projectCollabSpace.findFirst({
        where: { organizationId: orgId, projectId, provider: 'msteams' },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.projectCollabSpace.update({
          where: { id: existing.id },
          data: { externalId: teamId, url, source: 'provisioned', linkedAt: new Date() },
        });
      } else {
        await this.prisma.projectCollabSpace.create({
          data: {
            organizationId: orgId,
            projectId,
            provider: 'msteams',
            externalId: teamId,
            url,
            name: 'Microsoft Teams',
            source: 'provisioned',
          },
        });
      }
      this.logger.log(
        `Collab space linked: project=${projectId} provider=msteams team=${teamId} (${existing ? 'updated' : 'created'})`,
      );
    } catch (e) {
      // Best-effort : un souci ici ne doit pas invalider le provisioning réussi.
      this.logger.warn(
        `Failed to link collab space for project=${projectId} team=${teamId}: ${(e as Error).message}`,
      );
    }
  }

  /** Enqueue une reconcile différée (rattrape la résolution SharePoint async). */
  private async scheduleSharePointRetry(
    orgId: string,
    projectId: string,
    delayMs: number,
  ): Promise<void> {
    try {
      await getTeamsQueue().add(
        'reconcile',
        {
          action: 'reconcile',
          projectId,
          organizationId: orgId,
          tenantSlug: this.tenantCtx.currentSlug(),
        },
        { delay: delayMs },
      );
    } catch {
      /* best-effort : le cron de reconcile 6 h reste le filet final */
    }
  }

  /**
   * Relance la résolution/grant SharePoint si le projet la veut (`spContextEnabled`)
   * et qu'elle n'a pas encore abouti (`msSpGrantStatus != GRANTED`). No-op sinon —
   * pas d'appel Graph inutile pour les projets déjà résolus ou sans contexte doc.
   */
  private async retrySharePointIfPending(orgId: string, projectId: string): Promise<void> {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: { msTeamId: true, msSpGrantStatus: true, spContextEnabled: true },
    });
    if (!p?.msTeamId || !p.spContextEnabled || p.msSpGrantStatus === 'GRANTED') return;
    try {
      const sharepoint = this.moduleRef.get(SharePointProvider, { strict: false });
      await sharepoint.resolveAndGrant(orgId, projectId, p.msTeamId);
    } catch {
      /* provider indisponible : ignoré */
    }
  }

  /** Statut + derniers logs pour l'UI projet. */
  async status(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: { msTeamId: true, msTeamStatus: true, msTeamProvisionedAt: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    const logs = await this.prisma.msTeamProvisionLog.findMany({
      where: { organizationId: orgId, projectId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return { ...project, logs };
  }

  /** Test de connexion Graph (bouton admin) — n'expose jamais le secret. */
  async testConnection(orgId: string): Promise<{ ok: boolean; message: string }> {
    await this.assertFeature();
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.tenantId || !cfg.clientId) {
      return { ok: false, message: 'Configuration incomplète (tenantId / clientId).' };
    }
    let cred;
    try {
      cred = await this.settings.resolveGraphCredential(orgId, cfg.tenantId, cfg.clientId, 'teams.provisioning');
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const hasAuth =
      cred.authMethod === 'client_assertion' ? !!cred.privateKeyPem : !!cred.clientSecret;
    if (!hasAuth) {
      return { ok: false, message: 'Configuration incomplète (client secret ou certificat requis).' };
    }
    return this.graph.testConnection(cred);
  }
}
