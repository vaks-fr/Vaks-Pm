import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth.service';
import { TenantContext } from '../../tenancy/tenant-context.service';
import { PrismaService } from '../../prisma/prisma.service';

/** Cache process du « token epoch » par org (force-logout-all). TTL 30 s pour
 *  ne pas taper la base à chaque requête : un force-logout devient effectif en
 *  ≤ 30 s sur chaque réplica, à coût ~nul sur le hot-path d'auth. */
const EPOCH_TTL_MS = 30_000;
const epochCache = new Map<string, { revokedMs: number; fetchedAt: number }>();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly tenantCtx: TenantContext,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('jwt').accessSecret,
    });
  }

  /**
   * Renvoie l'epoch de révocation (ms) de l'org, caché 30 s. 0 = jamais
   * révoqué. Fail-open : toute erreur DB (colonne absente pendant un rollout,
   * etc.) → 0, pour ne JAMAIS bloquer l'auth sur un incident d'infra.
   */
  private async revokedEpochMs(orgId: string): Promise<number> {
    const now = Date.now();
    const hit = epochCache.get(orgId);
    if (hit && now - hit.fetchedAt < EPOCH_TTL_MS) return hit.revokedMs;
    let revokedMs = 0;
    try {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { sessionsRevokedAt: true },
      });
      revokedMs = org?.sessionsRevokedAt ? org.sessionsRevokedAt.getTime() : 0;
    } catch {
      revokedMs = 0;
    }
    epochCache.set(orgId, { revokedMs, fetchedAt: now });
    return revokedMs;
  }

  // Ce que retourne validate() devient req.user
  async validate(payload: JwtPayload & { iat?: number; scope?: string }) {
    // SÉCURITÉ — Un token de session n'a JAMAIS de claim `scope`. Les tokens
    // intermédiaires `mfa-challenge` / `mfa-enroll` (émis après le mot de passe,
    // AVANT le 2ᵉ facteur) sont signés avec le même secret ; sans ce rejet ils
    // passeraient pour une session complète → contournement total de la MFA.
    // Ces tokens ne sont consommés que par les handlers dédiés
    // (`completeMfaLogin` / `verifyEnrollToken`), qui vérifient `scope` eux-mêmes.
    if (payload.scope) {
      throw new UnauthorizedException('Token non valable pour une session');
    }
    // Frontière de confiance (cellule data-only) : un token n'est valable que
    // pour le tenant de son Host. Le control-plane émet le JWT{tenant} ; ici on
    // refuse un token dont le claim `tenant` ne matche pas le Host résolu.
    // Tolérance : claim absent (mode dedicated / token legacy) → on laisse
    // passer ; seul un claim PRÉSENT et incohérent est rejeté.
    if (this.config.get('serviceRole') === 'data-plane') {
      const hostSlug = this.tenantCtx.currentSlug();
      if (hostSlug && payload.tenant && payload.tenant !== hostSlug) {
        throw new UnauthorizedException('Token émis pour un autre tenant');
      }
      // Force-logout-all instantané : rejette tout token émis avant l'epoch.
      // `iat` est en secondes (claim JWT standard).
      if (payload.iat) {
        const revokedMs = await this.revokedEpochMs(payload.orgId);
        if (revokedMs && payload.iat * 1000 < revokedMs) {
          throw new UnauthorizedException('Session révoquée (force-logout)');
        }
      }
    }
    return {
      userId: payload.sub,
      orgId: payload.orgId,
      email: payload.email,
      isAdmin: payload.isAdmin,
      // Siège de licence. Tolérance rollout : un token **legacy** (émis avant le
      // déploiement, claim absent) est traité comme licencié pour ne pas
      // verrouiller les sessions ouvertes ; au prochain refresh le claim est
      // présent. Seul `licensed === false` (explicite) bloque le dashboard.
      licensed: payload.licensed !== false,
    };
  }
}
