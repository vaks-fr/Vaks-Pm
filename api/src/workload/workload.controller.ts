import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
  fromProjectBody,
  fromTaskBody,
  fromAllocationParam,
  fromProjectQuery,
  fromTaskQuery,
} from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser, requesterOf } from '../auth/current-user.decorator';
import { WorkloadService } from './workload.service';
import { AutoplanService } from './autoplan.service';
import { AutoplanRequestDto } from './dto/autoplan.dto';
import { UpsertWorkScheduleDto } from './dto/work-schedule.dto';
import {
  BulkUpsertTimeOffsDto,
  CreateTimeOffDto,
  ImportTimeOffsCsvDto,
  ListTimeOffsQuery,
  UpdateTimeOffDto,
} from './dto/time-off.dto';
import {
  AutoSplitDto,
  AutoSplitMultiDto,
  CreateAllocationDto,
  ListAllocationsQuery,
  MoveAllocationDayDto,
  UpdateAllocationDto,
  WorkloadGridQuery,
} from './dto/allocation.dto';

@ApiTags('workload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
// IMPORTANT : pas de `@ProjectAccess` au niveau contrôleur — `:id` y désigne
// tantôt une allocation, tantôt un time-off. La résolution est donc déclarée
// route par route (les time-offs / work-schedules portent leur propre scoping
// user/admin dans le service).
@PublicApi()
@Controller()
export class WorkloadController {
  constructor(
    private readonly svc: WorkloadService,
    private readonly autoplan: AutoplanService,
  ) {}

  // -------- Autoplan --------
  @Post('workload/autoplan')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromProjectBody('projectId'))
  runAutoplan(@CurrentUser() user: AuthUser, @Body() dto: AutoplanRequestDto) {
    return this.autoplan.run(user.orgId, dto);
  }

  // -------- Work schedules --------
  // Lecture : self / admin / manager (allocation:manage) / équipe ou projet
  // commun avec la cible (cf. ProjectAccessService.canViewUserResource) —
  // `report:view` seul ne suffit plus à énumérer la capacité de toute l'org.
  @Get('users/:userId/work-schedule')
  @RequirePermissions('report:view')
  getSchedule(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.getScheduleFor(user.orgId, requesterOf(user), userId);
  }

  @Put('users/:userId/work-schedule')
  @RequirePermissions('allocation:manage')
  putSchedule(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpsertWorkScheduleDto,
  ) {
    return this.svc.upsertSchedule(user.orgId, requesterOf(user), userId, dto);
  }

  /** Supprime le schedule custom : l'user revient aux défauts d'organisation. */
  @Delete('users/:userId/work-schedule')
  @RequirePermissions('allocation:manage')
  deleteSchedule(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.deleteSchedule(user.orgId, requesterOf(user), userId);
  }

  // -------- Time offs --------
  @Get('time-offs')
  @RequirePermissions('report:view')
  listTimeOffs(@CurrentUser() user: AuthUser, @Query() q: ListTimeOffsQuery) {
    return this.svc.listTimeOffs(user.orgId, requesterOf(user), q);
  }

  @Post('time-offs')
  @RequirePermissions('allocation:manage')
  createTimeOff(@CurrentUser() user: AuthUser, @Body() dto: CreateTimeOffDto) {
    return this.svc.createTimeOff(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      dto,
    );
  }

  @Patch('time-offs/:id')
  @RequirePermissions('allocation:manage')
  updateTimeOff(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTimeOffDto,
  ) {
    return this.svc.updateTimeOff(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      id,
      dto,
    );
  }

  @Delete('time-offs/:id')
  @RequirePermissions('allocation:manage')
  removeTimeOff(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteTimeOff(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      id,
    );
  }

  /**
   * Sync depuis un système amont (SIRH, script…). Idempotent par externalId.
   * Scope étroit `timeoff:write` (et non `allocation:manage`) : une clé org
   * de connecteur inbound RH ne peut QUE pousser des absences — les routes
   * unitaires time-off / allocations / schedules restent sur `allocation:manage`
   * (asymétrie voulue). `requesterOf` traite la clé org comme un admin, ce qui
   * satisfait le check par-item `assertCanManageTimeOffFor` du service.
   */
  @Post('time-offs/bulk-upsert')
  @PublicApi('timeoff:write')
  @RequirePermissions('timeoff:write')
  bulkUpsertTimeOffs(
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkUpsertTimeOffsDto,
  ) {
    return this.svc.bulkUpsertTimeOffs(user.orgId, requesterOf(user), dto);
  }

  /** Import CSV : payload `{ csv: "...", dateFormat?: 'iso'|'eu'|'us' }`. */
  @Post('time-offs/import-csv')
  @PublicApi('timeoff:write')
  @RequirePermissions('timeoff:write')
  importTimeOffsCsv(
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportTimeOffsCsvDto,
  ) {
    return this.svc.importTimeOffsCsv(user.orgId, requesterOf(user), dto);
  }

  // -------- Allocations --------
  @Get('allocations')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'), fromTaskQuery('taskId'))
  listAllocations(
    @CurrentUser() user: AuthUser,
    @Query() q: ListAllocationsQuery,
  ) {
    return this.svc.listAllocations(user.orgId, requesterOf(user), q);
  }

  @Post('allocations')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromTaskBody('taskId'))
  createAllocation(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAllocationDto,
  ) {
    return this.svc.createAllocation(user.orgId, dto);
  }

  /**
   * Dry-run : ne persiste rien. Renvoie une plage proposée qui absorbe
   * `totalHours` à `hoursPerDay`, en sautant week-ends/TO/fériés du user.
   * Utilisé par le bouton "Auto-split" du panneau d'allocation.
   */
  @Post('allocations/auto-split')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromTaskBody('taskId'))
  autoSplit(@CurrentUser() user: AuthUser, @Body() dto: AutoSplitDto) {
    return this.svc.autoSplit(user.orgId, dto);
  }

  /**
   * Dry-run multi-personnes : répartit `totalHours` entre plusieurs
   * assignees selon `strategy` (proportional / equal / greedy), en
   * respectant la capacité propre de chacun. Renvoie un plan par personne
   * + le nombre de personnes manquantes si la deadline ne tient pas.
   */
  @Post('allocations/auto-split-multi')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromTaskBody('taskId'))
  autoSplitMulti(@CurrentUser() user: AuthUser, @Body() dto: AutoSplitMultiDto) {
    return this.svc.autoSplitMulti(user.orgId, dto);
  }

  /**
   * Déplace UN jour d'une allocation vers une autre case (user×date) de
   * façon transactionnelle. Évite les états partiels que produisait la
   * séquence update → create → create côté UI.
   */
  @Post('allocations/:id/move-day')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromAllocationParam('id'))
  moveDay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveAllocationDayDto,
  ) {
    return this.svc.moveAllocationDay(user.orgId, id, dto);
  }

  @Patch('allocations/:id')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromAllocationParam('id'))
  updateAllocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAllocationDto,
  ) {
    return this.svc.updateAllocation(user.orgId, id, dto);
  }

  @Delete('allocations/:id')
  @RequirePermissions('allocation:manage')
  @ProjectAccess(fromAllocationParam('id'))
  removeAllocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteAllocation(user.orgId, id);
  }

  // -------- Aggregated workload grid --------
  @Get('workload')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  workload(@CurrentUser() user: AuthUser, @Query() q: WorkloadGridQuery) {
    return this.svc.workloadGrid(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      q,
    );
  }

  /** Export CSV de la charge : une ligne par utilisateur × jour. */
  @Get('workload.csv')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  async workloadCsv(
    @CurrentUser() user: AuthUser,
    @Query() q: WorkloadGridQuery,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const g = await this.svc.workloadGrid(user.orgId, { userId: user.userId, isAdmin: user.isAdmin }, q);
    const rows: unknown[][] = [];
    for (const r of g.rows) {
      for (const c of r.cells) {
        rows.push([r.name, r.email, c.date, c.capacityHours, c.allocatedHours, cellStatus(c, lang)]);
      }
    }
    sendCsv(
      res,
      'workload.csv',
      toCsv([t('user'), t('email'), t('date'), t('wl.capacityH'), t('wl.plannedH'), t('status')], rows),
    );
  }

  /** Export XLSX de la charge : feuille détail (user × jour) + feuille synthèse. */
  @Get('workload.xlsx')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  async workloadXlsx(
    @CurrentUser() user: AuthUser,
    @Query() q: WorkloadGridQuery,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const g = await this.svc.workloadGrid(user.orgId, { userId: user.userId, isAdmin: user.isAdmin }, q);
    const detail: unknown[][] = [];
    for (const r of g.rows) {
      for (const c of r.cells) {
        detail.push([r.name, r.email, c.date, c.capacityHours, c.allocatedHours, cellStatus(c, lang)]);
      }
    }
    const summary = g.rows.map((r) => {
      const s = userTotals(r.cells);
      return [r.name, r.email, round1(s.cap), round1(s.alloc), s.cap > 0 ? Math.round((s.alloc / s.cap) * 100) : 0, s.overloaded];
    });
    const buf = await buildXlsx(
      [
        {
          name: t('sheet.summary'),
          headers: [t('user'), t('email'), t('wl.capacityH'), t('wl.plannedH'), t('wl.loadPct'), t('wl.overloadedDays')],
          rows: summary,
        },
        {
          name: t('sheet.detail'),
          headers: [t('user'), t('email'), t('date'), t('wl.capacityH'), t('wl.plannedH'), t('status')],
          rows: detail,
        },
      ],
      { title: t('title.workload') },
    );
    sendXlsx(res, 'workload.xlsx', buf);
  }

  /** Rapport PDF de la charge : KPIs + barres de charge % par personne + synthèse. */
  @Get('workload.pdf')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  async workloadPdf(
    @CurrentUser() user: AuthUser,
    @Query() q: WorkloadGridQuery,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const g = await this.svc.workloadGrid(user.orgId, { userId: user.userId, isAdmin: user.isAdmin }, q);
    const per = g.rows.map((r) => {
      const s = userTotals(r.cells);
      return {
        name: r.name,
        cap: round1(s.cap),
        alloc: round1(s.alloc),
        util: s.cap > 0 ? Math.round((s.alloc / s.cap) * 100) : 0,
        overloaded: s.overloaded,
      };
    });
    const totalCap = round1(per.reduce((a, p) => a + p.cap, 0));
    const totalAlloc = round1(per.reduce((a, p) => a + p.alloc, 0));
    const overloadedPeople = per.filter((p) => p.util > 100).length;

    const pdf = new PdfReport(t('title.workload'));
    pdf.header(t('hdr.nPeople', { n: g.rows.length }), { from: g.from, to: g.to });
    pdf.kpis([
      { label: t('kpi.totalCapacity'), value: `${totalCap}h` },
      { label: t('kpi.planned'), value: `${totalAlloc}h` },
      { label: t('kpi.avgLoad'), value: `${totalCap > 0 ? Math.round((totalAlloc / totalCap) * 100) : 0}%` },
      { label: t('kpi.overloaded'), value: String(overloadedPeople), hint: t('kpi.overloadedHint') },
    ]);

    pdf.section(t('sec.loadByPerson'));
    pdf.chart(
      barsSvg(per.map((p) => ({ label: p.name, value: p.util })), { width: PDF_CONTENT_WIDTH, valueSuffix: '%', max: 100, color: CHART_COLORS.accent }),
      PDF_CONTENT_WIDTH,
      Math.min(Math.max(per.length, 1), 12) * 22 + 8,
    );

    pdf.section(t('sec.summary'));
    pdf.table(
      [
        { header: t('col.person'), width: 3 },
        { header: t('wl.capacityH'), width: 1.5, align: 'right' },
        { header: t('wl.plannedH'), width: 1.5, align: 'right' },
        { header: t('wl.loadPct'), width: 1.2, align: 'right' },
        { header: t('wl.overloadedDays'), width: 1.6, align: 'right' },
      ],
      per.map((p) => [p.name, p.cap, p.alloc, `${p.util}%`, p.overloaded]),
    );

    sendPdf(res, 'workload.pdf', await pdf.finish());
  }
}

type WorkloadCell = { capacityHours: number; allocatedHours: number; timeOffType?: string | null; isHoliday?: boolean };

function cellStatus(c: WorkloadCell, lang: ReportLang): string {
  const t = reportT(lang);
  return c.isHoliday
    ? t('wlStatus.holiday')
    : c.timeOffType
      ? t('wlStatus.absence')
      : c.capacityHours <= 0
        ? t('wlStatus.nonWorking')
        : c.allocatedHours > c.capacityHours
          ? t('wlStatus.overload')
          : c.allocatedHours === 0
            ? t('wlStatus.free')
            : t('wlStatus.ok');
}

function userTotals(cells: WorkloadCell[]): { cap: number; alloc: number; overloaded: number } {
  let cap = 0;
  let alloc = 0;
  let overloaded = 0;
  for (const c of cells) {
    cap += c.capacityHours;
    alloc += c.allocatedHours;
    if (c.capacityHours > 0 && c.allocatedHours > c.capacityHours) overloaded++;
  }
  return { cap, alloc, overloaded };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
