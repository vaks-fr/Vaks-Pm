import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateAllocationDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  taskId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsNumber()
  @Min(0)
  @Max(24)
  hoursPerDay!: number;

  @IsOptional()
  @IsString()
  notes?: string;

  /** Origine : `manual` (défaut, posée à la main → protégée de l'auto-plan)
   *  ou `auto_split` (créée par l'auto-split d'une tâche). */
  @IsOptional()
  @IsIn(['manual', 'auto_split'])
  origin?: 'manual' | 'auto_split';
}

export class UpdateAllocationDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  hoursPerDay?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  notes?: string | null;
}

export class ListAllocationsQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  taskId?: string;
}

export class WorkloadGridQuery {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;
}

/** Badge « plan obsolète » (Lot 3.3, AUTOPLAN_IMPROVEMENTS.md §3.3). */
export class PlanStatusQuery {
  @IsUUID()
  projectId!: string;
}

/** Vue agrégée des agents IA dans le workload (Lot 5, AUTOPLAN_IMPROVEMENTS.md
 *  §5.1) : concurrence + budget + file de revue. `projectId` absent = scope
 *  org borné aux projets accessibles `agentsEnabled` (self-scoping). */
export class AgentWorkloadQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

/**
 * Déplace UN seul jour d'une allocation multi-jours vers une autre case
 * (autre user ou autre date), en effectuant la coupe et le rebuild de
 * façon transactionnelle côté serveur. Si l'allocation est mono-jour,
 * équivaut à un déplacement simple. Renvoie tout ce qu'il faut pour un
 * éventuel undo : l'état "avant" de la source + les IDs créés.
 */
export class MoveAllocationDayDto {
  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsOptional()
  @IsUUID()
  toUserId?: string;

  /**
   * Résolution quand le dépôt tombe sur un jour non ouvré / au-dessus de la
   * capacité :
   *  - `overtime` (défaut) : pose les heures telles quelles sur le jour cible
   *    (heures supplémentaires assumées).
   *  - `resplit` : ré-étale les heures déplacées à partir du jour cible à la
   *    capacité réelle de la personne (sans overtime), en sautant ses jours
   *    non ouvrés. 5h sur un jour à 4h → 4h + 1h le jour ouvré suivant.
   */
  @IsOptional()
  @IsIn(['overtime', 'resplit'])
  mode?: 'overtime' | 'resplit';
}

/**
 * Demande au serveur de proposer une plage (startDate→endDate) qui
 * "absorbe" `totalHours` à la cadence `hoursPerDay` pour `userId`, en
 * sautant week-ends/TO/fériés. Ne persiste rien — c'est juste un dry-run.
 */
export class AutoSplitDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  taskId!: string;

  @IsDateString()
  startDate!: string;

  @IsNumber()
  @Min(0.25)
  totalHours!: number;

  @IsNumber()
  @Min(0.25)
  @Max(24)
  hoursPerDay!: number;

  /** Si fourni, le split s'arrête au plus tard à cette date. Si on n'arrive
   *  pas à absorber `totalHours` avant, on renvoie le restant dans
   *  `shortfallHours` pour que l'UI propose des résolutions. */
  @IsOptional()
  @IsDateString()
  mustFinishBy?: string;

  /** Si `true`, ignore le plafond journalier du schedule du user et utilise
   *  `hoursPerDay` brut (mode overtime — déclenché par l'UI quand l'user
   *  accepte explicitement de saturer la capacité). */
  @IsOptional()
  @IsBoolean()
  allowOvertime?: boolean;

  /** Allocations à exclure du calcul de capacité — utilisé par le mode
   *  "replace" du dialogue auto-split : on va supprimer ces allocs juste
   *  avant de créer les nouvelles, donc le serveur doit faire comme si
   *  elles n'existaient pas pour ne pas reporter un faux shortfall. */
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  excludeAllocationIds?: string[];
}

/**
 * Variante multi-personnes de l'auto-split : répartit `totalHours` entre
 * plusieurs assignees de la tâche selon une `strategy`, en respectant la
 * capacité propre de chacun (schedule × occupancy − fériés − time-offs −
 * allocations existantes). Ne persiste rien — dry-run, l'UI crée ensuite
 * les allocations chunk par chunk. Voir `WorkloadService.autoSplitMulti`.
 */
export class AutoSplitMultiDto {
  @IsUUID()
  taskId!: string;

  /** Assignees participant à la répartition (tous doivent être assignés). */
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  userIds!: string[];

  @IsDateString()
  startDate!: string;

  @IsNumber()
  @Min(0.25)
  totalHours!: number;

  /** Stratégie de répartition :
   *  - `proportional` : part proportionnelle à la capacité dispo de chacun ;
   *  - `equal`        : `totalHours / N` par personne ;
   *  - `greedy`       : remplit les plus disponibles d'abord, minimise le
   *    nombre de personnes réellement mobilisées. */
  @IsIn(['proportional', 'equal', 'greedy'])
  strategy!: 'proportional' | 'equal' | 'greedy';

  /** Plafond de cadence par personne (h/j). Défaut = capacité propre de
   *  chaque user (remplissage à pleine journée). */
  @IsOptional()
  @IsNumber()
  @Min(0.25)
  @Max(24)
  hoursPerDayCap?: number;

  @IsOptional()
  @IsDateString()
  mustFinishBy?: string;

  @IsOptional()
  @IsBoolean()
  allowOvertime?: boolean;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  excludeAllocationIds?: string[];
}
