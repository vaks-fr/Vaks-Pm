import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../storage/s3.service';
import {
  validateDocxTemplate,
  CHARTER_TEMPLATE_KEYS,
} from '../projects/charter-docx';
import { CLIENT_STATUS_TEMPLATE_KEYS, validateStatusDeckTemplate } from '../reports/status-deck';

const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
const TEMPLATE_KINDS = ['CHARTER', 'CLIENT_STATUS_PPTX'] as const;
type TemplateKind = (typeof TEMPLATE_KINDS)[number];

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** MIME attendu par type de template (le validateur docxtemplater lit aussi bien
 *  un .docx qu'un .pptx — c'est le même conteneur OOXML). */
const KIND_MIME: Record<TemplateKind, string> = {
  CHARTER: DOCX_MIME,
  CLIENT_STATUS_PPTX: PPTX_MIME,
};
const KIND_EXT: Record<TemplateKind, string> = {
  CHARTER: '.docx',
  CLIENT_STATUS_PPTX: '.pptx',
};
const KIND_KEYS: Record<TemplateKind, readonly string[]> = {
  CHARTER: CHARTER_TEMPLATE_KEYS,
  CLIENT_STATUS_PPTX: CLIENT_STATUS_TEMPLATE_KEYS,
};

@ApiTags('admin/document-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/document-templates')
export class DocumentTemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  @Get()
  @RequirePermissions('org:manage')
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.organizationDocumentTemplate.findMany({
      where: { organizationId: user.orgId },
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { kind: 'asc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  @Post(':kind')
  @RequirePermissions('org:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: TEMPLATE_MAX_BYTES } }))
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('kind') kindRaw: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const kind = this.parseKind(kindRaw);
    if (!file) throw new BadRequestException('Fichier manquant (champ "file")');
    if (file.mimetype !== KIND_MIME[kind]) {
      throw new BadRequestException(
        `MIME non autorisé (${file.mimetype}). Attendu : ${KIND_EXT[kind]}`,
      );
    }
    // Validation docxtemplater : rejette un template cassé (zip invalide ou
    // balise non fermée) AVANT de l'enregistrer. Le validateur ouvre un .docx
    // comme un .pptx (conteneur OOXML) ; le kind PPTX utilise un validateur
    // qui charge le module image (sinon les tags `{%chart}` cassent le parse).
    // Les tags inconnus du modèle sont remontés comme avertissement non bloquant.
    const validation =
      kind === 'CLIENT_STATUS_PPTX'
        ? validateStatusDeckTemplate(file.buffer)
        : validateDocxTemplate(file.buffer, KIND_KEYS[kind]);
    if (!validation.ok) {
      throw new BadRequestException(
        `Template invalide : ${validation.error}. Vérifie que chaque balise {placeholder} est bien fermée.`,
      );
    }
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    const storageKey = `${user.orgId}/${kind.toLowerCase()}/${Date.now()}_${safeName}`;
    await this.s3.putObject(
      this.s3.buckets.templates,
      storageKey,
      file.buffer,
      file.mimetype,
    );
    // Supprimer l'ancien blob s'il existe.
    const previous = await this.prisma.organizationDocumentTemplate.findUnique({
      where: { organizationId_kind: { organizationId: user.orgId, kind } },
    });
    if (previous) {
      await this.s3
        .removeObject(this.s3.buckets.templates, previous.storageKey)
        .catch(() => {});
    }
    const row = await this.prisma.organizationDocumentTemplate.upsert({
      where: { organizationId_kind: { organizationId: user.orgId, kind } },
      create: {
        organizationId: user.orgId,
        kind,
        storageKey,
        filename: safeName,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedById: user.userId,
      },
      update: {
        storageKey,
        filename: safeName,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedById: user.userId,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    return {
      ...this.serialize(row),
      // Avertissement non bloquant : tags inconnus = fautes de frappe probables.
      unknownTags: validation.unknownTags,
    };
  }

  @Get(':kind/file')
  @RequirePermissions('org:manage')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('kind') kindRaw: string,
    @Res() res: Response,
  ) {
    const kind = this.parseKind(kindRaw);
    const row = await this.prisma.organizationDocumentTemplate.findUnique({
      where: { organizationId_kind: { organizationId: user.orgId, kind } },
    });
    if (!row) throw new NotFoundException('Aucun template uploadé');
    const buffer = await this.s3.getObjectBuffer(this.s3.buckets.templates, row.storageKey);
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }

  @Delete(':kind')
  @RequirePermissions('org:manage')
  async reset(@CurrentUser() user: AuthUser, @Param('kind') kindRaw: string) {
    const kind = this.parseKind(kindRaw);
    const row = await this.prisma.organizationDocumentTemplate.findUnique({
      where: { organizationId_kind: { organizationId: user.orgId, kind } },
    });
    if (!row) return { kind, removed: false };
    await this.s3
      .removeObject(this.s3.buckets.templates, row.storageKey)
      .catch(() => {});
    await this.prisma.organizationDocumentTemplate.delete({
      where: { organizationId_kind: { organizationId: user.orgId, kind } },
    });
    return { kind, removed: true };
  }

  private parseKind(raw: string): TemplateKind {
    const k = raw.toUpperCase();
    if (!TEMPLATE_KINDS.includes(k as TemplateKind)) {
      throw new BadRequestException(
        `kind invalide. Attendu : ${TEMPLATE_KINDS.join(', ')}`,
      );
    }
    return k as TemplateKind;
  }

  private serialize(row: {
    organizationId: string;
    kind: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: Date;
    updatedAt: Date;
    uploadedBy: { id: string; name: string } | null;
  }) {
    return {
      kind: row.kind,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      uploadedAt: row.uploadedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      uploadedBy: row.uploadedBy,
    };
  }
}
