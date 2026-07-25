import {
  BadRequestException,
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
import { UserStatus } from '@db';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Annuaire des utilisateurs de l'org. Accessible à tous les membres : nécessaire
   * pour les dropdowns d'assignation (tâches, allocations, project managers…).
   * La gestion (création, edition, suspension) reste réservée à `member:manage`.
   */
  @Get()
  @PublicApi()
  @RequirePermissions('project:view')
  findAll(@CurrentUser() user: AuthUser, @Query('includeAgents') includeAgents?: string) {
    // `includeAgents=1` : opt-in des pickers d'affectation (équipes, projets) —
    // un agent IA y est éligible « comme un humain ». Défaut : humains only.
    return this.users.findAllInOrg(user.orgId, { includeAgents: includeAgents === '1' });
  }

  /**
   * Annuaire admin paginé (search/status/role) + schedules batchés. Route
   * app-privée (pas `@PublicApi`) — réservée au panneau admin. Lecture au niveau
   * `member:manage` (gestion des comptes).
   */
  @Get('directory')
  @RequirePermissions('member:manage')
  directory(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('role') role?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('includeSchedule') includeSchedule?: string,
  ) {
    const st =
      status === 'ACTIVE'
        ? UserStatus.ACTIVE
        : status === 'SUSPENDED'
          ? UserStatus.SUSPENDED
          : undefined;
    return this.users.findDirectory(user.orgId, {
      search,
      status: st,
      role: role || undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      includeSchedule: includeSchedule !== '0' && includeSchedule !== 'false',
    });
  }

  @Post()
  @RequirePermissions('member:manage')
  @SkipAudit() // hook explicite `user.created` dans UsersService
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(user.orgId, dto, {
      isAdmin: !!user.isAdmin,
      id: user.userId,
      email: user.email,
    });
  }

  /**
   * Import CSV. `commit` absent/false = dry-run (prévisualisation, aucune
   * écriture). `commit: true` crée les comptes valides.
   */
  @Post('import')
  @RequirePermissions('member:manage')
  importCsv(
    @CurrentUser() user: AuthUser,
    @Body() body: { csv?: string; commit?: boolean },
  ) {
    if (!body || typeof body.csv !== 'string') {
      throw new BadRequestException('csv (string) requis');
    }
    return this.users.importUsers(user.orgId, body.csv, body.commit === true, {
      isAdmin: !!user.isAdmin,
    });
  }

  @Patch(':userId')
  @RequirePermissions('member:manage')
  update(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(user.orgId, id, dto, {
      isAdmin: !!user.isAdmin,
      id: user.userId,
      email: user.email,
    });
  }

  /**
   * Déverrouille un compte bloqué par le lockout anti-brute-force
   * (`lockedUntil`). App-privé, `member:manage`. Audit `user.unlocked` posé
   * par le service.
   */
  @Post(':userId/unlock')
  @RequirePermissions('member:manage')
  @SkipAudit() // hook explicite `user.unlocked` dans UsersService
  unlock(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) id: string,
  ) {
    return this.users.unlock(user.orgId, id, {
      isAdmin: !!user.isAdmin,
      id: user.userId,
      email: user.email,
    });
  }

  @Delete(':userId')
  @RequirePermissions('member:manage')
  @SkipAudit() // hook explicite `user.deleted` dans UsersService
  remove(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) id: string,
  ) {
    return this.users.softDelete(user.orgId, id, user.userId);
  }

  /**
   * **RGPD — anonymisation (droit à l'effacement).** Pseudonymise
   * irréversiblement l'utilisateur (aucune suppression de ligne). App-privé,
   * `member:manage`. Audit `user.anonymized` posé par le service.
   */
  @Post(':userId/anonymize')
  @RequirePermissions('member:manage')
  @SkipAudit() // hook explicite `user.anonymized` dans UsersService
  anonymize(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) id: string,
  ) {
    return this.users.anonymize(user.orgId, id, {
      isAdmin: !!user.isAdmin,
      id: user.userId,
      email: user.email,
    });
  }

  /**
   * **RGPD — portabilité (variante admin).** Export JSON des données d'un
   * utilisateur, pour traiter une demande d'accès en son nom. App-privé,
   * `member:manage`. Audité `user.data_exported`.
   */
  @Get(':userId/export')
  @RequirePermissions('member:manage')
  async exportData(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) id: string,
  ) {
    const data = await this.users.exportData(user.orgId, id);
    void this.audit.logCritical({
      organizationId: user.orgId,
      action: AUDIT_ACTIONS.USER_DATA_EXPORTED,
      actorId: user.userId,
      actorLabel: user.email,
      resourceType: 'user',
      resourceId: id,
      detail: { by: 'admin' },
    });
    return data;
  }
}
