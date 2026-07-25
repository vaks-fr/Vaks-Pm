import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TaskPriority, TaskStatus } from '@db';

/** Un critère d'acceptation (chantier 2c.2). `done` = coché par le reviewer. */
export class AcceptanceCriterionDto {
  @IsString()
  @Length(1, 500)
  text!: string;

  @IsOptional()
  @IsBoolean()
  done?: boolean;
}

/**
 * Tous les champs sont optionnels (PATCH). `null` autorisé sur les champs
 * "effaçables" (description, dates, parent, estimation).
 */
export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  /**
   * Sous-statut (Custom Status). Non-null → pose le sous-statut ET force
   * `status` = son statut parent (400 si un `status` incompatible est fourni).
   * `null` → efface (statut inchangé). Absent + changement de statut → le
   * sous-statut courant est effacé si son parent ne correspond plus.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subStatusId?: string | null;

  /**
   * Motif facultatif de mise en pause. Pris en compte au passage en `ON_HOLD`
   * (écrit dans l'historique de statut + `holdReason`) ou, si le statut ne
   * change pas, pour éditer la raison courante d'une tâche déjà en pause.
   * `null`/chaîne vide efface la raison.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 500)
  statusReason?: string | null;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  estimateHours?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  startDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  endDate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progressPct?: number;

  @IsOptional()
  @IsBoolean()
  isMilestone?: boolean;

  @IsOptional()
  @IsBoolean()
  isBug?: boolean;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  color?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentTaskId?: string | null;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  labelIds?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  requiredSkillId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(100)
  requiredSkillLevel?: number | null;

  /**
   * Transition vers `DONE` : si `true`, clôture en cascade les prédécesseurs
   * non terminés. Sinon, refus (409) tant qu'un prédécesseur reste ouvert.
   */
  @IsOptional()
  @IsBoolean()
  completePredecessors?: boolean;

  // ---------- Agents IA (chantier 2c.2 — contexte de travail) ----------
  /** Garde-fous spécifiques à la tâche (ce que l'agent ne doit PAS faire). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 8000)
  agentGuardrails?: string | null;

  /** Critères d'acceptation (checklist) — remplace la liste entière si fourni. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AcceptanceCriterionDto)
  acceptanceCriteria?: AcceptanceCriterionDto[];

  /** Enveloppe totale de coût agent (€) pour cette tâche. `null` = pas de plafond. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  agentCostBudget?: number | null;

  /** Dépendance prestataire externe (note libre). `null`/vide efface. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 500)
  externalDependency?: string | null;

  /** true = tâche bloquée par sa dépendance externe. */
  @IsOptional()
  @IsBoolean()
  externalBlocked?: boolean;
}
