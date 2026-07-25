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
import { TenantUrlService } from '../tenancy/tenant-url.service';
import { generateWifKeypair } from '../google-chat-provisioning/google-token-provider';
import { FileSourceProviderRegistry } from './file-source-provider.registry';
import { ProviderDescriptor } from './file-source-provider.types';

/** Payload create/update — config et secrets séparés (secrets write-only). */
export interface UpsertFileSourceDto {
  source?: string;
  label?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

/** DTO exposé à l'admin — jamais de secret en clair. */
export interface FileSourceAdminDto {
  id: string;
  source: string;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsConfigured: string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}

type Row = {
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

/**
 * CRUD des connecteurs de sources de fichiers (google-drive, s3, webdav…). Même
 * pattern que `ConnectorsAdminService` (ticketing) : config non-secrète + secrets
 * chiffrés at-rest par tenant, secrets write-only. La source `sharepoint` n'a pas
 * de connecteur ici (identité via provisioning Teams) — elle n'apparaît que dans
 * la liste des providers (`listProviders`), jamais dans les rows.
 */
@Injectable()
export class ConnectorsFileSourceAdminService {
  private readonly log = new Logger(ConnectorsFileSourceAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly audit: AuditLogService,
    private readonly registry: FileSourceProviderRegistry,
    private readonly tenantUrl: TenantUrlService,
  ) {}

  listProviders(): ProviderDescriptor[] {
    return this.registry.list();
  }

  private async decryptSecrets(orgId: string, enc: string | null): Promise<Record<string, string>> {
    if (!enc) return {};
    try {
      const parsed = JSON.parse(await this.tenantCrypto.decrypt(orgId, enc)) as Record<string, string>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async configuredSecretKeys(orgId: string, enc: string | null): Promise<string[]> {
    return Object.entries(await this.decryptSecrets(orgId, enc))
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k]) => k);
  }

  private async toDto(orgId: string, r: Row): Promise<FileSourceAdminDto> {
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

  async list(orgId: string): Promise<FileSourceAdminDto[]> {
    const rows = await this.prisma.fileSourceConnector.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((r) => this.toDto(orgId, r as Row)));
  }

  private descriptorOrThrow(source: string): ProviderDescriptor {
    const provider = this.registry.get(source);
    if (!provider) throw new BadRequestException(`Type de source inconnu : ${source}`);
    return provider.describe();
  }

  private assertNotManagedElsewhere(desc: ProviderDescriptor): void {
    if (desc.managedElsewhere) {
      throw new BadRequestException(
        `La source « ${desc.label} » se configure ailleurs (identité de provisioning) — pas de connecteur.`,
      );
    }
  }

  private assertActivatable(
    desc: ProviderDescriptor,
    mergedConfig: Record<string, unknown>,
    storedSecretKeys: Set<string>,
  ): void {
    for (const f of desc.fields) {
      if (!f.required) continue;
      if (f.secret) {
        if (!storedSecretKeys.has(f.key)) throw new BadRequestException(`Impossible d'activer : « ${f.label} » requis.`);
      } else {
        const v = mergedConfig[f.key];
        const empty =
          v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
        if (empty) throw new BadRequestException(`Impossible d'activer : « ${f.label} » requis.`);
      }
    }
  }

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
    // Renseignée → alerte email J-14 (cron notifications). ISO date (`YYYY-MM-DD`).
    if (typeof config.secretExpiresAt === 'string' && config.secretExpiresAt.trim())
      out.secretExpiresAt = config.secretExpiresAt.trim();
    return out;
  }

  async create(
    orgId: string,
    dto: UpsertFileSourceDto,
    actor: { id?: string; email?: string },
  ): Promise<FileSourceAdminDto> {
    const source = (dto.source ?? '').trim().toLowerCase();
    if (!source) throw new BadRequestException('source (type de connecteur) requis.');
    const desc = this.descriptorOrThrow(source);
    this.assertNotManagedElsewhere(desc);

    const dup = await this.prisma.fileSourceConnector.findFirst({
      where: { organizationId: orgId, source },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Un connecteur de ce type existe déjà pour cette organisation.');

    const config = this.sanitizeConfig(desc, dto.config);
    const secrets: Record<string, string> = {};
    for (const f of desc.fields) {
      if (!f.secret) continue;
      const v = dto.secrets?.[f.key]?.trim();
      if (v) secrets[f.key] = v;
    }
    const enabled = dto.enabled ?? false;
    if (enabled) this.assertActivatable(desc, config, new Set(Object.keys(secrets)));

    const secretEnc = Object.keys(secrets).length
      ? await this.tenantCrypto.encrypt(orgId, JSON.stringify(secrets))
      : null;
    const created = await this.prisma.fileSourceConnector.create({
      data: { organizationId: orgId, source, label: dto.label?.trim() || desc.label, enabled, config: config as object, secretEnc },
    });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_CREATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'fileSourceConnector',
      resourceId: created.id,
      resourceLabel: `${source} (${created.label})`,
      detail: { source, enabled: created.enabled },
    });
    return this.toDto(orgId, created as Row);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpsertFileSourceDto,
    actor: { id?: string; email?: string },
  ): Promise<FileSourceAdminDto> {
    const existing = (await this.prisma.fileSourceConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as Row | null;
    if (!existing) throw new NotFoundException('Connecteur introuvable.');
    const desc = this.descriptorOrThrow(existing.source);

    const prevConfig = (existing.config && typeof existing.config === 'object' ? existing.config : {}) as Record<
      string,
      unknown
    >;
    const mergedConfig =
      dto.config !== undefined ? { ...prevConfig, ...this.sanitizeConfig(desc, dto.config) } : prevConfig;

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

    const updated = await this.prisma.fileSourceConnector.update({ where: { id }, data });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_UPDATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'fileSourceConnector',
      resourceId: id,
      resourceLabel: `${existing.source} (${updated.label})`,
      detail: { enabled: updated.enabled },
    });
    return this.toDto(orgId, updated as Row);
  }

  async remove(orgId: string, id: string, actor: { id?: string; email?: string }): Promise<void> {
    const existing = await this.prisma.fileSourceConnector.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true, source: true, label: true },
    });
    if (!existing) throw new NotFoundException('Connecteur introuvable.');
    await this.prisma.fileSourceConnector.delete({ where: { id } });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_DELETED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'fileSourceConnector',
      resourceId: id,
      resourceLabel: `${existing.source} (${existing.label})`,
    });
  }

  /**
   * Test d'un connecteur (bouton « Tester ») : résout config+secrets, appelle
   * `provider.testConnection` avec un contexte org-level (pas de projet), et
   * persiste `lastTestAt`/`lastTestOk`. Les providers `managedElsewhere`
   * (SharePoint) ont leur propre test projet-scopé.
   */
  async testConnector(
    orgId: string,
    id: string,
  ): Promise<{ ok: boolean; detail?: string; error?: string }> {
    const row = (await this.prisma.fileSourceConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as Row | null;
    if (!row) throw new NotFoundException('Connecteur introuvable.');
    const provider = this.registry.get(row.source);
    if (!provider) throw new BadRequestException(`Type de source inconnu : ${row.source}`);

    const config = (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>;
    const secret = await this.decryptSecrets(orgId, row.secretEnc);
    let result: { ok: boolean; detail?: string; error?: string };
    try {
      result = await provider.testConnection({ orgId, projectId: '', config, secret });
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }
    await this.prisma.fileSourceConnector
      .update({ where: { id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } })
      .catch(() => undefined);
    return result;
  }

  /**
   * Génère (ou régénère) la paire de clés RS256 du mode WIF pour un connecteur.
   * Persiste la clé privée chiffrée dans le secret `wifSigningKey` du connecteur,
   * stocke `wifKeyId`/`wifIssuer`/`wifJwksPublic` dans sa config, et renvoie le
   * JWKS public + issuer à coller côté Google (config du pool WIF). Régénérer
   * invalide l'ancienne clé — le JWKS côté Google doit être mis à jour.
   */
  async generateWifKey(
    orgId: string,
    id: string,
    actor: { id?: string; email?: string },
  ): Promise<{ keyId: string; jwks: unknown; issuer: string }> {
    const row = (await this.prisma.fileSourceConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as Row | null;
    if (!row) throw new NotFoundException('Connecteur introuvable.');

    const { privateKeyPem, keyId, jwks } = await generateWifKeypair();
    // Issuer = origine réelle du tenant (host unique, résolvable), auto-documenté
    // côté Google. Google ne le résout pas (JWKS collé) mais exige que `iss` matche.
    const issuer = `${this.tenantUrl.publicBaseUrl()}/federation/gdrive`;

    const secrets = await this.decryptSecrets(orgId, row.secretEnc);
    secrets.wifSigningKey = privateKeyPem;
    const secretEnc = await this.tenantCrypto.encrypt(orgId, JSON.stringify(secrets));

    const config = (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>;
    config.wifKeyId = keyId;
    config.wifIssuer = issuer;
    config.wifJwksPublic = JSON.stringify(jwks);

    await this.prisma.fileSourceConnector.update({ where: { id }, data: { secretEnc, config: config as object } });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_UPDATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'fileSourceConnector',
      resourceId: id,
      resourceLabel: `${row.source} (${row.label})`,
      detail: { wifKeyRotated: true, keyId },
    });
    return { keyId, jwks, issuer };
  }

  /** Résout config + secrets déchiffrés d'un connecteur activé (usage live). */
  async resolveProviderContext(
    orgId: string,
    source: string,
  ): Promise<{ config: Record<string, unknown>; secret: Record<string, string> } | null> {
    const row = (await this.prisma.fileSourceConnector.findFirst({
      where: { organizationId: orgId, source, enabled: true },
    })) as Row | null;
    if (!row) return null;
    return {
      config: (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>,
      secret: await this.decryptSecrets(orgId, row.secretEnc),
    };
  }
}
