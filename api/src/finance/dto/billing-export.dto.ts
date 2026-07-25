import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Filtres de l'export de facturation (timesheet → facturation portfolio).
 * `from`/`to` sont **obligatoires** (la facturation est toujours périodique) et
 * la fenêtre est plafonnée à 366 jours côté service. `clientId`/`projectId`
 * restreignent le périmètre ; `billableOnly=true` n'exporte que le temps
 * facturable. Contrairement aux reports, cet export **inclut** les tickets
 * externes (projets `kind=EXTERNAL`).
 */
export class BillingExportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** 'true' pour ne garder que les heures facturables (projet `billable`). */
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false', '1', '0'])
  billableOnly?: string;
}
