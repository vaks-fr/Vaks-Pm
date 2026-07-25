import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway';
import { MutationContextService } from './mutation-context.service';
import { MutationContextInterceptor } from './mutation-context.interceptor';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    EventsGateway,
    MutationContextService,
    { provide: APP_INTERCEPTOR, useClass: MutationContextInterceptor },
  ],
  exports: [EventsGateway, MutationContextService],
})
export class RealtimeModule {}
