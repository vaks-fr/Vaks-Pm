import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission, PERMISSIONS, permissionsForCapabilities } from '@vaks-pm/shared';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { PROJECT_ACCESS_KEY, ProjectAccessSource } from './project-access.decorator';
import { RbacService } from './rbac.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
  ) {}

  /** `body.<key>` uniquement pour les routes déclarant `fromProjectBody(key)`. */
  private projectIdFromDeclaredBody(
    ctx: ExecutionContext,
    req: { body?: Record<string, unknown> },
  ): string | undefined {
    const sources =
      this.reflector.getAllAndOverride<ProjectAccessSource[] | undefined>(PROJECT_ACCESS_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];
    for (const s of sources) {
      if (s.kind !== 'project' || s.in !== 'body') continue;
      const v = req.body?.[s.key];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Non authentifié');

    // projectId / teamId : le scope projet/équipe des permissions est lu dans
    // les params d'URL. SÉCURITÉ — le body n'est honoré QUE si la route déclare
    // explicitement une source `@ProjectAccess(fromProjectBody(...))` : les
    // guards tournent avant le ValidationPipe et express.json parse aussi le
    // corps d'un DELETE, donc lire `req.body.projectId` partout permettait à un
    // PM du projet X d'emporter ses droits projet (task:delete, allocation:manage…)
    // sur une route visant une entité du projet Y en glissant `{"projectId": X}`.
    const projectId = req.params?.projectId ?? this.projectIdFromDeclaredBody(ctx, req);
    const teamId = req.params?.teamId;

    // Jeton d'API : droits = scopes du jeton (ORG) ou RBAC du user ∩ scopes
    // (USER). On NE court-circuite PAS sur isAdmin si le jeton est restreint.
    if (user.viaApiToken) {
      let effective: Set<Permission>;
      if (user.isOrgToken) {
        effective = new Set<Permission>(user.tokenScopes ?? []);
      } else {
        const base = user.isAdmin
          ? new Set<Permission>(PERMISSIONS as readonly Permission[])
          : await this.rbac.getEffectivePermissions(user.userId, user.orgId, projectId, teamId);
        const scopes: Permission[] = user.tokenScopes ?? [];
        effective = scopes.length ? new Set([...base].filter((p) => scopes.includes(p))) : base;
        // Agent IA : droits = RBAC ∩ scopes ∩ permissions dérivées des
        // capabilities (dérivation vivante — jamais de hardcode par agent).
        // Un agent sans capability n'a AUCUN droit.
        if (user.actorKind === 'AGENT') {
          const capPerms = new Set(permissionsForCapabilities(user.capabilities ?? []));
          effective = new Set([...effective].filter((p) => capPerms.has(p)));
        }
      }
      if (!required.every((p) => effective.has(p))) {
        throw new ForbiddenException('Scope du jeton insuffisant');
      }
      return true;
    }

    if (user.isAdmin) return true;

    // Cache request-scoped : un même handler peut être traversé par plusieurs
    // guards/intercepteurs ; on évite les requêtes DB redondantes pour
    // (userId, orgId, projectId, teamId) sur la durée de la requête HTTP.
    const cacheKey = `${user.userId}|${user.orgId}|${projectId ?? ''}|${teamId ?? ''}`;
    const cache: Map<string, Set<Permission>> = (req._rbacPermCache ??= new Map());
    let effective = cache.get(cacheKey);
    if (!effective) {
      effective = await this.rbac.getEffectivePermissions(
        user.userId,
        user.orgId,
        projectId,
        teamId,
      );
      cache.set(cacheKey, effective);
    }

    const ok = required.every((p) => effective!.has(p));
    if (!ok) throw new ForbiddenException('Permission insuffisante');
    return true;
  }
}
