import { IsBoolean, IsDateString, IsOptional } from 'class-validator';

/**
 * Re-fige (snapshot) les taux des time entries d'un projet AUX TAUX COURANTS.
 * Cas d'usage : corriger une erreur de taux saisie après coup, ou back-filler
 * les saisies antérieures au snapshotting. Gardé `finance:manage`.
 */
export class RestampRatesDto {
  /** Borne basse de la date métier (incluse), ISO YYYY-MM-DD. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Borne haute (incluse). */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** true = ne re-stampe QUE les saisies sans snapshot (back-fill non destructif). */
  @IsOptional()
  @IsBoolean()
  onlyMissing?: boolean;
}
