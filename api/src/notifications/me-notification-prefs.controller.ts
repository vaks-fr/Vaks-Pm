import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';

/**
 * Préférences de notification **de l'utilisateur courant** (#14, self-service).
 * Aucune permission spéciale : chacun gère ses propres overrides. Route
 * app-privée (pas `@PublicApi`). `null` sur un champ = hériter du défaut org.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt() // self-service du compte : accessible sans siège
@Controller('me/notification-prefs')
export class MeNotificationPrefsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.notifications.getUserPrefs(user.orgId, user.userId);
  }

  @Put()
  update(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      assignment?: boolean | null;
      mention?: boolean | null;
      dueReminder?: boolean | null;
      statusChange?: boolean | null;
    },
  ) {
    return this.notifications.setUserPrefs(user.orgId, user.userId, body ?? {});
  }
}
