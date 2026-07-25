import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class MfaLoginDto {
  @IsString()
  challengeToken!: string;

  @IsString()
  @MinLength(6)
  code!: string;
}

export class MfaVerifyDto {
  @IsString()
  @MinLength(6)
  code!: string;
}
