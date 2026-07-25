import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { PasswordPolicyService } from './password-policy.service';
import { LoginDto, MfaLoginDto, MfaVerifyDto, RefreshDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginEnabledGuard } from './guards/login-enabled.guard';
import { SeatExempt } from './seat-exempt.decorator';
import { AuthUser, CurrentUser } from './current-user.decorator';
import { UsersService } from '../users/users.service';
import { RbacService } from '../rbac/rbac.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';

@ApiTags('auth')
@SeatExempt() // identité (/auth/me), logout, refresh, MFA : accessibles sans siège
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly users: UsersService,
    private readonly rbac: RbacService,
    private readonly prisma: PrismaService,
    private readonly policy: PasswordPolicyService,
    private readonly tenancy: TenancyService,
  ) {}

  /** Extrait UA + IP de la requête. IP : X-Forwarded-For (premier hop) en
   *  priorité car derrière Traefik, sinon req.ip. */
  private clientMeta(req: Request): { userAgent: string; ipAddress: string } {
    const xff = req.headers['x-forwarded-for'];
    const ipFromXff = Array.isArray(xff) ? xff[0] : (xff ?? '').split(',')[0]?.trim();
    return {
      userAgent: String(req.headers['user-agent'] ?? ''),
      ipAddress: ipFromXff || req.ip || '',
    };
  }

  /** Policy de mot de passe org-courante (longueur, complexité, history).
   *  L'UI consomme ça pour afficher les exigences sur l'écran change-password. */
  @Get('password-policy')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async getPasswordPolicy(@CurrentUser() user: AuthUser) {
    return this.policy.resolve(user.orgId);
  }

  /** 10 tentatives de login par minute par IP. Bloque credential stuffing
   *  + tentatives de bruteforce de mot de passe à grande échelle. */
  @Post('login')
  @UseGuards(LoginEnabledGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    // Multi-tenant : en mode `pooled`, le middleware a déjà lié la connexion à
    // la base du tenant (résolu depuis le Host) → le login y est scopé via la
    // connexion. On refuse juste un Host sans tenant. En `dedicated`, login
    // global (comportement on-premise inchangé).
    if (this.tenancy.mode === 'pooled') {
      const tenant = await this.tenancy.resolveFromHost(req.headers.host);
      if (!tenant) {
        throw new UnauthorizedException('Organisation introuvable pour ce domaine');
      }
    }
    return this.auth.login(dto.email, dto.password, this.clientMeta(req));
  }

  /** Étape 2 du login quand MFA est activé. Limite plus haute (30/min) car
   *  un user qui se trompe sur 1-2 chiffres re-soumet rapidement. */
  @Post('login/mfa')
  @UseGuards(LoginEnabledGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(200)
  loginMfa(@Body() dto: MfaLoginDto, @Req() req: Request) {
    return this.auth.completeMfaLogin(dto.challengeToken, dto.code, this.clientMeta(req));
  }

  @Post('refresh')
  @UseGuards(LoginEnabledGuard)
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, this.clientMeta(req));
  }

  @Post('logout')
  @UseGuards(LoginEnabledGuard)
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  /** Vérifie qu'un lien de reset est encore valide (public, résolu par Host). */
  @Get('password-reset')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async validateReset(
    @Query('token') token: string,
    @Req() req: Request,
  ) {
    if (this.tenancy.mode === 'pooled') {
      const tenant = await this.tenancy.resolveFromHost(req.headers.host);
      if (!tenant) throw new UnauthorizedException('Organisation introuvable pour ce domaine');
    }
    return this.auth.validatePasswordResetToken(token ?? '');
  }

  /** Consomme un lien de reset et fixe le nouveau mot de passe (public). */
  @Post('password-reset')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  async consumeReset(
    @Body() dto: { token?: string; newPassword?: string },
    @Req() req: Request,
  ) {
    if (this.tenancy.mode === 'pooled') {
      const tenant = await this.tenancy.resolveFromHost(req.headers.host);
      if (!tenant) throw new UnauthorizedException('Organisation introuvable pour ce domaine');
    }
    if (!dto?.token || !dto?.newPassword) {
      throw new BadRequestException('token et newPassword requis');
    }
    await this.auth.consumePasswordReset(dto.token, dto.newPassword);
    return { ok: true };
  }

  // -------------------- MFA enrôlement FORCÉ (post-login, policy on) --------------------
  // L'user vient de saisir email+password ; la policy force MFA et il n'a pas
  // encore enrollé. Ces routes acceptent l'`enrollToken` reçu en sortie de
  // /auth/login, PAS un access token complet — l'user ne peut rien faire
  // d'autre dans l'app tant qu'il n'a pas terminé l'enrôlement.

  @Post('mfa/forced-enroll/start')
  @UseGuards(LoginEnabledGuard)
  @HttpCode(200)
  async forcedEnrollStart(@Body() body: { enrollToken: string }) {
    const { userId } = await this.auth.verifyEnrollToken(body?.enrollToken);
    return this.mfa.startEnrollment(userId);
  }

  /** Vérifie le code ET émet directement les tokens d'auth — l'user passe en
   *  une étape de l'écran "scan QR" à la home. */
  @Post('mfa/forced-enroll/verify')
  @UseGuards(LoginEnabledGuard)
  @HttpCode(200)
  async forcedEnrollVerify(@Body() body: { enrollToken: string; code: string }, @Req() req: Request) {
    const { userId } = await this.auth.verifyEnrollToken(body?.enrollToken);
    await this.mfa.verifyEnrollment(userId, body?.code);
    return this.auth.issueTokensForUser(userId, this.clientMeta(req));
  }

  /** Changement de mot de passe par l'user (volontaire ou forcé par expiry/reset). */
  @Post('change-password')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    if (!body?.currentPassword || !body?.newPassword) {
      throw new BadRequestException('currentPassword et newPassword requis');
    }
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
  }

  // -------------------- MFA enrôlement (user authentifié) --------------------

  @Post('mfa/enroll/start')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  startMfaEnrollment(@CurrentUser() user: AuthUser) {
    return this.mfa.startEnrollment(user.userId);
  }

  @Post('mfa/enroll/verify')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async verifyMfaEnrollment(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaVerifyDto,
  ) {
    await this.mfa.verifyEnrollment(user.userId, dto.code);
  }

  /**
   * Désactivation MFA par l'user lui-même. Re-auth mot de passe obligatoire
   * (`{ code, password }`) — le code TOTP courant n'est PAS suffisant car
   * on veut prouver la possession du mot de passe.
   * Refus si l'org/le user a MFA obligatoire (break-glass ou policy).
   */
  @Post('mfa/disable')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async disableMfa(
    @CurrentUser() user: AuthUser,
    @Body() body: { password: string; code: string },
  ) {
    const fullUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
    });
    const mfaRequired = await this.auth.isMfaRequired(fullUser);
    if (mfaRequired) {
      throw new BadRequestException(
        'MFA est obligatoire pour ce compte (policy ou break-glass). Demandez à un admin de le reset si nécessaire.',
      );
    }
    if (!body?.password || !(await this.auth.verifyPassword(user.userId, body.password))) {
      throw new UnauthorizedException('Mot de passe invalide');
    }
    if (!body?.code || !(await this.mfa.verifyCode(user.userId, body.code))) {
      throw new UnauthorizedException('Code MFA invalide');
    }
    await this.mfa.disable(user.userId);
  }

  // ------------------------------------------------------------------------

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const full = await this.users.findOne(user.userId);
    if (!full) throw new NotFoundException('User not found');
    const perms = user.isAdmin
      ? ['*']
      : Array.from(await this.rbac.getEffectivePermissions(user.userId, user.orgId));
    const managerCount = await this.prisma.projectMember.count({
      where: { userId: user.userId, role: { key: 'PROJECT_MANAGER' } },
    });
    // Team lead d'au moins une équipe (non supprimée) → autorisé à gérer les
    // congés des membres de cette équipe et à voir leur workload élargi.
    const leadCount = await this.prisma.teamMember.count({
      where: {
        userId: user.userId,
        isLead: true,
        team: { organizationId: user.orgId, deletedAt: null },
      },
    });
    const dbUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: {
        mfaEnabled: true,
        authProvider: true,
        allowLocalLogin: true,
        mustChangePassword: true,
      },
    });
    return {
      ...full,
      isAdmin: user.isAdmin,
      permissions: perms,
      managesAnyProject: user.isAdmin || managerCount > 0,
      isTeamLead: user.isAdmin || leadCount > 0,
      mfaEnabled: dbUser.mfaEnabled,
      authProvider: dbUser.authProvider,
      allowLocalLogin: dbUser.allowLocalLogin,
      mustChangePassword: dbUser.mustChangePassword,
    };
  }
}
