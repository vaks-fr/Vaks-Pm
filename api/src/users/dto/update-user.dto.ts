import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { UserStatus } from '@db';

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;

  /** Siège de licence : false libère le siège (+coupe les sessions), true en
   *  attribue un (vérifie le plafond `maxUsers`). */
  @IsOptional()
  @IsBoolean()
  licensed?: boolean;

  /** Grant « AI administrator » (Membership.isAgentAdmin) : accorde `agent:manage`
   *  par-dessus le rôle org, sans consommer le slot de rôle. */
  @IsOptional()
  @IsBoolean()
  isAgentAdmin?: boolean;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  roleKey?: string;

  /** Pays ISO 3166-1 alpha-2 (ex. "FR", "LU"). null pour hériter du défaut org. */
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string | null;

  /** Identifiant RH/employé interne. null pour effacer. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  employeeId?: string | null;
}
