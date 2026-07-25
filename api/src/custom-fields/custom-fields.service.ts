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
  CUSTOM_FIELD_TYPES,
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  UpsertCustomFieldValuesDto,
} from './dto/custom-field.dto';
import { cleanOptions, optionsError, valueError } from './custom-field-rules';

export interface CallerCtx {
  userId: string;
  isAdmin: boolean;
}

type FieldType = (typeof CUSTOM_FIELD_TYPES)[number];
type EntityType = 'task' | 'project';

/**
 * Champs personnalisés — définitions par l'org + valeurs par entité. Modèle EAV
 * calqué sur le catalogue de skills (`SkillsService`) : write-policy
 * configurable, soft-delete + détachement transactionnel, valeurs posées via
 * deleteMany+createMany.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  // ============================================================
  // Write-policy (calque skills.catalogWriteMode)
  // ============================================================

  async canWrite(orgId: string, caller: CallerCtx): Promise<boolean> {
    if (caller.isAdmin) return true;
    const mode = await this.settings.getCustomFieldsWriteMode(orgId);
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
        "L'organisation n'autorise pas votre rôle à modifier les champs personnalisés.",
      );
    }
  }

  // ============================================================
  // Définitions (catalogue org)
  // ============================================================

  private toDefDto(d: {
    id: string;
    entityType: string;
    name: string;
    type: string;
    options: string[];
    order: number;
    createdAt: Date;
    updatedAt: Date;
    projects?: { projectId: string }[];
  }) {
    return {
      id: d.id,
      entityType: d.entityType as EntityType,
      name: d.name,
      type: d.type as FieldType,
      options: d.options,
      order: d.order,
      projectIds: (d.projects ?? []).map((p) => p.projectId),
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  async list(orgId: string, entityType?: string) {
    const defs = await this.prisma.customFieldDefinition.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        ...(entityType === 'task' || entityType === 'project' ? { entityType } : {}),
      },
      include: { projects: { select: { projectId: true } } },
      orderBy: [{ entityType: 'asc' }, { order: 'asc' }, { name: 'asc' }],
    });
    return defs.map((d) => this.toDefDto(d));
  }

  async create(orgId: string, dto: CreateCustomFieldDto, caller: CallerCtx) {
    await this.assertCanWrite(orgId, caller);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Nom requis');
    this.assertOptionsForType(dto.type, dto.options);
    // Unicité case-insensitive (la contrainte Prisma est case-sensitive).
    const dup = await this.prisma.customFieldDefinition.findFirst({
      where: {
        organizationId: orgId,
        entityType: dto.entityType,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { name: true },
    });
    if (dup) throw new ConflictException(`Un champ « ${dup.name} » existe déjà pour cette entité.`);

    const projectIds = await this.validProjectIds(orgId, dto.projectIds);
    try {
      const created = await this.prisma.customFieldDefinition.create({
        data: {
          organizationId: orgId,
          entityType: dto.entityType,
          name,
          type: dto.type,
          options: dto.type === 'select' ? cleanOptions(dto.options) : [],
          order: dto.order ?? 0,
          projects: projectIds.length ? { create: projectIds.map((projectId) => ({ projectId })) } : undefined,
        },
        include: { projects: { select: { projectId: true } } },
      });
      return this.toDefDto(created);
    } catch (e) {
      // Filet : la contrainte unique (org, entityType, name) est case-sensitive
      // et couvre d'éventuelles lignes historiques → 409 clair plutôt qu'un 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Un champ « ${name} » existe déjà pour cette entité.`);
      }
      throw e;
    }
  }

  async update(orgId: string, fieldId: string, dto: UpdateCustomFieldDto, caller: CallerCtx) {
    await this.assertCanWrite(orgId, caller);
    const existing = await this.prisma.customFieldDefinition.findFirst({
      where: { id: fieldId, organizationId: orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Champ introuvable');

    // Le TYPE et l'ENTITÉ sont immuables : changer le type d'un champ déjà
    // rempli invaliderait les valeurs existantes. Pour changer, on supprime et
    // on recrée (choix assumé, évite des migrations de valeurs hasardeuses).
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Nom requis');
      const dup = await this.prisma.customFieldDefinition.findFirst({
        where: {
          organizationId: orgId,
          entityType: existing.entityType,
          deletedAt: null,
          id: { not: fieldId },
          name: { equals: name, mode: 'insensitive' },
        },
        select: { name: true },
      });
      if (dup) throw new ConflictException(`Un champ « ${dup.name} » existe déjà pour cette entité.`);
    }
    if (dto.options !== undefined) {
      this.assertOptionsForType(existing.type, dto.options);
    }

    const data: Prisma.CustomFieldDefinitionUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.options !== undefined && existing.type === 'select') {
      data.options = cleanOptions(dto.options);
    }

    // Restriction projet remplacée en bloc si fournie.
    if (dto.projectIds !== undefined) {
      const projectIds = await this.validProjectIds(orgId, dto.projectIds);
      await this.prisma.$transaction([
        this.prisma.customFieldProject.deleteMany({ where: { fieldId } }),
        ...(projectIds.length
          ? [this.prisma.customFieldProject.createMany({ data: projectIds.map((projectId) => ({ fieldId, projectId })) })]
          : []),
      ]);
    }

    const updated = await this.prisma.customFieldDefinition.update({
      where: { id: fieldId },
      data,
      include: { projects: { select: { projectId: true } } },
    });
    return this.toDefDto(updated);
  }

  async remove(orgId: string, fieldId: string, caller: CallerCtx): Promise<{ removed: true }> {
    await this.assertCanWrite(orgId, caller);
    const existing = await this.prisma.customFieldDefinition.findFirst({
      where: { id: fieldId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Champ introuvable');
    // Hard-delete : une définition de champ n'a pas d'historique à conserver, et
    // la garder en soft-delete réserverait son nom (la contrainte unique
    // (org, entityType, name) n'exclut pas les lignes supprimées → recréer le
    // même nom échouerait). Les relations `onDelete: Cascade` sur les valeurs et
    // les restrictions projet nettoient tout automatiquement.
    await this.prisma.customFieldDefinition.delete({ where: { id: fieldId } });
    return { removed: true };
  }

  // ============================================================
  // Valeurs par entité
  // ============================================================

  /** Définitions applicables à une entité (pas de restriction, ou entité ∈ restrictions). */
  private applicableWhere(orgId: string, entityType: EntityType, projectId: string) {
    return {
      organizationId: orgId,
      entityType,
      deletedAt: null,
      OR: [{ projects: { none: {} } }, { projects: { some: { projectId } } }],
    } satisfies Prisma.CustomFieldDefinitionWhereInput;
  }

  async getTaskValues(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    return this.mergeValues(
      await this.prisma.customFieldDefinition.findMany({
        where: this.applicableWhere(orgId, 'task', task.projectId),
        include: { projects: { select: { projectId: true } } },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
      }),
      await this.prisma.taskCustomFieldValue.findMany({ where: { taskId }, select: { fieldId: true, value: true } }),
    );
  }

  async getProjectValues(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    return this.mergeValues(
      await this.prisma.customFieldDefinition.findMany({
        where: this.applicableWhere(orgId, 'project', projectId),
        include: { projects: { select: { projectId: true } } },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
      }),
      await this.prisma.projectCustomFieldValue.findMany({ where: { projectId }, select: { fieldId: true, value: true } }),
    );
  }

  private mergeValues(
    defs: Parameters<CustomFieldsService['toDefDto']>[0][],
    values: { fieldId: string; value: string }[],
  ) {
    const byField = new Map(values.map((v) => [v.fieldId, v.value]));
    return defs.map((d) => ({
      fieldId: d.id,
      value: byField.get(d.id) ?? null,
      definition: this.toDefDto(d),
    }));
  }

  async setTaskValues(orgId: string, taskId: string, dto: UpsertCustomFieldValuesDto) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    const applicable = await this.loadApplicable(orgId, 'task', task.projectId);
    const rows = this.validateValues(dto, applicable);
    await this.prisma.$transaction([
      this.prisma.taskCustomFieldValue.deleteMany({
        where: { taskId, fieldId: { in: dto.values.map((v) => v.fieldId) } },
      }),
      ...(rows.length
        ? [this.prisma.taskCustomFieldValue.createMany({ data: rows.map((r) => ({ taskId, fieldId: r.fieldId, value: r.value })) })]
        : []),
    ]);
    return this.getTaskValues(orgId, taskId);
  }

  async setProjectValues(orgId: string, projectId: string, dto: UpsertCustomFieldValuesDto) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    const applicable = await this.loadApplicable(orgId, 'project', projectId);
    const rows = this.validateValues(dto, applicable);
    await this.prisma.$transaction([
      this.prisma.projectCustomFieldValue.deleteMany({
        where: { projectId, fieldId: { in: dto.values.map((v) => v.fieldId) } },
      }),
      ...(rows.length
        ? [this.prisma.projectCustomFieldValue.createMany({ data: rows.map((r) => ({ projectId, fieldId: r.fieldId, value: r.value })) })]
        : []),
    ]);
    return this.getProjectValues(orgId, projectId);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async loadApplicable(orgId: string, entityType: EntityType, projectId: string) {
    const defs = await this.prisma.customFieldDefinition.findMany({
      where: this.applicableWhere(orgId, entityType, projectId),
      select: { id: true, type: true, options: true },
    });
    return new Map(defs.map((d) => [d.id, d]));
  }

  /**
   * Filtre + valide les valeurs entrantes : ignore les champs non applicables
   * (défense contre un fieldId d'un autre projet), garde la valeur non vide,
   * et vérifie la cohérence par type. Une valeur vide n'est pas conservée
   * (le deleteMany l'a déjà retirée).
   */
  private validateValues(
    dto: UpsertCustomFieldValuesDto,
    applicable: Map<string, { type: string; options: string[] }>,
  ): Array<{ fieldId: string; value: string }> {
    const out: Array<{ fieldId: string; value: string }> = [];
    for (const item of dto.values) {
      const def = applicable.get(item.fieldId);
      if (!def) continue; // champ non applicable à cette entité → ignoré
      const value = item.value.trim();
      if (value === '') continue; // suppression (déjà couverte par le deleteMany)
      const err = valueError(def.type as FieldType, def.options, value);
      if (err) throw new BadRequestException(err);
      out.push({ fieldId: item.fieldId, value });
    }
    return out;
  }

  private assertOptionsForType(type: string, options?: string[]): void {
    const err = optionsError(type, options);
    if (err) throw new BadRequestException(err);
  }

  /** Garde uniquement les projectIds réels de l'org (anti-injection d'ids étrangers). */
  private async validProjectIds(orgId: string, projectIds?: string[]): Promise<string[]> {
    if (!projectIds || projectIds.length === 0) return [];
    const uniq = [...new Set(projectIds)];
    const found = await this.prisma.project.findMany({
      where: { id: { in: uniq }, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    return found.map((p) => p.id);
  }
}
