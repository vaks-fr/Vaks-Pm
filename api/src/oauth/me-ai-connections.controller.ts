import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { OAuthService } from './oauth.service';

/**
 * Connexions IA **de l'utilisateur courant** (phase 11) — self-service, à la
 * manière des « sessions actives ». Liste les clients IA branchés (Claude,
 * ChatGPT, Copilot Studio…) et permet d'en couper un. App-privé (PAS
 * `@PublicApi`, JWT navigateur) : un jeton d'API ne gère pas les connexions.
 *
 * Révoquer une connexion supprime sa chaîne de refresh → le client IA devra se
 * reconnecter (et le jeton d'accès en cours, court, expire vite de lui-même).
 */
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt() // self-service du compte : accessible sans siège
@Controller('me/ai-connections')
export class MeAiConnectionsController {
  constructor(private readonly oauth: OAuthService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.oauth.listUserConnections(user.userId);
  }

  @Delete(':connId')
  revoke(@CurrentUser() user: AuthUser, @Param('connId') connId: string) {
    return this.oauth.revokeConnection(user.userId, connId);
  }
}
