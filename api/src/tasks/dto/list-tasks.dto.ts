import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { TaskStatus } from '@db';

/**
 * Filtres pour GET /projects/:projectId/tasks
 *
 * - `status` accepte une valeur unique ou une liste (CSV en query string).
 * - `parentTaskId=null` (chaîne litérale) pour filtrer les tâches racines.
 */
export class ListTasksDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsEnum(TaskStatus, { each: true })
  status?: TaskStatus | TaskStatus[];

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsUUID()
  labelId?: string;

  /** UUID, ou littéral "null" (query string) pour ne renvoyer que les tâches racines.
   *  Transformé : la chaîne "null" devient `null`. */
  @IsOptional()
  @Transform(({ value }) => (value === 'null' ? null : value))
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentTaskId?: string | null;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsDateString()
  dueBefore?: string;

  @IsOptional()
  @IsDateString()
  dueAfter?: string;

  /** true = ne renvoyer que les tâches bloquées par un prestataire externe. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  externalBlocked?: boolean;

  /**
   * Champ:direction. Champs autorisés : position, dueDate, priority, createdAt,
   * updatedAt, title. Direction: asc|desc. Défaut: position:asc.
   */
  @IsOptional()
  @IsString()
  sort?: string;

  /** Nombre max de tâches à renvoyer (cap dur côté serveur à 2000). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}
