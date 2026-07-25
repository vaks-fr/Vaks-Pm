import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body du refus d'offre : raison libre optionnelle (affichée dans l'historique). */
export class RefuseOfferDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** Body de l'envoi de l'offre par email : message d'introduction optionnel. */
export class EmailOfferDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  intro?: string;
}
