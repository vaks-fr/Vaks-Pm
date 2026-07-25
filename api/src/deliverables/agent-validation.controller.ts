import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { DeliverablesService } from './deliverables.service';

/**
 * Dispatch pull des tâches de VALIDATION (phase D `agent_validator`, symétrie de
 * `next_task`). Un agent validateur TIRE du travail de revue : le backend trouve
 * un livrable PENDING qu'il peut valider (projet agent-activé dont il est membre,
 * auteur ≠ lui, plancher requis == `agent_validator`) et le lui **baille**
 * atomiquement. `@PublicApi('task:view')` self-only ; le gate agent+capability
 * `deliverables:validate` + séparation des tâches est appliqué dans le service.
 */
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('me')
export class AgentValidationController {
  constructor(private readonly deliverables: DeliverablesService) {}

  @Post('next-validation/claim')
  @PublicApi('task:view')
  @RequirePermissions('task:view')
  @HttpCode(200)
  claim(@CurrentUser() user: AuthUser) {
    return this.deliverables.claimValidation(user.orgId, {
      userId: user.userId,
      actorKind: user.actorKind,
      capabilities: user.capabilities,
    });
  }
}
