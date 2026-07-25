import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkillRequestStatus } from '@db';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkillRequestsService } from './skill-requests.service';
import {
  CreateSkillRequestDto,
  UpdateSkillRequestStatusDto,
} from './dto/skill-request.dto';

@ApiTags('skill-requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller('skill-requests')
export class SkillRequestsController {
  constructor(private readonly svc: SkillRequestsService) {}

  @Post()
  @RequirePermissions('project:view')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSkillRequestDto) {
    return this.svc.create(user.orgId, { userId: user.userId, isAdmin: user.isAdmin }, dto);
  }

  @Get()
  @RequirePermissions('project:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query('box') box?: 'mine' | 'inbox' | 'all',
    @Query('status') status?: SkillRequestStatus,
  ) {
    return this.svc.list(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      box,
      status,
    );
  }

  /** Compteurs par statut pour les demandes émises par l'appelant. */
  @Get('mine/summary')
  @RequirePermissions('project:view')
  mineSummary(@CurrentUser() user: AuthUser) {
    return this.svc.summaryForRequester(user.orgId, user.userId);
  }

  @Patch(':id/status')
  @RequirePermissions('project:view')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkillRequestStatusDto,
  ) {
    return this.svc.updateStatus(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      id,
      dto,
    );
  }
}
