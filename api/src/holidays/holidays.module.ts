import { Global, Module } from '@nestjs/common';
import { HolidaysService } from './holidays.service';
import { HolidaysController, HolidaysLookupController } from './holidays.controller';

@Global()
@Module({
  providers: [HolidaysService],
  controllers: [HolidaysController, HolidaysLookupController],
  exports: [HolidaysService],
})
export class HolidaysModule {}
