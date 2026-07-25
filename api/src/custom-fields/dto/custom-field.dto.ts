import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'] as const;
export const CUSTOM_FIELD_ENTITIES = ['task', 'project'] as const;

export class CreateCustomFieldDto {
  @IsIn(CUSTOM_FIELD_ENTITIES as unknown as string[])
  entityType!: (typeof CUSTOM_FIELD_ENTITIES)[number];

  @IsString()
  @Length(1, 80)
  name!: string;

  @IsIn(CUSTOM_FIELD_TYPES as unknown as string[])
  type!: (typeof CUSTOM_FIELD_TYPES)[number];

  /** Options de la liste déroulante (obligatoire non vide si type='select'). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  options?: string[];

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
}

export class UpdateCustomFieldDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  options?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  order?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  projectIds?: string[];
}

class CustomFieldValueItemDto {
  @IsString()
  fieldId!: string;

  /** Sérialisation canonique en texte ; vide = suppression de la valeur. */
  @IsString()
  @Length(0, 2000)
  value!: string;
}

export class UpsertCustomFieldValuesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldValueItemDto)
  values!: CustomFieldValueItemDto[];
}
