import { Body, Controller, Get, Inject, Put, UseGuards, forwardRef } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AdminSettingsService } from './admin-settings.service';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { PolicyEngineService } from '../agents/policy-engine.service';

/**
 * Sous-ensemble des clés `OrgSetting` mises en cache 30 s par
 * `PolicyEngineService` (cf. `PolicyEngineService.load`). Tenu en synchro
 * manuellement : toute nouvelle clé cachée là-bas doit être ajoutée ici, sinon
 * une écriture via ce chemin générique laisserait l'ancienne policy évaluée
 * jusqu'à expiration naturelle du TTL (audit sécu 2026-08-01, finding #7 —
 * le chemin dédié `PUT /admin/agents/policies` invalide déjà explicitement ;
 * celui-ci est le chemin résiduel non couvert).
 */
const POLICY_CACHE_KEYS = [
  'agents.policies',
  'agents.backpressure.maxPendingReviews',
  'agents.requireRunDeclaration',
  'agents.preauthorizeBudget',
  'agents.executionLeaseMinutes',
  'agents.budgetBreaker',
] as const;

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly svc: AdminSettingsService,
    @Inject(forwardRef(() => PolicyEngineService))
    private readonly policies: PolicyEngineService,
  ) {}

  /**
   * Sous-ensemble *public* des settings org : valeurs nécessaires côté UI
   * à tout utilisateur authentifié (locale, premier jour de la semaine,
   * heures par jour ouvré). Accessible sans permission `org:settings`.
   */
  @Get('public')
  async getPublic(@CurrentUser() user: AuthUser) {
    const [
      locale,
      defaultLanguage,
      enabledLanguages,
      weekStart,
      hoursPerDay,
      skillsMaxLevel,
      skillsSelfEditEnabled,
      skillsLevelScale,
      skillsLevelInputMode,
      fiscalYearStartMonth,
      autoplanConcentration,
      logoUrl,
    ] = await Promise.all([
      this.svc.getDefaultLocale(user.orgId),
      this.svc.getDefaultLanguage(user.orgId),
      this.svc.getEnabledLanguages(user.orgId),
      this.svc.getWeekStart(user.orgId),
      this.svc.getHoursPerDay(user.orgId),
      this.svc.getSkillsMaxLevel(user.orgId),
      this.svc.getSkillsSelfEditEnabled(user.orgId),
      this.svc.getSkillsLevelScale(user.orgId),
      this.svc.getSkillsLevelInputMode(user.orgId),
      this.svc.getFiscalYearStartMonth(user.orgId),
      this.svc.getAutoplanConcentration(user.orgId),
      this.svc.getOrgLogoUrl(user.orgId),
    ]);
    return {
      locale,
      defaultLanguage,
      enabledLanguages,
      weekStart,
      hoursPerDay,
      skillsMaxLevel,
      skillsSelfEditEnabled,
      skillsLevelScale,
      skillsLevelInputMode,
      fiscalYearStartMonth,
      autoplanConcentration,
      logoUrl,
    };
  }

  /**
   * Lit TOUS les settings de l'org (dont SMTP / notif / gouvernance webhooks).
   * Réservé aux admins (`org:manage`) : les membres utilisent `/public` pour le
   * sous-ensemble UI non sensible.
   */
  @Get()
  @RequirePermissions('org:manage')
  getAll(@CurrentUser() user: AuthUser) {
    // getAllForAdmin masque les secrets chiffrés (`…Enc` → booléen `…Set`).
    return this.svc.getAllForAdmin(user.orgId);
  }

  /** Upsert d'un lot de settings. Le body est un objet plat `{ key: value }`. */
  @Put()
  @RequirePermissions('org:manage')
  @SkipAudit() // hook explicite `settings.updated` (avec diff) dans le service
  async putAll(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    const result = await this.svc.upsertMany(user.orgId, body || {}, {
      id: user.userId,
      email: user.email,
    });
    // Défense en profondeur : ce chemin générique peut aussi écrire les clés
    // agents.* (validateAgentSettings les gère déjà) — purger le cache 30 s du
    // moteur de policies pour ne pas laisser une ancienne règle évaluée. Le
    // chemin dédié `PUT /admin/agents/policies` invalide déjà lui-même.
    if (body && POLICY_CACHE_KEYS.some((k) => k in body)) {
      this.policies.invalidate(user.orgId);
    }
    return result;
  }
}
