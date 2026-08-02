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

/** Application partielle (Lot 2.5, AUTOPLAN_IMPROVEMENTS.md §2.5) : restreint
 *  la PERSISTANCE (pas l'aperçu, qui reste complet) aux allocations touchant
 *  ces users et/ou ces tâches. `undefined`/tableaux vides = pas de filtre. */
export class ApplyFilterDto {
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  taskIds?: string[];
}

/**
 * Levée CIBLÉE du gel du passé (Lot 4.2, AUTOPLAN_IMPROVEMENTS.md §4.2, porte
 * 2 — « Libérer cette journée »). Le gel du passé (cutoff = J+1) reste la
 * règle GÉNÉRALE ; ceci l'assouplit UNIQUEMENT sur un périmètre nominatif — un
 * user, un jour — jamais d'office. Validation métier forte dans
 * `AutoplanService.run` : n'a d'effet qu'avec `scope='user'`,
 * `userId===dto.userId` et `date` = AUJOURD'HUI (le seul jour du passé qu'une
 * action explicite du PM peut légitimement rouvrir — le passé strict reste
 * intouchable). Toute violation est rejetée (400), jamais silencieusement
 * ignorée.
 */
export class UnfreezeUserDayDto {
  @IsUUID()
  userId!: string;

  @IsDateString()
  date!: string;
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

  /** Stratégie de placement (Lot 2.1, AUTOPLAN_IMPROVEMENTS.md §2.1). `asap`
   *  (défaut) = au plus tôt, arbitré par le score (comportement du lot 1a).
   *  `deadline_aware` = seconde passe corrective qui booste le score des
   *  tâches en `deadline_overflow` et REJOUE le placement sur une capacité
   *  fraîche (jamais de mutation manuelle de segments) ; le nouveau plan
   *  n'est retenu que s'il améliore STRICTEMENT Σ(jours de retard × poids de
   *  priorité), sinon le plan `asap` est conservé — sûr par construction. */
  @IsOptional()
  @IsIn(['asap', 'deadline_aware'])
  placementStrategy?: 'asap' | 'deadline_aware';

  /** Curseur de concentration (Lot 2.2, AUTOPLAN_IMPROVEMENTS.md §2.2) :
   *  module le poids de continuité et le regroupement en grappes de
   *  l'affectation assistée (`autoAssign`). Sans effet si `autoAssign` est
   *  faux ou `scope=user`. Défaut : setting org `autoplan.concentration`
   *  (fallback `balanced`) si omis. */
  @IsOptional()
  @IsIn(['focus', 'balanced', 'spread'])
  concentration?: 'focus' | 'balanced' | 'spread';

  /** Application partielle (Lot 2.5) : restreint la persistance à ces
   *  users/tâches. L'aperçu (`persist` faux) renvoie toujours le diff
   *  complet — seul `persist` respecte ce filtre. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ApplyFilterDto)
  applyOnly?: ApplyFilterDto;

  /** Levée ciblée du gel (Lot 4.2, porte 2) — voir `UnfreezeUserDayDto`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => UnfreezeUserDayDto)
  unfreezeUserDay?: UnfreezeUserDayDto;
}
