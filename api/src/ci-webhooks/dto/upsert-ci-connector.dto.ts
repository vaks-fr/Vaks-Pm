import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { CI_PROVIDERS } from '../ci-providers';

/**
 * Création / mise à jour d'un connecteur CI signataire. Le `secret` (partagé
 * HMAC) est **write-only** : fourni ici en clair, chiffré at-rest, jamais
 * ré-émis à la lecture (remplacé par un booléen `secretConfigured`). Fournir
 * une chaîne vide efface le secret ; omettre le champ le conserve tel quel.
 */
export class UpsertCiConnectorDto {
  @IsOptional()
  @IsIn(CI_PROVIDERS as unknown as string[])
  provider?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  label?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 400)
  secret?: string;
}
