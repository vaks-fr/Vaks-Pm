import { BadRequestException, Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { HolidaysService } from './holidays.service';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@ApiTags('holidays')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller('holidays')
export class HolidaysLookupController {
  constructor(private readonly svc: HolidaysService) {}

  /**
   * Lookup fériés pour un pays + plage. Accessible à tout membre (`project:view`)
   * pour permettre aux vues task/timeline d'avertir quand une date tombe sur un
   * férié. Si `country` est omis → pays par défaut de l'org.
   */
  @Get()
  @RequirePermissions('project:view')
  async lookup(
    @CurrentUser() user: AuthUser,
    @Query('country') country: string | undefined,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!ISO_DATE_RE.test(from || '') || !ISO_DATE_RE.test(to || '')) {
      throw new BadRequestException('from/to must be ISO YYYY-MM-DD');
    }
    const cc = (country?.trim() || (await this.svc.getDefaultCountry(user.orgId))).toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) {
      throw new BadRequestException('Invalid country code');
    }
    return { country: cc, from, to, holidays: this.svc.forCountryRange(cc, from, to) };
  }

  /** Pays par défaut de l'org — exposé en lecture à tous les membres. */
  @Get('default-country')
  @RequirePermissions('project:view')
  async getDefault(@CurrentUser() user: AuthUser) {
    return { country: await this.svc.getDefaultCountry(user.orgId) };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/holidays')
export class HolidaysController {
  constructor(private readonly svc: HolidaysService) {}

  /** Liste des pays supportés (ISO alpha-2 + nom). Accessible à tout admin. */
  @Get('countries')
  @RequirePermissions('org:manage')
  countries() {
    return { countries: this.svc.listCountries() };
  }

  /** Pays par défaut de l'org (lecture). */
  @Get('default')
  @RequirePermissions('org:manage')
  async getDefault(@CurrentUser() user: AuthUser) {
    return { country: await this.svc.getDefaultCountry(user.orgId) };
  }

  /** Définit le pays par défaut de l'org. */
  @Put('default')
  @RequirePermissions('org:manage')
  async setDefault(
    @CurrentUser() user: AuthUser,
    @Body() body: { country?: string },
  ) {
    const country = await this.svc.setDefaultCountry(
      user.orgId,
      body?.country || '',
    );
    return { country };
  }

  /**
   * Prévisualise les jours fériés (lecture seule). Utile pour valider le
   * choix d'un pays dans l'admin. Si `country` est omis → utilise le défaut org.
   * Si `from`/`to` sont omis → renvoie l'année courante.
   */
  @Get('preview')
  @RequirePermissions('org:manage')
  async preview(
    @CurrentUser() user: AuthUser,
    @Query('country') country?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const cc = (country || (await this.svc.getDefaultCountry(user.orgId))).toUpperCase();
    const now = new Date();
    const fromIso = from || `${now.getUTCFullYear()}-01-01`;
    const toIso = to || `${now.getUTCFullYear()}-12-31`;
    const holidays = this.svc.forCountryRange(cc, fromIso, toIso);
    return { country: cc, from: fromIso, to: toIso, holidays };
  }
}
