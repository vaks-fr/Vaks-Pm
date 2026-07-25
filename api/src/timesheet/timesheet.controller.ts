import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { TimesheetService } from './timesheet.service';
import { TimesheetQueryDto } from './dto/timesheet.dto';

@ApiTags('timesheet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller()
export class TimesheetController {
  constructor(private readonly svc: TimesheetService) {}

  /** Timesheet d'un utilisateur sur [from, to] : capacité, allocations,
   *  time entries agrégées par jour. `userId` par défaut = soi-même (scope
   *  `time:log` requis). */
  @Get('timesheet')
  @RequirePermissions('time:log')
  get(@CurrentUser() user: AuthUser, @Query() query: TimesheetQueryDto) {
    return this.svc.getTimesheet(user.orgId, user.userId, query);
  }
}
