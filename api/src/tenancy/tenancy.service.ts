import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export type DeploymentMode = 'dedicated' | 'pooled';

/** Org résolue pour une requête (multi-tenant). */
export interface ResolvedTenant {
  id: string;
  slug: string | null;
}

/**
 * Résolution du tenant (organisation) pour le SaaS multi-tenant.
 *
 * - `dedicated` (défaut) : on-premise / cellule, 1 tenant par instance.
 *   `resolveFromHost` renvoie toujours `null` → le login reste global (par
 *   email), comportement historique inchangé.
 * - `pooled` : l'org est déduite du `Host` de la requête, soit par domaine
 *   custom exact (`Organization.primaryDomain`), soit par sous-domaine
 *   `<slug>.<baseDomain>` (`Organization.slug`).
 */
@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get mode(): DeploymentMode {
    return this.config.get('deployment').mode;
  }

  get baseDomain(): string {
    return this.config.get('deployment').baseDomain;
  }

  /** Map domaine custom → slug (statique, par config). */
  private get customDomains(): Record<string, string> {
    return this.config.get('deployment').customDomains ?? {};
  }

  /** Domaines de base des serveurs MCP publics (`<slug>.<mcpDomain>`). */
  private get mcpDomains(): string[] {
    return this.config.get('deployment').mcpDomains ?? [];
  }

  /** Normalise un Host : minuscule, sans port. */
  private normalizeHost(host?: string): string | null {
    if (!host) return null;
    const h = host.toLowerCase().split(':')[0].trim();
    return h || null;
  }

  /** Extrait le premier label d'un Host sous `base` (`<label>.….<base>`). */
  private labelUnder(host: string, base: string): string | null {
    if (!base || !host.endsWith(`.${base}`)) return null;
    const sub = host.slice(0, host.length - base.length - 1);
    const label = sub.split('.')[0];
    if (!label || label === 'www') return null;
    return label;
  }

  /** Extrait le slug d'un Host `<slug>.<baseDomain>` (ignore `www` et l'apex). */
  private slugFromHost(host: string): string | null {
    return this.labelUnder(host, this.baseDomain);
  }

  /**
   * Slug depuis un Host servi par un serveur MCP public (`<slug>.<mcpDomain>`).
   * Le premier label EST le slug : une seule entrée de config couvre tous les
   * tenants. Utilisé quand le domaine public du MCP diffère du domaine interne.
   */
  private slugFromMcpHost(host: string): string | null {
    for (const d of this.mcpDomains) {
      const label = this.labelUnder(host, d);
      if (label) return label;
    }
    return null;
  }

  /**
   * Résout le tenant depuis le Host. `null` en mode `dedicated`, ou si le Host
   * ne porte pas de sous-domaine tenant (apex / `www`).
   *
   * Modèle DB-par-tenant : la résolution est **par convention** (le slug du
   * sous-domaine = le tenant ; sa base = `<db>_<slug>`), sans lookup d'annuaire
   * partagé. L'existence réelle du tenant = l'existence de sa base (provisionnée
   * à l'onboarding) ; une base absente fera échouer la requête.
   */
  async resolveFromHost(host?: string): Promise<ResolvedTenant | null> {
    if (this.mode !== 'pooled') return null;
    const h = this.normalizeHost(host);
    if (!h) return null;
    // 1) Domaine custom mappé explicitement (ex. vaks-pm.vaks.fr → vaks).
    const custom = this.customDomains[h];
    if (custom) return { id: custom, slug: custom };
    // 2) Sous-domaine `<slug>.<baseDomain>`.
    const slug = this.slugFromHost(h);
    if (slug) return { id: slug, slug };
    // 3) Domaine public d'un serveur MCP (`<slug>.<mcpDomain>`). Couvre le MCP
    //    en DMZ dont le domaine diffère de l'interne : le Host public est relayé
    //    tel quel par le MCP, on résout le slug sur son premier label.
    const mcpSlug = this.slugFromMcpHost(h);
    if (mcpSlug) return { id: mcpSlug, slug: mcpSlug };
    return null;
  }
}
