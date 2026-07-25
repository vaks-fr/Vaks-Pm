import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EVENTS } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { CreateColumnDto } from './dto/create-column.dto';
import { UpdateColumnDto } from './dto/update-column.dto';
import { ReorderColumnsDto } from './dto/reorder-columns.dto';

@Injectable()
export class BoardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
  ) {}

  /** Récupère le board principal du projet (ou crée-le s'il manque). */
  async getProjectBoard(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    let board = await this.prisma.board.findFirst({
      where: { projectId },
      include: { columns: { orderBy: { order: 'asc' } } },
    });
    if (!board) {
      board = await this.prisma.board.create({
        data: { projectId, name: 'Board principal' },
        include: { columns: { orderBy: { order: 'asc' } } },
      });
    }
    return board;
  }

  async createColumn(orgId: string, projectId: string, dto: CreateColumnDto) {
    const board = await this.getProjectBoard(orgId, projectId);
    const max = await this.prisma.boardColumn.aggregate({
      where: { boardId: board.id },
      _max: { order: true },
    });
    const column = await this.prisma.boardColumn.create({
      data: {
        boardId: board.id,
        name: dto.name,
        status: dto.status,
        wipLimit: dto.wipLimit ?? null,
        order: (max._max.order ?? 0) + 1,
      },
    });
    this.events.emitToProject(projectId, EVENTS.COLUMN_CREATED, column);
    return column;
  }

  async updateColumn(
    orgId: string,
    projectId: string,
    columnId: string,
    dto: UpdateColumnDto,
  ) {
    const column = await this.assertColumn(orgId, projectId, columnId);
    const updated = await this.prisma.boardColumn.update({
      where: { id: column.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.wipLimit !== undefined ? { wipLimit: dto.wipLimit } : {}),
      },
    });
    this.events.emitToProject(projectId, EVENTS.COLUMN_UPDATED, updated);
    return updated;
  }

  async deleteColumn(orgId: string, projectId: string, columnId: string) {
    const column = await this.assertColumn(orgId, projectId, columnId);
    const tasksInCol = await this.prisma.task.count({
      where: { boardColumnId: columnId, deletedAt: null },
    });
    if (tasksInCol > 0) {
      throw new BadRequestException(
        `Colonne non vide (${tasksInCol} tâche(s)) : déplace-les d'abord`,
      );
    }
    await this.prisma.boardColumn.delete({ where: { id: column.id } });
    this.events.emitToProject(projectId, EVENTS.COLUMN_DELETED, { id: columnId });
    return { id: columnId, name: column.name, deleted: true };
  }

  async reorderColumns(orgId: string, projectId: string, dto: ReorderColumnsDto) {
    const board = await this.getProjectBoard(orgId, projectId);
    const existing = await this.prisma.boardColumn.findMany({
      where: { boardId: board.id },
      select: { id: true },
    });
    const existingSet = new Set(existing.map((c) => c.id));
    if (
      dto.columnIds.length !== existing.length ||
      dto.columnIds.some((id) => !existingSet.has(id))
    ) {
      throw new BadRequestException(
        'columnIds doit contenir exactement toutes les colonnes du board',
      );
    }
    await this.prisma.$transaction(
      dto.columnIds.map((id, idx) =>
        this.prisma.boardColumn.update({ where: { id }, data: { order: idx + 1 } }),
      ),
    );
    this.events.emitToProject(projectId, EVENTS.COLUMNS_REORDERED, {
      boardId: board.id,
      columnIds: dto.columnIds,
    });
    return this.getProjectBoard(orgId, projectId);
  }

  // --------- helpers ---------

  private async assertProject(orgId: string, projectId: string) {
    // `kind: STANDARD` : pas de board (ni d'auto-création du board principal)
    // sur un conteneur de tickets externes — il n'existe pas pour le Kanban.
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null, kind: 'STANDARD' },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
  }

  private async assertColumn(orgId: string, projectId: string, columnId: string) {
    await this.assertProject(orgId, projectId);
    const c = await this.prisma.boardColumn.findFirst({
      where: { id: columnId, board: { projectId } },
    });
    if (!c) throw new NotFoundException('Colonne introuvable');
    return c;
  }
}
