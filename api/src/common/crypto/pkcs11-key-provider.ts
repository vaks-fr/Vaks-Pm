import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { KekRef, KeyProvider, WrappedDek } from './key-provider';
import { KeyProviderRegistry } from './key-provider-registry';

const HSM_PREFIX = 'hsm:';

/**
 * `KeyProvider` HSM on-prem (DORA workstream G). **Client mince** d'un
 * **key-broker sidecar** : c'est le sidecar (et lui seul) qui embarque la
 * bibliothèque PKCS#11 du fournisseur et le PIN du HSM ; l'app ne fait que des
 * appels HTTP internes (`/wrap`, `/unwrap`). Bénéfice : l'image applicative reste
 * **vendor-neutral** (aucune dépendance native, aucun secret HSM).
 *
 * La KEK vit dans le HSM et n'en sort jamais : `wrapDek` envoie la DEK au sidecar
 * qui la chiffre **dans** le HSM ; `unwrapDek` la fait déchiffrer dans le HSM. La
 * DEK en clair ne transite que sur le réseau **overlay interne chiffré** (cf.
 * workstream D), protégée en plus par le secret partagé `BROKER_TOKEN`.
 *
 * `kekRef = hsm:<keyLabel>` (le label encode quelle KEK a wrappé → multi-clé /
 * rotation). Activé si `CRYPTO_HSM_BROKER_URL` + `CRYPTO_HSM_KEY_LABEL` définis.
 */
@Injectable()
export class Pkcs11KeyProvider implements KeyProvider, OnModuleInit {
  private readonly logger = new Logger(Pkcs11KeyProvider.name);
  private brokerUrl = '';
  private keyLabel = '';
  private token = '';

  constructor(
    private readonly config: ConfigService,
    private readonly registry: KeyProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.brokerUrl = (this.config.get<string>('crypto.hsm.brokerUrl') ?? '').replace(/\/+$/, '');
    this.keyLabel = this.config.get<string>('crypto.hsm.keyLabel') ?? '';
    this.token = this.config.get<string>('crypto.hsm.token') ?? '';
    if (!this.brokerUrl || !this.keyLabel) return; // sidecar non configuré → inactif
    this.registry.register('hsm', this);
    this.logger.log(`HSM KeyProvider actif (broker=${this.brokerUrl}, key=${this.keyLabel})`);
  }

  private async call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.brokerUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HSM broker ${path} → HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** DEK générée localement ; seul son wrap part au HSM via le sidecar. */
  async generateDataKey(): Promise<Buffer> {
    return randomBytes(32);
  }

  async wrapDek(dek: Buffer, kekRef?: KekRef): Promise<WrappedDek> {
    const keyLabel = kekRef?.startsWith(HSM_PREFIX) ? kekRef.slice(HSM_PREFIX.length) : this.keyLabel;
    const out = await this.call('/wrap', { keyLabel, dek: dek.toString('base64') });
    return { kekRef: `${HSM_PREFIX}${keyLabel}`, wrapped: Buffer.from(out.wrapped as string, 'base64') };
  }

  async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
    const keyLabel = wrapped.kekRef.slice(HSM_PREFIX.length);
    const out = await this.call('/unwrap', { keyLabel, wrapped: wrapped.wrapped.toString('base64') });
    return Buffer.from(out.dek as string, 'base64');
  }

  activeKekRef(): KekRef {
    return `${HSM_PREFIX}${this.keyLabel}`;
  }

  hasKek(kekRef: KekRef): boolean {
    return kekRef.startsWith(HSM_PREFIX) && !!this.brokerUrl;
  }
}
