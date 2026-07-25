import { IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';

/**
 * MAJ de l'enveloppe budgétaire et des taux horaires PAR DÉFAUT du projet
 * (fallback quand un membre n'a pas de `ProjectRate` explicite). Tous les champs
 * sont optionnels ; `null` efface la valeur. Gardé par `finance:manage`.
 */
export class UpdateBudgetDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000_000)
  budgetAmount?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  defaultCostRate?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  defaultBillRate?: number | null;
}
