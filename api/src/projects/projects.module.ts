import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { ProjectCreationPolicyService } from './project-creation-policy.service';
import { AdminModule } from '../admin/admin.module';
import { SkillsModule } from '../skills/skills.module';

@Module({
  imports: [AdminModule, SkillsModule],
  providers: [ProjectsService, ProjectCreationPolicyService],
  controllers: [ProjectsController],
  exports: [ProjectCreationPolicyService],
})
export class ProjectsModule {}
