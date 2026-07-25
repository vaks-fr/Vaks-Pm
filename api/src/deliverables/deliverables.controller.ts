import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, TaskWritePolicy, fromTaskParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { Audited } from '../audit-logs/audited.decorator';
import { DeliverablesService } from './deliverables.service';
import { CreateDeliverableDto } from './dto/create-deliverable.dto';
import { ReviewDeliverableDto } from './dto/review-deliverable.dto';
import { SubmitValidationDto } from './dto/submit-validation.dto';

/**
 * Livrables d'une tâche (chantier 2c). Routes **task-scopées** (l'accès projet
 * est vérifié par `ProjectAccessGuard` via `fromTaskParam`) : pas d'IDOR sur un
 * `deliverableId` isolé — il doit appartenir à la tâche du chemin.
 */
@ApiTags('deliverables')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromTaskParam('taskId'))
@PublicApi()
@Controller()
export class DeliverablesController {
  constructor(private readonly deliverables: DeliverablesService) {}

  @Get('tasks/:taskId/deliverables')
  @RequirePermissions('task:view')
  list(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.deliverables.list(user.orgId, taskId);
  }

  /**
   * Exigence de vérification pour cette tâche, du point de vue de l'acteur
   * courant (chantier 4b). L'agent l'appelle AVANT de travailler. Lecture seule.
   */
  @Get('tasks/:taskId/verification-requirements')
  @RequirePermissions('task:view')
  verificationRequirements(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.deliverables.getVerificationRequirements(user.orgId, taskId, user.userId);
  }

  /** Soumettre un livrable (auteur = acteur courant : humain ou agent). */
  @Post('tasks/:taskId/deliverables')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  @Audited('deliverable.submitted', { resource: 'task', idParam: 'taskId' })
  submit(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateDeliverableDto,
  ) {
    return this.deliverables.submit(user.orgId, taskId, user.userId, dto);
  }

  /**
   * Décision de revue d'un livrable (approve / request changes). Scope
   * **`task:review`** (jamais accordé à un agent) + reviewer ≠ auteur.
   */
  @Post('tasks/:taskId/deliverables/:deliverableId/review')
  @RequirePermissions('task:review')
  @TaskWritePolicy()
  @Audited('deliverable.reviewed', { resource: 'task', idParam: 'taskId' })
  review(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('deliverableId', ParseUUIDPipe) deliverableId: string,
    @Body() dto: ReviewDeliverableDto,
  ) {
    return this.deliverables.review(user.orgId, taskId, deliverableId, { userId: user.userId }, dto);
  }

  /**
   * Heartbeat du bail de validation d'un agent validateur (phase D §8.7). Le gate
   * réel (agent + capability `deliverables:validate` + claimant) est dans le
   * service. `task:view` = scope minimal pour atteindre la route.
   */
  @Post('tasks/:taskId/deliverables/:deliverableId/validation-heartbeat')
  @RequirePermissions('task:view')
  validationHeartbeat(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('deliverableId', ParseUUIDPipe) deliverableId: string,
  ) {
    return this.deliverables.validationHeartbeat(user.orgId, taskId, deliverableId, {
      userId: user.userId,
      actorKind: user.actorKind,
      capabilities: user.capabilities,
    });
  }

  /**
   * Verdict d'un agent validateur (phase D). Preuve `agent_validator` ; en mode
   * `enforce` + plancher `agent_validator`, un `approve` non échantillonné
   * auto-transitionne la tâche. Gate agent+capability+claimant≠auteur = service.
   */
  @Post('tasks/:taskId/deliverables/:deliverableId/validation')
  @RequirePermissions('task:view')
  submitValidation(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('deliverableId', ParseUUIDPipe) deliverableId: string,
    @Body() dto: SubmitValidationDto,
  ) {
    return this.deliverables.submitValidation(
      user.orgId,
      taskId,
      deliverableId,
      { userId: user.userId, actorKind: user.actorKind, capabilities: user.capabilities },
      dto,
    );
  }
}
