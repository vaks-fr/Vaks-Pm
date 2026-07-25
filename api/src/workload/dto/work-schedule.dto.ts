import { IsDateString, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpsertWorkScheduleDto {
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursMon?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursTue?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursWed?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursThu?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursFri?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursSat?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) hoursSun?: number;

  @IsOptional() @IsInt() @Min(0) @Max(100) occupancyPct?: number;
}
