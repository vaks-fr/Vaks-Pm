import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { PublicApi, RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AuditLogService } from './audit-log.service';
import { parseAuditFilters, streamAuditExport, assertExportFormatLicensed } from './audit-export';
import { SkipAudit } from './audited.decorator';
import { LicenseService } from '../licensing/license.service';

/**
 * Lecture du journal d'audit via l'**API publique** — scope `audit:read`.
 *
 * Cas d'usage : un SIEM / un job d'archivage qui pulle le journal au niveau
 * organisation avec une **clé org** (`vaks_org_…`) créée avec le scope
 * `audit:read`. Un PAT utilisateur ne fonctionne que si le user sous-jacent a
 * la permission (RBAC ∩ scopes) — en pratique, les Org Admins.
 *
 * Lecture SEULE : mêmes filtres et pagination keyset que le panneau admin,
 * plus l'export JSON Lines / CEF. Aucune écriture, aucune suppression
 * (append-only). Le rate-limit par jeton (`RL_ORG_LIMIT`) s'applique.
 */
@ApiTags('audit-logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi('audit:read')
@RequirePermissions('audit:read')
@SkipAudit()
@Controller('audit-logs')
export class AuditLogsPublicController {
  constructor(
    private readonly audit: AuditLogService,
    private readonly licenses: LicenseService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Lister les entrées du journal d'audit (org courante)",
    description:
      'Pagination keyset : repasser `nextCursor` tel quel pour la page suivante (null = fin). ' +
      'Filtres : `from`/`to` (ISO 8601), `action` (préfixe, ex. `auth.login`), `actorId`, ' +
      '`severity` (INFO|WARNING|CRITICAL), `outcome` (SUCCESS|FAILURE), `resourceType`, ' +
      '`resourceId`, `q` (recherche action + acteur), `pageSize` (≤ 100, défaut 50).',
  })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: Record<string, string | undefined>,
  ) {
    const filters = parseAuditFilters(query);
    const { items, nextCursor } = await this.audit.list(user.orgId, {
      ...filters,
      cursor: query.cursor,
      pageSize: query.pageSize ? Math.min(100, Number(query.pageSize) || 50) : undefined,
    });
    return {
      items: items.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        prevHash: undefined,
      })),
      nextCursor,
    };
  }

  @Get('export')
  @ApiOperation({
    summary: "Exporter le journal d'audit (JSON Lines ou CEF)",
    description:
      'Streaming, cap 100 000 lignes par appel — utiliser les filtres `from`/`to` pour découper. ' +
      '`format=jsonl` (défaut, 1 objet JSON par ligne) ou `format=cef` (ArcSight CEF). ' +
      'Pour un flux temps réel exhaustif, préférer le forwarder syslog (Admin > SIEM).',
  })
  async export(
    @CurrentUser() user: AuthUser,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    // Format CEF réservé à la licence SIEM ; JSON Lines reste ouvert au scope.
    await assertExportFormatLicensed(query, this.licenses);
    await streamAuditExport(this.audit, user.orgId, query, res);
  }
}
