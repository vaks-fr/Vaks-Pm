import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { TicketingSearchService } from './ticketing-search.service';

/**
 * Routes publiques (scope `time:log`) pour la recherche live de tickets.
 * Consommées par le picker timesheet — aucun secret jamais renvoyé.
 */
@ApiTags('ticketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi('time:log')
@Controller('ticketing')
export class TicketingSearchController {
  constructor(private readonly svc: TicketingSearchService) {}

  /** Sources actives configurées pour l'org (pour peupler le selector UI). */
  @Get('sources')
  @RequirePermissions('time:log')
  listSources(@CurrentUser() user: AuthUser) {
    return this.svc.listSources(user.orgId);
  }

  /**
   * Recherche live dans une source (?source=servicenow&q=incident).
   * Cache in-process 60 s — fail-open (retourne [] si erreur provider).
   */
  @Get('search')
  @RequirePermissions('time:log')
  search(
    @CurrentUser() user: AuthUser,
    @Query('source') source: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 20, 50) : 20;
    return this.svc.search(user.orgId, user.email, source ?? '', q ?? '', parsedLimit);
  }
}
