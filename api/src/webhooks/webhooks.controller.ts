import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import {
  CreateWebhookDto,
  KNOWN_EVENTS,
  UpdateWebhookDto,
  WebhooksService,
} from './webhooks.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/webhooks')
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Get('events')
  @RequirePermissions('org:manage')
  events() {
    return { events: KNOWN_EVENTS };
  }

  @Get()
  @RequirePermissions('org:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.orgId);
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWebhookDto) {
    return this.svc.create(user.orgId, dto, user.userId);
  }

  @Patch(':id')
  @RequirePermissions('org:manage')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.svc.update(user.orgId, id, dto, user.userId);
  }

  @Delete(':id')
  @RequirePermissions('org:manage')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.remove(user.orgId, id, user.userId);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions('org:manage')
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.rotateSecret(user.orgId, id, user.userId);
  }

  @Post(':id/test')
  @RequirePermissions('org:manage')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.sendTest(user.orgId, id);
  }

  @Get('deliveries')
  @RequirePermissions('org:manage')
  deliveries(
    @CurrentUser() user: AuthUser,
    @Query('webhookId') webhookId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? parseInt(limit, 10) : 100;
    return this.svc.listDeliveries(user.orgId, webhookId, Number.isFinite(n) ? n : 100);
  }

  @Post('deliveries/:id/retry')
  @RequirePermissions('org:manage')
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.retryDelivery(user.orgId, id);
  }
}
