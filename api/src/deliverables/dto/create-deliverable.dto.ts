import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Vérification d'un livrable (AGENTS_VERIFICATION.md). En **phase A (pilote)**,
 * seules `self_attest` et `human` sont exploitées ; les autres méthodes sont
 * acceptées (stockées) mais non évaluées tant que le gate n'est pas activé.
 */
const VERIFICATION_METHODS = [
  'self_attest',
  'tool_output',
  'agent_validator',
  'ci_signed',
  'human',
] as const;

export class VerificationDto {
  @IsIn(VERIFICATION_METHODS)
  method!: (typeof VERIFICATION_METHODS)[number];

  @IsOptional()
  @IsString()
  @Length(0, 40)
  status?: string; // passed | failed | pending …

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  evidence?: string; // lien / extrait de sortie d'outil
}

export class CreateDeliverableDto {
  @IsString()
  @Length(1, 300)
  title!: string;

  /** Artefact principal : URL cliquable (dépôt, doc, PR…). Optionnel si `attachmentId`. */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @Length(1, 2000)
  url?: string;

  /** …ou pièce jointe S3 déjà uploadée sur la même tâche. */
  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  /** …OU le contenu texte/markdown du document produit : l'API le persiste
   *  dans Garage/S3 comme pièce jointe et la rattache au livrable. Naturel pour
   *  un agent docs (il émet du markdown). Prioritaire sur `attachmentId`. */
  @IsOptional()
  @IsString()
  @Length(1, 1_000_000)
  content?: string;

  /** Nom de fichier pour `content` (défaut dérivé du titre, ex. `<titre>.md`). */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  filename?: string;

  /** Justification en langage naturel : ce qui a été produit, comment, choix. */
  @IsOptional()
  @IsString()
  @Length(0, 8000)
  justification?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VerificationDto)
  verification?: VerificationDto;

  /** SHA du commit associé (preuve CI, chantier vérif phase B). Optionnel. */
  @IsOptional()
  @IsString()
  @Length(0, 80)
  commitSha?: string;
}
