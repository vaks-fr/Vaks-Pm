import { IsEnum, IsInt, IsOptional, IsUUID } from 'class-validator';
import { DependencyType } from '@db';

export class CreateDependencyDto {
  @IsUUID()
  predecessorId!: string;

  @IsUUID()
  successorId!: string;

  @IsOptional()
  @IsEnum(DependencyType)
  type?: DependencyType;

  @IsOptional()
  @IsInt()
  lagDays?: number;
}
