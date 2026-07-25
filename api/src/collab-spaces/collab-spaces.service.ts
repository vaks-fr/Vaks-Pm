import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CollabSpaceDto, UpsertCollabSpaceDto } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Slug de fournisseur accepté (borné : pas d'injection de clé arbitraire). */
const PROVIDER_RE = /^[a-z0-9-]{2,32}$/;

/**
 * Espaces de collaboration rattachés à un projet. Le provisioning Teams écrit
 * son état sur `Project.msTeam*` ; cette table couvre la déclaration d'espaces
 * créés DEHORS par un provisioner tiers (Slack, Google, ou Teams géré hors Vaks).
 */
@Injectable()
export class CollabSpacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Valide le slug de provider (rejette avant tout accès base). */
  static assertProvider(provider: string): string {
    const p = (provider ?? '').trim().toLowerCase();
    if (!PROVIDER_RE.test(p)) {
      throw new BadRequestException(
        'Provider invalide : 2 à 32 caractères parmi [a-z0-9-] (ex. msteams, slack, gchat).',
      );
    }
    return p;
  }

  /** Valide l'URL de l'espace : https obligatoire (lien sortant affiché). */
  static assertUrl(url: string): string {
    const raw = (url ?? '').trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BadRequestException('URL invalide.');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException("L'URL doit être en https.");
    }
    return parsed.toString();
  }

  /** Isolation org : 404 si le projet n'appartient pas au tenant courant. */
  private async assertProject(orgId: string, projectId: string): Promise<void> {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
  }

  private toDto = (r: {
    id: string; projectId: string; provider: string; externalId: string | null;
    url: string; name: string | null; source: string;
    linkedAt: Date; createdAt: Date; updatedAt: Date;
  }): CollabSpaceDto => ({
    id: r.id,
    projectId: r.projectId,
    provider: r.provider,
    externalId: r.externalId,
    url: r.url,
    name: r.name,
    source: r.source === 'provisioned' ? 'provisioned' : 'external',
    linkedAt: r.linkedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });

  async list(orgId: string, projectId: string): Promise<CollabSpaceDto[]> {
    await this.assertProject(orgId, projectId);
    const rows = await this.prisma.projectCollabSpace.findMany({
      where: { organizationId: orgId, projectId },
      orderBy: { provider: 'asc' },
    });
    return rows.map(this.toDto);
  }

  /**
   * Upsert idempotent sur `(org, projet, provider)`. **Refuse d'écraser une
   * ligne `provisioned`** (409) : un outil externe ne doit pas détourner le lien
   * d'un espace que Vaks gère lui-même.
   */
  async upsert(
    orgId: string,
    projectId: string,
    providerRaw: string,
    dto: UpsertCollabSpaceDto,
  ): Promise<CollabSpaceDto> {
    const provider = CollabSpacesService.assertProvider(providerRaw);
    const url = CollabSpacesService.assertUrl(dto?.url);
    await this.assertProject(orgId, projectId);

    const existing = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider },
      select: { id: true, source: true },
    });
    if (existing && existing.source === 'provisioned') {
      throw new ConflictException(
        "Cet espace est géré par Vaks (provisioning) — il ne peut pas être remplacé par une déclaration externe.",
      );
    }

    const data = {
      url,
      externalId: dto?.externalId ?? null,
      name: dto?.name ?? null,
      source: 'external',
      linkedAt: new Date(),
    };

    const row = existing
      ? await this.prisma.projectCollabSpace.update({ where: { id: existing.id }, data })
      : await this.prisma.projectCollabSpace.create({
          data: { organizationId: orgId, projectId, provider, ...data },
        });
    return this.toDto(row);
  }

  /** Supprime un lien **externe** uniquement (409 sur une ligne `provisioned`). */
  async remove(orgId: string, projectId: string, providerRaw: string): Promise<{ deleted: true }> {
    const provider = CollabSpacesService.assertProvider(providerRaw);
    await this.assertProject(orgId, projectId);
    const row = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider },
      select: { id: true, source: true },
    });
    if (!row) throw new NotFoundException('Espace introuvable');
    if (row.source === 'provisioned') {
      throw new ConflictException("Cet espace est géré par Vaks (provisioning) — suppression refusée.");
    }
    await this.prisma.projectCollabSpace.delete({ where: { id: row.id } });
    return { deleted: true };
  }
}
