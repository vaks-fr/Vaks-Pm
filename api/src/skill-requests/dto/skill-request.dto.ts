import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { SkillRequestStatus, SkillRequestType } from '@db';

export class CreateSkillRequestDto {
  /** Équipe (et son lead) destinataire. */
  @IsUUID()
  teamId!: string;

  @IsEnum(SkillRequestType)
  type!: SkillRequestType;

  /** Skill existant visé. Exclusif avec `proposedName`. */
  @ValidateIf((o) => !o.proposedName)
  @IsUUID()
  skillId?: string;

  /** Nom d'un skill encore inexistant à créer. Exclusif avec `skillId`. */
  @ValidateIf((o) => !o.skillId)
  @IsString()
  @Length(1, 80)
  proposedName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  desiredLevel?: number;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  taskId?: string;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;
}

export class UpdateSkillRequestStatusDto {
  @IsEnum(SkillRequestStatus)
  status!: SkillRequestStatus;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;
}
