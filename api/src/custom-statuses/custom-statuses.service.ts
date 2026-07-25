import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import {
  CreateCustomStatusDto,
  SUB_STATUS_PARENTS,
  SubStatusParent,
  UpdateCustomStatusDto,
} from './dto/custom-status.dto';

export interface CallerCtx {
  userId: string;
  isAdmin: boolean;
}

/**
 * Sous-statuts configurables (Custom Status) — catalogue org + restriction
 * projet, calqué sur les champs personnalisés (`CustomFieldsService`) :
 * write-policy configurable, HARD delete (le soft réserverait le nom dans
 * l'unique → P2002) avec fallback des tâches sur le statut parent.
 */
@Injectable()
export class CustomStatusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  // ============================================================
  // Write-policy (calque custom-fields)
  // ============================================================

  async canWrite(orgId: string, caller: CallerCtx): Promise<boolean> {
    if (caller.isAdmin) return true;
    const mode = await this.settings.getCustomStatusesWriteMode(orgId);
    if (mode === 'admin') return false;
    if (mode === 'everyone') return true;
    if (mode === 'portfolio_manager') {
      const m = await this.prisma.membership.findFirst({
        where: { organizationId: orgId, userId: caller.userId },
        select: { role: { select: { key: true } } },
      });
      return m?.role.key === 'PORTFOLIO_MANAGER';
    }
    if (mode === 'team_lead') {
      const m = await this.prisma.membership.findFirst({
        where: { organizationId: orgId, userId: caller.userId },
        select: { role: { select: { key: true } } },
      });
      if (m?.role.key === 'PORTFOLIO_MANAGER') return true;
      const lead = await this.prisma.teamMember.findFirst({
        where: { userId: caller.userId, isLead: true, team: { organizationId: orgId, deletedAt: null } },
        select: { teamId: true },
      });
      return !!lead;
    }
    return false;
  }

  private async assertCanWrite(orgId: string, caller: CallerCtx) {
    if (!(await this.canWrite(orgId, caller))) {
      throw new ForbiddenException(
        "L'organisation n'autorise pas votre rôle à modifier les sous-statuts.",
      );
    }
  }

  // ============================================================
  // Catalogue org
  // ============================================================

  private toDto(s: {
    id: string;
    parentStatus: string;
    name: string;
    color: string | null;
    order: number;
    notifyUserIds: string[];
    notifyTeamIds: string[];
    createdAt: Date;
    updatedAt: Date;
    projects?: { projectId: string }[];
  }) {
    return {
      id: s.id,
      parentStatus: s.parentStatus as SubStatusParent,
      name: s.name,
      color: s.color,
      order: s.order,
      projectIds: (s.projects ?? []).map((p) => p.projectId),
      notifyUserIds: s.notifyUserIds,
      notifyTeamIds: s.notifyTeamIds,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  /** Liste org ; si `projectId` fourni, seulement les sous-statuts applicables
   *  à ce projet (pas de restriction OU projet ∈ restrictions). */
  async list(orgId: string, projectId?: string) {
    const statuses = await this.prisma.customStatus.findMany({
      where: {
        organizationId: orgId,
        ...(projectId
          ? { OR: [{ projects: { none: {} } }, { projects: { some: { projectId } } }] }
          : {}),
      },
      include: { projects: { select: { projectId: true } } },
      orderBy: [{ parentStatus: 'asc' }, { order: 'asc' }, { name: 'asc' }],
    });
    return statuses.map((s) => this.toDto(s));
  }

  async create(orgId: string, dto: CreateCustomStatusDto, caller: CallerCtx) {
    await this.assertCanWrite(orgId, caller);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Nom requis');
    if (!SUB_STATUS_PARENTS.includes(dto.parentStatus)) {
      throw new BadRequestException('Statut parent non subdivisable.');
    }
    // Unicité case-insensitive (la contrainte Prisma est case-sensitive).
    const dup = await this.prisma.customStatus.findFirst({
      where: { organizationId: orgId, name: { equals: name, mode: 'insensitive' } },
      select: { name: true },
    });
    if (dup) throw new ConflictException(`Un sous-statut « ${dup.name} » existe déjà.`);

    const projectIds = await this.validProjectIds(orgId, dto.projectIds);
    const notifyUserIds = await this.validUserIds(orgId, dto.notifyUserIds);
    const notifyTeamIds = await this.validTeamIds(orgId, dto.notifyTeamIds);
    try {
      const created = await this.prisma.customStatus.create({
        data: {
          organizationId: orgId,
          parentStatus: dto.parentStatus,
          name,
          color: dto.color?.trim() || null,
          order: dto.order ?? 0,
          notifyUserIds,
          notifyTeamIds,
          projects: projectIds.length ? { create: projectIds.map((projectId) => ({ projectId })) } : undefined,
        },
        include: { projects: { select: { projectId: true } } },
      });
      return this.toDto(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Un sous-statut « ${name} » existe déjà.`);
      }
      throw e;
    }
  }

  async update(orgId: string, statusId: string, dto: UpdateCustomStatusDto, caller: CallerCtx) {
    await this.assertCanWrite(orgId, caller);
    const existing = await this.prisma.customStatus.findFirst({
      where: { id: statusId, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Sous-statut introuvable');

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Nom requis');
      const dup = await this.prisma.customStatus.findFirst({
        where: {
          organizationId: orgId,
          id: { not: statusId },
          name: { equals: name, mode: 'insensitive' },
        },
        select: { name: true },
      });
      if (dup) throw new ConflictException(`Un sous-statut « ${dup.name} » existe déjà.`);
    }

    const data: Prisma.CustomStatusUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.color !== undefined) data.color = dto.color?.trim() || null;
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.notifyUserIds !== undefined) data.notifyUserIds = await this.validUserIds(orgId, dto.notifyUserIds);
    if (dto.notifyTeamIds !== undefined) data.notifyTeamIds = await this.validTeamIds(orgId, dto.notifyTeamIds);

    // Restriction projet remplacée en bloc si fournie.
    if (dto.projectIds !== undefined) {
      const projectIds = await this.validProjectIds(orgId, dto.projectIds);
      await this.prisma.$transaction([
        this.prisma.customStatusProject.deleteMany({ where: { statusId } }),
        ...(projectIds.length
          ? [this.prisma.customStatusProject.createMany({ data: projectIds.map((projectId) => ({ statusId, projectId })) })]
          : []),
      ]);
    }

    try {
      const updated = await this.prisma.customStatus.update({
        where: { id: statusId },
        data,
        include: { projects: { select: { projectId: true } } },
      });
      return this.toDto(updated);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Un sous-statut « ${dto.name?.trim() ?? '' } » existe déjà.`);
      }
      throw e;
    }
  }

  async remove(orgId: string, statusId: string, caller: CallerCtx): Promise<{ removed: true }> {
    await this.assertCanWrite(orgId, caller);
    const existing = await this.prisma.customStatus.findFirst({
      where: { id: statusId, organizationId: orgId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Sous-statut introuvable');
    // HARD delete + fallback : les tâches qui portaient ce sous-statut
    // retombent sur leur statut parent (Task.status, inchangé). La cascade
    // nettoie les restrictions projet.
    await this.prisma.$transaction([
      this.prisma.task.updateMany({ where: { subStatusId: statusId }, data: { subStatusId: null } }),
      this.prisma.customStatus.delete({ where: { id: statusId } }),
    ]);
    return { removed: true };
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Garde uniquement les projectIds réels de l'org (anti-injection). */
  private async validProjectIds(orgId: string, projectIds?: string[]): Promise<string[]> {
    if (!projectIds || projectIds.length === 0) return [];
    const uniq = [...new Set(projectIds)];
    const found = await this.prisma.project.findMany({
      where: { id: { in: uniq }, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    return found.map((p) => p.id);
  }

  /** Users notifiables : humains actifs, membres de l'org (anti-injection). */
  private async validUserIds(orgId: string, userIds?: string[]): Promise<string[]> {
    if (!userIds || userIds.length === 0) return [];
    const uniq = [...new Set(userIds)];
    const found = await this.prisma.user.findMany({
      where: {
        id: { in: uniq },
        kind: 'HUMAN',
        deletedAt: null,
        memberships: { some: { organizationId: orgId } },
      },
      select: { id: true },
    });
    return found.map((u) => u.id);
  }

  /** Équipes notifiables : équipes de l'org non supprimées (anti-injection). */
  private async validTeamIds(orgId: string, teamIds?: string[]): Promise<string[]> {
    if (!teamIds || teamIds.length === 0) return [];
    const uniq = [...new Set(teamIds)];
    const found = await this.prisma.team.findMany({
      where: { id: { in: uniq }, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    return found.map((t) => t.id);
  }
}
