import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { sendCsv } from '../common/csv.util';
import { ClientsService } from './clients.service';
import {
  CreateClientDto,
  CreateContactDto,
  ImportClientsDto,
  ListClientsDto,
  UpdateClientDto,
  UpdateContactDto,
} from './dto/client.dto';

@ApiTags('clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @RequirePermissions('client:view')
  list(@CurrentUser() user: AuthUser, @Query() query: ListClientsDto) {
    return this.clients.list(user.orgId, query);
  }

  // NB : déclaré avant `:clientId` pour ne pas être avalé par le ParseUUIDPipe.
  @Get('export.csv')
  @RequirePermissions('client:view')
  async exportCsv(@CurrentUser() user: AuthUser, @Res() res: Response) {
    sendCsv(res, 'clients.csv', await this.clients.exportCsv(user.orgId));
  }

  @Get('contacts/export.csv')
  @RequirePermissions('client:view')
  async exportContactsCsv(@CurrentUser() user: AuthUser, @Res() res: Response) {
    sendCsv(res, 'contacts.csv', await this.clients.exportContactsCsv(user.orgId));
  }

  /** Import CSV de clients (upsert par nom). Body JSON `{ csv: "..." }`. */
  @Post('import')
  @RequirePermissions('client:manage')
  importCsv(@CurrentUser() user: AuthUser, @Body() dto: ImportClientsDto) {
    return this.clients.importCsv(user.orgId, dto.csv);
  }

  @Get(':clientId')
  @RequirePermissions('client:view')
  get(@CurrentUser() user: AuthUser, @Param('clientId', ParseUUIDPipe) clientId: string) {
    return this.clients.get(user.orgId, clientId);
  }

  @Post()
  @RequirePermissions('client:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateClientDto) {
    return this.clients.create(user.orgId, dto);
  }

  @Patch(':clientId')
  @RequirePermissions('client:manage')
  update(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.clients.update(user.orgId, clientId, dto);
  }

  @Delete(':clientId')
  @RequirePermissions('client:manage')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ) {
    return this.clients.remove(user.orgId, clientId);
  }

  /**
   * **RGPD** — blanchit les coordonnées PII du client (email/tel/adresse/notes),
   * conserve le nom du compte. Pseudonymisation, aucune suppression. Audité.
   */
  @Post(':clientId/anonymize')
  @RequirePermissions('client:manage')
  anonymize(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ) {
    return this.clients.anonymizeClient(user.orgId, clientId, {
      id: user.userId,
      email: user.email,
    });
  }

  // ---- Contacts ----

  @Get(':clientId/contacts')
  @RequirePermissions('client:view')
  listContacts(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ) {
    return this.clients.listContacts(user.orgId, clientId);
  }

  @Post(':clientId/contacts')
  @RequirePermissions('client:manage')
  createContact(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() dto: CreateContactDto,
  ) {
    return this.clients.createContact(user.orgId, clientId, dto);
  }

  @Patch(':clientId/contacts/:contactId')
  @RequirePermissions('client:manage')
  updateContact(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.clients.updateContact(user.orgId, clientId, contactId, dto);
  }

  @Delete(':clientId/contacts/:contactId')
  @RequirePermissions('client:manage')
  removeContact(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    return this.clients.removeContact(user.orgId, clientId, contactId);
  }

  /**
   * **RGPD** — anonymise complètement un contact (personne) : nom pseudonymisé,
   * coordonnées nullées, soft-delete. Aucune suppression de ligne. Audité.
   */
  @Post(':clientId/contacts/:contactId/anonymize')
  @RequirePermissions('client:manage')
  anonymizeContact(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    return this.clients.anonymizeContact(user.orgId, clientId, contactId, {
      id: user.userId,
      email: user.email,
    });
  }
}
