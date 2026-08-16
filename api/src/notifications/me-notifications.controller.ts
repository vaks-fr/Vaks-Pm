import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';

/**
 * Boîte de réception in-app durable (cloche) **de l'utilisateur courant**.
 * Strictement self-only (sujet = `user.userId`, jamais un id passé en param —
 * même esprit que `GET /me/tasks`, `/me/notification-prefs`). Route app-privée
 * (pas `@PublicApi` : la cloche est un artefact de l'app web, pas de l'API
 * partenaire). `@SeatExempt` : la lecture de ses notifs ne consomme pas de
 * siège (self-service du compte).
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt()
@Controller('me/notifications')
export class MeNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Page keyset (plus récentes d'abord) + compteur global de non-lues. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : undefined;
    return this.notifications.listInbox(
      user.orgId,
      user.userId,
      cursor,
      Number.isFinite(n) ? (n as number) : undefined,
    );
  }

  /** Compteur de non-lues seul (pastille, sans charger la liste). */
  @Get('unread-count')
  async unread(@CurrentUser() user: AuthUser) {
    return { unreadCount: await this.notifications.unreadInboxCount(user.orgId, user.userId) };
  }

  /**
   * Marque des notifications lues. Body `{ ids?: string[] }` : sans `ids`,
   * marque TOUTES les non-lues (ouverture de la cloche).
   */
  @Post('read')
  markRead(@CurrentUser() user: AuthUser, @Body() body?: { ids?: string[] }) {
    return this.notifications.markInboxRead(user.orgId, user.userId, body?.ids);
  }

  /** Dismiss (supprime) une notification de sa propre boîte. */
  @Delete(':id')
  dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.dismissInbox(user.orgId, user.userId, id);
  }
}
