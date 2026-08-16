import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { S3Service } from '../storage/s3.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';

const LOGO_MAX_BYTES = 1 * 1024 * 1024; // 1 MB — largement assez pour un logo PNG/SVG
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
  'image/gif',
]);

/**
 * Branding (logos org, à terme : favicons, palettes, etc.). Deux familles
 * d'endpoints :
 *   - `/admin/branding/*` (admin uniquement) : upload/delete
 *   - `/public/branding/*` (sans auth) : lecture publique pour le sidebar et
 *     surtout les emails sortants (les clients mail ne savent pas faire un
 *     bearer token).
 *
 * Le contenu est stocké dans MinIO bucket `branding`, clé fixe par org+asset
 * (un seul logo par org pour l'instant). L'URL servie est sous `APP_URL` et
 * sauvée dans `OrgSetting.org.logoUrl` — donc tous les consumers (sidebar,
 * email templates) lisent la même valeur.
 */
@ApiTags('branding')
@Controller()
export class BrandingController {
  constructor(
    private readonly s3: S3Service,
    private readonly settings: AdminSettingsService,
    private readonly prisma: PrismaService,
    private readonly tenantUrl: TenantUrlService,
  ) {}

  // ============================================================
  // Admin endpoints
  // ============================================================

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('org:manage')
  @Post('admin/branding/org-logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES } }))
  async uploadOrgLogo(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported mime ${file.mimetype} — allowed: PNG, JPEG, SVG, WebP, GIF`,
      );
    }
    const ext = extFromMime(file.mimetype);
    const key = `org/${user.orgId}/logo.${ext}`;
    await this.s3.putObject(this.s3.buckets.branding, key, file.buffer, file.mimetype);

    // URL servie publiquement par l'API. APP_URL doit pointer vers le host
    // joignable par les destinataires email (sinon le `<img>` ne s'affichera
    // pas dans Outlook/Gmail). On embarque l'extension dans l'URL pour que
    // le navigateur/le client mail détermine le bon Content-Type sans HEAD.
    // Origine DU TENANT (le logo est référencé en <img> dans les emails : il
    // doit pointer vers le host que les destinataires peuvent joindre).
    const base = this.tenantUrl.publicBaseUrl();
    const url = `${base}/api/v1/public/branding/org-logo.${ext}?v=${Date.now()}`;

    // On stocke aussi le mime et la clé interne, pour pouvoir nettoyer / changer
    // d'extension proprement plus tard.
    await this.settings.upsertMany(user.orgId, {
      'org.logoUrl': url,
      'org.logoKey': key,
      'org.logoMime': file.mimetype,
    });

    return { url, mime: file.mimetype, sizeBytes: file.size };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('org:manage')
  @Delete('admin/branding/org-logo')
  async removeOrgLogo(@CurrentUser() user: AuthUser) {
    const all = await this.settings.getAll(user.orgId);
    const key = typeof all['org.logoKey'] === 'string' ? (all['org.logoKey'] as string) : null;
    if (key) {
      try {
        await this.s3.removeObject(this.s3.buckets.branding, key);
      } catch {
        // Le blob n'existait peut-être déjà plus — on tolère pour réussir la suppression UI.
      }
    }
    await this.settings.upsertMany(user.orgId, {
      'org.logoUrl': '',
      'org.logoKey': '',
      'org.logoMime': '',
    });
    return { ok: true };
  }

  // ============================================================
  // Public endpoint (no auth)
  // ============================================================

  /**
   * Sert le logo de l'org. Pas de JWT — accessible directement par les
   * clients mail. L'extension dans le path est cosmétique ; la résolution
   * de la clé MinIO se fait via `org.logoKey` sauvé dans les settings.
   *
   * Mono-tenant pour l'instant : on prend la seule org. Quand on passera
   * multi-tenant on routera via subdomain/header.
   */
  @Get('public/branding/org-logo.:ext')
  async getOrgLogo(@Res() res: Response) {
    const orgId = await this.firstOrgId();
    if (!orgId) throw new NotFoundException();
    const all = await this.settings.getAll(orgId);
    const key = typeof all['org.logoKey'] === 'string' ? (all['org.logoKey'] as string) : null;
    const mime = typeof all['org.logoMime'] === 'string' ? (all['org.logoMime'] as string) : 'image/png';
    if (!key) throw new NotFoundException();

    let buf: Buffer;
    try {
      buf = await this.s3.getObjectBuffer(this.s3.buckets.branding, key);
    } catch {
      throw new HttpException('Logo missing in storage', HttpStatus.NOT_FOUND);
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Length', String(buf.length));
    // SÉCURITÉ — Un logo SVG peut contenir <script> qui s'exécute si l'URL est
    // ouverte directement (XSS stockée sur l'origine de l'app). `nosniff` + une
    // CSP `sandbox` sans script neutralisent l'exécution tout en laissant le
    // rendu en <img> (emails/sidebar) intact — un SVG embarqué via <img>
    // n'exécute jamais de script de toute façon.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(buf);
  }

  /**
   * Nom d'affichage de l'organisation — PUBLIC (pas de JWT) pour l'écran de
   * login. Multi-tenant : le middleware a routé la connexion vers la base du
   * tenant (par Host), donc `firstOrgId` = l'org du tenant. Priorité au setting
   * éditable `orgName`, fallback `Organization.name`.
   */
  @Get('public/branding/org')
  async getPublicOrg(): Promise<{ name: string; logoUrl: string }> {
    const orgId = await this.firstOrgId();
    if (!orgId) throw new NotFoundException();
    const all = await this.settings.getAll(orgId);
    // Logo custom (chaîne vide si non configuré → l'UI de login retombe sur le
    // BrandMark Vaks). Public pour être lisible avant authentification.
    const logoUrl =
      typeof all['org.logoUrl'] === 'string' ? (all['org.logoUrl'] as string).trim() : '';
    const setting =
      typeof all['orgName'] === 'string' && all['orgName'].trim()
        ? (all['orgName'] as string).trim()
        : null;
    if (setting) return { name: setting, logoUrl };
    const org = await this.prisma.organization.findFirst({
      where: { id: orgId },
      select: { name: true },
    });
    return { name: org?.name ?? 'Vaks', logoUrl };
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private async firstOrgId(): Promise<string | null> {
    // Mono-tenant : on retourne la seule org existante. Quand on passera
    // multi-tenant (subdomain ou header), on déduira l'org du request.
    const row = await this.prisma.organization.findFirst({ select: { id: true } });
    return row?.id ?? null;
  }
}

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/svg+xml': return 'svg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'bin';
  }
}
