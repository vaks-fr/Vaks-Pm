import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { evaluateTransition, TransitionActor, TransitionVerdict } from './task-transitions';

/**
 * Arbitre les transitions de statut (AGENTS_ARCHITECTURE.md chantier 2). Enveloppe
 * la matrice pure `evaluateTransition` et décide quoi faire d'un verdict de refus :
 *
 *  - **Mode observation** (défaut) : on JOURNALISE le refus (log + audit WARNING
 *    `task.transition.observed`) mais on **laisse passer**. Sert à prouver, sur le
 *    trafic humain réel, qu'aucun flux légitime n'est faussement refusé AVANT
 *    d'activer le blocage.
 *  - **Mode enforce** (setting org `agents.transitions.enforce=true`) : un refus
 *    lève une `ConflictException` (409) → l'écriture n'a pas lieu.
 *
 * Le flag est mis en cache 30 s par org (les transitions sont fréquentes en
 * drag-drop ; on évite une lecture settings par mouvement).
 */
@Injectable()
export class TaskTransitionService {
  private readonly log = new Logger(TaskTransitionService.name);
  private readonly enforceCache = new Map<string, { value: boolean; expires: number }>();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly settings: AdminSettingsService,
    private readonly audit: AuditLogService,
  ) {}

  private async enforceEnabled(orgId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.enforceCache.get(orgId);
    if (hit && hit.expires > now) return hit.value;
    let value = false;
    try {
      const all = await this.settings.getAll(orgId);
      value = all['agents.transitions.enforce'] === true;
    } catch {
      value = false; // fail-open : jamais bloquer sur une panne de lecture settings
    }
    this.enforceCache.set(orgId, { value, expires: now + this.CACHE_TTL_MS });
    return value;
  }

  /**
   * Vérifie une transition. Ne fait rien si `from === to` ou si autorisée. Sinon :
   * throw en mode enforce, observe (audit WARNING) en mode observation.
   */
  async check(params: {
    orgId: string;
    projectId: string;
    taskId: string;
    /** Valeurs de statut (chaînes) — indépendant du type TaskStatus Prisma/shared. */
    from: string;
    to: string;
    actor: TransitionActor;
    actorUserId?: string | null;
    autoClose?: boolean;
  }): Promise<void> {
    const { orgId, from, to, actor } = params;
    if (from === to) return;

    const verdict: TransitionVerdict = evaluateTransition(from, to, actor, {
      autoClose: params.autoClose,
    });
    if (verdict.allowed) return;

    const enforce = await this.enforceEnabled(orgId);
    // Audit (fire-and-forget) : trace la transition refusée, avec le mode appliqué.
    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.TASK_TRANSITION_OBSERVED,
      severity: 'WARNING',
      actorType: actor.kind === 'AGENT' ? 'AGENT' : 'USER',
      actorId: params.actorUserId ?? null,
      resourceType: 'task',
      resourceId: params.taskId,
      detail: {
        projectId: params.projectId,
        from,
        to,
        code: verdict.code,
        actorKind: actor.kind,
        mode: enforce ? 'enforce' : 'observe',
      },
    });

    if (enforce) {
      throw new ConflictException({
        code: 'TRANSITION_NOT_ALLOWED',
        message: `Transition de statut refusée (${from} → ${to}).`,
        reason: verdict.code,
      });
    }
    // Observation : on laisse passer, mais on trace côté serveur pour diagnostic.
    this.log.warn(
      `[transitions] observe-only: ${from}->${to} refusé (${verdict.code}) ` +
        `task=${params.taskId} actor=${actor.kind} org=${orgId}`,
    );
  }
}
