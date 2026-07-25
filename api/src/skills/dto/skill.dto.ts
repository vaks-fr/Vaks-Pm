import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class CreateSkillDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color: format #rrggbb' })
  color?: string;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}

export class UpdateSkillDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color: format #rrggbb' })
  color?: string;

  @IsOptional()
  @IsString()
  @Length(0, 80)
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];
}

/** PUT /users/:userId/skills/:skillId — set or update level */
export class UpsertUserSkillDto {
  @IsInt()
  @Min(1)
  @Max(100)
  level!: number;
}

/** PUT /projects/:projectId/skills body — replace the full list */
export class SetProjectSkillsDto {
  @IsArray()
  @IsUUID('all', { each: true })
  skillIds!: string[];
}

/** PUT /teams/:teamId/skills body — replace the full competency set */
export class SetTeamSkillsDto {
  @IsArray()
  @IsUUID('all', { each: true })
  skillIds!: string[];
}

/** PUT /skills/packs/:packId/teams body — set teams qui voient/installent ce pack */
export class SetPackTeamScopeDto {
  @IsArray()
  @IsUUID('all', { each: true })
  teamIds!: string[];
}

/** Entrée d'un skill au sein d'un pack custom. */
export class SkillPackSkillDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}

/**
 * POST /skills/packs — créer/mettre à jour la définition d'un pack custom.
 * Même structure que les fichiers JSON builtin embarqués dans l'image.
 */
export class CreateSkillPackDto {
  /** Slug ascii minuscule (`^[a-z0-9][a-z0-9_-]{0,63}$`). */
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
    message: 'id : slug minuscule [a-z0-9_-], 1–64 caractères',
  })
  id!: string;

  @IsString()
  @Length(1, 80)
  label!: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color : format #rrggbb' })
  color?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SkillPackSkillDto)
  skills!: SkillPackSkillDto[];
}
