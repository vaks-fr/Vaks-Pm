import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KekRef, KeyProvider, UnknownKekError, WrappedDek } from './key-provider';
import { LocalKeyProvider } from './local-key-provider';
import { KekScheme, providerOfKekRef } from './kek-ref';

/**
 * Routeur de `KeyProvider` (DORA workstream G — HSM/KMS). C'est lui qui est
 * injecté sous le token `KEY_PROVIDER` ; il délègue à un ou plusieurs providers
 * nommés par schéma (`local`, `kms`, `hsm`…). Implémente lui-même `KeyProvider`
 * → aucun changement pour les appelants (`TenantCryptoService`, crypto admin).
 *
 *   - **unwrapDek** → provider propriétaire de `wrapped.kekRef`. Permet un état
 *     **mixte** pendant une migration : chaque ligne `DataEncryptionKey` porte
 *     son `kekRef`, donc certaines DEK peuvent être wrappées `local:v1` et
 *     d'autres `kms:…` simultanément.
 *   - **wrapDek** (nouvelle DEK / rotation) → provider **actif** (`CRYPTO_KEY_PROVIDER`).
 *   - **generateDataKey** → **toujours local** : la DEK est générée en clair côté
 *     app (elle doit l'être pour chiffrer les données sous AES-GCM) ; seul le
 *     wrap/unwrap de la DEK part au HSM/KMS, jamais la donnée ni la DEK en clair
 *     de façon persistante.
 *
 * Avec seul `local` enregistré (défaut), le comportement est **identique** à
 * l'historique. Migrer = enregistrer un provider externe + le rendre actif +
 * `rewrapAll` (re-wrap des DEK sous la nouvelle KEK, sans re-chiffrer les données).
 */
@Injectable()
export class KeyProviderRegistry implements KeyProvider {
  private readonly logger = new Logger(KeyProviderRegistry.name);
  private readonly providers = new Map<KekScheme, KeyProvider>();
  private readonly activeName: KekScheme;

  constructor(
    private readonly local: LocalKeyProvider,
    config: ConfigService,
  ) {
    this.providers.set('local', local);
    this.activeName = (config.get<string>('crypto.keyProvider') ?? 'local') as KekScheme;
  }

  /** Enregistre un provider externe (KMS/HSM) sous son schéma. À appeler au boot. */
  register(scheme: KekScheme, provider: KeyProvider): void {
    if (scheme === 'local') throw new Error("le schéma 'local' est réservé");
    this.providers.set(scheme, provider);
    this.logger.log(`External KeyProvider registered: ${scheme}`);
  }

  private bySchemeOrThrow(scheme: KekScheme): KeyProvider {
    const p = this.providers.get(scheme);
    if (!p) throw new Error(`KeyProvider non enregistré : ${scheme}`);
    return p;
  }

  private active(): KeyProvider {
    return this.bySchemeOrThrow(this.activeName);
  }

  /** DEK toujours générée localement (clair en mémoire pour le chiffrement local). */
  async generateDataKey(): Promise<Buffer> {
    return this.local.generateDataKey();
  }

  async wrapDek(dek: Buffer, kekRef?: KekRef): Promise<WrappedDek> {
    if (kekRef) return this.bySchemeOrThrow(providerOfKekRef(kekRef)).wrapDek(dek, kekRef);
    return this.active().wrapDek(dek);
  }

  async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
    const p = this.providers.get(providerOfKekRef(wrapped.kekRef));
    if (!p) throw new UnknownKekError(wrapped.kekRef);
    return p.unwrapDek(wrapped);
  }

  activeKekRef(): KekRef {
    return this.active().activeKekRef();
  }

  hasKek(kekRef: KekRef): boolean {
    const p = this.providers.get(providerOfKekRef(kekRef));
    return !!p && p.hasKek(kekRef);
  }
}
