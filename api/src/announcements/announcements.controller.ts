import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';

/**
 * Annonces projet. `@PublicApi` : atteignable par PAT (flux humain-via-MCP,
 * tool `vaks_notify_stakeholders`) ; les principals AGENT sont refusés dans le
 * service. Gating `comment:create` = « peut écrire des communications sur le
 * projet » (contributeur et au-dessus — pas les viewers/guests), membership
 * exigée par `@ProjectAccess`.
 */
@ApiTags('announcements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@PublicApi()
@Controller('projects/:projectId/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @RequirePermissions('comment:create')
  @ProjectAccess(fromProjectParam('projectId'))
  @SkipAudit() // audit explicite dans le service (détail audience/destinataires)
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateAnnouncementDto,
    @Req() req: Request,
  ) {
    // Attribution « via l'assistant » dérivée du header posé par le serveur
    // MCP (X-Vaks-Agent) — informative, jamais un vecteur de droits.
    const viaAssistant = Boolean(req.headers['x-vaks-agent']);
    return this.announcements.create(user.orgId, projectId, user, dto, viaAssistant);
  }

  @Get()
  @RequirePermissions('project:view')
  @ProjectAccess(fromProjectParam('projectId'))
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number.parseInt(limit, 10) : 50;
    return this.announcements.list(user.orgId, projectId, Number.isFinite(n) ? n : 50);
  }
}
