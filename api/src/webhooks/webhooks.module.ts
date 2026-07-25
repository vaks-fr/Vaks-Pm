import { Global, Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksProjectController } from './webhooks-project.controller';
import { WebhooksInternalController } from './webhooks-internal.controller';

/**
 * Module webhooks sortants. Global pour que tasks/comments/projects puissent
 * injecter `WebhooksService` et appeler `dispatch(orgId, event, payload)`
 * sans cycle d'import.
 */
@Global()
@Module({
  providers: [WebhooksService],
  controllers: [WebhooksController, WebhooksProjectController, WebhooksInternalController],
  exports: [WebhooksService],
})
export class WebhooksModule {}
