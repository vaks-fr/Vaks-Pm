import { Global, Module } from '@nestjs/common';
import { TenantCryptoService } from './tenant-crypto.service';

/**
 * Module @Global isolant `TenantCryptoService` (qui dépend de `PrismaService`)
 * du `CommonModule` (KeyProvider/CryptoService sans Prisma) → graphe de
 * dépendances unidirectionnel, pas de cycle. Étant global, les 5 consommateurs
 * n'ont aucun import de module à ajouter, seulement l'injection en constructeur.
 */
@Global()
@Module({
  providers: [TenantCryptoService],
  exports: [TenantCryptoService],
})
export class TenantCryptoModule {}
