import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';

@Module({
  imports: [RbacModule],
  providers: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}
