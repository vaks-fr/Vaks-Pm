import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/** Override d'affectation par le PM : pour une tâche donnée, utiliser CES
 *  users (choisis parmi les alternatives qualifiées/disponibles) au lieu du
 *  meilleur candidat retenu automatiquement. */
export class AssignmentOverrideDto {
  @IsUUID()
  taskId!: string;

  @IsArray()
  @IsUUID('all', { each: true })
  userIds!: string[];
}

export class AutoplanRequestDto {
  @IsIn(['project', 'user', 'global'])
  scope!: 'project' | 'user' | 'global';

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsBoolean()
  persist?: boolean;

  /** Ce que l'auto-plan préserve. Le passé/aujourd'hui est toujours gelé en
   *  plus. Défaut `manual_autosplit`. Voir AutoplanService.run. */
  @IsOptional()
  @IsIn(['manual_autosplit', 'manual', 'none'])
  preserve?: 'manual_autosplit' | 'manual' | 'none';

  /** Affectation assistée : si vrai, l'auto-plan propose le(s) meilleur(s)
   *  assignee(s) (skill + capacité réelle) pour les tâches SANS assigné, puis
   *  les planifie. Sans persist, c'est une suggestion (le PM peut swapper via
   *  `assignmentOverrides`) ; avec persist, les `TaskAssignee` sont créés.
   *  Ignoré pour `scope=user`. Défaut false (comportement historique : les
   *  tâches sans assigné sont silencieusement ignorées). */
  @IsOptional()
  @IsBoolean()
  autoAssign?: boolean;

  /** Réassignation : en mode suggestion, propose AUSSI les tâches déjà
   *  assignées (par défaut sur leur assigné actuel) pour swap via
   *  `assignmentOverrides`. Ignoré pour `scope=user`. Indépendant du mode de
   *  préservation. Défaut false (comportement historique). */
  @IsOptional()
  @IsBoolean()
  reassignAssigned?: boolean;

  /** Overrides PM du choix automatique d'assignees, par tâche. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentOverrideDto)
  assignmentOverrides?: AssignmentOverrideDto[];
}
