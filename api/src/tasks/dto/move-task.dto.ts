import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';

export class MoveTaskDto {
  @IsUUID()
  boardColumnId!: string;

  /**
   * Sous-statut cible (Custom Status) — drop dans un container du board.
   * Non-null → doit appartenir au statut de la colonne cible (400 sinon).
   * `null` → zone principale de la colonne (statut seul). Absent → préservé
   * si cohérent avec la colonne, effacé sinon.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subStatusId?: string | null;

  /**
   * Motif facultatif quand la colonne cible met la tâche en pause (`ON_HOLD`).
   * Écrit dans l'historique de statut + `holdReason`. Ignoré pour les autres
   * statuts cibles.
   */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  statusReason?: string;

  @IsOptional()
  @IsNumber()
  position?: number;

  @IsOptional()
  @IsUUID()
  beforeTaskId?: string;

  @IsOptional()
  @IsUUID()
  afterTaskId?: string;

  /**
   * Colonne cible de statut `DONE` : si `true`, clôture en cascade les
   * prédécesseurs non terminés. Sinon, refus (409) si l'un reste ouvert.
   */
  @IsOptional()
  @IsBoolean()
  completePredecessors?: boolean;
}
