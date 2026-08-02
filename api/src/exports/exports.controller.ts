import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { PublicApi } from '../rbac/require-permissions.decorator';
import { ExportsService } from './exports.service';
import type { ExportKind } from './export-job.store';

/**
 * Exports asynchrones : on lance, on interroge, on télécharge.
 *
 * Les routes **synchrones** existantes (`report.pdf`, `*.xlsx`, `/me/export`)
 * sont inchangées — l'UI web en dépend et n'a aucune raison de migrer. Ce
 * chemin est purement additif, pour les appelants qui ne peuvent pas tenir une
 * connexion ouverte le temps d'un rendu : au premier rang, les clients IA.
 */
@ApiTags('exports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('exports')
export class ExportsController {
  constructor(private readonly svc: ExportsService) {}

  /** Lance un export. Répond immédiatement un identifiant de job. */
  @Post()
  @PublicApi()
  async start(
    @CurrentUser() user: AuthUser,
    @Body() body: { kind: ExportKind; params?: Record<string, unknown> },
  ) {
    return this.svc.start(user.orgId, user.userId, body?.kind, body?.params ?? {});
  }

  /** État d'avancement. `DONE` ⇒ l'artefact est téléchargeable. */
  @Get(':id')
  @PublicApi()
  async status(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const rec = await this.svc.status(id, user.orgId, user.userId);
    return {
      jobId: rec.id,
      kind: rec.kind,
      status: rec.status,
      bytes: rec.bytes ?? null,
      error: rec.error ?? null,
      downloadUrl: rec.status === 'DONE' ? `/api/v1/exports/${rec.id}/download` : null,
    };
  }

  /**
   * Téléchargement, servi **par l'API** et donc soumis au contrôle d'accès —
   * pas une URL S3 pré-signée. Accepté aussi bien en session navigateur qu'avec
   * un jeton, pour que l'agent puisse transmettre le lien à l'humain *et* aller
   * chercher le fichier lui-même.
   */
  @Get(':id/download')
  @PublicApi()
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const { buffer, rec } = await this.svc.download(id, user.orgId, user.userId);
    res.setHeader('Content-Type', rec.contentType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${rec.kind}-${rec.id}.json"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }
}
