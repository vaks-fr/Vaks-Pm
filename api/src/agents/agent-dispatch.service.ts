import { Injectable } from '@nestjs/common';
import { TaskStatus } from '@db';
import { AgentPolicyContext } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { PolicyEngineService } from './policy-engine.service';
import { RankedCandidate, compareCandidates } from './agent-dispatch.ranking';

/**
 * Dispatch « pull » des tâches aux agents (AGENTS_ARCHITECTURE.md chantier 4).
 * L'agent **tire** le travail : il demande sa meilleure tâche revendiquable et
 * la revendique, plutôt que d'être poussé par une affectation. C'est le pendant
 * inversé de `suggestAssignees` (skills.service) — au lieu de « quels users pour
 * cette tâche », c'est « quelle tâche pour cet acteur ».
 *
 * **Sélection** (pool factorisé, PAS de fallback org-wide) :
 *  1. tâches TODO d'un projet ACTIVE `kind=STANDARD` **agent-activé** dont
 *     l'acteur est membre (direct ou via équipe) ;
 *  2. prédécesseurs FS tous DONE (sinon la tâche n'est pas encore prête) ;
 *  3. skills requis ⊆ UserSkill de l'acteur (filtre **dur**) ;
 *  4. policies : `deny` (enforce) exclut la tâche ;
 *  5. tri : priorité desc → échéance proche → successeurs débloqués desc →
 *     score skill → FIFO (createdAt).
 *
 * **Capacité agent ≠ heures** : on ne passe JAMAIS par CapacityService /
 * WorkSchedule. Les budgets (concurrence, runs, coût), la backpressure et
 * l'allowlist modèles sont ré-appliqués **au claim** (`TasksService.claim`) —
 * `next-task` (GET) ne fait que suggérer sans effet de bord ; `next-task/claim`
 * (POST) tente les meilleurs candidats jusqu'au premier claim qui passe.
 */
@Injectable()
export class AgentDispatchService {
  /** Nombre de candidats tentés en boucle au claim (borne dure). */
  private readonly CLAIM_ATTEMPTS = 3;
  /** Plafond de candidats évalués (évite de balayer un très gros backlog). */
  private readonly SCAN_LIMIT = 400;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly policies: PolicyEngineService,
  ) {}

  /** Projets ACTIVE / STANDARD / agent-activés dont l'acteur est membre. */
  private async memberAgentProjectIds(orgId: string, userId: string): Promise<string[]> {
    const [direct, viaTeam] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: {
          userId,
          project: {
            organizationId: orgId, deletedAt: null,
            status: 'ACTIVE', kind: 'STANDARD', agentsEnabled: true,
          },
        },
        select: { projectId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: {
          project: {
            organizationId: orgId, deletedAt: null,
            status: 'ACTIVE', kind: 'STANDARD', agentsEnabled: true,
          },
          team: { members: { some: { userId } } },
        },
        select: { projectId: true },
      }),
    ]);
    const ids = new Set<string>();
    for (const m of direct) ids.add(m.projectId);
    for (const t of viaTeam) ids.add(t.projectId);
    return [...ids];
  }

  /**
   * Calcule la liste ordonnée des candidats revendiquables par l'acteur. Retourne
   * les candidats + un code `reason` expliquant un résultat vide.
   */
  private async rankCandidates(
    orgId: string,
    userId: string,
    actorKind: 'HUMAN' | 'AGENT',
  ): Promise<{ ranked: RankedCandidate[]; reason: string; evaluated: number }> {
    const projectIds = await this.memberAgentProjectIds(orgId, userId);
    if (projectIds.length === 0) return { ranked: [], reason: 'no_projects', evaluated: 0 };

    // Skills de l'acteur (niveau par skill) + trustLevel pour les policies +
    // enjeu par projet (chantier 3 : l'enjeu vit au niveau PROJET, hérité par
    // ses tâches) pour la dimension `scopeIn` des policies.
    const [caller, userSkills, projRows] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { trustLevel: true } }),
      this.prisma.userSkill.findMany({ where: { userId }, select: { skillId: true, level: true } }),
      this.prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, stakes: true } }),
    ]);
    const skillLevel = new Map<string, number>();
    for (const s of userSkills) skillLevel.set(s.skillId, s.level);
    const stakesByProject = new Map<string, string | null>();
    for (const p of projRows) stakesByProject.set(p.id, p.stakes);

    // Candidats bruts : tâches TODO des projets, hors milestones.
    const tasks = await this.prisma.task.findMany({
      where: {
        organizationId: orgId, deletedAt: null,
        projectId: { in: projectIds },
        status: TaskStatus.TODO,
        isMilestone: false,
      },
      select: {
        id: true, projectId: true, title: true, priority: true, dueDate: true,
        createdAt: true, estimateHours: true,
        requiredSkillId: true, requiredSkillLevel: true,
        labels: { select: { label: { select: { name: true } } } },
        requiredSkills: { select: { skillId: true, level: true } },
      },
      take: this.SCAN_LIMIT,
    });
    if (tasks.length === 0) return { ranked: [], reason: 'no_candidates', evaluated: 0 };

    const taskIds = tasks.map((t) => t.id);
    // Prédécesseurs FS + comptage des successeurs (valeur de déblocage), en lot.
    const [fsDeps, succCounts] = await Promise.all([
      this.prisma.taskDependency.findMany({
        where: { successorId: { in: taskIds }, type: 'FS' },
        select: { successorId: true, predecessorId: true },
      }),
      this.prisma.taskDependency.groupBy({
        by: ['predecessorId'],
        where: { predecessorId: { in: taskIds } },
        _count: { predecessorId: true },
      }),
    ]);
    const predsByTask = new Map<string, string[]>();
    for (const d of fsDeps) {
      const arr = predsByTask.get(d.successorId) ?? [];
      arr.push(d.predecessorId);
      predsByTask.set(d.successorId, arr);
    }
    const succCount = new Map<string, number>();
    for (const g of succCounts) succCount.set(g.predecessorId, g._count.predecessorId);

    // Statut des prédécesseurs FS (pour le gate « tous DONE »).
    const predIds = [...new Set(fsDeps.map((d) => d.predecessorId))];
    const predStatus = new Map<string, TaskStatus>();
    if (predIds.length) {
      const preds = await this.prisma.task.findMany({
        where: { id: { in: predIds } },
        select: { id: true, status: true },
      });
      for (const p of preds) predStatus.set(p.id, p.status);
    }

    let blocked = 0;
    let unqualified = 0;
    let denied = 0;
    const ranked: RankedCandidate[] = [];
    for (const t of tasks) {
      // 2. Prédécesseurs FS tous DONE.
      const preds = predsByTask.get(t.id) ?? [];
      if (preds.some((p) => predStatus.get(p) !== TaskStatus.DONE)) {
        blocked++;
        continue;
      }
      // 3. Skills requis ⊆ acteur (filtre dur) + score de match.
      const reqs: Array<{ skillId: string; level: number }> = [];
      if (t.requiredSkillId) reqs.push({ skillId: t.requiredSkillId, level: t.requiredSkillLevel ?? 1 });
      for (const r of t.requiredSkills) reqs.push({ skillId: r.skillId, level: r.level });
      let qualified = true;
      let skillScore = 0;
      for (const r of reqs) {
        const have = skillLevel.get(r.skillId) ?? 0;
        if (have < r.level) { qualified = false; break; }
        skillScore += Math.min(have, r.level);
      }
      if (!qualified) { unqualified++; continue; }

      // 4. Policies : deny (enforce) exclut.
      const ctx: AgentPolicyContext = {
        actorKind,
        trustLevel: (caller?.trustLevel ?? null) as AgentPolicyContext['trustLevel'],
        labels: t.labels.map((l) => l.label.name),
        scope: (stakesByProject.get(t.projectId) ?? null) as AgentPolicyContext['scope'],
        estimateHours: t.estimateHours != null ? Number(t.estimateHours) : null,
        transition: `${TaskStatus.TODO}->${TaskStatus.CLAIMED}`,
      };
      const pol = await this.policies.evaluate(orgId, ctx);
      if (pol.deny && pol.enforce) { denied++; continue; }

      ranked.push({
        id: t.id,
        projectId: t.projectId,
        title: t.title,
        priority: t.priority,
        dueDate: t.dueDate,
        stakes: stakesByProject.get(t.projectId) ?? null,
        skillScore,
        unblocks: succCount.get(t.id) ?? 0,
        createdAt: t.createdAt,
        requireReview: pol.requireReview,
      });
    }

    ranked.sort(compareCandidates);
    const reason =
      ranked.length > 0
        ? 'ok'
        : blocked > 0
          ? 'all_blocked'
          : unqualified > 0
            ? 'no_qualified'
            : denied > 0
              ? 'all_denied'
              : 'no_candidates';
    return { ranked, reason, evaluated: tasks.length };
  }

  /**
   * Classement complet des tâches revendiquables — exposé pour le **nudge à
   * capacité maîtrisée** (`AgentNudgeService.resumeAgent`), qui doit réveiller
   * un agent sur *plusieurs* tâches quand plusieurs slots se libèrent, là où
   * `preview` n'expose que la tête du classement.
   *
   * Lecture pure, aucun effet de bord — le claim reste la seule autorité.
   */
  async rankClaimable(orgId: string, userId: string, actorKind: 'HUMAN' | 'AGENT') {
    return this.rankCandidates(orgId, userId, actorKind);
  }

  /** GET /me/next-task — meilleure candidate (sans effet de bord). */
  async preview(orgId: string, userId: string, actorKind: 'HUMAN' | 'AGENT') {
    const { ranked, reason, evaluated } = await this.rankCandidates(orgId, userId, actorKind);
    const best = ranked[0] ?? null;
    return {
      task: best ? this.toSuggestion(best) : null,
      reason,
      evaluated,
      candidates: ranked.length,
    };
  }

  /**
   * POST /me/next-task/claim — sélection + claim atomique, en boucle bornée sur
   * les meilleurs candidats. Le claim ré-applique tous les garde-fous (budgets,
   * backpressure, allowlist modèles, matrice) ; on tente le suivant si l'un est
   * refusé (déjà pris entre-temps, budget épuisé…).
   */
  async claim(orgId: string, userId: string, actorKind: 'HUMAN' | 'AGENT') {
    const { ranked, reason } = await this.rankCandidates(orgId, userId, actorKind);
    if (ranked.length === 0) return { claimed: null, reason };

    let lastError: string | null = null;
    for (const cand of ranked.slice(0, this.CLAIM_ATTEMPTS)) {
      try {
        const claimed = await this.tasks.claim(orgId, cand.id, { userId, actorKind });
        return { claimed, reason: 'ok' };
      } catch (e) {
        // Conflit/refus (409/403) → on passe au candidat suivant. Une erreur de
        // budget/backpressure/allowlist est **terminale** pour cette passe : rien
        // ne sert d'insister, on la remonte.
        const resp = (e as { getResponse?: () => unknown }).getResponse?.();
        const code =
          resp && typeof resp === 'object' && 'code' in resp
            ? String((resp as { code: unknown }).code)
            : '';
        lastError = code || (e as Error).message;
        if (/^BUDGET_|^BACKPRESSURE$|^MODEL_NOT_ALLOWED$|^POLICY_DENIED$/.test(code)) {
          return { claimed: null, reason: code };
        }
        // sinon (ALREADY_CLAIMED, NOT_CLAIMABLE…) : tenter le suivant.
      }
    }
    return { claimed: null, reason: lastError ?? 'all_attempts_failed' };
  }

  private toSuggestion(c: RankedCandidate) {
    return {
      id: c.id,
      projectId: c.projectId,
      title: c.title,
      priority: c.priority,
      dueDate: c.dueDate ? c.dueDate.toISOString() : null,
      stakes: c.stakes,
      unblocks: c.unblocks,
      skillScore: c.skillScore,
      requireReview: c.requireReview,
    };
  }
}

