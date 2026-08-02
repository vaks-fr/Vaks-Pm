import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import {
  AgentTrust,
  TaskStakes,
  VerificationMode,
  deriveVerificationFloor,
  strength,
} from './verification';

/**
 * Remontée de preuve d'un ARBRE de tâches (décision Thomas, 2026-08-01).
 *
 * Quand une tâche est découpée, le travail réel vit dans les sous-tâches : le
 * parent ne peut pas être validé sur son seul livrable de synthèse en ignorant
 * ce que ses enfants ont — ou n'ont pas — prouvé. Règle retenue : **le parent
 * vaut son maillon le plus faible**. Si le plancher exige `ci_signed` et qu'une
 * sous-tâche sur cinq n'a qu'une auto-attestation, l'ensemble ne vaut pas
 * `ci_signed` ; sinon il suffirait de noyer une pièce faible dans quatre pièces
 * vertes.
 *
 * Une sous-tâche **sans livrable approuvé** compte comme une preuve absente, pas
 * comme une preuve neutre : c'est le symptôme d'un découpage soumis trop tôt.
 *
 * ⚠️ Service **autonome** (Prisma + settings seulement), et pas une méthode de
 * `DeliverablesService` : celui-ci importe déjà `TasksService`, or c'est
 * `TasksService.submitForReview` qui a besoin de cette évaluation — l'y mettre
 * ferait un cycle de fichiers. La logique de décision reste la fonction PURE
 * `deriveVerificationFloor`, partagée avec le gate d'un livrable isolé.
 */
@Injectable()
export class SubtreeVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  /**
   * Évalue l'arbre d'un parent contre SON plancher (enjeu du projet × confiance
   * de l'acteur ∩ capacités de vérification du projet) — la politique réglée en
   * admin, jamais un choix de l'agent. Lecture pure : l'appelant décide de
   * bloquer (`enforce`) ou de journaliser (`report_only`).
   */
  async evaluate(orgId: string, parentTaskId: string, callerUserId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: parentTaskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        project: { select: { verificationCapabilities: true, stakes: true, verificationMode: true } },
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');

    const caller = await this.prisma.user.findUnique({
      where: { id: callerUserId },
      select: { trustLevel: true },
    });
    const caps = Array.isArray(task.project?.verificationCapabilities)
      ? (task.project!.verificationCapabilities as string[])
      : [];
    const req = deriveVerificationFloor(
      (task.project?.stakes ?? null) as TaskStakes | null,
      (caller?.trustLevel ?? null) as AgentTrust | null,
      caps,
    );
    const mode = await this.resolveMode(orgId, task.project?.verificationMode ?? null);

    const children = await this.prisma.task.findMany({
      where: { parentTaskId, organizationId: orgId, deletedAt: null },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
    if (!children.length) {
      return {
        hasChildren: false, requiredFloor: req.floor, mode,
        weakest: null, below: [] as { number: number; method: string }[],
        missing: [] as number[], satisfied: true,
      };
    }

    const approved = await this.prisma.deliverable.findMany({
      where: {
        taskId: { in: children.map((c) => c.id) },
        organizationId: orgId,
        reviewStatus: 'APPROVED',
        deletedAt: null,
      },
      select: { taskId: true, verification: true },
    });
    // Preuve la plus FORTE de chaque sous-tâche : elle a pu produire plusieurs
    // versions, on retient ce qu'elle a démontré de mieux.
    const bestByTask = new Map<string, string>();
    for (const d of approved) {
      const method = ((d.verification ?? null) as { method?: string } | null)?.method ?? 'self_attest';
      const prev = bestByTask.get(d.taskId);
      if (!prev || strength(method) > strength(prev)) bestByTask.set(d.taskId, method);
    }

    const floorStrength = strength(req.floor);
    const missing: number[] = [];
    const below: { number: number; method: string }[] = [];
    let weakest: string | null = null;
    let anyMissing = false;
    for (const c of children) {
      const method = bestByTask.get(c.id);
      if (!method) {
        missing.push(c.number);
        anyMissing = true;
        continue;
      }
      if (strength(method) < floorStrength) below.push({ number: c.number, method });
      if (weakest === null || strength(method) < strength(weakest)) weakest = method;
    }
    return {
      hasChildren: true,
      requiredFloor: req.floor,
      mode,
      /** Preuve la plus faible de l'arbre (`null` si une sous-tâche n'en a aucune). */
      weakest: anyMissing ? null : weakest,
      below,
      missing,
      satisfied: missing.length === 0 && below.length === 0,
    };
  }

  /** Mode effectif : override projet (phase D) sinon réglage org, fail-safe observation. */
  private async resolveMode(
    orgId: string,
    projectOverride: string | null,
  ): Promise<VerificationMode> {
    if (projectOverride === 'enforce' || projectOverride === 'report_only') {
      return projectOverride;
    }
    try {
      const all = await this.settings.getAll(orgId);
      if (all['agents.verification.mode'] === 'enforce') return 'enforce';
    } catch {
      /* fail-safe : report_only */
    }
    return 'report_only';
  }
}
