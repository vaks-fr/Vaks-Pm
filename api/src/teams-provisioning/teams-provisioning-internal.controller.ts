import { Body, Controller, Get, NotFoundException, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalTokenGuard } from '../notifications/internal-token.guard';
import { TeamsProvisioningService, ProvisionResult } from './teams-provisioning.service';

/**
 * Endpoints internes (worker → API) du provisioning Teams. Overlay-only,
 * protégés par `X-Worker-Token`. Le worker récupère ici le **contexte** (token
 * Graph minté côté API + membres résolus) et rapporte le **résultat**. L'orgId
 * est dérivé du projet (la base tenant est déjà résolue via `X-Tenant-Slug`),
 * jamais d'un header de confiance.
 */
@Controller('internal/teams-provisioning')
@UseGuards(InternalTokenGuard)
export class TeamsProvisioningInternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: TeamsProvisioningService,
  ) {}

  private async orgIdOf(projectId: string): Promise<string> {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
    return p.organizationId;
  }

  /** Contexte de provisioning consommé par le worker. */
  @Get('projects/:projectId/context')
  async context(
    @Param('projectId') projectId: string,
    @Query('action') action: 'provision' | 'archive' | 'unarchive' | 'reconcile',
  ) {
    const orgId = await this.orgIdOf(projectId);
    return this.svc.buildContext(orgId, projectId, action ?? 'provision');
  }

  /** Résultat d'une opération (persistance Project + journal). */
  @Patch('projects/:projectId')
  async result(@Param('projectId') projectId: string, @Body() body: ProvisionResult) {
    const orgId = await this.orgIdOf(projectId);
    await this.svc.applyResult(orgId, projectId, body);
    return { ok: true };
  }
}
