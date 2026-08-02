import { BadRequestException, Injectable } from '@nestjs/common';
import { WorkSchedule } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { HolidaysService } from '../holidays/holidays.service';
import { dateIso, excessLoggedHours, startOfUtcDay, weekdayMonFirst } from './scheduling';

const MS_PER_DAY = 86_400_000;

/** Borne dure du remplissage : empêche de boucler sur des inputs absurdes
 *  (totalHours immense + capacité ~0). 5 ans = largement assez. */
const MAX_SPLIT_DAYS = 365 * 5;

/**
 * Représentation interne du schedule effectif d'un utilisateur sur une journée.
 * Soit la ligne `WorkSchedule` (custom), soit un schedule virtuel calculé à partir
 * des défauts d'organisation (`hoursPerDay` × `defaultWorkDays`).
 */
export type EffectiveSchedule = Pick<
  WorkSchedule,
  'hoursMon' | 'hoursTue' | 'hoursWed' | 'hoursThu' | 'hoursFri' | 'hoursSat' | 'hoursSun' | 'occupancyPct'
> & { isDefault: boolean };

/** Contexte de capacité d'un user préchargé sur une fenêtre : tout ce qu'il
 *  faut pour calculer, jour par jour, ses heures dispo. Partagé entre
 *  l'auto-split mono/multi (workload) et le skill gap (skills). */
export interface UserCapacityCtx {
  sched: EffectiveSchedule;
  occ: number;
  timeOffs: { startDate: Date; endDate: Date }[];
  holidaysSet: Set<string>;
  existingAllocs: { taskId: string; startDate: Date; endDate: Date; hoursPerDay: number }[];
  /** Lot 4.1 — temps réellement loggé (TimeEntry), en heures, par jour ISO.
   *  BORNÉ au passé/aujourd'hui (jamais au-delà de `startOfUtcDay(now)`) —
   *  c'est ce bornage qui garantit que l'auto-plan (qui ne place qu'à partir
   *  de J+1) reste idempotent : cette carte y est structurellement toujours
   *  vide. Inclut les projets `kind=EXTERNAL` (tickets externes, pas de
   *  filtre projectId) — c'est par là qu'arrivent les incidents. */
  loggedByDay: Map<string, number>;
}

/** Résultat du remplissage jour-par-jour de la capacité d'un user. */
export interface FillResult {
  chunks: { startDate: string; endDate: string; hoursPerDay: number }[];
  absorbed: number;
  workdays: number;
  blockedDays: number;
  /** Dernier jour ouvré utilisé (ou la deadline si rien n'a pu être placé). */
  endDate: Date;
  /** Heures non absorbées (shortfall) dans la fenêtre/deadline donnée. */
  remaining: number;
}

type HasDayHours = Pick<
  WorkSchedule,
  'hoursMon' | 'hoursTue' | 'hoursWed' | 'hoursThu' | 'hoursFri' | 'hoursSat' | 'hoursSun'
>;

export function scheduleHoursFor(s: HasDayHours | undefined, d: Date): number {
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

/**
 * Capacité réelle d'un utilisateur jour par jour : WorkSchedule effectif
 * (× occupancy%), time-offs, jours fériés du pays, allocations existantes.
 * Extrait de WorkloadService pour être partagé avec SkillsService (skill gap).
 */
@Injectable()
export class CapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly holidays: HolidaysService,
  ) {}

  /** Schedule virtuel construit à partir des défauts d'organisation. */
  async buildDefaultSchedule(orgId: string): Promise<EffectiveSchedule> {
    const [hpd, days] = await Promise.all([
      this.settings.getHoursPerDay(orgId),
      this.settings.getDefaultWorkDays(orgId),
    ]);
    // days = [mon..sun]
    return {
      hoursMon: days[0] ? hpd : 0,
      hoursTue: days[1] ? hpd : 0,
      hoursWed: days[2] ? hpd : 0,
      hoursThu: days[3] ? hpd : 0,
      hoursFri: days[4] ? hpd : 0,
      hoursSat: days[5] ? hpd : 0,
      hoursSun: days[6] ? hpd : 0,
      occupancyPct: 100,
      isDefault: true,
    };
  }

  async loadUserCapacityCtx(
    orgId: string,
    userId: string,
    start: Date,
    horizon: Date,
    excludeAllocationIds?: string[],
  ): Promise<UserCapacityCtx> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: { countryCode: true },
    });
    // Lot 4.1 — fenêtre du temps loggé : BORNÉE au passé/aujourd'hui, jamais
    // au-delà. Si `start` est déjà dans le futur (le cas normal de l'auto-plan,
    // qui ne charge le contexte qu'à partir de `cutoff` = J+1), `loggedUpperBound
    // < start` rend la plage `[start, loggedUpperBound]` naturellement vide —
    // Prisma renvoie [] sans qu'on ait besoin de sauter la requête en code.
    const todayStart = startOfUtcDay(new Date());
    const loggedUpperBound = +horizon < +todayStart ? horizon : todayStart;
    const loggedQuery = this.prisma.timeEntry.groupBy({
      by: ['date'],
      // Pas de filtre projectId/kind : les tickets externes (projets
      // EXTERNAL) sont inclus à dessein — c'est par là qu'arrivent les
      // incidents qui détournent la capacité prévue.
      where: { organizationId: orgId, userId, date: { gte: start, lte: loggedUpperBound } },
      _sum: { durationMinutes: true },
    });
    const [scheduleRow, timeOffs, defaultCountry, defaultSchedule, existingAllocs, loggedRows] =
      await Promise.all([
        this.prisma.workSchedule.findFirst({
          where: { userId, organizationId: orgId, effectiveFrom: { lte: horizon } },
          orderBy: { effectiveFrom: 'desc' },
        }),
        this.prisma.timeOff.findMany({
          where: { userId, organizationId: orgId, endDate: { gte: start } },
          select: { startDate: true, endDate: true },
        }),
        this.holidays.getDefaultCountry(orgId),
        this.buildDefaultSchedule(orgId),
        this.prisma.allocation.findMany({
          where: {
            userId,
            organizationId: orgId,
            endDate: { gte: start },
            ...(excludeAllocationIds && excludeAllocationIds.length
              ? { id: { notIn: excludeAllocationIds } }
              : {}),
          },
          select: { taskId: true, startDate: true, endDate: true, hoursPerDay: true },
        }),
        loggedQuery,
      ]);
    const sched: EffectiveSchedule = scheduleRow
      ? { ...scheduleRow, isDefault: false }
      : defaultSchedule;
    const occ = (sched.occupancyPct ?? 100) / 100;
    const cc = ((user?.countryCode ?? null) || defaultCountry).toUpperCase();
    const holidaysSet = new Set(
      this.holidays
        .forCountryRange(cc, dateIso(start), dateIso(horizon))
        .map((h) => h.date),
    );
    const loggedByDay = new Map<string, number>();
    for (const row of loggedRows) {
      loggedByDay.set(dateIso(row.date), (row._sum.durationMinutes ?? 0) / 60);
    }
    return { sched, occ, timeOffs, holidaysSet, existingAllocs, loggedByDay };
  }

  /**
   * Avance jour par jour depuis `start` et consomme `totalHours` sur les
   * jours ouvrés effectifs (capacité > 0, pas de TO, pas de férié, capacité
   * restante après allocations existantes). Si `deadline` est posée, on
   * s'arrête à cette date et le restant ressort dans `remaining`.
   *
   * Construit des "chunks" (segments contigus de même cadence) pour que le
   * workload grid reste exact : 41h à 4h/j → 10j×4h + 1j×1h, pas 11j×4h.
   */
  fillUserDays(
    ctx: UserCapacityCtx,
    opts: {
      start: Date;
      totalHours: number;
      hoursPerDay: number;
      deadline: Date | null;
      allowOvertime?: boolean;
    },
  ): FillResult {
    const { sched, occ, timeOffs, holidaysSet, existingAllocs, loggedByDay } = ctx;
    const { start, totalHours, hoursPerDay, deadline, allowOvertime } = opts;
    const filled: { iso: string; hours: number }[] = [];
    let remaining = totalHours;
    let workdays = 0;
    let blockedDays = 0;
    let lastWorkDate = start;
    let absorbed = 0;
    let cursor = +start;
    const startMs = +start;
    while (remaining > 0.0001) {
      if (deadline && cursor > +deadline) break;
      const elapsed = Math.round((cursor - startMs) / MS_PER_DAY);
      if (elapsed >= MAX_SPLIT_DAYS) {
        throw new BadRequestException(
          'totalHours trop élevé : la plage proposée dépasse 5 ans.',
        );
      }
      const d = new Date(cursor);
      const iso = dateIso(d);
      const cap = scheduleHoursFor(sched, d) * occ;
      const isOff = timeOffs.some(
        (o) => +o.startDate <= cursor && +o.endDate >= cursor,
      );
      if (cap <= 0 || isOff || holidaysSet.has(iso)) {
        blockedDays++;
      } else {
        let alreadyUsed = 0;
        for (const a of existingAllocs) {
          if (+a.startDate <= cursor && +a.endDate >= cursor) {
            alreadyUsed += a.hoursPerDay;
          }
        }
        // Lot 4.1 — l'EXCÉDENT de temps loggé ce jour (au-delà de ce qui était
        // alloué) grignote la capacité restante, comme une allocation de plus.
        // `loggedByDay` est structurellement vide pour tout jour >= cutoff (le
        // seul territoire où l'auto-plan place) — le plafond overtime, lui, ne
        // bouge pas : l'excédent loggé n'agrandit jamais la marge 24h.
        const logged = loggedByDay.get(iso) ?? 0;
        const excess = excessLoggedHours(logged, alreadyUsed);
        const freeFromSchedule = Math.max(0, cap - alreadyUsed - excess);
        const ceil = allowOvertime
          ? Math.max(0, 24 - alreadyUsed)
          : freeFromSchedule;
        const dailyCap = Math.min(hoursPerDay, ceil);
        if (dailyCap <= 0.0001) {
          blockedDays++;
        } else {
          const want = Math.min(remaining, dailyCap);
          if (want <= 0.0001) {
            // Reliquat négligeable : tout est placé. On s'arrête (évite une
            // journée résiduelle à 0h et une boucle jusqu'à MAX_SPLIT_DAYS).
            break;
          }
          // Quantifie au quart d'heure pour éviter le bruit flottant dans les
          // allocations stockées (ex. 4.271973466003317h/j issu d'un reliquat
          // de répartition). Arrondi au plus proche, puis si ça dépasse la
          // capacité réelle du jour on arrondit à l'inférieur — résultat
          // toujours multiple de 0.25 et jamais > capacité. Un jour dont la
          // capacité libre est < 0.25 h est jugé inexploitable (skip), pas un
          // motif d'arrêt.
          let taken = Math.round(want * 4) / 4;
          if (taken > dailyCap) taken = Math.floor(dailyCap * 4) / 4;
          if (taken <= 0.0001) {
            blockedDays++;
          } else {
            absorbed += taken;
            remaining -= taken;
            workdays++;
            lastWorkDate = d;
            filled.push({ iso, hours: taken });
          }
        }
      }
      cursor += MS_PER_DAY;
    }

    const endDate = workdays === 0 && deadline ? deadline : lastWorkDate;

    const chunks: FillResult['chunks'] = [];
    for (const f of filled) {
      const last = chunks[chunks.length - 1];
      if (last && Math.abs(last.hoursPerDay - f.hours) < 0.001) {
        last.endDate = f.iso;
      } else {
        chunks.push({ startDate: f.iso, endDate: f.iso, hoursPerDay: f.hours });
      }
    }

    return { chunks, absorbed, workdays, blockedDays, endDate, remaining };
  }

  /**
   * Heures réellement libres d'un user sur `[start, end]` (inclus) :
   * Σ jour par jour de `capacité effective − allocations existantes`, en
   * sautant week-ends/fériés/time-offs. `excludeTaskId` retire du calcul les
   * allocations de cette tâche (= le travail qu'on cherche à couvrir, pas une
   * charge concurrente). Même astuce que `autoSplitMulti` : remplissage avec
   * un total « infini » borné par la deadline, `absorbed` = heures libres.
   */
  freeHoursInWindow(
    ctx: UserCapacityCtx,
    start: Date,
    end: Date,
    excludeTaskId?: string,
  ): number {
    const effCtx: UserCapacityCtx = excludeTaskId
      ? { ...ctx, existingAllocs: ctx.existingAllocs.filter((a) => a.taskId !== excludeTaskId) }
      : ctx;
    return this.fillUserDays(effCtx, {
      start,
      totalHours: 1e9,
      hoursPerDay: 24, // plafonné jour par jour par la capacité réelle
      deadline: end,
    }).absorbed;
  }

  /**
   * Analyse capacité/conflits d'un ensemble d'utilisateurs sur `[from, to]`.
   * Partagé par le KPI d'équipe et le KPI portefeuille.
   *
   *  - **conflictDays** = jours de **sur-allocation multi-projets** : un user
   *    alloué au-delà de sa capacité du jour ET sur ≥2 projets distincts
   *    (proxy de « ressource double-bookée », pas un retard prouvé).
   *  - **headroom** = Σ capacité dispo − Σ heures déjà allouées sur la fenêtre.
   *
   * Borne dure : la fenêtre est plafonnée à ~370 jours pour éviter de boucler.
   */
  async analyzeUsersCapacity(
    orgId: string,
    userIds: string[],
    from: Date,
    to: Date,
  ): Promise<{
    conflictDays: number;
    peopleAffected: number;
    worst: Array<{ userId: string; name: string; date: string; allocatedHours: number; capacityHours: number; projectCount: number }>;
    availableHours: number;
    allocatedHours: number;
    headroomHours: number;
    perUser: Array<{ userId: string; name: string; availableHours: number; allocatedHours: number; headroomHours: number }>;
  }> {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const fromMs = +from;
    const toMs = +to;
    const empty = {
      conflictDays: 0, peopleAffected: 0, worst: [] as never[],
      availableHours: 0, allocatedHours: 0, headroomHours: 0, perUser: [] as never[],
    };
    if (!userIds.length || toMs < fromMs) return empty;
    if ((toMs - fromMs) / MS_PER_DAY > 370) {
      throw new BadRequestException('Fenêtre KPI trop large (max ~1 an).');
    }

    const names = new Map(
      (await this.prisma.user.findMany({
        where: { id: { in: userIds }, organizationId: orgId },
        select: { id: true, name: true },
      })).map((u) => [u.id, u.name]),
    );

    let conflictDays = 0;
    const affected = new Set<string>();
    const worst: Array<{ userId: string; name: string; date: string; allocatedHours: number; capacityHours: number; projectCount: number; over: number }> = [];
    let availableHours = 0;
    let allocatedHours = 0;
    const perUser: Array<{ userId: string; name: string; availableHours: number; allocatedHours: number; headroomHours: number }> = [];

    for (const userId of userIds) {
      const ctx = await this.loadUserCapacityCtx(orgId, userId, from, to);
      // Allocations avec projectId (le ctx n'expose que taskId) pour compter
      // les projets distincts d'un même jour.
      const allocs = await this.prisma.allocation.findMany({
        where: { userId, organizationId: orgId, startDate: { lte: to }, endDate: { gte: from } },
        select: { projectId: true, startDate: true, endDate: true, hoursPerDay: true },
      });
      let uAvail = 0;
      let uAlloc = 0;
      for (let cur = fromMs; cur <= toMs; cur += MS_PER_DAY) {
        const d = new Date(cur);
        const iso = dateIso(d);
        const isOff = ctx.timeOffs.some((o) => +o.startDate <= cur && +o.endDate >= cur);
        const blocked = isOff || ctx.holidaysSet.has(iso);
        const cap = blocked ? 0 : scheduleHoursFor(ctx.sched, d) * ctx.occ;
        let allocated = 0;
        const projs = new Set<string>();
        for (const a of allocs) {
          if (+a.startDate <= cur && +a.endDate >= cur) {
            allocated += a.hoursPerDay;
            projs.add(a.projectId);
          }
        }
        uAvail += cap;
        uAlloc += allocated;
        const over = allocated - cap;
        if (over > 0.001 && projs.size >= 2) {
          conflictDays++;
          affected.add(userId);
          worst.push({ userId, name: names.get(userId) ?? '—', date: iso, allocatedHours: r1(allocated), capacityHours: r1(cap), projectCount: projs.size, over });
        }
      }
      availableHours += uAvail;
      allocatedHours += uAlloc;
      perUser.push({ userId, name: names.get(userId) ?? '—', availableHours: r1(uAvail), allocatedHours: r1(uAlloc), headroomHours: r1(uAvail - uAlloc) });
    }

    worst.sort((a, b) => b.over - a.over);
    return {
      conflictDays,
      peopleAffected: affected.size,
      worst: worst.slice(0, 10).map(({ over: _over, ...w }) => w),
      availableHours: r1(availableHours),
      allocatedHours: r1(allocatedHours),
      headroomHours: r1(availableHours - allocatedHours),
      perUser,
    };
  }
}
