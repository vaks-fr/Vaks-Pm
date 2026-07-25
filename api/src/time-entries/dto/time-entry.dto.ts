import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateTimeEntryDto {
  @IsUUID()
  taskId!: string;

  /** Date du jour ouvré (YYYY-MM-DD ou ISO). */
  @IsDateString()
  date!: string;

  /** Durée en minutes (1 min – 24 h). */
  @IsInt()
  @Min(1)
  @Max(60 * 24)
  durationMinutes!: number;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  /** Sous-portion d'overtime, en minutes (≤ durationMinutes). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60 * 24)
  overtimeMinutes?: number;
}

export class UpdateTimeEntryDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60 * 24)
  durationMinutes?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 1000)
  description?: string | null;

  /** Sous-portion d'overtime, en minutes (≤ durationMinutes). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60 * 24)
  overtimeMinutes?: number;
}

/**
 * Filtres pour le listing. Quand `projectId` est fourni, on filtre via la
 * jointure task.projectId. `userId` accepte 'me' pour le user courant.
 */
export class ListTimeEntriesDto {
  @IsOptional()
  @IsUUID()
  taskId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  userId?: string; // 'me' ou UUID

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  limit?: number;
}

/**
 * Bornes d'une semaine pour la vue timesheet (lundi → dimanche).
 */
export class TimesheetQueryDto {
  @IsDateString()
  weekStart!: string;

  @IsOptional()
  @IsString()
  userId?: string; // 'me' (défaut) ou UUID
}
