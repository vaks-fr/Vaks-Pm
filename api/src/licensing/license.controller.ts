import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import type { LicenseStatusDto } from '@vaks-pm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SeatExempt } from '../auth/seat-exempt.decorator';
import { LicenseService } from './license.service';

/**
 * `GET /license` — état de la licence du tenant, lisible par **tout user
 * authentifié** (le front l'utilise pour les `FeatureGate` et le bandeau
 * d'expiration). App-privé (pas `@PublicApi`), aucun token brut renvoyé.
 */
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SeatExempt() // état de licence lisible même par un compte sans siège
@Controller('license')
export class LicenseController {
  constructor(private readonly licenses: LicenseService) {}

  @Get()
  status(): Promise<LicenseStatusDto> {
    return this.licenses.status();
  }
}
