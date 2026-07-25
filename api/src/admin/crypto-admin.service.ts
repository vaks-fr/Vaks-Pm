import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { KEY_PROVIDER, KeyProvider } from '../common/crypto/key-provider';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { SECRET_SETTINGS } from './admin-settings.service';

type Actor = { id?: string; email?: string };

/**
 * Gestion des clés de chiffrement (DORA — Workstream B). Deux rotations :
 *
 *  - **KEK** (`rewrapKeks`) : re-wrappe les DEK du tenant sous la KEK active.
 *    Ne touche JAMAIS aux données chiffrées (la DEK en clair est inchangée).
 *
 *  - **DEK** (`rotateDek`) : génère une DEK fraîche et **re-chiffre** les colonnes
 *    secrètes du tenant sous celle-ci (réponse à une compromission). Gardé,
 *    transactionnel, **reprenable** (une DEK RETIRED non purgée = rotation à finir).
 */
@Injectable()
export class CryptoAdminService {
  private readonly logger = new Logger(CryptoAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCrypto: TenantCryptoService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly audit: AuditLogService,
  ) {}

  /** État des clés : KEK active + distribution des DEK par KEK. */
  async status(orgId: string) {
    const deks = await this.prisma.dataEncryptionKey.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    const kekDistribution: Record<string, number> = {};
    for (const d of deks) kekDistribution[d.kekRef] = (kekDistribution[d.kekRef] ?? 0) + 1;
    return {
      activeKek: this.keys.activeKekRef(),
      deks: deks.map((d) => ({
        dekRef: d.dekRef,
        kekRef: d.kekRef,
        status: d.status,
        createdAt: d.createdAt,
      })),
      kekDistribution,
    };
  }

  /** Rotation KEK : re-wrappe toutes les DEK du tenant sous la KEK active. */
  async rewrapKeks(orgId: string, actor: Actor) {
    const result = await this.tenantCrypto.rewrapAll(orgId);
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CRYPTO_KEK_ROTATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'cryptoKey',
      detail: result, // { rewrapped, total, activeKek } — aucune matière de clé
    });
    return result;
  }

  /** Colonnes chiffrées du tenant (re-chiffrées à la rotation DEK). */
  private async reencryptColumns(orgId: string): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const reenc = async (blob: string): Promise<string> =>
      this.tenantCrypto.encrypt(orgId, await this.tenantCrypto.decrypt(orgId, blob));

    // 1. User.mfaSecret
    const users = await this.prisma.user.findMany({
      where: { organizationId: orgId, mfaSecret: { not: null } },
      select: { id: true, mfaSecret: true },
    });
    for (const u of users) {
      try {
        const next = await reenc(u.mfaSecret as string);
        await this.prisma.user.update({ where: { id: u.id }, data: { mfaSecret: next } });
        processed += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`re-enc mfaSecret user ${u.id} échoué: ${(e as Error).message}`);
      }
    }

    // 2. OrgSetting (clés secrètes …Enc)
    const encKeys = SECRET_SETTINGS.map((s) => s.encKey);
    const settings = await this.prisma.orgSetting.findMany({
      where: { organizationId: orgId, key: { in: encKeys } },
    });
    for (const s of settings) {
      const v = s.value;
      if (typeof v !== 'string' || !v) continue;
      try {
        const next = await reenc(v);
        await this.prisma.orgSetting.update({ where: { id: s.id }, data: { value: next } });
        processed += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`re-enc orgSetting ${s.key} échoué: ${(e as Error).message}`);
      }
    }

    // 3. TicketingConnector.secretEnc
    const conns = await this.prisma.ticketingConnector.findMany({
      where: { organizationId: orgId, secretEnc: { not: null } },
      select: { id: true, secretEnc: true },
    });
    for (const c of conns) {
      try {
        const next = await reenc(c.secretEnc as string);
        await this.prisma.ticketingConnector.update({ where: { id: c.id }, data: { secretEnc: next } });
        processed += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`re-enc connector ${c.id} échoué: ${(e as Error).message}`);
      }
    }

    // 4. IdentityProvider.oidcClientSecretEnc
    const idps = await this.prisma.identityProvider.findMany({
      where: { organizationId: orgId, oidcClientSecretEnc: { not: null } },
      select: { id: true, oidcClientSecretEnc: true },
    });
    for (const p of idps) {
      try {
        const next = await reenc(p.oidcClientSecretEnc as string);
        await this.prisma.identityProvider.update({
          where: { id: p.id },
          data: { oidcClientSecretEnc: next },
        });
        processed += 1;
      } catch (e) {
        failed += 1;
        this.logger.warn(`re-enc idp ${p.id} échoué: ${(e as Error).message}`);
      }
    }

    return { processed, failed };
  }

  /**
   * Rotation DEK : nouvelle DEK ACTIVE + re-chiffrement des secrets. Reprenable
   * (si une DEK RETIRED traîne d'une rotation interrompue). La RETIRED n'est
   * supprimée que si TOUTES les colonnes ont été re-chiffrées sans échec.
   */
  async rotateDek(orgId: string, actor: Actor) {
    const active = await this.prisma.dataEncryptionKey.findFirst({
      where: { organizationId: orgId, status: 'ACTIVE' },
    });
    const retired = await this.prisma.dataEncryptionKey.findFirst({
      where: { organizationId: orgId, status: 'RETIRED' },
    });

    let mode: 'fresh' | 'resume' | 'minted';
    if (retired) {
      // Reprise d'une rotation interrompue : la nouvelle ACTIVE existe déjà.
      mode = 'resume';
    } else if (!active) {
      // Aucune DEK : on en crée une fraîche, rien à re-chiffrer.
      const dek = await this.keys.generateDataKey();
      const w = await this.keys.wrapDek(dek);
      await this.prisma.dataEncryptionKey.create({
        data: { organizationId: orgId, wrappedKey: w.wrapped.toString('base64'), kekRef: w.kekRef },
      });
      mode = 'minted';
    } else {
      // Cas nominal : on rétrograde l'ACTIVE → RETIRED et on crée une nouvelle
      // ACTIVE dans une transaction (évite la fenêtre 0-ACTIVE vs unique).
      const dek = await this.keys.generateDataKey();
      const w = await this.keys.wrapDek(dek);
      await this.prisma.$transaction([
        this.prisma.dataEncryptionKey.update({
          where: { organizationId_dekRef: { organizationId: orgId, dekRef: active.dekRef } },
          data: { status: 'RETIRED' },
        }),
        this.prisma.dataEncryptionKey.create({
          data: { organizationId: orgId, wrappedKey: w.wrapped.toString('base64'), kekRef: w.kekRef },
        }),
      ]);
      mode = 'fresh';
    }

    const counts = mode === 'minted' ? { processed: 0, failed: 0 } : await this.reencryptColumns(orgId);

    // Purge de la RETIRED seulement si tout est migré sans échec.
    let retiredPurged = false;
    if (counts.failed === 0) {
      const del = await this.prisma.dataEncryptionKey.deleteMany({
        where: { organizationId: orgId, status: 'RETIRED' },
      });
      retiredPurged = del.count > 0;
    }

    const summary = { mode, ...counts, retiredPurged };
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CRYPTO_DEK_ROTATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'cryptoKey',
      detail: summary,
    });
    return summary;
  }
}
