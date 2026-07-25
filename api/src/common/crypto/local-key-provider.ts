import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { gcmDecrypt, gcmEncrypt } from './aes-gcm';
import { KekRef, KeyProvider, UnknownKekError, WrappedDek } from './key-provider';

/**
 * `KeyProvider` auto-hébergé : la KEK (ou un trousseau de KEK versionnées) vit
 * dans des **fichiers montés** — Docker secret en Swarm, Secret K8s en volume,
 * ou plus tard une clé releasée par un ESO/CSI/HSM au même chemin. L'app ne sait
 * pas qui a déposé les fichiers → portable sans changement de code.
 *
 * Trousseau :
 *   - Fichiers `kek_v*` du répertoire `CRYPTO_KEYS_DIR` (défaut /etc/vaks/keys),
 *     base64 → 32 bytes, indexés par référence `vN` (préfixe `kek_` retiré).
 *   - La clé maître historique `MFA_ENCRYPTION_KEY` est enregistrée sous `env`.
 *
 * KEK active = `CRYPTO_ACTIVE_KEK` si présente, sinon la plus haute `vN`, sinon
 * `env`. **Fallback zéro-config** : aucun fichier + variable absente ⇒ `env` →
 * les déploiements existants (un seul `mfa_encryption_key`) tournent inchangés.
 */
@Injectable()
export class LocalKeyProvider implements KeyProvider, OnModuleInit {
  private readonly logger = new Logger(LocalKeyProvider.name);
  /** Référence env historique = la clé maître `MFA_ENCRYPTION_KEY`. */
  static readonly ENV_REF: KekRef = 'env';

  private readonly keys = new Map<KekRef, Buffer>();
  private active: KekRef = LocalKeyProvider.ENV_REF;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    // 1. Fichiers kek_v* du répertoire monté.
    const dir = this.config.get<string>('crypto.keysDir') ?? '/etc/vaks/keys';
    if (dir && existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!/^kek_v\w+$/.test(file)) continue;
        const ref = file.replace(/^kek_/, ''); // kek_v3 → v3
        const raw = readFileSync(join(dir, file), 'utf8').trim();
        const buf = Buffer.from(raw, 'base64');
        if (buf.length !== 32) {
          throw new Error(`KEK invalide ${file} : 32 bytes attendus (Base64), reçu ${buf.length}`);
        }
        this.keys.set(ref, buf);
      }
    }

    // 2. Clé maître env historique sous `env`.
    const envRaw = this.config.get<string>('encryptionKey') ?? '';
    if (envRaw) {
      const buf = Buffer.from(envRaw, 'base64');
      if (buf.length !== 32) {
        throw new Error(`MFA_ENCRYPTION_KEY invalide : 32 bytes attendus (Base64), reçu ${buf.length}`);
      }
      this.keys.set(LocalKeyProvider.ENV_REF, buf);
    }

    // 3. Sélection de la KEK active.
    const wanted = (this.config.get<string>('crypto.activeKek') ?? '').trim();
    if (wanted && this.keys.has(wanted)) {
      this.active = wanted;
    } else {
      const versioned = [...this.keys.keys()]
        .filter((r) => /^v\d+$/.test(r))
        .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10));
      this.active = versioned[0] ?? LocalKeyProvider.ENV_REF;
    }

    // 4. Garde-fou prod : aucune KEK chargeable = configuration cassée.
    if (this.keys.size === 0) {
      if (this.config.get<string>('nodeEnv') === 'production') {
        throw new Error(
          'Aucune KEK disponible en production — monter `mfa_encryption_key` ou des fichiers kek_v* dans CRYPTO_KEYS_DIR.',
        );
      }
      // Dev : KEK éphémère pour ne pas bloquer le démarrage.
      this.keys.set(LocalKeyProvider.ENV_REF, randomBytes(32));
      this.active = LocalKeyProvider.ENV_REF;
    }
    this.logger.log(
      `Keyring chargé : ${[...this.keys.keys()].join(', ')} (active=${this.active})`,
    );
  }

  private kek(ref: KekRef): Buffer {
    const k = this.keys.get(ref);
    if (!k) throw new UnknownKekError(ref);
    return k;
  }

  activeKekRef(): KekRef {
    return this.active;
  }

  hasKek(ref: KekRef): boolean {
    return this.keys.has(ref);
  }

  async generateDataKey(): Promise<Buffer> {
    return randomBytes(32);
  }

  async wrapDek(dek: Buffer, kekRef?: KekRef): Promise<WrappedDek> {
    const ref = kekRef ?? this.active;
    return { kekRef: ref, wrapped: gcmEncrypt(this.kek(ref), dek) };
  }

  async unwrapDek(w: WrappedDek): Promise<Buffer> {
    return gcmDecrypt(this.kek(w.kekRef), w.wrapped);
  }
}
