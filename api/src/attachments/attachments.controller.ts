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
import { contentDisposition } from '../common/content-disposition.util';

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

    // Défense-en-profondeur ceinture-et-bretelles contre la confusion de MIME :
    // le download force déjà Content-Disposition: attachment + X-Content-Type-Options: nosniff,
    // donc on ne rejette JAMAIS un upload sur la base de ce sniff (zéro faux positif visé).
    // On se contente, quand la signature d'octets contredit franchement le type déclaré,
    // de neutraliser le Content-Type stocké (S3 + DB) en le retombant sur octet-stream.
    const declaredMime = file.mimetype || 'application/octet-stream';
    const sniffed = this.sniffMime(file.buffer);
    const effectiveMime = this.isMimeMismatch(declaredMime, sniffed)
      ? 'application/octet-stream'
      : declaredMime;

    await this.s3.putObject(
      this.s3.buckets.attachments,
      storageKey,
      file.buffer,
      effectiveMime,
    );

    const created = await this.prisma.attachment.create({
      data: {
        organizationId: user.orgId,
        taskId,
        uploaderId: user.userId,
        storageKey,
        filename: file.originalname.slice(0, 255),
        mimeType: effectiveMime,
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
    res.setHeader('Content-Disposition', contentDisposition(row.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
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

  /**
   * Détecte le type réel d'un fichier à partir de ses premiers octets (magic bytes).
   * Retourne une famille générique ('pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip')
   * ou `null` si la signature n'est pas reconnue — dans ce cas on ne force jamais rien
   * (type inconnu = on fait confiance au déclaré).
   */
  private sniffMime(buf: Buffer): string | null {
    if (!buf || buf.length < 4) return null;

    // %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return 'pdf';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return 'png';
    }

    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'jpeg';
    }

    // GIF: "GIF8"
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
      return 'gif';
    }

    // WEBP: "RIFF"....."WEBP"
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return 'webp';
    }

    // ZIP / OOXML (docx, xlsx, pptx, jar, odt…) / conteneurs PK : PK\x03\x04, PK\x05\x06, PK\x07\x08
    if (
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
      (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
    ) {
      return 'zip';
    }

    return null;
  }

  /**
   * Détermine si le type déclaré (`declared`, ex. `file.mimetype`) contredit franchement
   * la famille sniffée. Regroupe par famille (ex. tous les conteneurs OOXML/zip/jar/odt
   * sont acceptés face à un sniff 'zip') pour éviter tout faux positif : en cas de doute,
   * on considère qu'il n'y a PAS de mismatch.
   */
  private isMimeMismatch(declared: string, sniffed: string | null): boolean {
    if (!sniffed) return false; // signature inconnue : on ne force jamais rien

    const d = (declared || '').toLowerCase();

    switch (sniffed) {
      case 'pdf':
        return d !== 'application/pdf';
      case 'png':
        return d !== 'image/png';
      case 'jpeg':
        return d !== 'image/jpeg' && d !== 'image/jpg';
      case 'gif':
        return d !== 'image/gif';
      case 'webp':
        return d !== 'image/webp';
      case 'zip':
        // Conteneur PK : zip brut, jar, odt/ods/odp, et toute la famille OOXML
        // (docx/xlsx/pptx = application/vnd.openxmlformats-officedocument.*).
        return !(
          d === 'application/zip' ||
          d === 'application/x-zip-compressed' ||
          d === 'application/java-archive' ||
          d.startsWith('application/vnd.openxmlformats-officedocument') ||
          d.startsWith('application/vnd.oasis.opendocument')
        );
      default:
        return false;
    }
  }
}
