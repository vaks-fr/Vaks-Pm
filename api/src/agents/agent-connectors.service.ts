import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AgentConnectorDto, AgentSyncResultDto, UpsertAgentConnectorDto } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS, severityForAction } from '../audit-logs/audit-actions';
import { AgentProviderRegistry } from './agent-provider.registry';
import { AgentsService, AgentMutationActor } from './agents.service';
import { AgentProviderDescriptor, ProviderContext } from './agent-directory.types';

type ConnectorRow = {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  config: unknown;
  secretEnc: string | null;
  defaultOwnerId: string | null;
  lastSyncAt: Date | null;
  lastSyncOk: boolean | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Connecteurs d'annuaire d'agents IA (seam `AgentDirectoryProvider`). Même
 * pattern que les connecteurs ticketing : config JSON non-secrète + secrets
 * chiffrés at-rest par tenant, jamais renvoyés à l'UI.
 */
@Injectable()
export class AgentConnectorsService {
  private readonly log = new Logger(AgentConnectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly audit: AuditLogService,
    private readonly registry: AgentProviderRegistry,
    private readonly agents: AgentsService,
  ) {}

  listProviders(): AgentProviderDescriptor[] {
    return this.registry.list();
  }

  private descriptorOrThrow(provider: string): AgentProviderDescriptor {
    const p = this.registry.get(provider);
    if (!p) throw new BadRequestException(`Type de plateforme inconnu : ${provider}`);
    return p.describe();
  }

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

  private async toDto(orgId: string, r: ConnectorRow): Promise<AgentConnectorDto> {
    const secrets = await this.decryptSecrets(orgId, r.secretEnc);
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      enabled: r.enabled,
      config: (r.config && typeof r.config === 'object' ? r.config : {}) as Record<string, unknown>,
      secretsConfigured: Object.entries(secrets)
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .map(([k]) => k),
      defaultOwnerId: r.defaultOwnerId,
      lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
      lastSyncOk: r.lastSyncOk,
      lastSyncError: r.lastSyncError,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async list(orgId: string): Promise<AgentConnectorDto[]> {
    const rows = await this.prisma.agentConnector.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((r) => this.toDto(orgId, r as ConnectorRow)));
  }

  /** Ne garde de `config` que les clés de champs NON secrets connus du provider. */
  private sanitizeConfig(
    desc: AgentProviderDescriptor,
    config: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!config) return out;
    for (const f of desc.fields) {
      if (f.secret) continue;
      if (config[f.key] !== undefined) out[f.key] = config[f.key];
    }
    // Clé réservée (hors descripteur) : date d'expiration du secret, OPTIONNELLE.
    // Le secret Entra est géré côté tiers ; la renseigner active l'alerte email
    // J-14 (cron notifications). ISO date (`YYYY-MM-DD`).
    if (typeof config.secretExpiresAt === 'string' && config.secretExpiresAt.trim())
      out.secretExpiresAt = config.secretExpiresAt.trim();
    return out;
  }

  /** Owner par défaut : humain ACTIF de l'org (les agents importés en héritent). */
  private async assertDefaultOwner(orgId: string, ownerId: string): Promise<void> {
    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, organizationId: orgId, deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
      select: { id: true },
    });
    if (!owner) throw new BadRequestException('defaultOwnerId invalide : humain ACTIF requis.');
  }

  async create(orgId: string, dto: UpsertAgentConnectorDto, actor: AgentMutationActor): Promise<AgentConnectorDto> {
    const provider = (dto.provider ?? '').trim().toLowerCase();
    if (!provider) throw new BadRequestException('provider requis.');
    const desc = this.descriptorOrThrow(provider);
    if (dto.defaultOwnerId) await this.assertDefaultOwner(orgId, dto.defaultOwnerId);

    const config = this.sanitizeConfig(desc, dto.config);
    const secrets: Record<string, string> = {};
    for (const f of desc.fields) {
      if (!f.secret) continue;
      const v = dto.secrets?.[f.key]?.trim();
      if (v) secrets[f.key] = v;
    }
    const secretEnc = Object.keys(secrets).length
      ? await this.tenantCrypto.encrypt(orgId, JSON.stringify(secrets))
      : null;

    const created = await this.prisma.agentConnector.create({
      data: {
        organizationId: orgId,
        provider,
        label: dto.label?.trim() || desc.label,
        enabled: dto.enabled ?? false,
        config: config as object,
        secretEnc,
        defaultOwnerId: dto.defaultOwnerId ?? null,
      },
    });
    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_CREATED,
      severity: severityForAction(AUDIT_ACTIONS.CONNECTOR_CREATED),
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'agentConnector',
      resourceId: created.id,
      resourceLabel: `${provider} (${created.label})`,
      detail: { provider, enabled: created.enabled },
    });
    return this.toDto(orgId, created as ConnectorRow);
  }

  async update(orgId: string, id: string, dto: UpsertAgentConnectorDto, actor: AgentMutationActor): Promise<AgentConnectorDto> {
    const existing = (await this.prisma.agentConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as ConnectorRow | null;
    if (!existing) throw new NotFoundException('Connecteur introuvable.');
    const desc = this.descriptorOrThrow(existing.provider); // provider immuable
    if (dto.defaultOwnerId) await this.assertDefaultOwner(orgId, dto.defaultOwnerId);

    const prevConfig = (existing.config && typeof existing.config === 'object'
      ? existing.config
      : {}) as Record<string, unknown>;
    const mergedConfig =
      dto.config !== undefined
        ? { ...prevConfig, ...this.sanitizeConfig(desc, dto.config) }
        : prevConfig;

    const mergedSecrets = await this.decryptSecrets(orgId, existing.secretEnc);
    if (dto.secrets) {
      for (const f of desc.fields) {
        if (!f.secret) continue;
        const v = dto.secrets[f.key];
        if (typeof v === 'string' && v.trim()) mergedSecrets[f.key] = v.trim();
      }
    }

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label.trim() || existing.label;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.config !== undefined) data.config = mergedConfig as object;
    if (dto.defaultOwnerId !== undefined) data.defaultOwnerId = dto.defaultOwnerId || null;
    if (dto.secrets !== undefined) {
      const keys = Object.entries(mergedSecrets).filter(([, v]) => v?.length);
      data.secretEnc = keys.length
        ? await this.tenantCrypto.encrypt(orgId, JSON.stringify(mergedSecrets))
        : null;
    }

    const updated = await this.prisma.agentConnector.update({ where: { id }, data });
    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_UPDATED,
      severity: severityForAction(AUDIT_ACTIONS.CONNECTOR_UPDATED),
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'agentConnector',
      resourceId: id,
      resourceLabel: `${existing.provider} (${updated.label})`,
      detail: { enabled: updated.enabled },
    });
    return this.toDto(orgId, updated as ConnectorRow);
  }

  async remove(orgId: string, id: string, actor: AgentMutationActor): Promise<void> {
    const existing = await this.prisma.agentConnector.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true, provider: true, label: true },
    });
    if (!existing) throw new NotFoundException('Connecteur introuvable.');
    await this.prisma.agentConnector.delete({ where: { id } });
    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CONNECTOR_DELETED,
      severity: severityForAction(AUDIT_ACTIONS.CONNECTOR_DELETED),
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'agentConnector',
      resourceId: id,
      resourceLabel: `${existing.provider} (${existing.label})`,
    });
  }

  private async toContext(orgId: string, row: ConnectorRow): Promise<ProviderContext> {
    return {
      config: (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>,
      secret: await this.decryptSecrets(orgId, row.secretEnc),
    };
  }

  /** Test de connexion réel — délégué au provider, résultat non persisté (sync l'est). */
  async testConnection(orgId: string, id: string) {
    const row = (await this.prisma.agentConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as ConnectorRow | null;
    if (!row) throw new NotFoundException('Connecteur introuvable.');
    const provider = this.registry.get(row.provider);
    if (!provider) return { ok: false, error: `Type de plateforme inconnu : ${row.provider}` };
    const result = await provider.testConnection(await this.toContext(orgId, row));
    if (!result.ok) {
      this.log.warn(`[agents] testConnection failed provider="${row.provider}" (org=${orgId}): ${result.error ?? 'unknown'}`);
    }
    return result;
  }

  /** Sync manuelle (« Sync now ») : énumère la plateforme et upserte les agents. */
  async sync(orgId: string, id: string, actor: AgentMutationActor): Promise<AgentSyncResultDto> {
    const row = (await this.prisma.agentConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as ConnectorRow | null;
    if (!row) throw new NotFoundException('Connecteur introuvable.');
    if (!row.enabled) throw new BadRequestException('Connecteur désactivé — activez-le avant de synchroniser.');
    const provider = this.registry.get(row.provider);
    if (!provider) throw new BadRequestException(`Type de plateforme inconnu : ${row.provider}`);

    try {
      const remote = await provider.listAgents(await this.toContext(orgId, row));
      const res = await this.agents.syncFromDirectory(orgId, row.provider, remote, row.defaultOwnerId, actor);
      await this.prisma.agentConnector.update({
        where: { id },
        data: { lastSyncAt: new Date(), lastSyncOk: true, lastSyncError: null },
      });
      return {
        ok: true,
        created: res.created,
        updated: res.updated,
        suspended: res.suspended,
        skippedOverLimit: res.skippedOverLimit,
      };
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 500) ?? 'unknown error';
      this.log.warn(`[agents] sync failed provider="${row.provider}" (org=${orgId}): ${msg}`);
      await this.prisma.agentConnector
        .update({ where: { id }, data: { lastSyncAt: new Date(), lastSyncOk: false, lastSyncError: msg } })
        .catch(() => undefined);
      return { ok: false, created: 0, updated: 0, suspended: 0, error: msg };
    }
  }
}
