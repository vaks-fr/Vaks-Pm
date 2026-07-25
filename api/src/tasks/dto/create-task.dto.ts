import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { TaskPriority, TaskStatus } from '@db';

export class CreateTaskDto {
  @IsString()
  @Length(1, 300)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimateHours?: number;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progressPct?: number;

  @IsOptional()
  @IsUUID()
  parentTaskId?: string;

  @IsOptional()
  @IsUUID()
  boardColumnId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  assigneeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  labelIds?: string[];

  @IsOptional()
  @IsBoolean()
  isMilestone?: boolean;

  @IsOptional()
  @IsBoolean()
  isBug?: boolean;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsUUID()
  requiredSkillId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  requiredSkillLevel?: number;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  externalDependency?: string;

  @IsOptional()
  @IsBoolean()
  externalBlocked?: boolean;
}
