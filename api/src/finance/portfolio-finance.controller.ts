import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser, requesterOf } from '../auth/current-user.decorator';
import { Audited } from '../audit-logs/audited.decorator';
import { FinanceApiGateGuard } from './finance-api-gate.guard';
import { FinanceService, FiscalGranularity } from './finance.service';
import { BillingExportDto } from './dto/billing-export.dto';
import { toCsv, sendCsv } from '../common/csv.util';
import { buildXlsx, sendXlsx, type XlsxSheet } from '../common/xlsx.util';
import { CurrentLang, reportT, type ReportLang } from '../common/i18n/report-i18n';

/**
 * Finance **org-level** (portefeuille), agrégée par client. Distinct de
 * `FinanceController` (scopé projet via `:projectId` + `@ProjectAccess`) : ici
 * pas de projet ciblé, donc pas de garde projet — `finance:view` suffit, et ce
 * scope n'est porté que par des rôles org-wide (ORG_ADMIN / PORTFOLIO_MANAGER /
 * GLOBAL_REPORT_VIEWER). Lecture `@PublicApi('finance:view')` mais gardée par
 * `FinanceApiGateGuard` : un jeton n'y accède que si `mcp.allowFinance` est on
 * (fail-closed sinon) ; le JWT navigateur n'est jamais affecté. ⚠️ Ne PAS
 * retirer le gate guard, c'est lui qui ferme la finance aux jetons.
 */
@ApiTags('finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, FinanceApiGateGuard)
@Controller('finance')
export class PortfolioFinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('portfolio')
  @PublicApi('finance:view')
  @RequirePermissions('finance:view')
  getPortfolio(
    @CurrentUser() user: AuthUser,
    @Query('granularity') granularity?: string,
    @Query('offset') offset?: string,
    @Query('clientId') clientId?: string,
  ) {
    const g: FiscalGranularity | undefined =
      granularity === 'quarter' || granularity === 'semester' || granularity === 'year'
        ? granularity
        : undefined;
    const off = offset != null && offset !== '' ? Number(offset) : undefined;
    return this.finance.getPortfolioFinance(user.orgId, {
      granularity: g,
      offset: Number.isFinite(off) ? off : undefined,
      clientId: clientId || undefined,
    });
  }

  /**
   * Export **facturation** : timesheet ligne à ligne (tous utilisateurs) +
   * valorisation, tickets externes inclus. App-privé only (PAS `@PublicApi` :
   * PII RH cross-user) ; gardé `finance:view` (rôles org-wide) + audit
   * `billing.exported`. CSV = feuille détail à plat ; XLSX = détail + synthèse.
   */
  @Get('billing-export.csv')
  @RequirePermissions('finance:view')
  @Audited('billing.exported', { resource: 'finance' })
  async billingExportCsv(
    @CurrentUser() user: AuthUser,
    @Query() dto: BillingExportDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const data = await this.finance.billingExport(user.orgId, requesterOf(user), dto);
    const t = reportT(lang);
    const headers = billingHeaders(t, data.currency);
    const rows = data.rows.map((r) => billingRow(t, r));
    sendCsv(res, `billing-${dto.from}_${dto.to}.csv`, toCsv(headers, rows));
  }

  @Get('billing-export.xlsx')
  @RequirePermissions('finance:view')
  @Audited('billing.exported', { resource: 'finance' })
  async billingExportXlsx(
    @CurrentUser() user: AuthUser,
    @Query() dto: BillingExportDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const data = await this.finance.billingExport(user.orgId, requesterOf(user), dto);
    const t = reportT(lang);
    const sheets: XlsxSheet[] = [
      {
        name: t('sheet.billingDetail'),
        headers: billingHeaders(t, data.currency),
        rows: data.rows.map((r) => billingRow(t, r)),
      },
      {
        name: t('sheet.summary'),
        headers: [t('be.client'), t('project'), t('name'), t('user'), t('tb.billableHours'), t('be.amount', { cur: data.currency })],
        rows: data.summary.map((s) => [s.clientName, s.projectKey, s.projectName, s.userName, s.billableHours, s.amount]),
      },
    ];
    const buf = await buildXlsx(sheets, { title: t('title.billingExport') });
    sendXlsx(res, `billing-${dto.from}_${dto.to}.xlsx`, buf);
  }
}

/** En-têtes de la feuille détail (une ligne par saisie de temps). */
function billingHeaders(t: ReturnType<typeof reportT>, cur: string): string[] {
  return [
    t('date'), t('user'), t('email'), t('project'), t('name'), t('be.client'),
    t('be.kind'), t('task'), t('be.ticketSource'), t('be.ticketKey'), t('be.ticketUrl'),
    t('hours'), t('overtime'), t('billable'), t('be.rate'), t('be.amount', { cur }), t('description'),
  ];
}

/** Une ligne détail (ordre aligné sur {@link billingHeaders}). */
function billingRow(
  t: ReturnType<typeof reportT>,
  r: {
    date: string; userName: string; userEmail: string; projectKey: string; projectName: string;
    clientName: string; kind: 'STANDARD' | 'EXTERNAL'; taskTitle: string;
    externalSource: string; externalKey: string; externalUrl: string;
    hours: number; overtimeHours: number; billable: boolean; billRate: number | null; amount: number; note: string;
  },
): unknown[] {
  return [
    r.date, r.userName, r.userEmail, r.projectKey, r.projectName, r.clientName,
    r.kind === 'EXTERNAL' ? t('kind.external') : t('kind.standard'),
    r.taskTitle, r.externalSource, r.externalKey, r.externalUrl,
    r.hours, r.overtimeHours, r.billable ? t('yes') : t('no'),
    r.billRate ?? '', r.amount, r.note,
  ];
}
