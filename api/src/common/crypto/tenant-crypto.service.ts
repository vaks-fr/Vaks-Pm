import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../crypto.service';
import { gcmDecrypt, gcmEncrypt } from './aes-gcm';
import { decodeV2, encodeV2 } from './blob-format';
import { KEY_PROVIDER, KeyProvider } from './key-provider';

/**
 * Chiffrement at-rest **par tenant** (envelope encryption). Remplace l'appel
 * direct à `CryptoService` dans les 5 consommateurs de secrets.
 *
 *  - encrypt : charge/crée la DEK ACTIVE du tenant, chiffre sous la DEK, encode
 *    un blob **v2** (toujours).
 *  - decrypt : v2 ⇒ résout la DEK par `dekRef` (base du tenant) et déchiffre ;
 *    sinon ⇒ blob **v1 legacy** déchiffré par `CryptoService` (KEK `env`).
 *
 * Service singleton @Global, mais sans état tenant : la résolution DB passe par
 * le proxy `PrismaService` (contexte tenant via ALS), donc chaque requête vise
 * la bonne base. Le cache DEK est keyé par `dekRef` (uuid globalement unique),
 * jamais persisté ni loggé.
 */
@Injectable()
export class TenantCryptoService {
  private readonly logger = new Logger(TenantCryptoService.name);
  /**
   * `org:dekRef` → DEK en clair (mémoire process). La clé est **scopée à l'org**
   * pour que le cache ne court-circuite jamais la liaison tenant (un blob d'un
   * autre org reste indéchiffrable même si sa DEK est en cache). Durcissement
   * TTL/zeroization : à venir.
   */
  private readonly dekCache = new Map<string, Buffer>();

  private cacheKey(organizationId: string, dekRef: string): string {
    return `${organizationId}:${dekRef}`;
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly legacy: CryptoService,
  ) {}

  /** Chiffre un secret pour `organizationId` → blob v2 base64. */
  async encrypt(organizationId: string, plaintext: string): Promise<string> {
    const { dekRef, dek } = await this.loadOrCreateActiveDek(organizationId);
    const body = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'));
    return encodeV2(dekRef, body);
  }

  /** Déchiffre un blob (v1 legacy ou v2) appartenant à `organizationId`. */
  async decrypt(organizationId: string, blob: string): Promise<string> {
    const v2 = decodeV2(blob);
    if (!v2) return this.legacy.decrypt(blob); // v1 : KEK env historique
    const dek = await this.dekByRef(organizationId, v2.dekRef);
    return gcmDecrypt(dek, v2.body).toString('utf8');
  }

  /** Charge la DEK ACTIVE du tenant, ou la crée à la volée (lazy mint). */
  private async loadOrCreateActiveDek(
    organizationId: string,
  ): Promise<{ dekRef: string; dek: Buffer }> {
    const existing = await this.prisma.dataEncryptionKey.findFirst({
      where: { organizationId, status: 'ACTIVE' },
    });
    if (existing) {
      return { dekRef: existing.dekRef, dek: await this.unwrapRow(organizationId, existing) };
    }
    // Aucune DEK : on en génère une et on la wrappe sous la KEK active.
    const dek = await this.keys.generateDataKey();
    const wrapped = await this.keys.wrapDek(dek);
    try {
      const row = await this.prisma.dataEncryptionKey.create({
        data: {
          organizationId,
          wrappedKey: wrapped.wrapped.toString('base64'),
          kekRef: wrapped.kekRef,
        },
      });
      this.dekCache.set(this.cacheKey(organizationId, row.dekRef), dek);
      return { dekRef: row.dekRef, dek };
    } catch (e) {
      // Course concurrente (deux premiers encrypts) : la contrainte unique
      // (organizationId, status=ACTIVE) rejette le perdant (P2002) → on relit
      // le gagnant. Les deux DEK sont valides ; celle du perdant reste inutilisée.
      this.logger.warn(`DEK mint race for org ${organizationId}, re-reading winner`);
      const winner = await this.prisma.dataEncryptionKey.findFirst({
        where: { organizationId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
      if (winner) return { dekRef: winner.dekRef, dek: await this.unwrapRow(organizationId, winner) };
      throw e;
    }
  }

  /** Résout une DEK par référence (depuis le header v2), bornée au tenant. */
  private async dekByRef(organizationId: string, dekRef: string): Promise<Buffer> {
    const cached = this.dekCache.get(this.cacheKey(organizationId, dekRef));
    if (cached) return cached;
    const row = await this.prisma.dataEncryptionKey.findFirst({
      where: { organizationId, dekRef },
    });
    if (!row) throw new Error(`DEK introuvable (dekRef=${dekRef})`);
    return this.unwrapRow(organizationId, row);
  }

  private async unwrapRow(
    organizationId: string,
    row: { dekRef: string; wrappedKey: string; kekRef: string },
  ): Promise<Buffer> {
    const key = this.cacheKey(organizationId, row.dekRef);
    const cached = this.dekCache.get(key);
    if (cached) return cached;
    const dek = await this.keys.unwrapDek({
      kekRef: row.kekRef,
      wrapped: Buffer.from(row.wrappedKey, 'base64'),
    });
    // Rotation KEK paresseuse : si la DEK est wrappée sous une ancienne KEK,
    // on la re-wrappe sous la KEK active au passage (best-effort).
    await this.maybeRewrap(organizationId, row, dek);
    this.dekCache.set(key, dek);
    return dek;
  }

  /**
   * Re-wrappe une DEK sous la KEK active si elle ne l'est pas déjà. Best-effort :
   * un échec ne casse JAMAIS le déchiffrement (la DEK en clair est déjà résolue).
   */
  private async maybeRewrap(
    organizationId: string,
    row: { dekRef: string; kekRef: string },
    dek: Buffer,
  ): Promise<void> {
    const active = this.keys.activeKekRef();
    const from = row.kekRef;
    if (from === active) return;
    try {
      const wrapped = await this.keys.wrapDek(dek);
      await this.prisma.dataEncryptionKey.update({
        where: { organizationId_dekRef: { organizationId, dekRef: row.dekRef } },
        data: { wrappedKey: wrapped.wrapped.toString('base64'), kekRef: wrapped.kekRef },
      });
      this.logger.log(
        `DEK ${row.dekRef.slice(0, 8)} re-wrappée ${from}→${wrapped.kekRef} (org ${organizationId})`,
      );
    } catch (e) {
      this.logger.warn(
        `Re-wrap paresseux échoué pour DEK ${row.dekRef.slice(0, 8)} : ${(e as Error).message}`,
      );
    }
  }

  /**
   * Re-wrappe **toutes** les DEK du tenant sous la KEK active (rotation KEK
   * proactive). Ne touche jamais aux données chiffrées. Idempotent.
   */
  async rewrapAll(
    organizationId: string,
  ): Promise<{ rewrapped: number; total: number; activeKek: string }> {
    const active = this.keys.activeKekRef();
    const rows = await this.prisma.dataEncryptionKey.findMany({ where: { organizationId } });
    let rewrapped = 0;
    for (const row of rows) {
      if (row.kekRef === active) continue;
      const dek = await this.keys.unwrapDek({
        kekRef: row.kekRef,
        wrapped: Buffer.from(row.wrappedKey, 'base64'),
      });
      const wrapped = await this.keys.wrapDek(dek);
      await this.prisma.dataEncryptionKey.update({
        where: { organizationId_dekRef: { organizationId, dekRef: row.dekRef } },
        data: { wrappedKey: wrapped.wrapped.toString('base64'), kekRef: wrapped.kekRef },
      });
      this.dekCache.set(this.cacheKey(organizationId, row.dekRef), dek);
      rewrapped += 1;
    }
    return { rewrapped, total: rows.length, activeKek: active };
  }
}
