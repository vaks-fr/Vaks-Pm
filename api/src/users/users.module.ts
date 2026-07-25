import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MePreferencesController } from './me-preferences.controller';
import { MeDataController } from './me-data.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [forwardRef(() => AuthModule)],
  providers: [UsersService],
  controllers: [UsersController, MePreferencesController, MeDataController],
  exports: [UsersService],
})
export class UsersModule {}
