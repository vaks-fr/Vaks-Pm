import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { SearchExternalTasksDto, UpsertExternalTaskDto } from './dto/external-task.dto';

/**
 * Tickets d'outils de ticketing externes, loggables en timesheet UNIQUEMENT.
 *
 * Chaque ticket est une `Task` ordinaire (donc `TimeEntry` fonctionne sans
 * rien changer) rangée dans un projet conteneur `kind=EXTERNAL` auto-
 * provisionné par couple (outil × client). Ces projets sont invisibles dans
 * tous les menus (`ProjectsService.findAll` filtre `kind=STANDARD`), exclus
 * des reports et du workload, et n'acceptent ni board, ni allocation, ni
 * dépendance — la timesheet est leur seul point de contact.
 */
@Injectable()
export class ExternalTasksService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert idempotent d'un ticket sur l'unique `(org, source, key)` :
   * réappeler avec la même clé met à jour titre/URL et ré-assigne, jamais de
   * doublon. Le projet conteneur (source × client) est créé au premier ticket.
   */
  async upsert(
    orgId: string,
    caller: { userId: string },
    dto: UpsertExternalTaskDto,
  ) {
    const client = dto.clientId
      ? await this.prisma.client.findFirst({
          where: { id: dto.clientId, organizationId: orgId, deletedAt: null },
          select: { id: true, name: true },
        })
      : null;
    if (dto.clientId && !client) throw new NotFoundException('Client introuvable');

    // Cible de l'assignation : l'appelant par défaut (cas UI « logger sur un
    // ticket »), ou l'utilisateur désigné par email (cas push machine).
    let assigneeId = caller.userId;
    if (dto.assigneeEmail) {
      const target = await this.prisma.user.findFirst({
        where: {
          organizationId: orgId,
          email: dto.assigneeEmail.toLowerCase(),
          deletedAt: null,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (!target) {
        throw new BadRequestException(`Aucun utilisateur actif avec l'email ${dto.assigneeEmail}`);
      }
      assigneeId = target.id;
    }

    const project = await this.ensureContainerProject(orgId, dto.source, client);

    const title = dto.title?.trim() || dto.key;
    const task = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.task.findUnique({
        where: {
          organizationId_externalSource_externalKey: {
            organizationId: orgId,
            externalSource: dto.source,
            externalKey: dto.key,
          },
        },
        select: { id: true },
      });
      if (existing) {
        return tx.task.update({
          where: { id: existing.id },
          data: {
            title,
            externalUrl: dto.url ?? undefined,
            deletedAt: null, // ré-upserter un ticket supprimé le ressuscite
          },
          select: TASK_SELECT,
        });
      }
      // Même sérialisation du `number` séquentiel que `TasksService.create`.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${project.id}))`;
      const agg = await tx.task.aggregate({
        where: { projectId: project.id },
        _max: { number: true },
      });
      return tx.task.create({
        data: {
          organizationId: orgId,
          projectId: project.id,
          number: (agg._max.number ?? 0) + 1,
          title,
          status: 'TODO',
          externalSource: dto.source,
          externalKey: dto.key,
          externalUrl: dto.url ?? null,
          createdById: caller.userId,
        },
        select: TASK_SELECT,
      });
    });

    // Assignation idempotente : fait apparaître le ticket dans les
    // `addableTasks` de la timesheet de l'utilisateur visé.
    await this.prisma.taskAssignee.upsert({
      where: { taskId_userId: { taskId: task.id, userId: assigneeId } },
      create: { taskId: task.id, userId: assigneeId },
      update: {},
    });

    return this.toDto(task);
  }

  /** Recherche de tickets existants (picker timesheet) par clé ou titre. */
  async search(orgId: string, q: SearchExternalTasksDto) {
    const where: Prisma.TaskWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      externalKey: { not: null },
      project: { kind: 'EXTERNAL', deletedAt: null },
    };
    if (q.source) where.externalSource = q.source.trim().toLowerCase();
    if (q.q) {
      where.OR = [
        { externalKey: { contains: q.q, mode: 'insensitive' } },
        { title: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    const tasks = await this.prisma.task.findMany({
      where,
      select: TASK_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: q.limit ?? 20,
    });
    return tasks.map((t) => this.toDto(t));
  }

  /**
   * Trouve ou crée le projet conteneur du couple (source × client). Création
   * concurrente possible (deux pushes simultanés) : on retombe sur le
   * `findFirst` si l'unique `(org, clientId, name)` claque.
   */
  private async ensureContainerProject(
    orgId: string,
    source: string,
    client: { id: string; name: string } | null,
  ) {
    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      kind: 'EXTERNAL',
      externalSource: source,
      clientId: client?.id ?? null,
      deletedAt: null,
    };
    const found = await this.prisma.project.findFirst({ where, select: PROJECT_SELECT });
    if (found) return found;

    const label = source.charAt(0).toUpperCase() + source.slice(1);
    const keyBase = source.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'EXT';
    const clientKey = client
      ? client.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
      : '';
    try {
      return await this.prisma.project.create({
        data: {
          organizationId: orgId,
          kind: 'EXTERNAL',
          externalSource: source,
          clientId: client?.id ?? null,
          key: clientKey ? `${keyBase}-${clientKey}` : keyBase,
          name: client ? `${label} — ${client.name}` : `${label} (tickets)`,
          status: 'ACTIVE',
          billable: false,
        },
        select: PROJECT_SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.project.findFirst({ where, select: PROJECT_SELECT });
        if (again) return again;
      }
      throw e;
    }
  }

  private toDto(t: Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>) {
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      externalSource: t.externalSource,
      externalKey: t.externalKey,
      externalUrl: t.externalUrl,
      projectId: t.project.id,
      projectKey: t.project.key,
      projectName: t.project.name,
      clientId: t.project.clientId,
    };
  }
}

const TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  externalSource: true,
  externalKey: true,
  externalUrl: true,
  project: { select: { id: true, key: true, name: true, clientId: true } },
} satisfies Prisma.TaskSelect;

const PROJECT_SELECT = {
  id: true,
  key: true,
  name: true,
  clientId: true,
} satisfies Prisma.ProjectSelect;
