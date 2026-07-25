import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { TicketProviderRegistry } from './ticket-provider.registry';
import { ProviderContext, ProviderDescriptor } from './ticket-provider.types';

/** Payload create/update — config et secrets séparés (les secrets sont write-only). */
export interface UpsertConnectorDto {
  /** Type de fournisseur (requis à la création) — figé ensuite. */
  source?: string;
  label?: string;
  enabled?: boolean;
  /** Valeurs des champs NON secrets (instanceUrl, tables, baseQuery…). */
  config?: Record<string, unknown>;
  /** Valeurs des champs secrets (password, token…). Vide/absent = inchangé. */
  secrets?: Record<string, string>;
}

/** DTO exposé à l'admin — ne contient JAMAIS de secret en clair. */
export interface ConnectorAdminDto {
  id: string;
  source: string;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Noms des champs secrets actuellement renseignés (valeurs jamais renvoyées). */
  secretsConfigured: string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}

type ConnectorRow = {
  id: string;
  source: string;
  label: string;
  enabled: boolean;
  config: unknown;
  secretEnc: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ConnectorsAdminService {
  private readonly log = new Logger(ConnectorsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly audit: AuditLogService,
    private readonly registry: TicketProviderRegistry,
  ) {}

  /** Catalogue des types de fournisseurs disponibles (pour l'UI). */
  listProviders(): ProviderDescriptor[] {
    return this.registry.list();
  }

  /** Déchiffre le blob de secrets (JSON) ; {} si absent / illisible. */
  private async decryptSecrets(orgId: string, enc: string | null): Promise<Record<string, string>> {
    if (!enc) return {};
    try {
      const json = await this.tenantCrypto.decrypt(orgId, enc);
      const parsed = JSON.parse(json) as Record<string, string>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {}; // clé rotée / blob corrompu → traité comme "non configuré"
    }
  }

  private async configuredSecretKeys(orgId: string, enc: string | null): Promise<string[]> {
    return Object.entries(await this.decryptSecrets(orgId, enc))
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k]) => k);
  }

  private async toDto(orgId: string, r: ConnectorRow): Promise<ConnectorAdminDto> {
    return {
      id: r.id,
      source: r.source,
      label: r.label,
      enabled: r.enabled,
      config: (r.config && typeof r.config === 'object' ? r.config : {}) as Record<string, unknown>,
      secretsConfigured: await this.configuredSecretKeys(orgId, r.secretEnc),
      lastTestAt: r.lastTestAt ? r.lastTestAt.toISOString() : null,
      lastTestOk: r.lastTestOk,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async list(orgId: string): Promise<ConnectorAdminDto[]> {
    const rows = await this.prisma.ticketingConnector.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((r) => this.toDto(orgId, r as ConnectorRow)));
  }

  private descriptorOrThrow(source: string): ProviderDescriptor {
    const provider = this.registry.get(source);
    if (!provider) throw new BadRequestException(`Type de connecteur inconnu : ${source}`);
    return provider.describe();
  }

  /**
   * Vérifie qu'au moment d'une ACTIVATION, tous les champs requis (config +
   * secrets) sont présents — soit fournis, soit déjà stockés.
   */
  private assertActivatable(
    desc: ProviderDescriptor,
    mergedConfig: Record<string, unknown>,
    storedSecretKeys: Set<string>,
  ): void {
    for (const f of desc.fields) {
      if (!f.required) continue;
      if (f.secret) {
        if (!storedSecretKeys.has(f.key)) {
          throw new BadRequestException(`Impossible d'activer : « ${f.label} » requis.`);
        }
      } else {
        const v = mergedConfig[f.key];
        const empty =
          v == null ||
          (typeof v === 'string' && v.trim() === '') ||
          (Array.isArray(v) && v.length === 0);
        if (empty) throw new BadRequestException(`Impossible d'activer : « ${f.label} » requis.`);
      }
    }
  }

  /** Ne garde de `config` que les clés de champs NON secrets connus du provider. */
  private sanitizeConfig(
    desc: ProviderDescriptor,
    config: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!config) return out;
    for (const f of desc.fields) {
      if (f.secret) continue;
      if (config[f.key] !== undefined) out[f.key] = config[f.key];
    }
    // Clé réservée (hors descripteur) : date d'expiration du secret, OPTIONNELLE.
    // Le secret est géré côté tiers (non trackable sinon) ; la renseigner active
    // l'alerte email J-14 (cron notifications). ISO date (`YYYY-MM-DD`).
    if (typeof config.secretExpiresAt === 'string' && config.secretExpiresAt.trim())
      out.secretExpiresAt = config.secretExpiresAt.trim();
    return out;
  }

  async create(
    orgId: string,
    dto: UpsertConnectorDto,
    actor: { id?: string; email?: string },
  ): Promise<ConnectorAdminDto> {
    const source = (dto.source ?? '').trim().toLowerCase();
    if (!source) throw new BadRequestException('source (type de connecteur) requis.');
    const desc = this.descriptorOrThrow(source);

    const dup = await this.prisma.ticketingConnector.findFirst({
      where: { organizationId: orgId, source },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Un connecteur de ce type existe déjà pour cette organisation.');

    const config = this.sanitizeConfig(desc, dto.config);
    // Secrets fournis (non vides) → chiffrés.
    const secrets: Record<string, string> = {};
    for (const f of desc.fields) {
      if (!f.secret) continue;
      const v = dto.secrets?.[f.key]?.trim();
      if (v) secrets[f.key] = v;
    }
    const enabled = dto.enabled ?? false;
    if (enabled) {
      this.assertActivatable(desc, config, new Set(Object.keys(secrets)));
    }

    const secretEnc = Object.keys(secrets).length
      ? await this.tenantCrypto.encrypt(orgId, JSON.stringify(secrets))
      : null;
    const created = await this.prisma.ticketingConnector.create({
      data: {
        organizationId: orgId,
        source,
        label: dto.label?.trim() || desc.label,
        enabled,
        config: config as object,
        secretEnc,
      },
    });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_CREATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'ticketingConnector',
      resourceId: created.id,
      resourceLabel: `${source} (${created.label})`,
      detail: { source, enabled: created.enabled },
    });
    return this.toDto(orgId, created as ConnectorRow);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpsertConnectorDto,
    actor: { id?: string; email?: string },
  ): Promise<ConnectorAdminDto> {
    const existing = (await this.prisma.ticketingConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as ConnectorRow | null;
    if (!existing) throw new NotFoundException('Connecteur introuvable.');
    const desc = this.descriptorOrThrow(existing.source); // source immuable

    // Config fusionnée (champs absents conservés).
    const prevConfig = (existing.config && typeof existing.config === 'object'
      ? existing.config
      : {}) as Record<string, unknown>;
    const mergedConfig =
      dto.config !== undefined
        ? { ...prevConfig, ...this.sanitizeConfig(desc, dto.config) }
        : prevConfig;

    // Secrets fusionnés : on part des existants, on écrase par les non-vides fournis.
    const mergedSecrets = await this.decryptSecrets(orgId, existing.secretEnc);
    if (dto.secrets) {
      for (const f of desc.fields) {
        if (!f.secret) continue;
        const v = dto.secrets[f.key];
        if (typeof v === 'string' && v.trim()) mergedSecrets[f.key] = v.trim();
      }
    }
    const storedSecretKeys = new Set(
      Object.entries(mergedSecrets)
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .map(([k]) => k),
    );

    const enabled = dto.enabled ?? existing.enabled;
    if (enabled) this.assertActivatable(desc, mergedConfig, storedSecretKeys);

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label.trim() || existing.label;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.config !== undefined) data.config = mergedConfig as object;
    if (dto.secrets !== undefined) {
      data.secretEnc = storedSecretKeys.size
        ? await this.tenantCrypto.encrypt(orgId, JSON.stringify(mergedSecrets))
        : null;
    }

    const updated = await this.prisma.ticketingConnector.update({ where: { id }, data });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_UPDATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'ticketingConnector',
      resourceId: id,
      resourceLabel: `${existing.source} (${updated.label})`,
      detail: { enabled: updated.enabled },
    });
    return this.toDto(orgId, updated as ConnectorRow);
  }

  async remove(orgId: string, id: string, actor: { id?: string; email?: string }): Promise<void> {
    const existing = await this.prisma.ticketingConnector.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true, source: true, label: true },
    });
    if (!existing) throw new NotFoundException('Connecteur introuvable.');
    await this.prisma.ticketingConnector.delete({ where: { id } });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_DELETED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'ticketingConnector',
      resourceId: id,
      resourceLabel: `${existing.source} (${existing.label})`,
    });
  }

  /** Résout le contexte fournisseur (config + secrets déchiffrés) d'un connecteur. */
  private async toContext(orgId: string, row: ConnectorRow): Promise<ProviderContext> {
    return {
      config: (row.config && typeof row.config === 'object' ? row.config : {}) as Record<
        string,
        unknown
      >,
      secret: await this.decryptSecrets(orgId, row.secretEnc),
    };
  }

  /**
   * Résout le contexte (config + secrets) d'un connecteur **activé** par source.
   * Retourne `null` si le connecteur est absent ou désactivé.
   * Utilisé par `TicketingSearchService` pour la recherche live.
   */
  async resolveProviderContext(orgId: string, source: string): Promise<ProviderContext | null> {
    const row = await this.prisma.ticketingConnector.findFirst({
      where: { organizationId: orgId, source, enabled: true },
    });
    if (!row) return null;
    return this.toContext(orgId, row as ConnectorRow);
  }

  /** Test de connexion réel — délégué au provider, résultat persisté pour l'UI. */
  async testConnection(orgId: string, id: string) {
    const row = (await this.prisma.ticketingConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as ConnectorRow | null;
    if (!row) throw new NotFoundException('Connecteur introuvable.');
    const provider = this.registry.get(row.source);
    if (!provider) {
      this.log.warn(`[ticketing] testConnection: unknown provider source="${row.source}" (org=${orgId}, connector=${id})`);
      return { ok: false, error: `Type de connecteur inconnu : ${row.source}` };
    }
    const result = await provider.testConnection(await this.toContext(orgId, row));
    if (!result.ok) {
      // Tracé côté serveur : le résultat est aussi renvoyé au client (bouton « Tester »),
      // mais un log persistant permet le diagnostic via les journaux du service `api`.
      this.log.warn(`[ticketing] testConnection failed source="${row.source}" label="${row.label}" (org=${orgId}, connector=${id}): ${result.error ?? 'unknown error'}`);
    } else {
      this.log.log(`[ticketing] testConnection ok source="${row.source}" (org=${orgId}, connector=${id})`);
    }
    await this.prisma.ticketingConnector
      .update({ where: { id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } })
      .catch(() => undefined);
    return result;
  }
}
