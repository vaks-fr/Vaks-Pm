import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * Verdict d'un agent validateur sur un livrable (phase D `agent_validator`).
 * `approve` = preuve `pass` ; `changes_requested` = preuve `fail`. Le verdict
 * devient une PREUVE (force 2), pas l'approbation humaine terminale.
 */
export class SubmitValidationDto {
  @IsIn(['approve', 'changes_requested'])
  verdict!: 'approve' | 'changes_requested';

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}
