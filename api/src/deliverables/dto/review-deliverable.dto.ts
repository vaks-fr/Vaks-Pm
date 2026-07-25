import { IsEnum, IsOptional, IsString, Length } from 'class-validator';

/** Décision de revue d'un livrable (reviewer `task:review`, ≠ auteur). */
export enum ReviewDecision {
  APPROVE = 'approve',
  REQUEST_CHANGES = 'request_changes',
}

export class ReviewDeliverableDto {
  @IsEnum(ReviewDecision)
  decision!: ReviewDecision;

  /** Note de revue (obligatoire côté produit sur un refus, conseillée sinon). */
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  note?: string;
}
