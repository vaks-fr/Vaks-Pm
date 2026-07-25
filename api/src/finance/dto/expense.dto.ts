import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const EXPENSE_CATEGORIES = [
  'LICENSE',
  'HARDWARE',
  'CLOUD',
  'SUBCONTRACTOR',
  'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_STATUSES = ['PLANNED', 'INCURRED'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_RECURRENCES = ['ONE_OFF', 'MONTHLY', 'ANNUAL'] as const;
export type ExpenseRecurrence = (typeof EXPENSE_RECURRENCES)[number];

/**
 * Création d'un coût hors main-d'œuvre rattaché à un projet (licence, matériel,
 * cloud, sous-traitance…). Gardé par `finance:manage`. `amount` = coût interne
 * (par période si récurrent), `billAmount` = montant refacturé client (optionnel).
 */
export class CreateExpenseDto {
  @IsEnum(EXPENSE_CATEGORIES)
  category!: ExpenseCategory;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000_000)
  amount!: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000_000)
  billAmount?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  quantity?: number;

  @IsOptional()
  @IsEnum(EXPENSE_STATUSES)
  status?: ExpenseStatus;

  @IsOptional()
  @IsEnum(EXPENSE_RECURRENCES)
  recurrence?: ExpenseRecurrence;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  startDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  endDate?: string | null;
}

/** MAJ partielle d'un coût hors main-d'œuvre. Tous les champs optionnels. */
export class UpdateExpenseDto {
  @IsOptional()
  @IsEnum(EXPENSE_CATEGORIES)
  category?: ExpenseCategory;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000_000)
  amount?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000_000)
  billAmount?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  quantity?: number;

  @IsOptional()
  @IsEnum(EXPENSE_STATUSES)
  status?: ExpenseStatus;

  @IsOptional()
  @IsEnum(EXPENSE_RECURRENCES)
  recurrence?: ExpenseRecurrence;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  startDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  endDate?: string | null;
}
