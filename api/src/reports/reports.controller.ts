import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam, fromProjectQuery } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser, requesterOf } from '../auth/current-user.decorator';
import { ReportsService } from './reports.service';
import { SkillsService } from '../skills/skills.service';
import { BurndownDto, TimeBreakdownDto } from './dto/reports.dto';
import { toCsv, sendCsv } from '../common/csv.util';
import { buildXlsx, sendXlsx, type XlsxSheet } from '../common/xlsx.util';
import { PdfReport, sendPdf, PDF_CONTENT_WIDTH } from '../common/pdf.util';
import { burndownSvg, donutSvg, barsSvg, CHART_COLORS } from '../common/charts.svg';
import { CurrentLang, reportT, statusLabel, type ReportLang } from '../common/i18n/report-i18n';
import { renderStatusDeckPptx } from './status-deck';

const h = (min: number) => Math.round((min / 60) * 100) / 100; // minutes → heures

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
// Les routes scopées projet portent `:projectId` ; `reports/time-breakdown`
// n'en a pas (agrégat transverse, déjà filtré au user dans le service) → la
// source `projectId` y reste absente, donc non contrôlée par le guard.
@ProjectAccess(fromProjectParam('projectId'))
@PublicApi()
@Controller()
export class ReportsController {
  constructor(
    private readonly svc: ReportsService,
    private readonly skills: SkillsService,
  ) {}

  // ----- Stats projet (avancement, overdue, totaux heures) -----
  @Get('projects/:projectId/stats')
  @RequirePermissions('report:view')
  projectStats(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.projectStats(user.orgId, projectId);
  }

  // ----- Burndown projet sur une période -----
  @Get('projects/:projectId/burndown')
  @RequirePermissions('report:view')
  burndown(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
  ) {
    return this.svc.burndown(user.orgId, projectId, dto);
  }

  // ----- Respect des échéances projet -----
  @Get('projects/:projectId/due-adherence')
  @RequirePermissions('report:view')
  dueAdherence(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.dueAdherence(user.orgId, projectId);
  }

  // ----- Répartition heures / tâches par équipe (assignés → équipe) -----
  @Get('projects/:projectId/by-team')
  @RequirePermissions('report:view')
  byTeam(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.projectByTeam(user.orgId, projectId);
  }

  // ----- Cumulative Flow Diagram (depuis l'historique de statut) -----
  @Get('projects/:projectId/cfd')
  @RequirePermissions('report:view')
  cfd(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.svc.cfd(user.orgId, projectId, {
      from,
      to,
      granularity: granularity === 'week' ? 'week' : granularity === 'day' ? 'day' : undefined,
    });
  }

  // ----- KPIs agents IA (throughput, first-pass, re-travail, activité) -----
  // Fenêtré comme le burndown ; le service renvoie `enabled:false` si le
  // projet n'a pas `agentsEnabled` → l'UI n'affiche aucun bloc agent.
  @Get('projects/:projectId/agents-report')
  @RequirePermissions('report:view')
  agentsReport(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.agentsReport(user.orgId, projectId, { from, to });
  }

  // ----- KPIs qualité / périmètre (re-travail, bugs, scope creep) -----
  @Get('projects/:projectId/quality')
  @RequirePermissions('report:view')
  quality(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.quality(user.orgId, projectId);
  }

  // ----- Breakdown transverse temps : par projet × user × label -----
  @Get('reports/time-breakdown')
  @RequirePermissions('report:view')
  // Agrégat transverse : si filtré sur un projet, l'appelant doit y avoir accès
  // (sinon fuite du breakdown cross-user du projet). NB : sans filtre projet,
  // l'endpoint reste org-large (politique `report:view` — suivi séparément).
  @ProjectAccess(fromProjectQuery('projectId'))
  timeBreakdown(@CurrentUser() user: AuthUser, @Query() query: TimeBreakdownDto) {
    return this.svc.timeBreakdown(user.orgId, requesterOf(user), query);
  }

  // ----- Tâches dont la fenêtre [start, due] intersecte la période demandée -----
  @Get('projects/:projectId/tasks-in-window')
  @RequirePermissions('report:view')
  tasksInWindow(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
  ) {
    return this.svc.tasksInWindow(user.orgId, projectId, dto);
  }

  // ----- Statut projet composite : stats + due-adherence + tasks-in-window
  // + workload en UN seul aller-retour (cf. `ReportsService.projectStatus`).
  // `from`/`to` optionnels (défaut serveur). Pensé pour un unique tool MCP.
  @Get('projects/:projectId/status')
  @RequirePermissions('report:view')
  projectStatus(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.projectStatus(
      user.orgId,
      projectId,
      { userId: user.userId, isAdmin: user.isAdmin },
      { from, to },
    );
  }

  // ================= Exports CSV (téléchargeables + via API) =================

  @Get('projects/:projectId/stats.csv')
  @RequirePermissions('report:view')
  async statsCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const s = (await this.svc.projectStats(user.orgId, projectId)) as Record<string, unknown>;
    const rows: unknown[][] = [];
    for (const [k, v] of Object.entries(s)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) rows.push([`${k}.${k2}`, v2]);
      } else rows.push([k, Array.isArray(v) ? v.length : v]);
    }
    sendCsv(res, `stats-${projectId.slice(0, 8)}.csv`, toCsv([t('metric'), t('value')], rows));
  }

  @Get('projects/:projectId/burndown.csv')
  @RequirePermissions('report:view')
  async burndownCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.burndown(user.orgId, projectId, dto);
    const rows = r.points.map((p) => [p.date, p.idealRemainingHours, p.actualRemainingHours, p.doneTasks]);
    sendCsv(
      res,
      `burndown-${projectId.slice(0, 8)}.csv`,
      toCsv([t('date'), t('bd.ideal'), t('bd.actual'), t('bd.doneTasks')], rows),
    );
  }

  @Get('projects/:projectId/due-adherence.csv')
  @RequirePermissions('report:view')
  async dueAdherenceCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const a = await this.svc.dueAdherence(user.orgId, projectId);
    sendCsv(
      res,
      `due-adherence-${projectId.slice(0, 8)}.csv`,
      toCsv(
        [t('da.completed'), t('da.onTime'), t('da.late'), t('da.noDeadline'), t('da.onTimePct')],
        [[a.totalCompleted, a.onTime, a.late, a.noDeadline, a.onTimePct]],
      ),
    );
  }

  @Get('projects/:projectId/tasks-in-window.csv')
  @RequirePermissions('report:view')
  async tasksInWindowCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.tasksInWindow(user.orgId, projectId, dto);
    const rows = r.tasks.map((task) => [
      task.title,
      statusLabel(lang, task.status),
      task.startDate,
      task.dueDate,
      task.estimateHours,
      task.progressPct,
      task.overdue ? t('yes') : t('no'),
      task.assignees.map((x) => x.name).join(' / '),
    ]);
    sendCsv(
      res,
      `tasks-${projectId.slice(0, 8)}.csv`,
      toCsv([t('title'), t('status'), t('start'), t('dueDate'), t('estimateH'), t('progressPct'), t('overdue'), t('assignees')], rows),
    );
  }

  @Get('reports/time-breakdown.csv')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  async timeBreakdownCsv(
    @CurrentUser() user: AuthUser,
    @Query() query: TimeBreakdownDto,
    @Query('by') by: string | undefined,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.timeBreakdown(user.orgId, requesterOf(user), query);
    let headers: string[];
    let rows: unknown[][];
    if (by === 'user') {
      headers = [t('user'), t('email'), t('hours'), t('tb.billableHours')];
      rows = r.byUser.map((u) => [u.name, u.email, h(u.minutes), h(u.billable)]);
    } else if (by === 'label') {
      headers = [t('label'), t('hours')];
      rows = r.byLabel.map((l) => [l.name, h(l.minutes)]);
    } else {
      headers = [t('project'), t('name'), t('hours'), t('tb.billableHours')];
      rows = r.byProject.map((p) => [p.key, p.name, h(p.minutes), h(p.billable)]);
    }
    sendCsv(res, `time-breakdown-${by ?? 'project'}.csv`, toCsv(headers, rows));
  }

  // ================= Exports XLSX (classeurs stylés) =================

  @Get('projects/:projectId/stats.xlsx')
  @RequirePermissions('report:view')
  async statsXlsx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const s = await this.svc.projectStats(user.orgId, projectId);
    const rows: unknown[][] = [
      [t('stats.totalTasks'), s.totalTasks],
      [statusLabel(lang, 'TODO'), s.byStatus.TODO],
      [statusLabel(lang, 'IN_PROGRESS'), s.byStatus.IN_PROGRESS],
      [statusLabel(lang, 'IN_REVIEW'), s.byStatus.IN_REVIEW],
      [statusLabel(lang, 'DONE'), s.byStatus.DONE],
      [t('stats.completionPct'), s.completionPct],
      [t('overdue'), s.overdueTasks],
      [t('stats.estimatedHours'), s.totalEstimateHours],
      [t('stats.doneEstimatedHours'), s.doneEstimateHours],
      [t('stats.remainingHours'), s.remainingEstimateHours],
      [t('stats.spentHours'), h(s.totalSpentMinutes)],
    ];
    const buf = await buildXlsx([{ name: t('sheet.stats'), headers: [t('metric'), t('value')], rows }], {
      title: t('title.stats', { key: s.projectKey }),
    });
    sendXlsx(res, `stats-${s.projectKey}.xlsx`, buf);
  }

  @Get('projects/:projectId/burndown.xlsx')
  @RequirePermissions('report:view')
  async burndownXlsx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.burndown(user.orgId, projectId, dto);
    const rows = r.points.map((p) => [p.date, p.idealRemainingHours, p.actualRemainingHours, p.doneTasks]);
    const buf = await buildXlsx([
      { name: t('sheet.burndown'), headers: [t('date'), t('bd.ideal'), t('bd.actual'), t('bd.doneTasks')], rows },
    ]);
    sendXlsx(res, `burndown-${projectId.slice(0, 8)}.xlsx`, buf);
  }

  @Get('projects/:projectId/due-adherence.xlsx')
  @RequirePermissions('report:view')
  async dueAdherenceXlsx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const a = await this.svc.dueAdherence(user.orgId, projectId);
    const rows: unknown[][] = [
      [t('da.completed'), a.totalCompleted],
      [t('da.onTime'), a.onTime],
      [t('da.late'), a.late],
      [t('da.noDeadline'), a.noDeadline],
      [t('da.onTimePct'), a.onTimePct],
    ];
    const buf = await buildXlsx([{ name: t('sheet.dueDates'), headers: [t('metric'), t('value')], rows }]);
    sendXlsx(res, `due-adherence-${projectId.slice(0, 8)}.xlsx`, buf);
  }

  @Get('projects/:projectId/tasks-in-window.xlsx')
  @RequirePermissions('report:view')
  async tasksInWindowXlsx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.tasksInWindow(user.orgId, projectId, dto);
    const rows = r.tasks.map((task) => [
      task.title,
      statusLabel(lang, task.status),
      task.startDate ?? '',
      task.dueDate ?? '',
      task.estimateHours ?? '',
      task.progressPct,
      task.overdue ? t('yes') : t('no'),
      task.assignees.map((x) => x.name).join(' / '),
    ]);
    const buf = await buildXlsx([
      {
        name: t('sheet.tasks'),
        headers: [t('title'), t('status'), t('start'), t('dueDate'), t('estimateH'), t('progressPct'), t('overdue'), t('assignees')],
        rows,
      },
    ]);
    sendXlsx(res, `tasks-${projectId.slice(0, 8)}.xlsx`, buf);
  }

  // ----- Exports du reporting agents IA (fenêtré comme le burndown) -----

  @Get('projects/:projectId/agents-report.csv')
  @RequirePermissions('report:view')
  async agentsReportCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.agentsReport(user.orgId, projectId, dto);
    const rows: unknown[][] = r.perAgent.map((a) => [
      a.name, a.tasksCompleted, a.deliverables, a.approved,
      a.firstPassPct ?? '', a.avgRounds ?? '', a.runs, a.tokens,
    ]);
    rows.push([
      t('ag.total'), r.tasksCompleted, r.perAgent.reduce((s, a) => s + a.deliverables, 0),
      r.approvedDeliverables, r.firstPassApprovalPct ?? '', r.avgReviewRounds ?? '',
      r.runs, r.tokensIn + r.tokensOut,
    ]);
    sendCsv(
      res,
      `agents-report-${projectId.slice(0, 8)}.csv`,
      toCsv(
        [t('ag.agent'), t('ag.tasksCompleted'), t('ag.deliverables'), t('ag.approved'), t('ag.firstPassPct'), t('ag.avgRounds'), t('ag.runs'), t('ag.tokens')],
        rows,
      ),
    );
  }

  /** Classeur 3 feuilles : synthèse, par agent, série hebdo du throughput. */
  @Get('projects/:projectId/agents-report.xlsx')
  @RequirePermissions('report:view')
  async agentsReportXlsx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.agentsReport(user.orgId, projectId, dto);
    const sheets: XlsxSheet[] = [
      {
        name: t('sheet.agentsSummary'),
        headers: [t('metric'), t('value')],
        rows: [
          [t('ag.window'), `${r.from} → ${r.to}`],
          [t('ag.tasksCompleted'), r.tasksCompleted],
          [t('ag.approved'), r.approvedDeliverables],
          [t('ag.firstPassPct'), r.firstPassApprovalPct ?? '—'],
          [t('ag.avgRounds'), r.avgReviewRounds ?? '—'],
          [t('ag.turnaroundH'), r.avgReviewTurnaroundHours ?? '—'],
          [t('ag.activeAgents'), r.activeAgents],
          [t('ag.runs'), r.runs],
          [t('ag.tokensIn'), r.tokensIn],
          [t('ag.tokensOut'), r.tokensOut],
        ],
      },
      {
        name: t('sheet.agentsPerAgent'),
        headers: [t('ag.agent'), t('ag.tasksCompleted'), t('ag.deliverables'), t('ag.approved'), t('ag.firstPassPct'), t('ag.avgRounds'), t('ag.runs'), t('ag.tokens')],
        rows: r.perAgent.map((a) => [
          a.name, a.tasksCompleted, a.deliverables, a.approved,
          a.firstPassPct ?? '', a.avgRounds ?? '', a.runs, a.tokens,
        ]),
      },
      {
        name: t('sheet.agentsWeekly'),
        headers: [t('ag.weekStart'), t('ag.count')],
        rows: r.weekly.map((w) => [w.weekStart, w.count]),
      },
    ];
    const buf = await buildXlsx(sheets, { title: t('title.agents') });
    sendXlsx(res, `agents-report-${projectId.slice(0, 8)}.xlsx`, buf);
  }

  /** Classeur multi-feuilles : par projet, par utilisateur, par label. */
  @Get('reports/time-breakdown.xlsx')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  async timeBreakdownXlsx(
    @CurrentUser() user: AuthUser,
    @Query() query: TimeBreakdownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.timeBreakdown(user.orgId, requesterOf(user), query);
    const sheets: XlsxSheet[] = [
      {
        name: t('sheet.byProject'),
        headers: [t('project'), t('name'), t('hours'), t('tb.billableHours')],
        rows: r.byProject.map((p) => [p.key, p.name, h(p.minutes), h(p.billable)]),
      },
      {
        name: t('sheet.byUser'),
        headers: [t('user'), t('email'), t('hours'), t('tb.billableHours')],
        rows: r.byUser.map((u) => [u.name, u.email, h(u.minutes), h(u.billable)]),
      },
      {
        name: t('sheet.byLabel'),
        headers: [t('label'), t('hours')],
        rows: r.byLabel.map((l) => [l.name, h(l.minutes)]),
      },
    ];
    const buf = await buildXlsx(sheets, { title: t('title.timeBreakdown') });
    sendXlsx(res, 'time-breakdown.xlsx', buf);
  }

  // ================= Exports PDF (rapports mis en forme) =================

  /**
   * Rapport projet complet : KPIs + courbe burndown + donut d'adhérence aux
   * échéances + table des tâches de la fenêtre. `from`/`to` cadrent le burndown
   * et la fenêtre de tâches.
   */
  @Get('projects/:projectId/report.pdf')
  @RequirePermissions('report:view')
  async projectReportPdf(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() dto: BurndownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const tr = reportT(lang);
    const [stats, burn, due, win] = await Promise.all([
      this.svc.projectStats(user.orgId, projectId),
      this.svc.burndown(user.orgId, projectId, dto),
      this.svc.dueAdherence(user.orgId, projectId),
      this.svc.tasksInWindow(user.orgId, projectId, dto),
    ]);

    const pdf = new PdfReport(tr('pdf.projectReport'));
    pdf.header(`${stats.projectKey} — ${stats.projectName}`, { from: burn.from, to: burn.to });

    pdf.kpis([
      { label: tr('kpi.tasks'), value: String(stats.totalTasks), hint: tr('kpi.tasksHint', { done: stats.byStatus.DONE }) },
      { label: tr('kpi.progress'), value: `${stats.completionPct}%`, hint: `${stats.doneEstimateHours}/${stats.totalEstimateHours}h` },
      { label: tr('kpi.remaining'), value: `${stats.remainingEstimateHours}h` },
      { label: tr('kpi.overdue'), value: String(stats.overdueTasks) },
      { label: tr('kpi.spent'), value: `${h(stats.totalSpentMinutes)}h` },
    ]);

    pdf.section(tr('sec.burndown'));
    if (burn.totalScopeHours > 0) {
      pdf.chart(burndownSvg(burn.points, { width: PDF_CONTENT_WIDTH, height: 200 }), PDF_CONTENT_WIDTH, 200);
      pdf.legend([
        { label: tr('legend.ideal'), color: CHART_COLORS.ideal },
        { label: tr('legend.actual'), color: CHART_COLORS.accent },
      ]);
    } else {
      pdf.note(tr('note.noEstimate'));
    }

    pdf.section(tr('sec.dueAdherence'));
    if (due.totalCompleted > 0) {
      const donut = donutSvg(
        [
          { label: tr('da.onTime'), value: due.onTime, color: CHART_COLORS.good },
          { label: tr('da.late'), value: due.late, color: CHART_COLORS.bad },
          { label: tr('da.noDeadline'), value: due.noDeadline, color: CHART_COLORS.neutral },
        ],
        { size: 160, centerValue: `${due.onTimePct}%`, centerLabel: tr('donut.onTimeCenter') },
      );
      pdf.chart(donut, 160, 160, true);
      pdf.legend([
        { label: `${tr('da.onTime')} (${due.onTime})`, color: CHART_COLORS.good },
        { label: `${tr('da.late')} (${due.late})`, color: CHART_COLORS.bad },
        { label: `${tr('da.noDeadline')} (${due.noDeadline})`, color: CHART_COLORS.neutral },
      ]);
    } else {
      pdf.note(tr('note.noCompleted'));
    }

    // Couverture des compétences — seulement si l'appelant a accès à la vue
    // gap (PM/lead/admin, gating plus strict que report:view) ET que le
    // projet déclare des skills requis. Sinon, section omise sans bruit.
    try {
      await this.skills.assertCanViewProjectGap(user.orgId, projectId, {
        userId: user.userId,
        isAdmin: user.isAdmin,
      });
      const gap = await this.skills.computeSkillGapForProject(user.orgId, projectId);
      if (gap.length > 0) {
        const fully = gap.reduce((s, g) => s + g.fully, 0);
        const splittable = gap.reduce((s, g) => s + g.splittable, 0);
        const partial = gap.reduce((s, g) => s + g.partial, 0);
        const uncovered = gap.reduce((s, g) => s + g.uncovered, 0);
        pdf.section(tr('sec.skillCoverage'));
        pdf.kpis([
          { label: tr('kpi.covered'), value: String(fully) },
          { label: tr('kpi.splittable'), value: String(splittable) },
          { label: tr('kpi.partial'), value: String(partial) },
          { label: tr('kpi.uncovered'), value: String(uncovered) },
        ]);
        const atRisk = gap.flatMap((g) =>
          g.tasks
            .filter((task) => task.status === 'uncovered' || task.status === 'partial')
            .map((task) => ({ skill: g.name, task })),
        );
        if (atRisk.length > 0) {
          pdf.table(
            [
              { header: tr('col.skill'), width: 2 },
              { header: tr('task'), width: 3.5 },
              { header: tr('status'), width: 1.4 },
              { header: tr('col.remainingH'), width: 1.2, align: 'right' },
              { header: tr('col.freeH'), width: 1.2, align: 'right' },
            ],
            atRisk.map(({ skill, task }) => [
              skill,
              task.title,
              task.status === 'uncovered' ? tr('skillStatus.uncovered') : tr('skillStatus.partial'),
              task.remainingHours ?? '—',
              task.totalFreeHours,
            ]),
          );
        } else {
          pdf.note(tr('note.noAtRisk'));
        }
      }
    } catch {
      // Not allowed to view the gap → report without this section.
    }

    // Agents IA — seulement si le projet les autorise (enabled) ; section
    // omise sans bruit sinon (même approche que la couverture skills).
    const agents = await this.svc.agentsReport(user.orgId, projectId, dto);
    if (agents.enabled) {
      pdf.section(tr('sec.agents'));
      if (agents.tasksCompleted === 0 && agents.runs === 0 && agents.perAgent.length === 0) {
        pdf.note(tr('note.noAgentActivity'));
      } else {
        pdf.kpis([
          { label: tr('ag.tasksCompleted'), value: String(agents.tasksCompleted) },
          { label: tr('ag.firstPassPct'), value: agents.firstPassApprovalPct != null ? `${agents.firstPassApprovalPct}%` : '—' },
          { label: tr('ag.avgRounds'), value: agents.avgReviewRounds != null ? String(agents.avgReviewRounds) : '—' },
          { label: tr('ag.runs'), value: String(agents.runs) },
          { label: tr('ag.tokens'), value: String(agents.tokensIn + agents.tokensOut) },
        ]);
        if (agents.perAgent.length > 0) {
          pdf.table(
            [
              { header: tr('ag.agent'), width: 3 },
              { header: tr('ag.tasksCompleted'), width: 1.4, align: 'right' },
              { header: tr('ag.deliverables'), width: 1.4, align: 'right' },
              { header: tr('ag.approved'), width: 1.2, align: 'right' },
              { header: tr('ag.firstPassPct'), width: 1.2, align: 'right' },
              { header: tr('ag.runs'), width: 1, align: 'right' },
            ],
            agents.perAgent.map((a) => [
              a.name,
              a.tasksCompleted,
              a.deliverables,
              a.approved,
              a.firstPassPct != null ? `${a.firstPassPct}%` : '—',
              a.runs,
            ]),
          );
        }
      }
    }

    pdf.section(tr('sec.tasksInWindow', { n: win.tasks.length }));
    pdf.table(
      [
        { header: tr('task'), width: 4 },
        { header: tr('status'), width: 1.4 },
        { header: tr('dueDate'), width: 1.3 },
        { header: tr('col.estShort'), width: 1, align: 'right' },
        { header: tr('col.progShort'), width: 1, align: 'right' },
        { header: tr('assignees'), width: 2.5 },
      ],
      win.tasks.map((task) => [
        task.title + (task.overdue ? '  (!)' : ''),
        statusLabel(lang, task.status),
        task.dueDate ?? '—',
        task.estimateHours ?? '—',
        task.progressPct,
        task.assignees.map((a) => a.name).join(', ') || '—',
      ]),
    );

    sendPdf(res, `report-${stats.projectKey}.pdf`, await pdf.finish());
  }

  /**
   * Point de statut CLIENT en PowerPoint (.pptx). Livrable dépouillé (statut
   * éditorial, avancement, jalons, next steps, risques) — sans temps/agents/coûts,
   * contrairement à `report.pdf`. Remplit le template `.pptx` de l'org s'il existe,
   * sinon deck par défaut brandé Vaks. Rendu synchrone (fill = quelques ms).
   */
  @Get('projects/:projectId/status-deck.pptx')
  @RequirePermissions('report:view')
  async statusDeckPptx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const model = await this.svc.statusDeckModel(user.orgId, projectId, {
      preparedById: user.userId,
      preparedByFallback: user.email,
      lang,
    });
    const tpl = await this.svc.loadClientStatusTemplate(user.orgId);
    const buf = await renderStatusDeckPptx(model, tpl);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    res.setHeader('Content-Disposition', `attachment; filename="status-${model.projectKey}.pptx"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  /** Répartition du temps : barres par projet / utilisateur / label + tables. */
  @Get('reports/time-breakdown.pdf')
  @RequirePermissions('report:view')
  @ProjectAccess(fromProjectQuery('projectId'))
  async timeBreakdownPdf(
    @CurrentUser() user: AuthUser,
    @Query() query: TimeBreakdownDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    const r = await this.svc.timeBreakdown(user.orgId, requesterOf(user), query);
    const pdf = new PdfReport(t('title.timeBreakdown'));
    pdf.header(
      query.projectId ? t('sub.projectFiltered') : t('sub.wholeOrg'),
      query.from && query.to ? { from: query.from, to: query.to } : undefined,
    );
    pdf.kpis([
      { label: t('kpi.total'), value: `${h(r.totalMinutes)}h` },
      { label: t('kpi.billable'), value: `${h(r.billableMinutes)}h` },
      { label: t('kpi.nonBillable'), value: `${h(r.nonBillableMinutes)}h` },
    ]);

    pdf.section(t('sheet.byProject'));
    pdf.chart(barsSvg(r.byProject.map((p) => ({ label: `${p.key} ${p.name}`, value: h(p.minutes) })), { width: PDF_CONTENT_WIDTH, valueSuffix: 'h', color: CHART_COLORS.palette[0] }), PDF_CONTENT_WIDTH, barsHeight(r.byProject.length));

    pdf.section(t('sheet.byUser'));
    pdf.chart(barsSvg(r.byUser.map((u) => ({ label: u.name, value: h(u.minutes) })), { width: PDF_CONTENT_WIDTH, valueSuffix: 'h', color: CHART_COLORS.palette[1] }), PDF_CONTENT_WIDTH, barsHeight(r.byUser.length));

    pdf.section(t('sheet.byLabel'));
    pdf.chart(barsSvg(r.byLabel.map((l) => ({ label: l.name, value: h(l.minutes) })), { width: PDF_CONTENT_WIDTH, valueSuffix: 'h', color: CHART_COLORS.palette[4] }), PDF_CONTENT_WIDTH, barsHeight(r.byLabel.length));

    sendPdf(res, 'time-breakdown.pdf', await pdf.finish());
  }
}

/** Hauteur native d'un graphe en barres (rendu 1:1, voir `barsSvg`). */
function barsHeight(count: number): number {
  const rows = Math.min(Math.max(count, 1), 12);
  return rows * 22 + 8;
}
