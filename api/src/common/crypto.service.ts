import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { gcmDecrypt, gcmEncrypt } from './crypto/aes-gcm';

/**
 * Chiffrement at-rest symétrique sous la **clé maître** (`MFA_ENCRYPTION_KEY`).
 *
 * Désormais cantonné au rôle de **primitive bas niveau + déchiffrement des blobs
 * v1 legacy** (KEK `env`). Le chiffrement applicatif des secrets passe par
 * `TenantCryptoService` (envelope, DEK par tenant, blobs v2). Conservé tel quel
 * pour que les blobs v1 existants restent déchiffrables tant que la clé maître
 * est montée.
 *
 * AES-256-GCM. Clé = 32 bytes Base64. Format (Base64) : nonce(12) || ct || tag(16).
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('encryptionKey') ?? '';
    if (!raw) {
      // En dev on tolère l'absence : on génère une clé éphémère.
      // En prod, le déploiement DOIT fournir MFA_ENCRYPTION_KEY (secret docker).
      const envName = this.config.get<string>('nodeEnv');
      if (envName === 'production') {
        throw new Error(
          'MFA_ENCRYPTION_KEY manquante en production — créer le secret docker `mfa_encryption_key`.',
        );
      }
      this.key = randomBytes(32);
      return;
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `MFA_ENCRYPTION_KEY invalide : 32 bytes attendus (Base64), reçu ${buf.length}`,
      );
    }
    this.key = buf;
  }

  encrypt(plaintext: string): string {
    if (!this.key) throw new Error('CryptoService non initialisé');
    return gcmEncrypt(this.key, Buffer.from(plaintext, 'utf8')).toString('base64');
  }

  decrypt(payload: string): string {
    if (!this.key) throw new Error('CryptoService non initialisé');
    return gcmDecrypt(this.key, Buffer.from(payload, 'base64')).toString('utf8');
  }
}
