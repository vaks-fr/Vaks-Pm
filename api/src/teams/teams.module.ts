import { Module } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { TeamsController } from './teams.controller';
import { WorkloadModule } from '../workload/workload.module';

@Module({
  imports: [WorkloadModule],
  providers: [TeamsService],
  controllers: [TeamsController],
})
export class TeamsModule {}
