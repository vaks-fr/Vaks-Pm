import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class CreateTeamDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color: format #rrggbb' })
  color?: string;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  /** Nom d'affichage personnalisé (override LOCAL). Éditable même sur une
   *  équipe SCIM/OIDC ; jamais touché par la synchro. '' / null = effacer
   *  l'override (l'UI revient au `name`). */
  @IsOptional()
  @ValidateIf((o) => o.displayName !== null)
  @IsString()
  @Length(0, 80)
  displayName?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'color: format #rrggbb' })
  color?: string;

  @IsOptional()
  @IsBoolean()
  canCreateNonBillableProject?: boolean;

  /** Auto-licence : attribue un siège de licence à tout membre actif (Org Admin
   *  uniquement — vérifié côté service). */
  @IsOptional()
  @IsBoolean()
  autoLicense?: boolean;
}

export class AddTeamMemberDto {
  @IsUUID()
  userId!: string;

  @IsOptional()
  @IsBoolean()
  isLead?: boolean;
}

export class UpdateTeamMemberDto {
  @IsOptional()
  @IsBoolean()
  isLead?: boolean;

  /**
   * Override par utilisateur pour la création de projets non-facturables.
   * null = hérite de l'équipe ; true/false = écrase. Modifiable par le
   * Team Manager de l'équipe ou par un Org Admin.
   */
  @IsOptional()
  canCreateNonBillableProject?: boolean | null;

  /**
   * Coût interne / h par défaut de l'utilisateur (stocké sur User, global —
   * pas par équipe). null = effacer. Modifiable uniquement par un Team
   * Manager d'une équipe du user, ou un Org Admin.
   */
  @IsOptional()
  @ValidateIf((o) => o.defaultCostRate !== null)
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  defaultCostRate?: number | null;

  /** Taux facturé client / h par défaut. Même règles que defaultCostRate. */
  @IsOptional()
  @ValidateIf((o) => o.defaultBillRate !== null)
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  defaultBillRate?: number | null;
}
