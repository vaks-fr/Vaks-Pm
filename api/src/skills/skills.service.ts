import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { CapacityService } from '../workload/capacity.service';

type PackSource = 'BUILTIN' | 'CUSTOM';

interface SkillPackDef {
  id: string;
  label: string;
  color: string | null;
  source: PackSource;
  skills: Array<{ name: string; description?: string }>;
}
import {
  CreateSkillDto,
  SetProjectSkillsDto,
  UpdateSkillDto,
  UpsertUserSkillDto,
} from './dto/skill.dto';

export interface CallerCtx {
  userId: string;
  isAdmin: boolean;
}

@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly access: ProjectAccessService,
    private readonly capacity: CapacityService,
  ) {}

  // ---------- Catalog ----------
  async list(orgId: string) {
    return this.prisma.skill.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  // ---------- Packs de compétences (catalogues prêts à l'emploi) ----------
  private packsDir(): string {
    const candidates = [
      path.join(process.cwd(), 'prisma', 'skill-packs'),
      path.join(__dirname, '..', '..', 'prisma', 'skill-packs'),
      '/app/api/prisma/skill-packs',
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* ignore */
      }
    }
    return candidates[0];
  }

  /** Packs livrés avec l'image (`api/prisma/skill-packs/*.json`). */
  private readBuiltinPacks(): SkillPackDef[] {
    const dir = this.packsDir();
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: SkillPackDef[] = [];
    for (const f of files.sort()) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push({
          id: raw.id || f.replace(/\.json$/, ''),
          label: raw.label || raw.id || f,
          color: raw.color ?? null,
          source: 'BUILTIN',
          skills: Array.isArray(raw.skills) ? raw.skills : [],
        });
      } catch {
        /* skip invalid pack file */
      }
    }
    return out;
  }

  /**
   * Packs enregistrés dynamiquement par l'API (table `SkillPack`).
   * Sert de point d'extension pour les intégrations (partenaires, modules
   * verticaux). À terme : exposé via PAT scopé `skills:write` (phase 9).
   */
  private async readCustomPacks(orgId: string): Promise<SkillPackDef[]> {
    const rows = await this.prisma.skillPack.findMany({
      where: { organizationId: orgId },
      orderBy: { packId: 'asc' },
    });
    return rows.map((r) => ({
      id: r.packId,
      label: r.label,
      color: r.color,
      source: 'CUSTOM' as PackSource,
      skills: Array.isArray(r.skills as unknown[])
        ? (r.skills as Array<{ name: string; description?: string }>)
        : [],
    }));
  }

  /** Merge builtin + DB-defined packs. Une collision d'id : la version DB l'emporte. */
  private async readPacks(orgId: string): Promise<SkillPackDef[]> {
    const builtin = this.readBuiltinPacks();
    const custom = await this.readCustomPacks(orgId);
    const map = new Map<string, SkillPackDef>();
    for (const p of builtin) map.set(p.id, p);
    for (const p of custom) map.set(p.id, p); // les customs écrasent les builtins de même id
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Récupère les scopes équipes par packId pour cette org.
   * Map<packId, teamIds[]>. Un packId absent de la map = pack org-wide.
   */
  async getPackTeamScopes(orgId: string): Promise<Map<string, string[]>> {
    const rows = await this.prisma.skillPackTeamScope.findMany({
      where: {
        organizationId: orgId,
        team: { deletedAt: null },
      },
      select: { packId: true, teamId: true },
    });
    const map = new Map<string, string[]>();
    for (const r of rows) {
      if (!map.has(r.packId)) map.set(r.packId, []);
      map.get(r.packId)!.push(r.teamId);
    }
    return map;
  }

  /** Liste les packs visibles par l'appelant + combien de leurs skills sont déjà installés. */
  async listPacks(orgId: string, caller: CallerCtx) {
    const packs = await this.readPacks(orgId);
    const [existing, scopes, ledTeamIds] = await Promise.all([
      this.prisma.skill.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { name: true },
      }),
      this.getPackTeamScopes(orgId),
      this.ledTeamIds(orgId, caller),
    ]);
    const have = new Set(existing.map((s) => s.name));
    const isAdmin = caller.isAdmin;
    const ledSet = new Set(ledTeamIds);
    const visible = packs.filter((p) => {
      const scope = scopes.get(p.id);
      if (!scope || scope.length === 0) return true; // org-wide
      if (isAdmin) return true; // admin voit tout
      return scope.some((t) => ledSet.has(t)); // lead d'une équipe de scope
    });
    return visible.map((p) => ({
      id: p.id,
      label: p.label,
      color: p.color,
      source: p.source,
      total: p.skills.length,
      seeded: p.skills.filter((s) => have.has(s.name)).length,
      teamScope: scopes.get(p.id) ?? [],
    }));
  }

  /** Équipes dont l'appelant est lead (vide pour admin pur — admin n'en a pas besoin). */
  private async ledTeamIds(orgId: string, caller: CallerCtx): Promise<string[]> {
    if (caller.isAdmin) return [];
    const rows = await this.prisma.teamMember.findMany({
      where: {
        userId: caller.userId,
        isLead: true,
        team: { organizationId: orgId, deletedAt: null },
      },
      select: { teamId: true },
    });
    return rows.map((r) => r.teamId);
  }

  /** Refuse l'écriture sur un pack scopé si l'appelant n'est ni admin ni lead d'une équipe de scope. */
  private async assertCanWritePack(orgId: string, packId: string, caller: CallerCtx) {
    if (caller.isAdmin) return;
    const scopes = await this.getPackTeamScopes(orgId);
    const scope = scopes.get(packId);
    if (!scope || scope.length === 0) return; // pack org-wide
    const led = new Set(await this.ledTeamIds(orgId, caller));
    if (!scope.some((t) => led.has(t))) {
      throw new ForbiddenException(
        "Ce pack est réservé à des équipes spécifiques. Demandez à un admin de vous y donner accès.",
      );
    }
  }

  /**
   * Injecte les skills d'un pack dans le catalogue de l'org.
   *
   * Comportement par défaut (`restoreDeleted=false`) :
   *   - crée les skills manquants,
   *   - met à jour description/couleur/catégorie des skills présents,
   *   - **respecte les suppressions utilisateur** : un skill avec `deletedAt`
   *     reste désactivé (ne resurgit pas).
   * Mode `restoreDeleted=true` : réactive en plus les skills désactivés —
   *   utilisé par l'action explicite « Re-synchroniser le pack ».
   */
  async applyPack(
    orgId: string,
    packId: string,
    caller: CallerCtx,
    opts: { restoreDeleted?: boolean } = {},
  ) {
    await this.assertCanWriteCatalog(orgId, caller);
    await this.assertCanWritePack(orgId, packId, caller);
    const pack = (await this.readPacks(orgId)).find((p) => p.id === packId);
    if (!pack) throw new NotFoundException('Pack introuvable');
    let created = 0;
    let updated = 0;
    let restored = 0;
    let skippedDisabled = 0;
    for (const s of pack.skills) {
      const name = (s.name ?? '').trim();
      if (!name) continue;
      const existing = await this.prisma.skill.findUnique({
        where: { organizationId_name: { organizationId: orgId, name } },
      });
      if (existing) {
        if (existing.deletedAt && !opts.restoreDeleted) {
          // Skill explicitement désactivé par un utilisateur : ne pas le ressusciter.
          skippedDisabled++;
          continue;
        }
        await this.prisma.skill.update({
          where: { id: existing.id },
          data: {
            description: s.description ?? null,
            color: pack.color,
            category: pack.label,
            ...(existing.deletedAt ? { deletedAt: null } : {}),
          },
        });
        if (existing.deletedAt) restored++;
        else updated++;
      } else {
        await this.prisma.skill.create({
          data: {
            organizationId: orgId,
            name,
            description: s.description ?? null,
            color: pack.color,
            category: pack.label,
          },
        });
        created++;
      }
    }

    // Auto-bind aux TeamSkill des équipes de scope (si pack scopé) — sinon
    // les compétences seraient "libres" (visibles partout) à cause de la règle
    // "skill sans équipe = assignable sur tous les projets".
    const scopes = await this.getPackTeamScopes(orgId);
    const scopeTeamIds = scopes.get(packId) ?? [];
    let autoBoundToTeams = 0;
    if (scopeTeamIds.length > 0) {
      const skillRows = await this.prisma.skill.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          name: { in: pack.skills.map((s) => s.name.trim()).filter(Boolean) },
        },
        select: { id: true },
      });
      for (const teamId of scopeTeamIds) {
        for (const sk of skillRows) {
          await this.prisma.teamSkill.upsert({
            where: { teamId_skillId: { teamId, skillId: sk.id } },
            update: {},
            create: { teamId, skillId: sk.id },
          });
        }
      }
      autoBoundToTeams = scopeTeamIds.length;
    }

    return {
      packId,
      label: pack.label,
      total: pack.skills.length,
      created,
      updated,
      restored,
      skippedDisabled,
      autoBoundToTeams,
    };
  }

  /**
   * Désinstalle un pack : désactive (soft delete) tous les skills du catalogue
   * dont le nom appartient au pack. Détache aussi des UserSkill / ProjectSkill /
   * TeamSkill / Task.requiredSkill, comme un delete individuel.
   */
  async removePack(orgId: string, packId: string, caller: CallerCtx) {
    await this.assertCanWriteCatalog(orgId, caller);
    await this.assertCanWritePack(orgId, packId, caller);
    const pack = (await this.readPacks(orgId)).find((p) => p.id === packId);
    if (!pack) throw new NotFoundException('Pack introuvable');
    const names = pack.skills.map((s) => (s.name ?? '').trim()).filter(Boolean);
    if (names.length === 0) return { packId, label: pack.label, removed: 0 };
    const targets = await this.prisma.skill.findMany({
      where: { organizationId: orgId, name: { in: names }, deletedAt: null },
      select: { id: true },
    });
    if (targets.length === 0) return { packId, label: pack.label, removed: 0 };
    const ids = targets.map((t) => t.id);
    await this.prisma.$transaction([
      this.prisma.task.updateMany({
        where: { organizationId: orgId, requiredSkillId: { in: ids } },
        data: { requiredSkillId: null, requiredSkillLevel: null },
      }),
      this.prisma.userSkill.deleteMany({ where: { skillId: { in: ids } } }),
      this.prisma.projectSkill.deleteMany({ where: { skillId: { in: ids } } }),
      this.prisma.teamSkill.deleteMany({ where: { skillId: { in: ids } } }),
      this.prisma.skill.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      }),
    ]);
    return { packId, label: pack.label, removed: ids.length };
  }

  // ---------- Scope équipes par pack (visibilité restreinte) ----------
  /** Liste les équipes auxquelles ce pack est réservé (vide = org-wide). */
  async getPackScope(orgId: string, packId: string) {
    const rows = await this.prisma.skillPackTeamScope.findMany({
      where: { organizationId: orgId, packId },
      include: { team: { select: { id: true, name: true, color: true } } },
      orderBy: { team: { name: 'asc' } },
    });
    return rows.map((r) => r.team);
  }

  /**
   * Définit les équipes propriétaires d'un pack. `teamIds = []` retire toute
   * restriction (le pack redevient org-wide). Réservé aux admins.
   */
  async setPackScope(
    orgId: string,
    packId: string,
    teamIds: string[],
    caller: CallerCtx,
  ) {
    if (!caller.isAdmin) {
      throw new ForbiddenException(
        "Seul un administrateur peut restreindre la visibilité d'un pack.",
      );
    }
    const ids = Array.from(new Set(teamIds));
    if (ids.length > 0) {
      const found = await this.prisma.team.count({
        where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
      });
      if (found !== ids.length) {
        throw new BadRequestException('Une ou plusieurs équipes invalides');
      }
    }
    // Avant de réécrire le scope, on identifie les équipes qui le QUITTENT.
    const before = await this.prisma.skillPackTeamScope.findMany({
      where: { organizationId: orgId, packId },
      select: { teamId: true },
    });
    const removedTeamIds = before
      .map((b) => b.teamId)
      .filter((tid) => !ids.includes(tid));

    await this.prisma.$transaction([
      this.prisma.skillPackTeamScope.deleteMany({
        where: { organizationId: orgId, packId },
      }),
      ...(ids.length
        ? [
            this.prisma.skillPackTeamScope.createMany({
              data: ids.map((teamId) => ({ organizationId: orgId, packId, teamId })),
            }),
          ]
        : []),
    ]);

    // Phase H : cleanup des TeamSkill auto-bound aux équipes qui quittent le
    // scope. On supprime UNIQUEMENT les liens vers des skills du pack — les
    // compétences ajoutées manuellement par le lead restent.
    if (removedTeamIds.length > 0) {
      const pack = (await this.readPacks(orgId)).find((p) => p.id === packId);
      if (pack && pack.skills.length > 0) {
        const names = pack.skills.map((s) => s.name);
        const packSkills = await this.prisma.skill.findMany({
          where: { organizationId: orgId, name: { in: names } },
          select: { id: true },
        });
        const packSkillIds = packSkills.map((s) => s.id);
        if (packSkillIds.length > 0) {
          await this.prisma.teamSkill.deleteMany({
            where: { teamId: { in: removedTeamIds }, skillId: { in: packSkillIds } },
          });
        }
      }
    }

    return this.getPackScope(orgId, packId);
  }

  // ---------- Packs dynamiques (registry API-extensible) ----------
  private static readonly PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

  /**
   * Enregistre ou met à jour la *définition* d'un pack custom pour cette org.
   * N'injecte pas les compétences au catalogue : il faut ensuite appeler
   * `applyPack(packId)` (ou cliquer « Installer » côté UI).
   *
   * Validation :
   *  - `packId` : slug ascii minuscule (`^[a-z0-9][a-z0-9_-]{0,63}$`)
   *  - `label` : 1–80 chars
   *  - `color` : null ou `#rrggbb`
   *  - `skills` : 1–500 entrées `{ name (1–80), description? (0–500) }`
   */
  async upsertCustomPack(
    orgId: string,
    caller: CallerCtx,
    dto: {
      id: string;
      label: string;
      color?: string | null;
      skills: Array<{ name: string; description?: string | null }>;
    },
  ) {
    await this.assertCanWriteCatalog(orgId, caller);
    const packId = (dto.id ?? '').trim();
    if (!SkillsService.PACK_ID_RE.test(packId)) {
      throw new BadRequestException(
        'id du pack : slug minuscule [a-z0-9_-], 1–64 caractères',
      );
    }
    const label = (dto.label ?? '').trim();
    if (!label || label.length > 80) {
      throw new BadRequestException('label requis (1–80 caractères)');
    }
    if (dto.color != null && !/^#[0-9a-fA-F]{6}$/.test(dto.color)) {
      throw new BadRequestException('color : format #rrggbb');
    }
    if (!Array.isArray(dto.skills) || dto.skills.length === 0) {
      throw new BadRequestException('skills : tableau non vide requis');
    }
    if (dto.skills.length > 500) {
      throw new BadRequestException('skills : 500 entrées max par pack');
    }
    const seen = new Set<string>();
    const cleanedSkills = dto.skills.map((s, i) => {
      const name = (s?.name ?? '').trim();
      if (!name || name.length > 80) {
        throw new BadRequestException(`skills[${i}].name requis (1–80)`);
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException(`skills[${i}] : doublon "${name}"`);
      }
      seen.add(key);
      const description = (s?.description ?? '').toString();
      if (description.length > 500) {
        throw new BadRequestException(`skills[${i}].description : 500 max`);
      }
      return { name, description: description || null };
    });

    const saved = await this.prisma.skillPack.upsert({
      where: { organizationId_packId: { organizationId: orgId, packId } },
      update: {
        label,
        color: dto.color ?? null,
        skills: cleanedSkills as unknown as Prisma.InputJsonValue,
        createdById: caller.userId,
      },
      create: {
        organizationId: orgId,
        packId,
        label,
        color: dto.color ?? null,
        skills: cleanedSkills as unknown as Prisma.InputJsonValue,
        createdById: caller.userId,
      },
    });
    return {
      id: saved.packId,
      label: saved.label,
      color: saved.color,
      source: 'CUSTOM' as PackSource,
      total: cleanedSkills.length,
      seeded: 0,
    };
  }

  /**
   * Supprime la définition d'un pack custom (sans toucher au catalogue).
   * Les compétences déjà installées via ce pack restent au catalogue ; pour
   * les retirer aussi, appeler d'abord `removePack(packId)` puis cette méthode.
   */
  async deleteCustomPackDefinition(
    orgId: string,
    packId: string,
    caller: CallerCtx,
  ) {
    await this.assertCanWriteCatalog(orgId, caller);
    const existing = await this.prisma.skillPack.findUnique({
      where: { organizationId_packId: { organizationId: orgId, packId } },
    });
    if (!existing) throw new NotFoundException('Pack custom introuvable');
    await this.prisma.skillPack.delete({ where: { id: existing.id } });
    return { packId, deleted: true };
  }

  /** Vrai si `caller` peut créer/renommer/supprimer un skill selon la policy
   *  org `skills.catalogWriteMode`. */
  async canWriteCatalog(orgId: string, caller: CallerCtx): Promise<boolean> {
    if (caller.isAdmin) return true;
    const mode = await this.settings.getSkillsCatalogWriteMode(orgId);
    if (mode === 'admin') return false;
    if (mode === 'everyone') return true;

    if (mode === 'portfolio_manager') {
      const m = await this.prisma.membership.findFirst({
        where: { organizationId: orgId, userId: caller.userId },
        select: { role: { select: { key: true } } },
      });
      return m?.role.key === 'PORTFOLIO_MANAGER';
    }
    if (mode === 'team_lead') {
      // PORTFOLIO_MANAGER cumulé + n'importe quel lead d'équipe.
      const m = await this.prisma.membership.findFirst({
        where: { organizationId: orgId, userId: caller.userId },
        select: { role: { select: { key: true } } },
      });
      if (m?.role.key === 'PORTFOLIO_MANAGER') return true;
      const lead = await this.prisma.teamMember.findFirst({
        where: {
          userId: caller.userId,
          isLead: true,
          team: { organizationId: orgId, deletedAt: null },
        },
        select: { teamId: true },
      });
      return !!lead;
    }
    return false;
  }

  private async assertCanWriteCatalog(orgId: string, caller: CallerCtx) {
    if (!(await this.canWriteCatalog(orgId, caller))) {
      throw new ForbiddenException(
        "L'organisation n'autorise pas votre rôle à modifier le catalogue de skills.",
      );
    }
  }

  async create(orgId: string, dto: CreateSkillDto, caller: CallerCtx) {
    await this.assertCanWriteCatalog(orgId, caller);
    const name = dto.name.trim();
    if (!name) throw new ConflictException('Nom requis');
    // Check case-insensitive uniqueness BEFORE l'insertion : la contrainte
    // Prisma `@@unique([organizationId, name])` est case-sensitive en
    // Postgres, donc "azure ad" et "Azure AD" passeraient toutes les deux.
    const dup = await this.findByNameInsensitive(orgId, name);
    if (dup) {
      throw new ConflictException(
        `Un skill avec ce nom existe déjà : "${dup.name}"`,
      );
    }
    try {
      return await this.prisma.skill.create({
        data: {
          organizationId: orgId,
          name,
          description: dto.description ?? null,
          color: dto.color ?? null,
          category: dto.category?.trim() || null,
          aliases: cleanAliases(dto.aliases),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un skill avec ce nom existe déjà');
      }
      throw e;
    }
  }

  async update(
    orgId: string,
    skillId: string,
    dto: UpdateSkillDto,
    caller: CallerCtx,
  ) {
    await this.assertCanWriteCatalog(orgId, caller);
    await this.assertSkill(orgId, skillId);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new ConflictException('Nom requis');
      const dup = await this.findByNameInsensitive(orgId, name);
      if (dup && dup.id !== skillId) {
        throw new ConflictException(
          `Un skill avec ce nom existe déjà : "${dup.name}"`,
        );
      }
    }
    try {
      return await this.prisma.skill.update({
        where: { id: skillId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.category !== undefined
            ? { category: dto.category.trim() || null }
            : {}),
          ...(dto.aliases !== undefined ? { aliases: cleanAliases(dto.aliases) } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Un skill avec ce nom existe déjà');
      }
      throw e;
    }
  }

  private async findByNameInsensitive(orgId: string, name: string) {
    return this.prisma.skill.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });
  }

  async remove(orgId: string, skillId: string, caller: CallerCtx) {
    await this.assertCanWriteCatalog(orgId, caller);
    // Charge le nom (et valide l'existence) → renvoyé pour le journal d'audit.
    const skill = await this.prisma.skill.findFirst({
      where: { id: skillId, organizationId: orgId, deletedAt: null },
      select: { name: true },
    });
    if (!skill) throw new NotFoundException('Skill introuvable');
    // Soft delete + détacher des tâches qui le référencent.
    await this.prisma.$transaction([
      this.prisma.task.updateMany({
        where: { organizationId: orgId, requiredSkillId: skillId },
        data: { requiredSkillId: null, requiredSkillLevel: null },
      }),
      this.prisma.userSkill.deleteMany({ where: { skillId } }),
      this.prisma.projectSkill.deleteMany({ where: { skillId } }),
      this.prisma.skill.update({
        where: { id: skillId },
        data: { deletedAt: new Date() },
      }),
    ]);
    return { id: skillId, name: skill.name, deleted: true };
  }

  // ---------- UserSkill ----------
  async listUserSkills(orgId: string, userId: string, caller: CallerCtx) {
    await this.assertUserInOrg(orgId, userId);
    const ok = await this.access.canViewUserResource(orgId, caller, userId);
    if (!ok) {
      throw new ForbiddenException(
        "Vous n'avez pas accès au profil de compétences de cet utilisateur",
      );
    }
    return this.prisma.userSkill.findMany({
      where: { userId, skill: { organizationId: orgId, deletedAt: null } },
      include: { skill: true },
      orderBy: { skill: { name: 'asc' } },
    });
  }

  async upsertUserSkill(
    orgId: string,
    userId: string,
    skillId: string,
    caller: CallerCtx,
    dto: UpsertUserSkillDto,
  ) {
    await this.assertCanManageUserSkills(orgId, userId, caller);
    await this.assertSkill(orgId, skillId);
    const maxLevel = await this.settings.getSkillsMaxLevel(orgId);
    if (dto.level < 1 || dto.level > maxLevel) {
      throw new BadRequestException(`level doit être entre 1 et ${maxLevel}`);
    }
    return this.prisma.userSkill.upsert({
      where: { userId_skillId: { userId, skillId } },
      create: { userId, skillId, level: dto.level, setById: caller.userId },
      update: { level: dto.level, setById: caller.userId },
      include: { skill: true },
    });
  }

  async removeUserSkill(
    orgId: string,
    userId: string,
    skillId: string,
    caller: CallerCtx,
  ) {
    await this.assertCanManageUserSkills(orgId, userId, caller);
    await this.prisma.userSkill.deleteMany({ where: { userId, skillId } });
    return { userId, skillId, deleted: true };
  }

  // ---------- ProjectSkill ----------
  async listProjectSkills(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    return this.prisma.projectSkill.findMany({
      where: { projectId, skill: { deletedAt: null } },
      include: { skill: true },
      orderBy: { skill: { name: 'asc' } },
    });
  }

  async setProjectSkills(
    orgId: string,
    projectId: string,
    dto: SetProjectSkillsDto,
    caller?: CallerCtx,
  ) {
    await this.assertProject(orgId, projectId);
    const ids = Array.from(new Set(dto.skillIds));
    if (ids.length) {
      const found = await this.prisma.skill.findMany({
        where: { organizationId: orgId, id: { in: ids }, deletedAt: null },
        select: { id: true, name: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('Un ou plusieurs skillIds invalides');
      }
      // Soft scoping : un non-admin ne peut retenir que des skills couverts
      // par les équipes affectées au projet (fallback catalogue complet si
      // aucune équipe). L'admin peut outrepasser. On ne supprime jamais un
      // skill déjà posé — on bloque seulement l'ajout hors périmètre.
      if (!caller?.isAdmin) {
        const available = await this.availableSkillIds(orgId, projectId);
        if (available) {
          const offending = found.filter((s) => !available.has(s.id));
          if (offending.length) {
            throw new BadRequestException(
              `Compétence(s) hors du périmètre des équipes du projet : ${offending
                .map((s) => s.name)
                .join(', ')}. Faites couvrir ce skill par une équipe affectée, ou émettez une demande de compétence.`,
            );
          }
        }
      }
    }
    await this.prisma.$transaction([
      this.prisma.projectSkill.deleteMany({ where: { projectId } }),
      ...(ids.length
        ? [
            this.prisma.projectSkill.createMany({
              data: ids.map((skillId) => ({ projectId, skillId })),
            }),
          ]
        : []),
    ]);
    return this.listProjectSkills(orgId, projectId);
  }

  // ---------- Availability (team-scoped) ----------
  /**
   * Ensemble des skillIds assignables à un projet :
   *  - `null`  → aucune équipe affectée → tout le catalogue est permis (fallback)
   *  - `Set`   → union des `TeamSkill` des équipes du projet (peut être vide)
   */
  async availableSkillIds(
    orgId: string,
    projectId: string,
  ): Promise<Set<string> | null> {
    const teams = await this.prisma.projectTeam.findMany({
      where: { projectId },
      select: { teamId: true },
    });
    if (teams.length === 0) return null; // fallback : catalogue complet
    const links = await this.prisma.teamSkill.findMany({
      where: {
        teamId: { in: teams.map((t) => t.teamId) },
        skill: { organizationId: orgId, deletedAt: null },
      },
      select: { skillId: true },
    });
    const set = new Set(links.map((l) => l.skillId));
    // Les compétences non rattachées à AUCUNE équipe forment un pool « libre »
    // proposé par défaut : disponibles sur tous les projets, même scopés.
    // Une compétence devient restreinte uniquement quand une équipe la « réclame ».
    const unassigned = await this.prisma.skill.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        teamSkills: { none: {} },
      },
      select: { id: true },
    });
    for (const s of unassigned) set.add(s.id);
    return set;
  }

  async isSkillAvailableForProject(
    orgId: string,
    projectId: string,
    skillId: string,
  ): Promise<boolean> {
    const set = await this.availableSkillIds(orgId, projectId);
    return set === null ? true : set.has(skillId);
  }

  /** Catalogue filtré au périmètre du projet, pour alimenter le picker UI. */
  async availableSkillsForProject(
    orgId: string,
    projectId: string,
    caller?: CallerCtx,
  ) {
    await this.assertProject(orgId, projectId);
    const set = await this.availableSkillIds(orgId, projectId);
    const all = await this.prisma.skill.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    const skills = set === null ? all : all.filter((s) => set.has(s.id));
    // Le bouton « Demander une compétence » dans le picker n'est exposé qu'aux
    // PM (du projet) / Portfolio Managers / admins.
    let canRequestSkill = false;
    if (caller) {
      canRequestSkill = await this.canRequestSkillForProject(
        orgId,
        caller,
        projectId,
      );
    }
    // `scoped=false` ⇒ fallback catalogue complet (aucune équipe sur le projet).
    return { scoped: set !== null, skills, canRequestSkill };
  }

  /** Duplique inline la logique de SkillRequestsService.canRequestForProject
   *  pour éviter une dépendance circulaire entre modules. */
  private async canRequestSkillForProject(
    orgId: string,
    caller: CallerCtx,
    projectId: string,
  ): Promise<boolean> {
    if (caller.isAdmin) return true;
    const m = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, userId: caller.userId },
      select: { role: { select: { key: true } } },
    });
    if (m?.role.key === 'PORTFOLIO_MANAGER') return true;
    const pm = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: caller.userId },
      select: { role: { select: { key: true } } },
    });
    return pm?.role.key === 'PROJECT_MANAGER';
  }

  // ---------- TeamSkill ----------
  async listTeamSkills(orgId: string, teamId: string) {
    await this.assertTeam(orgId, teamId);
    return this.prisma.teamSkill.findMany({
      where: { teamId, skill: { deletedAt: null } },
      include: { skill: true },
      orderBy: { skill: { name: 'asc' } },
    });
  }

  /** Remplace l'intégralité des skills d'une équipe (admin ou lead de l'équipe). */
  async setTeamSkills(
    orgId: string,
    teamId: string,
    skillIds: string[],
    caller: CallerCtx,
  ) {
    await this.assertCanManageTeamSkills(orgId, teamId, caller);
    const ids = Array.from(new Set(skillIds));
    if (ids.length) {
      const found = await this.prisma.skill.count({
        where: { organizationId: orgId, id: { in: ids }, deletedAt: null },
      });
      if (found !== ids.length) {
        throw new BadRequestException('Un ou plusieurs skillIds invalides');
      }
    }
    await this.prisma.$transaction([
      this.prisma.teamSkill.deleteMany({ where: { teamId } }),
      ...(ids.length
        ? [
            this.prisma.teamSkill.createMany({
              data: ids.map((skillId) => ({ teamId, skillId })),
            }),
          ]
        : []),
    ]);
    return this.listTeamSkills(orgId, teamId);
  }

  // ---------- Skills lifecycle (auto-bump close + decay) ----------
  /**
   * À la clôture d'un projet, monte d'un cran (capé par maxLevel) les
   * UserSkill des participants sur chacun des ProjectSkill du projet.
   * Crée la ligne UserSkill au niveau `delta` si elle n'existait pas.
   *
   * Best-effort : best run hors transaction de l'update projet.
   * Idempotent : `lastBumpProjectId` sur OrgSetting éviterait un double bump
   * (un même projet repassé COMPLETED ne re-bump pas — TODO si besoin).
   */
  async bumpForProjectClose(orgId: string, projectId: string) {
    const enabled = await this.settings.getSkillsAutoBumpEnabled(orgId);
    if (!enabled) return { skipped: 'disabled' as const };

    const [delta, maxLevel] = await Promise.all([
      this.settings.getSkillsAutoBumpDelta(orgId),
      this.settings.getSkillsMaxLevel(orgId),
    ]);

    // Skills du projet — fallback: si aucun ProjectSkill explicite, on prend
    // les requiredSkill des tâches du projet (au moins on bump quelque chose).
    const projectSkills = await this.prisma.projectSkill.findMany({
      where: { projectId, skill: { organizationId: orgId, deletedAt: null } },
      select: { skillId: true },
    });
    let skillIds = projectSkills.map((p) => p.skillId);
    if (skillIds.length === 0) {
      const fromTasks = await this.prisma.task.findMany({
        where: {
          projectId,
          deletedAt: null,
          requiredSkillId: { not: null },
        },
        select: { requiredSkillId: true },
        distinct: ['requiredSkillId'],
      });
      skillIds = Array.from(new Set(fromTasks.map((t) => t.requiredSkillId!).filter(Boolean)));
    }
    if (skillIds.length === 0) return { bumped: 0, users: 0, skipped: 'no-skills' as const };

    // Participants = ProjectMember directs + membres des équipes affectées
    // (limité aux users actifs).
    const [directMembers, projectTeams] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId, user: { deletedAt: null, status: 'ACTIVE' } },
        select: { userId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId },
        select: {
          team: {
            select: {
              members: {
                where: { user: { deletedAt: null, status: 'ACTIVE' } },
                select: { userId: true },
              },
            },
          },
        },
      }),
    ]);
    const userIds = new Set<string>();
    for (const m of directMembers) userIds.add(m.userId);
    for (const pt of projectTeams) for (const m of pt.team.members) userIds.add(m.userId);
    if (userIds.size === 0) return { bumped: 0, users: 0, skipped: 'no-users' as const };

    let bumped = 0;
    for (const userId of userIds) {
      for (const skillId of skillIds) {
        const existing = await this.prisma.userSkill.findUnique({
          where: { userId_skillId: { userId, skillId } },
        });
        if (existing) {
          const next = Math.min(maxLevel, existing.level + delta);
          if (next === existing.level) continue;
          await this.prisma.userSkill.update({
            where: { userId_skillId: { userId, skillId } },
            data: { level: next, setById: null },
          });
        } else {
          await this.prisma.userSkill.create({
            data: {
              userId,
              skillId,
              level: Math.min(maxLevel, delta),
              setById: null,
            },
          });
        }
        bumped++;
      }
    }
    return { bumped, users: userIds.size, skills: skillIds.length };
  }

  /**
   * Décrémente les UserSkill non touchés depuis `skills.decayPeriodDays`.
   * Si le niveau atteint 0, on supprime la ligne (la compétence n'est plus
   * référencée). À appeler en cron quotidien.
   *
   * `Prisma.userSkill.updatedAt` est mis à jour automatiquement à chaque
   * upsert ; on en profite comme proxy de « dernière activité ».
   */
  async applyDecayForOrg(orgId: string) {
    const enabled = await this.settings.getSkillsDecayEnabled(orgId);
    if (!enabled) return { skipped: 'disabled' as const };

    const [period, delta] = await Promise.all([
      this.settings.getSkillsDecayPeriodDays(orgId),
      this.settings.getSkillsDecayDelta(orgId),
    ]);
    const threshold = new Date(Date.now() - period * 86_400_000);

    const stale = await this.prisma.userSkill.findMany({
      where: {
        updatedAt: { lt: threshold },
        skill: { organizationId: orgId, deletedAt: null },
        user: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { userId: true, skillId: true, level: true },
    });
    let decayed = 0;
    let removed = 0;
    for (const r of stale) {
      const next = r.level - delta;
      if (next <= 0) {
        await this.prisma.userSkill.delete({
          where: { userId_skillId: { userId: r.userId, skillId: r.skillId } },
        });
        removed++;
      } else {
        await this.prisma.userSkill.update({
          where: { userId_skillId: { userId: r.userId, skillId: r.skillId } },
          data: { level: next, setById: null },
        });
        decayed++;
      }
    }
    return { decayed, removed, threshold: threshold.toISOString() };
  }

  /**
   * Scan quotidien des UserSkill ayant un `expiresAt` set : envoie une
   * relance par mail au user + leads de ses équipes selon le seuil franchi
   * (J-30, J-7, J0). État stocké dans `expiryReminderStage` pour éviter de
   * spammer (chaque seuil n'est notifié qu'une fois ; le stage se reset
   * automatiquement quand `expiresAt` change).
   */
  async sendExpirationReminders(orgId: string) {
    const rows = await this.prisma.userSkill.findMany({
      where: {
        expiresAt: { not: null },
        skill: { organizationId: orgId, deletedAt: null },
        user: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        userId: true,
        skillId: true,
        expiresAt: true,
        expiryReminderStage: true,
        user: { select: { email: true, name: true, preferredLanguage: true } },
        skill: { select: { name: true } },
      },
    });
    if (rows.length === 0) return { sent: 0 };

    const now = Date.now();
    let sent = 0;
    for (const r of rows) {
      if (!r.expiresAt) continue;
      const daysLeft = Math.ceil((+r.expiresAt - now) / 86_400_000);
      // Prochain seuil à franchir (30 → 7 → expiré). Une seule évaluation : le
      // premier bloc historique était systématiquement écrasé par celui-ci
      // (dans tous les cas où il assignait une valeur) → supprimé, code mort.
      let stageToFire: 30 | 7 | 0 | null = null;
      // expiryReminderStage interprétation : 0 = aucun, 30/7 = ces seuils
      // franchis, 1 = expiré envoyé (état final).
      // Cron progresse : 0 → 30 → 7 → 1.
      if (
        daysLeft <= 30 &&
        r.expiryReminderStage === 0
      ) {
        stageToFire = 30;
      } else if (
        daysLeft <= 7 &&
        (r.expiryReminderStage === 30 || r.expiryReminderStage === 0)
      ) {
        stageToFire = 7;
      } else if (
        daysLeft <= 0 &&
        (r.expiryReminderStage === 7 ||
          r.expiryReminderStage === 30 ||
          r.expiryReminderStage === 0)
      ) {
        stageToFire = 0;
      }
      if (stageToFire == null) continue;

      // Destinataires : le user lui-même + leads des équipes dont il est membre.
      const leadRows = await this.prisma.teamMember.findMany({
        where: {
          team: {
            organizationId: orgId,
            deletedAt: null,
            members: { some: { userId: r.userId } },
          },
          isLead: true,
          user: { deletedAt: null, status: 'ACTIVE' },
        },
        select: { user: { select: { id: true, email: true, name: true, preferredLanguage: true } } },
      });
      const recipientMap = new Map<string, { userId: string; email: string; name: string; preferredLanguage: string | null }>();
      recipientMap.set(r.user.email, { userId: r.userId, email: r.user.email, name: r.user.name, preferredLanguage: r.user.preferredLanguage });
      for (const lr of leadRows) {
        recipientMap.set(lr.user.email, { userId: lr.user.id, email: lr.user.email, name: lr.user.name, preferredLanguage: lr.user.preferredLanguage });
      }
      try {
        await this.notifications.notifySkillExpiring(
          orgId,
          Array.from(recipientMap.values()),
          {
            userName: r.user.name,
            skillName: r.skill.name,
            expiresAt: r.expiresAt.toISOString().slice(0, 10),
            stage: stageToFire,
          },
        );
        // Mémoise le seuil franchi (0 = expiré → on stocke 1 pour "final atteint")
        const nextStage = stageToFire === 0 ? 1 : stageToFire;
        await this.prisma.userSkill.update({
          where: { userId_skillId: { userId: r.userId, skillId: r.skillId } },
          data: { expiryReminderStage: nextStage },
        });
        sent++;
      } catch {
        /* best-effort */
      }
    }
    return { sent };
  }

  // ---------- Multi-skill par tâche (Phase E) ----------
  /** Compétences additionnelles requises par une tâche (au-delà du skill primary). */
  async listTaskRequiredSkills(orgId: string, taskId: string) {
    await this.assertTaskInOrg(orgId, taskId);
    return this.prisma.taskRequiredSkill.findMany({
      where: { taskId, skill: { organizationId: orgId, deletedAt: null } },
      include: { skill: true },
      orderBy: { skill: { name: 'asc' } },
    });
  }

  /** Remplace l'ensemble des skills additionnels d'une tâche. */
  async setTaskRequiredSkills(
    orgId: string,
    taskId: string,
    items: Array<{ skillId: string; level?: number }>,
    caller?: { isAdmin: boolean },
  ) {
    const task = await this.assertTaskInOrg(orgId, taskId);
    const ids = Array.from(new Set(items.map((it) => it.skillId)));
    if (ids.length) {
      // Validate skills exist
      const found = await this.prisma.skill.count({
        where: { organizationId: orgId, id: { in: ids }, deletedAt: null },
      });
      if (found !== ids.length) {
        throw new BadRequestException('Un ou plusieurs skillIds invalides');
      }
      // Soft scoping (cohérent avec Task.requiredSkill primaire)
      if (!caller?.isAdmin) {
        const available = await this.availableSkillIds(orgId, task.projectId);
        if (available) {
          const offending = ids.filter((id) => !available.has(id));
          if (offending.length) {
            throw new BadRequestException(
              "Compétence(s) hors du périmètre des équipes du projet.",
            );
          }
        }
      }
    }
    const maxLevel = await this.settings.getSkillsMaxLevel(orgId);
    await this.prisma.$transaction([
      this.prisma.taskRequiredSkill.deleteMany({ where: { taskId } }),
      ...(items.length
        ? [
            this.prisma.taskRequiredSkill.createMany({
              data: items.map((it) => ({
                taskId,
                skillId: it.skillId,
                level: Math.max(1, Math.min(maxLevel, it.level ?? 1)),
              })),
            }),
          ]
        : []),
    ]);
    return this.listTaskRequiredSkills(orgId, taskId);
  }

  private async assertTaskInOrg(orgId: string, taskId: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!t) throw new NotFoundException('Tâche introuvable');
    return t;
  }

  // ---------- Skill Gap Dashboard (Phase F) ----------
  /**
   * Calcule, par skill, l'écart entre la demande (somme `requiredSkillLevel
   * × estimateHours` sur les tâches actives) et la couverture (somme des
   * niveaux des UserSkill du pool).
   *
   * **Scoping** : la métrique est calculée **pour un projet donné**.
   *   - La demande agrège uniquement les tâches non-DONE du projet.
   *   - La couverture agrège les UserSkill **du pool du projet** : membres
   *     directs (ProjectMember) + membres des équipes affectées (ProjectTeam).
   *     C'est qui peut concrètement bosser sur le projet — c'est ce qui rend
   *     la métrique actionnable pour le PM.
   *
   * Le gating (qui peut voir) se fait dans le contrôleur (PM / team-lead /
   * admin), on ne le refait pas ici.
   */
  /**
   * Gating du gap-par-projet : autorisé seulement à
   *  - admin global
   *  - rôle org PORTFOLIO_MANAGER (vue transverse du portefeuille)
   *  - rôle projet PROJECT_MANAGER sur ce projet précis
   *  - lead d'une équipe affectée au projet (ProjectTeam ∩ TeamMember.isLead)
   * Les autres membres (Contributors, Viewers) NE voient pas ce dashboard —
   * la matrice compétences ↔ couverture est une info stratégique réservée
   * aux managers.
   */
  async assertCanViewProjectGap(
    orgId: string,
    projectId: string,
    caller: CallerCtx,
  ) {
    if (caller.isAdmin) return;
    // Portfolio Manager → ok partout
    const m = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, userId: caller.userId },
      select: { role: { select: { key: true } } },
    });
    if (m?.role.key === 'PORTFOLIO_MANAGER') return;
    // Project Manager du projet → ok
    const pm = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: caller.userId },
      select: { role: { select: { key: true } } },
    });
    if (pm?.role.key === 'PROJECT_MANAGER') return;
    // Lead d'une équipe affectée au projet → ok
    const leadOfTeam = await this.prisma.projectTeam.findFirst({
      where: {
        projectId,
        team: {
          deletedAt: null,
          members: { some: { userId: caller.userId, isLead: true } },
        },
      },
      select: { teamId: true },
    });
    if (leadOfTeam) return;
    throw new ForbiddenException(
      "Skill gap réservé aux Project Managers, Portfolio Managers, leads d'équipe affectée et admins.",
    );
  }

  /**
   * Couverture compétence × capacité, par tâche.
   *
   * Pour chaque (skill requis × tâche du projet), on cherche les users
   * **qualifiés** (skill au niveau requis) du pool effectif (ProjectMember
   * directs ∪ membres des équipes affectées). Pour chaque qualifié, les
   * heures libres sont calculées **jour par jour** via `CapacityService`
   * (WorkSchedule × occupancy, time-offs, fériés, allocations existantes) sur
   * la fenêtre de la tâche `[max(startDate, aujourd'hui), endDate ?? dueDate]`
   * (fenêtre par défaut proportionnelle à l'effort restant si pas de dates).
   * Les allocations **de cette tâche elle-même** sont exclues du calcul
   * (ce n'est pas du travail concurrent — c'est le travail qu'on cherche
   * justement à couvrir) : un qualifié déjà assigné n'est pas pénalisé par sa
   * propre allocation, mais reste **indisponible s'il est sur-chargé par
   * d'autres tâches** — avoir le skill ne suffit pas, il faut le temps libre.
   *
   * L'effort à couvrir est le **reste à faire** (`estimate − temps loggé`),
   * pas l'estimate total.
   *
   * Statuts par tâche :
   *   - fully     : reste à faire nul, ou un qualifié peut le faire seul
   *                 (freeHours ≥ remaining)
   *   - splittable: Σ freeHours des qualifiés ≥ remaining (split greedy proposé)
   *   - partial   : qualifiés présents mais Σ freeHours < remaining
   *   - uncovered : aucun qualifié
   *
   * Agrégation par compétence : 4 compteurs + drill-down complet.
   */
  async computeSkillGapForProject(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);

    // --- Tâches non-DONE du projet, avec leurs skills requis + assignees
    const tasks = await this.prisma.task.findMany({
      where: {
        organizationId: orgId,
        projectId,
        deletedAt: null,
        status: { not: 'DONE' },
      },
      select: {
        id: true,
        title: true,
        estimateHours: true,
        startDate: true,
        endDate: true,
        dueDate: true,
        requiredSkillId: true,
        requiredSkillLevel: true,
        requiredSkills: { select: { skillId: true, level: true } },
        assignees: { select: { userId: true } },
      },
    });

    // Skills réellement demandées par ce projet (évite de scanner tout le catalogue)
    const skillReqsByTask: Array<{
      taskId: string;
      reqs: Array<{ skillId: string; level: number }>;
    }> = tasks.map((t) => {
      const reqs: Array<{ skillId: string; level: number }> = [];
      if (t.requiredSkillId) {
        reqs.push({
          skillId: t.requiredSkillId,
          level: t.requiredSkillLevel ?? 1,
        });
      }
      for (const r of t.requiredSkills) reqs.push({ skillId: r.skillId, level: r.level });
      return { taskId: t.id, reqs };
    });
    const involvedSkillIds = Array.from(
      new Set(skillReqsByTask.flatMap((t) => t.reqs.map((r) => r.skillId))),
    );
    if (involvedSkillIds.length === 0) return [];

    const skills = await this.prisma.skill.findMany({
      where: {
        id: { in: involvedSkillIds },
        organizationId: orgId,
        deletedAt: null,
      },
      select: { id: true, name: true, color: true, category: true },
    });
    const skillById = new Map(skills.map((s) => [s.id, s]));

    // --- Pool projet
    const [directMembers, projectTeams] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId, user: { deletedAt: null, status: 'ACTIVE' } },
        select: { userId: true, user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId },
        select: {
          team: {
            select: {
              members: {
                where: { user: { deletedAt: null, status: 'ACTIVE' } },
                select: { user: { select: { id: true, name: true, email: true } } },
              },
            },
          },
        },
      }),
    ]);
    const userById = new Map<string, { id: string; name: string; email: string }>();
    for (const m of directMembers) if (m.user) userById.set(m.user.id, m.user);
    for (const pt of projectTeams)
      for (const m of pt.team.members) if (m.user) userById.set(m.user.id, m.user);
    const poolUserIds = Array.from(userById.keys());

    // --- UserSkill index (level by user × skill)
    const usRows = poolUserIds.length
      ? await this.prisma.userSkill.findMany({
          where: {
            userId: { in: poolUserIds },
            skillId: { in: involvedSkillIds },
          },
          select: { userId: true, skillId: true, level: true },
        })
      : [];
    const levelByUserSkill = new Map<string, number>();
    for (const r of usRows) levelByUserSkill.set(`${r.userId}|${r.skillId}`, r.level);

    // --- Temps déjà loggé par tâche : la couverture porte sur le RESTE À
    // FAIRE (estimate − loggé), pas sur l'estimate total — une tâche de 40h
    // dont 30h sont faites n'a besoin que de 10h de capacité.
    const taskIds = tasks.map((t) => t.id);
    const loggedRows = taskIds.length
      ? await this.prisma.timeEntry.groupBy({
          by: ['taskId'],
          where: { taskId: { in: taskIds }, organizationId: orgId },
          _sum: { durationMinutes: true },
        })
      : [];
    const loggedHoursByTask = new Map<string, number>(
      loggedRows.map((r) => [r.taskId, (r._sum.durationMinutes ?? 0) / 60]),
    );

    const hoursPerDay = await this.settings.getHoursPerDay(orgId);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // --- Fenêtre de couverture par tâche. On regarde toujours vers l'avant :
    // plancher à aujourd'hui (les heures libres du passé ne servent à rien).
    // Sans dates, la fenêtre par défaut est proportionnelle à l'effort restant
    // (reste ÷ h/j × 1.5, borné 7–60 j) plutôt qu'un forfait arbitraire.
    const defaultWindowDays = (effortHours: number | null): number => {
      if (effortHours == null) return 14;
      const days = Math.ceil((effortHours / Math.max(1, hoursPerDay)) * 1.5);
      return Math.min(60, Math.max(7, days));
    };
    const windowByTask = new Map<
      string,
      { start: Date; end: Date; logged: number; remaining: number | null }
    >();
    for (const t of tasks) {
      const logged = loggedHoursByTask.get(t.id) ?? 0;
      const remaining =
        t.estimateHours == null ? null : Math.max(0, t.estimateHours - logged);
      const rawStart = t.startDate ?? today;
      const start = rawStart < today ? today : rawStart;
      const due = t.endDate ?? t.dueDate;
      // Deadline déjà passée (ou absente) : on mesure ce que ça donne à
      // partir de maintenant sur la fenêtre par défaut.
      const end =
        due && due >= start
          ? due
          : new Date(+start + defaultWindowDays(remaining) * 86_400_000);
      windowByTask.set(t.id, { start, end, logged, remaining });
    }

    // --- Capacité réelle par user du pool (WorkSchedule × occupancy, time-offs,
    // fériés, allocations existantes) via le CapacityService partagé avec
    // l'auto-split/autoplan. Un seul contexte par user sur la fenêtre globale.
    let globalStart = today;
    let globalEnd = today;
    for (const w of windowByTask.values()) {
      if (+w.start < +globalStart) globalStart = w.start;
      if (+w.end > +globalEnd) globalEnd = w.end;
    }
    const ctxs = await Promise.all(
      poolUserIds.map((uid) =>
        this.capacity.loadUserCapacityCtx(orgId, uid, globalStart, globalEnd),
      ),
    );
    const ctxByUser = new Map(poolUserIds.map((uid, i) => [uid, ctxs[i]]));

    /**
     * Heures réellement libres d'un user sur `[start, end]`, jour par jour.
     * `excludeTaskId` : allocations de cette tâche ignorées (= le travail
     * qu'on cherche à couvrir, pas une charge concurrente).
     */
    const freeHoursFor = (
      userId: string,
      start: Date,
      end: Date,
      excludeTaskId?: string,
    ): number => {
      const ctx = ctxByUser.get(userId);
      if (!ctx) return 0;
      return this.capacity.freeHoursInWindow(ctx, start, end, excludeTaskId);
    };

    // --- Pour chaque (skill, tâche-requérant-le-skill), calculer la couverture
    type TaskCoverage = {
      taskId: string;
      title: string;
      status: 'fully' | 'splittable' | 'partial' | 'uncovered';
      requiredLevel: number;
      estimateHours: number | null;
      /** Heures déjà loggées sur la tâche (TimeEntry). */
      loggedHours: number;
      /** Reste à faire = estimate − loggé (null si pas d'estimate). */
      remainingHours: number | null;
      startDate: string | null;
      endDate: string | null;
      qualifiedUsers: Array<{
        userId: string;
        name: string;
        level: number;
        freeHours: number;
        assigned: boolean;
        canSolo: boolean;
      }>;
      /** Users à un niveau juste sous le requis (candidats formation). Ne
       *  comptent PAS dans les statuts de couverture. */
      nearQualified: Array<{
        userId: string;
        name: string;
        level: number;
        freeHours: number;
        assigned: boolean;
        canSolo: boolean;
      }>;
      totalFreeHours: number;
      split?: Array<{ userId: string; name: string; hours: number }>;
    };

    // Index: pour chaque skillId requis, liste des tâches qui le requièrent + niveau requis
    const taskById = new Map(tasks.map((x) => [x.id, x]));
    const tasksBySkill = new Map<string, Array<{ task: typeof tasks[number]; level: number }>>();
    for (const { taskId, reqs } of skillReqsByTask) {
      const t = taskById.get(taskId)!;
      for (const r of reqs) {
        if (!tasksBySkill.has(r.skillId)) tasksBySkill.set(r.skillId, []);
        tasksBySkill.get(r.skillId)!.push({ task: t, level: r.level });
      }
    }

    const result = [];
    for (const skillId of involvedSkillIds) {
      const s = skillById.get(skillId);
      if (!s) continue;
      const taskList = tasksBySkill.get(skillId) ?? [];
      const taskCoverages: TaskCoverage[] = [];
      let fully = 0, splittable = 0, partial = 0, uncovered = 0;

      for (const { task, level: reqLevel } of taskList) {
        const win = windowByTask.get(task.id)!;
        const taskStart = win.start;
        const safeEnd = win.end;
        const remainingHours = win.remaining;

        // Qualifiés = users du pool avec ce skill au niveau ≥ requis.
        // Presque-qualifiés = un niveau juste en dessous (candidats formation,
        // affichage seulement — aucun impact sur les statuts).
        const assigned = new Set(task.assignees.map((a) => a.userId));
        const qualified: TaskCoverage['qualifiedUsers'] = [];
        const nearQualified: TaskCoverage['nearQualified'] = [];
        for (const uid of poolUserIds) {
          const lvl = levelByUserSkill.get(`${uid}|${skillId}`) ?? 0;
          if (lvl >= 1 && lvl === reqLevel - 1) {
            const u = userById.get(uid)!;
            nearQualified.push({
              userId: uid,
              name: u.name,
              level: lvl,
              freeHours:
                Math.round(freeHoursFor(uid, taskStart, safeEnd, task.id) * 10) / 10,
              assigned: assigned.has(uid),
              canSolo: false,
            });
          }
          if (lvl < reqLevel) continue;
          const u = userById.get(uid)!;
          // Exclut l'allocation de cette tâche : on ne pénalise pas un assigné
          // pour le travail qu'on cherche justement à couvrir.
          const freeH = freeHoursFor(uid, taskStart, safeEnd, task.id);
          const isAssigned = assigned.has(uid);
          // Avoir le skill ne suffit pas : il faut le temps libre réel (hors
          // allocation de cette tâche) pour absorber le RESTE à faire. Un
          // qualifié sur-chargé par d'autres tâches ne peut pas solo, même
          // s'il est déjà assigné ici.
          const canSolo =
            remainingHours != null && remainingHours > 0
              ? freeH >= remainingHours
              : freeH > 0;
          qualified.push({
            userId: uid,
            name: u.name,
            level: lvl,
            freeHours: Math.round(freeH * 10) / 10,
            assigned: isAssigned,
            canSolo,
          });
        }
        // Tri : assignés en premier, puis par niveau desc, puis free hours desc
        qualified.sort((a, b) => {
          if (a.assigned !== b.assigned) return a.assigned ? -1 : 1;
          if (a.level !== b.level) return b.level - a.level;
          return b.freeHours - a.freeHours;
        });
        const totalFreeHours = qualified.reduce((acc, u) => acc + u.freeHours, 0);

        let status: TaskCoverage['status'];
        let split: TaskCoverage['split'] | undefined;
        if (remainingHours != null && remainingHours <= 0.01) {
          // Travail déjà fait (loggé ≥ estimate) : plus rien à couvrir.
          status = 'fully';
          fully++;
        } else if (qualified.length === 0) {
          status = 'uncovered';
          uncovered++;
        } else if (qualified.some((u) => u.canSolo)) {
          status = 'fully';
          fully++;
        } else if (remainingHours == null) {
          // Pas d'estimate → impossible de savoir s'il faut un split, on
          // considère couvert dès qu'un qualifié a des free hours > 0.
          if (totalFreeHours > 0) {
            status = 'fully';
            fully++;
          } else {
            status = 'partial';
            partial++;
          }
        } else if (totalFreeHours >= remainingHours) {
          status = 'splittable';
          splittable++;
          // Greedy : assigne par ordre (assigné > level > freeHours) jusqu'à
          // atteindre le reste à faire
          let remaining = remainingHours;
          split = [];
          for (const u of qualified) {
            if (remaining <= 0) break;
            const take = Math.min(u.freeHours, remaining);
            if (take > 0.01) {
              split.push({
                userId: u.userId,
                name: u.name,
                hours: Math.round(take * 10) / 10,
              });
              remaining -= take;
            }
          }
        } else {
          status = 'partial';
          partial++;
        }

        taskCoverages.push({
          taskId: task.id,
          title: task.title,
          status,
          requiredLevel: reqLevel,
          estimateHours: task.estimateHours,
          loggedHours: Math.round(win.logged * 10) / 10,
          remainingHours:
            remainingHours == null ? null : Math.round(remainingHours * 10) / 10,
          startDate: task.startDate ? task.startDate.toISOString().slice(0, 10) : null,
          endDate: task.endDate
            ? task.endDate.toISOString().slice(0, 10)
            : task.dueDate
              ? task.dueDate.toISOString().slice(0, 10)
              : null,
          qualifiedUsers: qualified,
          nearQualified,
          totalFreeHours: Math.round(totalFreeHours * 10) / 10,
          split,
        });
      }
      // Tri des tâches : pire statut en premier (uncovered > partial > splittable > fully)
      const order: Record<TaskCoverage['status'], number> = {
        uncovered: 0,
        partial: 1,
        splittable: 2,
        fully: 3,
      };
      taskCoverages.sort((a, b) => order[a.status] - order[b.status]);

      result.push({
        skillId,
        name: s.name,
        color: s.color,
        category: s.category,
        totalTasks: taskList.length,
        fully,
        splittable,
        partial,
        uncovered,
        tasks: taskCoverages,
      });
    }

    // Tri : compétences avec le plus de tâches non-couvertes en premier
    result.sort((a, b) => {
      const aBad = a.uncovered * 3 + a.partial * 2 + a.splittable;
      const bBad = b.uncovered * 3 + b.partial * 2 + b.splittable;
      return bBad - aBad;
    });
    return result;
  }

  // ---------- Bulk import UserSkill (Phase G) ----------
  /**
   * Import en masse de niveaux utilisateur via CSV.
   * Format : `email,skill,level` (3 colonnes) ou `email,skill,level,category`
   * (4 colonnes — la catégorie est optionnelle). Idempotent (upsert).
   *
   * Comportement de la catégorie :
   *  - skill créé via `createMissing=true` : catégorie = valeur CSV (ou
   *    "Imported" si non fournie)
   *  - skill existant SANS catégorie : la catégorie CSV est posée
   *  - skill existant AVEC catégorie : on ne touche pas (l'admin / le pack a
   *    déjà classé, on n'écrase pas)
   */
  /**
   * Export CSV de tous les UserSkill de l'org : `email,skill,level,category,
   * lastValidatedAt,expiresAt`. Symétrique du bulk import — peut servir
   * d'audit ou de pipeline vers un SIRH externe.
   */
  async exportUserSkillsCsv(orgId: string): Promise<string> {
    const rows = await this.prisma.userSkill.findMany({
      where: {
        skill: { organizationId: orgId, deletedAt: null },
        user: { deletedAt: null },
      },
      select: {
        level: true,
        lastValidatedAt: true,
        expiresAt: true,
        user: { select: { email: true, name: true } },
        skill: { select: { name: true, category: true } },
      },
      orderBy: [
        { user: { email: 'asc' } },
        { skill: { name: 'asc' } },
      ],
    });
    const esc = (v: string | number | null | undefined) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'email,skill,level,category,lastValidatedAt,expiresAt';
    const lines = rows.map((r) =>
      [
        esc(r.user.email),
        esc(r.skill.name),
        esc(r.level),
        esc(r.skill.category),
        esc(r.lastValidatedAt ? r.lastValidatedAt.toISOString().slice(0, 10) : ''),
        esc(r.expiresAt ? r.expiresAt.toISOString().slice(0, 10) : ''),
      ].join(','),
    );
    return [header, ...lines].join('\n');
  }

  async bulkImportUserSkills(
    orgId: string,
    caller: CallerCtx,
    csv: string,
    opts: { createMissing?: boolean } = {},
  ) {
    await this.assertCanWriteCatalog(orgId, caller);
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return { processed: 0, errors: [] };
    // Auto-skip header if first line looks like one
    const first = lines[0].toLowerCase();
    const startIdx = first.includes('email') && first.includes('skill') ? 1 : 0;
    const maxLevel = await this.settings.getSkillsMaxLevel(orgId);

    const users = await this.prisma.user.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true, email: true },
    });
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
    const skills = await this.prisma.skill.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true, name: true },
    });
    const byName = new Map(
      skills.map((s) => [s.name.toLowerCase().replace(/\s+/g, ' '), s.id]),
    );

    let created = 0;
    let updated = 0;
    let createdSkills = 0;
    const errors: Array<{ line: number; reason: string }> = [];

    for (let i = startIdx; i < lines.length; i++) {
      const raw = lines[i];
      const cells = raw.split(',').map((c) => c.trim());
      if (cells.length < 3) {
        errors.push({
          line: i + 1,
          reason: 'colonnes manquantes (email, skill, level[, category])',
        });
        continue;
      }
      const email = cells[0].toLowerCase();
      const skillName = cells[1];
      const lvl = parseInt(cells[2], 10);
      // 4ème colonne optionnelle : catégorie. Si fournie pour un skill existant
      // dépourvu de catégorie, on la pose (sinon on ne touche pas à l'existant).
      const csvCategory = (cells[3] ?? '').trim() || null;
      if (!Number.isFinite(lvl) || lvl < 1 || lvl > maxLevel) {
        errors.push({ line: i + 1, reason: `niveau invalide (1..${maxLevel})` });
        continue;
      }
      const userId = byEmail.get(email);
      if (!userId) {
        errors.push({ line: i + 1, reason: `utilisateur inconnu: ${email}` });
        continue;
      }
      const skillKey = skillName.toLowerCase().replace(/\s+/g, ' ');
      let skillId = byName.get(skillKey);
      if (!skillId) {
        if (!opts.createMissing) {
          errors.push({ line: i + 1, reason: `skill inconnu: ${skillName}` });
          continue;
        }
        const newSkill = await this.prisma.skill.create({
          data: {
            organizationId: orgId,
            name: skillName.trim(),
            // Catégorie : valeur du CSV si fournie, sinon "Imported" par défaut.
            category: csvCategory || 'Imported',
          },
        });
        skillId = newSkill.id;
        byName.set(skillKey, skillId);
        createdSkills++;
      } else if (csvCategory) {
        // Skill existant : on enrichit la catégorie SEULEMENT si elle est vide
        // — on n'écrase pas une classification déjà faite côté admin / pack.
        const existing = await this.prisma.skill.findUnique({
          where: { id: skillId },
          select: { category: true },
        });
        if (existing && !existing.category) {
          await this.prisma.skill.update({
            where: { id: skillId },
            data: { category: csvCategory },
          });
        }
      }
      const existing = await this.prisma.userSkill.findUnique({
        where: { userId_skillId: { userId, skillId } },
      });
      await this.prisma.userSkill.upsert({
        where: { userId_skillId: { userId, skillId } },
        update: { level: lvl, setById: caller.userId, lastValidatedAt: new Date() },
        create: {
          userId,
          skillId,
          level: lvl,
          setById: caller.userId,
          lastValidatedAt: new Date(),
        },
      });
      if (existing) updated++;
      else created++;
    }
    return {
      processed: created + updated,
      created,
      updated,
      createdSkills,
      errors,
    };
  }

  // ---------- Assignee suggestions ----------
  /**
   * Renvoie les users membres du projet de la tâche, triés par :
   *  1) match du skill requis × niveau (desc),
   *  2) capacité libre estimée sur la fenêtre (desc),
   *  3) nom (asc).
   * Le scoring n'exclut personne — on classe seulement.
   */
  async suggestAssignees(
    orgId: string,
    taskId: string,
    from?: string,
    to?: string,
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        requiredSkillId: true,
        requiredSkillLevel: true,
        startDate: true,
        endDate: true,
        dueDate: true,
        estimateHours: true,
      },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');

    // Pool : membres du projet (directs + via équipes).
    const [directMembers, projectTeams] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId: task.projectId },
        select: { userId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId: task.projectId },
        select: {
          team: {
            select: { members: { select: { userId: true } } },
          },
        },
      }),
    ]);
    const userIds = new Set<string>();
    for (const m of directMembers) userIds.add(m.userId);
    for (const pt of projectTeams) for (const m of pt.team.members) userIds.add(m.userId);

    // Fallback : si pas de membres, on prend tous les users actifs de l'org
    // pour ne pas renvoyer un dropdown vide.
    if (userIds.size === 0) {
      const all = await this.prisma.user.findMany({
        where: { organizationId: orgId, deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
        select: { id: true },
      });
      for (const u of all) userIds.add(u.id);
    }
    const ids = Array.from(userIds);
    if (ids.length === 0) return [];

    // kind HUMAN : les agents IA ne sont jamais suggérés comme assignés (v1
    // pull-only — décision AGENTS_ARCHITECTURE.md).
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
      select: { id: true, name: true, email: true },
    });

    // Niveau sur le skill requis principal (si défini).
    const skillLevelByUser = new Map<string, number>();
    if (task.requiredSkillId) {
      const rows = await this.prisma.userSkill.findMany({
        where: { skillId: task.requiredSkillId, userId: { in: ids } },
        select: { userId: true, level: true },
      });
      for (const r of rows) skillLevelByUser.set(r.userId, r.level);
    }

    // Phase E : compétences requises additionnelles → score multi-skill.
    // Pour chaque user, on calcule la somme des écarts (niveau user − niveau
    // requis), capée à 0. Plus c'est élevé, mieux il matche l'ensemble.
    const extraReqs = await this.prisma.taskRequiredSkill.findMany({
      where: { taskId },
      select: { skillId: true, level: true },
    });
    const multiSkillScoreByUser = new Map<string, number>();
    let multiSkillMaxScore = 0;
    if (extraReqs.length > 0) {
      const extraSkillIds = extraReqs.map((r) => r.skillId);
      const usRows = await this.prisma.userSkill.findMany({
        where: { skillId: { in: extraSkillIds }, userId: { in: ids } },
        select: { userId: true, skillId: true, level: true },
      });
      const lvlByUserSkill = new Map<string, number>();
      for (const r of usRows) lvlByUserSkill.set(`${r.userId}|${r.skillId}`, r.level);
      multiSkillMaxScore = extraReqs.reduce((acc, r) => acc + r.level, 0);
      for (const userId of ids) {
        let score = 0;
        for (const r of extraReqs) {
          const ul = lvlByUserSkill.get(`${userId}|${r.skillId}`) ?? 0;
          score += Math.min(ul, r.level); // bonus jusqu'au niveau requis
        }
        multiSkillScoreByUser.set(userId, score);
      }
    }

    // Fenêtre de dispo : from..to (override), sinon startDate..endDate de la
    // tâche, sinon today..due, sinon les 14 prochains jours.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = from
      ? toUtcDate(from)
      : task.startDate
        ? toUtcDate(task.startDate)
        : today;
    const end = to
      ? toUtcDate(to)
      : task.endDate
        ? toUtcDate(task.endDate)
        : task.dueDate
          ? toUtcDate(task.dueDate)
          : addDays(start, 14);
    const safeEnd = end.getTime() < start.getTime() ? start : end;

    // Charge déjà allouée sur la fenêtre (toutes tâches).
    const allocAgg = await this.prisma.allocation.groupBy({
      by: ['userId'],
      where: {
        userId: { in: ids },
        organizationId: orgId,
        startDate: { lte: safeEnd },
        endDate: { gte: start },
      },
      _sum: { hoursPerDay: true },
    });
    const allocatedByUser = new Map<string, number>();
    for (const a of allocAgg) {
      allocatedByUser.set(a.userId, a._sum.hoursPerDay ?? 0);
    }

    const hoursPerDay = await this.settings.getHoursPerDay(orgId);
    const windowDays =
      Math.max(1, Math.round((+safeEnd - +start) / 86_400_000) + 1);
    const grossCapacity = hoursPerDay * windowDays;
    const maxLevel = await this.settings.getSkillsMaxLevel(orgId);

    const enriched = users.map((u) => {
      const level = skillLevelByUser.get(u.id) ?? 0;
      const allocated = allocatedByUser.get(u.id) ?? 0;
      const freeHours = Math.max(0, grossCapacity - allocated);
      // Score = skill principal (poids 100) + multi-skill (poids 50) + dispo (poids 1).
      const skillScore = task.requiredSkillId ? (level / maxLevel) * 100 : 0;
      const multiScore =
        multiSkillMaxScore > 0
          ? ((multiSkillScoreByUser.get(u.id) ?? 0) / multiSkillMaxScore) * 50
          : 0;
      const freeScore = grossCapacity > 0 ? freeHours / grossCapacity : 0;
      const enough = task.estimateHours
        ? freeHours >= task.estimateHours
        : freeHours > 0;
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        level,
        meetsRequired:
          task.requiredSkillId && task.requiredSkillLevel
            ? level >= task.requiredSkillLevel
            : true,
        freeHours: Math.round(freeHours * 10) / 10,
        allocatedHours: Math.round(allocated * 10) / 10,
        capacityHours: Math.round(grossCapacity * 10) / 10,
        availableForTask: enough,
        score: Math.round((skillScore + multiScore + freeScore) * 100) / 100,
      };
    });
    enriched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
    return enriched;
  }

  // ---------- Helpers ----------
  private async assertSkill(orgId: string, skillId: string) {
    const s = await this.prisma.skill.findFirst({
      where: { id: skillId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!s) throw new NotFoundException('Skill introuvable');
  }

  private async assertProject(orgId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
  }

  private async assertTeam(orgId: string, teamId: string) {
    const t = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('Équipe introuvable');
  }

  /** Admin global OU lead de l'équipe ciblée. */
  private async assertCanManageTeamSkills(
    orgId: string,
    teamId: string,
    caller: CallerCtx,
  ) {
    await this.assertTeam(orgId, teamId);
    if (caller.isAdmin) return;
    const lead = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: caller.userId } },
      select: { isLead: true },
    });
    if (!lead?.isLead) {
      throw new ForbiddenException(
        "Seul un lead de cette équipe (ou un admin) peut gérer ses compétences.",
      );
    }
  }

  private async assertUserInOrg(orgId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!u) throw new NotFoundException('Utilisateur introuvable');
  }

  /** Admin, team-lead d'une équipe de l'user cible, ou self-edit si l'option
   *  org `skills.selfEditEnabled` est vraie ET la cible = l'appelant. */
  private async assertCanManageUserSkills(
    orgId: string,
    userId: string,
    caller: CallerCtx,
  ) {
    await this.assertUserInOrg(orgId, userId);
    if (caller.isAdmin) return;
    if (caller.userId === userId) {
      // Self-edit autorisé uniquement si l'admin l'a activé.
      const allowed = await this.settings.getSkillsSelfEditEnabled(orgId);
      if (allowed) return;
    }
    // Caller doit être lead d'une équipe dont `userId` est membre.
    const sharedLead = await this.prisma.teamMember.findFirst({
      where: {
        userId: caller.userId,
        isLead: true,
        team: {
          organizationId: orgId,
          deletedAt: null,
          members: { some: { userId } },
        },
      },
      select: { teamId: true },
    });
    if (sharedLead) return;
    // La cible est un AGENT dont le caller est l'owner (responsable) → il gère
    // ses compétences depuis le workspace « AI Agents » (chantier agents 4).
    const target = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: { kind: true, ownerId: true },
    });
    if (target?.kind === 'AGENT' && target.ownerId === caller.userId) return;
    throw new ForbiddenException(
      "Édition non autorisée : il faut être admin, team lead de cet utilisateur, owner de l'agent, ou que l'organisation autorise l'auto-édition.",
    );
  }
}

function toUtcDate(s: string | Date): Date {
  if (s instanceof Date) {
    const d = new Date(s);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(s.length === 10 ? s + 'T00:00:00.000Z' : s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Normalise une liste d'alias : trim, dedupe (case-insensitive), max 50, max 80 chars chacun. */
function cleanAliases(input: string[] | undefined): string[] {
  if (!input || !Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 80);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}
