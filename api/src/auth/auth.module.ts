import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';
import { MfaService } from './mfa.service';
import { PasswordPolicyService } from './password-policy.service';
import { SessionsCronService } from './sessions-cron.service';
import { LoginEnabledGuard } from './guards/login-enabled.guard';

@Module({
  imports: [PassportModule, JwtModule.register({}), forwardRef(() => UsersModule)],
  providers: [AuthService, JwtStrategy, MfaService, PasswordPolicyService, SessionsCronService, LoginEnabledGuard],
  controllers: [AuthController],
  exports: [AuthService, MfaService, PasswordPolicyService],
})
export class AuthModule {}
