import { BadRequestException, Injectable } from '@nestjs/common';
import type { LicenseHistoryRowDto } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LicenseService } from './license.service';

/**
 * Gestion administrative de la licence du tenant : upload (avec validation de
 * signature avant persistance), historique, suppression. Append-only : un
 * upload désactive les lignes précédentes et insère la nouvelle en `active`.
 */
@Injectable()
export class LicenseAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
  ) {}

  /**
   * Valide la signature/claims AVANT de remplacer la licence active. Refuse un
   * token cryptographiquement invalide (≠ comportement runtime permissif : à
   * l'upload, on protège l'admin d'un copier-coller foireux). Une licence déjà
   * expirée mais bien signée est acceptée (l'admin voit l'état « expired »).
   */
  async upload(
    organizationId: string,
    token: string,
    actor: { id: string; email: string },
  ) {
    const trimmed = (token ?? '').trim();
    if (!trimmed) throw new BadRequestException('Token de licence vide.');
    const evaluated = this.licenses.evaluateToken(trimmed);
    if (!evaluated.signatureValid) {
      throw new BadRequestException(
        'Signature de licence invalide — le fichier est corrompu ou émis par une autre clé.',
      );
    }
    const payload = evaluated.payload!;
    // Épinglage à l'installation : une licence portant un `organizationId` ne
    // peut être importée que dans l'install dont le `licenseId` (UUID unique)
    // correspond — anti-réemploi entre deux déploiements, même s'ils partagent
    // le même id d'org (slug / `seed-org`). Comparaison sur licenseId, PAS sur
    // l'id d'org réel (qui, lui, reste la FK d'insertion de la ligne License).
    const licenseId = await this.licenses.currentLicenseId();
    if (payload.organizationId && licenseId && payload.organizationId !== licenseId) {
      throw new BadRequestException(
        `Cette licence est destinée à une autre installation (${payload.organizationId}). ` +
          `Identifiant de cette installation : ${licenseId}.`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.license.updateMany({
        where: { active: true },
        data: { active: false },
      }),
      this.prisma.license.create({
        data: {
          organizationId,
          token: trimmed,
          licenseUuid: payload.sub ?? null,
          customer: evaluated.customer,
          features: evaluated.payload?.features ?? [],
          maxUsers: evaluated.maxUsers,
          issuedAt: evaluated.issuedAt,
          expiresAt: evaluated.expiresAt,
          notes: evaluated.notes,
          signatureValid: true,
          active: true,
          uploadedById: actor.id,
          uploadedByEmail: actor.email,
        },
      }),
    ]);
    this.licenses.invalidate();
    return this.licenses.status();
  }

  /** Historique des uploads (le plus récent d'abord). */
  async history(): Promise<LicenseHistoryRowDto[]> {
    const rows = await this.prisma.license.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        customer: true,
        features: true,
        issuedAt: true,
        expiresAt: true,
        signatureValid: true,
        active: true,
        uploadedByEmail: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      customer: r.customer,
      features: r.features,
      issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      signatureValid: r.signatureValid,
      active: r.active,
      uploadedByEmail: r.uploadedByEmail,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Retire la licence active (revient au core gratuit). N'efface pas l'historique. */
  async clearActive() {
    await this.prisma.license.updateMany({ where: { active: true }, data: { active: false } });
    this.licenses.invalidate();
    return this.licenses.status();
  }
}
