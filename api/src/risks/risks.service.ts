import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { RiskDto } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRiskDto, UpdateRiskDto } from './dto/risk.dto';

type RiskRow = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  probability: number;
  impact: number;
  score: number;
  category: string;
  mitigation: string | null;
  ownerId: string | null;
  owner: { id: string; name: string; email: string } | null;
  status: string;
  source: string;
  autoRuleKind: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

const OWNER_SELECT = { select: { id: true, name: true, email: true } };

/**
 * Registre de risques (RAID, MVP=RISK) — CRUD strictement scopé
 * organizationId + projectId (jamais de fuite cross-projet/cross-org : toute
 * requête porte les deux). L'écriture manuelle est gatée au contrôleur
 * (`risk:manage`) ; ce service ne fait aucun contrôle RBAC lui-même.
 *
 * Les risques `source=AUTO` (dérivés par `RiskAutoService` depuis le
 * chokepoint `emit` des automatisations) restent éditables ici comme
 * n'importe quel risque manuel — un humain PEUT prendre la main sur un
 * risque auto-détecté (changer le statut, ajouter une mitigation…). C'est
 * précisément ce que l'auto-feed respecte en retour (sa clause `update`
 * d'upsert ne touche jamais status/mitigation/ownerId — cf. risk-derivation.ts).
 */
@Injectable()
export class RisksService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(r: RiskRow): RiskDto {
    return {
      id: r.id,
      projectId: r.projectId,
      title: r.title,
      description: r.description,
      probability: r.probability,
      impact: r.impact,
      score: r.score,
      category: r.category as RiskDto['category'],
      mitigation: r.mitigation,
      ownerId: r.ownerId,
      owner: r.owner,
      status: r.status as RiskDto['status'],
      source: r.source as RiskDto['source'],
      autoRuleKind: r.autoRuleKind,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    };
  }

  private async assertOwnerValid(orgId: string, ownerId: string | null | undefined): Promise<void> {
    if (!ownerId) return;
    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!owner) throw new BadRequestException("Owner introuvable dans l'organisation.");
  }

  async list(orgId: string, projectId: string): Promise<RiskDto[]> {
    const rows = await this.prisma.risk.findMany({
      where: { organizationId: orgId, projectId, deletedAt: null },
      include: { owner: OWNER_SELECT },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  private async findOwned(orgId: string, projectId: string, riskId: string) {
    const row = await this.prisma.risk.findFirst({
      where: { id: riskId, organizationId: orgId, projectId, deletedAt: null },
      include: { owner: OWNER_SELECT },
    });
    if (!row) throw new NotFoundException('Risque introuvable');
    return row;
  }

  async create(orgId: string, projectId: string, dto: CreateRiskDto): Promise<RiskDto> {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('Titre requis');
    await this.assertOwnerValid(orgId, dto.ownerId ?? null);
    const probability = dto.probability;
    const impact = dto.impact;
    const created = await this.prisma.risk.create({
      data: {
        organizationId: orgId,
        projectId,
        title,
        description: dto.description ?? null,
        probability,
        impact,
        score: probability * impact,
        category: dto.category ?? 'RISK',
        mitigation: dto.mitigation ?? null,
        ownerId: dto.ownerId ?? null,
        status: dto.status ?? 'OPEN',
        source: 'MANUAL',
        resolvedAt: dto.status === 'RESOLVED' ? new Date() : null,
      },
      include: { owner: OWNER_SELECT },
    });
    return this.toDto(created);
  }

  async update(orgId: string, projectId: string, riskId: string, dto: UpdateRiskDto): Promise<RiskDto> {
    const existing = await this.findOwned(orgId, projectId, riskId);
    if (dto.ownerId !== undefined) await this.assertOwnerValid(orgId, dto.ownerId);

    const probability = dto.probability ?? existing.probability;
    const impact = dto.impact ?? existing.impact;
    const recomputeScore = dto.probability !== undefined || dto.impact !== undefined;

    const nextStatus = dto.status ?? existing.status;
    const wasResolved = existing.status === 'RESOLVED';
    const nowResolved = nextStatus === 'RESOLVED';

    const updated = await this.prisma.risk.update({
      where: { id: riskId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() || existing.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.probability !== undefined ? { probability: dto.probability } : {}),
        ...(dto.impact !== undefined ? { impact: dto.impact } : {}),
        ...(recomputeScore ? { score: probability * impact } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.mitigation !== undefined ? { mitigation: dto.mitigation } : {}),
        ...(dto.ownerId !== undefined ? { ownerId: dto.ownerId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        // Résolution : pose resolvedAt à l'entrée en RESOLVED, le vide si on
        // rouvre (rétrograde vers un autre statut).
        ...(!wasResolved && nowResolved ? { resolvedAt: new Date() } : {}),
        ...(wasResolved && !nowResolved ? { resolvedAt: null } : {}),
      },
      include: { owner: OWNER_SELECT },
    });
    return this.toDto(updated);
  }

  async resolve(orgId: string, projectId: string, riskId: string): Promise<RiskDto> {
    return this.update(orgId, projectId, riskId, { status: 'RESOLVED' });
  }

  async remove(orgId: string, projectId: string, riskId: string): Promise<void> {
    await this.findOwned(orgId, projectId, riskId);
    await this.prisma.risk.update({ where: { id: riskId }, data: { deletedAt: new Date() } });
  }
}
