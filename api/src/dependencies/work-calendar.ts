/**
 * Calendrier ouvré pour le CPM du Gantt.
 *
 * Un `TaskCalendar` répond à "ce jour est-il ouvré pour cette tâche ?" en
 * combinant :
 *   - le `WorkSchedule` des assignés (booléens Mon..Sun) ;
 *   - leurs `TimeOff` (plages inclusives) ;
 *   - les jours fériés publics de leur pays.
 *
 * Règle "task is ouvré ce jour" = au moins un assigné est disponible
 * (mask jour de semaine ET pas en congé ET pas férié dans son pays).
 * Pour une tâche sans assigné, on tombe sur l'org default work days + le
 * pays par défaut de l'org.
 */

const MS_PER_DAY = 86_400_000;

export function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function addCalendarDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export function weekdayMonFirst(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface AssigneeAvailability {
  /** 7 booléens : Mon..Sun. */
  workMask: readonly boolean[];
  /** Plages inclusives [start, end] (jours UTC). */
  timeOffs: readonly { start: Date; end: Date }[];
  /** Set de YYYY-MM-DD = jours fériés publics dans le pays de l'assigné. */
  holidays: ReadonlySet<string>;
}

export class TaskCalendar {
  constructor(
    private readonly assignees: readonly AssigneeAvailability[],
    /** Mask org Mon..Sun, utilisé si pas d'assigné. */
    private readonly orgDefaultMask: readonly boolean[],
    /** Fériés du pays par défaut org, utilisés si pas d'assigné. */
    private readonly orgDefaultHolidays: ReadonlySet<string>,
  ) {}

  isWorkingDay(d: Date): boolean {
    const wd = weekdayMonFirst(d);
    const day = startOfUtcDay(d);
    const t = +day;
    const iso = isoDay(day);
    if (this.assignees.length === 0) {
      if (!this.orgDefaultMask[wd]) return false;
      if (this.orgDefaultHolidays.has(iso)) return false;
      return true;
    }
    for (const a of this.assignees) {
      if (!a.workMask[wd]) continue;
      if (a.holidays.has(iso)) continue;
      let off = false;
      for (const o of a.timeOffs) {
        if (t >= +o.start && t <= +o.end) {
          off = true;
          break;
        }
      }
      if (!off) return true;
    }
    return false;
  }

  /**
   * Avance de `n` jours ouvrés à partir de `from`. `from` lui-même n'est
   * jamais compté (équivalent calendaire de `addDays(from, n)`).
   *   addWorkDays(Fri, 1) = Mon ; addWorkDays(Mon, 0) = Mon (alignement).
   */
  addWorkDays(from: Date, n: number): Date {
    if (n <= 0) return startOfUtcDay(from);
    let cur = startOfUtcDay(from);
    let added = 0;
    // Garde-fou contre une boucle infinie si l'assigné n'a aucun jour ouvré.
    let safety = n * 14 + 7;
    while (added < n && safety-- > 0) {
      cur = addCalendarDays(cur, 1);
      if (this.isWorkingDay(cur)) added++;
    }
    return cur;
  }

  /** Recule de `n` jours ouvrés. */
  subWorkDays(from: Date, n: number): Date {
    if (n <= 0) return startOfUtcDay(from);
    let cur = startOfUtcDay(from);
    let removed = 0;
    let safety = n * 14 + 7;
    while (removed < n && safety-- > 0) {
      cur = addCalendarDays(cur, -1);
      if (this.isWorkingDay(cur)) removed++;
    }
    return cur;
  }

  /** Premier jour ouvré ≥ d (lui-même s'il l'est). */
  nextWorkingDay(d: Date): Date {
    let cur = startOfUtcDay(d);
    let safety = 400;
    while (!this.isWorkingDay(cur) && safety-- > 0) {
      cur = addCalendarDays(cur, 1);
    }
    return cur;
  }

  /**
   * "Rembobine" un earlyFinish vers le premier jour calendaire suivant le
   * dernier jour ouvré effectif. CPM avance ef en sautant les week-ends
   * (Ven+1 work day = Lun), mais la barre Gantt doit s'arrêter à samedi
   * (= jour après le vendredi travaillé), pas étirer visuellement sur le
   * week-end. Tant que (cur-1) est non-ouvré, on recule d'un jour calendaire.
   */
  trimTrailingNonWorking(d: Date): Date {
    let cur = startOfUtcDay(d);
    let safety = 14;
    while (safety-- > 0) {
      const prev = addCalendarDays(cur, -1);
      if (this.isWorkingDay(prev)) return cur;
      cur = prev;
    }
    return cur;
  }

  /** Nombre de jours ouvrés dans la plage [from, to) (to exclusif). */
  workDaysBetween(from: Date, to: Date): number {
    const a = startOfUtcDay(from);
    const b = startOfUtcDay(to);
    if (+a >= +b) return 0;
    let n = 0;
    let cur = a;
    while (+cur < +b) {
      if (this.isWorkingDay(cur)) n++;
      cur = addCalendarDays(cur, 1);
    }
    return n;
  }
}

export function calendarDaysBetween(a: Date, b: Date): number {
  return Math.round((+startOfUtcDay(b) - +startOfUtcDay(a)) / MS_PER_DAY);
}
