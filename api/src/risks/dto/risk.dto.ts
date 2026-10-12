import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { RISK_CATEGORIES, RISK_STATUSES, type RiskCategory, type RiskStatus } from '@vaks-pm/shared';

export class CreateRiskDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 4000)
  description?: string;

  @IsInt()
  @Min(1)
  @Max(5)
  probability!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  impact!: number;

  @IsOptional()
  @IsIn(RISK_CATEGORIES as unknown as string[])
  category?: RiskCategory;

  @IsOptional()
  @IsString()
  @Length(0, 4000)
  mitigation?: string;

  @IsOptional()
  @IsString()
  ownerId?: string | null;

  @IsOptional()
  @IsIn(RISK_STATUSES as unknown as string[])
  status?: RiskStatus;
}

export class UpdateRiskDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 4000)
  description?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  probability?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  impact?: number;

  @IsOptional()
  @IsIn(RISK_CATEGORIES as unknown as string[])
  category?: RiskCategory;

  @IsOptional()
  @IsString()
  @Length(0, 4000)
  mitigation?: string | null;

  @IsOptional()
  @IsString()
  ownerId?: string | null;

  @IsOptional()
  @IsIn(RISK_STATUSES as unknown as string[])
  status?: RiskStatus;
}
