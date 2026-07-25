import { IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';

/**
 * Saisie/MAJ du taux horaire d'une personne sur un projet. `costRate` (coût
 * interne) obligatoire ; `billRate` (taux facturé client) optionnel — `null`
 * efface explicitement le taux de facturation nominatif. Montants en devise org.
 */
export class SetProjectRateDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  costRate!: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  billRate?: number | null;
}
