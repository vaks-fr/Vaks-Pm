import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

/**
 * MFA TOTP (RFC 6238) — 100% local, aucune dépendance externe.
 *
 * Pas de backup codes en v1 : si un user perd son authenticator, un admin
 * (`isAdmin = true`) doit lui reset le MFA via `adminReset()`. Garde-fou :
 * il faut au moins 1 admin qui ait gardé l'accès — d'où l'intérêt du
 * mécanisme break-glass (`User.allowLocalLogin`).
 */
@Injectable()
export class MfaService {
  private static readonly ISSUER = 'Vaks-PM';

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly audit: AuditLogService,
  ) {
    // Fenêtre de tolérance d'1 step (±30s) pour absorber les drifts d'horloge.
    authenticator.options = { window: 1 };
  }

  /**
   * Démarre l'enrôlement : génère un secret, l'enregistre chiffré, renvoie
   * le QR code à scanner. L'user n'est PAS encore considéré MFA-enabled tant
   * qu'il n'a pas validé un code via `verifyEnrollment`.
   */
  async startEnrollment(userId: string): Promise<{ qrCodeDataUrl: string; secret: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA déjà activé');
    }
    const secret = authenticator.generateSecret(); // Base32, 32 chars
    const otpauth = authenticator.keyuri(user.email, MfaService.ISSUER, secret);
    const qrCodeDataUrl = await qrcode.toDataURL(otpauth);
    // On stocke immédiatement le secret chiffré (mfaEnabled reste false).
    // Si l'user abandonne en cours de route, le secret reste latent — il sera
    // écrasé lors d'un nouveau startEnrollment, ou nettoyé par adminReset.
    const mfaSecret = await this.tenantCrypto.encrypt(user.organizationId, secret);
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret },
    });
    return { qrCodeDataUrl, secret };
  }

  /** Confirme l'enrôlement : vérifie le code et active le MFA. */
  async verifyEnrollment(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw new BadRequestException('MFA déjà activé');
    if (!user.mfaSecret) throw new BadRequestException('Aucun enrôlement en cours');
    const secret = await this.tenantCrypto.decrypt(user.organizationId, user.mfaSecret);
    if (!authenticator.check(this.normalize(code), secret)) {
      throw new UnauthorizedException('Code invalide');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaEnforcedAt: user.mfaEnforcedAt ?? new Date() },
    });
    void this.audit.logCritical({
      organizationId: user.organizationId,
      action: AUDIT_ACTIONS.AUTH_MFA_ENROLLED,
      actorId: user.id,
      actorLabel: user.email,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
    });
  }

  /** Vérifie un code TOTP au login (post-mot-de-passe). */
  async verifyCode(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled || !user.mfaSecret) return false;
    const secret = await this.tenantCrypto.decrypt(user.organizationId, user.mfaSecret);
    return authenticator.check(this.normalize(code), secret);
  }

  /** Désactivation par l'user lui-même (post-vérif mot de passe côté controller). */
  async disable(userId: string): Promise<void> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaEnforcedAt: null },
    });
    void this.audit.logCritical({
      organizationId: user.organizationId,
      action: AUDIT_ACTIONS.AUTH_MFA_DISABLED,
      actorId: user.id,
      actorLabel: user.email,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
      detail: { by: 'self' },
    });
  }

  /** Reset par un admin (user a perdu son authenticator). */
  async adminReset(targetUserId: string, actor?: { id: string; email?: string }): Promise<void> {
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { mfaEnabled: false, mfaSecret: null, mfaEnforcedAt: null },
    });
    void this.audit.logCritical({
      organizationId: user.organizationId,
      action: AUDIT_ACTIONS.AUTH_MFA_DISABLED,
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? null,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email,
      detail: { by: 'admin_reset', targetEmail: user.email },
    });
  }

  private normalize(code: string): string {
    return code.replace(/\s+/g, '').trim();
  }
}
