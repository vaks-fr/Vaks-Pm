import { IsNumber, Max, Min } from 'class-validator';

/**
 * Saisie/MAJ du taux de facturation d'un **agent IA** sur un projet.
 * Unité = € par 1000 tokens (in+out) déclarés via `AgentRun` — jamais l'heure.
 * Pour effacer l'override projet (retomber sur le défaut agent), utiliser
 * le DELETE dédié, comme pour les taux humains.
 */
export class SetAgentRateDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1_000_000)
  billRatePerKTokens!: number;
}
