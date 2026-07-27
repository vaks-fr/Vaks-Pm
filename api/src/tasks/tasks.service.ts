import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Prisma, Task, TaskStatus } from '@db';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { WatchersService } from '../automations/watchers.service';
import { EVENTS, AgentPolicyContext, AgentPolicyOutcome, isAgentModelAllowed } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { SkillsService } from '../skills/skills.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { auditDiff } from '../audit-logs/audit-sanitize';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TaskTransitionService } from './task-transition.service';
import { PolicyEngineService } from '../agents/policy-engine.service';
import { agentSelfGovernanceViolation } from './agent-self-governance';
import { decideSubStatus } from '../custom-statuses/sub-status-rules';
import { S3Service } from '../storage/s3.service';
import { FileSourcesService } from '../filesources/filesources.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';
import { ListTasksDto } from './dto/list-tasks.dto';

/** Espacement par défaut entre deux `position` consécutives. */
const POSITION_GAP = 1000;

/** Plafond dur appliqué à `GET /projects/:id/tasks` pour éviter de servir
 *  silencieusement N milliers de lignes sur un projet pathologique. */
const TASK_LIST_HARD_LIMIT = 2000;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Normalise une couleur de groupe.
 * - `undefined` → undefined (pas de modif).
 * - `null` → null (efface).
 * - Si la tâche n'est pas un groupe, la couleur est silencieusement ignorée.
 * - Hex invalide → BadRequestException.
 * Renvoie la couleur lowercased prête à stocker.
 */
function normalizeGroupColor(
  color: string | null | undefined,
  isGroup: boolean,
): string | null | undefined {
  if (color === undefined) return undefined;
  if (color === null) return null;
  if (!isGroup) return null;
  if (!HEX_COLOR_RE.test(color)) {
    throw new BadRequestException('Color must be in #RRGGBB hex format');
  }
  return color.toLowerCase();
}

const TASK_INCLUDE = {
  assignees: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
  labels: { include: { label: true } },
  _count: { select: { comments: true, attachments: true } },
} satisfies Prisma.TaskInclude;

type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

/**
 * Contexte d'appel des mutations de tâche. Type unique pour `create` et
 * `update` (ils divergeaient historiquement).
 */
export interface TaskCaller {
  isAdmin: boolean;
  /** Nature du principal. Pilote l'anti auto-gouvernance des agents. */
  actorKind?: 'HUMAN' | 'AGENT';
  /**
   * true = mutation émise par le **moteur d'automatisations** (règles de
   * mutation, lot 5). Sert de garde anti-boucle : les hooks d'automatisation
   * s'abstiennent quand ils sont eux-mêmes à l'origine du changement, sinon une
   * règle pourrait ré-alimenter la suivante indéfiniment.
   *
   * N'accorde AUCUN droit : le contrôle anti auto-gouvernance des agents
   * (`agentSelfGovernanceViolation`) porte sur `actorKind`, pas sur ce flag —
   * une automation ne peut donc pas servir de contournement à un agent.
   */
  system?: true;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly skills: SkillsService,
    private readonly audit: AuditLogService,
    private readonly transitions: TaskTransitionService,
    private readonly settings: AdminSettingsService,
    private readonly policies: PolicyEngineService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Hooks d'automatisation résolus en **lazy** : `AutomationsModule` importe
   * `WorkloadModule`/`FinanceModule`, un import direct depuis ici créerait un
   * cycle de modules. `strict: false` cherche le provider dans tout le graphe.
   * Best-effort : si le module n'est pas monté, les hooks sont simplement muets.
   */
  private automationHooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
  }

  /** Watchers de la tâche/du projet (lazy, même raison que `automationHooks`). */
  private watchersService(): WatchersService | null {
    try {
      return this.moduleRef.get(WatchersService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Notifie un changement de statut aux assignés **et** aux watchers (tâche ou
   * projet parent), dédupliqués. Best-effort : une panne du suivi ne doit pas
   * empêcher la notification des assignés.
   */
  private async notifyStatusWithWatchers(
    orgId: string,
    actorUserId: string | null,
    assigneeIds: string[],
    taskId: string,
    projectId: string,
    from: TaskStatus,
    to: TaskStatus,
  ): Promise<void> {
    let recipients = assigneeIds;
    try {
      const watcherIds =
        (await this.watchersService()?.watchersOf(orgId, { taskId, projectId })) ?? [];
      recipients = [...new Set([...assigneeIds, ...watcherIds])];
    } catch {
      /* fail-open : on notifie au moins les assignés */
    }
    // On ne se notifie pas soi-même de son propre changement.
    recipients = recipients.filter((id) => id !== actorUserId);
    if (!recipients.length) return;
    void this.notifications.notifyStatusChange(orgId, actorUserId, recipients, taskId, from, to);
  }

  /**
   * Soft scoping : interdit de poser un `requiredSkillId` hors du périmètre
   * des équipes affectées au projet, sauf pour un admin (override) ou si le
   * projet n'a aucune équipe (fallback catalogue complet). Ne touche jamais
   * une valeur déjà en place — n'est appelé que lors d'un set explicite.
   */
  private async assertRequiredSkillAllowed(
    orgId: string,
    projectId: string,
    requiredSkillId: string,
    caller?: { isAdmin: boolean },
  ) {
    if (caller?.isAdmin) return;
    const ok = await this.skills.isSkillAvailableForProject(
      orgId,
      projectId,
      requiredSkillId,
    );
    if (!ok) {
      throw new BadRequestException(
        "Compétence requise hors du périmètre des équipes du projet. Choisissez une compétence couverte par une équipe affectée, ou émettez une demande de compétence.",
      );
    }
  }

  // ------------------------------------------------------------
  // Lecture
  // ------------------------------------------------------------

  async findOne(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      include: TASK_INCLUDE,
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    return this.toDto(task);
  }

  async list(orgId: string, projectId: string, query: ListTasksDto) {
    await this.assertProject(orgId, projectId);

    const where: Prisma.TaskWhereInput = {
      organizationId: orgId,
      projectId,
      deletedAt: null,
    };

    if (query.status) {
      where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
    }
    if (query.assigneeId) {
      where.assignees = { some: { userId: query.assigneeId } };
    }
    if (query.labelId) {
      where.labels = { some: { labelId: query.labelId } };
    }
    if (query.parentTaskId !== undefined) {
      where.parentTaskId = query.parentTaskId;
    }
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.dueBefore || query.dueAfter) {
      where.dueDate = {};
      if (query.dueBefore) (where.dueDate as Prisma.DateTimeFilter).lte = new Date(query.dueBefore);
      if (query.dueAfter) (where.dueDate as Prisma.DateTimeFilter).gte = new Date(query.dueAfter);
    }
    if (query.externalBlocked !== undefined) {
      where.externalBlocked = query.externalBlocked;
    }

    const orderBy = this.parseSort(query.sort);

    const take = Math.min(query.limit ?? TASK_LIST_HARD_LIMIT, TASK_LIST_HARD_LIMIT);
    const tasks = await this.prisma.task.findMany({
      where,
      orderBy,
      include: TASK_INCLUDE,
      take,
    });
    return tasks.map((t) => this.toDto(t));
  }

  /**
   * Board inter-projet « Mes tâches » : toutes les tâches assignées à
   * l'utilisateur courant, à travers tous ses projets **ACTIVE** (et
   * `STANDARD` — les conteneurs de tickets externes restent invisibles).
   * Auto-scopé par `assignees.some.userId` → l'appelant ne voit jamais que
   * ses propres affectations (pas de fuite cross-user). Les tâches `DONE`
   * sont exclues (vue « travail en cours »). Retourne aussi, pour chaque
   * projet concerné, ses colonnes de board afin que l'UI puisse mapper un
   * statut cible → `boardColumnId` lors d'un drag-drop (réutilise `move()`).
   */
  async myTasks(orgId: string, userId: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: { not: TaskStatus.DONE },
        assignees: { some: { userId } },
        project: { status: 'ACTIVE', kind: 'STANDARD', deletedAt: null },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { position: 'asc' }],
      include: TASK_INCLUDE,
      take: TASK_LIST_HARD_LIMIT,
    });

    const projectIds = [...new Set(tasks.map((t) => t.projectId))];
    if (projectIds.length === 0) {
      return { projects: [], columns: {}, tasks: [] };
    }

    const [projects, columns] = await Promise.all([
      this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, key: true, name: true },
      }),
      this.prisma.boardColumn.findMany({
        where: { board: { projectId: { in: projectIds } } },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          name: true,
          order: true,
          status: true,
          wipLimit: true,
          board: { select: { projectId: true } },
        },
      }),
    ]);

    const columnsByProject: Record<
      string,
      { id: string; name: string; order: number; status: TaskStatus; wipLimit: number | null }[]
    > = {};
    for (const c of columns) {
      const pid = c.board.projectId;
      (columnsByProject[pid] ??= []).push({
        id: c.id,
        name: c.name,
        order: c.order,
        status: c.status,
        wipLimit: c.wipLimit,
      });
    }

    return {
      projects,
      columns: columnsByProject,
      tasks: tasks.map((t) => this.toDto(t)),
    };
  }

  // ------------------------------------------------------------
  // Création
  // ------------------------------------------------------------

  async create(
    orgId: string,
    projectId: string,
    userId: string,
    dto: CreateTaskDto,
    caller?: TaskCaller,
  ) {
    await this.assertProject(orgId, projectId);
    // Pas de création manuelle de tâche dans un conteneur de tickets externes
    // (kind=EXTERNAL) : ces tâches ne naissent que via l'upsert du module
    // `external-tasks/` (référence outil + idempotence sur la clé du ticket).
    const projKind = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { kind: true },
    });
    if (projKind?.kind === 'EXTERNAL') {
      throw new BadRequestException(
        'Ce projet est un conteneur de tickets externes — création de tâche réservée à POST /external-tasks.',
      );
    }
    if (dto.requiredSkillId) {
      await this.assertRequiredSkillAllowed(orgId, projectId, dto.requiredSkillId, caller);
    }

    // Si la colonne n'est pas fournie, on tombe sur la première colonne du board principal.
    const columnId = dto.boardColumnId ?? (await this.firstColumnId(projectId));
    if (columnId) await this.assertColumn(projectId, columnId);

    const status = dto.status ?? (await this.statusForColumn(columnId)) ?? TaskStatus.TODO;

    // Position : juste après la plus grande position de la colonne.
    const position = await this.nextPositionInColumn(columnId);

    if (dto.parentTaskId) await this.assertSameProjectTask(projectId, dto.parentTaskId);
    if (dto.assigneeIds?.length)
      await this.assertAssigneesAllowedOnProject(orgId, projectId, dto.assigneeIds);
    if (dto.labelIds?.length) await this.assertLabelsInProject(projectId, dto.labelIds);

    const task = await this.prisma.$transaction(async (tx) => {
      // Verrou advisory par projet : sérialise l'allocation du `number`
      // séquentiel sans bloquer les autres projets. Libéré à la fin de la
      // transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;
      const agg = await tx.task.aggregate({
        where: { projectId },
        _max: { number: true },
      });
      const nextNumber = (agg._max.number ?? 0) + 1;
      const created = await tx.task.create({
        data: {
          organizationId: orgId,
          projectId,
          number: nextNumber,
          boardColumnId: columnId ?? null,
          parentTaskId: dto.parentTaskId ?? null,
          title: dto.title,
          description: dto.description ?? null,
          status,
          priority: dto.priority ?? 'NORMAL',
          position,
          estimateHours: dto.estimateHours ?? null,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          progressPct: dto.progressPct ?? 0,
          isMilestone: dto.isMilestone ?? false,
          isBug: dto.isBug ?? false,
          isGroup: dto.isGroup ?? false,
          color: normalizeGroupColor(dto.color, dto.isGroup ?? false) ?? null,
          requiredSkillId: dto.requiredSkillId ?? null,
          requiredSkillLevel: dto.requiredSkillId ? (dto.requiredSkillLevel ?? null) : null,
          externalDependency: dto.externalDependency?.trim() || null,
          externalBlocked: dto.externalBlocked ?? false,
          externalBlockedAt: dto.externalBlocked ? new Date() : null,
          createdById: userId,
          assignees: dto.assigneeIds
            ? { create: dto.assigneeIds.map((uid) => ({ userId: uid })) }
            : undefined,
          labels: dto.labelIds
            ? { create: dto.labelIds.map((lid) => ({ labelId: lid })) }
            : undefined,
        },
        include: TASK_INCLUDE,
      });
      // Première entrée d'historique de statut (source du CFD / re-travail).
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId,
          projectId,
          taskId: created.id,
          fromStatus: null,
          toStatus: created.status,
          changedById: userId,
        },
      });
      return created;
    });

    const out = this.toDto(task);
    this.events.emitToProject(projectId, EVENTS.TASK_CREATED, out);
    void this.webhooks.dispatch(orgId, 'task.created', out, { projectId });
    if (dto.assigneeIds?.length) {
      void this.webhooks.dispatch(
        orgId,
        'task.assigned',
        { ...out, assignedUserIds: dto.assigneeIds },
        { projectId },
      );
      for (const uid of dto.assigneeIds) {
        void this.notifications.notifyAssignment(orgId, userId, uid, task.id);
      }
    }
    // Automatisation « compétence manquante » : la tâche exige un skill que
    // personne sur le projet ne couvre (fire-and-forget, jamais bloquant).
    if (dto.requiredSkillId) {
      void this.automationHooks()?.onTaskCreated(
        orgId,
        {
          id: task.id,
          title: task.title,
          requiredSkillId: task.requiredSkillId,
          requiredSkillLevel: task.requiredSkillLevel,
        },
        projectId,
        caller,
      );
    }
    return out;
  }

  // ------------------------------------------------------------
  // Gating "tâche terminée" : interdit de clôturer une tâche dont des
  // prédécesseurs (toutes natures de dépendance) ne sont pas encore terminés.
  // ------------------------------------------------------------

  /**
   * Prédécesseurs TRANSITIFS d'une tâche dont le statut n'est pas `DONE` :
   * on remonte toute la chaîne de dépendances (prédécesseurs des
   * prédécesseurs inclus) tant qu'on rencontre des tâches ouvertes — un
   * prédécesseur déjà `DONE` est considéré satisfait, on n'explore pas plus
   * haut sur cette branche. Dédupliqué, tâches supprimées exclues.
   *
   * Sert à la fois au payload d'erreur 409 / pré-check UI (liste lisible) et
   * à la clôture en cascade (les ids à terminer).
   */
  private async listIncompletePredecessors(
    orgId: string,
    taskId: string,
  ): Promise<{ id: string; number: number; title: string; status: TaskStatus }[]> {
    const byId = new Map<string, { id: string; number: number; title: string; status: TaskStatus }>();
    const visited = new Set<string>([taskId]);
    let frontier = [taskId];
    // Garde-fou contre un graphe pathologique (cycles théoriquement bloqués
    // côté création).
    for (let depth = 0; depth < 1000 && frontier.length; depth++) {
      const deps = await this.prisma.taskDependency.findMany({
        where: { organizationId: orgId, successorId: { in: frontier } },
        include: {
          predecessor: {
            select: { id: true, number: true, title: true, status: true, deletedAt: true },
          },
        },
      });
      const next: string[] = [];
      for (const d of deps) {
        const p = d.predecessor;
        if (!p || p.deletedAt != null || p.status === 'DONE' || visited.has(p.id)) continue;
        visited.add(p.id);
        byId.set(p.id, { id: p.id, number: p.number, title: p.title, status: p.status });
        next.push(p.id);
      }
      frontier = next;
    }
    return [...byId.values()];
  }

  /**
   * Clôture en cascade (dans une transaction) la liste de tâches fournie :
   * statut `DONE`, avancement 100 %, déplacement vers la colonne `DONE` du
   * board du projet (pour garder le Kanban cohérent), + historique de statut.
   * Retourne les tâches mises à jour pour l'émission d'events après commit.
   */
  private async cascadeComplete(
    tx: Prisma.TransactionClient,
    orgId: string,
    taskIds: string[],
    actorUserId: string | null,
  ): Promise<{ task: TaskWithRelations; from: TaskStatus }[]> {
    if (!taskIds.length) return [];
    const tasks = await tx.task.findMany({
      where: { id: { in: taskIds }, organizationId: orgId, deletedAt: null },
    });
    const doneColByProject = new Map<string, string | null>();
    const updated: { task: TaskWithRelations; from: TaskStatus }[] = [];
    for (const t of tasks) {
      if (t.status === 'DONE') continue;
      if (!doneColByProject.has(t.projectId)) {
        const col = await tx.boardColumn.findFirst({
          where: { board: { projectId: t.projectId }, status: 'DONE' },
          orderBy: { order: 'asc' },
          select: { id: true },
        });
        doneColByProject.set(t.projectId, col?.id ?? null);
      }
      const doneColId = doneColByProject.get(t.projectId) ?? null;
      const u = await tx.task.update({
        where: { id: t.id },
        data: {
          status: 'DONE',
          progressPct: 100,
          ...(doneColId ? { boardColumnId: doneColId } : {}),
        },
        include: TASK_INCLUDE,
      });
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId,
          projectId: t.projectId,
          taskId: t.id,
          fromStatus: t.status,
          toStatus: 'DONE',
          changedById: actorUserId,
        },
      });
      updated.push({ task: u, from: t.status });
    }
    return updated;
  }

  /** Émet les events temps réel + webhooks pour les tâches clôturées en cascade. */
  private emitCascadeEvents(
    orgId: string,
    updated: { task: TaskWithRelations; from: TaskStatus }[],
  ) {
    for (const { task, from } of updated) {
      const dto = this.toDto(task);
      this.events.emitToProject(task.projectId, EVENTS.TASK_UPDATED, dto);
      this.events.emitToProject(task.projectId, EVENTS.TASK_MOVED, {
        taskId: dto.id,
        boardColumnId: dto.boardColumnId,
        position: dto.position,
        status: dto.status,
      });
      this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
        taskId: task.id,
        from,
        to: 'DONE' as TaskStatus,
      });
      void this.webhooks.dispatch(orgId, 'task.updated', dto, { projectId: task.projectId });
      void this.webhooks.dispatch(orgId, 'task.completed', dto, { projectId: task.projectId });
    }
  }

  // ------------------------------------------------------------
  // Mise à jour
  // ------------------------------------------------------------

  async update(
    orgId: string,
    taskId: string,
    dto: UpdateTaskDto,
    actorUserId: string | null = null,
    caller?: TaskCaller,
  ) {
    const existing = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Tâche introuvable');

    // Anti auto-gouvernance des agents (chantier 3.3) : un agent porteur de
    // `task:update` ne doit jamais réécrire les garde-fous dérivés de son propre
    // enjeu × confiance — sinon il abaisse son plancher de vérification
    // (`stakes`), relève/efface son plafond de coût (`agentCostBudget`) ou
    // réécrit ses contraintes (`agentGuardrails` / `acceptanceCriteria`). Même
    // philosophie que l'anti auto-approbation de la revue (reviewer ≠ auteur).
    // 403 audité, avant tout effet de bord.
    const selfGov = agentSelfGovernanceViolation(caller?.actorKind, dto);
    if (selfGov.length) {
      void this.audit.log({
        organizationId: orgId,
        action: 'agent.self_governance_denied',
        severity: 'WARNING',
        actorType: 'AGENT',
        actorId: actorUserId,
        resourceType: 'task',
        resourceId: taskId,
        detail: { projectId: existing.projectId, attemptedFields: selfGov },
      });
      throw new ForbiddenException({
        code: 'AGENT_SELF_GOVERNANCE_FORBIDDEN',
        message:
          "Un agent IA ne peut pas modifier ses propres garde-fous de gouvernance (enjeu, budget de coût, garde-fous, critères d'acceptation).",
      });
    }

    // Sous-statut (Custom Status) : overlay additif sur l'enum. Invariant :
    // `status` = parentStatus du sous-statut porté. Poser un sous-statut force
    // le statut moteur au parent (AVANT le check de transitions, qui voit donc
    // la vraie transition) ; changer de statut efface un sous-statut devenu
    // incohérent ; `null` efface explicitement.
    let subStatusPatch: string | null | undefined;
    if (dto.subStatusId !== undefined || (dto.status !== undefined && dto.status !== existing.status)) {
      const requestedSub =
        dto.subStatusId != null
          ? await this.resolveSubStatus(orgId, existing.projectId, dto.subStatusId)
          : null;
      const currentSub =
        dto.subStatusId === undefined && existing.subStatusId
          ? await this.prisma.customStatus.findFirst({
              where: { id: existing.subStatusId, organizationId: orgId },
              select: { parentStatus: true },
            })
          : null;
      const decision = decideSubStatus({
        requestedSubId: dto.subStatusId,
        requestedSubParent: requestedSub?.parentStatus ?? null,
        requestedStatus: dto.status,
        currentStatus: existing.status,
        hasCurrentSub: !!existing.subStatusId,
        currentSubParent: currentSub?.parentStatus ?? null,
      });
      if ('error' in decision) {
        throw new BadRequestException(
          decision.error === 'SUB_STATUS_PARENT_MISMATCH'
            ? "Le sous-statut n'appartient pas au statut demandé."
            : 'Sous-statut introuvable ou non applicable à ce projet.',
        );
      }
      if (decision.forcedStatus !== undefined) dto.status = decision.forcedStatus as TaskStatus;
      subStatusPatch = decision.subStatusPatch;
    }

    // Matrice de transitions (chantier 2) — mode observation par défaut : ne
    // bloque pas, journalise seulement un refus. Enforce via setting org.
    if (dto.status !== undefined && dto.status !== existing.status) {
      await this.transitions.check({
        orgId,
        projectId: existing.projectId,
        taskId,
        from: existing.status,
        to: dto.status,
        actorUserId,
        actor: {
          kind: caller?.actorKind ?? 'HUMAN',
          isClaimant: !!actorUserId && existing.claimedById === actorUserId,
          canUpdate: true, // a passé le guard task:update
          // canReview/reviewingOwnWork : plombés avec le vrai RBAC en enforce (2c).
        },
      });
    }
    if (dto.requiredSkillId) {
      await this.assertRequiredSkillAllowed(orgId, existing.projectId, dto.requiredSkillId, caller);
    }

    const previousAssigneeIds = dto.assigneeIds
      ? (await this.prisma.taskAssignee.findMany({ where: { taskId }, select: { userId: true } })).map((a) => a.userId)
      : [];

    if (dto.parentTaskId !== undefined) {
      if (dto.parentTaskId === taskId)
        throw new BadRequestException('Une tâche ne peut être sa propre parente');
      if (dto.parentTaskId !== null) {
        const parent = await this.prisma.task.findFirst({
          where: {
            id: dto.parentTaskId,
            projectId: existing.projectId,
            deletedAt: null,
          },
          select: { id: true, isGroup: true },
        });
        if (!parent) throw new BadRequestException('Tâche parente invalide');
        if (!parent.isGroup) {
          throw new BadRequestException(
            "Le parent doit être un groupe (cochez 'Mark as group' sur la tâche parente).",
          );
        }
      }
    }
    // Si on tente de retirer le flag groupe alors que la tâche a encore des enfants, on refuse.
    if (dto.isGroup === false && existing.isGroup) {
      const childCount = await this.prisma.task.count({
        where: { parentTaskId: taskId, deletedAt: null },
      });
      if (childCount > 0) {
        throw new BadRequestException(
          'Impossible de retirer le statut groupe : la tâche contient encore des sous-éléments.',
        );
      }
    }
    if (dto.assigneeIds) {
      const currentAssignees = await this.prisma.taskAssignee.findMany({
        where: { taskId },
        select: { userId: true },
      });
      await this.assertAssigneesAllowedOnProject(
        orgId,
        existing.projectId,
        dto.assigneeIds,
        currentAssignees.map((a) => a.userId),
      );
    }
    if (dto.labelIds) await this.assertLabelsInProject(existing.projectId, dto.labelIds);

    const data: Prisma.TaskUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.status !== undefined) data.status = dto.status;
    if (subStatusPatch !== undefined) data.subStatusId = subStatusPatch;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.estimateHours !== undefined) data.estimateHours = dto.estimateHours;
    if (dto.dueDate !== undefined) data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.startDate !== undefined) data.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.endDate !== undefined) data.endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (dto.progressPct !== undefined) data.progressPct = dto.progressPct;
    if (dto.isMilestone !== undefined) data.isMilestone = dto.isMilestone;
    if (dto.isBug !== undefined) data.isBug = dto.isBug;
    if (dto.externalDependency !== undefined)
      data.externalDependency = dto.externalDependency?.trim() || null;
    if (dto.externalBlocked !== undefined) {
      data.externalBlocked = dto.externalBlocked;
      // Horodatage du blocage : posé au passage false→true, effacé au retour à
      // false. Sert d'ancienneté à l'automatisation `external_blocked_stale`.
      if (dto.externalBlocked && !existing.externalBlocked) data.externalBlockedAt = new Date();
      else if (!dto.externalBlocked) data.externalBlockedAt = null;
    }
    if (dto.isGroup !== undefined) data.isGroup = dto.isGroup;
    if (dto.color !== undefined) {
      const willBeGroup = dto.isGroup ?? existing.isGroup;
      data.color = normalizeGroupColor(dto.color, willBeGroup) ?? null;
    }
    // Si on enlève le flag groupe, on efface aussi la couleur (devient sans effet).
    if (dto.isGroup === false && existing.isGroup) {
      data.color = null;
    }
    if (dto.parentTaskId !== undefined) {
      data.parent = dto.parentTaskId
        ? { connect: { id: dto.parentTaskId } }
        : { disconnect: true };
    }
    if (dto.requiredSkillId !== undefined) {
      data.requiredSkill = dto.requiredSkillId
        ? { connect: { id: dto.requiredSkillId } }
        : { disconnect: true };
      // Si on retire le skill, on vide aussi le niveau.
      if (dto.requiredSkillId === null) data.requiredSkillLevel = null;
    }
    if (dto.requiredSkillLevel !== undefined) {
      data.requiredSkillLevel = dto.requiredSkillLevel;
    }
    if (dto.agentGuardrails !== undefined) data.agentGuardrails = dto.agentGuardrails;
    if (dto.agentCostBudget !== undefined) data.agentCostBudget = dto.agentCostBudget;
    if (dto.acceptanceCriteria !== undefined) {
      // Remplace la liste entière : normalise en `{ text, done }`.
      data.acceptanceCriteria = dto.acceptanceCriteria.map((c) => ({
        text: c.text,
        done: !!c.done,
      })) as unknown as Prisma.InputJsonValue;
    }

    // Raison de mise en pause (facultative). `null`/chaîne vide => efface.
    const reasonProvided = dto.statusReason !== undefined;
    const normReason = dto.statusReason ? dto.statusReason.trim() || null : null;
    const statusChanging = dto.status !== undefined && dto.status !== existing.status;
    if (statusChanging) {
      if (dto.status === 'ON_HOLD') {
        // Passage en pause : on adopte la raison fournie (ou rien).
        data.holdReason = reasonProvided ? normReason : null;
      } else if (existing.status === 'ON_HOLD') {
        // Sortie de pause : on efface la raison courante.
        data.holdReason = null;
      }
    } else if (reasonProvided && existing.status === 'ON_HOLD') {
      // Édition de la raison d'une tâche déjà en pause (pas de transition).
      data.holdReason = normReason;
    }

    // Gating clôture : on ne peut passer une tâche à DONE que si tous ses
    // prédécesseurs le sont. Sinon refus 409, sauf si `completePredecessors`
    // demande la clôture en cascade.
    const goingDone = dto.status === 'DONE' && existing.status !== 'DONE';
    let cascadeIds: string[] = [];
    if (goingDone) {
      const blocking = await this.listIncompletePredecessors(orgId, taskId);
      if (blocking.length) {
        if (!dto.completePredecessors) {
          throw new ConflictException({
            code: 'PREDECESSORS_NOT_DONE',
            message:
              'Cette tâche a des tâches précédentes non terminées ; elle ne peut pas être marquée comme terminée.',
            predecessors: blocking,
          });
        }
        cascadeIds = blocking.map((p) => p.id);
      }
    }

    const cascadeRef: { updated: { task: TaskWithRelations; from: TaskStatus }[] } = {
      updated: [],
    };
    const task = await this.prisma.$transaction(async (tx) => {
      if (cascadeIds.length) {
        cascadeRef.updated = await this.cascadeComplete(tx, orgId, cascadeIds, actorUserId);
      }
      if (dto.assigneeIds) {
        await tx.taskAssignee.deleteMany({ where: { taskId } });
        if (dto.assigneeIds.length) {
          await tx.taskAssignee.createMany({
            data: dto.assigneeIds.map((uid) => ({ taskId, userId: uid })),
          });
        }
      }
      if (dto.labelIds) {
        await tx.taskLabel.deleteMany({ where: { taskId } });
        if (dto.labelIds.length) {
          await tx.taskLabel.createMany({
            data: dto.labelIds.map((lid) => ({ taskId, labelId: lid })),
          });
        }
      }
      // Historique de statut (CFD / re-travail) : seulement si le statut change.
      if (dto.status !== undefined && dto.status !== existing.status) {
        await tx.taskStatusHistory.create({
          data: {
            organizationId: orgId,
            projectId: existing.projectId,
            taskId,
            fromStatus: existing.status,
            toStatus: dto.status,
            reason: dto.status === 'ON_HOLD' && reasonProvided ? normReason : null,
            changedById: actorUserId,
          },
        });
      }
      return tx.task.update({ where: { id: taskId }, data, include: TASK_INCLUDE });
    });

    const out = this.toDto(task);
    // Events des prédécesseurs clôturés en cascade (avant ceux de la tâche
    // courante : la chaîne se termine du haut vers le bas).
    if (cascadeRef.updated.length) this.emitCascadeEvents(orgId, cascadeRef.updated);
    const statusChanged = dto.status !== undefined && dto.status !== existing.status;
    // Diff lisible old→new pour le journal d'audit (entrée `task.updated` de
    // l'interceptor) — champs métier clés uniquement, pas le body brut.
    const norm = (t: { title: string; status: unknown; priority: unknown; estimateHours: unknown; progressPct: unknown; startDate: Date | null; dueDate: Date | null }) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      estimateHours: t.estimateHours,
      progressPct: t.progressPct,
      startDate: t.startDate?.toISOString().slice(0, 10) ?? null,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
    });
    const changes = auditDiff(norm(existing), norm(task));
    if (changes) this.audit.enrichRequest(changes);
    this.events.emitToProject(task.projectId, EVENTS.TASK_UPDATED, out);
    void this.webhooks.dispatch(orgId, 'task.updated', out, { projectId: task.projectId });
    // Events ciblés assignation : diff entre l'ancien et le nouveau set d'assignés.
    if (dto.assigneeIds) {
      const next = new Set(dto.assigneeIds);
      const prev = new Set(previousAssigneeIds);
      const added = dto.assigneeIds.filter((id) => !prev.has(id));
      const removed = previousAssigneeIds.filter((id) => !next.has(id));
      if (added.length)
        void this.webhooks.dispatch(
          orgId,
          'task.assigned',
          { ...out, assignedUserIds: added },
          { projectId: task.projectId },
        );
      if (removed.length)
        void this.webhooks.dispatch(
          orgId,
          'task.unassigned',
          { ...out, unassignedUserIds: removed },
          { projectId: task.projectId },
        );
    }
    // Event ciblé clôture : transition de statut vers DONE.
    if (statusChanged && task.status === 'DONE')
      void this.webhooks.dispatch(orgId, 'task.completed', out, { projectId: task.projectId });
    if (statusChanged) {
      this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
        taskId: task.id,
        from: existing.status,
        to: task.status,
      });
      const currentAssigneeIds = task.assignees.map((a) => a.userId);
      // Les watchers (abonnement passif) reçoivent le changement au même titre
      // que les assignés — dédup pour qu'un assigné qui suit aussi la tâche ne
      // reçoive pas deux mails.
      void this.notifyStatusWithWatchers(
        orgId,
        actorUserId,
        currentAssigneeIds,
        task.id,
        task.projectId,
        existing.status,
        task.status,
      );
    }
    if (dto.assigneeIds) {
      const added = dto.assigneeIds.filter((uid) => !previousAssigneeIds.includes(uid));
      for (const uid of added) {
        void this.notifications.notifyAssignment(orgId, actorUserId, uid, task.id);
      }
    }
    // Automatisation « parent auto-avancé » : la dernière sous-tâche qui se
    // termine peut faire basculer son parent. `caller` est transmis tel quel —
    // le hook s'abstient si c'est le moteur qui a produit ce changement
    // (anti-cascade).
    if (statusChanged && task.status === 'DONE' && existing.parentTaskId) {
      void this.automationHooks()?.onSubtaskDone(orgId, existing.parentTaskId, task.id, caller);
    }
    // Feed sponsor : jalon atteint → sponsors du projet (gaté par
    // `Project.sponsorNotify` dans le hook). Pas d'anti-cascade ici : une
    // clôture système légitime (auto-close APPROVED→DONE) intéresse autant
    // les sponsors qu'une clôture humaine.
    if (statusChanged && task.status === 'DONE' && task.isMilestone) {
      void this.automationHooks()?.onMilestoneCompleted(
        orgId,
        { id: task.id, title: task.title },
        task.projectId,
      );
    }
    // Notification d'ENTRÉE dans un sous-statut (Custom Status) : destinataires
    // configurés sur le sous-statut. Pas d'anti-boucle `caller.system` — aucune
    // mutation du moteur ne pose de sous-statut aujourd'hui, et si une le
    // faisait, prévenir l'équipe resterait le comportement voulu.
    if (typeof subStatusPatch === 'string' && subStatusPatch !== existing.subStatusId) {
      void this.automationHooks()?.onSubStatusEntered(
        orgId,
        { id: task.id, title: task.title, projectId: task.projectId },
        subStatusPatch,
        actorUserId,
      );
    }
    return out;
  }

  // ------------------------------------------------------------
  // Déplacement Kanban (colonne + position)
  // ------------------------------------------------------------

  async move(
    orgId: string,
    taskId: string,
    dto: MoveTaskDto,
    actor?: { userId?: string | null; actorKind?: 'HUMAN' | 'AGENT' },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');

    await this.assertColumn(task.projectId, dto.boardColumnId);

    let position: number;
    if (dto.position !== undefined) {
      position = dto.position;
    } else if (dto.beforeTaskId || dto.afterTaskId) {
      position = await this.computePositionBetween(
        dto.boardColumnId,
        dto.beforeTaskId,
        dto.afterTaskId,
      );
    } else {
      position = await this.nextPositionInColumn(dto.boardColumnId);
    }

    // Le status suit la colonne (mapping board_column.status).
    const column = await this.prisma.boardColumn.findUniqueOrThrow({
      where: { id: dto.boardColumnId },
    });

    // Sous-statut cible (container du board). Non-null → doit appartenir au
    // statut de la colonne ; absent → préservé si cohérent, effacé sinon
    // (l'invariant garantit que l'ancien parent == task.status, donc un
    // changement de colonne-statut invalide forcément le sous-statut porté).
    let moveSubPatch: string | null | undefined;
    {
      const requestedSub =
        dto.subStatusId != null
          ? await this.resolveSubStatus(orgId, task.projectId, dto.subStatusId)
          : null;
      const decision = decideSubStatus({
        requestedSubId: dto.subStatusId,
        requestedSubParent: requestedSub?.parentStatus ?? null,
        requestedStatus: column.status,
        currentStatus: task.status,
        hasCurrentSub: !!task.subStatusId,
        currentSubParent: null, // jamais nécessaire : cf. invariant ci-dessus
      });
      if ('error' in decision) {
        throw new BadRequestException(
          decision.error === 'SUB_STATUS_PARENT_MISMATCH'
            ? "Le sous-statut n'appartient pas au statut de la colonne cible."
            : 'Sous-statut introuvable ou non applicable à ce projet.',
        );
      }
      moveSubPatch = decision.subStatusPatch;
    }

    // Matrice de transitions (chantier 2) — observation par défaut. Un drag qui
    // change le statut de la carte est évalué comme une transition.
    if (column.status !== task.status) {
      await this.transitions.check({
        orgId,
        projectId: task.projectId,
        taskId,
        from: task.status,
        to: column.status,
        actorUserId: actor?.userId ?? null,
        actor: {
          kind: actor?.actorKind ?? 'HUMAN',
          isClaimant: !!actor?.userId && task.claimedById === actor.userId,
          canUpdate: true, // a passé le guard task:update
        },
      });
    }

    // Limite WIP : refuser l'entrée dans une colonne déjà pleine. Le simple
    // réordonnancement à l'intérieur de la même colonne n'est jamais bloqué.
    if (column.wipLimit != null && task.boardColumnId !== dto.boardColumnId) {
      const inColumn = await this.prisma.task.count({
        where: { boardColumnId: dto.boardColumnId, deletedAt: null },
      });
      if (inColumn >= column.wipLimit) {
        throw new ConflictException({
          code: 'WIP_LIMIT_REACHED',
          message: `La colonne « ${column.name} » a atteint sa limite WIP (${column.wipLimit}).`,
          wipLimit: column.wipLimit,
          columnId: column.id,
        });
      }
    }

    // Gating clôture : déplacer une carte vers une colonne `DONE` revient à la
    // terminer → mêmes règles que `update()` (refus 409 ou cascade).
    const goingDone = column.status === 'DONE' && task.status !== 'DONE';
    if (goingDone) {
      const blocking = await this.listIncompletePredecessors(orgId, taskId);
      if (blocking.length) {
        if (!dto.completePredecessors) {
          throw new ConflictException({
            code: 'PREDECESSORS_NOT_DONE',
            message:
              'Cette tâche a des tâches précédentes non terminées ; elle ne peut pas être marquée comme terminée.',
            predecessors: blocking,
          });
        }
        const cascadeIds = blocking.map((p) => p.id);
        const cascaded = await this.prisma.$transaction((tx) =>
          this.cascadeComplete(tx, orgId, cascadeIds, null),
        );
        this.emitCascadeEvents(orgId, cascaded);
      }
    }

    // Raison de mise en pause (facultative) selon le statut de la colonne cible.
    const moveReason = dto.statusReason ? dto.statusReason.trim() || null : null;
    const moveData: Prisma.TaskUncheckedUpdateInput = {
      boardColumnId: dto.boardColumnId,
      position,
      status: column.status,
    };
    if (moveSubPatch !== undefined) moveData.subStatusId = moveSubPatch;
    if (column.status === 'ON_HOLD') {
      moveData.holdReason = moveReason;
    } else if (task.status === 'ON_HOLD') {
      moveData.holdReason = null;
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: moveData,
      include: TASK_INCLUDE,
    });

    // Historique de statut (CFD / re-travail) si la colonne change le statut.
    if (column.status !== task.status) {
      await this.prisma.taskStatusHistory
        .create({
          data: {
            organizationId: orgId,
            projectId: task.projectId,
            taskId,
            fromStatus: task.status,
            toStatus: column.status,
            reason: column.status === 'ON_HOLD' ? moveReason : null,
            changedById: null,
          },
        })
        .catch(() => { /* best-effort analytics */ });
    }

    const out = this.toDto(updated);
    this.events.emitToProject(task.projectId, EVENTS.TASK_MOVED, {
      taskId: out.id,
      boardColumnId: out.boardColumnId,
      position: out.position,
      status: out.status,
    });
    void this.webhooks.dispatch(
      orgId,
      'task.moved',
      {
        taskId: out.id,
        projectId: task.projectId,
        boardColumnId: out.boardColumnId,
        position: out.position,
        status: out.status,
      },
      { projectId: task.projectId },
    );
    if (column.status !== task.status) {
      this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
        taskId: out.id,
        from: task.status,
        to: column.status,
      });
      if (column.status === 'DONE')
        void this.webhooks.dispatch(orgId, 'task.completed', out, { projectId: task.projectId });
    }
    // Notification d'ENTRÉE dans un sous-statut (drop dans un container du
    // board) : destinataires configurés sur le sous-statut, acteur exclu.
    if (typeof moveSubPatch === 'string' && moveSubPatch !== task.subStatusId) {
      void this.automationHooks()?.onSubStatusEntered(
        orgId,
        { id: task.id, title: task.title, projectId: task.projectId },
        moveSubPatch,
        actor?.userId ?? null,
      );
    }
    return out;
  }

  // ------------------------------------------------------------
  // Claim / release (cycle de vie agents — chantier 2b)
  // ------------------------------------------------------------

  /**
   * Revendication **atomique** d'une tâche libre (TODO → CLAIMED). Deux couches
   * anti-course :
   *  1. `pg_advisory_xact_lock(hashtext(acteur))` sérialise les claims d'un MÊME
   *     acteur → les vérifications de budget agent sont concurrency-safe.
   *  2. `updateMany(where status=TODO)` : deux acteurs différents qui visent la
   *     MÊME tâche → un seul `count===1` gagne, l'autre reçoit 409.
   *
   * Le claim **auto-assigne** l'acteur (upsert TaskAssignee) → la tâche remonte
   * dans « mes tâches ». Budgets agent (`maxConcurrentTasks`, `dailyRunBudget`)
   * appliqués aux seuls agents.
   */
  async claim(
    orgId: string,
    taskId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true, status: true, projectId: true, title: true, description: true,
        agentGuardrails: true, acceptanceCriteria: true, agentCostBudget: true,
        estimateHours: true,
        labels: { select: { label: { select: { name: true } } } },
        project: {
          select: {
            agentsEnabled: true, agentContext: true, agentGuardrails: true,
            agentCostBudget: true, stakes: true,
            client: { select: { name: true, allowedAgentModels: true } },
          },
        },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    // Gating agents par projet : un agent ne peut revendiquer que sur un projet
    // qui l'autorise (case « Agents IA »). Les humains ne sont pas concernés.
    if (actor.actorKind === 'AGENT' && !task.project?.agentsEnabled) {
      throw new ForbiddenException(
        "Les agents IA ne sont pas activés sur ce projet — revendication refusée.",
      );
    }
    if (task.status !== TaskStatus.TODO) {
      throw new ConflictException({
        code: 'NOT_CLAIMABLE',
        message: `La tâche n'est pas disponible à la revendication (statut ${task.status}).`,
      });
    }
    // Cohérence matrice (TODO→CLAIMED) : no-op en pratique, mais respecte le
    // point de passage unique + audit en mode enforce.
    await this.transitions.check({
      orgId, projectId: task.projectId, taskId,
      from: task.status, to: TaskStatus.CLAIMED, actorUserId: actor.userId,
      actor: { kind: actor.actorKind, isClaimant: false, canUpdate: true },
    });

    // Budgets (agents uniquement) — lus hors transaction, re-vérifiés sous lock.
    const agent =
      actor.actorKind === 'AGENT'
        ? await this.prisma.user.findUnique({
            where: { id: actor.userId },
            select: {
              maxConcurrentTasks: true, dailyRunBudget: true,
              dailyCostBudget: true, monthlyCostBudget: true, trustLevel: true,
              modelProvider: true, model: true,
              costRateInPerKTokens: true, costRateOutPerKTokens: true,
            },
          })
        : null;

    // Allowlist modèles par client (chantier 3) : un client peut restreindre
    // quels providers/modèles d'IA travaillent sur ses projets (souveraineté /
    // conformité). Enforcement DUR au claim, avant tout (fail-closed si l'agent
    // n'annonce pas son modèle et qu'une allowlist est active).
    if (actor.actorKind === 'AGENT') {
      const allowlist = task.project?.client?.allowedAgentModels ?? [];
      if (allowlist.length && !isAgentModelAllowed(allowlist, agent?.modelProvider, agent?.model)) {
        const declared = agent?.modelProvider && agent?.model
          ? `${agent.modelProvider}/${agent.model}`
          : '(non déclaré)';
        void this.audit.log({
          organizationId: orgId,
          action: 'agent.model_not_allowed',
          severity: 'WARNING',
          actorType: 'AGENT',
          actorId: actor.userId,
          resourceType: 'task',
          resourceId: taskId,
          detail: {
            projectId: task.projectId,
            client: task.project?.client?.name ?? null,
            declaredModel: declared,
            allowlist,
          },
        });
        throw new ForbiddenException({
          code: 'MODEL_NOT_ALLOWED',
          message: `Le modèle de l'agent (${declared}) n'est pas autorisé par le client de ce projet.`,
        });
      }
    }

    // (3a) Gate profil de coût (batch 1) — un agent doit avoir un profil de coût
    // configuré (au moins un taux entrée OU sortie) pour travailler : sans ça,
    // ses runs seraient non costés et échapperaient aux budgets. Un taux
    // explicitement à 0 (modèle interne/gratuit) est un choix délibéré et suffit
    // (null ≠ 0). Refus dur, avant tout effet de bord.
    if (
      actor.actorKind === 'AGENT' &&
      agent?.costRateInPerKTokens == null &&
      agent?.costRateOutPerKTokens == null
    ) {
      throw new ConflictException({
        code: 'AGENT_NO_COST_PROFILE',
        message:
          "Profil de coût de l'agent non configuré (Admin > Agents : taux par 1K tokens) — revendication refusée.",
      });
    }

    // (6) Budget pré-autorisé (opt-in `agents.preauthorizeBudget`) : on estime le
    // coût de CETTE tâche à partir du coût moyen par tâche historique de l'agent,
    // pour refuser le claim si l'enveloppe restante ne le couvre pas — au lieu de
    // ne bloquer qu'APRÈS dépassement. Fail-open tant qu'il n'y a pas d'historique
    // (premier run d'un agent : `costEstimate` reste null → aucun blocage).
    const preauthorizeBudget =
      actor.actorKind === 'AGENT' ? await this.policies.getPreauthorizeBudget(orgId) : false;
    let costEstimate: number | null = null;
    if (preauthorizeBudget) {
      const grouped = await this.prisma.agentRun.groupBy({
        by: ['taskId'],
        where: {
          organizationId: orgId,
          agentId: actor.userId,
          taskId: { not: null },
          cost: { not: null },
        },
        _sum: { cost: true },
      });
      const perTask = grouped.map((g) => Number(g._sum.cost ?? 0)).filter((v) => v > 0);
      costEstimate = perTask.length ? perTask.reduce((a, b) => a + b, 0) / perTask.length : null;
    }

    // Moteur de policies (chantier 3) : évalué au claim contre le contexte de la
    // tâche (labels, estimation, transition). `deny` (enforce) bloque ; sinon on
    // journalise seulement. `require_review` est honoré plus tard (auto-close).
    await this.evaluatePolicies(orgId, {
      actorKind: actor.actorKind,
      trustLevel: (agent?.trustLevel ?? null) as AgentPolicyContext['trustLevel'],
      labels: task.labels.map((l) => l.label.name),
      scope: (task.project?.stakes ?? null) as AgentPolicyContext['scope'],
      estimateHours: task.estimateHours != null ? Number(task.estimateHours) : null,
      transition: `${TaskStatus.TODO}->${TaskStatus.CLAIMED}`,
    }, { taskId, projectId: task.projectId, actorUserId: actor.userId, throwOnDeny: true });

    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.userId}))`;

      if (agent?.maxConcurrentTasks != null) {
        const active = await tx.task.count({
          where: {
            organizationId: orgId, deletedAt: null,
            status: { in: [TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS, TaskStatus.CHANGES_REQUESTED] },
            assignees: { some: { userId: actor.userId } },
          },
        });
        if (active >= agent.maxConcurrentTasks) {
          throw new ConflictException({
            code: 'BUDGET_CONCURRENCY',
            message: `Limite de tâches simultanées atteinte (${agent.maxConcurrentTasks}).`,
          });
        }
      }
      if (agent?.dailyRunBudget != null) {
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        const today = await tx.taskStatusHistory.count({
          where: {
            organizationId: orgId, changedById: actor.userId,
            toStatus: TaskStatus.CLAIMED, changedAt: { gte: since },
          },
        });
        if (today >= agent.dailyRunBudget) {
          throw new ConflictException({
            code: 'BUDGET_DAILY',
            message: `Budget de revendications quotidien atteint (${agent.dailyRunBudget}).`,
          });
        }
      }
      // Budgets de COÛT (€) — somme des runs déclarés (AgentRun) sur la fenêtre.
      // Refus si le seuil est déjà atteint (l'agent ne prend pas une tâche de plus).
      if (agent?.dailyCostBudget != null) {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const agg = await tx.agentRun.aggregate({
          _sum: { cost: true },
          where: { organizationId: orgId, agentId: actor.userId, createdAt: { gte: dayStart } },
        });
        const spent = Number(agg._sum.cost ?? 0);
        const budget = Number(agent.dailyCostBudget);
        if (spent >= budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_DAILY',
            message: `Budget de coût quotidien atteint (${budget} €, dépensé ${spent.toFixed(2)} €).`,
          });
        }
        if (costEstimate != null && spent + costEstimate > budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_DAILY_PREAUTH',
            message: `Coût estimé de la tâche (${costEstimate.toFixed(2)} €) au-dessus du budget quotidien restant (${(budget - spent).toFixed(2)} €).`,
          });
        }
      }
      if (agent?.monthlyCostBudget != null) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const agg = await tx.agentRun.aggregate({
          _sum: { cost: true },
          where: { organizationId: orgId, agentId: actor.userId, createdAt: { gte: monthStart } },
        });
        const spent = Number(agg._sum.cost ?? 0);
        const budget = Number(agent.monthlyCostBudget);
        if (spent >= budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_MONTHLY',
            message: `Budget de coût mensuel atteint (${budget} €, dépensé ${spent.toFixed(2)} €).`,
          });
        }
        if (costEstimate != null && spent + costEstimate > budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_MONTHLY_PREAUTH',
            message: `Coût estimé de la tâche (${costEstimate.toFixed(2)} €) au-dessus du budget mensuel restant (${(budget - spent).toFixed(2)} €).`,
          });
        }
      }
      // Budgets de coût par PROJET / par TÂCHE (enveloppes totales € — finance
      // agents). Indépendants du budget propre de l'agent : un petit projet ou une
      // tâche coûteuse ne peut pas déborder. Somme de TOUS les agents (coût agent
      // total du projet / de la tâche).
      if (actor.actorKind === 'AGENT' && task.project?.agentCostBudget != null) {
        const agg = await tx.agentRun.aggregate({
          _sum: { cost: true },
          where: { organizationId: orgId, projectId: task.projectId },
        });
        const spent = Number(agg._sum.cost ?? 0);
        const budget = Number(task.project.agentCostBudget);
        if (spent >= budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_PROJECT',
            message: `Budget de coût agent du projet atteint (${budget} €, dépensé ${spent.toFixed(2)} €).`,
          });
        }
        if (costEstimate != null && spent + costEstimate > budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_PROJECT_PREAUTH',
            message: `Coût estimé de la tâche (${costEstimate.toFixed(2)} €) au-dessus du budget agent projet restant (${(budget - spent).toFixed(2)} €).`,
          });
        }
      }
      if (actor.actorKind === 'AGENT' && task.agentCostBudget != null) {
        const agg = await tx.agentRun.aggregate({
          _sum: { cost: true },
          where: { organizationId: orgId, taskId },
        });
        const spent = Number(agg._sum.cost ?? 0);
        const budget = Number(task.agentCostBudget);
        if (spent >= budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_TASK',
            message: `Budget de coût agent de la tâche atteint (${budget} €, dépensé ${spent.toFixed(2)} €).`,
          });
        }
        if (costEstimate != null && spent + costEstimate > budget) {
          throw new ConflictException({
            code: 'BUDGET_COST_TASK_PREAUTH',
            message: `Coût estimé (${costEstimate.toFixed(2)} €) au-dessus du budget agent restant de la tâche (${(budget - spent).toFixed(2)} €).`,
          });
        }
      }

      const res = await tx.task.updateMany({
        where: { id: taskId, organizationId: orgId, status: TaskStatus.TODO, deletedAt: null },
        data: {
          status: TaskStatus.CLAIMED,
          claimedById: actor.userId,
          claimedAt: new Date(),
          // Fige le contexte lu par l'agent au claim (traçabilité DORA, chantier 2c.2).
          contextSnapshot: this.buildContextSnapshot(task.project, task) as unknown as Prisma.InputJsonValue,
        },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'ALREADY_CLAIMED',
          message: "Cette tâche vient d'être revendiquée par un autre acteur.",
        });
      }
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId, projectId: task.projectId, taskId,
          fromStatus: TaskStatus.TODO, toStatus: TaskStatus.CLAIMED, changedById: actor.userId,
        },
      });
      await tx.taskAssignee.upsert({
        where: { taskId_userId: { taskId, userId: actor.userId } },
        create: { taskId, userId: actor.userId },
        update: {},
      });
      return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    });

    const out = this.toDto(claimed);
    this.events.emitToProject(task.projectId, EVENTS.TASK_UPDATED, out);
    this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
      taskId, from: TaskStatus.TODO, to: TaskStatus.CLAIMED,
    });
    void this.webhooks.dispatch(orgId, 'task.updated', out, { projectId: task.projectId });
    void this.webhooks.dispatch(orgId, 'task.claimed', out, { projectId: task.projectId });
    return out;
  }

  /**
   * Libération d'une tâche revendiquée (CLAIMED → TODO). Autorisée au claimant
   * (release) OU à un humain `task:update` (takeover). Efface `claimedById`,
   * retire l'assignation de claim. La matrice arbitre le droit.
   */
  async release(
    orgId: string,
    taskId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, status: true, projectId: true, claimedById: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    if (task.status !== TaskStatus.CLAIMED) {
      throw new ConflictException({
        code: 'NOT_RELEASABLE',
        message: `Seule une tâche revendiquée (CLAIMED) peut être libérée (statut ${task.status}).`,
      });
    }
    await this.transitions.check({
      orgId, projectId: task.projectId, taskId,
      from: task.status, to: TaskStatus.TODO, actorUserId: actor.userId,
      actor: {
        kind: actor.actorKind,
        isClaimant: task.claimedById === actor.userId,
        canUpdate: true,
      },
    });

    const released = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.TODO, claimedById: null, claimedAt: null },
      });
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId, projectId: task.projectId, taskId,
          fromStatus: TaskStatus.CLAIMED, toStatus: TaskStatus.TODO, changedById: actor.userId,
        },
      });
      // Retire l'assignation posée par le claim (best-effort : elle peut avoir
      // été retirée entre-temps).
      await tx.taskAssignee
        .delete({ where: { taskId_userId: { taskId, userId: task.claimedById ?? actor.userId } } })
        .catch(() => undefined);
      return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    });

    const out = this.toDto(released);
    this.events.emitToProject(task.projectId, EVENTS.TASK_UPDATED, out);
    this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
      taskId, from: TaskStatus.CLAIMED, to: TaskStatus.TODO,
    });
    void this.webhooks.dispatch(orgId, 'task.updated', out, { projectId: task.projectId });
    void this.webhooks.dispatch(orgId, 'task.released', out, { projectId: task.projectId });
    return out;
  }

  // ------------------------------------------------------------
  // Revue des livrables (cycle de vie agents — chantier 2c)
  // ------------------------------------------------------------

  /** Auto-clôture APPROVED→DONE effective : override projet, sinon réglage org. */
  /**
   * Évalue les policies agents (chantier 3) contre un contexte de tâche et
   * **journalise** chaque règle matchée à l'audit (donnée de gouvernance). En
   * `throwOnDeny`, un `deny` en mode `enforce` lève un 403 (le claim est refusé) ;
   * un `deny` en `report_only` est seulement journalisé (calibration). Retourne
   * l'issue agrégée pour que l'appelant décide (ex. auto-close ← require_review).
   * Best-effort sur l'audit : ne bloque jamais un flux légitime sur une panne.
   */
  private async evaluatePolicies(
    orgId: string,
    ctx: AgentPolicyContext,
    opts: { taskId: string; projectId: string; actorUserId?: string | null; throwOnDeny?: boolean },
  ): Promise<AgentPolicyOutcome> {
    let outcome: AgentPolicyOutcome;
    try {
      outcome = await this.policies.evaluate(orgId, ctx);
    } catch {
      // Fail-open : une panne du moteur ne bloque pas un claim légitime.
      return { deny: false, requireReview: false, notify: false, enforce: false, matched: [] };
    }
    if (outcome.matched.length) {
      const blocking = opts.throwOnDeny === true && outcome.deny && outcome.enforce;
      void this.audit.log({
        organizationId: orgId,
        action: 'agent.policy.evaluated',
        severity: blocking || outcome.deny ? 'WARNING' : 'INFO',
        actorType: ctx.actorKind === 'AGENT' ? 'AGENT' : 'USER',
        actorId: opts.actorUserId ?? null,
        resourceType: 'task',
        resourceId: opts.taskId,
        detail: {
          projectId: opts.projectId,
          actorKind: ctx.actorKind,
          trustLevel: ctx.trustLevel ?? null,
          transition: ctx.transition ?? null,
          matched: outcome.matched,
          deny: outcome.deny,
          requireReview: outcome.requireReview,
          notify: outcome.notify,
          enforce: outcome.enforce,
          blocked: blocking,
        },
      });
    }
    if (opts.throwOnDeny === true && outcome.deny && outcome.enforce) {
      throw new ForbiddenException({
        code: 'POLICY_DENIED',
        message: 'Une policy agent interdit cette action sur cette tâche.',
      });
    }
    return outcome;
  }

  private async resolveAutoClose(
    orgId: string,
    project: { agentAutoCloseOnApproval: boolean | null },
  ): Promise<boolean> {
    if (project.agentAutoCloseOnApproval != null) return project.agentAutoCloseOnApproval;
    try {
      const all = await this.settings.getAll(orgId);
      return all['agents.autoCloseOnApproval'] === true;
    } catch {
      return false; // fail-safe : jamais de clôture auto sur une panne de lecture
    }
  }

  /** IDs des PROJECT_MANAGER du projet (reviewers pressentis → notif IN_REVIEW). */
  private async projectManagerIds(projectId: string): Promise<string[]> {
    const pms = await this.prisma.projectMember.findMany({
      where: { projectId, role: { key: 'PROJECT_MANAGER' } },
      select: { userId: true },
    });
    return pms.map((m) => m.userId);
  }

  /** Cible « propriétaire » d'une notif : owner humain d'un agent, sinon l'acteur lui-même. */
  private async ownerOrSelfId(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ownerId: true },
    });
    return u?.ownerId ?? userId;
  }

  /**
   * Soumission en revue (IN_PROGRESS → IN_REVIEW) par le claimant. Un **agent**
   * doit avoir posé ≥1 livrable PENDING (on ne passe pas en revue une déclaration
   * vide — la revue porte sur un artefact). Émet `task.review_requested` +
   * notifie les reviewers (PM du projet).
   */
  async submitForReview(
    orgId: string,
    taskId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, status: true, projectId: true, claimedById: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    if (task.status !== TaskStatus.IN_PROGRESS) {
      throw new ConflictException({
        code: 'NOT_SUBMITTABLE',
        message: `Seule une tâche en cours (IN_PROGRESS) peut être soumise en revue (statut ${task.status}).`,
      });
    }
    if (actor.actorKind === 'AGENT') {
      const pending = await this.prisma.deliverable.findMany({
        where: { taskId, organizationId: orgId, reviewStatus: 'PENDING', deletedAt: null },
        select: { id: true },
      });
      if (pending.length === 0) {
        throw new ConflictException({
          code: 'NO_DELIVERABLE',
          message: 'Un agent doit soumettre au moins un livrable avant de passer en revue.',
        });
      }
      // Déclaration de consommation obligatoire (opt-in `agents.requireRunDeclaration`) :
      // pour connaître le budget réellement dépensé, on exige qu'au moins un run
      // de coût (`AgentRun`) ait été déclaré par cet agent **et rattaché au
      // livrable soumis** (porte A1, batch 1) AVANT la revue — pas juste « un run
      // sur la tâche » : le run et le livrable doivent être liés (l'agent passe le
      // `deliverableId` à `vaks_report_run`). Rapproche le coût de l'artefact revu.
      if (await this.policies.getRequireRunDeclaration(orgId)) {
        const runs = await this.prisma.agentRun.count({
          where: {
            organizationId: orgId,
            taskId,
            agentId: actor.userId,
            deliverableId: { in: pending.map((d) => d.id) },
          },
        });
        if (runs === 0) {
          throw new ConflictException({
            code: 'NO_RUN_DECLARED',
            message:
              "Déclarez la consommation du livrable soumis (report_run avec son deliverableId : tokens/coût) avant de passer en revue.",
          });
        }
      }
      // Backpressure (chantier 3, AGENTS_VERIFICATION.md §8.8) : le débit global
      // est plafonné par le débit de revue humaine. Si la file de revue du projet
      // (tâches déjà IN_REVIEW) est saturée, on refuse de la charger davantage —
      // l'agent réessaie plus tard (`retryAfter`). N'affecte QUE les agents.
      const maxPending = await this.policies.getBackpressureMax(orgId);
      if (maxPending > 0) {
        const queued = await this.prisma.task.count({
          where: {
            organizationId: orgId, projectId: task.projectId,
            status: TaskStatus.IN_REVIEW, deletedAt: null,
          },
        });
        if (queued >= maxPending) {
          void this.audit.log({
            organizationId: orgId,
            action: 'agent.backpressure',
            severity: 'WARNING',
            actorType: 'AGENT',
            actorId: actor.userId,
            resourceType: 'task',
            resourceId: taskId,
            detail: { projectId: task.projectId, queued, maxPending },
          });
          throw new ConflictException({
            code: 'BACKPRESSURE',
            message: `File de revue saturée (${queued}/${maxPending}) — réessayez plus tard.`,
            retryAfter: 300,
          });
        }
      }
    }
    await this.transitions.check({
      orgId, projectId: task.projectId, taskId,
      from: task.status, to: TaskStatus.IN_REVIEW, actorUserId: actor.userId,
      actor: {
        kind: actor.actorKind,
        isClaimant: task.claimedById === actor.userId,
        canUpdate: true,
      },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.IN_REVIEW } });
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId, projectId: task.projectId, taskId,
          fromStatus: TaskStatus.IN_PROGRESS, toStatus: TaskStatus.IN_REVIEW, changedById: actor.userId,
        },
      });
      return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    });

    const out = this.toDto(updated);
    this.events.emitToProject(task.projectId, EVENTS.TASK_UPDATED, out);
    this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
      taskId, from: TaskStatus.IN_PROGRESS, to: TaskStatus.IN_REVIEW,
    });
    void this.webhooks.dispatch(orgId, 'task.updated', out, { projectId: task.projectId });
    void this.webhooks.dispatch(orgId, 'task.review_requested', out, { projectId: task.projectId });
    const reviewers = await this.projectManagerIds(task.projectId);
    if (reviewers.length) {
      void this.notifications.notifyStatusChange(
        orgId, actor.userId, reviewers, taskId, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW,
      );
    }
    return out;
  }

  /**
   * Applique la décision de revue au STATUT de la tâche (IN_REVIEW → APPROVED /
   * CHANGES_REQUESTED) — **point de passage unique** de la matrice. Le livrable
   * lui-même est muté par `DeliverablesService` ; ici on ne touche QUE la tâche
   * (+ auto-clôture APPROVED→DONE si configurée). Le reviewer ≠ auteur est
   * garanti en amont (`reviewingOwnWork`) et rejoué par la matrice.
   */
  async applyReviewDecision(
    orgId: string,
    taskId: string,
    to: 'APPROVED' | 'CHANGES_REQUESTED',
    reviewer: { userId: string; canReview: boolean; reviewingOwnWork: boolean },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true, status: true, projectId: true, claimedById: true, estimateHours: true,
        labels: { select: { label: { select: { name: true } } } },
        project: { select: { agentAutoCloseOnApproval: true, stakes: true } },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    if (task.status !== TaskStatus.IN_REVIEW) {
      throw new ConflictException({
        code: 'NOT_IN_REVIEW',
        message: `La tâche n'est pas en revue (statut ${task.status}).`,
      });
    }
    const toStatus = to === 'APPROVED' ? TaskStatus.APPROVED : TaskStatus.CHANGES_REQUESTED;
    await this.transitions.check({
      orgId, projectId: task.projectId, taskId,
      from: task.status, to: toStatus, actorUserId: reviewer.userId,
      actor: {
        kind: 'HUMAN', canUpdate: true,
        canReview: reviewer.canReview, reviewingOwnWork: reviewer.reviewingOwnWork,
      },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: toStatus,
          ...(toStatus === TaskStatus.CHANGES_REQUESTED ? { retryCount: { increment: 1 } } : {}),
        },
      });
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId, projectId: task.projectId, taskId,
          fromStatus: TaskStatus.IN_REVIEW, toStatus, changedById: reviewer.userId,
        },
      });
      return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    });
    let out = this.toDto(updated);
    this.events.emitToProject(task.projectId, EVENTS.TASK_UPDATED, out);
    this.events.emitToProject(task.projectId, EVENTS.TASK_STATUS_CHANGED, {
      taskId, from: TaskStatus.IN_REVIEW, to: toStatus,
    });
    void this.webhooks.dispatch(orgId, 'task.updated', out, { projectId: task.projectId });

    if (toStatus === TaskStatus.APPROVED) {
      void this.webhooks.dispatch(orgId, 'task.approved', out, { projectId: task.projectId });
      if (await this.resolveAutoClose(orgId, task.project)) {
        // Policy `require_review` (chantier 3) : une tâche qui matche exige une
        // **clôture humaine explicite** — l'auto-close est neutralisé même si
        // globalement activé (checkpoint de gouvernance sur les tâches sensibles).
        const claimant = task.claimedById
          ? await this.prisma.user.findUnique({
              where: { id: task.claimedById },
              select: { kind: true, trustLevel: true },
            })
          : null;
        const pol = await this.evaluatePolicies(
          orgId,
          {
            actorKind: claimant?.kind === 'AGENT' ? 'AGENT' : 'HUMAN',
            trustLevel: (claimant?.trustLevel ?? null) as AgentPolicyContext['trustLevel'],
            labels: task.labels.map((l) => l.label.name),
            scope: (task.project?.stakes ?? null) as AgentPolicyContext['scope'],
            estimateHours: task.estimateHours != null ? Number(task.estimateHours) : null,
            transition: `${TaskStatus.APPROVED}->${TaskStatus.DONE}`,
          },
          { taskId, projectId: task.projectId, actorUserId: reviewer.userId },
        );
        if (!pol.requireReview) {
          out = await this.autoCloseApproved(orgId, task.projectId, taskId, reviewer.userId);
        }
      }
    } else {
      void this.webhooks.dispatch(orgId, 'task.changes_requested', out, { projectId: task.projectId });
      const target = await this.ownerOrSelfId(task.claimedById);
      if (target) {
        void this.notifications.notifyStatusChange(
          orgId, reviewer.userId, [target], taskId, TaskStatus.IN_REVIEW, TaskStatus.CHANGES_REQUESTED,
        );
      }
      // Poison task (AGENTS_VERIFICATION.md §8.11) : trop de cycles rejetés →
      // escalade humaine automatique. On sort la tâche du circuit agent plutôt
      // que de la lui renvoyer indéfiniment (elle soulage la file, ne l'alourdit pas).
      const escalated = await this.maybeEscalatePoisonTask(
        orgId, taskId, task.projectId, task.claimedById, updated.retryCount, reviewer.userId,
      );
      if (escalated) out = escalated;
    }
    return out;
  }

  /**
   * Escalade « poison task » : si le compteur de rejets (`retryCount`) d'une tâche
   * revendiquée par un **agent** atteint le seuil, on retire l'agent (claim +
   * assignation) → la tâche cesse d'être resoumissible par l'agent (la matrice
   * exige le claimant pour CHANGES_REQUESTED→IN_PROGRESS) et attend une reprise
   * humaine. Audit `agent.poison_task` + notif PM. Seuil réglable
   * `agents.verification.poisonRetryThreshold` (défaut 3, clamp 1–20).
   * Retourne le DTO mis à jour si escaladé, sinon `null`. Best-effort.
   */
  private async maybeEscalatePoisonTask(
    orgId: string,
    taskId: string,
    projectId: string,
    claimedById: string | null,
    retryCount: number,
    reviewerId: string,
  ) {
    if (!claimedById) return null;
    let threshold = 3;
    try {
      const all = await this.settings.getAll(orgId);
      const n = Number(all['agents.verification.poisonRetryThreshold']);
      if (Number.isInteger(n) && n >= 1 && n <= 20) threshold = n;
    } catch {
      /* défaut 3 */
    }
    if (retryCount < threshold) return null;
    const claimant = await this.prisma.user.findUnique({
      where: { id: claimedById },
      select: { kind: true, ownerId: true },
    });
    if (claimant?.kind !== 'AGENT') return null; // poison réservé aux agents (v1)

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { claimedById: null } });
      await tx.taskAssignee
        .deleteMany({ where: { taskId, userId: claimedById } })
        .catch(() => undefined);
      return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    });
    void this.audit.logCritical({
      organizationId: orgId,
      action: 'agent.poison_task',
      actorType: 'AGENT',
      actorId: claimedById,
      resourceType: 'task',
      resourceId: taskId,
      detail: { projectId, retryCount, threshold, escalatedTo: 'human' },
    });
    // Prévient les reviewers (PM) qu'une tâche est sortie du circuit agent.
    const reviewers = await this.projectManagerIds(projectId);
    const targets = [...new Set([...reviewers, claimant?.ownerId].filter((v): v is string => !!v))];
    if (targets.length) {
      void this.notifications.notifyStatusChange(
        orgId, reviewerId, targets, taskId, TaskStatus.CHANGES_REQUESTED, TaskStatus.CHANGES_REQUESTED,
      );
    }
    const out = this.toDto(updated);
    this.events.emitToProject(projectId, EVENTS.TASK_UPDATED, out);
    return out;
  }

  /** Clôture automatique APPROVED → DONE (auto-close activé). Matrice `autoClose=true`. */
  private async autoCloseApproved(
    orgId: string, projectId: string, taskId: string, actorUserId: string,
  ) {
    await this.transitions.check({
      orgId, projectId, taskId, from: TaskStatus.APPROVED, to: TaskStatus.DONE,
      actorUserId, actor: { kind: 'HUMAN', canUpdate: false, canReview: false }, autoClose: true,
    });
    const done = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId, projectId, taskId,
          fromStatus: TaskStatus.APPROVED, toStatus: TaskStatus.DONE, changedById: actorUserId,
        },
      });
      return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    });
    const out = this.toDto(done);
    this.events.emitToProject(projectId, EVENTS.TASK_UPDATED, out);
    this.events.emitToProject(projectId, EVENTS.TASK_STATUS_CHANGED, {
      taskId, from: TaskStatus.APPROVED, to: TaskStatus.DONE,
    });
    void this.webhooks.dispatch(orgId, 'task.completed', out, { projectId });
    return out;
  }

  // ------------------------------------------------------------
  // Contexte de travail des agents (chantier 2c.2)
  // ------------------------------------------------------------

  /**
   * Snapshot léger du contexte lu par l'agent au claim + hash de détection de
   * changement. Si le brief/critères changent après coup, on sait que le livrable
   * a été produit sur la base du contexte `hash` (traçabilité DORA).
   */
  private buildContextSnapshot(
    project: { agentContext: string | null; agentGuardrails: string | null } | null,
    task: { agentGuardrails: string | null; acceptanceCriteria: Prisma.JsonValue },
  ) {
    const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
    const payload = {
      brief: project?.agentContext ?? null,
      projectGuardrails: project?.agentGuardrails ?? null,
      taskGuardrails: task.agentGuardrails ?? null,
      criteria,
    };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
    return { hash, capturedAt: new Date().toISOString(), ...payload };
  }

  /**
   * Contexte de travail agrégé d'une tâche — **une seule lecture** pour l'agent :
   * brief projet + garde-fous (projet & tâche) + tâche + critères d'acceptation +
   * journal vivant borné (livrables APPROUVÉS) + commentaires récents.
   */
  /**
   * Activité agent d'une tâche (batch 1 UI, 2026-07-26) : ce que les agents ont
   * fait SUR cette tâche — runs déclarés (tokens, coût déclaré vs coût de
   * référence `derivedCost`, flag d'anomalie recalculé), coût total, enveloppe
   * `agentCostBudget` + dépensé, et l'agent qui l'a revendiquée. Alimente
   * l'onglet « AI » du détail de tâche (les données existaient déjà en base, il
   * manquait juste cette lecture consolidée par tâche).
   */
  async getAgentActivity(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        agentCostBudget: true,
        claimedById: true,
        claimedAt: true,
        project: { select: { agentsEnabled: true } },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');

    const runs = await this.prisma.agentRun.findMany({
      where: { organizationId: orgId, taskId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const ids = new Set<string>(runs.map((r) => r.agentId));
    if (task.claimedById) ids.add(task.claimedById);
    const users = ids.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...ids] }, organizationId: orgId },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));
    let spent = 0;
    const runDtos = runs.map((r) => {
      const cost = num(r.cost);
      const derivedCost = num(r.derivedCost);
      if (cost != null) spent += cost;
      const tokensTotal = (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
      // Anomalie recalculée à la lecture (mêmes règles que report_run).
      let anomaly: 'no_tokens' | 'zero_cost' | 'below_reference' | null = null;
      if (r.deliverableId && tokensTotal === 0) anomaly = 'no_tokens';
      else if (cost === 0 && (derivedCost ?? 0) > 0) anomaly = 'zero_cost';
      else if (cost != null && cost > 0 && derivedCost != null && derivedCost > 0 && cost < derivedCost * 0.5)
        anomaly = 'below_reference';
      return {
        id: r.id,
        agentId: r.agentId,
        agentName: nameById.get(r.agentId) ?? null,
        model: r.model,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        cost,
        derivedCost,
        anomaly,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      };
    });

    return {
      agentsEnabled: !!task.project?.agentsEnabled,
      budget: {
        taskBudget: num(task.agentCostBudget),
        spent: Math.round(spent * 10000) / 10000,
        runCount: runs.length,
      },
      claim: task.claimedById
        ? {
            agentId: task.claimedById,
            agentName: nameById.get(task.claimedById) ?? null,
            claimedAt: task.claimedAt ? task.claimedAt.toISOString() : null,
          }
        : null,
      runs: runDtos,
    };
  }

  async getWorkContext(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true, number: true, title: true, description: true, status: true,
        dueDate: true, startDate: true, estimateHours: true,
        agentGuardrails: true, acceptanceCriteria: true, projectId: true,
        requiredSkillLevel: true,
        requiredSkill: { select: { name: true } },
        project: {
          select: { key: true, name: true, agentContext: true, agentGuardrails: true },
        },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');

    const [journal, comments, aiDocs] = await Promise.all([
      this.prisma.agentJournalEntry.findMany({
        where: { organizationId: orgId, projectId: task.projectId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { title: true, summary: true, taskId: true, createdAt: true },
      }),
      this.prisma.comment.findMany({
        where: { taskId, organizationId: orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { body: true, createdAt: true, author: { select: { name: true } } },
      }),
      // Documents projet marqués « Contexte IA » — l'agent lit le contenu via
      // `GET /tasks/:taskId/context-documents/:docId` (borné à sa tâche).
      this.prisma.projectDocument.findMany({
        where: { projectId: task.projectId, organizationId: orgId, aiContext: true },
        orderBy: { uploadedAt: 'desc' },
        take: 50,
        select: { id: true, filename: true, mimeType: true, sizeBytes: true },
      }),
    ]);

    const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
    // Sources de fichiers externes (SharePoint…) disponibles pour cette tâche —
    // l'agent découvre la dispo ici sans sonder. Résolu en lazy (module @Global)
    // pour ne pas coupler TasksModule au seam filesources ; best-effort.
    let contextSources: { source: string; label: string; available: boolean; reason?: string }[] = [];
    try {
      const fs = this.moduleRef.get(FileSourcesService, { strict: false });
      contextSources = await fs.availabilityForTask(orgId, taskId);
    } catch {
      /* seam indisponible : on omet simplement le bloc */
    }
    return {
      task: {
        id: task.id, number: task.number, title: task.title,
        description: task.description, status: task.status,
        dueDate: task.dueDate, startDate: task.startDate, estimateHours: task.estimateHours,
        requiredSkill: task.requiredSkill?.name ?? null,
        requiredSkillLevel: task.requiredSkillLevel ?? null,
      },
      project: {
        key: task.project.key, name: task.project.name,
        brief: task.project.agentContext ?? null,
        guardrails: task.project.agentGuardrails ?? null,
      },
      taskGuardrails: task.agentGuardrails ?? null,
      acceptanceCriteria: criteria,
      // Ordre chronologique (le plus ancien d'abord) pour la lecture.
      journal: journal.reverse().map((j) => ({
        title: j.title, summary: j.summary, taskId: j.taskId, at: j.createdAt,
      })),
      recentComments: comments.reverse().map((c) => ({
        author: c.author?.name ?? '—', body: c.body, at: c.createdAt,
      })),
      // Documents « Contexte IA » du projet : métadonnées seulement ici, le
      // contenu (texte) se lit à la demande via context-documents/:docId.
      projectDocuments: aiDocs.map((d) => ({
        id: d.id, filename: d.filename, mimeType: d.mimeType, sizeBytes: d.sizeBytes,
      })),
      // Sources de fichiers externes (ex. SharePoint de la team) : lecture via
      // `GET /tasks/:taskId/context-files[/:source/:itemId]`. `available:false` +
      // `reason` (FS_*) quand la source n'est pas exploitable sur ce projet.
      contextSources,
    };
  }

  /**
   * Contenu d'un document « Contexte IA » du projet d'une tâche, lu PAR la tâche
   * (même périmètre d'accès que le work-context — un agent affecté à la tâche
   * peut lire le contexte de son projet). Texte inline (cap ~64 Ko) ; binaire →
   * métadonnées + 415. Le blob vit dans le bucket S3 des chartes/docs.
   */
  async getContextDocument(orgId: string, taskId: string, docId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    const doc = await this.prisma.projectDocument.findFirst({
      where: { id: docId, projectId: task.projectId, organizationId: orgId, aiContext: true },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, storageKey: true },
    });
    if (!doc) throw new NotFoundException('Document de contexte introuvable');
    const meta = { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes };
    // Types texte lisibles inline. Le reste renvoie les métadonnées + un flag
    // (l'agent sait que le contenu n'est pas exploitable en texte).
    const isText =
      /^text\//.test(doc.mimeType) ||
      /(json|csv|xml|markdown|x-yaml|yaml|javascript|typescript)/.test(doc.mimeType) ||
      /\.(md|markdown|txt|csv|json|log|yml|yaml)$/i.test(doc.filename);
    if (!isText) {
      throw new UnsupportedMediaTypeException({
        code: 'BINARY_DOCUMENT',
        message: 'Contenu binaire non lisible en texte. Téléchargez le document.',
        document: meta,
      });
    }
    const CAP = 64 * 1024;
    // S3Service est @Global — résolu en lazy (comme les hooks) pour ne pas
    // alourdir le constructeur ni le TasksModule.
    const s3 = this.moduleRef.get(S3Service, { strict: false });
    const buffer = await s3.getObjectBuffer(s3.buckets.charters, doc.storageKey);
    const truncated = buffer.length > CAP;
    return {
      document: meta,
      truncated,
      content: buffer.subarray(0, CAP).toString('utf-8'),
    };
  }

  // ------------------------------------------------------------
  // Suppression logique
  // ------------------------------------------------------------

  async remove(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    await this.prisma.task.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
    this.events.emitToProject(task.projectId, EVENTS.TASK_DELETED, { taskId });
    void this.webhooks.dispatch(orgId, 'task.deleted', { taskId, projectId: task.projectId }, {
      projectId: task.projectId,
    });
    return { id: taskId, title: task.title, deleted: true };
  }

  // ------------------------------------------------------------
  // Helpers internes
  // ------------------------------------------------------------

  private async assertProject(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
  }

  private async assertColumn(projectId: string, columnId: string) {
    const col = await this.prisma.boardColumn.findFirst({
      where: { id: columnId, board: { projectId } },
      select: { id: true },
    });
    if (!col) throw new BadRequestException('Colonne inconnue pour ce projet');
  }

  private async assertSameProjectTask(projectId: string, parentId: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: parentId, projectId, deletedAt: null },
      select: { id: true, isGroup: true },
    });
    if (!t) throw new BadRequestException('Tâche parente invalide');
    if (!t.isGroup) {
      throw new BadRequestException(
        "Le parent doit être un groupe (cochez 'Mark as group' sur la tâche parente).",
      );
    }
  }

  private async assertUsersInOrg(orgId: string, userIds: string[]) {
    const found = await this.prisma.user.count({
      where: { id: { in: userIds }, organizationId: orgId, deletedAt: null },
    });
    if (found !== userIds.length) throw new BadRequestException('Assigné(s) invalide(s)');
  }

  /**
   * Vérifie que chaque assignee proposé appartient bien au périmètre du projet :
   * membre d'une équipe assignée (ProjectTeam → TeamMember) OU membre direct
   * (ProjectMember). Les assignees déjà présents sur la tâche sont tolérés
   * (`grandfathered`) pour qu'un PATCH inchangé ne casse pas après une
   * réorganisation d'équipes.
   *
   * Comportement par défaut si le projet n'a ni équipe assignée ni membre direct :
   * on tombe sur "n'importe quel user de l'org" (pas de configuration encore →
   * on ne bloque pas l'usage).
   */
  private async assertAssigneesAllowedOnProject(
    orgId: string,
    projectId: string,
    userIds: string[],
    grandfathered: string[] = [],
  ) {
    if (userIds.length === 0) return;
    // 1) existence dans l'org
    await this.assertUsersInOrg(orgId, userIds);

    // 1bis) gating agents : aucun agent assignable si le projet ne les autorise pas.
    const agentsInSet = await this.prisma.user.findMany({
      where: { id: { in: userIds }, kind: 'AGENT' },
      select: { id: true },
    });
    if (agentsInSet.length > 0) {
      const proj = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { agentsEnabled: true },
      });
      if (!proj?.agentsEnabled) {
        throw new BadRequestException(
          "Ce projet n'autorise pas les agents IA. Activez la case « Agents IA » du projet (et son contexte) avant d'y assigner un agent.",
        );
      }
    }

    // 2) périmètre projet
    const [teamMembers, projectMembers, projectTeams] = await Promise.all([
      this.prisma.teamMember.findMany({
        where: { team: { projects: { some: { projectId } } } },
        select: { userId: true },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId },
        select: { userId: true },
      }),
      this.prisma.projectTeam.count({ where: { projectId } }),
    ]);

    // Fallback : aucun périmètre défini → on autorise tous les users de l'org.
    if (projectTeams === 0 && projectMembers.length === 0) return;

    const allowed = new Set<string>();
    for (const m of teamMembers) allowed.add(m.userId);
    for (const m of projectMembers) allowed.add(m.userId);
    for (const id of grandfathered) allowed.add(id);

    const offenders = userIds.filter((id) => !allowed.has(id));
    if (offenders.length > 0) {
      throw new BadRequestException(
        `Assigné(s) hors périmètre projet : ${offenders.join(', ')}. ` +
          `Ajoute leur équipe au projet ou désigne-les comme membre direct.`,
      );
    }
  }

  private async assertLabelsInProject(projectId: string, labelIds: string[]) {
    const found = await this.prisma.label.count({ where: { id: { in: labelIds }, projectId } });
    if (found !== labelIds.length) throw new BadRequestException('Label(s) invalide(s)');
  }

  private async firstColumnId(projectId: string): Promise<string | undefined> {
    const board = await this.prisma.board.findFirst({
      where: { projectId },
      include: { columns: { orderBy: { order: 'asc' }, take: 1 } },
    });
    return board?.columns[0]?.id;
  }

  private async statusForColumn(columnId: string | undefined): Promise<TaskStatus | undefined> {
    if (!columnId) return undefined;
    const c = await this.prisma.boardColumn.findUnique({ where: { id: columnId } });
    return c?.status;
  }

  private async nextPositionInColumn(columnId: string | undefined): Promise<number> {
    if (!columnId) return POSITION_GAP;
    const top = await this.prisma.task.findFirst({
      where: { boardColumnId: columnId, deletedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return (top?.position ?? 0) + POSITION_GAP;
  }

  private async computePositionBetween(
    columnId: string,
    beforeId?: string,
    afterId?: string,
  ): Promise<number> {
    const fetch = async (id?: string) =>
      id
        ? this.prisma.task.findUnique({ where: { id }, select: { position: true, boardColumnId: true } })
        : null;
    const before = await fetch(beforeId);
    const after = await fetch(afterId);
    if (before && before.boardColumnId !== columnId)
      throw new BadRequestException('beforeTaskId hors de la colonne cible');
    if (after && after.boardColumnId !== columnId)
      throw new BadRequestException('afterTaskId hors de la colonne cible');

    if (before && after) return (before.position + after.position) / 2;
    if (before) return before.position + POSITION_GAP;
    if (after) return after.position - POSITION_GAP;
    return this.nextPositionInColumn(columnId);
  }

  private parseSort(sort: string | undefined): Prisma.TaskOrderByWithRelationInput {
    const allowed = ['position', 'dueDate', 'priority', 'createdAt', 'updatedAt', 'title'] as const;
    if (!sort) return { position: 'asc' };
    const [field, dir = 'asc'] = sort.split(':');
    if (!(allowed as readonly string[]).includes(field) || (dir !== 'asc' && dir !== 'desc')) {
      throw new BadRequestException('Tri invalide');
    }
    return { [field]: dir } as Prisma.TaskOrderByWithRelationInput;
  }

  /** Résout un sous-statut applicable à un projet (org + restriction), sinon 400. */
  private async resolveSubStatus(orgId: string, projectId: string, subStatusId: string) {
    const sub = await this.prisma.customStatus.findFirst({
      where: {
        id: subStatusId,
        organizationId: orgId,
        OR: [{ projects: { none: {} } }, { projects: { some: { projectId } } }],
      },
      select: { id: true, parentStatus: true },
    });
    if (!sub) {
      throw new BadRequestException('Sous-statut introuvable ou non applicable à ce projet.');
    }
    return sub;
  }

  private toDto(t: TaskWithRelations) {
    return {
      id: t.id,
      number: t.number,
      projectId: t.projectId,
      parentTaskId: t.parentTaskId,
      boardColumnId: t.boardColumnId,
      title: t.title,
      description: t.description,
      status: t.status,
      subStatusId: t.subStatusId ?? null,
      holdReason: t.holdReason ?? null,
      priority: t.priority,
      position: t.position,
      estimateHours: t.estimateHours,
      dueDate: t.dueDate?.toISOString() ?? null,
      startDate: t.startDate?.toISOString() ?? null,
      endDate: t.endDate?.toISOString() ?? null,
      progressPct: t.progressPct,
      isMilestone: t.isMilestone,
      isBug: t.isBug,
      isGroup: t.isGroup,
      color: t.color,
      requiredSkillId: t.requiredSkillId ?? null,
      requiredSkillLevel: t.requiredSkillLevel ?? null,
      externalDependency: t.externalDependency ?? null,
      externalBlocked: t.externalBlocked,
      createdById: t.createdById,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      assignees: t.assignees.map((a) => ({
        userId: a.user.id,
        name: a.user.name,
        email: a.user.email,
      })),
      labels: t.labels.map((l) => ({
        id: l.label.id,
        name: l.label.name,
        color: l.label.color,
      })),
      commentCount: t._count?.comments ?? 0,
      attachmentCount: t._count?.attachments ?? 0,
      agentGuardrails: t.agentGuardrails ?? null,
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? (t.acceptanceCriteria as Array<{ text: string; done: boolean }>)
        : [],
      agentCostBudget: t.agentCostBudget != null ? Number(t.agentCostBudget) : null,
    };
  }
}

export type { Task };
