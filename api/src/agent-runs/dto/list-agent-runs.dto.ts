import { IsBooleanString, IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Filtres du journal des runs d'agent. Tous cumulatifs et tous optionnels : la
 * vue sans filtre est le cas nominal (« qu'est-ce que l'IA a coûté »).
 */
export class ListAgentRunsDto {
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** Date de début incluse (YYYY-MM-DD). */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Date de fin INCLUSE (la journée entière est comprise, cf. service). */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** `'true'` = ne garder que les runs jugés suspects par le détecteur courant. */
  @IsOptional()
  @IsBooleanString()
  anomaliesOnly?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
