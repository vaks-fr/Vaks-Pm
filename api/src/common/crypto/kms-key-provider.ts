import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { randomBytes } from 'crypto';
import { KekRef, KeyProvider, WrappedDek } from './key-provider';
import { KeyProviderRegistry } from './key-provider-registry';

const KMS_PREFIX = 'kms:';

/**
 * `KeyProvider` adossé à un **KMS compatible AWS** (AWS KMS, ou tout endpoint
 * KMS-compatible : LocalStack en test, certains KMS on-prem). DORA workstream G.
 *
 * La KEK vit dans le KMS et **n'en sort jamais** : `wrapDek` = `Encrypt(DEK)`,
 * `unwrapDek` = `Decrypt(blob)`. Le `kekRef` encode l'id de la clé KMS
 * (`kms:<keyId>`) → support de plusieurs clés / rotation (chaque blob sait quelle
 * clé l'a wrappé). La DEK reste générée **localement** (32 octets) : seul son
 * enveloppe part au KMS, jamais la donnée ni la DEK en clair persistée.
 *
 * Activé seulement si `CRYPTO_KMS_KEY_ID` est défini ; s'enregistre alors auprès
 * du `KeyProviderRegistry` sous le schéma `kms`. Migrer la custody vers le KMS =
 * `CRYPTO_KEY_PROVIDER=kms` (nouvelles DEK wrappées KMS) puis `rewrapAll` (re-wrap
 * des DEK existantes ; aucune donnée re-chiffrée).
 */
@Injectable()
export class KmsKeyProvider implements KeyProvider, OnModuleInit {
  private readonly logger = new Logger(KmsKeyProvider.name);
  private client?: KMSClient;
  private keyId = '';

  constructor(
    private readonly config: ConfigService,
    private readonly registry: KeyProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.keyId = this.config.get<string>('crypto.kms.keyId') ?? '';
    if (!this.keyId) return; // KMS non configuré → provider inactif (non enregistré)

    const region = this.config.get<string>('crypto.kms.region') || 'us-east-1';
    const endpoint = this.config.get<string>('crypto.kms.endpoint') || undefined;
    const accessKeyId = process.env.CRYPTO_KMS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.CRYPTO_KMS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    this.client = new KMSClient({
      region,
      ...(endpoint ? { endpoint } : {}),
      // Sinon, chaîne de credentials par défaut du SDK (rôle IAM / workload identity).
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
    this.registry.register('kms', this);
    this.logger.log(`KMS KeyProvider actif (key=${this.keyId}, endpoint=${endpoint || `aws:${region}`})`);
  }

  /** DEK générée localement ; le KMS ne fait qu'envelopper. */
  async generateDataKey(): Promise<Buffer> {
    return randomBytes(32);
  }

  async wrapDek(dek: Buffer, kekRef?: KekRef): Promise<WrappedDek> {
    const keyId = kekRef?.startsWith(KMS_PREFIX) ? kekRef.slice(KMS_PREFIX.length) : this.keyId;
    const res = await this.client!.send(new EncryptCommand({ KeyId: keyId, Plaintext: dek }));
    if (!res.CiphertextBlob) throw new Error('KMS Encrypt : CiphertextBlob vide');
    return { kekRef: `${KMS_PREFIX}${keyId}`, wrapped: Buffer.from(res.CiphertextBlob) };
  }

  async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
    const keyId = wrapped.kekRef.slice(KMS_PREFIX.length);
    const res = await this.client!.send(
      new DecryptCommand({ CiphertextBlob: wrapped.wrapped, KeyId: keyId || undefined }),
    );
    if (!res.Plaintext) throw new Error('KMS Decrypt : Plaintext vide');
    return Buffer.from(res.Plaintext);
  }

  activeKekRef(): KekRef {
    return `${KMS_PREFIX}${this.keyId}`;
  }

  hasKek(kekRef: KekRef): boolean {
    return kekRef.startsWith(KMS_PREFIX) && !!this.client;
  }
}
