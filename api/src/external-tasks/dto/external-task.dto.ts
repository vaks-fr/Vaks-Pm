import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Upsert d'un ticket d'outil externe (idempotent sur `(org, source, key)`).
 * Crée au besoin le projet conteneur `kind=EXTERNAL` du couple (source ×
 * client). Appelable depuis l'UI timesheet (« logger sur un ticket ») comme
 * depuis l'API publique (push Jira/ServiceNow via clé org).
 */
export class UpsertExternalTaskDto {
  /** Slug de l'outil source : `jira`, `servicenow`, `zendesk`, … */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,31}$/, {
    message: 'source doit être un slug ([a-z0-9_-], 1-32 caractères)',
  })
  source!: string;

  /** Identifiant humain du ticket dans l'outil (ex. `PROJ-1234`, `INC0042`). */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 64)
  key!: string;

  /** Titre du ticket. Optionnel — défaut = la clé. Mis à jour si fourni. */
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  /** Lien cliquable vers le ticket dans l'outil source. */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2000)
  url?: string;

  /** Client auquel rattacher le conteneur (projet `SOURCE-CLIENT` dédié).
   *  Absent = bucket générique de l'outil. */
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /** Utilisateur à assigner au ticket (pour qu'il apparaisse dans SA
   *  timesheet). Destiné aux appels machine (clé org) ; depuis l'UI, c'est
   *  l'appelant qui est assigné. */
  @IsOptional()
  @IsEmail()
  assigneeEmail?: string;
}

export class SearchExternalTasksDto {
  /** Recherche plein-texte sur la clé et le titre. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  source?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
