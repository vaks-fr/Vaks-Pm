import { IsArray, IsOptional, IsString, Length } from 'class-validator';

export class CreateApiTokenDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /** Scopes (permissions). USER : restriction optionnelle. ORG : requis (lecture seule). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  /** ISO 8601 ; absent/null = pas d'expiration. */
  @IsOptional()
  @IsString()
  expiresAt?: string | null;
}
