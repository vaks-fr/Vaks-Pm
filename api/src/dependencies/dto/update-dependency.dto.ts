import { IsEnum, IsInt, IsOptional } from 'class-validator';
import { DependencyType } from '@db';

export class UpdateDependencyDto {
  @IsOptional()
  @IsEnum(DependencyType)
  type?: DependencyType;

  @IsOptional()
  @IsInt()
  lagDays?: number;
}
