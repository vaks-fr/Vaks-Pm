import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenancy/tenant-context.service';
import { AuditLogService } from '../../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../../audit-logs/audit-actions';
import { assertSafeExternalUrl, safeFetch } from '../../common/url-guard';
import { AgentFederationVerifier } from './agent-federation.verifier';

/**
 * CRUD des émetteurs de confiance (`AgentTrustIssuer`). App-privé, jamais
 * `@PublicApi` : déclarer qui peut attester d'un agent est une décision de
 * sécurité, elle ne s'automatise pas par jeton.
 */

export interface TrustIssuerInput {
  label?: string;
  enabled?: boolean;
  issuer?: string;
  audience?: string;
  discoveryUrl?: string | null;
  jwksUri?: string | null;
  jwksJson?: unknown | null;
  algorithms?: string[];
  subjectClaim?: string;
  idpSource?: string;
  claimConstraints?: Record<string, unknown>;
  requireJti?: boolean;
  tokenTtlSec?: number;
  autoDeclare?: boolean;
  defaultOwnerId?: string | null;
  connectorId?: string | null;
}

const MIN_TTL_SEC = 300;
const MAX_TTL_SEC = 3600;

@Injectable()
export class AgentTrustIssuersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly audit: AuditLogService,
    private readonly verifier: AgentFederationVerifier,
  ) {}

  async list(orgId: string) {
    const rows = await this.prisma.agentTrustIssuer.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r: Record<string, unknown>) => this.toDto(r));
  }

  private toDto(r: Record<string, unknown>) {
    return {
      id: r.id,
      label: r.label,
      enabled: r.enabled,
      issuer: r.issuer,
      audience: r.audience,
      discoveryUrl: r.discoveryUrl,
      jwksUri: r.jwksUri,
      /** Le JWKS est public par nature, mais on n'en renvoie que le compte. */
      jwksKeyCount: Array.isArray((r.jwksJson as { keys?: unknown[] })?.keys)
        ? (r.jwksJson as { keys: unknown[] }).keys.length
        : 0,
      algorithms: r.algorithms,
      subjectClaim: r.subjectClaim,
      idpSource: r.idpSource,
      claimConstraints: r.claimConstraints,
      requireJti: r.requireJti,
      tokenTtlSec: r.tokenTtlSec,
      autoDeclare: r.autoDeclare,
      defaultOwnerId: r.defaultOwnerId,
      connectorId: r.connectorId,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
    };
  }

  private async findOrThrow(orgId: string, id: string) {
    const row = await this.prisma.agentTrustIssuer.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Émetteur introuvable');
    return row as Record<string, unknown>;
  }

  /** `iss` est comparé au caractère près : on impose une URL absolue normalisée. */
  private normalizeIssuer(raw: string): string {
    const v = (raw ?? '').trim();
    if (!v) throw new BadRequestException("L'émetteur (`iss`) est requis.");
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new BadRequestException("L'émetteur doit être une URL absolue (claim `iss`).");
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new BadRequestException("L'émetteur doit être en http(s).");
    }
    // Pas de normalisation agressive (pas de suppression du slash final) : le
    // claim `iss` est comparé littéralement, on conserve ce que l'admin a saisi.
    return v;
  }

  private sanitizeAlgorithms(input?: string[]): string[] {
    if (!input?.length) return ['RS256', 'ES256'];
    const bad = input.filter((a) => a.toLowerCase() === 'none' || a.toUpperCase().startsWith('HS'));
    if (bad.length) {
      throw new BadRequestException(
        `Algorithmes interdits : ${bad.join(', ')}. « none » et HMAC (HS*) sont refusés — avec HS*, la clé publique du JWKS deviendrait le secret de signature.`,
      );
    }
    return Array.from(new Set(input.map((a) => a.trim()).filter(Boolean)));
  }

  private sanitizeJwks(raw: unknown): unknown | null {
    if (raw === undefined || raw === null || raw === '') return null;
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new BadRequestException('JWKS collé : JSON invalide.');
      }
    }
    const keys = (parsed as { keys?: unknown[] })?.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new BadRequestException('JWKS collé : objet `{ "keys": [...] }` non vide attendu.');
    }
    return parsed;
  }

  /** Résout `jwks_uri` depuis un document de découverte OIDC. */
  private async resolveDiscovery(discoveryUrl: string): Promise<string> {
    const url = discoveryUrl.trim();
    try {
      assertSafeExternalUrl(url, { httpsOnly: true });
    } catch (e) {
      // En on-premise l'émetteur est souvent interne ; on laisse l'opérateur
      // trancher via AGENT_FEDERATION_ALLOW_INTERNAL_JWKS, sinon on refuse ici.
      if (process.env.AGENT_FEDERATION_ALLOW_INTERNAL_JWKS !== 'true') {
        throw new BadRequestException(
          `${(e as Error).message} Pour un émetteur interne, collez le JWKS ou activez AGENT_FEDERATION_ALLOW_INTERNAL_JWKS côté opérateur.`,
        );
      }
    }
    let res: Response;
    try {
      res =
        process.env.AGENT_FEDERATION_ALLOW_INTERNAL_JWKS === 'true'
          ? await fetch(url)
          : await safeFetch(url, { httpsOnly: true });
    } catch (e) {
      throw new BadRequestException(`Découverte OIDC injoignable : ${(e as Error).message}`);
    }
    if (!res.ok) throw new BadRequestException(`Découverte OIDC : HTTP ${res.status}`);
    const doc = (await res.json().catch(() => null)) as { jwks_uri?: string } | null;
    if (!doc?.jwks_uri) throw new BadRequestException('Découverte OIDC sans `jwks_uri`.');
    return doc.jwks_uri;
  }

  async create(orgId: string, dto: TrustIssuerInput, actorId: string) {
    const label = dto.label?.trim();
    if (!label) throw new BadRequestException('Libellé requis.');
    const issuer = this.normalizeIssuer(dto.issuer ?? '');
    const audience = dto.audience?.trim();
    if (!audience) {
      throw new BadRequestException(
        "L'audience est requise : sans elle, un jeton obtenu par l'agent pour une autre application du même émetteur vaudrait credential ici.",
      );
    }
    const idpSource = dto.idpSource?.trim();
    if (!idpSource) throw new BadRequestException('`idpSource` requis (provenance des agents résolus).');

    const jwksJson = this.sanitizeJwks(dto.jwksJson);
    let jwksUri = dto.jwksUri?.trim() || null;
    if (dto.discoveryUrl?.trim() && !jwksUri && !jwksJson) {
      jwksUri = await this.resolveDiscovery(dto.discoveryUrl);
    }
    if (!jwksJson && !jwksUri) {
      throw new BadRequestException(
        'Renseignez une URL de découverte, une URL JWKS, ou collez le JWKS (recommandé pour un émetteur interne / air-gap).',
      );
    }

    const row = await this.prisma.agentTrustIssuer.create({
      data: {
        organizationId: orgId,
        label,
        enabled: dto.enabled ?? false,
        issuer,
        audience,
        discoveryUrl: dto.discoveryUrl?.trim() || null,
        jwksUri,
        jwksJson: (jwksJson ?? undefined) as unknown as Prisma.InputJsonValue,
        algorithms: this.sanitizeAlgorithms(dto.algorithms),
        subjectClaim: dto.subjectClaim?.trim() || 'sub',
        idpSource,
        claimConstraints: (dto.claimConstraints ?? {}) as unknown as Prisma.InputJsonValue,
        requireJti: dto.requireJti ?? true,
        tokenTtlSec: this.clampTtl(dto.tokenTtlSec),
        autoDeclare: dto.autoDeclare ?? false,
        defaultOwnerId: dto.defaultOwnerId || null,
        connectorId: dto.connectorId || null,
      },
    });

    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_TRUST_ISSUER_CREATED,
      actorId,
      resourceType: 'agentTrustIssuer',
      resourceId: (row as { id: string }).id,
      resourceLabel: label,
      detail: { issuer, audience, idpSource, enabled: dto.enabled ?? false },
    });
    return this.toDto(row as Record<string, unknown>);
  }

  async update(orgId: string, id: string, dto: TrustIssuerInput, actorId: string) {
    const existing = await this.findOrThrow(orgId, id);
    const data: Record<string, unknown> = {};

    if (dto.label !== undefined) data.label = dto.label.trim();
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.issuer !== undefined) data.issuer = this.normalizeIssuer(dto.issuer);
    if (dto.audience !== undefined) {
      const a = dto.audience.trim();
      if (!a) throw new BadRequestException("L'audience ne peut pas être vidée.");
      data.audience = a;
    }
    if (dto.discoveryUrl !== undefined) data.discoveryUrl = dto.discoveryUrl?.trim() || null;
    if (dto.jwksUri !== undefined) data.jwksUri = dto.jwksUri?.trim() || null;
    if (dto.jwksJson !== undefined) data.jwksJson = this.sanitizeJwks(dto.jwksJson) ?? undefined;
    if (dto.algorithms !== undefined) data.algorithms = this.sanitizeAlgorithms(dto.algorithms);
    if (dto.subjectClaim !== undefined) data.subjectClaim = dto.subjectClaim.trim() || 'sub';
    if (dto.idpSource !== undefined) {
      const s = dto.idpSource.trim();
      if (!s) throw new BadRequestException('`idpSource` ne peut pas être vidé.');
      data.idpSource = s;
    }
    if (dto.claimConstraints !== undefined) data.claimConstraints = dto.claimConstraints ?? {};
    if (dto.requireJti !== undefined) data.requireJti = dto.requireJti;
    if (dto.tokenTtlSec !== undefined) data.tokenTtlSec = this.clampTtl(dto.tokenTtlSec);
    if (dto.autoDeclare !== undefined) data.autoDeclare = dto.autoDeclare;
    if (dto.defaultOwnerId !== undefined) data.defaultOwnerId = dto.defaultOwnerId || null;

    const row = await this.prisma.agentTrustIssuer.update({ where: { id }, data });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_TRUST_ISSUER_UPDATED,
      actorId,
      resourceType: 'agentTrustIssuer',
      resourceId: id,
      resourceLabel: (data.label as string) ?? (existing.label as string),
      detail: { changed: Object.keys(data) },
    });
    return this.toDto(row as Record<string, unknown>);
  }

  async remove(orgId: string, id: string, actorId: string) {
    const existing = await this.findOrThrow(orgId, id);
    await this.prisma.agentTrustIssuer.delete({ where: { id } });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_TRUST_ISSUER_DELETED,
      actorId,
      resourceType: 'agentTrustIssuer',
      resourceId: id,
      resourceLabel: existing.label as string,
      detail: { issuer: existing.issuer, audience: existing.audience },
    });
    return { id, deleted: true };
  }

  /** Bouton « Tester » : le JWKS est-il exploitable ? */
  async probe(orgId: string, id: string) {
    const row = await this.findOrThrow(orgId, id);
    return this.verifier.probe({
      id: row.id as string,
      issuer: row.issuer as string,
      audience: row.audience as string,
      jwksUri: (row.jwksUri as string) ?? null,
      jwksJson: row.jwksJson ?? null,
      algorithms: (row.algorithms as string[]) ?? [],
      subjectClaim: (row.subjectClaim as string) ?? 'sub',
      claimConstraints: row.claimConstraints ?? {},
      requireJti: (row.requireJti as boolean) ?? true,
    });
  }

  /**
   * Pré-remplissage depuis un connecteur d'annuaire (affordance UI).
   *
   * **Snapshot, pas héritage** : les valeurs sont copiées une fois. Si l'admin
   * change ensuite le tenant du connecteur, l'émetteur ne bouge pas — modifier
   * une config d'annuaire ne doit jamais changer silencieusement *qui on croit
   * sur parole*. L'UI signale la dérive, l'admin tranche.
   */
  async deriveFromConnector(orgId: string, connectorId: string) {
    const conn = (await this.prisma.agentConnector.findFirst({
      where: { id: connectorId, organizationId: orgId },
    })) as Record<string, unknown> | null;
    if (!conn) throw new NotFoundException('Connecteur introuvable');

    const provider = conn.provider as string;
    const config = (conn.config ?? {}) as Record<string, unknown>;
    const slug = this.tenant.currentSlug() ?? 'vaks-pm';

    if (provider === 'entra-agent') {
      const tenantId = (config.tenantId as string) ?? '';
      if (!tenantId) {
        throw new BadRequestException(
          "Le connecteur n'a pas de `tenantId` : complétez-le avant de dériver un émetteur.",
        );
      }
      return {
        label: `${conn.label as string} — jetons`,
        // Entra v2 émet `iss = https://login.microsoftonline.com/<tid>/v2.0`.
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        discoveryUrl: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
        // Audience = notre propre app registration. Valeur proposée, à confirmer
        // par l'admin : elle doit correspondre à ce que la plateforme demande.
        audience: `api://vaks-pm/${slug}`,
        idpSource: provider,
        defaultOwnerId: (conn.defaultOwnerId as string) ?? null,
        connectorId,
        // Le `sub` d'un jeton workload identity n'est pas toujours l'`id`
        // d'`agentIdentities` stocké en externalId — à valider contre le tenant.
        subjectClaim: 'sub',
      };
    }

    throw new BadRequestException(
      `Aucune dérivation automatique pour le provider « ${provider} » : saisissez l'émetteur manuellement.`,
    );
  }

  private clampTtl(v?: number): number {
    if (!v || !Number.isFinite(v)) return MAX_TTL_SEC;
    return Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, Math.floor(v)));
  }
}
