import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { CI_PROVIDERS, CiProvider, isCiProvider } from './ci-providers';
import { UpsertCiConnectorDto } from './dto/upsert-ci-connector.dto';

export interface CiConnectorActor {
  id?: string | null;
  email?: string | null;
}

type CiConnectorRow = {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  secretEnc: string | null;
  lastEventAt: Date | null;
  lastEventOk: boolean | null;
  lastEventError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface CiConnectorDto {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  secretConfigured: boolean;
  lastEventAt: string | null;
  lastEventOk: boolean | null;
  lastEventError: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_LABELS: Record<CiProvider, string> = {
  github: 'GitHub Actions',
  generic: 'Generic CI (HMAC)',
};

/**
 * Connecteurs CI signataires (phase C). Détient le secret partagé HMAC, chiffré
 * at-rest par tenant (même pattern que les connecteurs d'annuaire d'agents). Le
 * secret n'est JAMAIS renvoyé à l'UI (booléen `secretConfigured`). Un connecteur
 * par (org, provider).
 */
@Injectable()
export class CiConnectorsService {
  private readonly log = new Logger(CiConnectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly audit: AuditLogService,
  ) {}

  listProviders(): { id: CiProvider; label: string; signatureHeader: string }[] {
    return CI_PROVIDERS.map((id) => ({
      id,
      label: DEFAULT_LABELS[id],
      signatureHeader: id === 'github' ? 'X-Hub-Signature-256' : 'X-Vaks-CI-Signature',
    }));
  }

  private toDto(r: CiConnectorRow): CiConnectorDto {
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      enabled: r.enabled,
      secretConfigured: !!r.secretEnc,
      lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
      lastEventOk: r.lastEventOk,
      lastEventError: r.lastEventError,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async list(orgId: string): Promise<CiConnectorDto[]> {
    const rows = (await this.prisma.ciConnector.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    })) as CiConnectorRow[];
    return rows.map((r) => this.toDto(r));
  }

  /** Secret partagé HMAC déchiffré du connecteur ACTIVÉ (ou null). Interne. */
  async getActiveSecret(orgId: string, provider: string): Promise<string | null> {
    const row = (await this.prisma.ciConnector.findFirst({
      where: { organizationId: orgId, provider, enabled: true },
      select: { secretEnc: true },
    })) as { secretEnc: string | null } | null;
    if (!row?.secretEnc) return null;
    try {
      return await this.tenantCrypto.decrypt(orgId, row.secretEnc);
    } catch {
      return null; // clé rotée / blob corrompu → non configuré
    }
  }

  async create(orgId: string, dto: UpsertCiConnectorDto, actor: CiConnectorActor): Promise<CiConnectorDto> {
    const provider = (dto.provider ?? '').trim().toLowerCase();
    if (!isCiProvider(provider)) throw new BadRequestException(`Signataire CI inconnu : ${provider}`);
    const existing = await this.prisma.ciConnector.findFirst({
      where: { organizationId: orgId, provider },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`Un connecteur ${provider} existe déjà pour cette organisation.`);
    }
    const secret = dto.secret?.trim();
    const secretEnc = secret ? await this.tenantCrypto.encrypt(orgId, secret) : null;
    const created = (await this.prisma.ciConnector.create({
      data: {
        organizationId: orgId,
        provider,
        label: dto.label?.trim() || DEFAULT_LABELS[provider as CiProvider],
        enabled: dto.enabled ?? true,
        secretEnc,
      },
    })) as CiConnectorRow;
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CI_CONNECTOR_CREATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'ciConnector',
      resourceId: created.id,
      resourceLabel: `${provider} (${created.label})`,
      detail: { provider, enabled: created.enabled, secretConfigured: !!secretEnc },
    });
    return this.toDto(created);
  }

  async update(orgId: string, id: string, dto: UpsertCiConnectorDto, actor: CiConnectorActor): Promise<CiConnectorDto> {
    const existing = (await this.prisma.ciConnector.findFirst({
      where: { id, organizationId: orgId },
    })) as CiConnectorRow | null;
    if (!existing) throw new NotFoundException('Connecteur CI introuvable.');

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label.trim() || existing.label;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    // secret : chaîne vide = effacer ; non fourni = conserver ; sinon rechiffrer.
    if (dto.secret !== undefined) {
      const secret = dto.secret.trim();
      data.secretEnc = secret ? await this.tenantCrypto.encrypt(orgId, secret) : null;
    }

    const updated = (await this.prisma.ciConnector.update({ where: { id }, data })) as CiConnectorRow;
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CI_CONNECTOR_UPDATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'ciConnector',
      resourceId: id,
      resourceLabel: `${existing.provider} (${updated.label})`,
      detail: { enabled: updated.enabled, secretRotated: dto.secret !== undefined },
    });
    return this.toDto(updated);
  }

  async remove(orgId: string, id: string, actor: CiConnectorActor): Promise<void> {
    const existing = await this.prisma.ciConnector.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true, provider: true, label: true },
    });
    if (!existing) throw new NotFoundException('Connecteur CI introuvable.');
    await this.prisma.ciConnector.delete({ where: { id } });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CI_CONNECTOR_DELETED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'ciConnector',
      resourceId: id,
      resourceLabel: `${existing.provider} (${existing.label})`,
    });
  }

  /** Note le diagnostic du dernier webhook reçu (best-effort, non bloquant). */
  async noteEvent(orgId: string, provider: string, ok: boolean, error: string | null): Promise<void> {
    await this.prisma.ciConnector
      .updateMany({
        where: { organizationId: orgId, provider },
        data: { lastEventAt: new Date(), lastEventOk: ok, lastEventError: error?.slice(0, 300) ?? null },
      })
      .catch(() => undefined);
  }
}
