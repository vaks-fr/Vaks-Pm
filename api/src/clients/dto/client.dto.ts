import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export const CLIENT_STATUSES = ['PROSPECT', 'ACTIVE', 'ARCHIVED'] as const;
export type ClientStatusValue = (typeof CLIENT_STATUSES)[number];

export class ListClientsDto {
  /** Recherche plein-texte : nom / société / email / téléphone du client + nom de ses contacts. */
  @IsOptional() @IsString() @Length(0, 160)
  search?: string;

  @IsOptional() @IsIn(CLIENT_STATUSES)
  status?: ClientStatusValue;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  /** Taille de page (défaut 12, max 200 — 200 sert aux dropdowns). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number;
}

export class CreateClientDto {
  @IsString()
  @Length(1, 160)
  name!: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 160)
  company?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsEmail()
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 500)
  address?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 2000)
  notes?: string | null;

  @IsOptional() @IsIn(CLIENT_STATUSES)
  status?: ClientStatusValue;

  /** Allowlist de modèles d'agent IA (`provider/model` / `provider/*`) — chantier agents 3. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @Length(1, 120, { each: true })
  allowedAgentModels?: string[];
}

export class UpdateClientDto {
  @IsOptional() @IsString() @Length(1, 160)
  name?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 160)
  company?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsEmail()
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 500)
  address?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 2000)
  notes?: string | null;

  @IsOptional() @IsIn(CLIENT_STATUSES)
  status?: ClientStatusValue;

  /** Allowlist de modèles d'agent IA (`provider/model` / `provider/*`) — chantier agents 3. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @Length(1, 120, { each: true })
  allowedAgentModels?: string[];
}

export class ImportClientsDto {
  /** Contenu CSV brut (colonnes : name obligatoire ; company,email,phone,address,notes,status optionnelles). */
  @IsString()
  @Length(1, 2_000_000)
  csv!: string;
}

export class CreateContactDto {
  @IsString()
  @Length(1, 160)
  name!: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 120)
  title?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsEmail()
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 2000)
  notes?: string | null;

  @IsOptional() @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateContactDto {
  @IsOptional() @IsString() @Length(1, 160)
  name?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 120)
  title?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsEmail()
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 40)
  phone?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(0, 2000)
  notes?: string | null;

  @IsOptional() @IsBoolean()
  isPrimary?: boolean;
}
