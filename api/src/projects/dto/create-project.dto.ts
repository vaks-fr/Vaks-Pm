import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @Matches(/^[A-Z0-9]{2,3}$/, {
    message: 'key: 2 ou 3 caractères majuscules/chiffres (sert de logo court)',
  })
  key!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Client (portefeuille) optionnel à la création. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  clientId?: string | null;

  /**
   * Équipes auxquelles rattacher le projet. Obligatoire (≥1) pour les
   * créateurs team-scoped (TEAM_MANAGER) — vérifié côté service ; optionnel
   * pour ORG_ADMIN / PORTFOLIO_MANAGER.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  teamIds?: string[];

  /**
   * true = projet facturable (charter signé requis pour ACTIVE),
   * false = projet non-facturable (DRAFT → ACTIVE direct).
   * Défaut : true (rétrocompatibilité).
   */
  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  // ---------- Agents IA (chantier 2 — contexte de travail) ----------
  /** Autoriser les agents IA. Si true, `agentContext` non vide requis (service). */
  @IsOptional()
  @IsBoolean()
  agentsEnabled?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 20000)
  agentContext?: string | null;

  /** Brief structuré — normalisé côté service (cf. `normalizeAgentBrief`). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  agentBrief?: Record<string, unknown> | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 8000)
  agentGuardrails?: string | null;

  /** Dépôt(s) CI autorisé(s) (ex. `["owner/repo"]`) — lie la preuve `ci_signed`
   *  d'un livrable à ce dépôt (anti-réutilisation cross-dépôt). Vide = comportement
   *  org-wide historique ; la protection s'active dès qu'un dépôt est renseigné. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  ciRepos?: string[];
}
