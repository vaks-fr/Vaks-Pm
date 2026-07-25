import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { AgentDispatchService } from './agent-dispatch.service';

/**
 * Dispatch « pull » pour les agents (AGENTS_ARCHITECTURE.md chantier 4). Deux
 * routes **self-only** (le sujet est toujours le porteur du jeton, jamais un id
 * en paramètre — même esprit que `GET /me/tasks`) :
 *
 *  - `GET  /me/next-task`        → meilleure tâche revendiquable, sans effet de bord.
 *  - `POST /me/next-task/claim`  → sélection + claim atomique (boucle bornée).
 *
 * `@PublicApi()` : ouvert aux jetons — un agent tire ainsi son travail via
 * `vaks_next_task`. Chaque route porte sa permission (`task:view` / `task:update`) ;
 * le claim ré-applique tous les garde-fous.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller('me/next-task')
export class AgentDispatchController {
  constructor(private readonly dispatch: AgentDispatchService) {}

  @Get()
  @RequirePermissions('task:view')
  next(@CurrentUser() user: AuthUser) {
    return this.dispatch.preview(user.orgId, user.userId, user.actorKind ?? 'HUMAN');
  }

  @Post('claim')
  @RequirePermissions('task:update')
  claim(@CurrentUser() user: AuthUser) {
    return this.dispatch.claim(user.orgId, user.userId, user.actorKind ?? 'HUMAN');
  }
}
