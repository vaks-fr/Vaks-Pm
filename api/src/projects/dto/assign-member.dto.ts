import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignMemberDto {
  @IsUUID()
  userId!: string;

  /** Clé du rôle project-scoped (PROJECT_MANAGER, CONTRIBUTOR, VIEWER, GUEST). */
  @IsString()
  roleKey!: string;

  /** Tag sponsor posé dès l'ajout (optionnel — éditable ensuite via PATCH membre). */
  @IsOptional()
  @IsBoolean()
  isSponsor?: boolean;
}

/** PATCH d'un membre existant — flags orthogonaux au rôle (pattern UpdateTeamMemberDto.isLead). */
export class UpdateProjectMemberDto {
  @IsOptional()
  @IsBoolean()
  isSponsor?: boolean;
}
