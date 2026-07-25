import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { FinanceApiGateGuard } from './finance-api-gate.guard';
import { FinanceService } from './finance.service';
import { SetProjectRateDto } from './dto/set-rate.dto';
import { SetAgentRateDto } from './dto/set-agent-rate.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { RestampRatesDto } from './dto/restamp-rates.dto';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';

/**
 * Endpoints finance d'un projet — taux horaires (coût/facturation) par personne
 * et enveloppe budgétaire. Les **lectures** sont `@PublicApi('finance:view')`
 * mais gardées par `FinanceApiGateGuard` : un PAT/clé-org n'y accède QUE si le
 * toggle `mcp.allowFinance` est activé (fail-closed sinon) ; le JWT navigateur
 * n'est jamais affecté par le gate. Les **écritures** restent `finance:manage`,
 * hors `@PublicApi`. C'est le seul endroit où les montants sont exposés —
 * les lectures projet ordinaires `omit` ces champs.
 * ⚠️ Ne PAS retirer `FinanceApiGateGuard` : c'est lui (pas l'absence de
 * `@PublicApi`) qui ferme la finance aux jetons quand le toggle est off.
 *
 * `@ProjectAccess` : aujourd'hui les porteurs de `finance:view` (PORTFOLIO_
 * MANAGER, GLOBAL_REPORT_VIEWER) ont aussi `project:view_all`, mais le guard
 * ferme l'IDOR le jour où un rôle custom/projet porte `finance:*` sans
 * visibilité org-wide.
 */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard, FinanceApiGateGuard)
@ProjectAccess(fromProjectParam('projectId'))
@Controller('projects')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get(':projectId/rates')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  getRates(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.finance.getRates(user.orgId, projectId);
  }

  @Get(':projectId/budget-summary')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  getBudgetSummary(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.finance.getBudgetSummary(user.orgId, projectId);
  }

  @Get(':projectId/evm')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  getEvm(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.finance.getProjectEvm(user.orgId, projectId);
  }

  @Put(':projectId/rates/:userId')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  setRate(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetProjectRateDto,
  ) {
    return this.finance.setRate(user.orgId, projectId, userId, dto);
  }

  @Delete(':projectId/rates/:userId')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  deleteRate(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.finance.deleteRate(user.orgId, projectId, userId);
  }

  // ----- Taux de facturation agents IA (€ / 1K tokens) -----
  // Miroir des taux humains, unité kToken. Visible seulement si le projet a
  // `agentsEnabled` (le service renvoie `enabled:false` sinon → UI muette).

  @Get(':projectId/agent-rates')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  getAgentRates(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.finance.getAgentRates(user.orgId, projectId);
  }

  @Put(':projectId/agent-rates/:agentId')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  setAgentRate(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: SetAgentRateDto,
  ) {
    return this.finance.setAgentRate(user.orgId, projectId, agentId, dto);
  }

  @Delete(':projectId/agent-rates/:agentId')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  deleteAgentRate(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
  ) {
    return this.finance.deleteAgentRate(user.orgId, projectId, agentId);
  }

  @Put(':projectId/budget')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  updateBudget(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    return this.finance.updateBudget(user.orgId, projectId, dto);
  }

  @Post(':projectId/rates/restamp')
  @RequirePermissions('finance:manage')
  restamp(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RestampRatesDto,
  ) {
    return this.finance.restampRates(user.orgId, projectId, dto);
  }

  // ----- Coûts hors main-d'œuvre (licences, matériel, cloud, sous-traitance) -----

  @Get(':projectId/expenses')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  listExpenses(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.finance.listExpenses(user.orgId, projectId);
  }

  @Post(':projectId/expenses')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  createExpense(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.finance.createExpense(user.orgId, projectId, user.userId, dto);
  }

  @Patch(':projectId/expenses/:expenseId')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  updateExpense(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('expenseId', ParseUUIDPipe) expenseId: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.finance.updateExpense(user.orgId, projectId, expenseId, dto);
  }

  @Delete(':projectId/expenses/:expenseId')
  @PublicApi('finance:manage')
  @RequirePermissions('finance:manage')
  deleteExpense(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('expenseId', ParseUUIDPipe) expenseId: string,
  ) {
    return this.finance.deleteExpense(user.orgId, projectId, expenseId);
  }
}
