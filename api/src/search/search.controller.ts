import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SearchService } from './search.service';

/**
 * Recherche globale pour la command palette (⌘K). App-privé (PAS `@PublicApi`) :
 * confort UI navigateur, pas une surface d'intégration. `project:view` suffit —
 * le service borne les résultats au périmètre accessible de l'appelant.
 */
@ApiTags('search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermissions('project:view')
  query(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.search.global(user, q ?? '');
  }
}
