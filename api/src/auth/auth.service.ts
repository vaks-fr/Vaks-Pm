import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { MfaService } from './mfa.service';
import { PasswordPolicyService } from './password-policy.service';
import { AuthTokens } from '@vaks-pm/shared';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AuditAlertsService } from '../audit-logs/audit-alerts.service';
import { AUDIT_ACTIONS, severityForAction } from '../audit-logs/audit-actions';

export interface JwtPayload {
  sub: string;
  orgId: string;
  email: string;
  isAdmin: boolean;
  /** Siège de licence (open-core). `false` = compte sans siège : accès dashboard
   *  refusé par `JwtAuthGuard` (seul /me, /auth et — si admin — /admin restent
   *  accessibles). Gravé dans le JWT comme `isAdmin` : un changement de siège
   *  prend effet au prochain refresh (le retrait coupe en plus les sessions). */
  licensed: boolean;
  /** Slug du tenant (mode pooled) résolu depuis le Host à l'émission. Sert de
   *  frontière de confiance : une cellule data-only refuse un token dont le
   *  `tenant` ne matche pas le Host. Absent en mode `dedicated`. */
  tenant?: string;
}

/** L'user a MFA activé : doit fournir un code TOTP via /auth/login/mfa. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string; // JWT court (5 min), passé à /auth/login/mfa
}

/** La policy force MFA mais l'user n'a pas encore enrollé : UI doit afficher
 *  le QR via /auth/mfa/forced-enroll/start avec l'enrollToken. */
export interface MfaEnrollmentRequiredResponse {
  mfaEnrollmentRequired: true;
  enrollToken: string; // JWT court (5 min), scope = mfa-enroll
  email: string; // utile pour l'UI (label du compte dans l'app authenticator)
}

export type LoginResult =
  | AuthTokens
  | MfaChallengeResponse
  | MfaEnrollmentRequiredResponse;

/** Erreur typée : l'user ne peut pas se connecter en local (SSO obligatoire). */
export class SsoRequiredException extends ForbiddenException {
  constructor() {
    super({ error: 'SSO_REQUIRED', message: 'Veuillez vous connecter via SSO.' });
  }
}

@Injectable()
export class AuthService {
  // Défauts si la policy org n'est pas définie.
  private static readonly LOCKOUT_MAX_ATTEMPTS_DEFAULT = 5;
  private static readonly LOCKOUT_DURATION_MIN_DEFAULT = 15;
  private static readonly MFA_CHALLENGE_TTL_SEC = 300; // 5 min

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mfa: MfaService,
    private readonly settings: AdminSettingsService,
    private readonly policy: PasswordPolicyService,
    private readonly tenantCtx: TenantContext,
    private readonly tenantConn: TenantConnectionService,
    private readonly audit: AuditLogService,
    private readonly alerts: AuditAlertsService,
  ) {}

  /** Trace d'audit auth (fire-and-forget — n'ajoute aucune latence au login).
   *  NB : un échec sur email inconnu n'est PAS journalisé — sans ligne User on
   *  ne sait pas attribuer d'organisation (et on n'écrit pas les emails tentés
   *  d'inconnus, vecteur de pollution du journal). */
  private auditAuth(
    action: string,
    user: { id?: string; organizationId: string; email?: string },
    opts: {
      outcome?: 'SUCCESS' | 'FAILURE';
      detail?: unknown;
      meta?: { userAgent?: string; ipAddress?: string };
    } = {},
  ): Promise<void> {
    const outcome = opts.outcome ?? 'SUCCESS';
    // Sévérité pilotée par la table centrale (cf. AUDIT_SEVERITY). Cas
    // dynamique : un rejeu de refresh token révoqué est un signal de vol →
    // CRITICAL (l'expiration bénigne reste WARNING).
    let severity = severityForAction(action, outcome);
    const reason =
      opts.detail && typeof opts.detail === 'object'
        ? (opts.detail as Record<string, unknown>).reason
        : undefined;
    if (action === AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED && reason === 'revoked_token_replayed') {
      severity = 'CRITICAL';
    }
    const entry = {
      organizationId: user.organizationId,
      action,
      severity,
      outcome,
      actorType: (user.id ? 'USER' : 'ANONYMOUS') as 'USER' | 'ANONYMOUS',
      actorId: user.id ?? null,
      actorLabel: user.email ?? null,
      resourceType: 'user',
      resourceId: user.id ?? null,
      resourceLabel: user.email ?? null,
      ip: opts.meta?.ipAddress,
      userAgent: opts.meta?.userAgent,
      detail: opts.detail,
    };
    // Écriture immédiate pour les faits de sécurité (échecs — relus aussitôt par
    // la détection brute-force — et événements CRITICAL). Les succès de routine
    // (login/logout/refresh) sont bufferisés : fort volume, désormais en INFO.
    // On retourne la promesse pour pouvoir chaîner (ex. brute-force APRÈS
    // persistance de l'échec) — les autres call-sites restent en `void`.
    if (outcome === 'FAILURE' || severity === 'CRITICAL') {
      return this.audit.logNow(entry);
    }
    this.audit.log(entry);
    return Promise.resolve();
  }

  /** Metadata client capturée à la couche controller. Tronquée côté backend
   *  avant insertion (UA -> 500, IP -> 64). */
  static cleanMeta(meta?: { userAgent?: string; ipAddress?: string }) {
    return {
      userAgent: meta?.userAgent ? meta.userAgent.slice(0, 500) : null,
      ipAddress: meta?.ipAddress ? meta.ipAddress.slice(0, 64) : null,
    };
  }

  /**
   * L'isolation multi-tenant est portée par la **connexion** : en mode `pooled`,
   * le middleware a déjà lié `PrismaService` à la base du tenant (résolu depuis
   * le Host), donc `findFirst({ email })` ne voit que les users de ce tenant.
   * En mode `dedicated`, c'est la base unique (comportement historique).
   */
  async login(
    email: string,
    password: string,
    meta?: { userAgent?: string; ipAddress?: string },
  ): Promise<LoginResult> {
    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null, status: 'ACTIVE' },
    });
    // Réponse uniforme pour ne pas révéler quels emails existent.
    if (!user) throw new UnauthorizedException('Identifiants invalides');

    // Un agent IA n'a JAMAIS de session interactive : son seul chemin d'accès
    // est un jeton API (PAT). Réponse uniforme (ne révèle pas la nature du compte).
    if (user.kind === 'AGENT') {
      void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGIN_FAILURE, user, {
        outcome: 'FAILURE',
        detail: { reason: 'agent_account' },
        meta,
      });
      throw new UnauthorizedException('Identifiants invalides');
    }

    // 1. Lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGIN_FAILURE, user, {
        outcome: 'FAILURE',
        detail: { reason: 'locked_out' },
        meta,
      }).then(() =>
        this.alerts.checkLoginFailures(
          user.organizationId,
          user.id,
          user.email,
          meta?.ipAddress,
        ),
      );
      throw new UnauthorizedException(
        `Compte temporairement verrouillé jusqu'à ${user.lockedUntil.toISOString()}`,
      );
    }

    // 2. SSO gate. Un compte break-glass (`allowLocalLogin`) passe TOUJOURS.
    //    Sinon : un compte LOCAL peut se connecter au mot de passe, SAUF si
    //    l'org impose le SSO (`security.ssoOnly`) — dans ce cas seuls les
    //    break-glass gardent le login local. Un compte OIDC/SAML sans
    //    break-glass est de toute façon refusé.
    const orgSettings = await this.settings.getAll(user.organizationId);
    const ssoOnly = orgSettings['security.ssoOnly'] === true;
    const canLoginLocally =
      user.allowLocalLogin === true ||
      (user.authProvider === 'LOCAL' && !ssoOnly);
    if (!canLoginLocally) {
      void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGIN_FAILURE, user, {
        outcome: 'FAILURE',
        detail: { reason: 'sso_required' },
        meta,
      });
      throw new SsoRequiredException();
    }

    // 3. Vérif mot de passe
    if (!user.passwordHash) throw new UnauthorizedException('Identifiants invalides');
    const passwordOk = await argon2.verify(user.passwordHash, password);
    if (!passwordOk) {
      await this.registerFailedAttempt(user.id, user.organizationId);
      // Détection brute-force APRÈS persistance de l'échec (le count inclut
      // l'événement courant). Fire-and-forget intégral, fail-open.
      void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGIN_FAILURE, user, {
        outcome: 'FAILURE',
        detail: { reason: 'bad_password' },
        meta,
      }).then(() =>
        this.alerts.checkLoginFailures(
          user.organizationId,
          user.id,
          user.email,
          meta?.ipAddress,
        ),
      );
      throw new UnauthorizedException('Identifiants invalides');
    }

    // 4. MFA — obligatoire si activé sur le user, OU si break-glass (allowLocalLogin),
    //    OU si la policy org force MFA sur tous les LOCAL.
    const mfaRequired = await this.isMfaRequired(user);
    if (mfaRequired && !user.mfaEnabled) {
      // L'user a un mot de passe valide mais n'a pas encore enrollé MFA.
      // On lui accorde un token court limité à l'enrôlement MFA, et on signale
      // explicitement à l'UI qu'il faut afficher le QR (pas un champ code).
      const enrollToken = await this.jwt.signAsync(
        { sub: user.id, orgId: user.organizationId, scope: 'mfa-enroll' },
        {
          secret: this.config.get('jwt').accessSecret,
          expiresIn: AuthService.MFA_CHALLENGE_TTL_SEC,
        },
      );
      await this.resetFailedAttempts(user.id);
      return {
        mfaEnrollmentRequired: true,
        enrollToken,
        email: user.email,
      };
    }
    if (user.mfaEnabled) {
      const challengeToken = await this.jwt.signAsync(
        { sub: user.id, orgId: user.organizationId, scope: 'mfa-challenge' },
        {
          secret: this.config.get('jwt').accessSecret,
          expiresIn: AuthService.MFA_CHALLENGE_TTL_SEC,
        },
      );
      return { mfaRequired: true, challengeToken };
    }

    // 5. Reset compteur + check expiry policy (LOCAL users uniquement)
    await this.resetFailedAttempts(user.id);
    await this.applyExpiryPolicy(user);
    void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS, user, { meta });
    return this.issueTokens({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      isAdmin: user.isAdmin,
      licensed: user.licensed,
    }, meta);
  }

  /**
   * Vérifie l'expiration et flag `mustChangePassword` si dépassée. On laisse
   * quand même passer le login : l'UI gate l'accès à l'app via ce flag et
   * affiche un écran "Change password" obligatoire avant tout autre appel.
   *
   * S'applique uniquement aux comptes `authProvider === 'LOCAL'`. Les comptes
   * break-glass (`authProvider != LOCAL` avec `allowLocalLogin = true`) sont
   * EXEMPTÉS : un compte d'urgence ne doit jamais expirer, sinon on se locke
   * out de l'org au moment où on en a le plus besoin (panne SSO).
   */
  private async applyExpiryPolicy(user: {
    id: string;
    organizationId: string;
    authProvider: string;
    passwordChangedAt: Date | null;
    createdAt: Date;
  }): Promise<void> {
    if (user.authProvider !== 'LOCAL') return;
    const p = await this.policy.resolve(user.organizationId);
    if (this.policy.isExpired(p, user.passwordChangedAt, user.createdAt)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { mustChangePassword: true },
      });
    }
  }

  /** Étape 2 du login : vérifie le code TOTP et émet les tokens. */
  async completeMfaLogin(challengeToken: string, code: string, meta?: { userAgent?: string; ipAddress?: string }): Promise<AuthTokens> {
    let payload: { sub: string; orgId: string; scope: string };
    try {
      payload = await this.jwt.verifyAsync(challengeToken, {
        secret: this.config.get('jwt').accessSecret,
      });
    } catch {
      throw new UnauthorizedException('Challenge MFA expiré');
    }
    if (payload.scope !== 'mfa-challenge') {
      throw new UnauthorizedException('Challenge MFA invalide');
    }
    const ok = await this.mfa.verifyCode(payload.sub, code);
    if (!ok) {
      void this.auditAuth(
        AUDIT_ACTIONS.AUTH_MFA_FAILURE,
        { id: payload.sub, organizationId: payload.orgId },
        { outcome: 'FAILURE', meta },
      );
      throw new UnauthorizedException('Code MFA invalide');
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: payload.sub },
    });
    await this.resetFailedAttempts(user.id);
    await this.applyExpiryPolicy(user);
    void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS, user, {
      detail: { mfa: true },
      meta,
    });
    return this.issueTokens({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      isAdmin: user.isAdmin,
      licensed: user.licensed,
    }, meta);
  }

  /** Détermine si MFA doit être présent pour cet user. */
  async isMfaRequired(user: {
    authProvider: string;
    allowLocalLogin: boolean;
    organizationId: string;
  }): Promise<boolean> {
    // Break-glass : MFA toujours obligatoire (c'est le prix du bypass SSO).
    if (user.authProvider !== 'LOCAL' && user.allowLocalLogin) return true;
    // LOCAL : suit la policy org `security.requireMfa` (toggle dans Admin).
    if (user.authProvider === 'LOCAL') {
      const all = await this.settings.getAll(user.organizationId);
      const v = all['security.requireMfa'] ?? all['mfa'];
      return v === true;
    }
    return false;
  }

  private async registerFailedAttempt(userId: string, orgId: string): Promise<void> {
    const all = await this.settings.getAll(orgId);
    const maxAttempts =
      typeof all['security.lockoutMaxAttempts'] === 'number'
        ? (all['security.lockoutMaxAttempts'] as number)
        : AuthService.LOCKOUT_MAX_ATTEMPTS_DEFAULT;
    const durationMin =
      typeof all['security.lockoutDurationMinutes'] === 'number'
        ? (all['security.lockoutDurationMinutes'] as number)
        : AuthService.LOCKOUT_DURATION_MIN_DEFAULT;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const next = user.failedLoginAttempts + 1;
    const shouldLock = next >= maxAttempts;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: shouldLock ? 0 : next,
        lockedUntil: shouldLock
          ? new Date(Date.now() + durationMin * 60_000)
          : user.lockedUntil,
      },
    });
  }

  private async resetFailedAttempts(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  private async issueTokens(
    payload: JwtPayload,
    meta?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthTokens> {
    const jwtCfg = this.config.get('jwt');
    // Stamp central du claim `tenant` (slug résolu depuis le Host en pooled) :
    // tous les chemins d'émission (login, MFA, refresh, forced-enroll) passent
    // ici → le control-plane signe systématiquement le tenant. Null en
    // dedicated (pas de contexte) → claim absent, comportement inchangé.
    const tenant = this.tenantCtx.currentSlug();
    const fullPayload: JwtPayload = tenant ? { ...payload, tenant } : payload;
    const accessToken = await this.jwt.signAsync(fullPayload, {
      secret: jwtCfg.accessSecret,
      expiresIn: jwtCfg.accessTtl,
    });
    const refreshRaw = randomBytes(48).toString('hex');
    const tokenHash = createHash('sha256').update(refreshRaw).digest('hex');
    const cleaned = AuthService.cleanMeta(meta);
    await this.prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash,
        expiresAt: new Date(Date.now() + jwtCfg.refreshTtl * 1000),
        lastActivityAt: new Date(),
        userAgent: cleaned.userAgent,
        ipAddress: cleaned.ipAddress,
      },
    });
    return { accessToken, refreshToken: refreshRaw };
  }

  async refresh(refreshRaw: string, meta?: { userAgent?: string; ipAddress?: string }): Promise<AuthTokens> {
    const tokenHash = createHash('sha256').update(refreshRaw).digest('hex');
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Replay d'un refresh token déjà révoqué = signal de vol potentiel.
      // (Token inconnu : pas d'attribution possible, pas de trace.)
      if (stored) {
        const u = await this.prisma.user.findUnique({
          where: { id: stored.userId },
          select: { id: true, organizationId: true, email: true },
        });
        if (u) {
          void this.auditAuth(AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED, u, {
            outcome: 'FAILURE',
            detail: { reason: stored.revokedAt ? 'revoked_token_replayed' : 'expired' },
            meta,
          });
        }
      }
      throw new UnauthorizedException('Refresh token invalide');
    }
    // Idle timeout : si l'écart depuis la dernière activité dépasse la policy,
    // on révoque la session — l'user devra refaire un login complet.
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });
    // Ceinture : un agent n'a jamais de refresh token (login déjà bloqué),
    // mais un compte humain converti en agent ne doit pas garder sa session.
    if (user.kind === 'AGENT') throw new UnauthorizedException('Refresh token invalide');
    const idleMin = await this.settings.getSessionIdleTimeoutMinutes(user.organizationId);
    if (idleMin > 0) {
      const idleMs = Date.now() - stored.lastActivityAt.getTime();
      if (idleMs > idleMin * 60_000) {
        await this.prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        });
        throw new UnauthorizedException('Session expirée (inactivité)');
      }
    }
    // OK : rotation classique du refresh token.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      isAdmin: user.isAdmin,
      licensed: user.licensed,
    }, meta);
  }

  async logout(refreshRaw: string): Promise<void> {
    const tokenHash = createHash('sha256').update(refreshRaw).digest('hex');
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, organizationId: true, email: true } } },
    });
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (stored?.user) {
      void this.auditAuth(AUDIT_ACTIONS.AUTH_LOGOUT, {
        id: stored.user.id,
        organizationId: stored.user.organizationId,
        email: stored.user.email,
      });
    }
  }

  /** Vérifie un mot de passe brut contre le hash stocké (utilisé pour gate
   * les opérations sensibles : disable MFA, change password). */
  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) return false;
    return argon2.verify(user.passwordHash, password);
  }

  /**
   * Changement de mot de passe par l'user lui-même. Vérif mot de passe courant
   * + check policy (longueur, complexité, historique) + révoque toutes les
   * autres sessions actives (best practice : un changement de mot de passe
   * invalide les sessions ouvertes ailleurs).
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) {
      throw new UnauthorizedException('Compte sans mot de passe (SSO).');
    }
    const ok = await argon2.verify(user.passwordHash, currentPassword);
    if (!ok) throw new UnauthorizedException('Mot de passe actuel invalide');
    // Empêcher new == current trivial avant même la policy.
    if (currentPassword === newPassword) {
      throw new UnauthorizedException('Le nouveau mot de passe doit être différent.');
    }
    // Policies (complexité, historique) : LOCAL uniquement.
    // Les break-glass / SSO sont exemptés pour ne pas se retrouver locked-out.
    const policyApplies = user.authProvider === 'LOCAL';
    if (policyApplies) {
      await this.policy.validateStrength(user.organizationId, newPassword);
      await this.policy.checkHistory(user.organizationId, user.id, newPassword);
    }
    const newHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        passwordChangedAt: new Date(),
        mustChangePassword: false,
      },
    });
    if (policyApplies) {
      await this.policy.recordHistory(user.organizationId, user.id, user.passwordHash);
    }
    // Révoque toutes les autres sessions (force re-login ailleurs).
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    void this.auditAuth(AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED, user);
  }

  // ============================================================
  // Réinitialisation de mot de passe par lien email (admin-triggered)
  // ============================================================

  private static readonly RESET_TTL_MS = 60 * 60 * 1000; // 1 heure
  private hashResetToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Crée un jeton de reset à usage unique pour `userId` et renvoie le **secret
   * en clair** (à mettre dans le lien email — jamais persisté). Invalide les
   * jetons précédents non utilisés du même user. Retourne aussi l'email cible.
   */
  async createPasswordResetToken(
    orgId: string,
    userId: string,
    actorId?: string,
  ): Promise<{ rawToken: string; email: string; name: string }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true, email: true, name: true, authProvider: true, allowLocalLogin: true },
    });
    if (!user) throw new UnauthorizedException('Utilisateur introuvable');
    // Reset = login local : refusé pour un compte SSO pur (sans break-glass).
    if (user.authProvider !== 'LOCAL' && !user.allowLocalLogin) {
      throw new ForbiddenException(
        'Compte SSO : la connexion locale est désactivée (activez le break-glass pour un reset).',
      );
    }
    // Invalide les jetons en cours (marqués utilisés) pour ne garder qu'un lien actif.
    await this.prisma.passwordResetToken.updateMany({
      where: { organizationId: orgId, userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        organizationId: orgId,
        userId,
        tokenHash: this.hashResetToken(rawToken),
        expiresAt: new Date(Date.now() + AuthService.RESET_TTL_MS),
        createdById: actorId ?? null,
      },
    });
    return { rawToken, email: user.email, name: user.name };
  }

  /**
   * Valide un jeton de reset (existe, non expiré, non utilisé). Lecture seule.
   * Pas d'`orgId` : le `tokenHash` est unique et la connexion est déjà liée au
   * bon tenant (résolution par Host) — l'org est dérivée du jeton.
   */
  async validatePasswordResetToken(
    rawToken: string,
  ): Promise<{ valid: boolean; email?: string }> {
    if (!rawToken) return { valid: false };
    const tok = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash: this.hashResetToken(rawToken),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!tok) return { valid: false };
    const user = await this.prisma.user.findFirst({
      where: { id: tok.userId, organizationId: tok.organizationId, deletedAt: null },
      select: { email: true },
    });
    return user ? { valid: true, email: user.email } : { valid: false };
  }

  /**
   * Consomme un jeton de reset et fixe le nouveau mot de passe (policy LOCAL
   * appliquée). Usage unique. Révoque les sessions existantes.
   */
  async consumePasswordReset(
    rawToken: string,
    newPassword: string,
  ): Promise<void> {
    const tok = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash: this.hashResetToken(rawToken),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!tok) throw new UnauthorizedException('Lien de réinitialisation invalide ou expiré.');
    const orgId = tok.organizationId;
    const user = await this.prisma.user.findFirst({
      where: { id: tok.userId, organizationId: orgId, deletedAt: null },
    });
    if (!user) throw new UnauthorizedException('Utilisateur introuvable');
    const policyApplies = user.authProvider === 'LOCAL';
    if (policyApplies) {
      await this.policy.validateStrength(orgId, newPassword);
      await this.policy.checkHistory(orgId, user.id, newPassword);
    }
    const newHash = await argon2.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash, passwordChangedAt: new Date(), mustChangePassword: false },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: tok.id },
        data: { usedAt: new Date() },
      }),
      // Révoque les sessions ouvertes (le reset doit invalider l'existant).
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    if (policyApplies) {
      await this.policy.recordHistory(orgId, user.id, user.passwordHash);
    }
    void this.auditAuth(AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED, user);
  }

  /** Décode un enroll-token (renvoyé quand l'user doit configurer MFA après login). */
  async verifyEnrollToken(token: string): Promise<{ userId: string; orgId: string }> {
    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get('jwt').accessSecret,
      });
      if (payload.scope !== 'mfa-enroll') throw new Error();
      return { userId: payload.sub, orgId: payload.orgId };
    } catch {
      throw new UnauthorizedException('Enroll token invalide ou expiré');
    }
  }

  /**
   * Révoque tous les refresh tokens "morts par inactivité" :
   * lastActivityAt + sessionTimeout(min) < now.
   * - Si `orgId` est fourni, scopé à cette org sur la **base courante** (lazy
   *   cleanup au listSessions, contexte tenant déjà posé par le middleware).
   * - Si `orgId` est null, c'est le **cron global** :
   *     · mode `dedicated` → base courante (1 seule base) ;
   *     · mode `pooled`    → **chaque base tenant** (`<db>_<slug>`), nettoyée
   *       dans son propre contexte ALS pour router `PrismaService` /
   *       `AdminSettingsService` dessus. Sans ça, le cron tournait hors contexte
   *       et ne touchait que la base de base — les sessions tenant ne mouraient
   *       jamais.
   *
   * Retourne le nombre total de tokens révoqués.
   */
  async cleanupStaleSessions(orgId?: string): Promise<number> {
    if (orgId) return this.revokeStaleForCurrentDb(orgId);

    const mode = this.config.get('deployment')?.mode;
    if (mode !== 'pooled') return this.revokeStaleForCurrentDb();

    // Pooled : énumère les bases tenant par convention de nommage `<db>_<slug>`
    // (pg_database est cluster-wide, lisible depuis n'importe quelle connexion).
    const base = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
    const baseDb = (base?.pathname.replace(/^\//, '') || 'vakspm');
    const rows = await this.prisma.$queryRawUnsafe<Array<{ datname: string }>>(
      // `\_` échappe le `_` (wildcard LIKE) → match strict sur le séparateur.
      `SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname <> $2`,
      `${baseDb}\\_%`,
      baseDb,
    );
    let total = 0;
    for (const { datname } of rows) {
      const slug = datname.slice(baseDb.length + 1);
      if (!slug) continue;
      try {
        const client = this.tenantConn.getClient({ id: slug, slug });
        total += await this.tenantCtx.run({ client, slug }, () =>
          this.revokeStaleForCurrentDb(),
        );
      } catch {
        // Base tenant injoignable / non provisionnée : on continue les autres.
      }
    }
    return total;
  }

  /**
   * Révoque les sessions inactives sur la **base actuellement liée au contexte**
   * (tenant courant en pooled, base globale en dedicated). Lit `sessionTimeout`
   * par org (défaut 60 min ; 0 = désactivé) et révoque en bloc via un seuil.
   */
  private async revokeStaleForCurrentDb(orgId?: string): Promise<number> {
    const orgs = orgId
      ? [{ id: orgId }]
      : await this.prisma.organization.findMany({ select: { id: true } });
    let total = 0;
    for (const org of orgs) {
      const idleMin = await this.settings.getSessionIdleTimeoutMinutes(org.id);
      if (idleMin <= 0) continue; // policy explicitement désactivée → on ne touche rien.
      const cutoff = new Date(Date.now() - idleMin * 60_000);
      const r = await this.prisma.refreshToken.updateMany({
        where: {
          revokedAt: null,
          lastActivityAt: { lt: cutoff },
          user: { organizationId: org.id },
        },
        data: { revokedAt: new Date() },
      });
      total += r.count;
    }
    return total;
  }

  /** Émet les tokens définitifs pour un user identifié — utilisé par le flow
   *  "forced enrollment" après que l'user a validé un code TOTP frais. */
  async issueTokensForUser(userId: string, meta?: { userAgent?: string; ipAddress?: string }): Promise<AuthTokens> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.issueTokens({
      sub: user.id,
      orgId: user.organizationId,
      email: user.email,
      isAdmin: user.isAdmin,
      licensed: user.licensed,
    }, meta);
  }
}
