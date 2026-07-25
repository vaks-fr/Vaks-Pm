import { IsEnum, IsInt, IsOptional, IsString, Length, Min, ValidateIf } from 'class-validator';
import { TaskStatus } from '@db';

export class UpdateColumnDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  wipLimit?: number | null;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;
}
