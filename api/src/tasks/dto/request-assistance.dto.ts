import { IsBoolean, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/**
 * Demande d'assistance sur la tâche qu'on détient (lot B). Volontairement
 * minimale : la question, éventuellement la compétence qui manque, et le choix
 * de mettre la tâche en pause. **Aucun destinataire** n'est demandé — l'équipe
 * cible est résolue serveur depuis la compétence, pour qu'un agent ne puisse pas
 * choisir qui il dérange (même principe que l'audience des annonces projet).
 */
export class RequestAssistanceDto {
  /** Ce qui bloque, en langage naturel. Posté en commentaire sur la tâche. */
  @IsString()
  @Length(1, 4000)
  question!: string;

  /** Compétence manquante (catalogue). À défaut, celle requise par la tâche. */
  @IsOptional()
  @IsUUID()
  skillId?: string;

  /** …ou une compétence proposée hors catalogue, si rien ne correspond. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  proposedSkillName?: string;

  /**
   * true = passer la tâche ON_HOLD avec la question pour motif. La tâche garde
   * son claim (personne ne la reprend au hasard) et son bail s'éteint : elle
   * attend explicitement une réponse humaine.
   */
  @IsOptional()
  @IsBoolean()
  pause?: boolean;
}
