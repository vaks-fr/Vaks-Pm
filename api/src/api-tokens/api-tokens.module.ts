import { Global, Module } from '@nestjs/common';
import { ApiTokensService } from './api-tokens.service';
import { MyApiTokensController, OrgApiTokensController } from './api-tokens.controller';

/**
 * Jetons API (Phase 9). Global : le `JwtAuthGuard` (utilisé partout) injecte
 * `ApiTokensService` pour authentifier les `Authorization: Bearer vaks_…`.
 */
@Global()
@Module({
  controllers: [MyApiTokensController, OrgApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
