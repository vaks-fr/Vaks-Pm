import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { AdminSettingsService } from './admin-settings.service';

/**
 * **Data Management** (Admin panel) — purge du soft-delete + export org.
 *
 * Périmètre de purge validé « étendu » : entités feuilles soft-deleted
 * (Skill, Comment, Attachment, Contact, ProjectExpense, AgentProjectRate,
 * Team) **plus** les Tâches et Projets soft-deleted, en démontant leurs
 * dépendants **non-cascade** avant la suppression (le reste part par les
 * `onDelete: Cascade` du schéma).
 *
 * ⚠️ EXCLUS par design :
 *  - `User` : jamais hard-delete (temps/finance/audit agrègent sur la FK) —
 *    voir la voie RGPD `UsersService.anonymize` (pseudonymisation).
 *  - `Client` : ancre des projets ; non couvert par « étendu ».
 *
 * Non-cascade connus (schéma) démontés à la main :
 *  - Task ← Attachment, TaskAssignee, Task.parent (self-FK subtasks)
 *  - Project ← Task, ProjectMember, Board, Label, Allocation(project-level)
 *  - Skill ← Task.requiredSkill (nullable)
 * Tout le reste (TimeEntry, Comment, TaskLabel/Skill/Dependency, ProjectRate,
 * ProjectTeam/Skill, TeamMember…) casse en cascade DB.
 *
 * Les objets S3 des pièces jointes sont supprimés **après** commit DB
 * (best-effort : on n'orpheline jamais un blob dont la ligne survit).
 */
@Injectable()
export class DataManagementService {
  private readonly log = new Logger(DataManagementService.name);

  /**
   * Modèles feuilles soft-deletables purgés « tels quels » (cascade DB).
   * NB : `AgentProjectRate` n'a PAS de `deletedAt` (couvert par la cascade
   * projet) → hors liste.
   */
  private static readonly LEAF_MODELS = ['comment', 'contact', 'projectExpense', 'team'] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly settings: AdminSettingsService,
  ) {}

  /**
   * Compte les enregistrements soft-deleted purgeables (aperçu avant purge).
   * `olderThan` optionnel = ne compter que ce qui dépasse le délai de grâce.
   */
  async purgeStats(
    orgId: string,
    olderThan?: Date,
  ): Promise<{ total: number; byType: Record<string, number> }> {
    const where = this.softDeletedWhere(orgId, olderThan);
    const models: Array<{ key: string; model: string }> = [
      { key: 'skill', model: 'skill' },
      { key: 'comment', model: 'comment' },
      { key: 'attachment', model: 'attachment' },
      { key: 'contact', model: 'contact' },
      { key: 'projectExpense', model: 'projectExpense' },
      { key: 'team', model: 'team' },
      { key: 'task', model: 'task' },
      { key: 'project', model: 'project' },
    ];
    const byType: Record<string, number> = {};
    let total = 0;
    for (const m of models) {
      const n = await (this.prisma as never as Record<string, { count: (a: unknown) => Promise<number> }>)[
        m.model
      ].count({ where });
      if (n > 0) {
        byType[m.key] = n;
        total += n;
      }
    }
    return { total, byType };
  }

  /**
   * Purge définitive. `olderThan` non fourni = purge TOUT le soft-delete
   * (« Purge now » manuel) ; fourni = seulement au-delà du délai (cron).
   * Retourne le décompte par type effectivement supprimé.
   */
  async purge(
    orgId: string,
    olderThan?: Date,
  ): Promise<{ total: number; byType: Record<string, number> }> {
    const where = this.softDeletedWhere(orgId, olderThan);
    const byType: Record<string, number> = {};
    const s3Keys: string[] = [];

    await this.prisma.$transaction(
      async (tx) => {
        const t = tx as never as PrismaService;

        // 1. Projets soft-deleted d'abord (emporte toutes leurs tâches en bloc).
        const projects = await t.project.findMany({ where, select: { id: true } });
        if (projects.length) {
          const keys = await this.hardDeleteProjects(t, orgId, projects.map((p) => p.id));
          s3Keys.push(...keys);
          byType.project = projects.length;
        }

        // 2. Tâches soft-deleted restantes (dans des projets non purgés).
        const tasks = await t.task.findMany({ where, select: { id: true } });
        if (tasks.length) {
          const keys = await this.hardDeleteTasks(t, orgId, tasks.map((x) => x.id));
          s3Keys.push(...keys);
          byType.task = tasks.length;
        }

        // 3. Pièces jointes feuilles soft-deleted (hors tâches déjà purgées).
        const atts = await t.attachment.findMany({ where, select: { id: true, storageKey: true } });
        if (atts.length) {
          s3Keys.push(...atts.map((a) => a.storageKey));
          await t.attachment.deleteMany({ where: { id: { in: atts.map((a) => a.id) } } });
          byType.attachment = atts.length;
        }

        // 4. Skills soft-deleted : détacher la FK non-cascade Task.requiredSkill.
        const skills = await t.skill.findMany({ where, select: { id: true } });
        if (skills.length) {
          const ids = skills.map((s) => s.id);
          await t.task.updateMany({
            where: { organizationId: orgId, requiredSkillId: { in: ids } },
            data: { requiredSkillId: null },
          });
          await t.skill.deleteMany({ where: { id: { in: ids } } });
          byType.skill = skills.length;
        }

        // 5. Feuilles pures (cascade DB propre).
        for (const model of DataManagementService.LEAF_MODELS) {
          const n = await (
            t as never as Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }>
          )[model].deleteMany({ where });
          if (n.count > 0) byType[model] = n.count;
        }
      },
      { timeout: 120_000, maxWait: 15_000 },
    );

    // Suppression S3 APRÈS commit (best-effort — un échec n'orpheline pas la DB).
    let s3Removed = 0;
    for (const key of s3Keys) {
      try {
        await this.s3.removeObject(this.s3.buckets.attachments, key);
        s3Removed++;
      } catch (err) {
        this.log.warn(`S3 remove failed key=${key}: ${(err as Error).message}`);
      }
    }

    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    if (total > 0) {
      this.log.log(
        `purge org=${orgId} total=${total} s3=${s3Removed}/${s3Keys.length} ${JSON.stringify(byType)}`,
      );
    }
    return { total, byType };
  }

  // ============================================================
  // Helpers de démontage (dans la transaction)
  // ============================================================

  /** Filtre soft-deleted (`deletedAt` non-null, optionnellement < olderThan). */
  private softDeletedWhere(orgId: string, olderThan?: Date) {
    return {
      organizationId: orgId,
      deletedAt: olderThan ? { lt: olderThan } : { not: null },
    };
  }

  /**
   * Hard-delete d'un lot de tâches (démonte les FK non-cascade puis cascade
   * TimeEntry/Allocation/Comment/TaskLabel/TaskSkill/TaskDependency).
   * Retourne les clés S3 des pièces jointes à effacer post-commit.
   */
  private async hardDeleteTasks(
    tx: PrismaService,
    orgId: string,
    taskIds: string[],
  ): Promise<string[]> {
    if (!taskIds.length) return [];
    const atts = await tx.attachment.findMany({
      where: { organizationId: orgId, taskId: { in: taskIds } },
      select: { id: true, storageKey: true },
    });
    if (atts.length) {
      await tx.attachment.deleteMany({ where: { id: { in: atts.map((a) => a.id) } } });
    }
    await tx.taskAssignee.deleteMany({ where: { taskId: { in: taskIds } } });
    // Sous-tâches pointant vers une tâche purgée mais HORS du lot : on orpheline
    // (parentTaskId → null) plutôt que de les supprimer en cascade non voulue.
    await tx.task.updateMany({
      where: { organizationId: orgId, parentTaskId: { in: taskIds }, id: { notIn: taskIds } },
      data: { parentTaskId: null },
    });
    await tx.task.deleteMany({ where: { id: { in: taskIds } } });
    return atts.map((a) => a.storageKey);
  }

  /**
   * Hard-delete d'un lot de projets (emporte TOUTES leurs tâches, même non
   * soft-deleted — le projet entier est effacé), démonte les FK non-cascade,
   * puis cascade ProjectRate/Expense/Team/Skill/Charter/Document.
   */
  private async hardDeleteProjects(
    tx: PrismaService,
    orgId: string,
    projectIds: string[],
  ): Promise<string[]> {
    if (!projectIds.length) return [];
    const tasks = await tx.task.findMany({
      where: { organizationId: orgId, projectId: { in: projectIds } },
      select: { id: true },
    });
    const s3Keys = await this.hardDeleteTasks(tx, orgId, tasks.map((t) => t.id));
    await tx.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.label.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.allocation.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.board.deleteMany({ where: { projectId: { in: projectIds } } });
    await tx.project.deleteMany({ where: { id: { in: projectIds } } });
    return s3Keys;
  }

  // ============================================================
  // Export org (RGPD — portabilité, Art. 20)
  // ============================================================

  /**
   * Export machine-lisible de l'organisation (JSON). Secrets exclus
   * (mots de passe, MFA, tokens, valeurs `…Enc`). Métadonnées de pièces
   * jointes seulement (pas les binaires). Destiné au téléchargement admin.
   */
  async exportOrg(orgId: string): Promise<Record<string, unknown>> {
    const [organization, settings] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true, createdAt: true },
      }),
      this.settings.getAllForAdmin(orgId),
    ]);

    const [users, clients, contacts, projects, tasks, timeEntries, allocations, comments, teams, skills, attachments] =
      await Promise.all([
        this.prisma.user.findMany({
          where: { organizationId: orgId },
          select: {
            id: true, email: true, name: true, kind: true, status: true, isAdmin: true,
            timezone: true, countryCode: true, preferredLanguage: true,
            employeeId: true, authProvider: true, idpSource: true, licensed: true,
            createdAt: true, updatedAt: true,
          },
        }),
        this.prisma.client.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, name: true, createdAt: true },
        }),
        this.prisma.contact.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, clientId: true, name: true, email: true, phone: true, title: true },
        }),
        this.prisma.project.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: {
            id: true, name: true, kind: true, status: true, clientId: true,
            startDate: true, dueDate: true, createdAt: true, updatedAt: true,
          },
        }),
        this.prisma.task.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: {
            id: true, projectId: true, title: true, status: true, priority: true,
            startDate: true, dueDate: true, estimateHours: true, isMilestone: true,
            createdAt: true, updatedAt: true,
          },
        }),
        this.prisma.timeEntry.findMany({
          where: { organizationId: orgId },
          select: {
            id: true, taskId: true, userId: true, date: true, durationMinutes: true,
            overtimeMinutes: true, description: true, createdAt: true,
          },
        }),
        this.prisma.allocation.findMany({
          where: { organizationId: orgId },
          select: {
            id: true, taskId: true, projectId: true, userId: true, startDate: true,
            endDate: true, hoursPerDay: true,
          },
        }),
        this.prisma.comment.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, taskId: true, authorId: true, body: true, createdAt: true },
        }),
        this.prisma.team.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, name: true, createdAt: true },
        }),
        this.prisma.skill.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: { id: true, name: true, category: true },
        }),
        this.prisma.attachment.findMany({
          where: { organizationId: orgId, deletedAt: null },
          select: {
            id: true, taskId: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true,
          },
        }),
      ]);

    return {
      exportedAt: new Date().toISOString(),
      organization,
      settings,
      counts: {
        users: users.length, clients: clients.length, contacts: contacts.length,
        projects: projects.length, tasks: tasks.length, timeEntries: timeEntries.length,
        allocations: allocations.length, comments: comments.length, teams: teams.length,
        skills: skills.length, attachments: attachments.length,
      },
      users, clients, contacts, projects, tasks, timeEntries, allocations, comments, teams, skills,
      attachments,
    };
  }
}
