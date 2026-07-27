import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS, severityForAction } from '../audit-logs/audit-actions';

/**
 * **RGPD — portabilité des données (Art. 20), self-service.** L'utilisateur
 * courant télécharge SES propres données (JSON). Strictement self-only :
 * le sujet de l'export est toujours `user.userId`, jamais un id passé en
 * paramètre (même esprit que `GET /timesheet`). Route app-privée (pas
 * `@PublicApi`). Acte tracé `user.data_exported`.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt() // RGPD self-export : accessible sans siège
@Controller('me/export')
export class MeDataController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async exportMine(@CurrentUser() user: AuthUser) {
    const data = await this.users.exportData(user.orgId, user.userId);
    void this.audit.log({
      organizationId: user.orgId,
      action: AUDIT_ACTIONS.USER_DATA_EXPORTED,
      severity: severityForAction(AUDIT_ACTIONS.USER_DATA_EXPORTED),
      actorId: user.userId,
      actorLabel: user.email,
      resourceType: 'user',
      resourceId: user.userId,
      detail: { by: 'self' },
    });
    return data;
  }
}
