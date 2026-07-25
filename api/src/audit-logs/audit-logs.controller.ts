import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AuditLogService } from './audit-log.service';
import { AuditRetentionCronService } from './audit-retention-cron.service';
import { parseAuditFilters, streamAuditExport, assertExportFormatLicensed } from './audit-export';
import { SkipAudit } from './audited.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LicenseService } from '../licensing/license.service';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { RequiresFeature } from '../licensing/requires-feature.decorator';

/**
 * Lecture / export du journal d'audit — panneau admin. App-privé (PAS de
 * @PublicApi) et admin-only (`org:manage`). La lecture via jeton d'API passe
 * par le controller public dédié (`/audit-logs`, scope `audit:read`).
 * Aucune route d'écriture ni de suppression : append-only, seule la purge de
 * rétention (cron) supprime. `@SkipAudit` : lire le journal ne le remplit pas.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, LicenseFeatureGuard)
@SkipAudit()
@Controller('admin/audit-logs')
export class AuditLogsController {
  constructor(
    private readonly audit: AuditLogService,
    private readonly cron: AuditRetentionCronService,
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
  ) {}

  /**
   * Vérifie l'intégrité d'une journée passée : recalcule l'empreinte des
   * entrées du jour `date` (UTC) et la compare au `dayHash` scellé dans
   * l'ancre `audit.anchor` écrite le lendemain (et forwardée au SIEM).
   * `ok:false` = des entrées ont été altérées/supprimées en base APRÈS
   * le scellement — ou ajoutées rétroactivement.
   */
  @Get('verify')
  @RequirePermissions('org:manage')
  @RequiresFeature('audit-advanced')
  async verify(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const d = date ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d).getTime())) {
      throw new BadRequestException('date : format YYYY-MM-DD attendu');
    }
    const from = new Date(`${d}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

    const anchor = await this.prisma.auditLog.findFirst({
      where: {
        organizationId: user.orgId,
        action: 'audit.anchor',
        detail: { path: ['date'], equals: d },
      },
      orderBy: { createdAt: 'asc' }, // la première ancre du jour fait foi
    });
    if (!anchor) {
      return { ok: null, date: d, anchored: false, message: 'Aucune ancre pour cette date (le scellement tourne le lendemain).' };
    }
    const sealed = anchor.detail as { dayHash?: string; count?: number };
    const { dayHash, count } = await this.cron.computeDayHash(user.orgId, from, to);
    const ok = sealed.dayHash === dayHash && sealed.count === count;
    return {
      ok,
      date: d,
      anchored: true,
      anchorAt: anchor.createdAt.toISOString(),
      sealedCount: sealed.count ?? null,
      currentCount: count,
      expected: sealed.dayHash ?? null,
      actual: dayHash,
    };
  }

  @Get()
  @RequirePermissions('org:manage')
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

  /**
   * Export streaming JSON Lines / CEF (mêmes filtres que le listing).
   * Borné à 100 000 lignes — affiner les filtres pour le reste, ou brancher
   * le forwarder syslog pour l'exhaustivité temps réel.
   */
  @Get('export')
  @RequirePermissions('org:manage')
  async export(
    @CurrentUser() user: AuthUser,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ) {
    // JSON Lines = core ; le format CEF (destiné aux SIEM) est premium.
    await assertExportFormatLicensed(query, this.licenses);
    await streamAuditExport(this.audit, user.orgId, query, res);
  }

  /** Bouton "Tester la connexion" SIEM : enqueue un job test vers le worker. */
  @Post('syslog/test')
  @RequirePermissions('org:manage')
  @RequiresFeature('siem-export')
  async syslogTest(@CurrentUser() user: AuthUser) {
    try {
      await this.audit.enqueueSyslogTest(user.orgId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { queued: true };
  }
}
