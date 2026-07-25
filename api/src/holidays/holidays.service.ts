import { Injectable } from '@nestjs/common';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { PrismaService } from '../prisma/prisma.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Holidays = require('date-holidays');

interface HdEntry {
  date: string;
  name: string;
  type: string;
}

export interface CountryInfo {
  code: string;
  name: string;
}

/**
 * Service jours fériés. Source : librairie `date-holidays` (couvre ~140 pays,
 * intègre les algos pascaux et les dates fixes nationales). On résout par
 * (countryCode, year) avec cache mémoire. Pas de stockage des dates en DB
 * pour l'instant — la lib est la source de vérité. Le seul stockage côté
 * org est :
 *   - OrgSetting `holidays.defaultCountry` (string ISO 3166-1 alpha-2)
 *   - User.countryCode (override par utilisateur)
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  private cache = new Map<string, Map<string, string>>();

  /** Liste des pays supportés par la lib, triés par nom. */
  listCountries(): CountryInfo[] {
    const hd = new Holidays();
    const countries = hd.getCountries() as Record<string, string>;
    return Object.entries(countries)
      .map(([code, name]) => ({ code, name: String(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Récupère le pays par défaut de l'organisation (ou 'FR' faute de config). */
  async getDefaultCountry(orgId: string): Promise<string> {
    const all = await this.settings.getAll(orgId);
    const v = all['holidays.defaultCountry'];
    if (typeof v === 'string' && /^[A-Z]{2}$/i.test(v)) {
      return v.toUpperCase();
    }
    return 'FR';
  }

  /** Définit le pays par défaut org-wide. */
  async setDefaultCountry(orgId: string, code: string): Promise<string> {
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(clean)) {
      throw new Error('Invalid country code (expected ISO 3166-1 alpha-2)');
    }
    await this.settings.upsertMany(orgId, {
      'holidays.defaultCountry': clean,
    });
    return clean;
  }

  /**
   * Retourne une map `date(iso yyyy-mm-dd) → libellé` pour un pays/année donnés.
   * On exclut les jours "observance" (purement informatifs) et on garde public,
   * bank et school car ce qui compte c'est ce qui ferme l'entreprise.
   * Pour simplifier : seuls les types "public" sont retournés (jour férié légal).
   */
  forCountryYear(country: string, year: number): Map<string, string> {
    const key = `${country}-${year}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const hd = new Holidays(country);
    const raw = (hd.getHolidays(year) || []) as HdEntry[];
    const out = new Map<string, string>();
    for (const h of raw) {
      if (h.type !== 'public') continue; // ignore bank/school/observance
      // h.date peut être "2026-05-01 00:00:00" → normaliser sur YYYY-MM-DD.
      const iso = String(h.date).slice(0, 10);
      out.set(iso, h.name);
    }
    this.cache.set(key, out);
    return out;
  }

  /**
   * Pour une plage [from,to] et un pays, renvoie les fériés.
   * Étend automatiquement à toutes les années couvertes.
   */
  forCountryRange(
    country: string,
    fromIso: string,
    toIso: string,
  ): { date: string; name: string }[] {
    const y1 = parseInt(fromIso.slice(0, 4), 10);
    const y2 = parseInt(toIso.slice(0, 4), 10);
    const out: { date: string; name: string }[] = [];
    for (let y = y1; y <= y2; y++) {
      const m = this.forCountryYear(country, y);
      for (const [date, name] of m) {
        if (date >= fromIso && date <= toIso) out.push({ date, name });
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  /**
   * Map { userId → countryCode résolu } pour une org : on lit User.countryCode
   * et on fallback sur le défaut org si null.
   */
  async resolveUserCountries(
    orgId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const def = await this.getDefaultCountry(orgId);
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds }, organizationId: orgId },
      select: { id: true, countryCode: true },
    });
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.id, (r.countryCode || def).toUpperCase());
    // Anyone missing (shouldn't happen but defensive) gets the default.
    for (const id of userIds) if (!m.has(id)) m.set(id, def);
    return m;
  }
}
