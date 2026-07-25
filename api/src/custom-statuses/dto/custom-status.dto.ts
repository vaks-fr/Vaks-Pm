import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/** Statuts parents subdivisables. Le cycle agents (CLAIMED / CHANGES_REQUESTED /
 *  APPROVED) est système : jamais de sous-statut dessus. */
export const SUB_STATUS_PARENTS = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'ON_HOLD',
  'DONE',
] as const;
export type SubStatusParent = (typeof SUB_STATUS_PARENTS)[number];

export class CreateCustomStatusDto {
  @IsIn(SUB_STATUS_PARENTS as unknown as string[])
  parentStatus!: SubStatusParent;

  @IsString()
  @Length(1, 60)
  name!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 30)
  color?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  order?: number;

  /** projectIds de restriction ; absent/[] = tous les projets. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  projectIds?: string[];

  /** Users notifiés à l'ENTRÉE d'une tâche dans ce sous-statut. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyUserIds?: string[];

  /** Équipes notifiées (tous les membres) à l'ENTRÉE dans ce sous-statut. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyTeamIds?: string[];
}

/** `parentStatus` est IMMUABLE (changer le parent muterait silencieusement le
 *  statut moteur des tâches qui portent le sous-statut) — delete + recreate. */
export class UpdateCustomStatusDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 30)
  color?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  order?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  projectIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyUserIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notifyTeamIds?: string[];
}
