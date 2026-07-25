import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Filtres communs aux endpoints de reporting transverses (`/reports/...`).
 * Au moins l'un des deux scopes (`projectId` / `userId`) peut être fourni ;
 * sans rien, on agrège sur toute l'org. Les bornes de date sont inclusives.
 */
export class TimeBreakdownDto {
  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** UUID ou 'me' */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** Découpage de l'export CSV : 'project' (défaut) | 'user' | 'label'. */
  @IsOptional()
  @IsString()
  by?: string;
}

export class BurndownDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}
