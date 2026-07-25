import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MfaService } from '../auth/mfa.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Audited, SkipAudit } from '../audit-logs/audited.decorator';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

/**
 * Endpoints admin pour la partie Security & Compliance :
 * - lister / révoquer les sessions actives (refresh tokens)
 * - force logout org-wide
 * - reset MFA d'un user (si perte d'authenticator)
 * - toggle break-glass (allowLocalLogin) sur un user
 *
 * Toutes les routes exigent `org:manage` (admin org).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/security')
export class AdminSecurityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Liste les sessions actives (refresh tokens non révoqués/non expirés). */
  @Get('sessions')
  @RequirePermissions('org:manage')
  async listSessions(@CurrentUser() user: AuthUser) {
    // Nettoie d'abord les sessions "mortes par inactivité" pour ne pas les
    // afficher comme actives — le filtre sur lastActivityAt fait le reste.
    await this.auth.cleanupStaleSessions(user.orgId);
    const sessions = await this.prisma.refreshToken.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { organizationId: user.orgId },
      },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      userEmail: s.user.email,
      userName: s.user.name,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastActivityAt: s.lastActivityAt,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
    }));
  }

  /** Révoque une session précise. */
  @Delete('sessions/:id')
  @RequirePermissions('org:manage')
  @HttpCode(204)
  @Audited(AUDIT_ACTIONS.SECURITY_SESSION_REVOKED, { resource: 'session', severity: 'CRITICAL' })
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const tok = await this.prisma.refreshToken.findUnique({
      where: { id },
      include: { user: { select: { organizationId: true } } },
    });
    if (!tok || tok.user.organizationId !== user.orgId) {
      throw new ForbiddenException();
    }
    await this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /** Force la déconnexion de tous les utilisateurs de l'organisation. */
  @Post('force-logout-all')
  @RequirePermissions('org:manage')
  @HttpCode(200)
  @Audited(AUDIT_ACTIONS.SECURITY_FORCE_LOGOUT_ALL, { resource: 'organization', severity: 'CRITICAL' })
  async forceLogoutAll(@CurrentUser() user: AuthUser) {
    const now = new Date();
    const r = await this.prisma.refreshToken.updateMany({
      where: {
        revokedAt: null,
        user: { organizationId: user.orgId },
      },
      data: { revokedAt: now },
    });
    // « Token epoch » : invalide aussi tous les access tokens JWT déjà émis
    // (sinon ils restent valides jusqu'à expiration ~15 min). JwtStrategy
    // rejette tout token dont `iat < sessionsRevokedAt`.
    await this.prisma.organization.update({
      where: { id: user.orgId },
      data: { sessionsRevokedAt: now },
    });
    return { revokedCount: r.count };
  }

  /**
   * Reset le MFA d'un user (perte d'authenticator). N'envoie pas d'email à
   * l'user — laissé à la phase notifications/SIEM.
   */
  @Post('users/:id/mfa/reset')
  @RequirePermissions('org:manage')
  @HttpCode(204)
  @SkipAudit() // hook explicite `auth.mfa.disabled` (by: admin_reset) dans MfaService
  async resetUserMfa(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: user.orgId, deletedAt: null },
    });
    if (!target) throw new ForbiddenException();
    await this.mfa.adminReset(id, { id: user.userId, email: user.email });
  }

  /**
   * Envoie un lien de réinitialisation de mot de passe à l'utilisateur (#3).
   * L'admin ne voit jamais le mot de passe. Lien usage-unique, valable 1 h,
   * pointant sur le **même Host** que la requête → bon tenant en mode pooled.
   */
  @Post('users/:id/password-reset')
  @RequirePermissions('member:manage')
  @HttpCode(200)
  @Audited(AUDIT_ACTIONS.SECURITY_PASSWORD_RESET_LINK, { resource: 'user', severity: 'CRITICAL' })
  async sendPasswordReset(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const { rawToken, email, name } = await this.auth.createPasswordResetToken(
      user.orgId,
      id,
      user.userId,
    );
    const proto =
      (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || 'https';
    const host = req.headers.host;
    const resetUrl = `${proto}://${host}/reset-password?token=${rawToken}`;
    await this.notifications.sendPasswordReset(user.orgId, email, name, resetUrl, 60);
    return { sent: true };
  }

  /**
   * Toggle "break-glass" (allowLocalLogin) sur un user. Quand activé,
   * l'user peut se connecter par mot de passe même si authProvider != LOCAL.
   * MFA devient automatiquement obligatoire pour ce compte (enforcement
   * géré côté login flow, pas un flag à part).
   */
  @Post('users/:id/break-glass')
  @RequirePermissions('org:manage')
  @Audited(AUDIT_ACTIONS.SECURITY_BREAK_GLASS_TOGGLED, { resource: 'user', severity: 'CRITICAL' })
  async setBreakGlass(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
    @Req() req: Request,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: user.orgId, deletedAt: null },
    });
    if (!target) throw new ForbiddenException();
    const updated = await this.prisma.user.update({
      where: { id },
      data: { allowLocalLogin: body.enabled === true },
      select: { id: true, allowLocalLogin: true },
    });

    // Un break-glass n'est utilisable qu'avec un mot de passe local. Si on
    // l'active sur un compte SSO qui n'en a pas encore (`passwordHash` null),
    // on envoie automatiquement un lien de **définition** de mot de passe —
    // sinon l'admin devrait y penser séparément. Best-effort : un échec d'email
    // (SMTP non configuré) ne casse pas l'activation du break-glass.
    let setupLinkSent = false;
    if (body.enabled === true && !target.passwordHash) {
      try {
        const { rawToken, email, name } = await this.auth.createPasswordResetToken(
          user.orgId,
          id,
          user.userId,
        );
        const proto =
          (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || 'https';
        const host = req.headers.host;
        const resetUrl = `${proto}://${host}/reset-password?token=${rawToken}`;
        await this.notifications.sendPasswordReset(user.orgId, email, name, resetUrl, 60);
        setupLinkSent = true;
      } catch {
        // Email indisponible : le break-glass reste activé, l'admin pourra
        // renvoyer un lien manuellement (bouton « Send password reset »).
        setupLinkSent = false;
      }
    }
    // L'UI avertit si on a activé sur un compte sans mot de passe SANS réussir
    // à envoyer le lien (l'admin doit alors définir un mot de passe à la main).
    const passwordSetupNeeded =
      body.enabled === true && !target.passwordHash && !setupLinkSent;
    return { ...updated, setupLinkSent, passwordSetupNeeded };
  }
}
