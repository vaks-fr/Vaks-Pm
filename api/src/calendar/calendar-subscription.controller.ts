import { Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { CalendarService } from './calendar.service';

/**
 * Cycle de vie du flux ICS **de l'utilisateur courant** (self-service, comme
 * `/me/api-tokens`). Aucune permission spéciale : chacun ne gère que le sien —
 * le sujet est toujours `user.userId` du JWT, jamais un id de paramètre.
 * App-privée, pas `@PublicApi` : un PAT/agent n'a pas besoin de faire tourner
 * l'abonnement calendrier de son porteur.
 *
 * Le back ne renvoie que le `token` brut ; l'URL complète (host + base API)
 * est reconstruite côté web, qui connaît sa propre origine.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt() // self-service du compte : accessible sans siège
@Controller('me/calendar-feed')
export class CalendarSubscriptionController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.calendar.getStatus(user.orgId, user.userId);
  }

  @Post('rotate')
  rotate(@CurrentUser() user: AuthUser) {
    return this.calendar.regenerate(user.orgId, user.userId);
  }

  @Delete()
  revoke(@CurrentUser() user: AuthUser) {
    return this.calendar.revoke(user.orgId, user.userId);
  }
}
