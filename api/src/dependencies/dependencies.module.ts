import { Module } from '@nestjs/common';
import { DependenciesService } from './dependencies.service';
import { DependenciesController } from './dependencies.controller';

@Module({
  providers: [DependenciesService],
  controllers: [DependenciesController],
})
export class DependenciesModule {}
