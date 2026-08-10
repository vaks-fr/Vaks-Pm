import { IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsObject, IsOptional, IsString, Length, Min, ValidateIf } from 'class-validator';
import { ProjectStatus, ProjectHealth } from '@db';

export class UpdateProjectDto {
  /**
   * Bascule facturable / non-facturable. Modifiable uniquement tant que
   * `status = DRAFT` ; verrouillé une fois le projet sorti du brouillon.
   */
  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  /** Santé projet (RAG) pour le point de statut client. `null` = effacer. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEnum(ProjectHealth)
  statusHealth?: ProjectHealth | null;

  /** Résumé narratif du statut (rendu dans le deck client). `null`/'' = effacer. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 4000)
  statusSummary?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  startDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  clientId?: string | null;

  // ---------- Agents IA (chantier 2 — contexte de travail) ----------
  @IsOptional()
  @IsBoolean()
  agentsEnabled?: boolean;

  /** Kill-switch par projet du contexte documentaire SharePoint pour les agents. */
  @IsOptional()
  @IsBoolean()
  spContextEnabled?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(0, 20000)
  agentContext?: string | null;

  /**
   * Brief STRUCTURÉ (`{ role, outputConventions, deliveryTarget, outOfScope }`).
   * La validation fine (clés connues, types, caps) est faite par
   * `normalizeAgentBrief` côté service — même traitement que
   * `verificationCapabilities`. `null` explicite = effacer.
   */
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
   *  au bon dépôt (anti-réutilisation cross-dépôt). Vide = comportement org-wide. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  ciRepos?: string[];

  /** Override projet de l'auto-clôture APPROVED→DONE (chantier 2c). `null` =
   *  hériter du réglage org `agents.autoCloseOnApproval`. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsBoolean()
  agentAutoCloseOnApproval?: boolean | null;

  /** Enveloppe totale de coût agent (€) pour le projet. `null` = pas de plafond. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  agentCostBudget?: number | null;

  /** Capacités de vérification mécaniques disponibles (chantier 3, phase B) :
   *  sous-ensemble de `tool_output`/`agent_validator`/`ci_signed`. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsArray()
  @IsIn(['tool_output', 'agent_validator', 'ci_signed'], { each: true })
  verificationCapabilities?: string[] | null;

  /** Enjeu du projet (chantier 3, phase B) : dérive le plancher de vérification. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['low', 'medium', 'high', 'critical'])
  stakes?: string | null;

  /** Mode de vérification (phase D) — override projet du défaut org
   *  `agents.verification.mode`. `enforce` = le gate bloque + auto-transition
   *  agent_validator (échantillonnée) ; `null` = hérite de l'org. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['report_only', 'enforce'])
  verificationMode?: string | null;

  /** Matrice d'événements notifiés aux sponsors du projet. Clés booléennes
   *  `milestoneReached` / `projectStatus` (défaut ON) et `milestoneAtRisk` /
   *  `budgetThresholds` (défaut OFF, opt-in). Whitelist appliquée côté service.
   *  `null` = revenir aux défauts. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsObject()
  sponsorNotify?: Record<string, boolean> | null;
}
