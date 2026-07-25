import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { LocalKeyProvider } from './crypto/local-key-provider';
import { KeyProviderRegistry } from './crypto/key-provider-registry';
import { KmsKeyProvider } from './crypto/kms-key-provider';
import { Pkcs11KeyProvider } from './crypto/pkcs11-key-provider';
import { KEY_PROVIDER } from './crypto/key-provider';
import { CacheService } from './cache.service';

/**
 * Providers crypto **sans dépendance Prisma** (instanciables au boot, avant tout
 * contexte tenant). `TenantCryptoService` (qui dépend de Prisma) vit dans son
 * propre module `TenantCryptoModule`.
 *
 * `KEY_PROVIDER` = `KeyProviderRegistry` (DORA workstream G) : routeur qui
 * délègue au keyring local par défaut, et plus tard à un provider KMS/HSM
 * enregistré. Avec seul `local`, comportement identique à l'historique.
 */
@Global()
@Module({
  providers: [
    CryptoService,
    LocalKeyProvider,
    KeyProviderRegistry,
    // S'auto-enregistrent auprès du registry à l'init SI configurés (KMS : CRYPTO_KMS_KEY_ID ;
    // HSM : CRYPTO_HSM_BROKER_URL+KEY_LABEL) ; sinon inactifs. Pas de cycle (→ registry → local).
    KmsKeyProvider,
    Pkcs11KeyProvider,
    { provide: KEY_PROVIDER, useExisting: KeyProviderRegistry },
    // Cache Redis court-terme (endpoints agrégés lourds). Dépend de ConfigService
    // + TenantContext (globaux), pas de Prisma → OK dans ce module de boot.
    CacheService,
  ],
  exports: [CryptoService, LocalKeyProvider, KeyProviderRegistry, KEY_PROVIDER, CacheService],
})
export class CommonModule {}
