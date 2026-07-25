import { IsEnum, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { TaskStatus } from '@db';

export class CreateColumnDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsEnum(TaskStatus)
  status!: TaskStatus;

  @IsOptional()
  @IsInt()
  @Min(0)
  wipLimit?: number;
}
