import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import {
  LICENSE_FEATURES,
  LICENSE_FEATURE_ALL,
  type LicenseFeature,
  type LicensePayload,
  type LicenseStatus,
  type LicenseStatusDto,
} from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { verifyV4Public } from './paseto';
import { licensePublicKeyPem, licenseTrialPublicKeyPem } from './public-key';

/** Émetteur attendu dans chaque licence — défense en profondeur (anti-réemploi). */
const EXPECTED_ISSUER = 'vaks-pm-licensing';
/** Fenêtre de grâce avant désactivation effective des features (SPEC §16.4). */
const GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Plafond dur pour tout token vérifié avec la clé **essai** (jamais la clé
 * produit). Marge au-dessus des 90 j du portail (`TRIAL_DAYS` côté Netlify)
 * pour absorber une légère dérive d'horloge — jamais assez pour approcher une
 * durée de licence payante. Défense en profondeur : même une clé essai
 * compromise ne peut pas forger une licence longue durée.
 */
const TRIAL_KEY_MAX_DAYS = 100;
/**
 * Fenêtre de grâce hors-ligne par défaut (jours) pour une licence `online.required`
 * qui ne précise pas `maxOfflineDays`. Surchargeable par l'env `LICENSE_OFFLINE_GRACE_DAYS`.
 */
const DEFAULT_OFFLINE_DAYS = Math.max(1, Number(process.env.LICENSE_OFFLINE_GRACE_DAYS) || 7);
/**
 * TTL du cache de la licence active par tenant (re-lecture DB + re-vérif).
 * Court (60 s) : la lecture est un `findFirst` indexé négligeable, et le cache
 * étant **par réplica**, `invalidate()` ne purge que le réplica courant — un TTL
 * long laissait les AUTRES réplicas servir un état périmé jusqu'à 6 h (ex. après
 * un upload admin ou une install opérateur). 60 s borne cette dérive.
 */
const CACHE_TTL_MS = 60 * 1000;

/** Parse un plafond depuis l'env (entier ≥ 0), sinon défaut. Autorise un 0 explicite. */
function envLimit(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}
/**
 * **Plafonds gratuits (freemium)** appliqués **en l'absence de licence payante
 * vivante**. La licence les lève : `maxUsers`/`maxAgents` (paliers métrés) ou la
 * feature `agents` (agents illimités). On ne borne QUE la création — les
 * comptes/agents déjà existants ne sont jamais coupés (cf. `assert*SlotAvailable`).
 */
const FREE_SEAT_LIMIT = envLimit(process.env.FREE_SEAT_LIMIT, 10);
const FREE_AGENT_LIMIT = envLimit(process.env.FREE_AGENT_LIMIT, 5);

/** Résultat évalué d'une licence pour le tenant courant. */
export interface EvaluatedLicense {
  status: LicenseStatus;
  features: LicenseFeature[];
  payload: LicensePayload | null;
  signatureValid: boolean;
  expiresAt: Date | null;
  issuedAt: Date | null;
  customer: string | null;
  maxUsers: number | null;
  notes: string | null;
  /** La licence exige un contact serveur récurrent (claim `online.required`). */
  requireOnline: boolean;
  /** Fenêtre de grâce hors-ligne (jours) pour cette licence ; null = défaut produit. */
  maxOfflineDays: number | null;
}

interface CacheEntry {
  at: number;
  /** Token brut de la ligne active observée (pour invalider si elle change). */
  token: string | null;
  evaluated: EvaluatedLicense;
}

const EMPTY: EvaluatedLicense = {
  status: 'none',
  features: [],
  payload: null,
  signatureValid: false,
  expiresAt: null,
  issuedAt: null,
  customer: null,
  maxUsers: null,
  notes: null,
  requireOnline: false,
  maxOfflineDays: null,
};

/**
 * Lecture/évaluation de la licence du **tenant courant** (open-core, SPEC §16).
 * Per-tenant : chaque base tenant porte sa propre table `License` (une seule
 * ligne `active`). Le service lit la ligne active, **re-vérifie la signature**
 * (jamais de confiance aveugle dans le snapshot), puis dérive l'état avec la
 * grace period. Cache mémoire 6 h par tenant, invalidé sur upload.
 *
 * **Permissif par conception** : toute erreur (pas de licence, signature
 * invalide, DB indisponible) ⇒ `features = []` mais ne lève jamais — le core
 * doit toujours tourner (SPEC §16.1).
 */
@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContext,
  ) {}

  private tenantKey(): string {
    return this.tenantCtx.currentSlug() ?? '__default__';
  }

  /** Invalide le cache du tenant courant (après un upload/suppression). */
  invalidate(): void {
    this.cache.delete(this.tenantKey());
  }

  /**
   * Évalue la licence active du tenant courant. Lit la DB (avec cache 6 h),
   * vérifie la signature et calcule l'état. Ne lève jamais.
   */
  async evaluate(): Promise<EvaluatedLicense> {
    const key = this.tenantKey();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.evaluated;
    }
    let row: { token: string; createdAt: Date } | null = null;
    try {
      row = await this.prisma.license.findFirst({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
        select: { token: true, createdAt: true },
      });
    } catch (err) {
      // Table absente pendant un rollout (db push pas encore passé) ou DB KO :
      // on ne bloque jamais le core.
      this.logger.warn(`Lecture licence impossible: ${(err as Error).message}`);
      return EMPTY;
    }
    const base = row ? this.evaluateToken(row.token) : EMPTY;
    const bound = await this.applyOrgBinding(base);
    const evaluated = await this.applyConnectivityGate(bound, row?.createdAt ?? null);
    this.cache.set(key, { at: Date.now(), token: row?.token ?? null, evaluated });
    return evaluated;
  }

  /** Id de l'organisation du tenant courant (épinglage + affichage admin). */
  private async currentOrgId(): Promise<string | null> {
    try {
      const org = await this.prisma.organization.findFirst({ select: { id: true } });
      return org?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * **Identité de licence** de l'installation : `Organization.licenseId`, un UUID
   * unique et immuable, distinct de `id` (slug de routage / `seed-org` partagé).
   * C'est cette valeur qui épingle une licence à une install — impossible à
   * deviner ou à faire collisionner entre deux déploiements. À ne PAS confondre
   * avec `currentOrgId()`, qui reste la clé FK réelle utilisée pour les sièges.
   */
  async currentLicenseId(): Promise<string | null> {
    try {
      const org = await this.prisma.organization.findFirst({ select: { licenseId: true } });
      return org?.licenseId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * **Épinglage à l'organisation** : si la licence porte un `organizationId`
   * (claim `--org`), elle n'est valable que pour l'organisation dont l'UUID
   * correspond. Empêche d'utiliser une licence émise pour un autre client.
   * Mismatch ⇒ `status = 'invalid'`, features coupées. L'upload rejette déjà ce
   * cas avec un message clair (cf. LicenseAdminService) ; ceci est le garde-fou
   * runtime (insertion DB directe, changement d'org…). Permissif si l'org est
   * illisible (ne bloque jamais le core par erreur d'infra).
   */
  private async applyOrgBinding(base: EvaluatedLicense): Promise<EvaluatedLicense> {
    const bound = base.payload?.organizationId;
    if (!base.signatureValid || !bound) return base;
    // Épinglage sur le licenseId (UUID unique par install), pas sur l'id d'org
    // (slug/seed-org réutilisable). Permissif si licenseId illisible (rollout).
    const licenseId = await this.currentLicenseId();
    if (licenseId && bound !== licenseId) {
      this.logger.warn(`Licence épinglée à ${bound} ≠ licenseId courant ${licenseId} → invalide.`);
      return { ...base, status: 'invalid', features: [] };
    }
    return base;
  }

  /**
   * **Gestion des sièges** : lève `ForbiddenException` si attribuer `adding`
   * siège(s) ferait dépasser le plafond `maxUsers` de la licence active.
   * **Siège = utilisateur `licensed=true` non supprimé** (source de vérité unique,
   * découplée de `status` : un compte sans siège — admin-only ou parqué — existe
   * mais ne consomme rien). Aucun plafond (`maxUsers` null) ⇒ illimité. Non
   * destructif : borne seulement les nouvelles attributions de siège. À appeler
   * avant toute **attribution** de siège (création d'un user licencié, passage
   * sans-siège→licencié, import). Le provisioning SCIM en débordement crée des
   * comptes `licensed=false` et NE passe donc PAS par ici (pas de 403 vers l'IdP).
   */
  async assertSeatAvailable(orgId: string, adding = 1): Promise<void> {
    const cap = await this.seatLimit();
    if (cap == null) return; // illimité (licence payante sans plafond)
    const active = await this.prisma.user.count({
      where: { organizationId: orgId, deletedAt: null, licensed: true },
    });
    if (active + adding > cap) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'SEAT_LIMIT_REACHED',
        message:
          `Limite de licences atteinte : ${cap} siège(s). ` +
          `Désactivez un utilisateur ou augmentez la licence avant d'en ajouter.`,
      });
    }
  }

  /**
   * **Plafond effectif de sièges humains** : sous licence payante vivante →
   * `maxUsers` (peut être `null` = illimité) ; sinon le plafond gratuit
   * `FREE_SEAT_LIMIT`. Sert à `assertSeatAvailable` et à l'affichage UI.
   */
  async seatLimit(): Promise<number | null> {
    const e = await this.evaluate();
    if (e.status === 'active' || e.status === 'grace') return e.maxUsers;
    return FREE_SEAT_LIMIT;
  }

  /** Nombre d'identités agents **vivantes** (kind=AGENT, non supprimées, non
   *  suspendues → une suspension libère un slot). Permissif (0 sur erreur). */
  async agentsUsed(orgId: string): Promise<number> {
    try {
      return await this.prisma.user.count({
        where: {
          organizationId: orgId,
          deletedAt: null,
          kind: 'AGENT',
          status: { not: 'SUSPENDED' },
        },
      });
    } catch {
      return 0;
    }
  }

  /**
   * **Plafond effectif d'agents** (3 tiers) : licence vivante **et** feature
   * `agents` → `null` (illimité) ; sinon licence vivante **et** `limits.maxAgents`
   * entier > 0 → ce palier métré ; sinon le plafond gratuit `FREE_AGENT_LIMIT`.
   */
  async agentLimit(): Promise<number | null> {
    const e = await this.evaluate();
    const live = e.status === 'active' || e.status === 'grace';
    if (live && e.features.includes('agents')) return null; // illimité
    const metered = e.payload?.limits?.maxAgents;
    if (live && typeof metered === 'number' && Number.isInteger(metered) && metered > 0) {
      return metered;
    }
    return FREE_AGENT_LIMIT;
  }

  /**
   * Lève `ForbiddenException` (`AGENT_LIMIT_REACHED`) si créer `adding` identité(s)
   * agent ferait dépasser le plafond effectif. Illimité (`agentLimit()===null`) ⇒
   * ne borne rien. À appeler **avant toute création** d'identité agent.
   */
  async assertAgentSlotAvailable(orgId: string, adding = 1): Promise<void> {
    const cap = await this.agentLimit();
    if (cap == null) return; // illimité
    const used = await this.agentsUsed(orgId);
    if (used + adding > cap) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'AGENT_LIMIT_REACHED',
        message:
          `Limite d'agents atteinte : ${cap} agent(s). ` +
          `Suspendez/supprimez un agent, ou activez une licence Agents pour en créer d'autres.`,
      });
    }
  }

  /**
   * Couche **hybride en ligne** (SPEC §16) — enforcement **porté par la licence**.
   * Si la licence active déclare `online.required`, les features premium sont
   * suspendues (`status = 'suspended'`) dès que le dernier contact réussi avec le
   * serveur de licences (`LicenseConnectivity.lastSuccessAt`) remonte à plus de
   * `maxOfflineDays`. Référence de repli quand aucun poll n'a jamais réussi (ex.
   * déploiement non provisionné — pas de clé d'activation) : la date d'activation
   * de la licence (`createdAt`) → une licence `online.required` finit donc par
   * suspendre même sans poller (fail-closed, choix produit).
   *
   * Licence sans politique en ligne ⇒ aucun effet (100 % hors-ligne). Suspension
   * uniquement pour une licence par ailleurs valide (`active`/`grace`) — le core
   * et les données restent intacts. Toute erreur (table absente, DB KO) ⇒
   * permissif : évaluation inchangée.
   */
  private async applyConnectivityGate(
    base: EvaluatedLicense,
    licenseCreatedAt: Date | null,
  ): Promise<EvaluatedLicense> {
    if (!base.requireOnline) return base;
    if (base.status !== 'active' && base.status !== 'grace') return base;
    const graceMs = (base.maxOfflineDays ?? DEFAULT_OFFLINE_DAYS) * DAY_MS;
    try {
      const conn = await this.prisma.licenseConnectivity.findUnique({
        where: { id: 1 },
        select: { lastSuccessAt: true },
      });
      const baseline = conn?.lastSuccessAt ?? licenseCreatedAt ?? new Date();
      if (Date.now() - baseline.getTime() > graceMs) {
        return { ...base, status: 'suspended', features: [] };
      }
    } catch (err) {
      this.logger.warn(`Lecture connectivité licence impossible: ${(err as Error).message}`);
    }
    return base;
  }

  /**
   * Évalue un token brut (vérif signature + claims + grace). Utilisé par
   * `evaluate()` et par l'upload admin (validation avant persistance). Public et
   * pur : ne touche pas la DB ni le cache.
   */
  evaluateToken(token: string): EvaluatedLicense {
    let payload: LicensePayload;
    let viaTrialKey = false;
    try {
      payload = verifyV4Public<LicensePayload>(token, licensePublicKeyPem());
    } catch {
      // Pas signé par la clé produit : tente la clé essai dédiée avant de
      // rejeter (cf. `public-key.ts` — deux clés distinctes, pas de fallback
      // silencieux qui ferait passer un token essai pour une licence pleine).
      try {
        payload = verifyV4Public<LicensePayload>(token, licenseTrialPublicKeyPem());
        viaTrialKey = true;
      } catch (err) {
        this.logger.warn(`Signature de licence invalide: ${(err as Error).message}`);
        return { ...EMPTY, status: 'invalid' };
      }
    }
    if (payload?.iss !== EXPECTED_ISSUER) {
      this.logger.warn(`Licence à émetteur inattendu: ${payload?.iss}`);
      return { ...EMPTY, status: 'invalid' };
    }
    const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
    const issuedAt = payload.issuedAt ? new Date(payload.issuedAt) : null;
    if (viaTrialKey) {
      const spanMs = expiresAt && issuedAt ? expiresAt.getTime() - issuedAt.getTime() : NaN;
      if (!Number.isFinite(spanMs) || spanMs <= 0 || spanMs > TRIAL_KEY_MAX_DAYS * DAY_MS) {
        this.logger.warn(
          `Licence signée par la clé essai hors plafond (${TRIAL_KEY_MAX_DAYS} j) → rejetée.`,
        );
        return { ...EMPTY, status: 'invalid' };
      }
    }
    const declared = Array.isArray(payload.features) ? payload.features : [];
    // Wildcard « all » ⇒ toutes les features connues à l'exécution (y compris
    // celles ajoutées après l'émission de la licence).
    const known: LicenseFeature[] = declared.includes(LICENSE_FEATURE_ALL)
      ? [...LICENSE_FEATURES]
      : declared.filter((f): f is LicenseFeature =>
          (LICENSE_FEATURES as readonly string[]).includes(f),
        );
    const status = this.deriveStatus(expiresAt);
    // Expirée ⇒ aucune feature active (mais token reste lisible).
    const features = status === 'expired' ? [] : known;
    const online = payload.online ?? null;
    const requireOnline = online?.required === true;
    const rawMaxOffline = online?.maxOfflineDays;
    const maxOfflineDays =
      typeof rawMaxOffline === 'number' && Number.isFinite(rawMaxOffline) && rawMaxOffline > 0
        ? Math.floor(rawMaxOffline)
        : null;
    return {
      status,
      features,
      payload,
      signatureValid: true,
      expiresAt,
      issuedAt,
      customer: payload.customer ?? null,
      maxUsers: payload.limits?.maxUsers ?? null,
      notes: payload.notes ?? null,
      requireOnline,
      maxOfflineDays,
    };
  }

  private deriveStatus(expiresAt: Date | null): LicenseStatus {
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) return 'active';
    const remainingMs = expiresAt.getTime() - Date.now();
    if (remainingMs <= 0) return 'expired';
    if (remainingMs <= GRACE_DAYS * DAY_MS) return 'grace';
    return 'active';
  }

  /**
   * Vrai si la feature premium est **active** pour le tenant courant (status
   * `active` ou `grace`). Point d'entrée du guard et des checks inline (SSO/SCIM).
   */
  async hasFeature(feature: LicenseFeature): Promise<boolean> {
    const e = await this.evaluate();
    return e.features.includes(feature);
  }

  /**
   * Sièges restants sous le **plafond effectif** (`seatLimit()` : `maxUsers` sous
   * licence, sinon le plafond gratuit `FREE_SEAT_LIMIT`) : `null` = illimité
   * (licence payante sans plafond). Sinon `max(0, cap - seatsUsed)`. Sert à
   * l'attribution **best-effort** en lot (auto-licence d'un groupe) sans jamais
   * dépasser le plafond — y compris l'offre gratuite (pas de contournement via
   * l'auto-licence d'équipe).
   */
  async seatsRemaining(orgId: string): Promise<number | null> {
    const cap = await this.seatLimit();
    if (cap == null) return null;
    const used = await this.seatsUsed(orgId);
    return Math.max(0, cap - used);
  }

  /** Nombre de sièges occupés (utilisateurs `licensed=true` non supprimés) pour
   *  l'org courante. Permissif (0 sur erreur d'infra). */
  async seatsUsed(orgId: string): Promise<number> {
    try {
      return await this.prisma.user.count({
        where: { organizationId: orgId, deletedAt: null, licensed: true },
      });
    } catch {
      return 0;
    }
  }

  /** Projection publique pour `GET /license` (UI). Jamais le token brut. */
  async status(): Promise<LicenseStatusDto> {
    const e = await this.evaluate();
    const organizationId = await this.currentOrgId();
    // Valeur affichée/copiée dans l'UI = licenseId (l'identifiant à fournir pour
    // demander une licence). Repli sur l'id réel si le backfill n'a pas encore
    // eu lieu. Les sièges, eux, restent comptés sur l'id réel (FK User).
    const licenseId = await this.currentLicenseId();
    const seatsUsed = organizationId ? await this.seatsUsed(organizationId) : null;
    const agentsUsed = organizationId ? await this.agentsUsed(organizationId) : null;
    const [seatLimit, agentLimit] = await Promise.all([this.seatLimit(), this.agentLimit()]);
    const daysRemaining =
      e.expiresAt && !Number.isNaN(e.expiresAt.getTime())
        ? Math.ceil((e.expiresAt.getTime() - Date.now()) / DAY_MS)
        : null;
    return {
      status: e.status,
      features: e.features,
      customer: e.customer,
      issuedAt: e.issuedAt ? e.issuedAt.toISOString() : null,
      expiresAt: e.expiresAt ? e.expiresAt.toISOString() : null,
      daysRemaining,
      maxUsers: e.maxUsers,
      notes: e.notes,
      signatureValid: e.signatureValid,
      requireOnline: e.requireOnline,
      organizationId: licenseId ?? organizationId,
      seatsUsed,
      seatLimit,
      agentsUsed,
      agentLimit,
    };
  }
}
