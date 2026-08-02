import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { McpToolUsageService, MCP_USAGE_WINDOW_SEC } from './mcp-tool-usage.service';

/**
 * Lecture de l'usage MCP par tool. App-privé (**pas** `@PublicApi`) : c'est une
 * vue d'administration, pas une surface d'intégration — et l'exposer aux jetons
 * permettrait à un agent d'observer sa propre consommation pour la contourner.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/mcp')
export class McpAdminController {
  constructor(private readonly usage: McpToolUsageService) {}

  /**
   * Compteurs par tool sur la **fenêtre courante** (temps réel).
   *
   * L'historique, lui, vit dans le journal d'audit (`detail.mcpTool`) — mais il
   * **sous-compte les lectures**, seules les mutations et les GET `@Audited` y
   * étant capturées. Les deux vues sont donc complémentaires, pas redondantes.
   */
  @Get('tool-usage')
  @RequirePermissions('org:manage')
  async toolUsage() {
    return {
      windowSec: MCP_USAGE_WINDOW_SEC,
      tools: await this.usage.currentWindow(),
    };
  }
}
