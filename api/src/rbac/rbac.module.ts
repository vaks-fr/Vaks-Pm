import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { PermissionsGuard } from './permissions.guard';
import { ProjectAccessService } from './project-access.service';
import { ProjectAccessGuard } from './project-access.guard';

@Global()
@Module({
  providers: [RbacService, PermissionsGuard, ProjectAccessService, ProjectAccessGuard],
  exports: [RbacService, PermissionsGuard, ProjectAccessService, ProjectAccessGuard],
})
export class RbacModule {}
