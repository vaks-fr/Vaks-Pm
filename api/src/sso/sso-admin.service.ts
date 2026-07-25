import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../admin/roles.service';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { RoleScope } from '@vaks-pm/shared';
import { OidcClientService } from './oidc-client.service';
import { RoleMapping } from './sso.types';
import { isBlockedHost } from '../common/url-guard';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export interface UpsertIdpDto {
  type?: 'OIDC' | 'SAML';
  slug?: string;
  displayName?: string;
  enabled?: boolean;
  oidcDiscoveryUrl?: string | null;
  oidcClientId?: string | null;
  /** Client secret en clair — write-only. Chiffré avant stockage, jamais
   *  renvoyé. Absent/'' = inchangé. */
  oidcClientSecret?: string | null;
  /** Clé privée PEM PKCS#8 (mode certificat, secretless) — write-only, chiffrée,
   *  jamais renvoyée. Absent/'' = inchangé. Prime sur le client secret. */
  oidcPrivateKey?: string | null;
  /** Empreinte (x5t, hex) du certificat Entra — non-secret, requise avec la clé privée. */
  oidcCertThumbprint?: string | null;
  oidcScopes?: string[];
  // ---- SAML ----
  samlEntryPoint?: string | null;
  samlIssuer?: string | null;
  /** Certificat X.509 de signature de l'IdP (PEM public — pas un secret). */
  samlIdpCert?: string | null;
  jitProvisioning?: boolean;
  syncRolesOnLogin?: boolean;
  defaultRoleKey?: string | null;
  linkStrategy?: 'link' | 'reject';
  linkMatchKey?: 'upn' | 'email';
  roleMappings?: RoleMapping[];
  claimMappings?: Record<string, string>;
}

/** DTO exposé à l'admin — n'inclut JAMAIS de secret (il n'y en a pas en DB). */
export interface IdpAdminDto {
  id: string;
  type: 'OIDC' | 'SAML';
  slug: string;
  displayName: string;
  enabled: boolean;
  oidcDiscoveryUrl: string | null;
  oidcClientId: string | null;
  oidcScopes: string[];
  /** True si le secret client (Swarm secret) est monté côté serveur. */
  clientSecretConfigured: boolean;
  /** True si l'auth **certificat** (clé privée + empreinte) est configurée. */
  certAuthConfigured: boolean;
  /** Empreinte du certificat (non-secret), renvoyée pour affichage. */
  oidcCertThumbprint: string | null;
  // ---- SAML (cert public, renvoyé tel quel) ----
  samlEntryPoint: string | null;
  samlIssuer: string | null;
  samlIdpCert: string | null;
  jitProvisioning: boolean;
  syncRolesOnLogin: boolean;
  defaultRoleKey: string | null;
  linkStrategy: string;
  /** Clé de rapprochement de compte LOCAL : 'upn' (défaut) | 'email'. */
  linkMatchKey: string;
  roleMappings: RoleMapping[];
  claimMappings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class SsoAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly roles: RolesService,
    private readonly tenantCrypto: TenantCryptoService,
    private readonly audit: AuditLogService,
    private readonly oidc: OidcClientService,
  ) {}

  /** Secret Swarm partagé (fallback back-compat) présent côté serveur ? */
  private envSecretPresent(): boolean {
    return Boolean(this.config.get('sso')?.oidcClientSecret);
  }

  /** Un secret utilisable existe-t-il pour CE provider (propre OU fallback) ? */
  private secretConfiguredFor(encPresent: boolean): boolean {
    return encPresent || this.envSecretPresent();
  }

  private toDto(p: {
    id: string; type: string; slug: string; displayName: string; enabled: boolean;
    oidcDiscoveryUrl: string | null; oidcClientId: string | null; oidcScopes: string[];
    oidcClientSecretEnc: string | null;
    oidcPrivateKeyEnc?: string | null; oidcCertThumbprint?: string | null;
    samlEntryPoint: string | null; samlIssuer: string | null; samlIdpCert: string | null;
    jitProvisioning: boolean; syncRolesOnLogin: boolean; defaultRoleKey: string | null; linkStrategy: string;
    linkMatchKey: string;
    roleMappings: unknown; claimMappings: unknown; createdAt: Date; updatedAt: Date;
  }): IdpAdminDto {
    return {
      id: p.id,
      type: p.type as 'OIDC' | 'SAML',
      slug: p.slug,
      displayName: p.displayName,
      enabled: p.enabled,
      oidcDiscoveryUrl: p.oidcDiscoveryUrl,
      oidcClientId: p.oidcClientId,
      oidcScopes: p.oidcScopes ?? [],
      clientSecretConfigured: this.secretConfiguredFor(Boolean(p.oidcClientSecretEnc)),
      certAuthConfigured: Boolean(p.oidcPrivateKeyEnc),
      oidcCertThumbprint: p.oidcCertThumbprint ?? null,
      samlEntryPoint: p.samlEntryPoint,
      samlIssuer: p.samlIssuer,
      samlIdpCert: p.samlIdpCert,
      jitProvisioning: p.jitProvisioning,
      defaultRoleKey: p.defaultRoleKey,
      linkStrategy: p.linkStrategy,
      linkMatchKey: p.linkMatchKey ?? 'upn',
      syncRolesOnLogin: p.syncRolesOnLogin,
      roleMappings: Array.isArray(p.roleMappings) ? (p.roleMappings as RoleMapping[]) : [],
      claimMappings: (p.claimMappings as Record<string, string>) ?? {},
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  async list(orgId: string): Promise<IdpAdminDto[]> {
    const rows = await this.prisma.identityProvider.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Valide les clés de rôle référencées (defaultRoleKey + mappings) côté org. */
  private async validateRoleKeys(orgId: string, dto: UpsertIdpDto): Promise<void> {
    const keys = new Set<string>();
    if (dto.defaultRoleKey) keys.add(dto.defaultRoleKey);
    const seenMatches = new Set<string>();
    for (const m of dto.roleMappings ?? []) {
      if (!m.match || !m.roleKey) {
        throw new BadRequestException('Chaque mapping exige `match` et `roleKey`.');
      }
      const match = m.match.trim();
      // Garde-fou : un même groupe ne peut être mappé qu'UNE fois (sinon seul le
      // premier s'appliquerait — config ambiguë). On rejette le doublon.
      if (seenMatches.has(match)) {
        throw new BadRequestException(
          `Le groupe « ${match} » est mappé plusieurs fois. Chaque groupe ne peut viser qu'un seul rôle.`,
        );
      }
      seenMatches.add(match);
      keys.add(m.roleKey);
    }
    for (const key of keys) {
      const role = await this.roles.findByKey(orgId, key).catch(() => null);
      if (!role) throw new BadRequestException(`Rôle inconnu : ${key}`);
      if (role.scope !== RoleScope.ORG) {
        throw new BadRequestException(`${key} n'est pas un rôle d'organisation.`);
      }
    }
  }

  private validateShape(dto: UpsertIdpDto, opts: { creating: boolean; secretConfigured: boolean }): void {
    const type = dto.type ?? 'OIDC';
    if (opts.creating) {
      if (!dto.slug || !SLUG_RE.test(dto.slug)) {
        throw new BadRequestException('slug invalide ([a-z0-9-], 2–40 caractères).');
      }
      if (!dto.displayName?.trim()) throw new BadRequestException('displayName requis.');
      if (dto.type && !['OIDC', 'SAML'].includes(dto.type)) {
        throw new BadRequestException('type doit être OIDC ou SAML.');
      }
    }
    if (dto.linkStrategy && !['link', 'reject'].includes(dto.linkStrategy)) {
      throw new BadRequestException('linkStrategy doit être `link` ou `reject`.');
    }
    if (dto.linkMatchKey && !['upn', 'email'].includes(dto.linkMatchKey)) {
      throw new BadRequestException('linkMatchKey doit être `upn` ou `email`.');
    }
    if (dto.oidcDiscoveryUrl) {
      let u: URL | null = null;
      try {
        u = new URL(dto.oidcDiscoveryUrl);
        if (u.protocol !== 'https:') throw new Error();
      } catch {
        throw new BadRequestException('oidcDiscoveryUrl doit être une URL https valide.');
      }
      // Anti-SSRF : la discovery est fetchée côté serveur (openid-client) →
      // refuser une cible interne/privée/loopback.
      if (isBlockedHost(u.hostname)) {
        throw new BadRequestException('oidcDiscoveryUrl ne peut pas cibler un hôte interne.');
      }
    }
    if (dto.samlEntryPoint) {
      let u: URL | null = null;
      try {
        u = new URL(dto.samlEntryPoint);
        if (u.protocol !== 'https:') throw new Error();
      } catch {
        throw new BadRequestException('samlEntryPoint doit être une URL https valide.');
      }
      if (isBlockedHost(u.hostname)) {
        throw new BadRequestException('samlEntryPoint ne peut pas cibler un hôte interne.');
      }
    }
    if (dto.samlIdpCert && !/-----BEGIN CERTIFICATE-----/.test(dto.samlIdpCert)) {
      throw new BadRequestException('samlIdpCert doit être un certificat X.509 au format PEM.');
    }
    // Anti-activation incomplète : config minimale requise selon le type.
    if (dto.enabled) {
      if (type === 'SAML') {
        if (!dto.samlEntryPoint || !dto.samlIdpCert) {
          throw new BadRequestException(
            "Impossible d'activer : SSO URL (entryPoint) et certificat de signature de l'IdP requis.",
          );
        }
      } else {
        if (!dto.oidcDiscoveryUrl || !dto.oidcClientId) {
          throw new BadRequestException(
            "Impossible d'activer : discovery URL et client ID requis.",
          );
        }
        if (!opts.secretConfigured) {
          throw new BadRequestException(
            "Impossible d'activer : aucun client secret ni certificat défini pour ce fournisseur. Renseignez l'un des deux ci-dessus.",
          );
        }
      }
    }
  }

  /** Valide le matériel du mode certificat : PEM PKCS#8 + empreinte hex présente. */
  private assertCertShape(privateKeyPem: string | undefined, thumbprint: string | null): void {
    if (!privateKeyPem) return;
    if (!/-----BEGIN (?:PRIVATE|RSA PRIVATE|EC PRIVATE) KEY-----/.test(privateKeyPem)) {
      throw new BadRequestException('oidcPrivateKey doit être une clé privée au format PEM (PKCS#8).');
    }
    if (!thumbprint || thumbprint.replace(/[^0-9a-fA-F]/g, '').length < 40) {
      throw new BadRequestException(
        "oidcCertThumbprint requis (empreinte hex du certificat Entra) avec la clé privée.",
      );
    }
  }

  async create(orgId: string, dto: UpsertIdpDto, actor: { id?: string; email?: string }): Promise<IdpAdminDto> {
    const secret = dto.oidcClientSecret?.trim();
    const encNew = secret ? await this.tenantCrypto.encrypt(orgId, secret) : null;
    const pk = dto.oidcPrivateKey?.trim();
    const pkEncNew = pk ? await this.tenantCrypto.encrypt(orgId, pk) : null;
    const thumbNew = dto.oidcCertThumbprint?.trim() || null;
    this.assertCertShape(pk, thumbNew);
    this.validateShape(dto, {
      creating: true,
      secretConfigured: Boolean(encNew) || Boolean(pkEncNew) || this.envSecretPresent(),
    });
    await this.validateRoleKeys(orgId, dto);
    const dup = await this.prisma.identityProvider.findFirst({
      where: { organizationId: orgId, slug: dto.slug },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Un fournisseur avec ce slug existe déjà.');
    const created = await this.prisma.identityProvider.create({
      data: {
        organizationId: orgId,
        type: (dto.type ?? 'OIDC') as 'OIDC' | 'SAML',
        slug: dto.slug!,
        displayName: dto.displayName!.trim(),
        enabled: dto.enabled ?? false,
        oidcDiscoveryUrl: dto.oidcDiscoveryUrl ?? null,
        oidcClientId: dto.oidcClientId ?? null,
        oidcClientSecretEnc: encNew,
        oidcPrivateKeyEnc: pkEncNew,
        oidcCertThumbprint: thumbNew,
        oidcScopes: dto.oidcScopes ?? [],
        samlEntryPoint: dto.samlEntryPoint ?? null,
        samlIssuer: dto.samlIssuer ?? null,
        samlIdpCert: dto.samlIdpCert ?? null,
        jitProvisioning: dto.jitProvisioning ?? true,
        syncRolesOnLogin: dto.syncRolesOnLogin ?? false,
        defaultRoleKey: dto.defaultRoleKey ?? null,
        linkStrategy: dto.linkStrategy ?? 'link',
        linkMatchKey: dto.linkMatchKey ?? 'upn',
        roleMappings: (dto.roleMappings ?? []) as object,
        claimMappings: (dto.claimMappings ?? {}) as object,
      },
    });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.IDP_CREATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'identityProvider',
      resourceId: created.id,
      resourceLabel: created.slug,
      detail: { type: created.type, enabled: created.enabled },
    });
    return this.toDto(created);
  }

  async update(orgId: string, id: string, dto: UpsertIdpDto, actor: { id?: string; email?: string }): Promise<IdpAdminDto> {
    const existing = await this.prisma.identityProvider.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Fournisseur introuvable.');
    // Fusion pour la validation d'activation (les champs absents gardent l'ancienne valeur).
    const merged: UpsertIdpDto = {
      type: existing.type as 'OIDC' | 'SAML',
      enabled: dto.enabled ?? existing.enabled,
      oidcDiscoveryUrl: dto.oidcDiscoveryUrl ?? existing.oidcDiscoveryUrl,
      oidcClientId: dto.oidcClientId ?? existing.oidcClientId,
      samlEntryPoint: dto.samlEntryPoint ?? existing.samlEntryPoint,
      samlIssuer: dto.samlIssuer ?? existing.samlIssuer,
      samlIdpCert: dto.samlIdpCert ?? existing.samlIdpCert,
      linkStrategy: (dto.linkStrategy ?? existing.linkStrategy) as 'link' | 'reject',
      linkMatchKey: (dto.linkMatchKey ?? existing.linkMatchKey) as 'upn' | 'email',
      defaultRoleKey: dto.defaultRoleKey ?? existing.defaultRoleKey,
      roleMappings: dto.roleMappings ?? (existing.roleMappings as unknown as RoleMapping[]),
    };
    // Secret : non vide → (re)chiffre ; absent/'' → inchangé.
    const secret = dto.oidcClientSecret?.trim();
    const encNew = secret ? await this.tenantCrypto.encrypt(orgId, secret) : undefined;
    // Clé privée (mode certificat) : idem write-only. Empreinte non-secrète.
    const pk = dto.oidcPrivateKey?.trim();
    const pkEncNew = pk ? await this.tenantCrypto.encrypt(orgId, pk) : undefined;
    const thumbNew = dto.oidcCertThumbprint !== undefined ? (dto.oidcCertThumbprint?.trim() || null) : undefined;
    // Empreinte résultante (nouvelle si fournie, sinon existante) pour valider la cohérence.
    const effThumb = thumbNew !== undefined ? thumbNew : existing.oidcCertThumbprint;
    if (pk) this.assertCertShape(pk, effThumb ?? null);
    const certConfigured = Boolean(existing.oidcPrivateKeyEnc) || Boolean(pkEncNew);
    if (certConfigured && !effThumb) {
      throw new BadRequestException(
        "Empreinte du certificat (x5t) requise avec la clé privée du mode certificat.",
      );
    }
    this.validateShape(merged, {
      creating: false,
      secretConfigured:
        Boolean(existing.oidcClientSecretEnc) || Boolean(encNew) || certConfigured || this.envSecretPresent(),
    });
    await this.validateRoleKeys(orgId, merged);
    const data: Record<string, unknown> = {};
    // slug immuable (figé dans le redirect_uri) — on ne le modifie pas.
    if (dto.displayName !== undefined) data.displayName = dto.displayName.trim();
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.oidcDiscoveryUrl !== undefined) data.oidcDiscoveryUrl = dto.oidcDiscoveryUrl;
    if (dto.oidcClientId !== undefined) data.oidcClientId = dto.oidcClientId;
    if (encNew !== undefined) data.oidcClientSecretEnc = encNew;
    if (pkEncNew !== undefined) data.oidcPrivateKeyEnc = pkEncNew;
    if (thumbNew !== undefined) data.oidcCertThumbprint = thumbNew;
    if (dto.oidcScopes !== undefined) data.oidcScopes = dto.oidcScopes;
    if (dto.samlEntryPoint !== undefined) data.samlEntryPoint = dto.samlEntryPoint;
    if (dto.samlIssuer !== undefined) data.samlIssuer = dto.samlIssuer;
    if (dto.samlIdpCert !== undefined) data.samlIdpCert = dto.samlIdpCert;
    if (dto.jitProvisioning !== undefined) data.jitProvisioning = dto.jitProvisioning;
    if (dto.syncRolesOnLogin !== undefined) data.syncRolesOnLogin = dto.syncRolesOnLogin;
    if (dto.defaultRoleKey !== undefined) data.defaultRoleKey = dto.defaultRoleKey;
    if (dto.linkStrategy !== undefined) data.linkStrategy = dto.linkStrategy;
    if (dto.linkMatchKey !== undefined) data.linkMatchKey = dto.linkMatchKey;
    if (dto.roleMappings !== undefined) data.roleMappings = dto.roleMappings as object;
    if (dto.claimMappings !== undefined) data.claimMappings = dto.claimMappings as object;
    const updated = await this.prisma.identityProvider.update({ where: { id }, data });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.IDP_UPDATED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'identityProvider',
      resourceId: id,
      resourceLabel: updated.slug,
      detail: { enabled: updated.enabled },
    });
    return this.toDto(updated);
  }

  async remove(orgId: string, id: string, actor: { id?: string; email?: string }): Promise<void> {
    const existing = await this.prisma.identityProvider.findFirst({
      where: { id, organizationId: orgId }, select: { id: true, slug: true },
    });
    if (!existing) throw new NotFoundException('Fournisseur introuvable.');
    await this.prisma.identityProvider.delete({ where: { id } });
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.IDP_DELETED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'identityProvider',
      resourceId: id,
      resourceLabel: existing.slug,
    });
  }

  /** Test de connexion : OIDC → découverte + secret ; SAML → config présente. */
  async testConnection(orgId: string, id: string) {
    const p = await this.prisma.identityProvider.findFirst({ where: { id, organizationId: orgId } });
    if (!p) throw new NotFoundException('Fournisseur introuvable.');
    if (p.type === 'SAML') {
      const entryOk = Boolean(p.samlEntryPoint);
      const certOk = Boolean(p.samlIdpCert && /-----BEGIN CERTIFICATE-----/.test(p.samlIdpCert));
      return {
        ok: entryOk && certOk,
        entryPointConfigured: entryOk,
        idpCertConfigured: certOk,
        error: entryOk && certOk ? undefined : 'SSO URL et/ou certificat IdP manquant.',
      };
    }
    if (!p.oidcDiscoveryUrl) {
      return { ok: false, error: 'Discovery URL non configurée.' };
    }
    const disc = await this.oidc.testDiscovery(p.oidcDiscoveryUrl);
    const secretOk = this.secretConfiguredFor(Boolean(p.oidcClientSecretEnc));
    const certOk = Boolean(p.oidcPrivateKeyEnc && p.oidcCertThumbprint);
    const authOk = secretOk || certOk;
    return {
      ok: disc.ok && authOk && Boolean(p.oidcClientId),
      issuer: disc.issuer,
      discoveryOk: disc.ok,
      clientIdConfigured: Boolean(p.oidcClientId),
      clientSecretConfigured: secretOk,
      certAuthConfigured: certOk,
      error: disc.error,
    };
  }
}
