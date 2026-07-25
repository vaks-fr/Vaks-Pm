import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromTaskParam, fromAttachmentParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import { EventsGateway } from '../realtime/events.gateway';
import { Audited } from '../audit-logs/audited.decorator';

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB / fichier

@ApiTags('attachments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromTaskParam('taskId'), fromAttachmentParam('id'))
@PublicApi()
@Controller()
export class AttachmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly events: EventsGateway,
  ) {}

  @Get('tasks/:taskId/attachments')
  @RequirePermissions('task:view')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    await this.assertTask(user.orgId, taskId);
    const rows = await this.prisma.attachment.findMany({
      where: { taskId, organizationId: user.orgId, deletedAt: null },
      include: { uploader: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  @Post('tasks/:taskId/attachments')
  @RequirePermissions('attachment:manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES } }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Fichier manquant (champ "file")');
    const task = await this.assertTask(user.orgId, taskId);

    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    const storageKey = `org/${user.orgId}/task/${taskId}/${randomUUID()}-${safeName}`;
    await this.s3.putObject(
      this.s3.buckets.attachments,
      storageKey,
      file.buffer,
      file.mimetype || 'application/octet-stream',
    );

    const created = await this.prisma.attachment.create({
      data: {
        organizationId: user.orgId,
        taskId,
        uploaderId: user.userId,
        storageKey,
        filename: file.originalname.slice(0, 255),
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: file.size,
      },
      include: { uploader: { select: { id: true, name: true, email: true } } },
    });

    const dto = this.serialize(created);
    this.events.emitToProject(task.projectId, 'attachment.created', dto);
    return dto;
  }

  @Get('attachments/:id/download')
  @RequirePermissions('task:view')
  @Audited('attachment.downloaded', { resource: 'attachment' })
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const row = await this.prisma.attachment.findFirst({
      where: { id, organizationId: user.orgId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Pièce jointe introuvable');
    const buffer = await this.s3.getObjectBuffer(
      this.s3.buckets.attachments,
      row.storageKey,
    );
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${row.filename.replace(/"/g, '')}"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }

  @Delete('attachments/:id')
  @RequirePermissions('attachment:manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.prisma.attachment.findFirst({
      where: { id, organizationId: user.orgId, deletedAt: null },
      include: { task: { select: { projectId: true } } },
    });
    if (!row) throw new NotFoundException('Pièce jointe introuvable');
    if (!user.isAdmin && row.uploaderId !== user.userId) {
      throw new ForbiddenException('Tu ne peux supprimer que tes propres pièces jointes');
    }
    await this.s3
      .removeObject(this.s3.buckets.attachments, row.storageKey)
      .catch(() => {});
    await this.prisma.attachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    this.events.emitToProject(row.task.projectId, 'attachment.deleted', {
      id,
      taskId: row.taskId,
    });
    return { id, filename: row.filename, deleted: true };
  }

  // ---- Helpers ----

  private async assertTask(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    return task;
  }

  private serialize(a: {
    id: string;
    taskId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
    uploader: { id: string; name: string; email: string };
  }) {
    return {
      id: a.id,
      taskId: a.taskId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      uploader: a.uploader,
      createdAt: a.createdAt.toISOString(),
      downloadUrl: `/api/attachments/${a.id}/download`,
    };
  }
}
