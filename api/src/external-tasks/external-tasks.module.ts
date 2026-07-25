import { Module } from '@nestjs/common';
import { ExternalTasksService } from './external-tasks.service';
import { ExternalTasksController } from './external-tasks.controller';

@Module({
  providers: [ExternalTasksService],
  controllers: [ExternalTasksController],
})
export class ExternalTasksModule {}
