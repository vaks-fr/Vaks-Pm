import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Déclaration d'un espace de collaboration créé DEHORS (Slack, Google, ou Teams
 * géré hors Vaks). L'URL est re-validée en service (https obligatoire) — on ne
 * s'appuie pas seulement sur `@IsUrl` pour garder un message d'erreur unique.
 */
export class UpsertCollabSpaceBody {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string | null;
}
