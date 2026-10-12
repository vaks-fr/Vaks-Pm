import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, Task, TaskStatus } from '@db';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { WatchersService } from '../automations/watchers.service';
import { EVENTS, AgentPolicyContext, AgentPolicyOutcome, isAgentModelAllowed, foldToBaseStatus, billingUnitForProvider } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AgentNudgeService } from '../agents/agent-nudge.service';
import { SkillsService } from '../skills/skills.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { auditDiff } from '../audit-logs/audit-sanitize';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TaskTransitionService } from './task-transition.service';
import { PolicyEngineService } from '../agents/policy-engine.service';
import { AgentBudgetService } from '../agents/agent-budget.service';
import { leaseExpiryFrom } from '../agents/agent-budget';
import { readStructuredOutputs } from '../deliverables/structured-outputs';
// Résolus en LAZY via `moduleRef` (comme les hooks d'automatisation) : on
// n'ajoute PAS ces modules aux imports de TasksModule — CommentsModule et
// SkillRequestsModule vivent au-dessus des tâches, l'inverse ferait un cycle de
// modules. L'import de fichier, lui, est sans cycle (ni l'un ni l'autre
// n'importe `tasks.service`) et il faut la classe à l'exécution comme jeton DI.
import { CommentsService } from '../comments/comments.service';
import { SkillRequestsService } from '../skill-requests/skill-requests.service';
// Service AUTONOME (prisma + settings + logique pure de vérification) : import
// direct sans cycle, contrairement à `DeliverablesService` qui importe déjà
// `TasksService`. Fourni par `TasksModule` pour la même raison.
import { SubtreeVerificationService } from '../deliverables/subtree-verification.service';
import { agentSelfGovernanceViolation } from './agent-self-governance';
import { decideSubStatus } from '../custom-statuses/sub-status-rules';
import { S3Service } from '../storage/s3.service';
import { AgentContextService } from '../agent-context/agent-context.service';
import { buildContextSnapshot } from '../agents/context/context-hash';
import { effectiveAiFolderIds } from '../projects/document-context';
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

/** Longueur minimale de la description d'une sous-tâche créée par un agent.
 *  Assez pour forcer une phrase utile, assez peu pour ne pas pousser au
 *  remplissage : c'est un plancher, pas une cible. */
const MIN_SUBTASK_DESCRIPTION = 60;

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
   * Identifiant du principal. Renseigné pour les contrôles qui comparent
   * l'acteur à l'état de la tâche — décomposition agent (« tu ne découpes que
   * ce que tu tiens »). `create()` reçoit déjà `userId` en paramètre ; ce champ
   * sert aux chemins où seul le `caller` est propagé.
   */
  userId?: string;
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
    private readonly agentNudge: AgentNudgeService,
    private readonly skills: SkillsService,
    private readonly audit: AuditLogService,
    private readonly transitions: TaskTransitionService,
    private readonly settings: AdminSettingsService,
    private readonly policies: PolicyEngineService,
    private readonly budgets: AgentBudgetService,
    private readonly subtreeVerification: SubtreeVerificationService,
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

  /**
   * Lecture self-only pour le flux ICS personnel (`CalendarService`, slice C).
   * Mêmes filtres que `myTasks` (assigné, non DONE, projet actif) restreints
   * aux tâches avec échéance — une tâche sans `dueDate` n'a rien à afficher
   * dans un calendrier. Select minimal : aucune donnée d'autres membres.
   */
  async tasksForUserCalendar(orgId: string, userId: string) {
    return this.prisma.task.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: { not: TaskStatus.DONE },
        dueDate: { not: null },
        assignees: { some: { userId } },
        project: { status: 'ACTIVE', kind: 'STANDARD', deletedAt: null },
      },
      orderBy: { dueDate: 'asc' },
      take: TASK_LIST_HARD_LIMIT,
      select: {
        id: true,
        title: true,
        dueDate: true,
        priority: true,
        status: true,
        project: { select: { key: true, name: true } },
      },
    });
  }

  /**
   * Remontée de preuve de l'arbre au moment où un agent soumet un parent en
   * revue. Le plancher est celui du PARENT (enjeu projet × confiance ∩ capacités
   * de vérification), c'est-à-dire la politique réglée en admin — jamais quelque
   * chose que l'agent choisit.
   *
   * Même dualité que le gate d'un livrable isolé : en `enforce` on refuse, en
   * `report_only` on journalise. `DeliverablesService` est résolu en lazy — il
   * importe déjà `TasksService`, un import direct ferait un cycle.
   */
  private async assertSubtreeVerified(
    orgId: string,
    taskId: string,
    projectId: string,
    actorUserId: string,
  ) {
    let sub: Awaited<ReturnType<SubtreeVerificationService['evaluate']>> | null = null;
    try {
      sub = await this.subtreeVerification.evaluate(orgId, taskId, actorUserId);
    } catch {
      return; // fail-open : une panne d'évaluation ne bloque pas un flux légitime
    }
    if (!sub || sub.satisfied) return;

    const detail = {
      projectId,
      requiredFloor: sub.requiredFloor,
      weakest: sub.weakest,
      belowFloor: sub.below,
      missingProof: sub.missing,
      mode: sub.mode,
    };
    void this.audit.log({
      organizationId: orgId,
      action: 'agent.subtree.below_floor',
      severity: 'WARNING',
      actorType: 'AGENT',
      actorId: actorUserId,
      resourceType: 'task',
      resourceId: taskId,
      detail,
    });
    if (sub.mode !== 'enforce') return; // calibration : on observe sans bloquer

    const parts: string[] = [];
    if (sub.missing.length) parts.push(`sans livrable approuvé : #${sub.missing.join(', #')}`);
    if (sub.below.length) {
      parts.push(
        `sous le plancher ${sub.requiredFloor} : ` +
          sub.below.map((b) => `#${b.number} (${b.method})`).join(', '),
      );
    }
    throw new ConflictException({
      code: 'SUBTREE_BELOW_FLOOR',
      message: `Le découpage ne prouve pas assez pour ce parent — ${parts.join(' ; ')}.`,
    });
  }

  /**
   * Décomposition par un AGENT (lot B, capability `tasks:decompose`).
   *
   * `task:create` seul serait une porte de sortie : un agent plafonné sur sa
   * tâche s'ouvrirait une tâche neuve, hors enveloppe et hors périmètre. Le
   * droit est donc borné **à l'action**, comme le pouvoir de valider (4c) :
   *
   *  1. la tâche créée DOIT être l'enfant d'une tâche que l'agent **tient**
   *     (`claimedById`) — il découpe son propre travail, il n'ouvre pas de
   *     chantier ;
   *  2. **un seul niveau** : on ne décompose pas une sous-tâche (l'arbre reste
   *     borné, et l'héritage d'enveloppe reste calculable en une remontée) ;
   *  3. aucun champ de gouvernance (budget, enjeu, garde-fous, critères) —
   *     un agent ne s'écrit pas ses propres limites, ici comme au PATCH.
   *
   * Un humain n'est concerné par aucune de ces règles.
   */
  private async assertAgentDecomposition(
    orgId: string,
    projectId: string,
    dto: CreateTaskDto,
    caller?: TaskCaller,
  ): Promise<void> {
    if (caller?.actorKind !== 'AGENT') return;

    const forbidden = agentSelfGovernanceViolation(
      'AGENT',
      dto as unknown as Record<string, unknown>,
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'AGENT_SELF_GOVERNANCE',
        message: `Un agent ne définit pas lui-même ${forbidden.join(', ')} sur une tâche.`,
      });
    }
    if (!dto.parentTaskId) {
      throw new ForbiddenException({
        code: 'AGENT_SUBTASK_ONLY',
        message:
          "Un agent ne crée que des sous-tâches de la tâche qu'il a revendiquée : fournissez `parentTaskId`.",
      });
    }
    const parent = await this.prisma.task.findFirst({
      where: { id: dto.parentTaskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true, projectId: true, claimedById: true, parentTaskId: true, status: true,
        requiredSkillId: true, requiredSkillLevel: true,
      },
    });
    if (!parent || parent.projectId !== projectId) {
      throw new NotFoundException('Tâche parente introuvable dans ce projet.');
    }
    if (parent.claimedById !== caller.userId) {
      throw new ForbiddenException({
        code: 'AGENT_NOT_CLAIMANT',
        message:
          "Vous ne détenez pas cette tâche — un agent ne peut décomposer que la tâche qu'il a revendiquée.",
      });
    }
    // `claimedById` SURVIT à l'approbation et à la clôture (c'est une trace, pas
    // un bail) : sans ce contrôle, un agent pourrait rouvrir du travail sous une
    // tâche terminée des semaines plus tôt. On exige donc un statut où le travail
    // est réellement en cours.
    const ACTIVE_PARENT: TaskStatus[] = [
      TaskStatus.CLAIMED,
      TaskStatus.IN_PROGRESS,
      TaskStatus.CHANGES_REQUESTED,
    ];
    if (!ACTIVE_PARENT.includes(parent.status)) {
      throw new ForbiddenException({
        code: 'AGENT_PARENT_NOT_ACTIVE',
        message: `La tâche parente n'est pas en cours d'exécution (statut ${parent.status}) — on ne rouvre du travail que sous une tâche activement tenue.`,
      });
    }
    // CONTRAT DE PASSAGE DE RELAIS. Une sous-tâche est destinée à être reprise
    // par QUELQU'UN D'AUTRE : le créateur sait pourquoi il découpe, celui qui la
    // prend ne le saura jamais. Un titre seul produit une tâche techniquement
    // prenable et pratiquement infaisable — on l'exige donc explicitement plutôt
    // que d'espérer la bonne volonté de l'agent.
    if (!dto.description || dto.description.trim().length < MIN_SUBTASK_DESCRIPTION) {
      throw new BadRequestException({
        code: 'SUBTASK_DESCRIPTION_REQUIRED',
        message:
          `Décrivez la sous-tâche (${MIN_SUBTASK_DESCRIPTION} caractères minimum) : ce qu'il y a à faire, ` +
          "ce qui est déjà connu, et à quoi ressemble le résultat attendu. Un autre acteur doit pouvoir la prendre sans vous.",
      });
    }
    if (parent.parentTaskId) {
      throw new ForbiddenException({
        code: 'AGENT_DEPTH_LIMIT',
        message:
          "Cette tâche est déjà une sous-tâche : la décomposition est limitée à un niveau. Signalez le besoin dans un commentaire.",
      });
    }
    // Compétence HÉRITÉE du parent par défaut. Sans elle, `next_task` n'a aucun
    // critère de routage : n'importe quel agent membre peut tirer la sous-tâche,
    // y compris celui qui ne sait pas la faire — alors même que « il me manque
    // une compétence » est le premier motif de découpage. L'agent peut toujours
    // déclarer une autre compétence s'il découpe justement pour en changer.
    if (!dto.requiredSkillId && parent.requiredSkillId) {
      dto.requiredSkillId = parent.requiredSkillId;
      if (dto.requiredSkillLevel == null && parent.requiredSkillLevel != null) {
        dto.requiredSkillLevel = parent.requiredSkillLevel;
      }
    }
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
    // Décomposition par un agent (lot B) : bornée à l'action, pas au RBAC.
    await this.assertAgentDecomposition(orgId, projectId, dto, caller);

    // Si la colonne n'est pas fournie, on tombe sur la première colonne du board principal.
    const columnId = dto.boardColumnId ?? (await this.firstColumnId(projectId));
    if (columnId) await this.assertColumn(projectId, columnId);

    const status = dto.status ?? (await this.statusForColumn(columnId)) ?? TaskStatus.TODO;

    // Position : juste après la plus grande position de la colonne.
    const position = await this.nextPositionInColumn(columnId);

    if (dto.parentTaskId) {
      await this.assertSameProjectTask(projectId, dto.parentTaskId);
    }
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
      void this.agentNudge.nudgeTaskAssigned(orgId, { id: task.id, projectId }, dto.assigneeIds);
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
          select: { id: true },
        });
        if (!parent) throw new BadRequestException('Tâche parente invalide');
        // N'importe quelle tâche peut être parente (cf. assertSameProjectTask) ;
        // seul le cycle est interdit.
        await this.assertNoParentCycle(taskId, dto.parentTaskId);
      }
    }
    // Retirer le flag « groupe » d'une tâche qui a des enfants est désormais
    // LÉGITIME : elle redevient une tâche ordinaire qui porte un découpage, ce
    // que le modèle autorise depuis la séparation affichage/découpage. Seule la
    // couleur (significative pour un groupe seulement) est effacée, plus bas.
    if (dto.assigneeIds) {
      // Réutilise `previousAssigneeIds` (déjà chargé ci-dessus sous la même
      // condition `dto.assigneeIds`) au lieu de refaire la même requête.
      await this.assertAssigneesAllowedOnProject(
        orgId,
        existing.projectId,
        dto.assigneeIds,
        previousAssigneeIds,
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

    // Bail d'exécution (lot A §1) : il ne vit que dans les statuts où un agent
    // TIENT la tâche (CLAIMED / IN_PROGRESS). On le renouvelle quand l'agent
    // claimant y (re)vient lui-même — typiquement CLAIMED→IN_PROGRESS au
    // démarrage, et CHANGES_REQUESTED→IN_PROGRESS à la reprise après revue,
    // sinon un bail périmé ferait faucher la tâche à la seconde où l'agent la
    // reprend. Toute sortie de ces statuts l'éteint. Jamais de bail posé pour un
    // humain (ni claimant humain, ni PM qui déplace la carte d'un agent).
    if (statusChanging) {
      const held = dto.status === TaskStatus.CLAIMED || dto.status === TaskStatus.IN_PROGRESS;
      if (!held) {
        data.leaseExpiresAt = null;
      } else if (caller?.actorKind === 'AGENT' && existing.claimedById === actorUserId) {
        data.leaseExpiresAt = leaseExpiryFrom(
          new Date(),
          await this.policies.getExecutionLeaseMinutes(orgId),
        );
      }
    }

    // Réaligne la carte sur la colonne du statut foldé (CLAIMED/CHANGES_REQUESTED
    // → In progress, APPROVED → In review, etc.). Sans ça, `boardColumnId` reste
    // figé sur tout changement de statut hors `move()` et la carte « traîne » dans
    // une colonne qui ne correspond plus à son statut. Best-effort.
    if (statusChanging && dto.status) {
      const colId = await this.columnForStatus(existing.projectId, dto.status as TaskStatus);
      if (colId) data.boardColumn = { connect: { id: colId } };
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
      if (added.length) {
        void this.webhooks.dispatch(
          orgId,
          'task.assigned',
          { ...out, assignedUserIds: added },
          { projectId: task.projectId },
        );
        void this.agentNudge.nudgeTaskAssigned(
          orgId,
          { id: task.id, projectId: task.projectId },
          added,
        );
      }
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
    // Estimation coût Copilot : une tâche complétée directement par un AGENT
    // (projets sans revue) → run estimé via la grille tarifaire si l'agent
    // facture en crédits (non mesurable). Toutes les gardes vivent dans le hook.
    if (statusChanged && task.status === 'DONE' && caller?.actorKind === 'AGENT' && !caller?.system) {
      void this.automationHooks()?.onTaskCompletedByAgent(orgId, { taskId: task.id, agentId: actorUserId ?? undefined });
      // Projets sans revue : la tâche se termine ici, la capacité de l'agent se
      // libère ici aussi (le chemin avec revue passe par `applyReviewDecision`).
      void this.agentNudge.resumeAgent(orgId, actorUserId);
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

    // Snapshot du contexte lu par l'agent — composé AVANT la transaction (c'est
    // une lecture pure, et on ne veut pas tenir un verrou pendant tout ça).
    const contextSnapshot = await this.buildClaimSnapshot(orgId, task.projectId, task);

    // Budget frais AVANT le contrôle : pour un agent crédits (Copilot), persiste
    // son meter d'appels MCP en cours (les crédits déjà brûlés sur ses tâches
    // récentes, pas encore persistés) → le contrôle de budget plus bas voit la
    // dépense réelle, pas une valeur en retard. Best-effort.
    if (actor.actorKind === 'AGENT') {
      await this.automationHooks()?.persistAgentMeter(orgId, actor.userId);
    }

    // Enveloppe de coût de la tâche, HÉRITAGE COMPRIS (lot B) : une sous-tâche
    // sans plafond propre est couverte par celui de son parent, sinon découper
    // une tâche plafonnée suffirait à s'en affranchir. Résolu hors transaction
    // (lecture pure), consommé sous verrou plus bas.
    const taskEnvelope =
      actor.actorKind === 'AGENT'
        ? await this.budgets.resolveTaskEnvelope(orgId, taskId)
        : { projectId: task.projectId, budget: null as number | null, taskIds: [taskId] };

    // Bail d'exécution (lot A §1) : un AGENT ne tient la tâche que pour une
    // durée bornée, qu'il prolonge par heartbeat tant qu'il travaille. Les
    // humains n'ont pas de bail — on ne déposséde pas quelqu'un parce qu'il a
    // fermé son laptop, alors qu'un agent muet est presque toujours un agent mort.
    const leaseExpiresAt =
      actor.actorKind === 'AGENT'
        ? leaseExpiryFrom(new Date(), await this.policies.getExecutionLeaseMinutes(orgId))
        : null;

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
      if (actor.actorKind === 'AGENT' && taskEnvelope.budget != null) {
        const agg = await tx.agentRun.aggregate({
          _sum: { cost: true },
          where: { organizationId: orgId, taskId: { in: taskEnvelope.taskIds } },
        });
        const spent = Number(agg._sum.cost ?? 0);
        const budget = taskEnvelope.budget;
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

      // Réaligne la carte sur la colonne foldée (CLAIMED → In progress).
      const claimedColId = await this.columnForStatus(task.projectId, TaskStatus.CLAIMED);
      const res = await tx.task.updateMany({
        where: { id: taskId, organizationId: orgId, status: TaskStatus.TODO, deletedAt: null },
        data: {
          status: TaskStatus.CLAIMED,
          ...(claimedColId ? { boardColumnId: claimedColId } : {}),
          claimedById: actor.userId,
          claimedAt: new Date(),
          leaseExpiresAt,
          // Fige le contexte lu par l'agent au claim (traçabilité DORA, chantier 2c.2).
          contextSnapshot: contextSnapshot as unknown as Prisma.InputJsonValue,
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
    // Le réveil qui a mené à ce claim a joué son rôle : on libère le slot
    // réservé (AGENT_NUDGE_CAPACITY.md §4.1). Sans ça, la tâche compterait
    // deux fois — comme réservation ET comme tâche active — jusqu'à expiration.
    if (actor.actorKind === 'AGENT') void this.agentNudge.consumeSlot(actor.userId);
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

    // Réaligne la carte sur la colonne TODO : au claim elle avait été poussée
    // vers la colonne foldée CLAIMED → In progress. Sans ça la carte « traîne »
    // en In progress alors que le statut est repassé TODO. Best-effort.
    const todoColId = await this.columnForStatus(task.projectId, TaskStatus.TODO);

    const released = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.TODO,
          ...(todoColId ? { boardColumnId: todoColId } : {}),
          claimedById: null,
          claimedAt: null,
          leaseExpiresAt: null,
        },
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
    // Capacité libérée → on réveille l'agent sur la suite. ⚠️ `task.claimedById`
    // (valeur d'AVANT le release) et pas `actor.userId` : un humain peut faire
    // un takeover, ce serait alors lui qu'on tenterait de réveiller.
    void this.agentNudge.resumeAgent(orgId, task.claimedById);
    return out;
  }

  /**
   * Heartbeat d'exécution (lot A §1) — l'agent prolonge son bail tant qu'il
   * travaille. C'est le pendant de `validationHeartbeat` côté revue.
   *
   * Conditionné au claimant ET au statut par un `updateMany` (pas un `update`) :
   * si le balayeur vient de reprendre la tâche, ou si un humain a fait un
   * takeover, le compteur retombe à 0 et l'agent reçoit `LEASE_LOST` — il doit
   * alors abandonner ce travail plutôt que continuer à brûler des tokens sur une
   * tâche qui ne lui appartient plus.
   *
   * Renvoie aussi les LIMITES courantes (budget restant, compteur de rejets) :
   * le heartbeat est le canal naturel par lequel un agent apprend qu'il doit
   * s'arrêter, sans avoir à interroger quoi que ce soit d'autre.
   */
  async heartbeat(
    orgId: string,
    taskId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, status: true, projectId: true, claimedById: true, retryCount: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    if (task.claimedById !== actor.userId) {
      throw new ConflictException({
        code: 'LEASE_LOST',
        message:
          "Vous ne détenez plus cette tâche (bail expiré ou reprise par un autre acteur) — arrêtez ce travail.",
      });
    }
    if (task.status !== TaskStatus.CLAIMED && task.status !== TaskStatus.IN_PROGRESS) {
      throw new ConflictException({
        code: 'LEASE_LOST',
        message: `La tâche n'est plus en cours d'exécution (statut ${task.status}) — le bail ne s'applique plus.`,
      });
    }

    const minutes = await this.policies.getExecutionLeaseMinutes(orgId);
    const expires = leaseExpiryFrom(new Date(), minutes);
    const res = await this.prisma.task.updateMany({
      where: {
        id: taskId,
        organizationId: orgId,
        claimedById: actor.userId,
        status: { in: [TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS] },
        deletedAt: null,
      },
      data: { leaseExpiresAt: expires },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'LEASE_LOST',
        message: "Le bail vient d'être perdu (reprise concurrente) — arrêtez ce travail.",
      });
    }

    // (Meter de coût : plus de persistance ici — le meter est matérialisé À CHAQUE
    // appel MCP par `McpToolQuotaInterceptor`. Persister aussi au heartbeat ferait
    // un upsert concurrent sur le même runKey que l'appel courant.)

    return {
      taskId,
      status: task.status,
      leaseExpiresAt: expires ? expires.toISOString() : null,
      ...(await this.agentLimits(orgId, taskId, task.projectId, actor, task.retryCount)),
    };
  }

  /**
   * Limites opposables à un agent sur une tâche : bail, plafond de rejets
   * (poison task) et enveloppes de budget restantes. Bloc commun au heartbeat et
   * au work-context — un agent doit connaître ses bornes AVANT de produire, pas
   * les découvrir en se faisant refuser.
   *
   * Renvoie un bloc vide (`applicable:false`) pour un humain : ces plafonds
   * n'existent que pour les agents, autant le dire explicitement.
   */
  private async agentLimits(
    orgId: string,
    taskId: string,
    projectId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
    retryCount: number,
  ) {
    if (actor.actorKind !== 'AGENT') {
      return { limits: { applicable: false as const } };
    }
    const [leaseMinutes, maxRetries, budget] = await Promise.all([
      this.policies.getExecutionLeaseMinutes(orgId).catch(() => 0),
      this.poisonRetryThreshold(orgId),
      this.budgets
        .snapshot(orgId, actor.userId, { taskId, projectId })
        .catch(() => ({ envelopes: [], stop: false, exceeded: [] })),
    ]);
    return {
      limits: {
        applicable: true as const,
        /** Durée du bail en minutes (0 = pas de bail sur cette org). */
        executionLeaseMinutes: leaseMinutes,
        /** Nombre de rejets de revue au-delà duquel la tâche sort du circuit agent. */
        maxRetries,
        retryCount,
        /** Enveloppes € définies (agent/jour, agent/mois, projet, tâche). */
        budget: {
          envelopes: budget.envelopes,
          exceeded: budget.exceeded,
          /** `true` = une enveloppe est consommée : arrêtez et soumettez l'existant. */
          stop: budget.stop,
        },
      },
    };
  }

  /** Seuil de rejets « poison task » (réglable, défaut 3, clamp 1–20). */
  private async poisonRetryThreshold(orgId: string): Promise<number> {
    try {
      const all = await this.settings.getAll(orgId);
      const n = Number(all['agents.verification.poisonRetryThreshold']);
      if (Number.isInteger(n) && n >= 1 && n <= 20) return n;
    } catch {
      /* défaut */
    }
    return 3;
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
    // Idempotence : une tâche DÉJÀ en revue par le même claimant → no-op (on
    // renvoie l'état courant sans erreur). Sans ça, un agent trop zélé qui
    // rappelle `submit_for_review` se prend un NOT_SUBMITTABLE et boucle. La
    // 1ʳᵉ soumission a déjà créé le livrable + posé IN_REVIEW ; les suivantes
    // ne doivent ni casser ni dupliquer.
    if (task.status === TaskStatus.IN_REVIEW && task.claimedById === actor.userId) {
      const current = await this.prisma.task.findFirst({
        where: { id: taskId, organizationId: orgId },
        include: TASK_INCLUDE,
      });
      return this.toDto(current!);
    }
    if (task.status !== TaskStatus.IN_PROGRESS) {
      throw new ConflictException({
        code: 'NOT_SUBMITTABLE',
        message: `Seule une tâche en cours (IN_PROGRESS) peut être soumise en revue (statut ${task.status}).`,
      });
    }
    if (actor.actorKind === 'AGENT') {
      // ORDRE VOULU : le découpage AVANT le livrable de synthèse. Refuser
      // d'abord sur « pas de livrable » pousserait l'agent à rédiger sa synthèse
      // alors que ses sous-tâches sont encore ouvertes — exactement la
      // consolidation prématurée qu'on veut éviter.
      const children = await this.prisma.task.findMany({
        where: { parentTaskId: taskId, organizationId: orgId, deletedAt: null },
        select: { number: true, status: true },
      });
      if (children.length) {
        const open = children
          .filter((c) => c.status !== TaskStatus.DONE && c.status !== TaskStatus.APPROVED)
          .map((c) => c.number);
        if (open.length) {
          throw new ConflictException({
            code: 'SUBTASKS_PENDING',
            message: `Sous-tâches non terminées (#${open.join(', #')}) — terminez le découpage avant de soumettre le parent.`,
          });
        }
        // Remontée de preuve : le parent vaut son maillon le plus faible. Le
        // livrable de synthèse ne rachète pas une sous-tâche restée sous le
        // plancher (décision Thomas 2026-08-01).
        await this.assertSubtreeVerified(orgId, taskId, task.projectId, actor.userId);
      }

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
      //
      // ⚠️ EXEMPTION agents crédits (Copilot) : leur coût est MESURÉ serveur (meter
      // d'appels MCP), `vaks_report_run` leur est masqué → ils ne PEUVENT pas
      // déclarer, et la ligne metered n'a pas de `deliverableId`. Exiger la
      // déclaration les bloquerait éternellement en IN_PROGRESS. Le meter couvre
      // déjà le besoin (connaître le coût réel).
      const isCreditsAgent =
        billingUnitForProvider(
          (
            await this.prisma.user.findFirst({
              where: { id: actor.userId, organizationId: orgId },
              select: { modelProvider: true },
            })
          )?.modelProvider,
        ) === 'credits';
      if (!isCreditsAgent && (await this.policies.getRequireRunDeclaration(orgId))) {
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
        // ⚠️ Ne compte QUE les tâches produites par des agents : ce plafond
        // protège la capacité de revue des LIVRABLES D'AGENTS, et une file de
        // relecture entre humains n'y touche pas. Compter les tâches humaines
        // faisait bloquer les agents par une activité qui ne les concerne pas.
        // `Task.claimedById` est un scalaire sans relation (découplage du
        // schéma) → on résout les ids d'agents puis on filtre par `in`.
        const agentIds = (
          await this.prisma.user.findMany({
            where: { organizationId: orgId, kind: 'AGENT' },
            select: { id: true },
          })
        ).map((u) => u.id);
        const queued = agentIds.length
          ? await this.prisma.task.count({
              where: {
                organizationId: orgId, projectId: task.projectId,
                status: TaskStatus.IN_REVIEW, deletedAt: null,
                claimedById: { in: agentIds },
              },
            })
          : 0;
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

    // Réaligne sur la colonne foldée (IN_REVIEW → In review).
    const reviewColId = await this.columnForStatus(task.projectId, TaskStatus.IN_REVIEW);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Le bail d'exécution s'éteint ici : la balle est dans le camp du reviewer,
      // plus dans celui de l'agent — le balayeur n'a plus rien à reprendre.
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.IN_REVIEW,
          leaseExpiresAt: null,
          ...(reviewColId ? { boardColumn: { connect: { id: reviewColId } } } : {}),
        },
      });
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
    // (Meter de coût : matérialisé à chaque appel MCP par l'intercepteur — plus
    // de persistance ici, cf. commentaire au heartbeat.)
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

    // Réaligne sur la colonne foldée (APPROVED → In review, CHANGES_REQUESTED → In progress).
    const decisionColId = await this.columnForStatus(task.projectId, toStatus);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Écriture CONDITIONNÉE au statut lu : deux décisions concurrentes
      // (APPROVE + CHANGES_REQUESTED, ou revue humaine + validateur agent) ne
      // peuvent pas passer toutes les deux — la seconde voit count=0 → 409.
      const hit = await tx.task.updateMany({
        where: { id: taskId, status: TaskStatus.IN_REVIEW },
        data: {
          status: toStatus,
          ...(decisionColId ? { boardColumnId: decisionColId } : {}),
          ...(toStatus === TaskStatus.CHANGES_REQUESTED ? { retryCount: { increment: 1 } } : {}),
        },
      });
      if (hit.count === 0) {
        throw new ConflictException({
          code: 'NOT_IN_REVIEW',
          message: "La tâche n'est plus en revue (décision concurrente).",
        });
      }
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
      // La tâche quitte la file de revue → un slot de backpressure ET un slot de
      // concurrence se libèrent pour son claimant.
      void this.agentNudge.resumeAgent(orgId, task.claimedById);
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
      // Nudge : réveille l'agent claimant pour qu'il traite les corrections.
      void this.agentNudge.nudgeChangesRequested(
        orgId,
        { id: taskId, projectId: task.projectId },
        task.claimedById,
      );
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
    const threshold = await this.poisonRetryThreshold(orgId);
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
    // L'agent vient d'être retiré de la tâche : sa concurrence se libère. La
    // tâche empoisonnée ne peut pas lui être re-proposée (elle n'est plus TODO,
    // et `rankCandidates` ne classe que des TODO).
    void this.agentNudge.resumeAgent(orgId, claimedById);
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
    // Réaligne sur la colonne Done (auto-close normal : `cascadeComplete` le
    // faisait déjà, pas ce chemin — d'où l'incohérence corrigée ici).
    const doneColId = await this.columnForStatus(projectId, TaskStatus.DONE);
    const done = await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.DONE,
          ...(doneColId ? { boardColumn: { connect: { id: doneColId } } } : {}),
        },
      });
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
    // Estimation coût Copilot : auto-close du flux de revue → l'agent qui a
    // produit le livrable est résolu dans le hook (claimant / auteur du livrable).
    void this.automationHooks()?.onTaskCompletedByAgent(orgId, { taskId });
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
  private async buildClaimSnapshot(
    orgId: string,
    projectId: string,
    task: { agentGuardrails: string | null; acceptanceCriteria: Prisma.JsonValue },
  ) {
    const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
    const pack = await this.agentContextPack(orgId, projectId);
    return buildContextSnapshot(
      {
        // INSTRUCTIONS HUMAINES → `authoredHash`. Ajouter un chef de projet ne
        // doit PAS ressembler à une modification d'instructions.
        brief: pack?.project.briefStructured ?? null,
        freeNotes: pack?.project.freeNotes ?? null,
        projectGuardrails: pack?.project.guardrails ?? null,
        taskGuardrails: task.agentGuardrails ?? null,
        criteria,
        charter: pack?.charter ?? null,
      },
      {
        // ENVIRONNEMENT RÉSOLU → `factsHash`. Sa dérive reste observable, sans
        // polluer le signal « quelqu'un a réécrit les consignes ».
        reviewers: pack?.facts.reviewers ?? [],
        verificationMode: pack?.facts.verificationMode ?? null,
        stakes: pack?.facts.stakes ?? null,
        verificationCapabilities: pack?.facts.verificationCapabilities ?? [],
        locale: pack?.facts.locale ?? null,
        hasCostBudget: !!pack?.facts.hasCostBudget,
      },
      pack?.project.brief ?? null,
    );
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
        contextSnapshot: true,
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
      /**
       * Empreintes du contexte figé au claim. Écrites depuis le chantier 2c.2
       * mais lues par PERSONNE jusqu'ici : il fallait ouvrir psql pour vérifier
       * la traçabilité DORA. On expose les hashes (pas le texte composé, trop
       * volumineux) sur cette route déjà app-privée et gatée `task:view`.
       *
       * `authoredHash` bouge quand un humain réécrit les consignes ;
       * `factsHash` bouge quand l'environnement change (nouveau PM, mode de
       * vérification…). Les distinguer est tout l'intérêt du dispositif.
       */
      contextSnapshot: task.contextSnapshot
        ? (() => {
            const s = task.contextSnapshot as Record<string, unknown>;
            return {
              authoredHash: (s.authoredHash ?? s.hash ?? null) as string | null,
              factsHash: (s.factsHash ?? null) as string | null,
              capturedAt: (s.capturedAt ?? null) as string | null,
            };
          })()
        : null,
      runs: runDtos,
    };
  }

  /**
   * Contexte de travail complet d'une tâche.
   *
   * La partie PROJET (brief composé, charter filtré, documents de contexte,
   * sources externes, journal) vient de `AgentContextService.buildPack` — le
   * MÊME code que l'écran « ce que voient les agents ». C'est ce qui garantit
   * que la prévisualisation ne peut pas dériver de ce que l'agent reçoit
   * réellement. Ne pas recomposer quoi que ce soit ici.
   */
  async getWorkContext(
    orgId: string,
    taskId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' } = { userId: '', actorKind: 'HUMAN' },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true, number: true, title: true, description: true, status: true,
        dueDate: true, startDate: true, estimateHours: true,
        agentGuardrails: true, acceptanceCriteria: true, projectId: true,
        requiredSkillLevel: true, retryCount: true, leaseExpiresAt: true,
        parentTaskId: true,
        requiredSkill: { select: { name: true } },
        project: { select: { key: true, name: true } },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');

    const [pack, comments, limits, reviewFeedback, upstreamOutputs, parent] = await Promise.all([
      this.agentContextPack(orgId, task.projectId),
      this.prisma.comment.findMany({
        where: { taskId, organizationId: orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { body: true, createdAt: true, author: { select: { name: true } } },
      }),
      this.agentLimits(orgId, taskId, task.projectId, actor, task.retryCount),
      this.reviewFeedback(orgId, taskId),
      this.upstreamOutputs(orgId, taskId),
      this.parentContext(orgId, task.parentTaskId),
    ]);

    const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
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
        /** Brief COMPOSÉ (4 champs + faits système + notes libres en dernier). */
        brief: pack?.project.brief ?? null,
        /** Les 4 champs, pour un agent qui préfère la donnée au markdown. */
        briefStructured: pack?.project.briefStructured ?? null,
        guardrails: pack?.project.guardrails ?? null,
        stakes: pack?.project.stakes ?? 'low',
      },
      /** Rubriques du charter autorisées aux agents (jamais budget/personnes). */
      charter: pack?.charter ?? null,
      taskGuardrails: task.agentGuardrails ?? null,
      acceptanceCriteria: criteria,
      /**
       * Bloc PRIORITAIRE de reprise après revue (lot A §5). Non nul dès qu'un
       * livrable a été rejeté : décision, note exacte du valideur, historique des
       * versions. Sans ça un agent en CHANGES_REQUESTED devait deviner ce qu'on
       * lui reprochait (la note vivait sur le livrable, hors du contexte de
       * travail) — première cause de re-travail à côté de la plaque.
       */
      reviewFeedback,
      /**
       * Sorties structurées produites en amont (prédécesseurs + sous-tâches),
       * livrables APPROUVÉS uniquement. À lire AVANT de partir chercher les
       * mêmes valeurs dans la prose des livrables amont.
       */
      upstreamOutputs,
      /**
       * Tâche dont celle-ci est le découpage. `null` si c'est une tâche racine.
       * Sans ce bloc, une sous-tâche est orpheline de sa raison d'être : elle
       * hérite du brief PROJET mais rien du travail qui l'a fait naître.
       */
      parent,
      /** Bornes opposables : bail, plafond de rejets, enveloppes € restantes. */
      ...limits,
      /** Échéance du bail courant si l'agent tient déjà la tâche. */
      leaseExpiresAt: task.leaseExpiresAt ? task.leaseExpiresAt.toISOString() : null,
      journal: (pack?.journal ?? []).map((j) => ({
        title: j.title, summary: j.summary, taskId: j.taskId, at: j.at,
      })),
      recentComments: comments.reverse().map((c) => ({
        author: c.author?.name ?? '—', body: c.body, at: c.createdAt,
      })),
      // Documents « Contexte IA » du projet : métadonnées seulement ici, le
      // contenu (texte) se lit à la demande via context-documents/:docId.
      projectDocuments: (pack?.documents.items ?? []).map((d) => ({
        id: d.id, filename: d.filename, mimeType: d.mimeType, sizeBytes: d.sizeBytes,
        freshAt: d.freshAt,
      })),
      /** Troncature EXPLICITE : `truncated:true` = tout n'est pas remonté. */
      projectDocumentsMeta: {
        total: pack?.documents.total ?? 0,
        returned: pack?.documents.returned ?? 0,
        truncated: pack?.documents.truncated ?? false,
      },
      // Sources de fichiers externes (ex. SharePoint de la team) : lecture via
      // `GET /tasks/:taskId/context-files[/:source/:itemId]`. `available:false` +
      // `reason` (FS_*) quand la source n'est pas exploitable sur ce projet.
      contextSources: pack?.contextSources ?? [],
    };
  }

  /**
   * Demande d'assistance ciblée sur la tâche qu'on détient (lot B).
   *
   * Poster un commentaire est un appel dans le vide : personne n'est nommément
   * prévenu. On réutilise donc la mécanique qui existe déjà pour ça — la
   * **demande de compétence** (`SkillRequest`), qui atterrit dans la boîte du
   * lead de l'équipe couvrant la compétence manquante. Pas de nouveau statut
   * `BLOCKED` ni de « sous-tâche d'assistance » : ce serait une troisième
   * mécanique de demande d'aide à maintenir, pour le même service rendu.
   *
   * Trois effets, dans cet ordre : (1) la question est **toujours** postée en
   * commentaire (trace lisible sur la tâche, quoi qu'il arrive ensuite) ;
   * (2) si une compétence est nommée ET qu'une équipe du projet la couvre, une
   * `SkillRequest` est ouverte vers cette équipe ; (3) si `pause` est demandé,
   * la tâche passe ON_HOLD avec la question pour motif — elle garde son claim et
   * son bail s'éteint, donc le balayeur ne la reprend pas : elle attend un
   * humain, ce qui est exactement l'état voulu.
   */
  async requestAssistance(
    orgId: string,
    taskId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT'; isAdmin?: boolean },
    dto: { question: string; skillId?: string; proposedSkillName?: string; pause?: boolean },
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true, number: true, title: true, status: true, projectId: true,
        claimedById: true, requiredSkillId: true, requiredSkillLevel: true,
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    if (task.claimedById !== actor.userId) {
      throw new ConflictException({
        code: 'NOT_CLAIMANT',
        message:
          "Vous ne détenez pas cette tâche — on ne demande de l'aide que sur le travail qu'on a revendiqué.",
      });
    }
    const question = dto.question.trim();
    if (!question) throw new BadRequestException('Décrivez ce qui vous bloque.');

    // (1) Trace sur la tâche — best-effort : une panne du fil de commentaires
    // ne doit pas empêcher la demande de partir.
    let commentPosted = false;
    try {
      const comments = this.moduleRef.get(CommentsService, { strict: false });
      await comments.create(orgId, actor.userId, taskId, { body: `🆘 ${question}` });
      commentPosted = true;
    } catch {
      /* best-effort */
    }

    // (2) Équipe destinataire résolue SERVEUR à partir de la compétence : parmi
    // les équipes affectées au projet, la première qui déclare couvrir ce skill.
    // Aucune équipe couvrante ⇒ pas de demande (mieux vaut rien qu'un ticket
    // envoyé à quelqu'un qui n'y peut rien) — le commentaire, lui, est passé.
    const skillId = dto.skillId ?? task.requiredSkillId ?? null;
    let skillRequestId: string | null = null;
    let reason: string | null = null;
    if (!skillId && !dto.proposedSkillName?.trim()) {
      reason = 'no_skill_specified';
    } else {
      const teams = await this.prisma.projectTeam.findMany({
        where: { projectId: task.projectId },
        select: { teamId: true },
      });
      const teamIds = teams.map((t) => t.teamId);
      let targetTeamId: string | null = null;
      if (teamIds.length && skillId) {
        const cover = await this.prisma.teamSkill.findFirst({
          where: { teamId: { in: teamIds }, skillId },
          select: { teamId: true },
        });
        targetTeamId = cover?.teamId ?? null;
      }
      // Compétence proposée (hors catalogue) ou non couverte : à défaut, la
      // première équipe du projet — quelqu'un de concerné, pas n'importe qui.
      if (!targetTeamId && teamIds.length) targetTeamId = teamIds[0];
      if (!targetTeamId) {
        reason = 'no_team_on_project';
      } else {
        try {
          const svc = this.moduleRef.get(SkillRequestsService, { strict: false });
          const created = await svc.createFromAgent(
            orgId,
            {
              teamId: targetTeamId,
              type: 'ASSIGN_SKILL',
              ...(skillId ? { skillId } : { proposedName: dto.proposedSkillName!.trim() }),
              desiredLevel: task.requiredSkillLevel ?? undefined,
              projectId: task.projectId,
              taskId,
              note: `[#${task.number} ${task.title}] ${question}`.slice(0, 2000),
            } as never,
            actor.userId,
          );
          skillRequestId = (created as { id?: string })?.id ?? null;
        } catch (e) {
          reason = `skill_request_failed: ${(e as Error).message}`;
        }
      }
    }

    // (3) Mise en pause explicite — passe par `update()` (donc par la matrice de
    // transitions et l'historique), jamais par une écriture directe.
    let paused = false;
    if (dto.pause) {
      await this.update(
        orgId,
        taskId,
        { status: TaskStatus.ON_HOLD, statusReason: question.slice(0, 500) } as UpdateTaskDto,
        actor.userId,
        { isAdmin: !!actor.isAdmin, actorKind: actor.actorKind, userId: actor.userId },
      );
      paused = true;
    }

    // (4) ALERTE HUMAINE — le cœur de la demande d'aide. Sans elle, l'appel au
    // secours ne réveille personne : le commentaire ne touche que les watchers,
    // la mise en pause dépend d'un réglage de notification désactivé par défaut,
    // et la demande de compétence n'existe que si une équipe couvrante a été
    // trouvée. On prévient donc explicitement le PM du projet, l'owner de
    // l'agent et les co-assignés, via le chokepoint `emit` (cooldown, quiet
    // hours, kill switch, carte Teams et audit hérités).
    const notified =
      (await this.automationHooks()
        ?.onAgentAssistanceRequested(orgId, {
          agentId: actor.userId,
          taskId,
          projectId: task.projectId,
          question,
          paused,
        })
        .catch(() => 0)) ?? 0;

    return {
      taskId,
      commentPosted,
      skillRequestId,
      paused,
      /** Nombre d'humains effectivement alertés (PM, owner, co-assignés). */
      notified,
      /** Pourquoi aucune demande de compétence n'a été ouverte, le cas échéant. */
      reason,
    };
  }

  /**
   * Synthèse des sous-tâches d'une tâche (lot B) — ce qu'un agent lit AVANT de
   * consolider son livrable final.
   *
   * Sans ça, l'agent parent devrait lister les tâches du projet, filtrer, puis
   * ouvrir chaque livrable pour savoir ce qui est fait. Ici : un appel, l'état
   * de chaque sous-tâche et les **sorties structurées approuvées** qu'elle a
   * produites. `allDone` dit s'il peut conclure ; `pending` liste ce qui manque
   * (une consolidation prématurée est le meilleur moyen de se faire rejeter).
   */
  async getSubtasksSummary(orgId: string, taskId: string, callerUserId?: string) {
    const parent = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, number: true, title: true, status: true },
    });
    if (!parent) throw new NotFoundException('Tâche introuvable');

    const subtasks = await this.prisma.task.findMany({
      where: { parentTaskId: taskId, organizationId: orgId, deletedAt: null },
      orderBy: { number: 'asc' },
      select: {
        id: true, number: true, title: true, status: true, estimateHours: true,
        claimedById: true, assignees: { select: { userId: true } },
      },
      take: 100,
    });
    const approved = subtasks.length
      ? await this.prisma.deliverable.findMany({
          where: {
            organizationId: orgId,
            taskId: { in: subtasks.map((s) => s.id) },
            reviewStatus: 'APPROVED',
            deletedAt: null,
          },
          orderBy: { reviewedAt: 'desc' },
          select: { taskId: true, title: true, url: true, structuredOutputs: true, reviewedAt: true },
        })
      : [];
    const byTask = new Map<string, (typeof approved)[number]>();
    for (const d of approved) if (!byTask.has(d.taskId)) byTask.set(d.taskId, d);

    const items = subtasks.map((s) => {
      const d = byTask.get(s.id);
      return {
        taskId: s.id,
        number: s.number,
        title: s.title,
        status: s.status,
        estimateHours: s.estimateHours,
        assigneeIds: s.assignees.map((a) => a.userId),
        approvedDeliverable: d
          ? {
              title: d.title,
              url: d.url,
              outputs: readStructuredOutputs(d.structuredOutputs),
              approvedAt: d.reviewedAt ? d.reviewedAt.toISOString() : null,
            }
          : null,
      };
    });
    // Remontée de preuve : ce que l'arbre démontre, contre le plancher du
    // parent. C'est ce qui bloquera (ou non) la soumission en revue — autant que
    // l'agent le voie AVANT de tenter, plutôt qu'en se prenant un 409.
    const verification = callerUserId
      ? await this.subtreeVerification.evaluate(orgId, taskId, callerUserId).catch(() => null)
      : null;

    const DONE_ENOUGH: TaskStatus[] = [TaskStatus.DONE, TaskStatus.APPROVED];
    return {
      parent: { taskId: parent.id, number: parent.number, title: parent.title, status: parent.status },
      count: items.length,
      /** Plancher de preuve du parent + maillon le plus faible de l'arbre. */
      verification,
      /** true = toutes les sous-tâches sont closes : la consolidation peut se faire. */
      allDone: items.length > 0 && items.every((i) => DONE_ENOUGH.includes(i.status as TaskStatus)),
      pending: items.filter((i) => !DONE_ENOUGH.includes(i.status as TaskStatus)).map((i) => i.number),
      subtasks: items,
    };
  }

  /**
   * Contexte de la tâche PARENTE, pour une sous-tâche.
   *
   * Un découpage transmet aujourd'hui le brief du projet mais rien du travail
   * qui l'a fait naître : celui qui reprend la sous-tâche ignore ce qu'on
   * cherchait à faire, ce qui a déjà été décidé et ce sur quoi le parent sera
   * jugé. On remonte donc l'énoncé du parent, ses critères, ses garde-fous
   * propres — et ses sorties structurées **approuvées**, seules à circuler
   * (même règle anti-poisoning que partout ailleurs).
   */
  private async parentContext(orgId: string, parentTaskId: string | null) {
    if (!parentTaskId) return null;
    try {
      const p = await this.prisma.task.findFirst({
        where: { id: parentTaskId, organizationId: orgId, deletedAt: null },
        select: {
          id: true, number: true, title: true, description: true, status: true,
          acceptanceCriteria: true, agentGuardrails: true,
        },
      });
      if (!p) return null;
      const approved = await this.prisma.deliverable.findFirst({
        where: {
          taskId: parentTaskId, organizationId: orgId,
          reviewStatus: 'APPROVED', deletedAt: null,
        },
        orderBy: { reviewedAt: 'desc' },
        select: { structuredOutputs: true },
      });
      return {
        taskId: p.id,
        number: p.number,
        title: p.title,
        description: p.description,
        status: p.status,
        acceptanceCriteria: Array.isArray(p.acceptanceCriteria) ? p.acceptanceCriteria : [],
        guardrails: p.agentGuardrails ?? null,
        outputs: approved ? readStructuredOutputs(approved.structuredOutputs) : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Sorties structurées des tâches AMONT (lot B) — le chaînage machine.
   *
   * Sans ça, une tâche qui dépend d'une autre doit relire tout le livrable amont
   * (prose sur S3) pour y retrouver un endpoint ou un numéro de version : c'est
   * exactement la lecture où un modèle invente. On remonte donc les paires
   * clé/valeur produites en amont, telles quelles.
   *
   * Deux sources : les **prédécesseurs directs** (toute dépendance, pas
   * seulement FS — un SS renseigne autant) et les **sous-tâches** de la tâche
   * courante (décomposition). Dans les deux cas, **livrables APPROUVÉS
   * uniquement** : même règle anti-poisoning que le journal vivant — un livrable
   * rejeté ne doit jamais alimenter le contexte d'une autre tâche. Une seule
   * entrée par tâche (la version approuvée la plus récente), plafonnée.
   */
  private async upstreamOutputs(orgId: string, taskId: string) {
    try {
      const self = await this.prisma.task.findFirst({
        where: { id: taskId, organizationId: orgId },
        select: { parentTaskId: true },
      });
      const [deps, subtasks, siblings] = await Promise.all([
        this.prisma.taskDependency.findMany({
          where: { successorId: taskId, organizationId: orgId },
          select: { predecessorId: true, type: true },
          take: 20,
        }),
        this.prisma.task.findMany({
          where: { parentTaskId: taskId, organizationId: orgId, deletedAt: null },
          select: { id: true },
          take: 20,
        }),
        // Fratrie : les autres sous-tâches du même découpage. C'est le cas
        // d'usage naturel — on découpe un travail en morceaux qui se répondent,
        // et chacun doit pouvoir lire ce que les autres ont établi.
        self?.parentTaskId
          ? this.prisma.task.findMany({
              where: {
                parentTaskId: self.parentTaskId,
                organizationId: orgId,
                deletedAt: null,
                NOT: { id: taskId },
              },
              select: { id: true },
              take: 20,
            })
          : Promise.resolve([] as { id: string }[]),
      ]);
      const sources = new Map<string, 'predecessor' | 'subtask' | 'sibling'>();
      for (const d of deps) sources.set(d.predecessorId, 'predecessor');
      for (const s of subtasks) if (!sources.has(s.id)) sources.set(s.id, 'subtask');
      for (const s of siblings) if (!sources.has(s.id)) sources.set(s.id, 'sibling');
      if (!sources.size) return [];

      const rows = await this.prisma.deliverable.findMany({
        where: {
          organizationId: orgId,
          taskId: { in: [...sources.keys()] },
          reviewStatus: 'APPROVED',
          deletedAt: null,
          NOT: { structuredOutputs: { equals: Prisma.DbNull } },
        },
        orderBy: { reviewedAt: 'desc' },
        select: {
          taskId: true, title: true, structuredOutputs: true, reviewedAt: true,
          task: { select: { number: true, title: true, status: true } },
        },
      });

      const seen = new Set<string>();
      const out: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        if (seen.has(r.taskId)) continue; // la plus récente approuvée suffit
        const outputs = readStructuredOutputs(r.structuredOutputs);
        if (!outputs) continue;
        seen.add(r.taskId);
        out.push({
          taskId: r.taskId,
          taskNumber: r.task?.number ?? null,
          taskTitle: r.task?.title ?? null,
          taskStatus: r.task?.status ?? null,
          source: sources.get(r.taskId) ?? 'predecessor',
          deliverableTitle: r.title,
          approvedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
          outputs,
        });
        if (out.length >= 10) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Retour de revue sur les livrables d'une tâche (lot A §5) — ce que le
   * valideur a effectivement écrit, plus la chaîne des versions.
   *
   * `pending` = livrable en attente (l'agent a déjà soumis, il n'a rien à
   * refaire) ; `lastDecision` porte le verdict le plus récent. On remonte
   * jusqu'à 5 versions : au-delà, ce n'est plus du contexte utile mais du bruit
   * qui coûte des tokens. Best-effort — un contexte de travail ne doit jamais
   * échouer sur ce bloc.
   */
  private async reviewFeedback(orgId: string, taskId: string) {
    try {
      const rows = await this.prisma.deliverable.findMany({
        where: { taskId, organizationId: orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, title: true, version: true, reviewStatus: true,
          reviewNote: true, reviewedAt: true, reviewedById: true, createdAt: true,
        },
      });
      if (!rows.length) return null;
      const reviewerIds = [...new Set(rows.map((r) => r.reviewedById).filter((v): v is string => !!v))];
      const reviewers = reviewerIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: reviewerIds }, organizationId: orgId },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(reviewers.map((u) => [u.id, u.name]));
      const decided = rows.find((r) => r.reviewStatus !== 'PENDING') ?? null;
      return {
        pending: rows.some((r) => r.reviewStatus === 'PENDING'),
        lastDecision: decided
          ? {
              deliverableId: decided.id,
              version: decided.version,
              decision: decided.reviewStatus,
              /** Le texte EXACT du valideur — c'est la consigne de reprise. */
              note: decided.reviewNote,
              reviewedAt: decided.reviewedAt ? decided.reviewedAt.toISOString() : null,
              reviewer: decided.reviewedById ? nameById.get(decided.reviewedById) ?? null : null,
            }
          : null,
        history: rows.map((r) => ({
          deliverableId: r.id,
          title: r.title,
          version: r.version,
          reviewStatus: r.reviewStatus,
          note: r.reviewNote,
          at: (r.reviewedAt ?? r.createdAt).toISOString(),
        })),
      };
    } catch {
      return null;
    }
  }

  /**
   * Pack de contexte projet, résolu en lazy (module `@Global`) pour ne pas
   * coupler `TasksModule` au module de composition. Best-effort : un agent ne
   * doit jamais être privé de sa tâche parce que la composition a échoué.
   */
  private async agentContextPack(orgId: string, projectId: string) {
    try {
      const svc = this.moduleRef.get(AgentContextService, { strict: false });
      return await svc.buildPack(orgId, projectId);
    } catch {
      return null;
    }
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
    // L'exposition est une UNION : drapeau propre OU dossier « contexte IA »
    // (héritage). Ne filtrer que sur `aiContext:true` listerait dans le
    // work-context des documents que l'agent recevrait ensuite en 404.
    const folders = await this.prisma.projectDocumentFolder.findMany({
      where: { projectId: task.projectId, organizationId: orgId },
      select: { id: true, parentId: true, aiContext: true },
    });
    const aiFolderIds = effectiveAiFolderIds(folders);
    const doc = await this.prisma.projectDocument.findFirst({
      where: {
        id: docId,
        projectId: task.projectId,
        organizationId: orgId,
        OR: [
          { aiContext: true },
          ...(aiFolderIds.size ? [{ folderId: { in: [...aiFolderIds] } }] : []),
        ],
      },
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

  /**
   * Parent valide : même projet, vivant. **Plus d'exigence de « groupe »**
   * (2026-08-01).
   *
   * Le produit faisait porter deux métiers à une seule relation : le
   * *regroupement d'affichage* (colonne « Groupes » du board, couleur héritée =
   * `isGroup`) et le *découpage du travail* (une tâche réelle qui se subdivise).
   * Exiger que tout parent soit un groupe rendait le second impossible sans
   * dénaturer le premier — une tâche revendiquée, en cours, avec son livrable et
   * son budget, n'a aucune raison de devenir un conteneur d'affichage.
   *
   * Les deux notions sont désormais séparées : `isGroup` ne pilote plus que le
   * board, et n'importe quelle tâche peut porter des enfants. L'anti-cycle est
   * assuré par `assertNoParentCycle`.
   */
  private async assertSameProjectTask(projectId: string, parentId: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: parentId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!t) throw new BadRequestException('Tâche parente invalide');
  }

  /**
   * Refuse un rattachement qui créerait un cycle (A enfant de B, B enfant de A).
   * Tant que seuls les groupes pouvaient être parents, le risque restait
   * théorique ; en ouvrant la parenté à toutes les tâches, il devient réel.
   * Remontée bornée : un arbre légitime est peu profond, une boucle déjà
   * présente en base ne doit pas faire tourner la requête à l'infini.
   */
  private async assertNoParentCycle(taskId: string, parentId: string) {
    let current: string | null = parentId;
    for (let depth = 0; current && depth < 50; depth++) {
      if (current === taskId) {
        throw new BadRequestException(
          'Rattachement impossible : la tâche parente descend déjà de cette tâche.',
        );
      }
      const row: { parentTaskId: string | null } | null = await this.prisma.task.findUnique({
        where: { id: current },
        select: { parentTaskId: true },
      });
      current = row?.parentTaskId ?? null;
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

    let offenders = userIds.filter((id) => !allowed.has(id));
    if (offenders.length > 0) {
      // Héritage owner→agent : un agent dont l'**owner** est dans le périmètre
      // du projet est éligible sans ajout membre explicite (le projet est
      // `agentsEnabled` — vérifié plus haut dès qu'un agent est présent). Le set
      // `allowed` = exactement « membres directs ∪ membres d'équipe affectée »,
      // donc « owner ∈ allowed » ⇔ « owner membre du projet ».
      const offenderAgents = await this.prisma.user.findMany({
        where: { id: { in: offenders }, kind: 'AGENT', ownerId: { not: null } },
        select: { id: true, ownerId: true },
      });
      const inherited = new Set(
        offenderAgents.filter((a) => a.ownerId && allowed.has(a.ownerId)).map((a) => a.id),
      );
      offenders = offenders.filter((id) => !inherited.has(id));
    }
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

  /**
   * Colonne de board correspondant au statut donné, en repliant les statuts
   * agents sur leur base (`foldToBaseStatus` — SOURCE DE VÉRITÉ partagée avec le
   * front) : CLAIMED/CHANGES_REQUESTED → colonne IN_PROGRESS, APPROVED → colonne
   * IN_REVIEW. Sert à réaligner `boardColumnId` sur tout chemin d'écriture de
   * statut HORS `move()` (le drag choisit sa colonne explicitement). Best-effort :
   * renvoie `undefined` si aucune colonne — l'appelant ne touche alors à rien.
   * Même pattern que `cascadeComplete`. Lecture via `this.prisma` (les colonnes
   * ne sont pas mutées dans les transactions appelantes → lecture stable).
   */
  private async columnForStatus(projectId: string, status: TaskStatus): Promise<string | undefined> {
    const base = foldToBaseStatus(status) as TaskStatus;
    const col = await this.prisma.boardColumn.findFirst({
      where: { board: { projectId }, status: base },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    return col?.id;
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
