import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { isBlockedHost as isBlockedHostShared } from '../common/url-guard';
import { isIP, BlockList } from 'node:net';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { getWebhookQueue } from './webhook-queue';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS, severityForAction } from '../audit-logs/audit-actions';

/** Appelant d'une opération de gestion de webhook (pour l'autorisation). */
export interface WebhookCaller {
  userId: string;
  isAdmin: boolean;
}

export type WebhookEvent =
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  | 'task.moved'
  | 'task.assigned'
  | 'task.unassigned'
  | 'task.completed'
  // Cycle de vie agents (chantier 2)
  | 'task.claimed'
  | 'task.released'
  | 'task.review_requested'
  | 'task.changes_requested'
  | 'task.approved'
  | 'deliverable.submitted'
  | 'deliverable.reviewed'
  | 'comment.created'
  | 'project.created'
  | 'project.updated'
  // Passage du projet à ACTIVE (transition, pas une simple mise à jour) — c'est
  // le déclencheur qu'un provisioner externe attend pour créer l'espace de
  // collaboration puis le déclarer via `PUT /projects/:id/collab-spaces/:provider`.
  | 'project.activated'
  | 'project.announcement'
  | 'skill_request.created'
  | 'skill_request.acknowledged'
  | 'skill_request.resolved'
  | 'skill_request.rejected'
  | 'skill_request.reminded'
  | 'audit.alert'
  | 'backup.failed'
  | 'automation.alert';

export const KNOWN_EVENTS: WebhookEvent[] = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.moved',
  'task.assigned',
  'task.unassigned',
  'task.completed',
  'task.claimed',
  'task.released',
  'task.review_requested',
  'task.changes_requested',
  'task.approved',
  'deliverable.submitted',
  'deliverable.reviewed',
  'comment.created',
  'project.created',
  'project.updated',
  'project.activated',
  'project.announcement',
  'skill_request.created',
  'skill_request.acknowledged',
  'skill_request.resolved',
  'skill_request.rejected',
  'skill_request.reminded',
  'audit.alert',
  'backup.failed',
  'automation.alert',
];

export type WebhookScopeType = 'ORG' | 'PROJECT' | 'TEAM';
export type WebhookFormat = 'raw' | 'teams' | 'slack';

export interface CreateWebhookDto {
  url: string;
  label?: string;
  events: string[];
  active?: boolean;
  /** Optionnel : si non fourni, on génère un secret aléatoire 32 bytes (base64). */
  secret?: string;
  /** Périmètre de routage (défaut ORG). */
  scopeType?: WebhookScopeType;
  /** projectId/teamId selon scopeType (requis si PROJECT/TEAM). */
  scopeId?: string | null;
  /** Format du payload émis (défaut 'raw'). */
  format?: WebhookFormat;
}

export interface UpdateWebhookDto {
  url?: string;
  label?: string;
  events?: string[];
  active?: boolean;
  secret?: string;
  scopeType?: WebhookScopeType;
  scopeId?: string | null;
  format?: WebhookFormat;
}

/**
 * Contexte de routage d'un event : à quel projet / équipe il se rattache.
 * Sert à ne déclencher que les webhooks dont le `scope` correspond.
 */
export interface DispatchContext {
  projectId?: string | null;
  teamId?: string | null;
}

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContext,
    private readonly settings: AdminSettingsService,
    private readonly audit: AuditLogService,
  ) {}

  // ============================================================
  // Dispatch — appelé par les autres modules (tasks, comments, …)
  // ============================================================

  /**
   * Émet un event. Pour chaque webhook actif qui souscrit à `event` (ou à "*"),
   * crée une ligne WebhookDelivery et enqueue un job BullMQ. Fire-and-forget :
   * ne jette jamais — toute erreur est loggée et silencée pour ne pas faire
   * planter la mutation métier appelante.
   */
  async dispatch(
    orgId: string,
    event: WebhookEvent,
    payload: unknown,
    ctx: DispatchContext = {},
  ): Promise<void> {
    try {
      const hooks = await this.prisma.webhook.findMany({
        where: { organizationId: orgId, active: true },
      });
      const subscribed = hooks.filter((h) => h.events.includes('*') || h.events.includes(event));
      if (subscribed.length === 0) return;

      // Périmètre de l'event : projet direct + équipes rattachées (affectées au
      // projet, ou ciblée directement pour une demande de compétence).
      const projectId = ctx.projectId ?? null;
      const teamIds = new Set<string>();
      if (ctx.teamId) teamIds.add(ctx.teamId);
      // On ne résout les équipes du projet que si un webhook TEAM existe.
      if (projectId && subscribed.some((h) => h.scopeType === 'TEAM')) {
        const links = await this.prisma.projectTeam.findMany({
          where: { projectId },
          select: { teamId: true },
        });
        links.forEach((l) => teamIds.add(l.teamId));
      }

      const targets = subscribed.filter((h) => {
        if (h.scopeType === 'PROJECT') return !!projectId && h.scopeId === projectId;
        if (h.scopeType === 'TEAM') return !!h.scopeId && teamIds.has(h.scopeId);
        return true; // ORG → tout
      });
      if (targets.length === 0) return;

      // Gouvernance autoritaire à l'envoi : on relit l'allowlist (une fois) et on
      // re-vérifie chaque cible. Une cible non conforme (SSRF/domaine/tenant Entra)
      // n'est PAS envoyée — on trace une livraison FAILED pour la visibilité.
      const [domainAllow, entraAllow] = await Promise.all([
        this.settings.getWebhookDomainAllowlist(orgId),
        this.settings.getWebhookEntraTenantAllowlist(orgId),
      ]);
      const queue = getWebhookQueue();
      for (const hook of targets) {
        let blocked: string | null = null;
        try {
          this.checkUrl(hook.url, domainAllow, entraAllow);
        } catch (e) {
          blocked = (e as Error).message;
        }
        const delivery = await this.prisma.webhookDelivery.create({
          data: {
            organizationId: orgId,
            webhookId: hook.id,
            event,
            payload: payload as never,
            ...(blocked
              ? { status: 'FAILED', error: `Bloqué par la gouvernance : ${blocked}`, attemptCount: 0 }
              : {}),
          },
        });
        if (blocked) continue; // pas d'enqueue → rien n'est émis
        await queue.add('deliver', {
          deliveryId: delivery.id,
          webhookId: hook.id,
          organizationId: orgId,
          event,
          payload,
          tenantSlug: this.tenantCtx.currentSlug(),
        });
      }
    } catch (err) {
      this.log.warn(`dispatch(${event}) failed: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // CRUD admin
  // ============================================================

  async list(orgId: string) {
    const hooks = await this.prisma.webhook.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return hooks.map(this.toDto);
  }

  async get(orgId: string, id: string) {
    const hook = await this.prisma.webhook.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!hook) throw new NotFoundException('Webhook introuvable');
    return this.toDto(hook);
  }

  /** Trace d'audit conf webhook. Configuration visible et réversible (gouvernée
   *  par l'allowlist de domaines) → WARNING bufferisé (cf. AUDIT_SEVERITY). */
  private auditHook(
    orgId: string,
    action: string,
    hookId: string,
    actorId: string | undefined,
    detail: unknown,
    label?: string,
  ): void {
    void this.audit.log({
      organizationId: orgId,
      action,
      severity: severityForAction(action),
      actorId: actorId ?? null,
      resourceType: 'webhook',
      resourceId: hookId,
      resourceLabel: label ?? null,
      detail,
    });
  }

  async create(orgId: string, dto: CreateWebhookDto, actorId?: string) {
    await this.validateUrl(orgId, dto.url);
    const events = this.validateEvents(dto.events);
    const scope = await this.validateScope(orgId, dto.scopeType, dto.scopeId);
    const secret = dto.secret?.trim() || randomBytes(32).toString('base64url');
    const hook = await this.prisma.webhook.create({
      data: {
        organizationId: orgId,
        url: dto.url.trim(),
        label: (dto.label ?? '').trim(),
        secret,
        events,
        active: dto.active ?? true,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        format: this.normFormat(dto.format),
      },
    });
    this.auditHook(orgId, AUDIT_ACTIONS.WEBHOOK_CREATED, hook.id, actorId, {
      url: hook.url,
      events,
      scopeType: hook.scopeType,
      scopeId: hook.scopeId,
    }, hook.label || hook.url);
    return this.toDto(hook);
  }

  async update(orgId: string, id: string, dto: UpdateWebhookDto, actorId?: string) {
    const before = await this.get(orgId, id);
    if (dto.url !== undefined) await this.validateUrl(orgId, dto.url);
    const events = dto.events !== undefined ? this.validateEvents(dto.events) : undefined;
    // Le scope ne change que si scopeType est fourni explicitement.
    const scope =
      dto.scopeType !== undefined
        ? await this.validateScope(orgId, dto.scopeType, dto.scopeId)
        : undefined;
    const hook = await this.prisma.webhook.update({
      where: { id },
      data: {
        url: dto.url?.trim(),
        label: dto.label?.trim(),
        events,
        active: dto.active,
        secret: dto.secret?.trim() || undefined,
        scopeType: scope?.scopeType,
        scopeId: scope ? scope.scopeId : undefined,
        format: dto.format !== undefined ? this.normFormat(dto.format) : undefined,
        // Réactivation manuelle → on repart d'une ardoise propre (clé auto-disable).
        ...(dto.active === true ? { consecutiveFailures: 0, autoDisabledAt: null } : {}),
      },
    });
    this.auditHook(orgId, AUDIT_ACTIONS.WEBHOOK_UPDATED, id, actorId, {
      ...(dto.url !== undefined && dto.url.trim() !== before.url
        ? { url: { old: before.url, new: dto.url.trim() } }
        : {}),
      ...(events !== undefined ? { events } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.secret !== undefined ? { secretChanged: true } : {}),
    }, hook.label || hook.url);
    return this.toDto(hook);
  }

  private normFormat(f?: string): WebhookFormat {
    if (f === 'teams') return 'teams';
    if (f === 'slack') return 'slack';
    return 'raw';
  }

  async remove(orgId: string, id: string, actorId?: string) {
    const before = await this.get(orgId, id);
    await this.prisma.webhook.delete({ where: { id } });
    const label = before.label || before.url;
    this.auditHook(orgId, AUDIT_ACTIONS.WEBHOOK_DELETED, id, actorId, { url: before.url }, label);
    return { id, label, deleted: true };
  }

  /** Régénère le secret d'un webhook (le récepteur devra mettre à jour sa conf). */
  async rotateSecret(orgId: string, id: string, actorId?: string) {
    await this.get(orgId, id);
    const secret = randomBytes(32).toString('base64url');
    const hook = await this.prisma.webhook.update({ where: { id }, data: { secret } });
    this.auditHook(orgId, AUDIT_ACTIONS.WEBHOOK_UPDATED, id, actorId, { secretRotated: true }, hook.label || hook.url);
    return this.toDto(hook);
  }

  // ============================================================
  // Deliveries (debug)
  // ============================================================

  async listDeliveries(orgId: string, webhookId?: string, limit = 100) {
    const take = Math.min(500, Math.max(1, limit));
    return this.prisma.webhookDelivery.findMany({
      where: { organizationId: orgId, ...(webhookId ? { webhookId } : {}) },
      orderBy: { queuedAt: 'desc' },
      take,
    });
  }

  /** Re-enqueue manuel d'une livraison (bouton "Retry" dans l'admin). */
  async retryDelivery(orgId: string, deliveryId: string) {
    const d = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, organizationId: orgId },
    });
    if (!d) throw new NotFoundException('Livraison introuvable');
    // Gouvernance autoritaire au retry : si la cible n'est plus autorisée, on refuse.
    const hook = await this.prisma.webhook.findFirst({
      where: { id: d.webhookId, organizationId: orgId },
      select: { url: true },
    });
    if (hook) await this.validateUrl(orgId, hook.url);
    const updated = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', error: null, responseStatus: null, responseBody: null },
    });
    await getWebhookQueue().add('deliver', {
      deliveryId: d.id,
      webhookId: d.webhookId,
      organizationId: d.organizationId,
      event: d.event,
      payload: d.payload,
      tenantSlug: this.tenantCtx.currentSlug(),
    });
    return updated;
  }

  /** Test depuis l'UI admin : envoie un event `ping` au webhook fourni. */
  async sendTest(orgId: string, id: string) {
    const hook = await this.prisma.webhook.findFirst({ where: { id, organizationId: orgId } });
    if (!hook) throw new NotFoundException('Webhook introuvable');
    await this.validateUrl(orgId, hook.url); // gouvernance autoritaire aussi au test
    const payload = {
      event: 'ping',
      message: 'Test webhook from Vaks PM',
      at: new Date().toISOString(),
    };
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        organizationId: orgId,
        webhookId: hook.id,
        event: 'ping',
        payload: payload as never,
      },
    });
    await getWebhookQueue().add('deliver', {
      deliveryId: delivery.id,
      webhookId: hook.id,
      organizationId: orgId,
      event: 'ping',
      payload,
      tenantSlug: this.tenantCtx.currentSlug(),
    });
    return { deliveryId: delivery.id };
  }

  // ============================================================
  // Self-service projet (scope forcé + autorisation PM/lead)
  // ============================================================

  /** Webhooks du projet (scope PROJECT:projectId). Réservé aux gestionnaires. */
  async listForProject(orgId: string, caller: WebhookCaller, projectId: string) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    const hooks = await this.prisma.webhook.findMany({
      where: { organizationId: orgId, scopeType: 'PROJECT', scopeId: projectId },
      orderBy: { createdAt: 'desc' },
    });
    return hooks.map(this.toDto);
  }

  async createForProject(
    orgId: string,
    caller: WebhookCaller,
    projectId: string,
    dto: CreateWebhookDto,
  ) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    return this.create(orgId, { ...dto, scopeType: 'PROJECT', scopeId: projectId }, caller.userId);
  }

  async updateForProject(
    orgId: string,
    caller: WebhookCaller,
    projectId: string,
    id: string,
    dto: UpdateWebhookDto,
  ) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    await this.assertWebhookInProject(orgId, projectId, id);
    // Scope verrouillé sur le projet : on ignore toute tentative de le changer.
    return this.update(orgId, id, { ...dto, scopeType: 'PROJECT', scopeId: projectId }, caller.userId);
  }

  async removeForProject(orgId: string, caller: WebhookCaller, projectId: string, id: string) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    await this.assertWebhookInProject(orgId, projectId, id);
    return this.remove(orgId, id, caller.userId);
  }

  async testForProject(orgId: string, caller: WebhookCaller, projectId: string, id: string) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    await this.assertWebhookInProject(orgId, projectId, id);
    return this.sendTest(orgId, id);
  }

  async rotateForProject(orgId: string, caller: WebhookCaller, projectId: string, id: string) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    await this.assertWebhookInProject(orgId, projectId, id);
    return this.rotateSecret(orgId, id, caller.userId);
  }

  async deliveriesForProject(
    orgId: string,
    caller: WebhookCaller,
    projectId: string,
    limit = 100,
  ) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    const hooks = await this.prisma.webhook.findMany({
      where: { organizationId: orgId, scopeType: 'PROJECT', scopeId: projectId },
      select: { id: true },
    });
    const ids = hooks.map((h) => h.id);
    if (ids.length === 0) return [];
    const take = Math.min(500, Math.max(1, limit));
    return this.prisma.webhookDelivery.findMany({
      where: { organizationId: orgId, webhookId: { in: ids } },
      orderBy: { queuedAt: 'desc' },
      take,
    });
  }

  async retryForProject(
    orgId: string,
    caller: WebhookCaller,
    projectId: string,
    deliveryId: string,
  ) {
    await this.assertCanManage(orgId, caller, 'PROJECT', projectId);
    const d = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, organizationId: orgId },
      select: { webhook: { select: { scopeType: true, scopeId: true } } },
    });
    if (!d || d.webhook.scopeType !== 'PROJECT' || d.webhook.scopeId !== projectId) {
      throw new NotFoundException('Livraison introuvable pour ce projet');
    }
    return this.retryDelivery(orgId, deliveryId);
  }

  /** Garde-fou : le webhook existe ET appartient bien à ce projet. */
  private async assertWebhookInProject(orgId: string, projectId: string, id: string) {
    const hook = await this.prisma.webhook.findFirst({
      where: { id, organizationId: orgId, scopeType: 'PROJECT', scopeId: projectId },
      select: { id: true },
    });
    if (!hook) throw new NotFoundException('Webhook introuvable pour ce projet');
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Version PUBLIQUE de {@link validateUrl}, réutilisée par d'autres modules qui
   * enregistrent une URL sortante (ex. souscriptions de nudge agent) et doivent
   * appliquer la **même** gouvernance (anti-SSRF, port allowlist, domain
   * allowlist, pin tenant Entra). Jette `BadRequestException` si non conforme.
   *
   * `allowInternalCidrs` (mode on-prem, opt-in, gaté côté appelant) : autorise
   * les IP privées matchant un de ces CIDR — jamais loopback/metadata. Vide =
   * anti-SSRF strict inchangé.
   */
  async validateExternalUrl(
    orgId: string,
    url: string,
    allowInternalCidrs: string[] = [],
  ): Promise<void> {
    const [domainAllow, entraAllow] = await Promise.all([
      this.settings.getWebhookDomainAllowlist(orgId),
      this.settings.getWebhookEntraTenantAllowlist(orgId),
    ]);
    this.checkUrl(url, domainAllow, entraAllow, this.buildInternalAllow(allowInternalCidrs));
  }

  /** BlockList à partir de CIDR "X.X.X.X/XX" (v4/v6). null si vide / aucun valide. */
  private buildInternalAllow(cidrs: string[]): BlockList | null {
    if (!cidrs || cidrs.length === 0) return null;
    const bl = new BlockList();
    let added = 0;
    for (const raw of cidrs) {
      const m = String(raw).trim().match(/^(.+)\/(\d+)$/);
      if (!m) continue;
      const addr = m[1];
      const prefix = Number(m[2]);
      const fam = isIP(addr);
      if (fam === 4 && prefix >= 0 && prefix <= 32) {
        bl.addSubnet(addr, prefix, 'ipv4');
        added++;
      } else if (fam === 6 && prefix >= 0 && prefix <= 128) {
        bl.addSubnet(addr, prefix, 'ipv6');
        added++;
      }
    }
    return added > 0 ? bl : null;
  }

  /**
   * Valide l'URL cible : protocole http(s), anti-SSRF (refuse loopback / IP
   * privées / link-local / hôtes internes), et allowlist de domaines org si
   * configurée. Async car l'allowlist est lue en base.
   */
  private async validateUrl(orgId: string, url: string): Promise<void> {
    const [domainAllow, entraAllow] = await Promise.all([
      this.settings.getWebhookDomainAllowlist(orgId),
      this.settings.getWebhookEntraTenantAllowlist(orgId),
    ]);
    this.checkUrl(url, domainAllow, entraAllow);
  }

  /**
   * Validation pure (sans I/O) d'une URL cible contre la gouvernance : protocole,
   * anti-SSRF, domain allowlist, tenant Entra. Jette `BadRequestException` si la
   * cible n'est pas autorisée. Réutilisée à la création/édition ET à chaque envoi
   * (dispatch/test/retry) pour que l'allowlist soit autoritaire en continu.
   */
  private checkUrl(
    url: string,
    domainAllow: string[],
    entraAllow: string[],
    allowInternal: BlockList | null = null,
  ): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('URL invalide');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('URL doit utiliser http:// ou https://');
    }
    // Restreint les ports aux ports HTTP(S) usuels : empêche d'utiliser un
    // webhook comme scanner de ports internes (ex. `:6379`, `:22`) — l'oracle
    // statut/timing de la livraison révélerait les services joignables.
    const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
    if (!ALLOWED_PORTS.has(parsed.port)) {
      throw new BadRequestException('Port non autorisé (seuls 80, 443, 8080, 8443 sont permis).');
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (this.isBlockedHost(host, allowInternal)) {
      throw new BadRequestException(
        'URL refusée : cible interne/privée interdite (anti-SSRF).',
      );
    }
    const allow = domainAllow;
    if (allow.length > 0) {
      const ok = allow.some((d) => host === d || host.endsWith('.' + d));
      if (!ok) {
        throw new BadRequestException(
          `Domaine non autorisé. Domaines permis : ${allow.join(', ')}`,
        );
      }
    }

    // Allowlist de tenants Entra ID (ciblé) : ne contraint que les destinations
    // Microsoft dont l'URL porte le GUID du tenant :
    //  - Incoming Webhook Teams : `*.webhook.office.com`, tenant en `…@<guid>/…`.
    //  - Power Automate (env Default) : `*.environment.api.powerplatform.com`,
    //    tenant encodé dans le host (`default<guid>` éclaté par un point).
    const POWER_SUFFIX = '.environment.api.powerplatform.com';
    const isOffice = host === 'webhook.office.com' || host.endsWith('.webhook.office.com');
    const isPowerPlatform = host.endsWith(POWER_SUFFIX);
    if (isOffice || isPowerPlatform) {
      const entra = entraAllow;
      if (entra.length > 0) {
        const found = this.entraTenantsInUrl(parsed, POWER_SUFFIX);
        if (found.length === 0) {
          throw new BadRequestException(
            'Cible Microsoft sans tenant Entra identifiable — impossible de vérifier la destination.',
          );
        }
        if (!found.some((t) => entra.includes(t))) {
          throw new BadRequestException(
            `Tenant Entra non autorisé (${found.join(', ')}). Tenants permis : ${entra.join(', ')}`,
          );
        }
      }
    }
  }

  /** Reconstruit un GUID (8-4-4-4-12) depuis 32 caractères hex. */
  private guidFromHex(hex: string): string {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Extrait les GUID de tenant Entra candidats portés par une URL Microsoft :
   *  - Teams Incoming Webhook : segment `@<guid>` dans le chemin.
   *  - Power Automate (env Default) : host `default<guid>.environment.api...`,
   *    le GUID (32 hex) étant éclaté par des points → on retire les points et on
   *    prend les 32 derniers hex (l'env Default = `Default-<tenantId>`).
   */
  private entraTenantsInUrl(parsed: URL, powerSuffix: string): string[] {
    const out = new Set<string>();
    const decoded = decodeURIComponent(parsed.pathname).toLowerCase();
    const re = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
    for (const m of decoded.matchAll(re)) out.add(m[1]);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith(powerSuffix)) {
      const flat = host.slice(0, host.length - powerSuffix.length).replace(/\./g, '');
      const tail = flat.slice(-32);
      if (/^[0-9a-f]{32}$/.test(tail)) out.add(this.guidFromHex(tail));
    }
    return [...out];
  }

  /**
   * Vrai si l'hôte est loopback / privé / link-local / interne (SSRF). Délègue
   * à `common/url-guard.ts` (implémentation unique : crochets IPv6, IPv4-mapped
   * pointée/hexa, `allowInternal` = CIDR approuvés hors loopback/metadata).
   */
  private isBlockedHost(host: string, allowInternal: BlockList | null = null): boolean {
    return isBlockedHostShared(host, allowInternal);
  }

  // ============================================================
  // Autorisation (self-service projet / équipe encadré)
  // ============================================================

  /**
   * Vrai si `caller` peut gérer un webhook de périmètre (scopeType, scopeId)
   * selon la policy org `webhooks.managePolicy`. Org Admin : toujours. ORG :
   * admin seulement. PROJECT/TEAM : PM du projet / lead de l'équipe selon policy.
   */
  async canManage(
    orgId: string,
    caller: WebhookCaller,
    scopeType: WebhookScopeType,
    scopeId: string | null,
  ): Promise<boolean> {
    if (caller.isAdmin) return true;
    if (scopeType === 'ORG') return false; // ORG réservé à l'admin
    const policy = await this.settings.getWebhookManagePolicy(orgId);
    if (policy === 'admin') return false;

    const isPortfolio = await this.hasOrgRole(orgId, caller.userId, 'PORTFOLIO_MANAGER');
    if (isPortfolio) return true;
    if (policy === 'portfolio_manager') return false;

    // policy === 'project_manager'
    if (!scopeId) return false;
    if (scopeType === 'PROJECT') {
      const pm = await this.prisma.projectMember.findFirst({
        where: { projectId: scopeId, userId: caller.userId },
        select: { role: { select: { key: true } } },
      });
      return pm?.role.key === 'PROJECT_MANAGER';
    }
    // scopeType === 'TEAM'
    const lead = await this.prisma.teamMember.findFirst({
      where: { teamId: scopeId, userId: caller.userId, isLead: true },
      select: { teamId: true },
    });
    return !!lead;
  }

  private async hasOrgRole(orgId: string, userId: string, key: string): Promise<boolean> {
    const m = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: { select: { key: true } } },
    });
    return m?.role.key === key;
  }

  private async assertCanManage(
    orgId: string,
    caller: WebhookCaller,
    scopeType: WebhookScopeType,
    scopeId: string | null,
  ): Promise<void> {
    if (!(await this.canManage(orgId, caller, scopeType, scopeId))) {
      throw new ForbiddenException(
        "Votre rôle ne permet pas de gérer les webhooks de ce périmètre.",
      );
    }
  }

  /** Valide le périmètre et vérifie que la cible existe dans l'org. */
  private async validateScope(
    orgId: string,
    scopeType?: WebhookScopeType,
    scopeId?: string | null,
  ): Promise<{ scopeType: WebhookScopeType; scopeId: string | null }> {
    const t = (scopeType ?? 'ORG').toUpperCase() as WebhookScopeType;
    if (t === 'ORG') return { scopeType: 'ORG', scopeId: null };
    if (t !== 'PROJECT' && t !== 'TEAM') {
      throw new BadRequestException(`scopeType invalide: ${scopeType}`);
    }
    const id = scopeId?.trim();
    if (!id) throw new BadRequestException('scopeId requis pour un périmètre PROJECT/TEAM');
    if (t === 'PROJECT') {
      const p = await this.prisma.project.findFirst({
        where: { id, organizationId: orgId },
        select: { id: true },
      });
      if (!p) throw new BadRequestException('Projet introuvable dans cette organisation');
    } else {
      const team = await this.prisma.team.findFirst({
        where: { id, organizationId: orgId },
        select: { id: true },
      });
      if (!team) throw new BadRequestException('Équipe introuvable dans cette organisation');
    }
    return { scopeType: t, scopeId: id };
  }

  private validateEvents(events: string[]): string[] {
    if (!Array.isArray(events) || events.length === 0) {
      throw new BadRequestException('Au moins un event est requis');
    }
    const cleaned = events.map((e) => e.trim()).filter(Boolean);
    for (const e of cleaned) {
      if (e === '*') continue;
      if (!KNOWN_EVENTS.includes(e as WebhookEvent)) {
        throw new BadRequestException(`Event inconnu: ${e}`);
      }
    }
    return Array.from(new Set(cleaned));
  }

  private toDto = (hook: {
    id: string;
    url: string;
    label: string;
    secret: string;
    events: string[];
    active: boolean;
    scopeType: string;
    scopeId: string | null;
    format: string;
    autoDisabledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) => ({
    id: hook.id,
    url: hook.url,
    label: hook.label,
    secret: hook.secret, // exposé à l'admin pour qu'il puisse le configurer côté récepteur
    events: hook.events,
    active: hook.active,
    scopeType: hook.scopeType as WebhookScopeType,
    scopeId: hook.scopeId,
    format: (hook.format === 'teams'
      ? 'teams'
      : hook.format === 'slack'
        ? 'slack'
        : 'raw') as WebhookFormat,
    autoDisabledAt: hook.autoDisabledAt,
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  });
}
