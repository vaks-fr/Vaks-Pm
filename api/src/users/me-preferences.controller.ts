import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from './users.service';

/**
 * Préférences d'interface **de l'utilisateur courant** (self-service).
 * Aucune permission spéciale : chacun gère sa propre langue d'UI. Route
 * app-privée (pas `@PublicApi`). `language: null` → hériter du défaut org.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt() // self-service du compte : accessible sans siège
@Controller('me/preferences')
export class MePreferencesController {
  constructor(private readonly users: UsersService) {}

  @Put('language')
  async setLanguage(
    @CurrentUser() user: AuthUser,
    @Body() body: { language?: string | null },
  ) {
    const updated = await this.users.setMyLanguage(user.userId, body?.language);
    return { preferredLanguage: updated.preferredLanguage };
  }
}
