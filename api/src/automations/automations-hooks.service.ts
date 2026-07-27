import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { SkillRequestsService } from '../skill-requests/skill-requests.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { readAutomationsSettings } from './automations-settings';
import { readSponsorNotify } from './sponsor-notify';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationRecipientsService } from './automation-recipients.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';

/**
 * Hooks événementiels du moteur d'automatisations : les règles dont la
 * condition naît d'une action utilisateur, pas de l'écoulement du temps (le
 * cron traite les autres).
 *
 * Contrat identique à `AuditAlertsService` et aux méthodes `notify*` :
 * **fire-and-forget et fail-open** — les appelants font `void this.hooks.onX(…)`
 * et aucune erreur ici ne doit casser la mutation métier qui les déclenche.
 *
 * Anti-boucle : chaque hook sort immédiatement si le déclencheur est le moteur
 * lui-même (`caller.system`), pour que les mutations automatiques du lot 5 ne
 * puissent pas ré-alimenter les règles.
 */
@Injectable()
export class AutomationsHooksService {
  private readonly log = new Logger(AutomationsHooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly actions: AutomationActionsService,
    private readonly recipients: AutomationRecipientsService,
    private readonly tenantUrl: TenantUrlService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Origine publique DU TENANT courant (jamais `APP_URL` global : en pooled
   *  chaque tenant a son host). Cf. TenantUrlService. */
  private appBase(): string {
    return this.tenantUrl.publicBaseUrl();
  }

  /** Settings de l'org, ou null si le moteur est coupé (kill switch). */
  private async enabledSettings(orgId: string) {
    const s = readAutomationsSettings(await this.settings.getAll(orgId));
    return s.enabled ? s : null;
  }

  // ============================================================
  // Feed sponsor (2026-07-18) — événements « en altitude » destinés aux
  // membres `isSponsor` du projet, gatés par `Project.sponsorNotify` (pas par
  // le kill switch automations : c'est une feature projet, pas une règle du
  // moteur). Le chokepoint `emit` conserve cooldown / quiet hours / kill
  // switch email / ajout des watchers.
  // ============================================================

  /** Jalon (`isMilestone`) passé à DONE → sponsors (défaut ON). */
  async onMilestoneCompleted(
    orgId: string,
    task: { id: string; title: string },
    projectId: string,
  ): Promise<void> {
    try {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, organizationId: orgId, deletedAt: null },
        select: { id: true, name: true, sponsorNotify: true },
      });
      if (!project) return;
      if (!readSponsorNotify(project.sponsorNotify).milestoneReached) return;
      const sponsors = await this.recipients.projectSponsors(projectId);
      if (!sponsors.length) return;
      await this.actions.emit(orgId, {
        kind: 'milestone_reached',
        entityId: task.id,
        recipients: sponsors,
        params: { taskTitle: task.title, projectName: project.name },
        taskId: task.id,
        projectId,
        url: `${this.appBase()}/tasks/${task.id}`,
      });
    } catch (err) {
      this.log.warn(`onMilestoneCompleted(${task.id}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Une tâche vient d'ENTRER dans un sous-statut (Custom Status) qui a des
   * destinataires configurés (`notifyUserIds`/`notifyTeamIds`) → email + carte
   * Teams aux users directs + membres des équipes. Feature par sous-statut
   * (comme le feed sponsor : pas gatée par le kill switch automations) ; le
   * chokepoint `emit` garde cooldown (par tâche×sous-statut — une carte qui
   * fait des allers-retours ne spamme pas), quiet hours et kill switch email.
   * L'acteur du déplacement est exclu (il sait déjà).
   */
  async onSubStatusEntered(
    orgId: string,
    task: { id: string; title: string; projectId: string },
    subStatusId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    try {
      const sub = await this.prisma.customStatus.findFirst({
        where: { id: subStatusId, organizationId: orgId },
        select: { id: true, name: true, notifyUserIds: true, notifyTeamIds: true },
      });
      if (!sub || (sub.notifyUserIds.length === 0 && sub.notifyTeamIds.length === 0)) return;
      const targets = await this.recipients.subStatusTargets(
        orgId,
        sub.notifyUserIds,
        sub.notifyTeamIds,
        actorUserId,
      );
      if (!targets.length) return;
      const project = await this.prisma.project.findFirst({
        where: { id: task.projectId, organizationId: orgId },
        select: { name: true },
      });
      await this.actions.emit(orgId, {
        kind: 'sub_status_entered',
        entityId: task.id,
        qualifier: sub.id,
        recipients: targets,
        params: { taskTitle: task.title, subStatusName: sub.name, projectName: project?.name ?? '' },
        taskId: task.id,
        projectId: task.projectId,
        url: `${this.appBase()}/tasks/${task.id}`,
      });
    } catch (err) {
      this.log.warn(`onSubStatusEntered(${task.id}) failed: ${(err as Error).message}`);
    }
  }

  /** Changement de statut du projet → sponsors (défaut ON). */
  async onProjectStatusChanged(
    orgId: string,
    project: { id: string; name: string; sponsorNotify?: unknown },
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    try {
      if (!readSponsorNotify(project.sponsorNotify).projectStatus) return;
      const sponsors = await this.recipients.projectSponsors(project.id);
      if (!sponsors.length) return;
      await this.actions.emit(orgId, {
        kind: 'project_status_changed',
        entityId: project.id,
        // Qualifié par le statut d'arrivée : deux transitions distinctes
        // rapprochées passent toutes les deux, une oscillation est filtrée.
        qualifier: toStatus,
        recipients: sponsors,
        params: { projectName: project.name, from: fromStatus, to: toStatus },
        projectId: project.id,
        url: `${this.appBase()}/projects/${project.id}`,
      });
    } catch (err) {
      this.log.warn(`onProjectStatusChanged(${project.id}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Règle 17 — tâche créée avec une compétence requise que **personne sur le
   * projet** ne couvre. Check volontairement léger (pool + un `count`) : il
   * tourne dans le chemin de création de tâche, on ne rejoue pas le gap complet
   * du projet (`SkillsService.computeSkillGapForProject` scanne toutes les
   * tâches — bien trop lourd ici).
   */
  async onTaskCreated(
    orgId: string,
    task: { id: string; title: string; requiredSkillId: string | null; requiredSkillLevel: number | null },
    projectId: string,
    caller?: { system?: boolean },
  ): Promise<void> {
    try {
      if (caller?.system) return;
      if (!task.requiredSkillId) return;
      const s = await this.enabledSettings(orgId);
      if (!s || !s.skillGapOnCreate.enabled) return;

      const level = task.requiredSkillLevel ?? 1;
      const pool = await this.projectPoolUserIds(projectId);
      if (!pool.length) return; // projet sans personne : ce n'est pas un gap de skill

      const covered = await this.prisma.userSkill.count({
        where: {
          userId: { in: pool },
          skillId: task.requiredSkillId,
          level: { gte: level },
          // Une compétence expirée ne couvre plus rien.
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (covered > 0) return;

      const [skill, project, to] = await Promise.all([
        this.prisma.skill.findFirst({
          where: { id: task.requiredSkillId, organizationId: orgId },
          select: { name: true },
        }),
        this.prisma.project.findFirst({ where: { id: projectId }, select: { name: true } }),
        this.recipients.projectPMs(projectId),
      ]);
      if (!to.length) return;

      const outcome = await this.actions.emit(orgId, {
        kind: 'skill_gap',
        entityId: task.id,
        recipients: to,
        params: {
          taskTitle: task.title,
          projectName: project?.name ?? '',
          skillName: skill?.name ?? task.requiredSkillId,
          level: task.requiredSkillLevel ?? undefined,
        },
        taskId: task.id,
        projectId,
        url: `${this.appBase()}/tasks/${task.id}`,
      });

      // Demande de compétence automatique (opt-in). Adossée à l'alerte réelle :
      // si le cooldown a mangé l'alerte, on ne crée pas non plus la demande.
      if (s.skillGapOnCreate.autoRequest && outcome === 'sent') {
        await this.autoRequestSkill(orgId, projectId, task, skill?.name ?? null, level);
      }
    } catch (err) {
      this.log.warn(`onTaskCreated failed: ${(err as Error).message}`);
    }
  }

  /**
   * Crée une demande de compétence au nom du moteur.
   *
   * L'équipe destinataire n'est pas un détail : une demande vise une équipe
   * **et son lead**. On ne choisit donc que si l'on sait vraiment à qui
   * s'adresser — une équipe affectée au projet dont les `TeamSkill` couvrent la
   * compétence demandée (c'est elle qui peut la fournir). Sinon on renonce : le
   * PM a déjà reçu l'alerte et créera la demande lui-même, en connaissance de
   * cause. Le système n'invente jamais un destinataire.
   */
  private async autoRequestSkill(
    orgId: string,
    projectId: string,
    task: { id: string; title: string; requiredSkillId: string | null },
    skillName: string | null,
    level: number,
  ): Promise<void> {
    try {
      if (!task.requiredSkillId) return;
      const candidate = await this.prisma.projectTeam.findFirst({
        where: {
          projectId,
          team: {
            deletedAt: null,
            skills: { some: { skillId: task.requiredSkillId } },
          },
        },
        select: { teamId: true, team: { select: { name: true } } },
      });
      if (!candidate) {
        this.log.debug(
          `skill gap auto-request skipped task=${task.id}: aucune équipe du projet ne couvre le skill`,
        );
        return;
      }

      const svc = this.skillRequests();
      if (!svc) return;
      await svc.createFromAutomation(orgId, {
        teamId: candidate.teamId,
        type: 'ASSIGN_SKILL',
        skillId: task.requiredSkillId,
        desiredLevel: level,
        projectId,
        taskId: task.id,
        note: `Demande créée automatiquement : la tâche « ${task.title} » requiert ${skillName ?? 'cette compétence'}${level > 1 ? ` (niveau ${level})` : ''} et aucun membre du projet ne la couvre.`,
      });
      this.actions.logMutation(orgId, {
        kind: 'skill_gap',
        resourceType: 'task',
        resourceId: task.id,
        resourceLabel: task.title,
        field: 'skillRequest',
        before: null,
        after: { teamId: candidate.teamId, skillId: task.requiredSkillId, desiredLevel: level },
      });
    } catch (err) {
      // L'alerte est déjà partie : une demande ratée ne doit rien casser.
      this.log.warn(`autoRequestSkill task=${task.id} failed: ${(err as Error).message}`);
    }
  }

  /** `SkillRequestsService` en lazy (cf. commentaire de classe). */
  private skillRequests(): SkillRequestsService | null {
    try {
      return this.moduleRef.get(SkillRequestsService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Pool de candidats d'un projet : membres directs + membres des équipes
   * affectées, actifs. Même définition que le calcul de gap
   * (`SkillsService.computeSkillGapForProject`) — gardée alignée avec lui.
   */
  private async projectPoolUserIds(projectId: string): Promise<string[]> {
    const active = { deletedAt: null, status: 'ACTIVE' as const };
    const [direct, teams] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId, user: active },
        select: { userId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId },
        select: {
          team: { select: { members: { where: { user: active }, select: { userId: true } } } },
        },
      }),
    ]);
    return [
      ...new Set([
        ...direct.map((m) => m.userId),
        ...teams.flatMap((pt) => pt.team.members.map((m) => m.userId)),
      ]),
    ];
  }

  /**
   * Règle 4 — une sous-tâche vient de passer DONE : si c'était la dernière, le
   * parent est prêt à être revu.
   *
   * Trois modes (`automations.parentAutoAdvance.mode`) :
   *  - `off`     : rien ;
   *  - `notify`  : on prévient le PM (défaut — on ne touche pas au board) ;
   *  - `advance` : on passe le parent en IN_REVIEW (mutation, opt-in).
   *
   * ⚠️ Anti-cascade : sortie immédiate si le changement vient du moteur
   * (`caller.system`). Sans ce garde, avancer un parent qui est lui-même
   * sous-tâche d'un grand-parent pourrait remonter tout l'arbre en chaîne.
   * Structurellement le risque est faible (on écrit IN_REVIEW, pas DONE, et
   * seul DONE déclenche ce hook) mais on ne s'appuie pas là-dessus.
   */
  async onSubtaskDone(
    orgId: string,
    parentTaskId: string,
    subtaskId: string,
    caller?: { system?: boolean },
  ): Promise<void> {
    try {
      if (caller?.system) return;
      const s = await this.enabledSettings(orgId);
      if (!s || s.parentAutoAdvance === 'off') return;

      const parent = await this.prisma.task.findFirst({
        where: { id: parentTaskId, organizationId: orgId, deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          project: { select: { id: true, name: true } },
        },
      });
      // Un parent déjà terminé/approuvé n'a plus rien à attendre de ses enfants.
      if (!parent || ['DONE', 'APPROVED', 'IN_REVIEW'].includes(parent.status)) return;

      // Reste-t-il une sous-tâche non terminée ? (une seule requête, pas de
      // chargement de la fratrie complète)
      const pending = await this.prisma.task.count({
        where: {
          parentTaskId,
          organizationId: orgId,
          deletedAt: null,
          status: { notIn: ['DONE'] },
        },
      });
      if (pending > 0) return; // ce n'était pas la dernière
      void subtaskId; // (le déclencheur ne sert pas au message : c'est le parent qui compte)

      const pms = await this.recipients.projectPMs(parent.project.id);

      if (s.parentAutoAdvance === 'advance') {
        const tasks = this.tasksService();
        if (!tasks) return;
        await tasks.update(orgId, parent.id, { status: 'IN_REVIEW' }, null, {
          isAdmin: true,
          system: true,
        });
        this.actions.logMutation(orgId, {
          kind: 'parent_ready',
          resourceType: 'task',
          resourceId: parent.id,
          resourceLabel: parent.title,
          field: 'status',
          before: parent.status,
          after: 'IN_REVIEW',
        });
      }

      if (!pms.length) return;
      await this.actions.emit(orgId, {
        kind: 'parent_ready',
        entityId: parent.id,
        recipients: pms,
        params: {
          taskTitle: parent.title,
          projectName: parent.project.name,
          // Le message diffère : « prêt à revoir » vs « passé en revue ».
          scope: s.parentAutoAdvance === 'advance' ? 'advanced' : 'ready',
        },
        taskId: parent.id,
        projectId: parent.project.id,
        url: `${this.appBase()}/tasks/${parent.id}`,
      });
    } catch (err) {
      this.log.warn(`onSubtaskDone failed: ${(err as Error).message}`);
    }
  }

  /**
   * Anti-triche sur le coût agent (batch 1, 2026-07-26) — un run vient d'être
   * déclaré et paraît suspect : livrable produit sans tokens, coût déclaré à 0
   * malgré un tarif, ou coût déclaré implausiblement en dessous du coût de
   * référence recalculé serveur (`AgentRun.derivedCost`). On prévient l'**owner**
   * de l'agent (son superviseur humain) pour qu'il vérifie — jamais l'agent
   * lui-même. Ne modifie AUCUN chiffre : la facturation garde le coût déclaré.
   *
   * Gaté par le kill switch automations seulement (feature de sécurité, pas de
   * toggle dédié). Fire-and-forget / fail-open comme les autres hooks.
   */
  async onAgentRunReported(
    orgId: string,
    run: {
      runId: string;
      agentId: string;
      taskId: string | null;
      projectId: string | null;
      reason: 'no_tokens' | 'zero_cost' | 'below_reference';
      declaredCost: number | null;
      derivedCost: number | null;
    },
  ): Promise<void> {
    try {
      const s = await this.enabledSettings(orgId);
      if (!s) return; // kill switch automations
      const agent = await this.prisma.user.findFirst({
        where: { id: run.agentId, organizationId: orgId, kind: 'AGENT' },
        select: { name: true, ownerId: true },
      });
      if (!agent) return;
      const to = await this.recipients.agentSupervisors(orgId, agent.ownerId);
      if (!to.length) return;

      const currency = await this.settings.getCurrency(orgId).catch(() => 'EUR');
      const money = (n: number | null): string =>
        n == null ? '—' : `${Math.round(n * 100) / 100} ${currency}`;

      await this.actions.emit(orgId, {
        kind: 'agent_run_anomaly',
        entityId: run.runId,
        // Une alerte par (agent × jour × motif) : on ne spamme pas l'owner à
        // chaque run douteux, mais un motif différent ré-alerte.
        qualifier: `${run.reason}:${new Date().toISOString().slice(0, 10)}`,
        recipients: to,
        params: {
          userName: agent.name ?? 'Agent',
          reason: run.reason,
          amount: money(run.declaredCost),
          budget: money(run.derivedCost),
        },
        taskId: run.taskId ?? undefined,
        projectId: run.projectId ?? undefined,
        url: `${this.appBase()}/?view=agents`,
      });
    } catch (err) {
      this.log.warn(`onAgentRunReported(${run.runId}) failed: ${(err as Error).message}`);
    }
  }

  /** `TasksService` en lazy (cf. commentaire de classe : cycle de modules). */
  private tasksService(): TasksService | null {
    try {
      return this.moduleRef.get(TasksService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Règle 11 — congé posé qui chevauche des allocations déjà planifiées. Le
   * plan devient faux à la seconde où l'absence est saisie ; on prévient les PM
   * des projets touchés plutôt que de les laisser le découvrir dans la grille.
   *
   * Une alerte par projet touché (pas une par allocation) : le PM veut savoir
   * « X est absent et ça percute mon projet », pas recevoir 12 mails.
   */
  async onTimeOffCreated(
    orgId: string,
    timeOff: { userId: string; startDate: Date; endDate: Date },
  ): Promise<void> {
    try {
      const s = await this.enabledSettings(orgId);
      if (!s || !s.timeOffConflict.enabled) return;

      const overlapping = await this.prisma.allocation.findMany({
        where: {
          organizationId: orgId,
          userId: timeOff.userId,
          // Chevauchement classique de deux intervalles fermés.
          startDate: { lte: timeOff.endDate },
          endDate: { gte: timeOff.startDate },
        },
        select: { id: true, project: { select: { id: true, name: true, deletedAt: true, status: true } } },
      });
      if (!overlapping.length) return;

      const user = await this.prisma.user.findFirst({
        where: { id: timeOff.userId, organizationId: orgId },
        select: { name: true },
      });

      const byProject = new Map<string, { name: string; count: number }>();
      for (const a of overlapping) {
        if (!a.project || a.project.deletedAt || a.project.status !== 'ACTIVE') continue;
        const cur = byProject.get(a.project.id);
        if (cur) cur.count += 1;
        else byProject.set(a.project.id, { name: a.project.name, count: 1 });
      }

      for (const [projectId, info] of byProject) {
        const to = await this.recipients.projectPMs(projectId);
        if (!to.length) continue;
        await this.actions.emit(orgId, {
          kind: 'timeoff_conflict',
          entityId: `${timeOff.userId}:${projectId}`,
          qualifier: timeOff.startDate.toISOString().slice(0, 10),
          recipients: to,
          params: { userName: user?.name ?? 'Un membre', projectName: info.name, count: info.count },
          projectId,
          url: `${this.appBase()}/?view=workload`,
        });
      }
    } catch (err) {
      this.log.warn(`onTimeOffCreated failed: ${(err as Error).message}`);
    }
  }

  /**
   * Règle 8 — l'auto-plan appliqué laisse des tâches qui débordent leur
   * échéance (`deadline_overflow`). Signalé une fois par projet, pas par tâche.
   *
   * ⚠️ N'appeler QUE sur une application réelle : `AutoplanService.run` produit
   * les mêmes warnings en preview, et un PM qui explore des scénarios ne doit
   * pas déclencher une alerte à chaque aperçu.
   */
  async onAutoplanApplied(
    orgId: string,
    projectId: string | null,
    warnings: Array<{ type: string; taskId: string }>,
  ): Promise<void> {
    try {
      if (!projectId) return; // auto-plan à périmètre user : pas de PM à prévenir
      const s = await this.enabledSettings(orgId);
      if (!s || !s.autoplanOverflow.enabled) return;

      const overflow = warnings.filter((w) => w.type === 'deadline_overflow');
      if (!overflow.length) return;

      const project = await this.prisma.project.findFirst({
        where: { id: projectId, organizationId: orgId },
        select: { name: true },
      });
      const to = await this.recipients.projectPMs(projectId);
      if (!to.length) return;

      await this.actions.emit(orgId, {
        kind: 'autoplan_overflow',
        entityId: projectId,
        recipients: to,
        params: { projectName: project?.name ?? '', count: overflow.length },
        projectId,
        url: `${this.appBase()}/?view=workload`,
      });
    } catch (err) {
      this.log.warn(`onAutoplanApplied failed: ${(err as Error).message}`);
    }
  }
}
