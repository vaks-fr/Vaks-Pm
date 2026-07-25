import { Module } from '@nestjs/common';
import { LabelsService } from './labels.service';
import { LabelsController } from './labels.controller';

@Module({
  providers: [LabelsService],
  controllers: [LabelsController],
})
export class LabelsModule {}
