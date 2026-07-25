import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoleScope, SYSTEM_ROLES } from '@vaks-pm/shared';
import type { Prisma } from '@db';

/**
 * Source de vérité pour les rôles système. Au boot, on s'assure que chaque
 * organisation existante a un enregistrement `Role` à jour pour chacun des
 * rôles système définis dans `SYSTEM_ROLES` (idempotent). Cela couvre les
 * DB pré-existantes où GLOBAL_PM ou GUEST n'avaient pas encore été créés.
 */
@Injectable()
export class RolesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    try {
      await this.renameLegacyKeys();
      await this.syncSystemRolesAcrossOrgs();
    } catch (e) {
      // Ne bloque pas le démarrage si la DB n'est pas prête (CI, tests).
      this.logger.warn(`Role sync skipped: ${(e as Error).message}`);
    }
  }

  /**
   * Migration douce des clés de rôles renommées. Évite d'avoir deux Role rows
   * en parallèle (l'ancien orphelin + le nouveau créé par l'upsert) — ce qui
   * laisserait les Memberships existantes pointer sur l'ancien.
   */
  private async renameLegacyKeys() {
    const renames: Array<{ from: string; to: string; name: string }> = [
      { from: 'GLOBAL_PM', to: 'PORTFOLIO_MANAGER', name: 'Portfolio Manager' },
    ];
    for (const r of renames) {
      // Si une row "to" existe déjà dans une org où "from" existe aussi,
      // basculer les Memberships sur "to" puis supprimer "from".
      const fromRows = await this.prisma.role.findMany({ where: { key: r.from } });
      for (const row of fromRows) {
        const existingTo = await this.prisma.role.findUnique({
          where: { organizationId_key: { organizationId: row.organizationId, key: r.to } },
        });
        if (existingTo) {
          await this.prisma.membership.updateMany({
            where: { roleId: row.id },
            data: { roleId: existingTo.id },
          });
          await this.prisma.projectMember.updateMany({
            where: { roleId: row.id },
            data: { roleId: existingTo.id },
          });
          await this.prisma.role.delete({ where: { id: row.id } });
          this.logger.log(`Migrated role ${r.from} → ${r.to} (org ${row.organizationId})`);
        } else {
          await this.prisma.role.update({
            where: { id: row.id },
            data: { key: r.to, name: r.name },
          });
          this.logger.log(`Renamed role ${r.from} → ${r.to} (org ${row.organizationId})`);
        }
      }
    }
  }

  /** Pour chaque org × chaque rôle système → upsert. */
  async syncSystemRolesAcrossOrgs() {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    let n = 0;
    for (const org of orgs) {
      for (const def of Object.values(SYSTEM_ROLES)) {
        await this.prisma.role.upsert({
          where: { organizationId_key: { organizationId: org.id, key: def.key } },
          update: {
            name: def.name,
            scope: def.scope as RoleScope,
            permissions: def.permissions as string[],
            isSystem: true,
          },
          create: {
            organizationId: org.id,
            key: def.key,
            name: def.name,
            scope: def.scope as RoleScope,
            permissions: def.permissions as string[],
            isSystem: true,
          },
        });
        n++;
      }
    }
    this.logger.log(`Synced ${n} system role rows across ${orgs.length} org(s)`);
  }

  /** Liste tous les rôles de l'org (système + customs futurs). */
  list(orgId: string) {
    return this.prisma.role.findMany({
      where: { organizationId: orgId },
      orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    });
  }

  /** Récupère un rôle par sa clé pour une org. */
  async findByKey(orgId: string, key: string) {
    const r = await this.prisma.role.findUnique({
      where: { organizationId_key: { organizationId: orgId, key } },
    });
    if (!r) throw new NotFoundException(`Role ${key} not found`);
    return r;
  }

  /**
   * Met à jour le rôle org (Membership) d'un user. Crée la Membership si
   * elle n'existe pas. Pour `ORG_ADMIN`, le caller doit aussi flipper
   * `user.isAdmin = true` côté UsersService — on ne touche pas le User ici.
   */
  async setOrgRole(orgId: string, userId: string, roleKey: string) {
    const role = await this.findByKey(orgId, roleKey);
    if (role.scope !== RoleScope.ORG) {
      throw new BadRequestException(`${roleKey} is a project-scoped role; assign it via project membership.`);
    }
    return this.prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      update: { roleId: role.id },
      create: { organizationId: orgId, userId, roleId: role.id },
      include: { role: { select: { id: true, key: true, name: true } } },
    });
  }

  /** Renvoie la clé du rôle org actuel du user (ou null s'il n'a pas de Membership). */
  async getOrgRoleKey(orgId: string, userId: string): Promise<string | null> {
    const m = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      include: { role: { select: { key: true } } },
    });
    return m?.role.key ?? null;
  }
}
