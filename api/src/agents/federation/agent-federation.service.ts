import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { decodeJwt } from 'jose';
import { permissionsForCapabilities, type Permission } from '@vaks-pm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenancy/tenant-context.service';
import { ApiTokensService } from '../../api-tokens/api-tokens.service';
import { LicenseService } from '../../licensing/license.service';
import { AuditLogService } from '../../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../../audit-logs/audit-actions';
import {
  AgentFederationVerifier,
  FederationVerifyError,
  type TrustIssuerConfig,
} from './agent-federation.verifier';

/**
 * Fédération d'identité des agents — orchestration de l'échange RFC 8693.
 *
 * Principe : l'agent ne détient aucun secret. Il présente le JWT que sa
 * plateforme d'exécution lui délivre ; on le vérifie, on résout l'identité
 * locale, on applique les portes de gouvernance, et on émet un `vaks_pat_` de
 * courte durée. Le jeton émis est un PAT **ordinaire** — validé par
 * `ApiTokensService.verify` puis `JwtAuthGuard`/`PermissionsGuard` comme
 * n'importe quel autre. Aucun guard, aucun RBAC, aucun chemin d'audit n'a été
 * modifié pour ce chantier.
 *
 * Invariant repris de `AGENTS_ARCHITECTURE.md` : un JWT valide n'accorde JAMAIS
 * de droits à lui seul. L'agent doit préexister ET avoir été activé par un
 * humain (trustLevel > DRAFT_ONLY, capabilities posées). La fédération remplace
 * la distribution du secret, pas la décision d'activation.
 */

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPES = new Set([
  'urn:ietf:params:oauth:token-type:jwt',
  'urn:ietf:params:oauth:token-type:id_token',
  'urn:ietf:params:oauth:token-type:access_token',
]);
const ISSUED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

const MIN_TTL_SEC = 300;
const MAX_TTL_SEC = 3600;

export interface TokenExchangeParams {
  subject_token?: string;
  subject_token_type?: string;
  requested_token_type?: string;
  scope?: string;
  audience?: string;
  resource?: string;
}

export interface TokenExchangeResult {
  access_token: string;
  issued_token_type: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  deletedAt: Date | null;
  trustLevel: string | null;
  ownerId: string | null;
  capabilities: string[];
  idpSource: string | null;
}

@Injectable()
export class AgentFederationService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentFederationService.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: AgentFederationVerifier,
    private readonly apiTokens: ApiTokensService,
    private readonly audit: AuditLogService,
    private readonly tenant: TenantContext,
    private readonly licenses: LicenseService,
    config: ConfigService,
  ) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => this.logger.error(`redis error: ${e.message}`));
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  static readonly GRANT_TYPE = GRANT_TYPE;

  // ── Erreurs au format RFC 6749 §5.2 ───────────────────────────────────────
  // Un objet passé à une HttpException Nest devient le corps de réponse tel
  // quel — on obtient donc `{error, error_description}` sans filtre dédié. Les
  // clients de token exchange (SDK cloud, Vault, SPIFFE) l'exigent ; le reste du
  // module OAuth ne renvoie que des exceptions Nest francisées, et n'est pas
  // touché ici.

  private invalidRequest(desc: string): never {
    throw new BadRequestException({ error: 'invalid_request', error_description: desc });
  }

  private invalidGrant(desc: string): never {
    throw new UnauthorizedException({ error: 'invalid_grant', error_description: desc });
  }

  /**
   * Échange un JWT de plateforme contre un PAT court. Appelé par
   * `OAuthService.token()` sur le grant RFC 8693.
   */
  async exchange(params: TokenExchangeParams): Promise<TokenExchangeResult> {
    const rawToken = params.subject_token?.trim();
    if (!rawToken) this.invalidRequest('subject_token requis.');

    const stt = params.subject_token_type?.trim();
    if (stt && !SUBJECT_TOKEN_TYPES.has(stt)) {
      this.invalidRequest(`subject_token_type non supporté : ${stt}`);
    }
    if (params.requested_token_type && params.requested_token_type !== ISSUED_TOKEN_TYPE) {
      this.invalidRequest('requested_token_type non supporté.');
    }

    // 1. Lecture NON vérifiée, uniquement pour retrouver la config d'émetteur.
    //    Aucune confiance n'est accordée à ces valeurs : la vérification
    //    cryptographique ci-dessous re-contrôle `iss` et `aud` contre la ligne
    //    trouvée. C'est le fonctionnement normal — il faut bien identifier
    //    l'émetteur avant de savoir quelle clé lui appliquer.
    let unverified: { iss?: string; aud?: string | string[] };
    try {
      unverified = decodeJwt(rawToken);
    } catch {
      this.invalidGrant('subject_token illisible.');
    }
    const iss = unverified!.iss;
    if (!iss) this.invalidGrant('subject_token sans émetteur (`iss`).');

    const audList = Array.isArray(unverified!.aud)
      ? unverified!.aud
      : unverified!.aud
        ? [unverified!.aud]
        : [];

    // 2. Sélection de l'émetteur : (iss, aud) doit désigner exactement une ligne.
    const candidates = (await this.prisma.agentTrustIssuer.findMany({
      where: { issuer: iss, enabled: true },
    })) as unknown as (TrustIssuerConfig & {
      organizationId: string;
      idpSource: string;
      tokenTtlSec: number;
      autoDeclare: boolean;
      defaultOwnerId: string | null;
      label: string;
    })[];

    const matched = candidates.filter((c) => audList.includes(c.audience));
    if (matched.length === 0) {
      // On ne distingue pas « émetteur inconnu » de « audience non concordante » :
      // les deux sont un refus, et détailler renseignerait un attaquant sur la
      // configuration de confiance du tenant.
      await this.denied(null, iss, 'issuer_or_audience_unknown');
      this.invalidGrant('Émetteur ou audience non reconnu.');
    }
    if (matched.length > 1) {
      // Ambigu ⇒ on refuse plutôt que de choisir. Ne peut arriver que si
      // plusieurs organisations coexistent dans la même base tenant.
      await this.denied(null, iss, 'ambiguous_issuer');
      this.invalidGrant('Configuration de confiance ambiguë pour cet émetteur.');
    }
    const issuer = matched[0];

    // Gating open-core. Vérifié APRÈS la résolution de l'émetteur (il faut
    // l'orgId) mais AVANT toute crypto : inutile de vérifier une signature pour
    // refuser ensuite. Sans licence, les agents continuent de fonctionner avec
    // des PAT mintés par un admin — la fédération est un confort d'échelle.
    if (!(await this.licenses.hasFeature('agent-federation'))) {
      await this.denied(issuer.organizationId, iss, 'license_missing');
      throw new UnauthorizedException({
        error: 'invalid_client',
        error_description:
          "Fédération d'identité des agents non incluse dans la licence de ce déploiement.",
      });
    }

    // 3. Vérification cryptographique complète.
    let verified;
    try {
      verified = await this.verifier.verify(issuer, rawToken);
    } catch (e) {
      const code = e instanceof FederationVerifyError ? e.code : 'verify_failed';
      await this.denied(issuer.organizationId, iss, code);
      this.invalidGrant(
        e instanceof FederationVerifyError ? e.message : 'Vérification du jeton échouée.',
      );
    }

    // 4. Anti-rejeu.
    if (verified!.jti && !(await this.claimJti(issuer.id, verified!.jti, verified!.expSec))) {
      await this.denied(issuer.organizationId, iss, 'replayed');
      this.invalidGrant('Jeton déjà utilisé (rejeu).');
    }

    // 5. Résolution de l'identité locale.
    const orgId = issuer.organizationId;
    const agent = (await this.prisma.user.findFirst({
      where: {
        organizationId: orgId,
        kind: 'AGENT',
        idpSource: issuer.idpSource,
        externalId: verified!.subject,
      },
      select: {
        id: true, name: true, status: true, deletedAt: true,
        trustLevel: true, ownerId: true, capabilities: true, idpSource: true,
      },
    })) as AgentRow | null;

    if (!agent || agent.deletedAt) {
      if (!agent && issuer.autoDeclare) {
        // Déclaration SANS credential : l'agent apparaît dans l'admin en attente
        // d'activation humaine. On refuse quand même l'échange — sinon une
        // plateforme d'identité compromise fabriquerait identité ET jeton, la
        // chaîne d'escalade complète que `POST /agents` interdit déjà.
        await this.autoDeclare(orgId, issuer, verified!.subject);
        await this.denied(orgId, iss, 'auto_declared_pending_activation');
        this.invalidGrant("Agent déclaré, en attente d'activation par un administrateur.");
      }
      await this.denied(orgId, iss, 'agent_unknown');
      this.invalidGrant('Agent inconnu pour cet émetteur.');
    }

    // 6. Portes de gouvernance.
    await this.assertActivated(orgId, iss, agent!, issuer.idpSource);

    // 7. Périmètre : capabilities de l'agent, éventuellement réduites par la
    //    demande. On n'ÉLARGIT jamais : `scope` ne peut que restreindre.
    const capPerms = permissionsForCapabilities(agent!.capabilities ?? []) as Permission[];
    const requested = (params.scope ?? '').split(/\s+/).filter(Boolean);
    const scopes = requested.length
      ? capPerms.filter((p) => requested.includes(p))
      : capPerms;
    if (scopes.length === 0) {
      await this.denied(orgId, iss, 'empty_scope');
      this.invalidGrant("Aucun périmètre accordable (capabilities de l'agent vides ou scope demandé disjoint).");
    }

    // 8. Émission.
    const ttl = Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, issuer.tokenTtlSec || MAX_TTL_SEC));
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const minted = await this.apiTokens.create(orgId, 'USER', {
      userId: agent!.id,
      createdById: agent!.id,
      // Audit dédié plus bas : un `apiToken.created` CRITICAL par heure et par
      // agent noierait le journal.
      skipAudit: true,
      dto: {
        name: `Federated (${issuer.label})`,
        scopes,
        expiresAt,
        source: 'federation',
      },
    });

    // 9. Un seul PAT fédéré vivant par agent : le précédent est révoqué. Même
    //    logique que la rotation OAuth — un agent compromis ne cumule pas des
    //    dizaines de credentials valides, et la purge a moins à ramasser.
    await this.revokePreviousFederated(orgId, agent!.id, minted.id);

    void this.prisma.agentTrustIssuer
      .update({ where: { id: issuer.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_FEDERATION_EXCHANGED,
      severity: 'INFO',
      actorType: 'AGENT',
      actorId: agent!.id,
      actorLabel: agent!.name,
      resourceType: 'agent',
      resourceId: agent!.id,
      resourceLabel: agent!.name,
      detail: {
        issuer: iss,
        issuerId: issuer.id,
        jti: verified!.jti,
        tokenId: minted.id,
        scopes,
        ttlSec: ttl,
      },
    });

    return {
      access_token: minted.token,
      issued_token_type: ISSUED_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: scopes.join(' '),
    };
  }

  /** Portes d'activation — un JWT valide ne suffit jamais. */
  private async assertActivated(
    orgId: string,
    iss: string,
    agent: AgentRow,
    issuerIdpSource: string,
  ): Promise<void> {
    if (agent.status !== 'ACTIVE') {
      await this.denied(orgId, iss, 'agent_suspended', agent.id);
      this.invalidGrant('Agent suspendu.');
    }
    if (!agent.trustLevel || agent.trustLevel === 'DRAFT_ONLY') {
      await this.denied(orgId, iss, 'agent_not_activated', agent.id);
      this.invalidGrant("Agent non activé : un administrateur doit lui accorder un niveau de confiance.");
    }
    if (!agent.capabilities?.length) {
      await this.denied(orgId, iss, 'agent_no_capabilities', agent.id);
      this.invalidGrant("Agent sans capability : aucun droit ne peut être accordé.");
    }
    // Garde en profondeur : un agent ne peut être authentifié que par un
    // émetteur dont l'`idpSource` correspond à sa provenance. Confine un
    // émetteur mal déclaré à son propre périmètre — il ne peut pas usurper les
    // agents venus d'un autre annuaire.
    if (agent.idpSource !== issuerIdpSource) {
      await this.denied(orgId, iss, 'provenance_mismatch', agent.id);
      this.invalidGrant("Cet émetteur n'est pas habilité pour la provenance de cet agent.");
    }
    // L'agent meurt avec son responsable — même règle que `ApiTokensService.verify`,
    // appliquée ici pour refuser AVANT d'émettre plutôt qu'à l'usage.
    if (!agent.ownerId) {
      await this.denied(orgId, iss, 'owner_missing', agent.id);
      this.invalidGrant('Agent sans responsable humain.');
    }
    const owner = await this.prisma.user.findFirst({
      where: {
        id: agent.ownerId,
        organizationId: orgId,
        kind: 'HUMAN',
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!owner) {
      await this.denied(orgId, iss, 'owner_inactive', agent.id);
      this.invalidGrant('Le responsable humain de cet agent est inactif.');
    }
  }

  /**
   * Anti-rejeu : `SET NX EX` sur le `jti`, borné par la durée de vie restante du
   * JWT (au-delà, il est de toute façon expiré).
   *
   * **Fail-open assumé** : une panne Redis laisse passer. C'est la règle de la
   * maison (rate-limiter, alerting audit) et le bon arbitrage ici — le rejeu
   * suppose déjà un jeton capturé, alors qu'un fail-closed couperait toute la
   * flotte d'agents au moindre hoquet du cache. L'incident est journalisé.
   */
  private async claimJti(issuerId: string, jti: string, expSec: number): Promise<boolean> {
    const slug = this.tenant.currentSlug() ?? '_';
    const ttl = Math.max(60, Math.min(MAX_TTL_SEC, expSec - Math.floor(Date.now() / 1000)));
    try {
      const res = await this.redis.set(`agentfed:${slug}:${issuerId}:${jti}`, '1', 'EX', ttl, 'NX');
      return res === 'OK';
    } catch (e) {
      this.logger.warn(`replay guard unavailable, allowing exchange: ${(e as Error).message}`);
      return true;
    }
  }

  /** Révoque les PAT fédérés antérieurs de cet agent (best-effort). */
  private async revokePreviousFederated(orgId: string, agentId: string, keepId: string): Promise<void> {
    try {
      await this.prisma.apiToken.updateMany({
        where: {
          organizationId: orgId,
          userId: agentId,
          type: 'USER',
          source: 'federation',
          revokedAt: null,
          id: { not: keepId },
        },
        data: { revokedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(`could not revoke previous federated tokens: ${(e as Error).message}`);
    }
  }

  /** Déclare un agent inconnu en DRAFT_ONLY, SANS jeton. */
  private async autoDeclare(
    orgId: string,
    issuer: { idpSource: string; defaultOwnerId: string | null; label: string },
    externalId: string,
  ): Promise<void> {
    if (!issuer.defaultOwnerId) return;
    const owner = await this.prisma.user.findFirst({
      where: {
        id: issuer.defaultOwnerId,
        organizationId: orgId,
        kind: 'HUMAN',
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!owner) return;
    const name = `${issuer.label} — ${externalId.slice(0, 24)}`;
    try {
      await this.prisma.user.create({
        data: {
          organizationId: orgId,
          email: `agent-fed-${externalId.slice(0, 20).toLowerCase()}@agents.invalid`,
          name,
          kind: 'AGENT',
          trustLevel: 'DRAFT_ONLY',
          capabilities: [],
          ownerId: owner.id,
          idpSource: issuer.idpSource,
          externalId,
          createdVia: 'agent',
          status: 'ACTIVE',
          licensed: false,
          isAdmin: false,
          allowLocalLogin: false,
          authProvider: 'LOCAL',
          passwordHash: null,
        },
      });
      void this.audit.logCritical({
        organizationId: orgId,
        action: AUDIT_ACTIONS.AGENT_CREATED,
        actorId: null,
        resourceType: 'agent',
        resourceLabel: name,
        detail: { via: 'federation_auto_declare', idpSource: issuer.idpSource, externalId },
      });
    } catch (e) {
      // Course entre deux échanges simultanés : la contrainte unique
      // `(organizationId, idpSource, externalId)` tranche, on ignore.
      this.logger.warn(`auto-declare skipped: ${(e as Error).message}`);
    }
  }

  /** Trace de refus — WARNING, c'est ce qu'on veut voir remonter au SIEM. */
  private async denied(
    orgId: string | null,
    iss: string,
    reason: string,
    agentId?: string,
  ): Promise<void> {
    if (!orgId) {
      this.logger.warn(`federation denied (${reason}) for issuer ${iss}`);
      return;
    }
    this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_FEDERATION_DENIED,
      severity: 'WARNING',
      actorType: 'AGENT',
      actorId: agentId ?? null,
      outcome: 'FAILURE',
      resourceType: 'agent',
      resourceId: agentId,
      detail: { issuer: iss, reason },
    });
  }
}
