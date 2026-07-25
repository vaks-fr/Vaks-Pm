import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { UserStatus } from '@db';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;

  /** Attribuer un siège de licence (défaut true côté service). */
  @IsOptional()
  @IsBoolean()
  licensed?: boolean;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  roleKey?: string;

  /** Identifiant RH/employé interne (unique par organisation). */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  employeeId?: string;
}
