import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Deliverable, Prisma, TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { S3Service } from '../storage/s3.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { TasksService } from '../tasks/tasks.service';
import { CiWebhooksService } from '../ci-webhooks/ci-webhooks.service';
import { CreateDeliverableDto } from './dto/create-deliverable.dto';
import { ReviewDeliverableDto, ReviewDecision } from './dto/review-deliverable.dto';
import {
  deriveVerificationFloor,
  evaluateVerification,
  shouldRecheck,
  strength,
  TaskStakes,
  AgentTrust,
  VerificationMode,
  VERIFICATION_METHODS,
} from './verification';
import { normalizeStructuredOutputs, StructuredOutputsError } from './structured-outputs';

/** Durée du bail de validation d'un agent validateur (§8.7). */
const VALIDATION_LEASE_MS = 30 * 60 * 1000;

/** Acteur appelant côté validation agent (issu du principal du jeton). */
export interface ValidationActor {
  userId: string;
  actorKind?: 'HUMAN' | 'AGENT';
  capabilities?: string[];
}

/** Statuts de tâche dans lesquels on peut encore attacher un livrable. */
const SUBMITTABLE_STATUSES: TaskStatus[] = [
  TaskStatus.CLAIMED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.CHANGES_REQUESTED,
  TaskStatus.IN_REVIEW,
];

/**
 * Livrables (chantier 2c) — l'artefact produit pour une tâche + son workflow de
 * revue propre. La décision de revue délègue la **transition de statut** de la
 * tâche à `TasksService` (point de passage unique de la matrice) : ici on ne
 * mute que la ligne `Deliverable`.
 */
@Injectable()
export class DeliverablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
    private readonly s3: S3Service,
    private readonly tasks: TasksService,
    private readonly settings: AdminSettingsService,
    private readonly audit: AuditLogService,
    private readonly ci: CiWebhooksService,
  ) {}

  /**
   * Mode de vérification effectif (report_only par défaut — on journalise l'écart
   * sans bloquer). Réglable via `agents.verification.mode`. **Phase B** : le
   * plancher n'est plus une constante globale (`agents.verification.floor`) mais
   * **dérivé par tâche** (enjeu × trust ∩ capacités du projet), cf.
   * `evaluateAndLogVerification`.
   */
  private async resolveVerificationMode(orgId: string): Promise<VerificationMode> {
    try {
      const all = await this.settings.getAll(orgId);
      if (all['agents.verification.mode'] === 'enforce') return 'enforce';
    } catch {
      /* fail-safe : report_only */
    }
    return 'report_only';
  }

  /** Décore une liste de livrables avec les libellés d'auteur / reviewer + PJ. */
  private async decorate(rows: Deliverable[]) {
    const ids = [
      ...new Set(rows.flatMap((r) => [r.authorId, r.reviewedById]).filter((v): v is string => !!v)),
    ];
    const attIds = [...new Set(rows.map((r) => r.attachmentId).filter((v): v is string => !!v))];
    const [users, atts] = await Promise.all([
      ids.length
        ? this.prisma.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, kind: true },
          })
        : Promise.resolve([]),
      attIds.length
        ? this.prisma.attachment.findMany({
            where: { id: { in: attIds } },
            select: { id: true, filename: true, sizeBytes: true },
          })
        : Promise.resolve([]),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const attById = new Map(atts.map((a) => [a.id, a]));
    return rows.map((r) => {
      const a = byId.get(r.authorId);
      const rv = r.reviewedById ? byId.get(r.reviewedById) : null;
      const att = r.attachmentId ? attById.get(r.attachmentId) : null;
      return {
        id: r.id,
        taskId: r.taskId,
        title: r.title,
        url: r.url,
        attachmentId: r.attachmentId,
        attachment: att
          ? { id: att.id, filename: att.filename, sizeBytes: att.sizeBytes }
          : null,
        justification: r.justification,
        reviewStatus: r.reviewStatus,
        version: r.version,
        supersedesId: r.supersedesId,
        verification: r.verification,
        commitSha: r.commitSha,
        structuredOutputs: r.structuredOutputs ?? null,
        author: { id: r.authorId, name: a?.name ?? 'Inconnu', isAgent: a?.kind === 'AGENT' },
        reviewedBy: r.reviewedById ? { id: r.reviewedById, name: rv?.name ?? 'Inconnu' } : null,
        reviewedAt: r.reviewedAt,
        reviewNote: r.reviewNote,
        createdAt: r.createdAt,
      };
    });
  }

  /** Charge la tâche (scopée org, non supprimée) ou 404. */
  private async loadTask(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, status: true, projectId: true, project: { select: { ciRepos: true } } },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    return task;
  }

  async list(orgId: string, taskId: string) {
    await this.loadTask(orgId, taskId);
    const rows = await this.prisma.deliverable.findMany({
      where: { taskId, organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return this.decorate(rows);
  }

  /**
   * Exigence de vérification pour une tâche, du point de vue de l'**acteur
   * courant** (chantier 4b — AGENTS_VERIFICATION.md §9.1). L'agent appelle ceci
   * AVANT de travailler : il sait s'il doit lancer des tests, obtenir une CI
   * signée, ou si un simple `self_attest` suffit. Dérivé de enjeu(tâche) ×
   * trust(acteur) ∩ capacités du projet (fallback `human`, anti-deadlock).
   * Aucun effet de bord.
   */
  async getVerificationRequirements(orgId: string, taskId: string, callerUserId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        project: { select: { verificationCapabilities: true, stakes: true } },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    const caller = await this.prisma.user.findUnique({
      where: { id: callerUserId },
      select: { kind: true, trustLevel: true },
    });
    const caps = Array.isArray(task.project?.verificationCapabilities)
      ? (task.project!.verificationCapabilities as string[])
      : [];
    const mode = await this.resolveVerificationMode(orgId);
    const req = deriveVerificationFloor(
      (task.project?.stakes ?? null) as TaskStakes | null,
      (caller?.trustLevel ?? null) as AgentTrust | null,
      caps,
    );
    // Méthodes acceptables = toutes celles de force ≥ plancher (`X+`).
    const floorStrength = strength(req.floor);
    const acceptableMethods = VERIFICATION_METHODS.filter((m) => strength(m) >= floorStrength);
    // Capacités mécaniques réellement disponibles ici (self_attest + human
    // toujours implicites, comme dans la dérivation).
    const capabilitiesAvailable = [...new Set([...caps, 'self_attest', 'human'])].filter((m) =>
      (VERIFICATION_METHODS as readonly string[]).includes(m),
    );
    return {
      taskId: task.id,
      stakes: req.stakes,
      trust: req.trust,
      actorKind: caller?.kind ?? 'HUMAN',
      /** Plancher effectif (méthode minimale acceptable). */
      requiredFloor: req.floor,
      /** Plancher brut de la table AVANT ajustement au terrain. */
      baseFloor: req.baseFloor,
      /** L'exigence a été remontée à `human` faute de capacité mécanique. */
      escalatedToHuman: req.escalatedToHuman,
      /** Ensemble des méthodes acceptables (force ≥ plancher). */
      requiredMethods: acceptableMethods,
      /** Méthodes réellement produisibles sur ce projet. */
      capabilitiesAvailable,
      /** `enforce` bloque sous le plancher ; `report_only` journalise seulement. */
      mode,
    };
  }

  /**
   * Construit le blob `verification` persisté. Pour `ci_signed` (phase C), le
   * `status` stocké est **corroboré serveur** (résultat CI signé matché sur
   * `commitSha`), jamais celui déclaré par l'agent ; on annexe un bloc `ci`
   * (provenance, verdict, lien de run) que le reviewer voit. Les autres méthodes
   * sont stockées telles quelles.
   */
  private async buildVerification(
    orgId: string,
    dto: CreateDeliverableDto,
    allowedRepos: string[] = [],
  ): Promise<Prisma.InputJsonValue | typeof Prisma.JsonNull> {
    if (!dto.verification) return Prisma.JsonNull;
    const v: Record<string, unknown> = { ...dto.verification };
    if (dto.verification.method === 'ci_signed') {
      const corr = await this.ci.corroborate(orgId, dto.commitSha, allowedRepos);
      v.status = corr.status; // vérité serveur, écrase le status déclaré
      v.ci = {
        corroborated: corr.corroborated,
        provider: corr.provider,
        conclusion: corr.conclusion,
        runUrl: corr.runUrl,
        reason: corr.reason,
        repo: corr.repo,
      };
    }
    return v as Prisma.InputJsonValue;
  }

  /** Soumission d'un livrable par l'auteur (l'acteur courant). */
  async submit(orgId: string, taskId: string, authorId: string, dto: CreateDeliverableDto) {
    const task = await this.loadTask(orgId, taskId);
    if (!SUBMITTABLE_STATUSES.includes(task.status)) {
      throw new ConflictException({
        code: 'NOT_SUBMITTABLE',
        message: `Impossible d'attacher un livrable à une tâche au statut ${task.status}.`,
      });
    }
    if (!dto.url && !dto.attachmentId && !dto.content && !dto.justification?.trim()) {
      throw new BadRequestException(
        'Un livrable doit porter au moins une URL, un contenu, une pièce jointe ou une justification.',
      );
    }

    // Persistance de l'artefact : soit un CONTENU texte/markdown que l'agent
    // produit (écrit dans Garage/S3, réutilise le pipeline Attachment), soit une
    // pièce jointe déjà uploadée. Le contenu est prioritaire.
    let attachmentId: string | null = dto.attachmentId ?? null;
    if (dto.content) {
      const desired = (dto.filename || `${dto.title}.md`).slice(0, 255);
      const safeName = desired.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
      const mimeType = /\.(md|markdown)$/i.test(desired) ? 'text/markdown' : 'text/plain';
      const buffer = Buffer.from(dto.content, 'utf-8');
      const storageKey = `org/${orgId}/task/${taskId}/deliverable/${randomUUID()}-${safeName}`;
      await this.s3.putObject(this.s3.buckets.attachments, storageKey, buffer, mimeType);
      const att = await this.prisma.attachment.create({
        data: {
          organizationId: orgId,
          taskId,
          uploaderId: authorId,
          storageKey,
          filename: desired,
          mimeType,
          sizeBytes: buffer.length,
        },
        select: { id: true },
      });
      attachmentId = att.id;
    } else if (dto.attachmentId) {
      // PJ existante : doit appartenir à la même tâche/org.
      const att = await this.prisma.attachment.findFirst({
        where: { id: dto.attachmentId, organizationId: orgId, taskId, deletedAt: null },
        select: { id: true },
      });
      if (!att) throw new BadRequestException('Pièce jointe introuvable sur cette tâche.');
    }

    // Chaîne de versions : ce livrable supersède le plus récent de la tâche.
    const previous = await this.prisma.deliverable.findFirst({
      where: { taskId, organizationId: orgId, deletedAt: null },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    });

    // Corroboration serveur de la preuve `ci_signed` (phase C) : vaks-pm ne fait
    // jamais confiance au `status` DÉCLARÉ par l'agent pour une preuve CI — il le
    // dérive du résultat CI signé reçu par webhook, matché sur `commitSha`. Aucun
    // résultat trouvé ⇒ `pending` (le webhook peut arriver plus tard, re-corroboré
    // au gate de revue).
    const verificationToStore = await this.buildVerification(
      orgId,
      dto,
      (task as { project?: { ciRepos?: string[] } }).project?.ciRepos ?? [],
    );

    // Sorties structurées (lot B) : validées ICI, pas dans la ValidationPipe —
    // le message doit dire à l'agent CE qu'il doit corriger, pas « objet
    // invalide ». Un refus laisse le reste du livrable non écrit (rien de
    // partiel n'est persisté).
    let structuredOutputs: Prisma.InputJsonValue | undefined;
    try {
      const norm = normalizeStructuredOutputs(dto.structuredOutputs);
      if (norm) structuredOutputs = norm as unknown as Prisma.InputJsonValue;
    } catch (e) {
      if (e instanceof StructuredOutputsError) throw new BadRequestException(e.message);
      throw e;
    }

    const created = await this.prisma.deliverable.create({
      data: {
        organizationId: orgId,
        taskId,
        authorId,
        title: dto.title,
        url: dto.url ?? null,
        attachmentId,
        justification: dto.justification?.trim() || null,
        verification: verificationToStore,
        commitSha: dto.commitSha?.trim() || null,
        ...(structuredOutputs !== undefined ? { structuredOutputs } : {}),
        supersedesId: previous?.id ?? null,
        version: (previous?.version ?? 0) + 1,
      },
    });

    void this.webhooks.dispatch(
      orgId,
      'deliverable.submitted',
      { id: created.id, taskId, projectId: task.projectId, title: created.title, version: created.version },
      { projectId: task.projectId },
    );
    const [dto2] = await this.decorate([created]);
    return dto2;
  }

  /**
   * Décision de revue d'un livrable (reviewer `task:review`, **≠ auteur**).
   * Met à jour la ligne `Deliverable` PUIS délègue la transition de statut de la
   * tâche à `TasksService` (IN_REVIEW → APPROVED / CHANGES_REQUESTED + auto-close).
   */
  async review(
    orgId: string,
    taskId: string,
    deliverableId: string,
    reviewer: { userId: string },
    dto: ReviewDeliverableDto,
  ) {
    const deliverable = await this.prisma.deliverable.findFirst({
      where: { id: deliverableId, taskId, organizationId: orgId, deletedAt: null },
    });
    if (!deliverable) throw new NotFoundException('Livrable introuvable');
    if (deliverable.reviewStatus !== 'PENDING') {
      throw new ConflictException({
        code: 'ALREADY_REVIEWED',
        message: `Ce livrable a déjà été revu (${deliverable.reviewStatus}).`,
      });
    }
    // Anti auto-approbation : un acteur ne revoit jamais son propre livrable.
    const reviewingOwnWork = deliverable.authorId === reviewer.userId;
    if (reviewingOwnWork) {
      throw new ForbiddenException("Vous ne pouvez pas revoir votre propre livrable.");
    }

    const approved = dto.decision === ReviewDecision.APPROVE;
    const reviewStatus = approved ? 'APPROVED' : 'CHANGES_REQUESTED';

    // Transition de statut de la tâche D'ABORD (point de passage unique + autorité
    // de la matrice). Elle valide que la tâche est bien IN_REVIEW et lève
    // NOT_IN_REVIEW sinon. On ne mute le livrable qu'APRÈS : ainsi un échec de
    // transition (tâche pas/plus en revue, course concurrente) ne laisse jamais un
    // livrable orphelin marqué APPROVED terminal alors que la tâche n'a pas bougé
    // (audit sécu 2026-08-01, finding #2).
    const task = await this.tasks.applyReviewDecision(
      orgId,
      taskId,
      approved ? 'APPROVED' : 'CHANGES_REQUESTED',
      { userId: reviewer.userId, canReview: true, reviewingOwnWork: false },
    );

    await this.prisma.deliverable.update({
      where: { id: deliverableId },
      data: {
        reviewStatus,
        reviewedById: reviewer.userId,
        reviewedAt: new Date(),
        reviewNote: dto.note?.trim() || null,
      },
    });

    // Journal vivant (chantier 2c.2) : SEUL un livrable APPROUVÉ contribue au
    // contexte des agents suivants (garde-fou anti-poisoning — la sortie validée
    // par un humain devient l'entrée du suivant). Best-effort, ne bloque pas.
    if (approved) {
      await this.prisma.agentJournalEntry
        .create({
          data: {
            organizationId: orgId,
            projectId: (task as { projectId: string }).projectId,
            taskId,
            deliverableId,
            title: deliverable.title,
            summary: deliverable.justification ?? null,
          },
        })
        .catch(() => undefined);
    }

    void this.webhooks.dispatch(
      orgId,
      'deliverable.reviewed',
      { id: deliverableId, taskId, reviewStatus, reviewedById: reviewer.userId },
      { projectId: (task as { projectId?: string }).projectId },
    );

    // Gate de vérification (phase A, observationnel — AGENTS_VERIFICATION.md) :
    // mesure la force de la preuve du livrable vs le plancher requis et journalise
    // l'écart (calibration). En `report_only` ça NE change PAS la décision humaine.
    void this.evaluateAndLogVerification(orgId, deliverable, taskId, reviewer.userId, approved);

    const [reviewed] = await this.decorate([
      { ...deliverable, reviewStatus, reviewedById: reviewer.userId, reviewedAt: new Date(), reviewNote: dto.note?.trim() || null } as Deliverable,
    ]);
    return { deliverable: reviewed, task };
  }

  /**
   * Évalue la preuve du livrable au gate (phase B) et journalise l'assessment à
   * l'audit — donnée de CALIBRATION : la preuve de l'agent (self_attest…) vs le
   * verdict humain réel, et si les deux concordent. Le **plancher requis est
   * dérivé** de l'enjeu de la tâche × le trust de l'agent auteur, intersecté avec
   * les capacités de vérification du projet (AGENTS_VERIFICATION.md §4).
   *
   * **Boucle de confiance (§7)** : si l'auteur est un agent, que l'humain a
   * demandé des changements ET que l'agent avait **sur-attesté** (status `pass`
   * sous le plancher), on enregistre un `attestation_mismatch` et on **descend
   * son trustLevel d'un cran** — ses exigences de preuve futures remontent
   * automatiquement (le mou mord sur le futur, pas sur l'appel courant).
   * Best-effort, jamais bloquant en report_only.
   */
  private async evaluateAndLogVerification(
    orgId: string,
    deliverable: Deliverable,
    taskId: string,
    reviewerId: string,
    approved: boolean,
  ): Promise<void> {
    try {
      const mode = await this.resolveVerificationMode(orgId);
      // Terrain : enjeu de la tâche + capacités du projet.
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          project: { select: { verificationCapabilities: true, stakes: true, ciRepos: true } },
        },
      });
      // Auteur : trust de l'agent (humain → pas de dérivation trust-dépendante).
      const author = await this.prisma.user.findUnique({
        where: { id: deliverable.authorId },
        select: { kind: true, trustLevel: true },
      });
      const caps = Array.isArray(task?.project?.verificationCapabilities)
        ? (task!.project!.verificationCapabilities as string[])
        : [];
      const req = deriveVerificationFloor(
        (task?.project?.stakes ?? null) as TaskStakes | null,
        (author?.trustLevel ?? null) as AgentTrust | null,
        caps,
      );
      const ver = (deliverable.verification ?? null) as {
        method?: string | null;
        status?: string | null;
      } | null;
      // Re-corroboration `ci_signed` au gate : le webhook CI peut être arrivé
      // APRÈS la soumission (§8.2) → on relit le buffer signé, pas le status figé.
      let effectiveVer = ver;
      let ciCorr: Awaited<ReturnType<CiWebhooksService['corroborate']>> | null = null;
      if (ver?.method === 'ci_signed') {
        ciCorr = await this.ci.corroborate(
          orgId,
          deliverable.commitSha,
          (task?.project?.ciRepos as string[] | undefined) ?? [],
        );
        effectiveVer = { ...ver, status: ciCorr.status };
      }
      const verdict = evaluateVerification({ verification: effectiveVer, requiredFloor: req.floor, mode });
      const humanDecision = approved ? 'APPROVE' : 'CHANGES_REQUESTED';
      const agreed = verdict.decision === humanDecision;
      await this.audit.log({
        organizationId: orgId,
        action: 'deliverable.verification.evaluated',
        severity: verdict.belowFloor && !agreed ? 'WARNING' : 'INFO',
        actorType: 'USER',
        actorId: reviewerId,
        resourceType: 'deliverable',
        resourceId: deliverable.id,
        detail: {
          taskId,
          authorId: deliverable.authorId,
          method: verdict.method,
          status: verdict.status,
          requiredFloor: req.floor,
          baseFloor: req.baseFloor,
          escalatedToHuman: req.escalatedToHuman,
          stakes: req.stakes,
          trust: req.trust,
          mode,
          gateDecision: verdict.decision,
          code: verdict.code,
          belowFloor: verdict.belowFloor,
          humanDecision,
          agreed,
          // Corroboration serveur de la preuve CI (phase C), le cas échéant.
          ...(ciCorr
            ? {
                ciCorroborated: ciCorr.corroborated,
                ciConclusion: ciCorr.conclusion,
                ciReason: ciCorr.reason,
              }
            : {}),
        },
      });

      // Boucle de confiance : sur-attestation détectée par la revue humaine.
      const overAttested =
        !approved &&
        author?.kind === 'AGENT' &&
        (ver?.status ?? null) === 'pass' &&
        verdict.belowFloor;
      if (overAttested) {
        await this.downgradeTrust(orgId, deliverable.authorId, deliverable.id, taskId, req, ver);
      }
    } catch {
      /* best-effort : la calibration ne bloque jamais la revue */
    }
  }

  /** Descend le trustLevel d'un agent d'un cran (AUTONOMOUS→SUPERVISED→DRAFT_ONLY,
   *  plancher DRAFT_ONLY) et journalise `agent.attestation_mismatch` (CRITICAL). */
  private async downgradeTrust(
    orgId: string,
    agentId: string,
    deliverableId: string,
    taskId: string,
    req: { floor: string; stakes: string; trust: string },
    ver: { method?: string | null; status?: string | null } | null,
  ): Promise<void> {
    const NEXT: Record<string, string | null> = {
      AUTONOMOUS: 'SUPERVISED',
      SUPERVISED: 'DRAFT_ONLY',
      DRAFT_ONLY: null, // déjà au plus bas
    };
    const current = req.trust;
    const to = NEXT[current] ?? null;
    if (to) {
      await this.prisma.user
        .update({ where: { id: agentId }, data: { trustLevel: to as never } })
        .catch(() => undefined);
    }
    await this.audit.logCritical({
      organizationId: orgId,
      action: 'agent.attestation_mismatch',
      actorType: 'AGENT',
      actorId: agentId,
      resourceType: 'deliverable',
      resourceId: deliverableId,
      detail: {
        taskId,
        attestedMethod: ver?.method ?? null,
        attestedStatus: ver?.status ?? null,
        requiredFloor: req.floor,
        stakes: req.stakes,
        trustFrom: current,
        trustTo: to ?? current,
        downgraded: !!to,
      },
    });
  }

  // =========================================================================
  // Phase D — validation par un AGENT VALIDATEUR (AGENTS_VERIFICATION.md §9.1)
  // La revue devient une TÂCHE TIRÉE (symétrie next_task) : un agent ≠ l'auteur
  // revendique un livrable (bail TTL), envoie des heartbeats, rend un verdict.
  // Un verdict `agent_validator` est une PREUVE (force 2) ; en mode `enforce` et
  // si le plancher requis == exactement `agent_validator`, un `approve` non
  // échantillonné auto-transitionne la tâche (première approbation non humaine).
  // =========================================================================

  /** Gate d'action : seul un AGENT porteur de la capability `deliverables:validate`. */
  private assertValidator(caller: ValidationActor): void {
    if (caller.actorKind !== 'AGENT') {
      throw new ForbiddenException('La validation par agent est réservée aux acteurs de type agent.');
    }
    if (!caller.capabilities?.includes('deliverables:validate')) {
      throw new ForbiddenException("Cet agent n'a pas la capacité de valider des livrables.");
    }
  }

  /** Mode de vérification effectif : override projet > défaut org (phase D). */
  private async effectiveMode(orgId: string, projectMode: string | null | undefined): Promise<VerificationMode> {
    if (projectMode === 'enforce') return 'enforce';
    if (projectMode === 'report_only') return 'report_only';
    return this.resolveVerificationMode(orgId);
  }

  /** IDs des projets dont l'acteur est membre (direct ou via une équipe affectée). */
  private async memberProjectIds(orgId: string, userId: string): Promise<string[]> {
    const [pm, pt] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { userId, project: { organizationId: orgId, deletedAt: null } },
        select: { projectId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: { team: { members: { some: { userId } } }, project: { organizationId: orgId, deletedAt: null } },
        select: { projectId: true },
      }),
    ]);
    return [...new Set([...pm.map((r) => r.projectId), ...pt.map((r) => r.projectId)])];
  }

  /**
   * Le plancher requis d'un livrable == exactement `agent_validator` ? (Détermine
   * si un agent validateur est la méthode attendue pour CE livrable.)
   */
  private async floorForDeliverable(
    orgId: string,
    authorId: string,
    project: { stakes?: string | null; verificationCapabilities?: unknown },
  ) {
    const author = await this.prisma.user.findUnique({
      where: { id: authorId },
      select: { trustLevel: true },
    });
    const caps = Array.isArray(project.verificationCapabilities)
      ? (project.verificationCapabilities as string[])
      : [];
    return deriveVerificationFloor(
      (project.stakes ?? null) as TaskStakes | null,
      (author?.trustLevel ?? null) as AgentTrust | null,
      caps,
    );
  }

  /**
   * Tire une tâche de validation (symétrie `next_task`) et la revendique
   * ATOMIQUEMENT via un bail. Candidats : livrables PENDING dont la tâche est
   * IN_REVIEW, sur un projet **agent-activé** dont l'acteur est membre, auteur ≠
   * appelant, plancher requis == `agent_validator`, non baillé (ou bail expiré).
   * Renvoie `null` si rien à valider.
   */
  async claimValidation(orgId: string, caller: ValidationActor) {
    this.assertValidator(caller);
    const projectIds = await this.memberProjectIds(orgId, caller.userId);
    if (!projectIds.length) return null;
    const now = new Date();
    const candidates = await this.prisma.deliverable.findMany({
      where: {
        organizationId: orgId,
        reviewStatus: 'PENDING',
        deletedAt: null,
        authorId: { not: caller.userId },
        task: {
          deletedAt: null,
          status: TaskStatus.IN_REVIEW,
          projectId: { in: projectIds },
          project: { agentsEnabled: true },
        },
        OR: [{ validatorClaimedById: null }, { validatorLeaseExpiresAt: { lt: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: {
        id: true,
        taskId: true,
        authorId: true,
        task: {
          select: {
            projectId: true,
            project: { select: { stakes: true, verificationCapabilities: true } },
          },
        },
      },
    });

    for (const c of candidates) {
      const req = await this.floorForDeliverable(orgId, c.authorId, c.task.project ?? {});
      if (req.floor !== 'agent_validator') continue; // pas la méthode attendue ici
      const leaseUntil = new Date(now.getTime() + VALIDATION_LEASE_MS);
      const res = await this.prisma.deliverable.updateMany({
        where: {
          id: c.id,
          reviewStatus: 'PENDING',
          authorId: { not: caller.userId },
          OR: [{ validatorClaimedById: null }, { validatorLeaseExpiresAt: { lt: now } }],
        },
        data: {
          validatorClaimedById: caller.userId,
          validatorClaimedAt: now,
          validatorLeaseExpiresAt: leaseUntil,
        },
      });
      if (res.count !== 1) continue; // ravi par un autre validateur → suivant
      const full = await this.prisma.deliverable.findUnique({ where: { id: c.id } });
      const [decorated] = await this.decorate([full as Deliverable]);
      void this.audit.log({
        organizationId: orgId,
        action: 'agent.validation.claimed',
        severity: 'INFO',
        actorType: 'AGENT',
        actorId: caller.userId,
        resourceType: 'deliverable',
        resourceId: c.id,
        detail: { taskId: c.taskId, authorId: c.authorId, requiredFloor: req.floor, leaseUntil: leaseUntil.toISOString() },
      });
      return {
        reviewId: c.id,
        taskId: c.taskId,
        projectId: c.task.projectId,
        authorId: c.authorId,
        requiredFloor: req.floor,
        leaseExpiresAt: leaseUntil.toISOString(),
        deliverable: decorated,
      };
    }
    return null;
  }

  /** Prolonge le bail de validation (§8.7). 403 si l'appelant n'est pas le claimant. */
  async validationHeartbeat(orgId: string, taskId: string, deliverableId: string, caller: ValidationActor) {
    this.assertValidator(caller);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + VALIDATION_LEASE_MS);
    const res = await this.prisma.deliverable.updateMany({
      where: {
        id: deliverableId,
        taskId,
        organizationId: orgId,
        reviewStatus: 'PENDING',
        validatorClaimedById: caller.userId,
        validatorLeaseExpiresAt: { gt: now },
        // Cohérent avec claimValidation : un projet désactivé pour les agents entre
        // le claim et le heartbeat fait retomber le bail comme perdu (LEASE_LOST)
        // plutôt que de laisser un validateur prolonger sur un projet où les agents
        // ont été coupés (audit sécu 2026-08-01, finding #4).
        task: { project: { agentsEnabled: true } },
      },
      data: { validatorLeaseExpiresAt: leaseUntil },
    });
    if (res.count !== 1) {
      throw new ConflictException({
        code: 'LEASE_LOST',
        message: 'Bail de validation perdu ou expiré — reprenez une tâche de validation.',
      });
    }
    return { ok: true, leaseExpiresAt: leaseUntil.toISOString() };
  }

  /**
   * Soumet le verdict de l'agent validateur. Écrit une preuve `agent_validator`
   * (force 2) sur le livrable. En mode `enforce` ET si le plancher requis ==
   * exactement `agent_validator`, un `approve` **non échantillonné** (§7)
   * auto-transitionne IN_REVIEW→APPROVED (+auto-close) ; un `changes_requested`
   * → CHANGES_REQUESTED. Sinon (report_only, plancher différent, ou échantillon
   * tiré) : la preuve est enregistrée, l'humain garde la décision.
   */
  async submitValidation(
    orgId: string,
    taskId: string,
    deliverableId: string,
    caller: ValidationActor,
    dto: { verdict: 'approve' | 'changes_requested'; note?: string },
  ) {
    this.assertValidator(caller);
    const d = await this.prisma.deliverable.findFirst({
      where: { id: deliverableId, taskId, organizationId: orgId, deletedAt: null },
    });
    if (!d) throw new NotFoundException('Livrable introuvable');
    if (d.reviewStatus !== 'PENDING') {
      throw new ConflictException({ code: 'ALREADY_REVIEWED', message: `Ce livrable a déjà été revu (${d.reviewStatus}).` });
    }
    if (d.authorId === caller.userId) {
      throw new ForbiddenException('Un agent ne valide jamais son propre livrable.');
    }
    if (d.validatorClaimedById && d.validatorClaimedById !== caller.userId) {
      throw new ForbiddenException('Ce livrable est en cours de validation par un autre agent.');
    }

    const approve = dto.verdict === 'approve';
    const verification = {
      method: 'agent_validator',
      status: approve ? 'pass' : 'fail',
      evidence: { validator_agent_id: caller.userId, verdict: dto.verdict, notes: dto.note?.trim() || null },
    };

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        projectId: true,
        project: {
          select: { stakes: true, verificationCapabilities: true, verificationMode: true, agentsEnabled: true },
        },
      },
    });
    // Cohérent avec claimValidation (qui filtre `project: { agentsEnabled: true }`
    // dès le tirage) : refuser tout verdict — même simplement enregistré, a fortiori
    // auto-approuvant en enforce — sur un projet où les agents ont été désactivés
    // depuis le claim (audit sécu 2026-08-01, finding #4).
    if (!task?.project?.agentsEnabled) {
      throw new ConflictException({
        code: 'AGENTS_DISABLED',
        message: 'Les agents IA sont désactivés sur ce projet.',
      });
    }
    const req = await this.floorForDeliverable(orgId, d.authorId, task?.project ?? {});
    const author = await this.prisma.user.findUnique({ where: { id: d.authorId }, select: { trustLevel: true } });
    const mode = await this.effectiveMode(orgId, task?.project?.verificationMode);

    // Décision d'auto-transition (uniquement enforce + plancher == agent_validator
    // + tâche IN_REVIEW). Sinon la preuve est juste enregistrée (report_only /
    // plancher différent : l'humain décide).
    let transition: 'APPROVED' | 'CHANGES_REQUESTED' | null = null;
    let sampled = false;
    if (mode === 'enforce' && req.floor === 'agent_validator' && task?.status === TaskStatus.IN_REVIEW) {
      if (approve) {
        sampled = shouldRecheck((author?.trustLevel ?? null) as AgentTrust | null, Math.random());
        if (!sampled) transition = 'APPROVED';
      } else {
        transition = 'CHANGES_REQUESTED';
      }
    }

    // Auto-transition serveur D'ABORD quand une transition est décidée (autorité
    // de la matrice, valide IN_REVIEW) : on ne marque le livrable revu qu'APRÈS
    // une transition réussie — sinon un échec (course, tâche sortie de revue entre
    // la lecture du statut et ici) laissait un livrable APPROVED orphelin sans
    // transition de tâche correspondante (audit sécu 2026-08-01, finding #2). Le
    // validateur agent porte l'autorité du gate (canReview:true, reviewingOwnWork:
    // false garanti par les checks ci-dessus).
    let taskResult: unknown = null;
    if (transition) {
      taskResult = await this.tasks.applyReviewDecision(orgId, taskId, transition, {
        userId: caller.userId,
        canReview: true,
        reviewingOwnWork: false,
      });
    }

    const reviewStatus = transition === 'APPROVED' ? 'APPROVED' : transition === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'PENDING';
    await this.prisma.deliverable.update({
      where: { id: deliverableId },
      data: {
        verification: verification as unknown as Prisma.InputJsonValue,
        validatorVerdict: dto.verdict,
        validatorNote: dto.note?.trim() || null,
        validatorLeaseExpiresAt: null, // bail consommé
        ...(transition
          ? { reviewStatus, reviewedById: caller.userId, reviewedAt: new Date(), reviewNote: dto.note?.trim() || null }
          : {}),
      },
    });

    if (transition === 'APPROVED') {
      await this.prisma.agentJournalEntry
        .create({
          data: {
            organizationId: orgId,
            projectId: (taskResult as { projectId: string }).projectId ?? task!.projectId,
            taskId,
            deliverableId,
            title: d.title,
            summary: d.justification ?? null,
          },
        })
        .catch(() => undefined);
    }
    if (transition) {
      void this.webhooks.dispatch(
        orgId,
        'deliverable.reviewed',
        { id: deliverableId, taskId, reviewStatus, reviewedById: caller.userId, byAgentValidator: true },
        { projectId: task!.projectId },
      );
    }

    void this.audit.logCritical({
      organizationId: orgId,
      action: 'agent.validation.submitted',
      actorType: 'AGENT',
      actorId: caller.userId,
      resourceType: 'deliverable',
      resourceId: deliverableId,
      detail: {
        taskId,
        authorId: d.authorId,
        verdict: dto.verdict,
        mode,
        requiredFloor: req.floor,
        transition: transition ?? 'none',
        sampled,
        autoApproved: transition === 'APPROVED',
      },
    });

    const [decorated] = await this.decorate([
      { ...d, reviewStatus, validatorVerdict: dto.verdict, verification: verification as never } as Deliverable,
    ]);
    return {
      applied: !!transition,
      decision: transition ?? (sampled ? 'ESCALATE_HUMAN' : 'RECORDED'),
      sampled,
      mode,
      requiredFloor: req.floor,
      deliverable: decorated,
      task: taskResult,
    };
  }
}
