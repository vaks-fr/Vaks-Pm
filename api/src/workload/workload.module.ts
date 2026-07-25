import { Module } from '@nestjs/common';
import { WorkloadService } from './workload.service';
import { WorkloadController } from './workload.controller';
import { AutoplanService } from './autoplan.service';
import { CapacityService } from './capacity.service';
import { HolidaysModule } from '../holidays/holidays.module';

@Module({
  imports: [HolidaysModule],
  providers: [WorkloadService, AutoplanService, CapacityService],
  controllers: [WorkloadController],
  exports: [WorkloadService, CapacityService],
})
export class WorkloadModule {}
