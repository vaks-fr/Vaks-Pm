import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { FinanceApiGateGuard } from '../finance/finance-api-gate.guard';
import { ReportsService } from './reports.service';

/**
 * KPI **projet portefeuille** (transverse org) : conflits de ressources,
 * Schedule Variance, Milestone Hit Rate, cycle time, utilisation. Données de
 * pilotage org-wide (inclut de la valeur EV/PV) → gardé `finance:view`, porté
 * uniquement par des rôles org-wide (ORG_ADMIN / PORTFOLIO_MANAGER /
 * GLOBAL_REPORT_VIEWER). Lecture `@PublicApi('finance:view')` mais gardée par
 * `FinanceApiGateGuard` : un jeton n'y accède que si `mcp.allowFinance` est on
 * (fail-closed sinon) ; le JWT navigateur n'est jamais affecté. ⚠️ Ne PAS
 * retirer le gate guard. Le service self-scope quand même le périmètre projet
 * (défense en profondeur).
 */
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, FinanceApiGateGuard)
@Controller('reports')
export class PortfolioKpiController {
  constructor(private readonly svc: ReportsService) {}

  @Get('portfolio-kpi')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  portfolioKpi(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.svc.portfolioKpi(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      { from, to, teamId },
    );
  }
}
