import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { CustomStatusesService } from './custom-statuses.service';
import { CreateCustomStatusDto, UpdateCustomStatusDto } from './dto/custom-status.dto';

/**
 * Sous-statuts configurables (Custom Status). App-privé (pas de `@PublicApi`) :
 * feature d'UI, pas une surface d'intégration en v1. Catalogue org-global
 * uniquement (aucune route `:projectId`/`:taskId`) — write-gating dans le
 * service (setting `customStatuses.writeMode`). Les écritures SUR les tâches
 * (`subStatusId`) passent par les routes tasks existantes (update/move).
 */
@ApiTags('custom-statuses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('custom-statuses')
export class CustomStatusesController {
  constructor(private readonly svc: CustomStatusesService) {}

  /** Liste org ; `?projectId=` filtre aux sous-statuts applicables au projet. */
  @Get()
  @RequirePermissions('project:view')
  list(@CurrentUser() user: AuthUser, @Query('projectId') projectId?: string) {
    return this.svc.list(user.orgId, projectId || undefined);
  }

  @Get('capabilities')
  @RequirePermissions('project:view')
  async capabilities(@CurrentUser() user: AuthUser) {
    const canWrite = await this.svc.canWrite(user.orgId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
    return { canWrite };
  }

  @Post()
  @RequirePermissions('project:view')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomStatusDto) {
    return this.svc.create(user.orgId, dto, { userId: user.userId, isAdmin: user.isAdmin });
  }

  @Patch(':statusId')
  @RequirePermissions('project:view')
  update(
    @CurrentUser() user: AuthUser,
    @Param('statusId', ParseUUIDPipe) statusId: string,
    @Body() dto: UpdateCustomStatusDto,
  ) {
    return this.svc.update(user.orgId, statusId, dto, { userId: user.userId, isAdmin: user.isAdmin });
  }

  @Delete(':statusId')
  @RequirePermissions('project:view')
  remove(@CurrentUser() user: AuthUser, @Param('statusId', ParseUUIDPipe) statusId: string) {
    return this.svc.remove(user.orgId, statusId, { userId: user.userId, isAdmin: user.isAdmin });
  }
}
