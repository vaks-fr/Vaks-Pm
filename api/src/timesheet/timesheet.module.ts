import { Module } from '@nestjs/common';
import { TimesheetService } from './timesheet.service';
import { TimesheetController } from './timesheet.controller';
import { HolidaysModule } from '../holidays/holidays.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [HolidaysModule, AdminModule],
  providers: [TimesheetService],
  controllers: [TimesheetController],
})
export class TimesheetModule {}
