import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/** Audiences d'annonce résolues CÔTÉ SERVEUR par rôles — jamais d'emails libres. */
export const ANNOUNCEMENT_AUDIENCES = ['pm', 'members', 'watchers', 'sponsors'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export class CreateAnnouncementDto {
  /** Titre libre (le sujet de l'email reste préfixé serveur `[Org] Projet — …`). */
  @IsString()
  @Length(1, 200)
  title!: string;

  /** Corps libre en texte brut (échappé au rendu, URLs non cliquables). */
  @IsString()
  @Length(1, 4000)
  body!: string;

  /** Qui prévenir, par rôle. La résolution en personnes est serveur. */
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ANNOUNCEMENT_AUDIENCES, { each: true })
  audience!: AnnouncementAudience[];

  /** Tâche de contexte optionnelle (ajoute ses watchers à l'audience `watchers`). */
  @IsOptional()
  @IsUUID()
  taskId?: string;
}
