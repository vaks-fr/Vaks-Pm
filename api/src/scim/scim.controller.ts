import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { ScimAuthGuard } from './scim-auth.guard';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { ScimContentTypeInterceptor, ScimExceptionFilter } from './scim-exception.filter';
import { ScimService } from './scim.service';
import {
  SCIM_SCHEMA_ENTERPRISE,
  SCIM_SCHEMA_GROUP,
  SCIM_SCHEMA_USER,
  scimList,
  ScimGroupWrite,
  ScimPatchOp,
  ScimUserWrite,
} from './scim.types';

/**
 * Surface SCIM 2.0 (RFC 7644) — provisioning/déprovisioning depuis l'IdP (Entra).
 * Auth par **clé organisation** scopée `scim:provision` (pas de session JWT).
 * App-privé / hors OpenAPI public. Tenant résolu par Host (pooled).
 */
@ApiExcludeController()
@SkipAudit() // les écritures SCIM sont tracées explicitement par ScimService
// Premium : SCIM exige la feature `scim` (licence active/grace). Le
// LicenseFeatureGuard tourne après ScimAuthGuard (tenant déjà résolu par Host).
@RequiresFeature('scim')
@UseGuards(ScimAuthGuard, LicenseFeatureGuard)
@UseFilters(ScimExceptionFilter)
@UseInterceptors(ScimContentTypeInterceptor)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  private baseUrl(req: Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'https';
    return `${proto}://${req.headers.host}/api/v1/scim/v2`;
  }

  private actor(user: AuthUser) {
    return { orgId: user.orgId, userId: user.userId };
  }

  // -------------------- Discovery --------------------

  @Get('ServiceProviderConfig')
  serviceProviderConfig(@Req() req: Request) {
    const base = this.baseUrl(req);
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: `${base}`,
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authentication via the SCIM bearer token (org API key, scope scim:provision).',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
    };
  }

  @Get('ResourceTypes')
  resourceTypes(@Req() req: Request) {
    const base = this.baseUrl(req);
    return scimList(
      [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: SCIM_SCHEMA_USER,
          meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: SCIM_SCHEMA_GROUP,
          meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
        },
      ],
      2,
      1,
    );
  }

  @Get('Schemas')
  schemas() {
    return scimList(
      [
        {
          id: SCIM_SCHEMA_USER,
          name: 'User',
          description: 'User Account',
          attributes: [
            { name: 'userName', type: 'string', required: true, uniqueness: 'server' },
            { name: 'name', type: 'complex', required: false },
            { name: 'displayName', type: 'string', required: false },
            { name: 'emails', type: 'complex', multiValued: true, required: false },
            { name: 'active', type: 'boolean', required: false },
            { name: 'externalId', type: 'string', required: false },
          ],
          meta: { resourceType: 'Schema' },
        },
        {
          id: SCIM_SCHEMA_GROUP,
          name: 'Group',
          description: 'Group',
          attributes: [
            { name: 'displayName', type: 'string', required: true, uniqueness: 'server' },
            { name: 'members', type: 'complex', multiValued: true, required: false },
            { name: 'externalId', type: 'string', required: false },
          ],
          meta: { resourceType: 'Schema' },
        },
        {
          id: SCIM_SCHEMA_ENTERPRISE,
          name: 'EnterpriseUser',
          description: 'Enterprise User extension (employeeNumber → employeeId)',
          attributes: [
            { name: 'employeeNumber', type: 'string', required: false },
          ],
          meta: { resourceType: 'Schema' },
        },
      ],
      3,
      1,
    );
  }

  // -------------------- Users --------------------

  @Get('Users')
  async listUsers(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const si = Math.max(1, parseInt(startIndex ?? '1', 10) || 1);
    const ct = Math.max(0, parseInt(count ?? '100', 10) || 100);
    const { resources, total } = await this.scim.list(user.orgId, filter, si, ct, this.baseUrl(req));
    return scimList(resources, total, si);
  }

  @Get('Users/:id')
  getUser(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.scim.get(user.orgId, id, this.baseUrl(req));
  }

  @Post('Users')
  @HttpCode(201)
  createUser(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: ScimUserWrite) {
    return this.scim.create(this.actor(user), body, this.baseUrl(req));
  }

  @Put('Users/:id')
  replaceUser(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ScimUserWrite,
  ) {
    return this.scim.replace(this.actor(user), id, body, this.baseUrl(req));
  }

  @Patch('Users/:id')
  patchUser(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ScimPatchOp,
  ) {
    return this.scim.patch(this.actor(user), id, body.Operations, this.baseUrl(req));
  }

  @Delete('Users/:id')
  @HttpCode(204)
  async deleteUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.scim.remove(this.actor(user), id);
  }

  // -------------------- Groups (→ Teams) --------------------

  @Get('Groups')
  async listGroups(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    const si = Math.max(1, parseInt(startIndex ?? '1', 10) || 1);
    const ct = Math.max(0, parseInt(count ?? '100', 10) || 100);
    const { resources, total } = await this.scim.listGroups(user.orgId, filter, si, ct, this.baseUrl(req));
    return scimList(resources, total, si);
  }

  @Get('Groups/:id')
  getGroup(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.scim.getGroup(user.orgId, id, this.baseUrl(req));
  }

  @Post('Groups')
  @HttpCode(201)
  createGroup(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: ScimGroupWrite) {
    return this.scim.createGroup(this.actor(user), body, this.baseUrl(req));
  }

  @Put('Groups/:id')
  replaceGroup(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ScimGroupWrite,
  ) {
    return this.scim.replaceGroup(this.actor(user), id, body, this.baseUrl(req));
  }

  @Patch('Groups/:id')
  patchGroup(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ScimPatchOp,
  ) {
    return this.scim.patchGroup(this.actor(user), id, body.Operations, this.baseUrl(req));
  }

  @Delete('Groups/:id')
  @HttpCode(204)
  async deleteGroup(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.scim.removeGroup(this.actor(user), id);
  }
}
