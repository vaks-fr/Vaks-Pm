import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { RbacModule } from './rbac/rbac.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { TasksModule } from './tasks/tasks.module';
import { DeliverablesModule } from './deliverables/deliverables.module';
import { AgentRunsModule } from './agent-runs/agent-runs.module';
import { BoardsModule } from './boards/boards.module';
import { SearchModule } from './search/search.module';
import { LabelsModule } from './labels/labels.module';
import { TimeEntriesModule } from './time-entries/time-entries.module';
import { CommentsModule } from './comments/comments.module';
import { ReportsModule } from './reports/reports.module';
import { DependenciesModule } from './dependencies/dependencies.module';
import { WorkloadModule } from './workload/workload.module';
import { FinanceModule } from './finance/finance.module';
import { TimesheetModule } from './timesheet/timesheet.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ExternalTasksModule } from './external-tasks/external-tasks.module';
import { TeamsModule } from './teams/teams.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './admin/admin.module';
import { ClientsModule } from './clients/clients.module';
import { StorageModule } from './storage/storage.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { HolidaysModule } from './holidays/holidays.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { OpsModule } from './ops/ops.module';
import { BrandingModule } from './branding/branding.module';
import { SkillsModule } from './skills/skills.module';
import { SkillRequestsModule } from './skill-requests/skill-requests.module';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { SsoModule } from './sso/sso.module';
import { ScimModule } from './scim/scim.module';
import { LicensingModule } from './licensing/licensing.module';
import { TeamsProvisioningModule } from './teams-provisioning/teams-provisioning.module';
import { SlackProvisioningModule } from './slack-provisioning/slack-provisioning.module';
import { GoogleChatProvisioningModule } from './google-chat-provisioning/google-chat-provisioning.module';
import { GoogleDriveProvisioningModule } from './google-drive-provisioning/google-drive-provisioning.module';
import { CollabSpacesModule } from './collab-spaces/collab-spaces.module';
import { FileSourcesModule } from './filesources/filesources.module';
import { TicketingModule } from './ticketing/ticketing.module';
import { AgentsModule } from './agents/agents.module';
import { CiWebhooksModule } from './ci-webhooks/ci-webhooks.module';
import { AutomationsModule } from './automations/automations.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { CustomStatusesModule } from './custom-statuses/custom-statuses.module';
import { OAuthModule } from './oauth/oauth.module';
import { AgentSelfAuthModule } from './agents/self-auth/agent-self-auth.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantMiddleware } from './tenancy/tenant.middleware';
import { CommonModule } from './common/common.module';
import { TenantCryptoModule } from './common/crypto/tenant-crypto.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { ApiThrottlerGuard, RL, TOKEN_THROTTLER } from './rbac/api-throttler.guard';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';

@Module({
  imports: [
    // DiscoveryModule : permet à main.ts d'énumérer les routes marquées
    // @PublicApi pour filtrer la doc OpenAPI (et, futur, gater les PAT).
    DiscoveryModule,
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    // Rate limit **distribué via Redis** (partagé entre les réplicas Swarm —
    // plus de compteur ×3 réinitialisé à chaque rolling update). Deux paliers :
    //  - `default` : filet par IP, par route. Les @Throttle de controller (ex.
    //    /auth/login, /auth/login/mfa) surchargent ce nom 'default' → désormais
    //    eux aussi distribués (anti-brute-force cohérent multi-réplica).
    //  - `token`   : budget global par jeton d'API (org vs PAT), appliqué par
    //    ApiThrottlerGuard uniquement quand un `Bearer vaks_…` est présent.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const redis = new Redis(cfg.get<string>('redisUrl') ?? 'redis://redis:6379', {
          maxRetriesPerRequest: null,
          lazyConnect: false,
        });
        redis.on('error', (e) => {
          // eslint-disable-next-line no-console
          console.error(`[throttler] redis error: ${e.message}`);
        });
        return {
          throttlers: [
            { name: 'default', ttl: RL.windowMs, limit: RL.ip },
            { name: TOKEN_THROTTLER, ttl: RL.windowMs, limit: RL.pat },
          ],
          storage: new ThrottlerStorageRedisService(redis),
        };
      },
    }),
    CommonModule,
    TenantCryptoModule,
    StorageModule,
    PrismaModule,
    TenancyModule,
    RbacModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    TasksModule,
    DeliverablesModule,
    AgentRunsModule,
    BoardsModule,
    SearchModule,
    LabelsModule,
    TimeEntriesModule,
    CommentsModule,
    ReportsModule,
    DependenciesModule,
    WorkloadModule,
    FinanceModule,
    TimesheetModule,
    DashboardModule,
    ExternalTasksModule,
    TeamsModule,
    HealthModule,
    AdminModule,
    ClientsModule,
    AttachmentsModule,
    HolidaysModule,
    NotificationsModule,
    WebhooksModule,
    OpsModule,
    BrandingModule,
    SkillsModule,
    SkillRequestsModule,
    ApiTokensModule,
    AuditLogsModule,
    SsoModule,
    ScimModule,
    LicensingModule,
    TeamsProvisioningModule,
    SlackProvisioningModule,
    GoogleChatProvisioningModule,
    GoogleDriveProvisioningModule,
    CollabSpacesModule,
    FileSourcesModule,
    TicketingModule,
    AgentsModule,
    CiWebhooksModule,
    AutomationsModule,
    AnnouncementsModule,
    CustomFieldsModule,
    CustomStatusesModule,
    OAuthModule,
    AgentSelfAuthModule,
  ],
  // ApiThrottlerGuard en APP_GUARD : limite globale par IP + budget par jeton
  // d'API, distribué via Redis, plus les @Throttle() par route (ex. /auth/login).
  providers: [{ provide: APP_GUARD, useClass: ApiThrottlerGuard }],
})
export class AppModule implements NestModule {
  // Pose le contexte tenant (mode pooled) avant guards/controllers, sur toutes
  // les routes → tous les accès DB en aval visent la base du tenant.
  configure(consumer: MiddlewareConsumer) {
    // NestJS 11 / Express 5 (path-to-regexp v8) : le wildcard `*` doit être
    // nommé. `{*splat}` matche toutes les routes, racine incluse.
    consumer.apply(TenantMiddleware).forRoutes('{*splat}');
  }
}
