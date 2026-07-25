import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { toCsv, sendCsv } from '../common/csv.util';
import { buildXlsx, sendXlsx } from '../common/xlsx.util';
import { PdfReport, sendPdf, PDF_CONTENT_WIDTH } from '../common/pdf.util';
import { barsSvg, CHART_COLORS } from '../common/charts.svg';
import { CurrentLang, reportT, type ReportLang } from '../common/i18n/report-i18n';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import {
  ProjectAccess,
  fromTaskParam,
  fromTaskBody,
  fromTimeEntryParam,
  fromProjectQuery,
  fromTaskQuery,
} from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser, requesterOf } from '../auth/current-user.decorator';
import { TimeEntriesService } from './time-entries.service';
import {
  CreateTimeEntryDto,
  ListTimeEntriesDto,
  TimesheetQueryDto,
  UpdateTimeEntryDto,
} from './dto/time-entry.dto';

const hrs = (min: number) => Math.round((min / 60) * 100) / 100; // minutes → heures

@ApiTags('time-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
// `:taskId` (time-summary), body `taskId` (create) et `:id` (time-entry) sont
// remontés au projet ; les filtres `?projectId`/`?taskId` du listing sont aussi
// contrôlés. NB : un listing SANS filtre n'est PAS scopé projet ici (voir le
// scoping user au niveau service — suivi séparément).
@ProjectAccess(
  fromTaskParam('taskId'),
  fromTaskBody('taskId'),
  fromTimeEntryParam('id'),
  fromProjectQuery('projectId'),
  fromTaskQuery('taskId'),
)
@PublicApi()
@Controller()
export class TimeEntriesController {
  constructor(private readonly svc: TimeEntriesService) {}

  // ----- Listing global avec filtres -----
  @Get('time-entries')
  @RequirePermissions('time:log')
  list(@CurrentUser() user: AuthUser, @Query() query: ListTimeEntriesDto) {
    return this.svc.list(user.orgId, requesterOf(user), query);
  }

  /** Export CSV des saisies de temps (filtres identiques au listing). */
  @Get('time-entries.csv')
  @RequirePermissions('time:log')
  async listCsv(
    @CurrentUser() user: AuthUser,
    @Query() query: ListTimeEntriesDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const entries = await this.svc.list(user.orgId, requesterOf(user), query);
    const rows = entries.map((e) => [
      e.date,
      e.user.name,
      e.user.email,
      e.task.title,
      Math.round((e.durationMinutes / 60) * 100) / 100,
      Math.round((e.overtimeMinutes / 60) * 100) / 100,
      e.task.projectBillable ? t('yes') : t('no'),
      e.description,
    ]);
    sendCsv(
      res,
      'time-entries.csv',
      toCsv([t('date'), t('user'), t('email'), t('task'), t('hours'), t('overtime'), t('billable'), t('description')], rows),
    );
  }

  /** Export XLSX des saisies de temps (filtres identiques au listing). */
  @Get('time-entries.xlsx')
  @RequirePermissions('time:log')
  async listXlsx(
    @CurrentUser() user: AuthUser,
    @Query() query: ListTimeEntriesDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const entries = await this.svc.list(user.orgId, requesterOf(user), query);
    const rows = entries.map((e) => [
      e.date,
      e.user.name,
      e.user.email,
      e.task.title,
      hrs(e.durationMinutes),
      hrs(e.overtimeMinutes),
      e.task.projectBillable ? t('yes') : t('no'),
      e.description,
    ]);
    const buf = await buildXlsx(
      [
        {
          name: t('sheet.timeEntries'),
          headers: [t('date'), t('user'), t('email'), t('task'), t('hours'), t('overtime'), t('billable'), t('description')],
          rows,
        },
      ],
      { title: t('sheet.timeEntries') },
    );
    sendXlsx(res, 'time-entries.xlsx', buf);
  }

  /** Rapport PDF des saisies de temps : KPIs + barres par utilisateur + table. */
  @Get('time-entries.pdf')
  @RequirePermissions('time:log')
  async listPdf(
    @CurrentUser() user: AuthUser,
    @Query() query: ListTimeEntriesDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const entries = await this.svc.list(user.orgId, requesterOf(user), query);
    let totalMin = 0;
    let billableMin = 0;
    let overtimeMin = 0;
    const byUser = new Map<string, number>();
    for (const e of entries) {
      totalMin += e.durationMinutes;
      if (e.task.projectBillable) billableMin += e.durationMinutes;
      overtimeMin += e.overtimeMinutes;
      byUser.set(e.user.name, (byUser.get(e.user.name) ?? 0) + e.durationMinutes);
    }
    const period =
      query.from && query.to ? { from: String(query.from), to: String(query.to) } : undefined;

    const pdf = new PdfReport(t('sheet.timeEntries'));
    pdf.header(t('hdr.nEntries', { n: entries.length }), period);
    pdf.kpis([
      { label: t('kpi.total'), value: `${hrs(totalMin)}h` },
      { label: t('kpi.billable'), value: `${hrs(billableMin)}h` },
      { label: t('kpi.nonBillable'), value: `${hrs(totalMin - billableMin)}h` },
      { label: t('kpi.overtime'), value: `${hrs(overtimeMin)}h` },
    ]);

    const users = [...byUser.entries()].map(([name, min]) => ({ label: name, value: hrs(min) })).sort((a, b) => b.value - a.value);
    pdf.section(t('sec.hoursByUser'));
    pdf.chart(
      barsSvg(users, { width: PDF_CONTENT_WIDTH, valueSuffix: 'h', color: CHART_COLORS.palette[1] }),
      PDF_CONTENT_WIDTH,
      Math.min(Math.max(users.length, 1), 12) * 22 + 8,
    );

    pdf.section(t('sec.detail'));
    pdf.table(
      [
        { header: t('date'), width: 1.3 },
        { header: t('user'), width: 2 },
        { header: t('task'), width: 3.2 },
        { header: t('hours'), width: 1, align: 'right' },
        { header: t('col.factShort'), width: 0.8, align: 'center' },
      ],
      entries.map((e) => [e.date, e.user.name, e.task.title, hrs(e.durationMinutes), e.task.projectBillable ? t('yes') : '']),
    );

    sendPdf(res, 'time-entries.pdf', await pdf.finish());
  }

  // ----- Vue timesheet (semaine) -----
  @Get('time-entries/timesheet')
  @RequirePermissions('time:log')
  timesheet(@CurrentUser() user: AuthUser, @Query() query: TimesheetQueryDto) {
    return this.svc.timesheet(user.orgId, user.userId, query);
  }

  // ----- Résumé estimé/réel d'une tâche -----
  @Get('tasks/:taskId/time-summary')
  @RequirePermissions('task:view')
  taskSummary(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.taskSummary(user.orgId, taskId);
  }

  // ----- CRUD -----
  @Post('time-entries')
  @RequirePermissions('time:log')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTimeEntryDto) {
    return this.svc.create(user.orgId, user.userId, dto);
  }

  @Patch('time-entries/:id')
  @RequirePermissions('time:log')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTimeEntryDto,
  ) {
    return this.svc.update(user.orgId, user.userId, user.isAdmin, id, dto);
  }

  @Delete('time-entries/:id')
  @RequirePermissions('time:log')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(user.orgId, user.userId, user.isAdmin, id);
  }
}
