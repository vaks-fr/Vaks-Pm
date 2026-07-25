import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@db';
import { EVENTS } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { CreateLabelDto, UpdateLabelDto } from './dto/label.dto';

@Injectable()
export class LabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
  ) {}

  async list(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    return this.prisma.label.findMany({ where: { projectId }, orderBy: { name: 'asc' } });
  }

  async create(orgId: string, projectId: string, dto: CreateLabelDto) {
    await this.assertProject(orgId, projectId);
    try {
      const label = await this.prisma.label.create({
        data: { projectId, name: dto.name, color: dto.color ?? '#6b7280' },
      });
      this.events.emitToProject(projectId, EVENTS.LABEL_CREATED, label);
      return label;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un label avec ce nom existe déjà');
      }
      throw e;
    }
  }

  async update(orgId: string, projectId: string, labelId: string, dto: UpdateLabelDto) {
    await this.assertLabel(orgId, projectId, labelId);
    try {
      const label = await this.prisma.label.update({
        where: { id: labelId },
        data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.color !== undefined ? { color: dto.color } : {}) },
      });
      this.events.emitToProject(projectId, EVENTS.LABEL_UPDATED, label);
      return label;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un label avec ce nom existe déjà');
      }
      throw e;
    }
  }

  async remove(orgId: string, projectId: string, labelId: string) {
    const label = await this.assertLabel(orgId, projectId, labelId);
    await this.prisma.label.delete({ where: { id: labelId } });
    this.events.emitToProject(projectId, EVENTS.LABEL_DELETED, { id: labelId });
    return { id: labelId, name: label.name, deleted: true };
  }

  private async assertProject(orgId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
  }

  private async assertLabel(orgId: string, projectId: string, labelId: string) {
    await this.assertProject(orgId, projectId);
    const l = await this.prisma.label.findFirst({ where: { id: labelId, projectId } });
    if (!l) throw new NotFoundException('Label introuvable');
    return l;
  }
}
