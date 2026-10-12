import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { WorkloadService } from '../workload/workload.service';
import { buildVCalendar, IcsEvent } from './ics.util';

const TOKEN_PREFIX = 'ics_';
const MAX_COLLISION_RETRY = 5;

/**
 * Flux ICS personnel (slice C du calendrier — cf. `project_calendar_view`).
 * Deux surfaces distinctes s'appuient sur ce service :
 *  - `CalendarFeedController` (PUBLIC, non-JWT) : résout le token → rend le
 *    VCALENDAR. Aucune notion de session ici, seulement le token opaque.
 *  - `CalendarSubscriptionController` (JWT, self-only) : gère le cycle de vie
 *    du token pour l'utilisateur courant (générer/régénérer/révoquer).
 *
 * Isolation stricte : le token identifie UN SEUL user, et les deux helpers de
 * lecture (`tasksForUserCalendar`, `allocationsForUserCalendar`) sont
 * bornés à ce `userId` — aucune donnée d'autrui ne peut transiter par ce flux.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly workload: WorkloadService,
  ) {}

  /**
   * Résout le token vers son propriétaire puis rend le VCALENDAR. `null` si
   * le token est inconnu/révoqué/l'user supprimé — le contrôleur répond alors
   * 404 sans distinguer les cas (pas d'oracle sur la validité d'un token).
   */
  async renderIcs(token: string): Promise<string | null> {
    if (!token) return null;
    const user = await this.prisma.user.findFirst({
      // status: 'ACTIVE' — un compte SUSPENDU (offboarding en cours, ou compte
      // compromis suspendu) a son login interactif coupé (auth.service.ts) ; sans
      // ce filtre, son flux ICS resterait servi sur l'URL publique non authentifiée,
      // contournant la suspension de compte. Self-data only, mais on respecte la porte.
      where: { icsToken: token, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, organizationId: true },
    });
    if (!user) return null;

    const [tasks, allocations] = await Promise.all([
      this.tasks.tasksForUserCalendar(user.organizationId, user.id),
      this.workload.allocationsForUserCalendar(user.organizationId, user.id),
    ]);

    const events: IcsEvent[] = [];
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const projectLabel = t.project ? `${t.project.key} — ${t.project.name}` : null;
      events.push({
        uid: `task-${t.id}@vaks-pm`,
        summary: projectLabel ? `[${t.project!.key}] ${t.title}` : t.title,
        description: [projectLabel, `Priorité : ${t.priority}`, `Statut : ${t.status}`]
          .filter(Boolean)
          .join('\n'),
        startDate: t.dueDate,
      });
    }
    for (const a of allocations) {
      const projectLabel = a.project ? `${a.project.key} — ${a.project.name}` : null;
      const taskTitle = a.task?.title ?? null;
      const summary = taskTitle
        ? `Allocation : ${taskTitle}`
        : `Allocation${projectLabel ? ` — ${projectLabel}` : ''}`;
      // Allocation.endDate est inclusive côté modèle métier ; DTEND iCal est
      // exclusif → +1 jour pour couvrir le dernier jour de l'allocation.
      const endExclusive = new Date(a.endDate);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      events.push({
        uid: `alloc-${a.id}@vaks-pm`,
        summary,
        description: [projectLabel, a.notes ? `Notes : ${a.notes}` : null, `${a.hoursPerDay} h/j`]
          .filter(Boolean)
          .join('\n'),
        startDate: a.startDate,
        endDateExclusive: endExclusive,
      });
    }

    return buildVCalendar(events);
  }

  /** État du flux pour l'utilisateur courant — jamais le token d'un autre. */
  async getStatus(orgId: string, userId: string): Promise<{ enabled: boolean; token: string | null }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: { icsToken: true },
    });
    return { enabled: !!user?.icsToken, token: user?.icsToken ?? null };
  }

  /**
   * (Re)génère le token. Idempotent côté appelant : peut être appelé qu'un
   * abonnement existe déjà ou non (régénération = invalide l'ancienne URL,
   * comportement volontaire — cf. confirmation UI avant l'appel).
   */
  async regenerate(orgId: string, userId: string): Promise<{ token: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_COLLISION_RETRY; attempt++) {
      const token = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
      try {
        // `orgId` n'entre pas dans le `where` : comme partout ailleurs sur les
        // routes `/me/*`, `userId` provient déjà du JWT de CET utilisateur —
        // il ne peut désigner un compte d'une autre organisation.
        await this.prisma.user.update({
          where: { id: userId },
          data: { icsToken: token },
        });
        return { token };
      } catch (err) {
        // Collision sur la contrainte @unique — improbable (30 octets
        // aléatoires) mais on retente plutôt que d'échouer l'utilisateur.
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('icsToken generation failed');
  }

  async revoke(orgId: string, userId: string): Promise<{ revoked: true }> {
    // Même remarque que `regenerate` : `userId` vient du JWT de l'appelant,
    // `orgId` n'a pas besoin d'entrer dans le `where`.
    await this.prisma.user.update({
      where: { id: userId },
      data: { icsToken: null },
    });
    return { revoked: true };
  }
}
