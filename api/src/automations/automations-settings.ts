import { BadRequestException } from '@nestjs/common';

/**
 * Schéma typé des settings du module automatisations built-in, stockés dans
 * `OrgSetting` sous les clés `automations.*` (même pattern que `notif.*` —
 * voir `notifications-settings.ts`). Lecture/écriture via
 * `AdminSettingsService.getAll/upsertMany` ; ce fichier centralise les clés,
 * les défauts, les bornes et la validation à l'écriture.
 *
 * Philosophie (BUILTIN_AUTOMATIONS.md) : règles livrées de base, l'admin ne
 * fait qu'activer/désactiver et régler des seuils. Notifications pures =
 * défaut ON ; mutations d'état = défaut OFF (opt-in explicite).
 */

export type ParentAutoAdvanceMode = 'off' | 'notify' | 'advance';

export interface AutomationsSettings {
  /** Kill switch global du moteur (n'affecte pas les webhooks métier). */
  enabled: boolean;
  /** Heure UTC (0-23) d'exécution des règles quotidiennes. */
  dailyHour: number;
  /** Matérialisation des tâches récurrentes (lot 5). */
  recurrenceEnabled: boolean;

  // Hygiène des tâches
  onHoldDormant: { enabled: boolean; days: number };
  overdue: { enabled: boolean; graceDays: number; bumpPriority: boolean };
  inProgressInactive: { enabled: boolean; days: number };
  parentAutoAdvance: ParentAutoAdvanceMode;
  unassignedStale: { enabled: boolean; days: number };
  /** Tâche bloquée par un prestataire externe depuis plus de N jours. */
  externalBlockedStale: { enabled: boolean; days: number };

  // Échéances & planning
  milestoneAtRisk: { enabled: boolean; days: number };
  autoplanOverflow: { enabled: boolean };

  // Workload & capacité
  overload: { enabled: boolean; thresholdPct: number };
  underload: { enabled: boolean; thresholdPct: number; weeks: number };
  timeOffConflict: { enabled: boolean };
  /**
   * Lot 4.3 — tâche ALLOUÉE dont la fenêtre (fin de la dernière allocation) est
   * passée depuis `graceDays` jours et qui n'a JAMAIS quitté TODO. Signal
   * fondé sur le statut, jamais le pointage (cf. `isAllocationWindowMissed`).
   */
  allocationWindowMissed: { enabled: boolean; graceDays: number };

  // Timesheet
  timesheetReminder: { enabled: boolean; thresholdPct: number; weekday: number; hour: number };
  overtime: { enabled: boolean; hoursPerWeek: number };

  /**
   * Taux d'occupation facturable par PERSONNE : heures loggées sur des projets
   * `billable` / heures totales loggées. NB : la facturabilité est un booléen
   * de projet (`Project.billable`), jamais une propriété de l'heure — un
   * « ratio billable » par projet vaudrait toujours 100 % ou 0 %. La seule
   * maille qui porte du sens est donc l'utilisateur.
   */
  utilization: { enabled: boolean; thresholdPct: number };

  // Finance
  budgetThreshold: { enabled: boolean; tiers: number[] };
  forecastOverrun: { enabled: boolean };

  // Skills
  skillGapOnCreate: { enabled: boolean; autoRequest: boolean };

  // Agents IA
  /**
   * NB : pas de règle « re-travail agent ». Le **poison task**
   * (`TasksService.maybeEscalatePoisonTask`, seuil
   * `agents.verification.poisonRetryThreshold`) traite déjà le sujet, et plus
   * fort : au seuil il retire l'agent de la tâche (elle sort du circuit agent)
   * et notifie PM + owner. Un second seuil ici n'aurait fait que semer la
   * confusion entre deux sections admin.
   */
  agentBudget: { enabled: boolean; thresholdPct: number };
  deliverableStale: { enabled: boolean; hours: number };

  // Projets
  projectInactive: { enabled: boolean; days: number };
  projectEndSoon: { enabled: boolean; days: number };
}

export const DEFAULT_AUTOMATIONS_SETTINGS: AutomationsSettings = {
  enabled: true,
  dailyHour: 7,
  recurrenceEnabled: true,
  onHoldDormant: { enabled: true, days: 5 },
  overdue: { enabled: true, graceDays: 0, bumpPriority: false },
  inProgressInactive: { enabled: true, days: 7 },
  parentAutoAdvance: 'notify',
  unassignedStale: { enabled: true, days: 3 },
  externalBlockedStale: { enabled: true, days: 5 },
  milestoneAtRisk: { enabled: true, days: 7 },
  autoplanOverflow: { enabled: false },
  overload: { enabled: true, thresholdPct: 100 },
  underload: { enabled: false, thresholdPct: 50, weeks: 2 },
  timeOffConflict: { enabled: true },
  allocationWindowMissed: { enabled: true, graceDays: 1 },
  timesheetReminder: { enabled: true, thresholdPct: 80, weekday: 5, hour: 16 },
  overtime: { enabled: false, hoursPerWeek: 5 },
  utilization: { enabled: false, thresholdPct: 60 },
  budgetThreshold: { enabled: true, tiers: [80, 100] },
  forecastOverrun: { enabled: true },
  skillGapOnCreate: { enabled: true, autoRequest: false },
  agentBudget: { enabled: true, thresholdPct: 80 },
  deliverableStale: { enabled: true, hours: 24 },
  projectInactive: { enabled: false, days: 14 },
  projectEndSoon: { enabled: true, days: 7 },
};

const PARENT_MODES: ParentAutoAdvanceMode[] = ['off', 'notify', 'advance'];

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return def;
}
function asInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Parse "80,100" → [80, 100] (croissant, dédupliqué, borné 1-200, max 5). */
export function parseTiers(v: unknown, def: number[]): number[] {
  if (v == null || v === '') return def;
  const parts = String(v)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 200);
  const uniq = [...new Set(parts)].sort((a, b) => a - b).slice(0, 5);
  return uniq.length ? uniq : def;
}

/**
 * Lit les settings automatisations depuis un dump `{key: value}` (sortie de
 * `AdminSettingsService.getAll`). Applique les défauts pour les clés absentes.
 */
export function readAutomationsSettings(raw: Record<string, unknown>): AutomationsSettings {
  const D = DEFAULT_AUTOMATIONS_SETTINGS;
  return {
    enabled: asBool(raw['automations.enabled'], D.enabled),
    dailyHour: asInt(raw['automations.dailyHour'], D.dailyHour, 0, 23),
    recurrenceEnabled: asBool(raw['automations.recurrence.enabled'], D.recurrenceEnabled),
    onHoldDormant: {
      enabled: asBool(raw['automations.onHoldDormant.enabled'], D.onHoldDormant.enabled),
      days: asInt(raw['automations.onHoldDormant.days'], D.onHoldDormant.days, 1, 90),
    },
    overdue: {
      enabled: asBool(raw['automations.overdue.enabled'], D.overdue.enabled),
      graceDays: asInt(raw['automations.overdue.graceDays'], D.overdue.graceDays, 0, 30),
      bumpPriority: asBool(raw['automations.overdue.bumpPriority'], D.overdue.bumpPriority),
    },
    inProgressInactive: {
      enabled: asBool(raw['automations.inProgressInactive.enabled'], D.inProgressInactive.enabled),
      days: asInt(raw['automations.inProgressInactive.days'], D.inProgressInactive.days, 1, 90),
    },
    parentAutoAdvance: PARENT_MODES.includes(raw['automations.parentAutoAdvance.mode'] as ParentAutoAdvanceMode)
      ? (raw['automations.parentAutoAdvance.mode'] as ParentAutoAdvanceMode)
      : D.parentAutoAdvance,
    unassignedStale: {
      enabled: asBool(raw['automations.unassignedStale.enabled'], D.unassignedStale.enabled),
      days: asInt(raw['automations.unassignedStale.days'], D.unassignedStale.days, 1, 60),
    },
    externalBlockedStale: {
      enabled: asBool(raw['automations.externalBlockedStale.enabled'], D.externalBlockedStale.enabled),
      days: asInt(raw['automations.externalBlockedStale.days'], D.externalBlockedStale.days, 1, 90),
    },
    milestoneAtRisk: {
      enabled: asBool(raw['automations.milestoneAtRisk.enabled'], D.milestoneAtRisk.enabled),
      days: asInt(raw['automations.milestoneAtRisk.days'], D.milestoneAtRisk.days, 1, 60),
    },
    autoplanOverflow: {
      enabled: asBool(raw['automations.autoplanOverflow.enabled'], D.autoplanOverflow.enabled),
    },
    overload: {
      enabled: asBool(raw['automations.overload.enabled'], D.overload.enabled),
      thresholdPct: asInt(raw['automations.overload.thresholdPct'], D.overload.thresholdPct, 50, 300),
    },
    underload: {
      enabled: asBool(raw['automations.underload.enabled'], D.underload.enabled),
      thresholdPct: asInt(raw['automations.underload.thresholdPct'], D.underload.thresholdPct, 0, 100),
      weeks: asInt(raw['automations.underload.weeks'], D.underload.weeks, 1, 12),
    },
    timeOffConflict: {
      enabled: asBool(raw['automations.timeOffConflict.enabled'], D.timeOffConflict.enabled),
    },
    allocationWindowMissed: {
      enabled: asBool(
        raw['automations.allocationWindowMissed.enabled'],
        D.allocationWindowMissed.enabled,
      ),
      graceDays: asInt(
        raw['automations.allocationWindowMissed.graceDays'],
        D.allocationWindowMissed.graceDays,
        0,
        30,
      ),
    },
    timesheetReminder: {
      enabled: asBool(raw['automations.timesheetReminder.enabled'], D.timesheetReminder.enabled),
      thresholdPct: asInt(raw['automations.timesheetReminder.thresholdPct'], D.timesheetReminder.thresholdPct, 0, 100),
      weekday: asInt(raw['automations.timesheetReminder.weekday'], D.timesheetReminder.weekday, 1, 7),
      hour: asInt(raw['automations.timesheetReminder.hour'], D.timesheetReminder.hour, 0, 23),
    },
    overtime: {
      enabled: asBool(raw['automations.overtime.enabled'], D.overtime.enabled),
      hoursPerWeek: asInt(raw['automations.overtime.hoursPerWeek'], D.overtime.hoursPerWeek, 1, 40),
    },
    utilization: {
      enabled: asBool(raw['automations.utilization.enabled'], D.utilization.enabled),
      thresholdPct: asInt(raw['automations.utilization.thresholdPct'], D.utilization.thresholdPct, 0, 100),
    },
    budgetThreshold: {
      enabled: asBool(raw['automations.budgetThreshold.enabled'], D.budgetThreshold.enabled),
      tiers: parseTiers(raw['automations.budgetThreshold.tiers'], D.budgetThreshold.tiers),
    },
    forecastOverrun: {
      enabled: asBool(raw['automations.forecastOverrun.enabled'], D.forecastOverrun.enabled),
    },
    skillGapOnCreate: {
      enabled: asBool(raw['automations.skillGapOnCreate.enabled'], D.skillGapOnCreate.enabled),
      autoRequest: asBool(raw['automations.skillGapOnCreate.autoRequest'], D.skillGapOnCreate.autoRequest),
    },
    agentBudget: {
      enabled: asBool(raw['automations.agentBudget.enabled'], D.agentBudget.enabled),
      thresholdPct: asInt(raw['automations.agentBudget.thresholdPct'], D.agentBudget.thresholdPct, 10, 100),
    },
    deliverableStale: {
      enabled: asBool(raw['automations.deliverableStale.enabled'], D.deliverableStale.enabled),
      hours: asInt(raw['automations.deliverableStale.hours'], D.deliverableStale.hours, 1, 336),
    },
    projectInactive: {
      enabled: asBool(raw['automations.projectInactive.enabled'], D.projectInactive.enabled),
      days: asInt(raw['automations.projectInactive.days'], D.projectInactive.days, 1, 180),
    },
    projectEndSoon: {
      enabled: asBool(raw['automations.projectEndSoon.enabled'], D.projectEndSoon.enabled),
      days: asInt(raw['automations.projectEndSoon.days'], D.projectEndSoon.days, 1, 60),
    },
  };
}

/** Bornes des clés numériques `automations.*` (validation à l'écriture). */
const INT_BOUNDS: Record<string, [number, number]> = {
  'automations.dailyHour': [0, 23],
  'automations.onHoldDormant.days': [1, 90],
  'automations.overdue.graceDays': [0, 30],
  'automations.inProgressInactive.days': [1, 90],
  'automations.unassignedStale.days': [1, 60],
  'automations.externalBlockedStale.days': [1, 90],
  'automations.milestoneAtRisk.days': [1, 60],
  'automations.overload.thresholdPct': [50, 300],
  'automations.underload.thresholdPct': [0, 100],
  'automations.underload.weeks': [1, 12],
  'automations.timesheetReminder.thresholdPct': [0, 100],
  'automations.timesheetReminder.weekday': [1, 7],
  'automations.timesheetReminder.hour': [0, 23],
  'automations.overtime.hoursPerWeek': [1, 40],
  'automations.utilization.thresholdPct': [0, 100],
  'automations.agentBudget.thresholdPct': [10, 100],
  'automations.deliverableStale.hours': [1, 336],
  'automations.projectInactive.days': [1, 180],
  'automations.projectEndSoon.days': [1, 60],
  'automations.allocationWindowMissed.graceDays': [0, 30],
};

/**
 * Validation forte des réglages `automations.*` AVANT persistance — même
 * philosophie que `validateAuditSettings` (rejet clair, jamais de valeur
 * silencieusement tronquée à l'écriture ; la troncature du reader ne sert
 * que de filet pour les données historiques).
 */
export function validateAutomationSettings(values: Record<string, unknown>): void {
  for (const [key, [min, max]] of Object.entries(INT_BOUNDS)) {
    if (key in values && values[key] != null && values[key] !== '') {
      const n = Number(values[key]);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new BadRequestException(`${key} invalide : ${String(values[key])} (entier ${min}-${max} attendu)`);
      }
    }
  }
  if ('automations.parentAutoAdvance.mode' in values) {
    const v = values['automations.parentAutoAdvance.mode'];
    if (v != null && v !== '' && !PARENT_MODES.includes(String(v) as ParentAutoAdvanceMode)) {
      throw new BadRequestException(`automations.parentAutoAdvance.mode invalide : ${String(v)} (off|notify|advance)`);
    }
  }
  if ('automations.budgetThreshold.tiers' in values) {
    const v = values['automations.budgetThreshold.tiers'];
    if (v != null && v !== '') {
      const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((s) => {
        const n = Number(s);
        return !Number.isInteger(n) || n < 1 || n > 200;
      });
      if (!parts.length || bad.length) {
        throw new BadRequestException(
          `automations.budgetThreshold.tiers invalide : ${String(v)} (liste d'entiers 1-200, ex. "80,100")`,
        );
      }
      if (parts.length > 5) {
        throw new BadRequestException('automations.budgetThreshold.tiers : 5 paliers maximum');
      }
    }
  }
}
