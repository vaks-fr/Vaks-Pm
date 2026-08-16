import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, TimeOffType, WorkSchedule } from '@db';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { HolidaysService } from '../holidays/holidays.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { CacheService } from '../common/cache.service';
import {
  CapacityService,
  EffectiveSchedule,
  FillResult,
  UserCapacityCtx,
} from './capacity.service';
import { dateIso, excessLoggedHours, isPlanStale, startOfUtcDay, weekdayMonFirst } from './scheduling';
import { UpsertWorkScheduleDto } from './dto/work-schedule.dto';
import {
  BulkTimeOffItem,
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

const MS_PER_DAY = 86_400_000;

/** Borne dure du remplissage auto-split : empêche de boucler sur des inputs
 *  absurdes (totalHours immense + capacité ~0). 5 ans = largement assez. */
const MAX_SPLIT_DAYS = 365 * 5;

/** Suggestions retournées par autoSplit quand on n'arrive pas à absorber
 *  `totalHours` avant `mustFinishBy` — l'UI peut proposer ces alternatives
 *  à l'utilisateur (étendre la deadline, augmenter h/j, etc.). */
export interface AutoSplitAlternatives {
  /** Date où on absorberait `totalHours` SANS contrainte de deadline. */
  extendedEndDate: string | null;
  /** Nombre de jours de dépassement par rapport à la deadline. */
  extraDaysNeeded: number | null;
  /** h/j requis pour rentrer dans la deadline (null si impossible même à 24h/j). */
  requiredHoursPerDayToHitDeadline: number | null;
}

@Injectable()
export class WorkloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly holidays: HolidaysService,
    private readonly access: ProjectAccessService,
    private readonly capacity: CapacityService,
    private readonly moduleRef: ModuleRef,
    private readonly cache: CacheService,
  ) {}

  /**
   * Hooks d'automatisation résolus en **lazy** : `AutomationsModule` importe
   * `WorkloadModule` (pour `CapacityService`), un import direct dans l'autre
   * sens créerait un cycle. Best-effort — muet si le module n'est pas monté.
   */
  private automationHooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
  }

  /** Schedule virtuel construit à partir des défauts d'organisation. */
  private buildDefaultSchedule(orgId: string): Promise<EffectiveSchedule> {
    return this.capacity.buildDefaultSchedule(orgId);
  }

  // ============================================================
  // Work schedules
  // ============================================================

  /**
   * Schedule effectif d'un user à une date donnée. Si l'utilisateur a une
   * ligne `WorkSchedule` la plus récente <= `on`, elle prévaut. Sinon on
   * renvoie un schedule virtuel calculé sur les défauts d'organisation —
   * sans rien persister, pour que tout changement des défauts impacte
   * immédiatement les users qui les suivent.
   */
  /** Variante exposée à l'API : vérifie que `requester` peut voir la capacité
   *  de `userId` (self / admin / manager / équipe ou projet commun) avant de
   *  déléguer à {@link getActiveSchedule} (qui reste l'entrée interne sans
   *  contrôle, utilisée par les calculs de grille/autoplan). */
  async getScheduleFor(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    userId: string,
  ) {
    await this.assertUserInOrg(orgId, userId);
    const ok = await this.access.canViewUserResource(orgId, requester, userId);
    if (!ok) {
      throw new ForbiddenException(
        "Vous n'avez pas accès au planning de cet utilisateur",
      );
    }
    return this.getActiveSchedule(orgId, userId);
  }

  async getActiveSchedule(orgId: string, userId: string, on = new Date()) {
    await this.assertUserInOrg(orgId, userId);
    const active = await this.prisma.workSchedule.findFirst({
      where: { userId, organizationId: orgId, effectiveFrom: { lte: startOfUtcDay(on) } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (active) return { ...active, isDefault: false };
    const def = await this.buildDefaultSchedule(orgId);
    // Forme compatible avec WorkScheduleDto : id/userId/orgId/effectiveFrom
    // synthétiques pour les consommateurs frontaux.
    return {
      id: '',
      userId,
      organizationId: orgId,
      effectiveFrom: startOfUtcDay(on),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...def,
    };
  }

  async upsertSchedule(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    userId: string,
    dto: UpsertWorkScheduleDto,
  ) {
    await this.assertUserInOrg(orgId, userId);
    // Même règle que les congés : la capacité d'un user est une ressource
    // managée (admin ou lead d'une de ses équipes), `allocation:manage` org
    // ne suffit pas à éditer n'importe qui.
    await this.assertCanManageTimeOffFor(orgId, requester, userId);
    const effectiveFrom = dto.effectiveFrom
      ? startOfUtcDay(new Date(dto.effectiveFrom))
      : startOfUtcDay(new Date());
    const def = await this.buildDefaultSchedule(orgId);
    const data = {
      userId,
      organizationId: orgId,
      effectiveFrom,
      hoursMon: dto.hoursMon ?? def.hoursMon,
      hoursTue: dto.hoursTue ?? def.hoursTue,
      hoursWed: dto.hoursWed ?? def.hoursWed,
      hoursThu: dto.hoursThu ?? def.hoursThu,
      hoursFri: dto.hoursFri ?? def.hoursFri,
      hoursSat: dto.hoursSat ?? def.hoursSat,
      hoursSun: dto.hoursSun ?? def.hoursSun,
      occupancyPct: dto.occupancyPct ?? 100,
    };
    return this.prisma.workSchedule.upsert({
      where: { userId_effectiveFrom: { userId, effectiveFrom } },
      update: data,
      create: data,
    });
  }

  /** Supprime toutes les lignes `WorkSchedule` d'un user → revient aux défauts org. */
  async deleteSchedule(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    userId: string,
  ) {
    await this.assertUserInOrg(orgId, userId);
    await this.assertCanManageTimeOffFor(orgId, requester, userId);
    const r = await this.prisma.workSchedule.deleteMany({
      where: { userId, organizationId: orgId },
    });
    return { userId, deleted: r.count };
  }

  // ============================================================
  // Time offs
  // ============================================================

  async listTimeOffs(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: ListTimeOffsQuery,
  ) {
    const where: Prisma.TimeOffWhereInput = { organizationId: orgId };
    // SÉCURITÉ — Les congés exposent des données personnelles sensibles (type
    // SICK/PARENTAL, notes libres). `report:view` est une permission de niveau
    // membre : sans ce scoping, n'importe quel membre énumérerait les absences
    // de toute l'org. On restreint à l'ensemble visible (self / équipe / projet
    // commun), sauf admin / gestionnaire (allocation:manage / member:manage).
    const scope = await this.access.accessibleUserScope(orgId, requester.userId, requester.isAdmin);
    if (scope !== null) {
      where.userId = q.userId
        ? scope.includes(q.userId)
          ? q.userId
          : '__none__' // userId demandé hors scope → aucun résultat
        : { in: scope };
    } else if (q.userId) {
      where.userId = q.userId;
    }
    if (q.from || q.to) {
      // Intersection avec [from..to]
      const from = q.from ? startOfUtcDay(new Date(q.from)) : undefined;
      const to = q.to ? startOfUtcDay(new Date(q.to)) : undefined;
      const and: Prisma.TimeOffWhereInput[] = [];
      if (to) and.push({ startDate: { lte: to } });
      if (from) and.push({ endDate: { gte: from } });
      if (and.length) where.AND = and;
    }
    const rows = await this.prisma.timeOff.findMany({
      where,
      orderBy: { startDate: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return rows.map(this.toTimeOffDto);
  }

  /**
   * Vérifie que le requester peut gérer les congés — et, même règle, le
   * work-schedule — de `targetUserId`.
   * Règle : Org Admin OK ; sinon il doit être `isLead` dans au moins une
   * équipe dont le user cible est membre. Volontairement strict — la
   * gestion fine RH n'est pas dans le scope de l'outil.
   */
  private async assertCanManageTimeOffFor(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    targetUserId: string,
  ) {
    if (requester.isAdmin) return;
    const sharedLead = await this.prisma.teamMember.findFirst({
      where: {
        userId: requester.userId,
        isLead: true,
        team: {
          organizationId: orgId,
          deletedAt: null,
          members: { some: { userId: targetUserId } },
        },
      },
      select: { teamId: true },
    });
    if (!sharedLead) {
      throw new ForbiddenException(
        "Vous devez être team lead d'une équipe dont cet utilisateur est membre",
      );
    }
  }

  async createTimeOff(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    dto: CreateTimeOffDto,
  ) {
    await this.assertUserInOrg(orgId, dto.userId);
    await this.assertCanManageTimeOffFor(orgId, requester, dto.userId);
    const start = startOfUtcDay(new Date(dto.startDate));
    const end = startOfUtcDay(new Date(dto.endDate));
    if (end.getTime() < start.getTime())
      throw new BadRequestException('endDate must be on or after startDate');
    const t = await this.prisma.timeOff.create({
      data: {
        organizationId: orgId,
        userId: dto.userId,
        startDate: start,
        endDate: end,
        type: dto.type ?? TimeOffType.VACATION,
        notes: dto.notes ?? null,
        source: 'MANUAL',
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    // Automatisation « congé vs allocations » : le plan devient faux dès que
    // l'absence est posée (fire-and-forget, jamais bloquant).
    void this.automationHooks()?.onTimeOffCreated(orgId, {
      userId: dto.userId,
      startDate: start,
      endDate: end,
    });
    return this.toTimeOffDto(t);
  }

  async updateTimeOff(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    id: string,
    dto: UpdateTimeOffDto,
  ) {
    const existing = await this.prisma.timeOff.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Time off introuvable');
    await this.assertCanManageTimeOffFor(orgId, requester, existing.userId);
    const data: Prisma.TimeOffUpdateInput = {};
    if (dto.startDate) data.startDate = startOfUtcDay(new Date(dto.startDate));
    if (dto.endDate) data.endDate = startOfUtcDay(new Date(dto.endDate));
    if (dto.type) data.type = dto.type;
    if (dto.notes !== undefined) data.notes = dto.notes;
    const t = await this.prisma.timeOff.update({
      where: { id },
      data,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return this.toTimeOffDto(t);
  }

  async deleteTimeOff(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    id: string,
  ) {
    const existing = await this.prisma.timeOff.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Time off introuvable');
    await this.assertCanManageTimeOffFor(orgId, requester, existing.userId);
    await this.prisma.timeOff.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Upsert idempotent d'une liste de time-offs. Match par
   * `(organizationId, source, externalId)` quand `externalId` est fourni ;
   * sinon création pure. Le requester doit pouvoir gérer chaque user
   * cible (Org Admin ou Team Lead partagé) — sinon l'item est rejeté en
   * `forbidden`, sans interrompre le batch.
   */
  async bulkUpsertTimeOffs(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    dto: BulkUpsertTimeOffsDto,
  ) {
    const source = dto.source ?? 'API';
    const created: ReturnType<WorkloadService['toTimeOffDto']>[] = [];
    const updated: ReturnType<WorkloadService['toTimeOffDto']>[] = [];
    const errors: { index: number; reason: string }[] = [];

    for (let i = 0; i < dto.items.length; i++) {
      const it = dto.items[i];
      try {
        const userId = await this.resolveUserId(orgId, it);
        if (!userId) {
          errors.push({ index: i, reason: 'user-not-found' });
          continue;
        }
        await this.assertCanManageTimeOffFor(orgId, requester, userId);
        const start = startOfUtcDay(new Date(it.startDate));
        const end = startOfUtcDay(new Date(it.endDate));
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          errors.push({ index: i, reason: 'invalid-date' });
          continue;
        }
        if (end.getTime() < start.getTime()) {
          errors.push({ index: i, reason: 'end-before-start' });
          continue;
        }
        const data = {
          organizationId: orgId,
          userId,
          startDate: start,
          endDate: end,
          type: it.type ?? TimeOffType.VACATION,
          notes: it.notes ?? null,
          source,
          externalId: it.externalId ?? null,
        };
        if (it.externalId) {
          // Upsert sur la clé composite (orgId, source, externalId).
          const existing = await this.prisma.timeOff.findFirst({
            where: {
              organizationId: orgId,
              source,
              externalId: it.externalId,
            },
          });
          if (existing) {
            const t = await this.prisma.timeOff.update({
              where: { id: existing.id },
              data: {
                userId,
                startDate: start,
                endDate: end,
                type: data.type,
                notes: data.notes,
              },
              include: { user: { select: { id: true, name: true, email: true } } },
            });
            updated.push(this.toTimeOffDto(t));
            continue;
          }
        }
        const t = await this.prisma.timeOff.create({
          data,
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        created.push(this.toTimeOffDto(t));
      } catch (e: any) {
        errors.push({ index: i, reason: e?.message ?? 'error' });
      }
    }

    return {
      created: created.length,
      updated: updated.length,
      errors,
      items: [...created, ...updated],
    };
  }

  /**
   * Import CSV → délègue à `bulkUpsertTimeOffs` après parsing.
   * Le format de date est résolu via le param explicite ou le setting
   * org `locale` (en-US → us, sinon eu). ISO YYYY-MM-DD toujours accepté.
   */
  async importTimeOffsCsv(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    dto: ImportTimeOffsCsvDto,
  ) {
    const format: 'iso' | 'eu' | 'us' =
      dto.dateFormat ??
      (await this.settings.getDefaultLocale(orgId).then((loc) =>
        loc === 'en-US' ? 'us' : 'eu',
      ));

    const { rows, headerErrors } = parseCsv(dto.csv);
    if (headerErrors.length) {
      throw new BadRequestException(headerErrors.join('; '));
    }

    const items: BulkTimeOffItem[] = [];
    const lineErrors: { index: number; reason: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const startIso = parseDateInput(r.startDate, format);
      const endIso = parseDateInput(r.endDate, format);
      if (!startIso || !endIso) {
        lineErrors.push({ index: i, reason: 'invalid-date' });
        continue;
      }
      const type = (r.type || '').toUpperCase();
      const item: BulkTimeOffItem = {
        userId: r.userId || undefined,
        employeeId: r.employeeId || undefined,
        email: r.email || undefined,
        startDate: startIso,
        endDate: endIso,
        type: (TimeOffType as Record<string, TimeOffType>)[type] ?? undefined,
        notes: r.notes || undefined,
        externalId: r.externalId || undefined,
      };
      if (!item.userId && !item.employeeId && !item.email) {
        lineErrors.push({ index: i, reason: 'no-user-key' });
        continue;
      }
      items.push(item);
    }

    if (items.length === 0) {
      return { created: 0, updated: 0, errors: lineErrors, items: [] };
    }

    const result = await this.bulkUpsertTimeOffs(orgId, requester, {
      items,
      source: 'IMPORT',
    });
    return { ...result, errors: [...lineErrors, ...result.errors] };
  }

  /** Résout l'user cible par userId > employeeId > email, scoping org. */
  private async resolveUserId(
    orgId: string,
    it: { userId?: string; employeeId?: string; email?: string },
  ): Promise<string | null> {
    if (it.userId) {
      const u = await this.prisma.user.findFirst({
        where: { id: it.userId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      return u?.id ?? null;
    }
    if (it.employeeId) {
      const u = await this.prisma.user.findFirst({
        where: { employeeId: it.employeeId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      return u?.id ?? null;
    }
    if (it.email) {
      const u = await this.prisma.user.findFirst({
        where: { email: it.email, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      return u?.id ?? null;
    }
    return null;
  }

  // ============================================================
  // Allocations
  // ============================================================

  async listAllocations(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: ListAllocationsQuery,
  ) {
    const where: Prisma.AllocationWhereInput = { organizationId: orgId };
    if (q.userId) where.userId = q.userId;
    if (q.projectId) where.projectId = q.projectId;
    if (q.taskId) where.taskId = q.taskId;
    const and: Prisma.AllocationWhereInput[] = [];
    if (q.from || q.to) {
      const from = q.from ? startOfUtcDay(new Date(q.from)) : undefined;
      const to = q.to ? startOfUtcDay(new Date(q.to)) : undefined;
      if (to) and.push({ startDate: { lte: to } });
      if (from) and.push({ endDate: { gte: from } });
    }
    // Scoping transverse : sans droit de lecture élevé, l'appelant ne voit que
    // ses propres allocations + celles des projets accessibles (sinon fuite de
    // la charge de toute l'org à un simple membre). cf. workloadGrid qui
    // self-scope déjà par équipe.
    const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);
    if (scope !== null) {
      and.push({ OR: [{ userId: requester.userId }, { projectId: { in: scope } }] });
    }
    if (and.length) where.AND = and;
    const rows = await this.prisma.allocation.findMany({
      where,
      orderBy: { startDate: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true, countryCode: true } },
        task: { select: { id: true, title: true } },
      },
    });
    const effective = await this.computeEffectiveHoursBatch(orgId, rows);
    return rows.map((a) => this.toAllocationDto(a, effective.get(a.id)));
  }

  /**
   * Pour chaque allocation, calcule `workdays`, `effectiveHours` et
   * `blockedDays` en tenant compte du `WorkSchedule` (custom ou défaut org),
   * des `TimeOff`, et des jours fériés du `countryCode` du user.
   *
   * On regroupe tous les inputs en un seul batch pour ne pas multiplier les
   * requêtes Prisma quand on liste N allocations d'un même projet/tâche.
   */
  // Public : réutilisé par FinanceService pour le coût prévisionnel (heures
  // d'allocation effectives × taux), afin de rester cohérent avec la grille
  // Workload (mêmes schedule / time-off / fériés).
  async computeEffectiveHoursBatch(
    orgId: string,
    rows: ReadonlyArray<{
      id: string;
      userId: string;
      startDate: Date;
      endDate: Date;
      hoursPerDay: number;
      user?: { countryCode?: string | null } | null;
    }>,
  ): Promise<Map<string, { workdays: number; effectiveHours: number; blockedDays: number }>> {
    const out = new Map<string, { workdays: number; effectiveHours: number; blockedDays: number }>();
    if (rows.length === 0) return out;

    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    let minStart = +rows[0].startDate;
    let maxEnd = +rows[0].endDate;
    for (const r of rows) {
      if (+r.startDate < minStart) minStart = +r.startDate;
      if (+r.endDate > maxEnd) maxEnd = +r.endDate;
    }
    const minStartDate = new Date(minStart);
    const maxEndDate = new Date(maxEnd);

    const [schedules, timeOffs, defaultCountry, defaultSchedule] = await Promise.all([
      this.prisma.workSchedule.findMany({
        where: {
          userId: { in: userIds },
          organizationId: orgId,
          effectiveFrom: { lte: maxEndDate },
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.prisma.timeOff.findMany({
        where: {
          userId: { in: userIds },
          organizationId: orgId,
          startDate: { lte: maxEndDate },
          endDate: { gte: minStartDate },
        },
        select: { userId: true, startDate: true, endDate: true },
      }),
      this.holidays.getDefaultCountry(orgId),
      this.buildDefaultSchedule(orgId),
    ]);

    // Premier schedule par user (le plus récent <= maxEndDate). Pour le MVP
    // on prend une seule ligne sur toute la fenêtre — si un user change de
    // schedule mi-allocation, c'est l'actuel qui prévaut. À raffiner si besoin.
    const scheduleByUser = new Map<string, EffectiveSchedule>();
    for (const s of schedules) {
      if (!scheduleByUser.has(s.userId)) {
        scheduleByUser.set(s.userId, { ...s, isDefault: false });
      }
    }

    // Holidays per user (selon countryCode user ou défaut org).
    // `new Map` dédoublonne déjà par clé userId ; le countryCode d'un même user
    // est identique sur toutes ses lignes → pas de filtre de dédup (l'ancien
    // `.filter(...findIndex...)` était un O(n²) sans effet).
    const userById = new Map(
      rows.map((r) => [r.userId, r.user?.countryCode ?? null] as const),
    );
    const holidaysByUser = new Map<string, Set<string>>();
    const fromIso = dateIso(minStartDate);
    const toIso = dateIso(maxEndDate);
    for (const uid of userIds) {
      const cc = (userById.get(uid) || defaultCountry).toUpperCase();
      const set = new Set<string>();
      for (const h of this.holidays.forCountryRange(cc, fromIso, toIso)) {
        set.add(h.date);
      }
      holidaysByUser.set(uid, set);
    }

    // Time-off index par user → list.
    const toByUser = new Map<string, { startDate: Date; endDate: Date }[]>();
    for (const t of timeOffs) {
      const arr = toByUser.get(t.userId) ?? [];
      arr.push({ startDate: t.startDate, endDate: t.endDate });
      toByUser.set(t.userId, arr);
    }

    for (const a of rows) {
      const sched = scheduleByUser.get(a.userId) ?? defaultSchedule;
      const myTo = toByUser.get(a.userId) ?? [];
      const myHol = holidaysByUser.get(a.userId) ?? new Set<string>();
      const occ = (sched.occupancyPct ?? 100) / 100;
      let workdays = 0;
      let effectiveHours = 0;
      let blockedDays = 0;
      for (let t = +a.startDate; t <= +a.endDate; t += MS_PER_DAY) {
        const d = new Date(t);
        const iso = dateIso(d);
        const cap = scheduleHoursFor(sched, d) * occ;
        const isOff = myTo.some(
          (o) => +o.startDate <= t && +o.endDate >= t,
        );
        if (cap <= 0 || isOff || myHol.has(iso)) {
          blockedDays++;
          continue;
        }
        workdays++;
        // Plafonne à la capacité du jour : un user à 4h/j n'absorbera pas 8h.
        effectiveHours += Math.min(a.hoursPerDay, cap);
      }
      out.set(a.id, {
        workdays,
        effectiveHours: round(effectiveHours),
        blockedDays,
      });
    }
    return out;
  }

  /**
   * Vérifie qu'aucun jour de la plage [startDate, endDate] ne ferait dépasser
   * 24h de charge cumulée pour `userId` (allocation en cours d'écriture
   * incluse, optionnellement excluant `excludeAllocationId` lors d'un update).
   * Lève BadRequestException si un jour dépasse, en indiquant le jour fautif.
   */
  private async assertNoDailyOverbook(
    orgId: string,
    userId: string,
    startDate: Date,
    endDate: Date,
    hoursPerDay: number,
    excludeAllocationId?: string,
  ) {
    const MAX_HOURS_PER_DAY = 24;
    const others = await this.prisma.allocation.findMany({
      where: {
        organizationId: orgId,
        userId,
        ...(excludeAllocationId ? { id: { not: excludeAllocationId } } : {}),
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { startDate: true, endDate: true, hoursPerDay: true },
    });
    // Itère chaque jour de la nouvelle allocation et somme les autres.
    const cur = new Date(startDate);
    const end = new Date(endDate);
    while (cur.getTime() <= end.getTime()) {
      let total = hoursPerDay;
      for (const o of others) {
        if (o.startDate.getTime() <= cur.getTime() && o.endDate.getTime() >= cur.getTime()) {
          total += o.hoursPerDay;
        }
      }
      if (total > MAX_HOURS_PER_DAY) {
        throw new BadRequestException(
          `Allocation refusée : ${total.toFixed(1)}h cumulées le ${cur.toISOString().slice(0, 10)} (max ${MAX_HOURS_PER_DAY}h/jour).`,
        );
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  async createAllocation(orgId: string, dto: CreateAllocationDto) {
    await this.assertUserInOrg(orgId, dto.userId);
    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        project: { select: { kind: true } },
        assignees: { select: { userId: true } },
      },
    });
    if (!task) throw new BadRequestException('Task introuvable');
    // Les tickets externes (projet EXTERNAL) ne portent JAMAIS d'allocation :
    // ils ne vivent que dans la timesheet (temps réel loggé), jamais dans le
    // workload (charge planifiée). Verrou central — auto-split et autoplan
    // passent aussi par ici ou filtrent en amont.
    if (task.project.kind === 'EXTERNAL') {
      throw new BadRequestException(
        'Impossible de planifier une allocation sur un ticket externe (timesheet uniquement).',
      );
    }
    // Une allocation cible obligatoirement un assignee : ça force à passer par
    // l'attribution explicite (qui porte les règles RBAC et la cohérence avec
    // les équipes), au lieu de "réserver" du workload sur quelqu'un qui n'est
    // pas censé travailler dessus.
    const assigneeIds = new Set(task.assignees.map((a) => a.userId));
    if (!assigneeIds.has(dto.userId)) {
      throw new BadRequestException(
        'User is not assigned to this task — assign them first before allocating.',
      );
    }
    const start = startOfUtcDay(new Date(dto.startDate));
    const end = startOfUtcDay(new Date(dto.endDate));
    if (end.getTime() < start.getTime())
      throw new BadRequestException('endDate must be on or after startDate');
    if (dto.hoursPerDay <= 0 || dto.hoursPerDay > 24)
      throw new BadRequestException('hoursPerDay doit être compris entre 0 et 24.');
    await this.assertNoDailyOverbook(orgId, dto.userId, start, end, dto.hoursPerDay);
    const a = await this.prisma.allocation.create({
      data: {
        organizationId: orgId,
        userId: dto.userId,
        taskId: task.id,
        projectId: task.projectId,
        startDate: start,
        endDate: end,
        hoursPerDay: dto.hoursPerDay,
        notes: dto.notes ?? null,
        // Origine : manuel (défaut) = posé à la main, protégé de l'auto-plan
        // (isManual:true). auto-split = planning automatique par tâche
        // (isManual:false, isAutoPlan:false → distinct de l'auto-plan projet).
        isManual: dto.origin !== 'auto_split',
      },
      include: {
        user: { select: { id: true, name: true, email: true, countryCode: true } },
        task: { select: { id: true, title: true } },
      },
    });
    const effective = await this.computeEffectiveHoursBatch(orgId, [a]);
    return this.toAllocationDto(a, effective.get(a.id));
  }

  async updateAllocation(orgId: string, id: string, dto: UpdateAllocationDto) {
    const existing = await this.prisma.allocation.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Allocation introuvable');
    const data: Prisma.AllocationUpdateInput = {};
    if (dto.userId) {
      await this.assertUserInOrg(orgId, dto.userId);
      // Réassigner une allocation à quelqu'un qui n'est pas assignee de la
      // tâche est interdit : mêmes raisons que createAllocation.
      const assignees = await this.prisma.taskAssignee.findMany({
        where: { taskId: existing.taskId },
        select: { userId: true },
      });
      if (!assignees.some((a) => a.userId === dto.userId)) {
        throw new BadRequestException(
          'User is not assigned to this task — assign them first before reassigning the allocation.',
        );
      }
      data.user = { connect: { id: dto.userId } };
    }
    if (dto.startDate) data.startDate = startOfUtcDay(new Date(dto.startDate));
    if (dto.endDate) data.endDate = startOfUtcDay(new Date(dto.endDate));
    if (dto.hoursPerDay !== undefined) {
      if (dto.hoursPerDay <= 0 || dto.hoursPerDay > 24)
        throw new BadRequestException('hoursPerDay doit être compris entre 0 et 24.');
      data.hoursPerDay = dto.hoursPerDay;
    }
    if (dto.notes !== undefined) data.notes = dto.notes;
    // Validation cap journalier 24h : on évalue avec les valeurs effectives
    // (post-update) pour ce qui change, en excluant l'allocation elle-même
    // de la somme des "autres".
    const effectiveUserId = dto.userId ?? existing.userId;
    const effectiveStart = dto.startDate ? startOfUtcDay(new Date(dto.startDate)) : existing.startDate;
    const effectiveEnd = dto.endDate ? startOfUtcDay(new Date(dto.endDate)) : existing.endDate;
    const effectiveHpd = dto.hoursPerDay ?? existing.hoursPerDay;
    await this.assertNoDailyOverbook(
      orgId,
      effectiveUserId,
      effectiveStart,
      effectiveEnd,
      effectiveHpd,
      id,
    );
    const a = await this.prisma.allocation.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, name: true, email: true, countryCode: true } },
        task: { select: { id: true, title: true } },
      },
    });
    const effective = await this.computeEffectiveHoursBatch(orgId, [a]);
    return this.toAllocationDto(a, effective.get(a.id));
  }

  /**
   * Déplace UN seul jour d'une allocation source vers une autre case
   * (autre user / autre date) dans une transaction Prisma : trim/split
   * de la source + création de la case cible. Renvoie un snapshot pour
   * permettre un undo côté UI.
   *
   * - Si source mono-jour : équivaut à un update (userId + dates).
   * - Sinon, selon la position de `fromDate` dans le range :
   *   - bord gauche → start = start+1
   *   - bord droit  → end = end-1
   *   - milieu      → end = fromDate-1 + nouvelle alloc [fromDate+1..end]
   * - Puis création d'une alloc mono-jour [toDate, toDate] pour `toUserId`.
   *
   * Validations : RBAC (toUserId doit être assignee), cap 24h cumulatif
   * pour la case cible (assertNoDailyOverbook).
   */
  async moveAllocationDay(orgId: string, allocId: string, dto: MoveAllocationDayDto) {
    const a = await this.prisma.allocation.findFirst({
      where: { id: allocId, organizationId: orgId },
    });
    if (!a) throw new NotFoundException('Allocation introuvable');

    const fromD = startOfUtcDay(new Date(dto.fromDate));
    const toD = startOfUtcDay(new Date(dto.toDate));
    const toUserId = dto.toUserId ?? a.userId;
    // fromDate doit être dans le range source.
    if (+fromD < +a.startDate || +fromD > +a.endDate) {
      throw new BadRequestException('fromDate hors du range de l\'allocation source.');
    }
    // No-op : on lâche sur la même case.
    if (toUserId === a.userId && +toD === +fromD) {
      return { source: this.toAllocationDto(a as any), created: [], snapshot: null };
    }
    // RBAC : le user cible doit être assignee de la tâche.
    const assignees = await this.prisma.taskAssignee.findMany({
      where: { taskId: a.taskId },
      select: { userId: true },
    });
    if (!assignees.some((x) => x.userId === toUserId)) {
      throw new BadRequestException(
        'User cible non assigné à la tâche — assigne-le d\'abord.',
      );
    }
    // Si target tombe dans la source pour le même user, no-op.
    const singleDay = +a.startDate === +a.endDate;
    if (
      !singleDay &&
      toUserId === a.userId &&
      +toD >= +a.startDate &&
      +toD <= +a.endDate
    ) {
      return { source: this.toAllocationDto(a as any), created: [], snapshot: null };
    }

    // Snapshot pour undo (renvoyé au client).
    const snapshot = {
      sourceId: a.id,
      userId: a.userId,
      taskId: a.taskId,
      startDate: dateIso(a.startDate),
      endDate: dateIso(a.endDate),
      hoursPerDay: a.hoursPerDay,
      notes: a.notes,
    };

    const mode = dto.mode === 'resplit' ? 'resplit' : 'overtime';

    // En mode `resplit`, on ré-étale les heures déplacées (= `a.hoursPerDay`)
    // à partir du jour cible, à la capacité réelle de la personne et SANS
    // overtime (les jours non ouvrés sont sautés). On calcule les segments
    // hors transaction (lectures de capacité), puis on les persiste dans la
    // transaction. La source est exclue du contexte de capacité (elle libère
    // ce jour dans la transaction).
    let fitChunks: { startDate: string; endDate: string; hoursPerDay: number }[] = [];
    if (mode === 'resplit') {
      const horizon = new Date(+toD + MAX_SPLIT_DAYS * MS_PER_DAY);
      const ctx = await this.loadUserCapacityCtx(orgId, toUserId, toD, horizon, [a.id]);
      const fill = this.fillUserDays(ctx, {
        start: toD,
        totalHours: a.hoursPerDay,
        hoursPerDay: 24, // plafonné jour par jour par la capacité réelle
        deadline: null,
        allowOvertime: false,
      });
      fitChunks = fill.chunks;
      if (fitChunks.length === 0) {
        throw new BadRequestException(
          'Impossible de ré-étaler : aucune capacité disponible pour cette personne.',
        );
      }
    } else {
      // Overtime : on vérifie seulement le cap dur 24h sur la case cible.
      await this.assertNoDailyOverbook(
        orgId,
        toUserId,
        toD,
        toD,
        a.hoursPerDay,
        // On EXCLUT la source : la source perd ce jour dans la transaction.
        a.id,
      );
    }

    // Transaction : trim/split source + create target(s) (+ optional tail).
    const dayBefore = new Date(+fromD - MS_PER_DAY);
    const dayAfter = new Date(+fromD + MS_PER_DAY);
    const createdIds: string[] = [];
    let updatedSource: Awaited<ReturnType<typeof this.prisma.allocation.update>> | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Cas simple : mono-jour + overtime = simple ré-affectation de la source.
      if (singleDay && mode === 'overtime') {
        updatedSource = await tx.allocation.update({
          where: { id: a.id },
          data: {
            user: { connect: { id: toUserId } },
            startDate: toD,
            endDate: toD,
          },
        });
        return;
      }

      // 1) Retirer le jour `fromD` de la source.
      if (singleDay) {
        // resplit : tout le jour part dans les chunks → supprime la source.
        await tx.allocation.delete({ where: { id: a.id } });
        updatedSource = null;
      } else if (+fromD === +a.startDate) {
        updatedSource = await tx.allocation.update({
          where: { id: a.id },
          data: { startDate: dayAfter },
        });
      } else if (+fromD === +a.endDate) {
        updatedSource = await tx.allocation.update({
          where: { id: a.id },
          data: { endDate: dayBefore },
        });
      } else {
        updatedSource = await tx.allocation.update({
          where: { id: a.id },
          data: { endDate: dayBefore },
        });
        const tail = await tx.allocation.create({
          data: {
            organizationId: orgId,
            userId: a.userId,
            taskId: a.taskId,
            projectId: a.projectId,
            startDate: dayAfter,
            endDate: a.endDate,
            hoursPerDay: a.hoursPerDay,
            notes: a.notes ?? null,
          },
        });
        createdIds.push(tail.id);
      }

      // 2) Créer la/les cible(s).
      if (mode === 'resplit') {
        for (const ch of fitChunks) {
          const created = await tx.allocation.create({
            data: {
              organizationId: orgId,
              userId: toUserId,
              taskId: a.taskId,
              projectId: a.projectId,
              startDate: startOfUtcDay(new Date(ch.startDate)),
              endDate: startOfUtcDay(new Date(ch.endDate)),
              hoursPerDay: ch.hoursPerDay,
              notes: a.notes ?? null,
            },
          });
          createdIds.push(created.id);
        }
      } else {
        const target = await tx.allocation.create({
          data: {
            organizationId: orgId,
            userId: toUserId,
            taskId: a.taskId,
            projectId: a.projectId,
            startDate: toD,
            endDate: toD,
            hoursPerDay: a.hoursPerDay,
            notes: a.notes ?? null,
          },
        });
        createdIds.push(target.id);
      }
    });

    // Recharge les enregistrements pour renvoyer des DTO complets.
    const [reloadedSource, createdRows] = await Promise.all([
      updatedSource
        ? this.prisma.allocation.findUnique({
            where: { id: (updatedSource as any).id },
            include: {
              user: { select: { id: true, name: true, email: true, countryCode: true } },
              task: { select: { id: true, title: true } },
            },
          })
        : Promise.resolve(null),
      this.prisma.allocation.findMany({
        where: { id: { in: createdIds } },
        include: {
          user: { select: { id: true, name: true, email: true, countryCode: true } },
          task: { select: { id: true, title: true } },
        },
      }),
    ]);

    const effective = await this.computeEffectiveHoursBatch(
      orgId,
      [reloadedSource, ...createdRows].filter(Boolean) as any[],
    );
    return {
      source: reloadedSource ? this.toAllocationDto(reloadedSource as any, effective.get(reloadedSource.id)) : null,
      created: createdRows.map((r) => this.toAllocationDto(r as any, effective.get(r.id))),
      // Pas d'undo "1-clic" pour un re-split : la source mono-jour est
      // supprimée et la réorganisation crée N segments — le snapshot
      // simple (restore source + delete créés) ne suffirait pas.
      snapshot: mode === 'resplit' ? null : snapshot,
    };
  }

  /**
   * Propose une plage [startDate, endDate] qui absorbe `totalHours` à la
   * cadence `hoursPerDay`, en commençant à `startDate` et en sautant les
   * jours non-ouvrés du user (weekend selon son schedule, time-off,
   * fériés selon countryCode). N'écrit RIEN — c'est un dry-run pour
   * pré-remplir le formulaire d'allocation.
   */
  async autoSplit(orgId: string, dto: AutoSplitDto) {
    await this.assertUserInOrg(orgId, dto.userId);
    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        assignees: { select: { userId: true } },
      },
    });
    if (!task) throw new BadRequestException('Task introuvable');
    // Même règle que createAllocation : on ne propose un split que pour un
    // user déjà assigné. Sinon le formulaire se remplit avec une plage que
    // l'utilisateur ne pourra pas sauvegarder ensuite.
    if (!task.assignees.some((a) => a.userId === dto.userId)) {
      throw new BadRequestException(
        'User is not assigned to this task — assign them first.',
      );
    }
    if (dto.hoursPerDay <= 0)
      throw new BadRequestException('hoursPerDay must be > 0');
    if (dto.totalHours <= 0)
      throw new BadRequestException('totalHours must be > 0');

    const start = startOfUtcDay(new Date(dto.startDate));
    const deadline = dto.mustFinishBy
      ? startOfUtcDay(new Date(dto.mustFinishBy))
      : null;
    if (deadline && +deadline < +start) {
      throw new BadRequestException(
        'mustFinishBy must be on or after startDate',
      );
    }
    // Borne dure pour ne pas boucler sur des inputs absurdes (totalHours
    // immense + occupancyPct=0 → infinite loop). 5 ans = largement assez.
    const horizon = new Date(+start + MAX_SPLIT_DAYS * MS_PER_DAY);
    const ctx = await this.loadUserCapacityCtx(
      orgId,
      dto.userId,
      start,
      horizon,
      dto.excludeAllocationIds,
    );

    // Remplissage jour-par-jour (capacité du user, fériés/TO/allocs pris en
    // compte). Extrait dans `fillUserDays` pour être partagé avec le mode
    // multi-personnes (`autoSplitMulti`).
    const fill = this.fillUserDays(ctx, {
      start,
      totalHours: dto.totalHours,
      hoursPerDay: dto.hoursPerDay,
      deadline,
      allowOvertime: dto.allowOvertime,
    });
    const { chunks, absorbed, workdays, blockedDays, endDate, remaining } = fill;

    // (9) Si on n'a pas pu tout absorber AVANT la deadline, propose des
    // alternatives lisibles côté UI : étendre la plage au-delà de la
    // deadline, ou bumper hoursPerDay pour rentrer dans le délai.
    let alternatives: AutoSplitAlternatives | undefined;
    const shortfall = Math.max(remaining, 0);
    if (deadline && shortfall > 0.0001) {
      // a) Plage étendue : on rejoue le même remplissage SANS deadline pour
      // savoir où l'on absorberait tout le total. La capacité par jour est
      // calculée indépendamment de ce qui a déjà été placé (les allocs en
      // cours de création ne sont pas soustraites), donc filler le total
      // depuis `start` sans deadline donne exactement la même date de fin
      // que « continuer après la deadline avec le restant ».
      const extFill = this.fillUserDays(ctx, {
        start,
        totalHours: dto.totalHours,
        hoursPerDay: dto.hoursPerDay,
        deadline: null,
      });
      const extEnd = extFill.workdays > 0 ? extFill.endDate : null;

      // b) Required hoursPerDay : combien faut-il par jour pour rentrer
      // dans la deadline ? On part du nombre de jours ouvrés effectivement
      // disponibles dans la fenêtre [start, deadline].
      let availableWorkdays = 0;
      let cur2 = +start;
      while (cur2 <= +deadline) {
        const d = new Date(cur2);
        const iso = dateIso(d);
        const cap = scheduleHoursFor(ctx.sched, d) * ctx.occ;
        const isOff = ctx.timeOffs.some(
          (o) => +o.startDate <= cur2 && +o.endDate >= cur2,
        );
        if (cap > 0 && !isOff && !ctx.holidaysSet.has(iso)) availableWorkdays++;
        cur2 += MS_PER_DAY;
      }
      const requiredHpd =
        availableWorkdays > 0
          ? Math.ceil((dto.totalHours / availableWorkdays) * 4) / 4
          : null;

      alternatives = {
        extendedEndDate: extEnd ? dateIso(extEnd) : null,
        extraDaysNeeded: extEnd
          ? Math.max(0, Math.round((+extEnd - +deadline) / MS_PER_DAY))
          : null,
        requiredHoursPerDayToHitDeadline:
          requiredHpd != null && requiredHpd > dto.hoursPerDay && requiredHpd <= 24
            ? requiredHpd
            : null,
      };
    }

    return {
      startDate: dateIso(start),
      endDate: dateIso(endDate),
      hoursPerDay: dto.hoursPerDay,
      workdays,
      blockedDays,
      effectiveHours: round(absorbed),
      requestedHours: dto.totalHours,
      shortfallHours: round(shortfall),
      hitDeadline: deadline ? shortfall > 0.0001 : false,
      chunks,
      alternatives,
    };
  }

  /**
   * Variante multi-personnes : répartit `totalHours` entre `userIds` selon
   * `strategy`, en respectant la capacité propre de chaque user. Dry-run —
   * ne persiste rien. L'UI crée ensuite une allocation par chunk et par
   * user. Voir la décision "auto-split multi" dans CLAUDE.md.
   */
  async autoSplitMulti(orgId: string, dto: AutoSplitMultiDto) {
    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, assignees: { select: { userId: true } } },
    });
    if (!task) throw new BadRequestException('Task introuvable');
    const assigneeSet = new Set(task.assignees.map((a) => a.userId));
    const userIds = [...new Set(dto.userIds)];
    if (userIds.length === 0)
      throw new BadRequestException('Aucune personne sélectionnée');
    for (const uid of userIds) {
      if (!assigneeSet.has(uid)) {
        throw new BadRequestException(
          'User is not assigned to this task — assign them first.',
        );
      }
    }
    if (dto.totalHours <= 0)
      throw new BadRequestException('totalHours must be > 0');

    const start = startOfUtcDay(new Date(dto.startDate));
    const deadline = dto.mustFinishBy
      ? startOfUtcDay(new Date(dto.mustFinishBy))
      : null;
    if (deadline && +deadline < +start) {
      throw new BadRequestException('mustFinishBy must be on or after startDate');
    }
    const horizon = new Date(+start + MAX_SPLIT_DAYS * MS_PER_DAY);
    // Fenêtre de pondération : jusqu'à la deadline si elle existe, sinon un
    // trimestre glissant (92 j) — assez pour estimer une capacité relative.
    const windowEnd = deadline ?? new Date(+start + 92 * MS_PER_DAY);
    // Cadence de remplissage par personne : par défaut on remplit à pleine
    // journée (le `fillUserDays` plafonne déjà à la capacité réelle du jour),
    // sinon le plafond explicite demandé par le PM.
    const fillHpd = dto.hoursPerDayCap && dto.hoursPerDayCap > 0 ? dto.hoursPerDayCap : 24;

    const ctxs = await Promise.all(
      userIds.map((uid) =>
        this.loadUserCapacityCtx(orgId, uid, start, horizon, dto.excludeAllocationIds),
      ),
    );

    // Capacité dispo cumulée de chaque user sur la fenêtre (sans overtime) :
    // on rejoue le remplissage avec un total "infini" borné par windowEnd ;
    // `absorbed` = somme des heures libres jour par jour. Sert de poids pour
    // `proportional` et `greedy`, et à estimer les personnes manquantes.
    const capWindow = ctxs.map(
      (ctx) =>
        this.fillUserDays(ctx, {
          start,
          totalHours: 1e9,
          hoursPerDay: fillHpd,
          deadline: windowEnd,
        }).absorbed,
    );
    const capSum = capWindow.reduce((a, b) => a + b, 0);

    // Heures cibles par user selon la stratégie.
    let targets: number[];
    let order = userIds.map((_, i) => i);
    if (dto.strategy === 'equal') {
      targets = userIds.map(() => dto.totalHours / userIds.length);
    } else if (dto.strategy === 'proportional') {
      targets =
        capSum > 0
          ? capWindow.map((c) => (dto.totalHours * c) / capSum)
          : userIds.map(() => dto.totalHours / userIds.length);
    } else {
      // greedy : remplir les plus disponibles d'abord, jusqu'à épuiser le
      // total. Les users non nécessaires gardent une cible nulle.
      order = userIds
        .map((_, i) => i)
        .sort((a, b) => capWindow[b] - capWindow[a]);
      targets = userIds.map(() => 0);
      let rem = dto.totalHours;
      for (const i of order) {
        if (rem <= 0.0001) break;
        const take = capSum > 0 ? Math.min(rem, capWindow[i]) : rem;
        targets[i] = take;
        rem -= take;
      }
      // S'il reste des heures après avoir saturé tout le monde (deadline trop
      // courte), on les empile sur le plus dispo : le shortfall ressortira au
      // remplissage réel et l'UI affichera les personnes manquantes.
      if (rem > 0.0001 && order.length) targets[order[0]] += rem;
    }

    // Arrondit les cibles à l'heure pleine pour des montants lisibles (la
    // division proportionnelle donne sinon 196.6h, 207.6h… puis des reliquats
    // moches au remplissage). Le résidu d'arrondi est réparti par pas de 1h
    // sur les participants par capacité décroissante, pour que la somme des
    // cibles reste = totalHours. On ne touche pas les cibles nulles (greedy).
    {
      const participants = userIds
        .map((_, i) => i)
        .filter((i) => targets[i] > 0.0001)
        .sort((a, b) => capWindow[b] - capWindow[a]);
      if (participants.length) {
        for (const i of participants) targets[i] = Math.round(targets[i]);
        let drift =
          Math.round(dto.totalHours) -
          participants.reduce((s, i) => s + targets[i], 0);
        let gi = 0;
        const guard = participants.length * 100000;
        while (Math.abs(drift) >= 1 && gi < guard) {
          const i = participants[gi % participants.length];
          if (drift > 0) {
            targets[i] += 1;
            drift -= 1;
          } else if (targets[i] > 1) {
            targets[i] -= 1;
            drift += 1;
          }
          gi++;
        }
      }
    }

    const perUser = userIds.map((uid, i) => {
      if (targets[i] <= 0.0001) {
        return {
          userId: uid,
          targetHours: 0,
          effectiveHours: 0,
          workdays: 0,
          blockedDays: 0,
          shortfallHours: 0,
          startDate: dateIso(start),
          endDate: dateIso(start),
          chunks: [] as FillResult['chunks'],
        };
      }
      const r = this.fillUserDays(ctxs[i], {
        start,
        totalHours: targets[i],
        hoursPerDay: fillHpd,
        deadline,
        allowOvertime: dto.allowOvertime,
      });
      return {
        userId: uid,
        targetHours: round(targets[i]),
        effectiveHours: round(r.absorbed),
        workdays: r.workdays,
        blockedDays: r.blockedDays,
        shortfallHours: round(Math.max(r.remaining, 0)),
        startDate: dateIso(start),
        endDate: dateIso(r.endDate),
        chunks: r.chunks,
      };
    });

    const effectiveHours = round(perUser.reduce((s, p) => s + p.effectiveHours, 0));
    const shortfallHours = round(Math.max(dto.totalHours - effectiveHours, 0));
    const endDate = perUser.reduce(
      (mx, p) => (p.endDate > mx ? p.endDate : mx),
      dateIso(start),
    );
    const peopleUsed = perUser.filter((p) => p.effectiveHours > 0.01).length;

    // Personnes manquantes : combien de personnes de capacité moyenne il
    // faudrait en plus pour absorber le shortfall sur la même fenêtre.
    let peopleShort = 0;
    if (shortfallHours > 0.01) {
      const avgCap = capWindow.length ? capSum / capWindow.length : 0;
      peopleShort = avgCap > 0 ? Math.ceil(shortfallHours / avgCap) : 0;
    }

    return {
      strategy: dto.strategy,
      startDate: dateIso(start),
      endDate,
      requestedHours: dto.totalHours,
      effectiveHours,
      shortfallHours,
      hitDeadline: deadline ? shortfallHours > 0.01 : false,
      peopleUsed,
      peopleShort,
      perUser,
    };
  }

  /**
   * Précharge tout ce qu'il faut pour calculer la capacité dispo d'un user
   * jour par jour sur [start, horizon]. Délégué à `CapacityService` (partagé
   * avec le skill gap).
   */
  private loadUserCapacityCtx(
    orgId: string,
    userId: string,
    start: Date,
    horizon: Date,
    excludeAllocationIds?: string[],
  ): Promise<UserCapacityCtx> {
    return this.capacity.loadUserCapacityCtx(orgId, userId, start, horizon, excludeAllocationIds);
  }

  /**
   * Remplissage jour-par-jour de la capacité d'un user. Délégué à
   * `CapacityService` (partagé avec le skill gap).
   */
  private fillUserDays(
    ctx: UserCapacityCtx,
    opts: {
      start: Date;
      totalHours: number;
      hoursPerDay: number;
      deadline: Date | null;
      allowOvertime?: boolean;
    },
  ): FillResult {
    return this.capacity.fillUserDays(ctx, opts);
  }

  async deleteAllocation(orgId: string, id: string) {
    const existing = await this.prisma.allocation.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundException('Allocation introuvable');
    await this.prisma.allocation.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ============================================================
  // Workload grid : capacité vs charge par user × jour
  // ============================================================

  async workloadGrid(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: WorkloadGridQuery,
  ) {
    // Agrégation lourde (capacité × charge par user×jour) → cache Redis 30 s.
    // Clé scopée par **userId** : un non-admin ne voit que le workload de ses
    // équipes (`teamScope`), donc jamais partager la clé entre appelants.
    return this.cache.wrap(
      ['workloadGrid', orgId, requester.userId, requester.isAdmin, JSON.stringify(q)],
      30,
      () => this.computeWorkloadGrid(orgId, requester, q),
    );
  }

  private async computeWorkloadGrid(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: WorkloadGridQuery,
  ) {
    const from = startOfUtcDay(new Date(q.from));
    const to = startOfUtcDay(new Date(q.to));
    if (to.getTime() < from.getTime())
      throw new BadRequestException('to must be on or after from');

    // 1. Users in scope. Humains seulement : la capacité des agents IA n'est
    // pas des heures (concurrence + budgets) — jamais dans la grille workload.
    const usersWhere: Prisma.UserWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      status: 'ACTIVE',
      kind: 'HUMAN',
    };
    if (q.userId) usersWhere.id = q.userId;
    if (q.projectId) {
      usersWhere.projectMembers = { some: { projectId: q.projectId } };
    }

    // Scoping équipe. Un non-admin ne voit QUE le workload des membres de ses
    // propres équipes. Un admin voit tout (filtre `teamId` optionnel).
    let teamScope: string[] | null = null; // null = pas de restriction (admin)
    if (!requester.isAdmin) {
      const myTeams = await this.prisma.teamMember.findMany({
        where: {
          userId: requester.userId,
          team: { organizationId: orgId, deletedAt: null },
        },
        select: { teamId: true },
      });
      teamScope = myTeams.map((t) => t.teamId);
      // Si un teamId est demandé, on l'intersecte avec les équipes de l'user :
      // demander une équipe dont il n'est pas membre ne doit rien renvoyer.
      if (q.teamId) {
        teamScope = teamScope.includes(q.teamId) ? [q.teamId] : [];
      }
    } else if (q.teamId) {
      teamScope = [q.teamId];
    }
    if (teamScope !== null) {
      // Pas d'équipe en scope → aucune ligne (évite un `in: []` qui matche tout
      // ou rien selon le moteur, et court-circuite la requête).
      if (teamScope.length === 0) {
        return { from: dateIso(from), to: dateIso(to), days: this.daysOf(from, to), rows: [] };
      }
      usersWhere.teamMembers = { some: { teamId: { in: teamScope } } };
    }
    const users = await this.prisma.user.findMany({
      where: usersWhere,
      select: { id: true, name: true, email: true, countryCode: true },
      orderBy: { name: 'asc' },
    });
    if (users.length === 0) {
      return { from: dateIso(from), to: dateIso(to), days: this.daysOf(from, to), rows: [] };
    }
    const userIds = users.map((u) => u.id);

    // Jours fériés par utilisateur : on résout son pays (ou le défaut org) puis
    // on charge les fériés couvrant la fenêtre [from,to] via date-holidays.
    const defaultCountry = await this.holidays.getDefaultCountry(orgId);
    const fromIso = dateIso(from);
    const toIso = dateIso(to);
    const holidayByUser = new Map<string, Map<string, string>>();
    const countryCache = new Map<string, Map<string, string>>();
    for (const u of users) {
      const cc = (u.countryCode || defaultCountry).toUpperCase();
      let m = countryCache.get(cc);
      if (!m) {
        m = new Map<string, string>();
        for (const h of this.holidays.forCountryRange(cc, fromIso, toIso)) {
          m.set(h.date, h.name);
        }
        countryCache.set(cc, m);
      }
      holidayByUser.set(u.id, m);
    }

    // 2. Schedules actifs au début de la fenêtre (assez précis pour un MVP ;
    //    on néglige les changements en cours de fenêtre). Les users sans
    //    ligne récupèrent un schedule virtuel basé sur les défauts d'org.
    const schedules = await this.prisma.workSchedule.findMany({
      where: { userId: { in: userIds }, organizationId: orgId, effectiveFrom: { lte: to } },
      orderBy: { effectiveFrom: 'desc' },
    });
    const scheduleByUser = new Map<string, EffectiveSchedule>();
    for (const s of schedules) if (!scheduleByUser.has(s.userId)) scheduleByUser.set(s.userId, { ...s, isDefault: false });
    const defaultSchedule = await this.buildDefaultSchedule(orgId);

    // 3. Time-offs intersectant la fenêtre.
    const timeOffs = await this.prisma.timeOff.findMany({
      where: {
        userId: { in: userIds },
        organizationId: orgId,
        startDate: { lte: to },
        endDate: { gte: from },
      },
    });

    // 4. Allocations intersectant la fenêtre.
    const allocWhere: Prisma.AllocationWhereInput = {
      userId: { in: userIds },
      organizationId: orgId,
      startDate: { lte: to },
      endDate: { gte: from },
    };
    if (q.projectId) allocWhere.projectId = q.projectId;
    // Exclut les allocations pointant vers une tâche ou un projet soft-deleted —
    // sinon la grille Workload continue d'afficher des charges fantômes après
    // archivage d'un projet ou d'une tâche.
    allocWhere.task = { deletedAt: null };
    // `kind: STANDARD` = défense en profondeur : aucune allocation ne devrait
    // exister sur un projet EXTERNAL (bloqué dans createAllocation), mais la
    // grille n'en affichera jamais même si une ligne orpheline apparaissait.
    allocWhere.project = { deletedAt: null, kind: 'STANDARD' };
    const allocs = await this.prisma.allocation.findMany({
      where: allocWhere,
      include: {
        task: { select: { id: true, title: true } },
        project: { select: { id: true, key: true, name: true } },
      },
    });

    // 4bis. Charger les tâches des projets impliqués pour calculer la couleur
    // effective (couleur propre du groupe, sinon couleur du plus proche ancêtre
    // groupe). Léger : on lit (id, parentTaskId, color, isGroup) uniquement.
    const involvedProjectIds = Array.from(
      new Set(allocs.map((a) => a.projectId)),
    );
    const taskColorInfos = involvedProjectIds.length
      ? await this.prisma.task.findMany({
          where: {
            projectId: { in: involvedProjectIds },
            organizationId: orgId,
            deletedAt: null,
          },
          select: {
            id: true,
            parentTaskId: true,
            color: true,
            isGroup: true,
          },
        })
      : [];
    const taskColorById = new Map(taskColorInfos.map((t) => [t.id, t]));

    // 4ter (Lot 4.1) — temps réellement loggé, BORNÉ au passé/aujourd'hui,
    // pour rendre visible dans la grille la journée « brûlée » (loggé au-delà
    // de ce qui était alloué). Display only — n'entre dans aucun calcul
    // d'idempotence (l'auto-plan ne lit pas cette grille). Pas de filtre
    // projectId/kind : inclut les tickets externes.
    const todayStart = startOfUtcDay(new Date());
    const loggedUpperBound = to.getTime() < todayStart.getTime() ? to : todayStart;
    const loggedRows =
      from.getTime() <= loggedUpperBound.getTime()
        ? await this.prisma.timeEntry.groupBy({
            by: ['userId', 'date'],
            where: {
              organizationId: orgId,
              userId: { in: userIds },
              date: { gte: from, lte: loggedUpperBound },
            },
            _sum: { durationMinutes: true },
          })
        : [];
    const loggedByUserDay = new Map<string, Map<string, number>>();
    for (const row of loggedRows) {
      let m = loggedByUserDay.get(row.userId);
      if (!m) {
        m = new Map<string, number>();
        loggedByUserDay.set(row.userId, m);
      }
      m.set(dateIso(row.date), (row._sum.durationMinutes ?? 0) / 60);
    }
    /** Couleur effective : couleur propre si présente, sinon celle du
     * plus proche ancêtre coloré. Retourne `null` si rien à propager.
     * Mémoïsé par `taskId` : `taskColorById` est immuable ici et la grille
     * interroge le même `taskId` sur chaque jour × user → on évite des milliers
     * de remontées d'ancêtres identiques (résultat inchangé). */
    const colorMemo = new Map<string, string | null>();
    const effectiveColor = (taskId: string): string | null => {
      if (colorMemo.has(taskId)) return colorMemo.get(taskId)!;
      let cur = taskColorById.get(taskId);
      const seen = new Set<string>();
      let result: string | null = null;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.color) { result = cur.color; break; }
        if (!cur.parentTaskId) { result = null; break; }
        cur = taskColorById.get(cur.parentTaskId);
      }
      colorMemo.set(taskId, result);
      return result;
    };

    // 5. Build cells.
    const days = this.daysOf(from, to);
    const rows = users.map((u) => {
      const sched = scheduleByUser.get(u.id) ?? defaultSchedule;
      const myTimeOffs = timeOffs.filter((t) => t.userId === u.id);
      const myAllocs = allocs.filter((a) => a.userId === u.id);
      const myHolidays = holidayByUser.get(u.id) ?? new Map<string, string>();
      const myLoggedByDay = loggedByUserDay.get(u.id);
      const cells = days.map((d) => {
        const date = startOfUtcDay(new Date(d.date));
        // Capacité brute selon le schedule (par jour de semaine).
        let cap = scheduleHoursFor(sched, date) * ((sched?.occupancyPct ?? 100) / 100);
        const off = myTimeOffs.find(
          (t) => t.startDate.getTime() <= date.getTime() && t.endDate.getTime() >= date.getTime(),
        );
        if (off) cap = 0;
        const holidayName = myHolidays.get(d.date) ?? null;
        if (holidayName) cap = 0;
        // Lot 4.1 (display only) — un jour <= aujourd'hui où le temps loggé
        // dépasse ce qui était alloué grignote la capacité affichée, pour que
        // la journée « brûlée » (détournement, incident) soit visible dans la
        // grille sans attendre le prochain auto-plan.
        if (cap > 0 && date.getTime() <= todayStart.getTime() && myLoggedByDay) {
          const rawAllocatedForDay = myAllocs
            .filter(
              (a) => a.startDate.getTime() <= date.getTime() && a.endDate.getTime() >= date.getTime(),
            )
            .reduce((s, a) => s + a.hoursPerDay, 0);
          const logged = myLoggedByDay.get(d.date) ?? 0;
          cap = Math.max(0, cap - excessLoggedHours(logged, rawAllocatedForDay));
        }
        // Allocations pour ce jour.
        //   - Jour ouvré (cap>0) : toutes les allocations dont la plage couvre
        //     le jour, plafonnées par la capacité (mi-temps, etc.).
        //   - Jour NON ouvré (cap=0 : weekend, férié, time-off) : on masque le
        //     *débordement* d'une plage multi-jour qui traverse le weekend
        //     (sinon le user verrait "4h un samedi" sans rien planifier),
        //     MAIS on affiche les allocations mono-jour posées explicitement
        //     sur ce jour (overtime assumé via drag-drop). Les masquer les
        //     rendait invisibles ET impossibles à re-déplacer depuis la grille
        //     — le chip "disparaissait" après un drop sur un weekend.
        const dayMatches = (a: (typeof myAllocs)[number]) =>
          a.startDate.getTime() <= date.getTime() &&
          a.endDate.getTime() >= date.getTime();
        const isExplicitSingleDay = (a: (typeof myAllocs)[number]) =>
          a.startDate.getTime() === date.getTime() &&
          a.endDate.getTime() === date.getTime();
        const cellAllocs = myAllocs
          .filter((a) => (cap > 0 ? dayMatches(a) : isExplicitSingleDay(a)))
          .map((a) => ({
            allocationId: a.id,
            taskId: a.taskId,
            taskTitle: a.task.title,
            projectKey: a.project.key,
            projectName: a.project.name,
            color: effectiveColor(a.taskId),
            // Sur un jour ouvré : plafonné par la capacité. Sur un jour non
            // ouvré : pleine charge (overtime), la capacité étant nulle.
            hours: cap > 0 ? Math.min(a.hoursPerDay, cap) : a.hoursPerDay,
            isManual: a.isManual,
            isAutoPlan: a.isAutoPlan,
          }));
        const allocated = cellAllocs.reduce((s, x) => s + x.hours, 0);
        return {
          date: d.date,
          weekday: d.weekday,
          capacityHours: round(cap),
          allocatedHours: round(allocated),
          timeOffType: off?.type ?? null,
          isHoliday: !!holidayName,
          holidayName,
          allocations: cellAllocs,
        };
      });
      return { userId: u.id, name: u.name, email: u.email, cells };
    });

    return { from: dateIso(from), to: dateIso(to), days, rows };
  }

  /**
   * Fraîcheur du dernier auto-plan appliqué sur un projet (Lot 3.3,
   * AUTOPLAN_IMPROVEMENTS.md §3.3). Comparaison synchrone de deux `max()` —
   * pas de job en arrière-plan, pas de nouvelle table. Retourne
   * `PlanStatusDto` (packages/shared).
   */
  async planStatus(orgId: string, projectId: string) {
    const [taskAgg, allocAgg] = await Promise.all([
      this.prisma.task.aggregate({
        where: { organizationId: orgId, projectId, deletedAt: null },
        _max: { updatedAt: true },
      }),
      this.prisma.allocation.aggregate({
        where: { organizationId: orgId, projectId, isAutoPlan: true },
        _max: { createdAt: true },
      }),
    ]);
    const maxTaskUpdatedAt = taskAgg._max.updatedAt ?? null;
    const maxAutoAllocCreatedAt = allocAgg._max.createdAt ?? null;
    return {
      stale: isPlanStale(maxTaskUpdatedAt, maxAutoAllocCreatedAt),
      hasAutoPlan: !!maxAutoAllocCreatedAt,
      maxTaskUpdatedAt: maxTaskUpdatedAt ? maxTaskUpdatedAt.toISOString() : null,
      maxAutoAllocCreatedAt: maxAutoAllocCreatedAt ? maxAutoAllocCreatedAt.toISOString() : null,
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async assertUserInOrg(orgId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!u) throw new BadRequestException('User introuvable');
  }

  private daysOf(from: Date, to: Date): { date: string; weekday: number }[] {
    const out: { date: string; weekday: number }[] = [];
    let cur = new Date(from);
    while (cur.getTime() <= to.getTime()) {
      out.push({ date: dateIso(cur), weekday: weekdayMonFirst(cur) });
      cur = new Date(cur.getTime() + MS_PER_DAY);
    }
    return out;
  }

  private toTimeOffDto(t: {
    id: string;
    userId: string;
    user?: { id: string; name: string; email: string };
    startDate: Date;
    endDate: Date;
    type: TimeOffType;
    notes: string | null;
    source?: string;
    externalId?: string | null;
    createdAt: Date;
  }) {
    return {
      id: t.id,
      userId: t.userId,
      user: t.user,
      startDate: dateIso(t.startDate),
      endDate: dateIso(t.endDate),
      type: t.type,
      notes: t.notes,
      source: t.source ?? 'MANUAL',
      externalId: t.externalId ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  private toAllocationDto(
    a: {
      id: string;
      userId: string;
      taskId: string;
      projectId: string;
      user?: { id: string; name: string; email: string; countryCode?: string | null } | null;
      task?: { id: string; title: string };
      startDate: Date;
      endDate: Date;
      hoursPerDay: number;
      notes: string | null;
      createdAt: Date;
    },
    effective?: { workdays: number; effectiveHours: number; blockedDays: number },
  ) {
    return {
      id: a.id,
      userId: a.userId,
      taskId: a.taskId,
      projectId: a.projectId,
      user: a.user
        ? { id: a.user.id, name: a.user.name, email: a.user.email }
        : undefined,
      taskTitle: a.task?.title,
      startDate: dateIso(a.startDate),
      endDate: dateIso(a.endDate),
      hoursPerDay: a.hoursPerDay,
      notes: a.notes,
      createdAt: a.createdAt.toISOString(),
      workdays: effective?.workdays,
      effectiveHours: effective?.effectiveHours,
      blockedDays: effective?.blockedDays,
    };
  }
}

// ============================================================
// Pure helpers
// ============================================================

type HasDayHours = Pick<
  WorkSchedule,
  'hoursMon' | 'hoursTue' | 'hoursWed' | 'hoursThu' | 'hoursFri' | 'hoursSat' | 'hoursSun'
>;
function scheduleHoursFor(s: HasDayHours | undefined, d: Date): number {
  if (!s) return 0;
  switch (weekdayMonFirst(d)) {
    case 0: return s.hoursMon;
    case 1: return s.hoursTue;
    case 2: return s.hoursWed;
    case 3: return s.hoursThu;
    case 4: return s.hoursFri;
    case 5: return s.hoursSat;
    case 6: return s.hoursSun;
  }
  return 0;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ============================================================
// CSV + date parsing (imports)
// ============================================================

const KNOWN_CSV_HEADERS = new Set([
  'userId',
  'employeeId',
  'email',
  'startDate',
  'endDate',
  'type',
  'notes',
  'externalId',
]);

/** Parse CSV minimal : virgule, guillemets doubles, échappement "" — assez pour les imports SIRH/CSV manuels. */
export function parseCsv(input: string): {
  rows: Record<string, string>[];
  headerErrors: string[];
} {
  const lines = splitCsvLines(input);
  if (lines.length === 0) return { rows: [], headerErrors: ['empty-csv'] };
  const headers = splitCsvRow(lines[0]).map((h) => h.trim());
  const headerErrors: string[] = [];
  for (const h of headers) {
    if (h && !KNOWN_CSV_HEADERS.has(h)) {
      headerErrors.push(`unknown-column:${h}`);
    }
  }
  if (
    !headers.includes('startDate') ||
    !headers.includes('endDate') ||
    (!headers.includes('userId') &&
      !headers.includes('employeeId') &&
      !headers.includes('email'))
  ) {
    headerErrors.push('missing-required-columns');
  }
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cells = splitCsvRow(raw);
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = (cells[c] ?? '').trim();
    rows.push(row);
  }
  return { rows, headerErrors };
}

function splitCsvLines(input: string): string[] {
  // Respecte les CR/LF dans les champs entre guillemets.
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (inQuote && input[i + 1] === '"') {
        buf += '""';
        i++;
      } else {
        inQuote = !inQuote;
        buf += ch;
      }
      continue;
    }
    if (!inQuote && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length) out.push(buf);
  return out;
}

function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        buf += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (!inQuote && ch === ',') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * Accepte ISO `YYYY-MM-DD`, ou `DD/MM/YYYY`/`DD-MM-YYYY` (eu), ou
 * `MM/DD/YYYY`/`MM-DD-YYYY` (us). Renvoie ISO ou null si invalide.
 */
export function parseDateInput(raw: string, format: 'iso' | 'eu' | 'us'): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return validIsoOrNull(+iso[1], +iso[2], +iso[3]);
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (!m) return null;
  const a = +m[1], b = +m[2], y = +m[3];
  if (format === 'iso') return null;
  const day = format === 'eu' ? a : b;
  const month = format === 'eu' ? b : a;
  return validIsoOrNull(y, month, day);
}

function validIsoOrNull(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
}
