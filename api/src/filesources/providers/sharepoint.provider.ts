import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSettingsService } from '../../admin/admin-settings.service';
import { GraphService } from '../../teams-provisioning/graph.service';
import {
  ConnectorTestResult,
  FileEntry,
  FileListResult,
  FileSourceContext,
  FileSourceError,
  FileSourceProvider,
  ProviderDescriptor,
} from '../file-source-provider.types';

const SELECT_ITEM = 'id,name,size,file,folder,lastModifiedDateTime,webUrl';

/** Résultat d'une (ré)solution de site/grant SharePoint pour un projet. */
export interface SpResolveResult {
  status: 'GRANTED' | 'PENDING' | 'FAILED';
  siteId?: string | null;
  driveId?: string | null;
  detail?: string;
}

/**
 * Provider SharePoint — première source de fichiers du seam. Lit le drive de la
 * team Microsoft Teams provisionnée par projet (proxy live, aucune copie).
 *
 * Réutilise l'identité Graph du provisioning Teams (pas de secret propre). Deux
 * modes d'identité (`teams.provisioning.sharepoint.identityMode`) :
 *  - `read_all`         : l'app provisioning porte `Sites.Read.All` → sert aussi
 *                         les lectures ; le filtrage « seulement les teams
 *                         provisionnées » est assuré par vaks-pm (drive résolu
 *                         par `msTeamDriveId`).
 *  - `selected_granter` : app « lecteur » (`Sites.Selected`) sert les lectures ;
 *                         l'app provisioning (`Sites.FullControl.All`) pose un
 *                         grant `read` sur le seul site de la team.
 */
@Injectable()
export class SharePointProvider implements FileSourceProvider {
  readonly source = 'sharepoint';
  readonly label = 'Microsoft SharePoint';
  private readonly log = new Logger(SharePointProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly graph: GraphService,
  ) {}

  describe(): ProviderDescriptor {
    return {
      source: this.source,
      label: this.label,
      blurb:
        "Lecture, par les agents IA, des documents du SharePoint de la team Microsoft Teams provisionnée pour le projet. Réutilise l'identité Graph du provisioning Teams — configurée dans « Microsoft Teams — provisioning ». Proxy live, aucune copie.",
      accent: '#038387',
      short: 'sp',
      managedElsewhere: true,
      fields: [],
    };
  }

  // ------------------------------------------------------------
  // Tokens
  // ------------------------------------------------------------

  /** Token de l'app de PROVISIONING (résolution de site + grant + lecture en read_all). */
  private async provisioningToken(orgId: string): Promise<string> {
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.tenantId || !cfg.clientId) {
      throw new FileSourceError('FS_AUTH_FAILED', 'Configuration Graph de provisioning incomplète.');
    }
    try {
      const cred = await this.settings.resolveGraphCredential(orgId, cfg.tenantId, cfg.clientId, 'teams.provisioning');
      return await this.graph.getAppToken(cred);
    } catch (e) {
      throw new FileSourceError('FS_AUTH_FAILED', `Token Graph (provisioning) indisponible : ${(e as Error).message}`);
    }
  }

  /** Token à utiliser pour les LECTURES, selon le mode d'identité. */
  private async readToken(orgId: string): Promise<string> {
    const sp = await this.settings.getSharePointContextConfig(orgId);
    if (sp.identityMode === 'read_all') return this.provisioningToken(orgId);
    // selected_granter : app lecteur minimale (Sites.Selected).
    const cfg = await this.settings.getTeamsProvisioningConfig(orgId);
    if (!cfg.tenantId || !sp.readerClientId) {
      throw new FileSourceError('FS_AUTH_FAILED', "App lecteur SharePoint non configurée (clientId).");
    }
    try {
      const cred = await this.settings.resolveGraphCredential(
        orgId,
        cfg.tenantId,
        sp.readerClientId,
        'teams.provisioning.reader',
      );
      return await this.graph.getAppToken(cred);
    } catch (e) {
      throw new FileSourceError('FS_AUTH_FAILED', `Token Graph (lecteur) indisponible : ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------
  // Résolution de site + grant (provisioning / verify / cron)
  // ------------------------------------------------------------

  /**
   * Résout le site/drive de la team et, en mode `selected_granter`, pose le grant
   * `read` pour l'app lecteur sur ce seul site. Persiste `msTeamSiteId`/`DriveId`/
   * `msSpGrantStatus` + journalise. **Ne jette jamais** (appelé fire-and-forget
   * depuis `applyResult`) — renvoie un statut lisible pour le bouton « Vérifier ».
   */
  async resolveAndGrant(orgId: string, projectId: string, teamId: string): Promise<SpResolveResult> {
    let result: SpResolveResult = { status: 'FAILED' };
    try {
      const token = await this.provisioningToken(orgId);
      // 1. Site racine du groupe.
      const siteRes = await this.graph.request(
        token,
        'GET',
        `/groups/${encodeURIComponent(teamId)}/sites/root?$select=id,webUrl`,
      );
      if (siteRes.status === 403) {
        result = { status: 'PENDING', detail: 'Accès au site refusé (grant à poser).' };
      } else if (!this.ok(siteRes.status) || !siteRes.json?.id) {
        result = { status: 'FAILED', detail: `Résolution du site échouée (HTTP ${siteRes.status}).` };
      } else {
        const siteId = String(siteRes.json.id);
        // 2. Drive par défaut du site.
        const driveRes = await this.graph.request(
          token,
          'GET',
          `/sites/${encodeURIComponent(siteId)}/drive?$select=id`,
        );
        const driveId = driveRes.json?.id ? String(driveRes.json.id) : null;
        const sp = await this.settings.getSharePointContextConfig(orgId);
        if (sp.identityMode === 'selected_granter') {
          result = await this.grantReader(orgId, token, siteId, driveId);
        } else {
          result = { status: 'GRANTED', siteId, driveId };
        }
      }
    } catch (e) {
      result = { status: 'FAILED', detail: (e as Error).message };
    }

    // Persistance + journal (best-effort).
    await this.prisma.project
      .updateMany({
        where: { id: projectId, organizationId: orgId },
        data: {
          msTeamSiteId: result.siteId ?? undefined,
          msTeamDriveId: result.driveId ?? undefined,
          msSpGrantStatus: result.status as never,
        },
      })
      .catch(() => undefined);
    await this.prisma.msTeamProvisionLog
      .create({
        data: {
          organizationId: orgId,
          projectId,
          action: 'sp.resolve',
          status: result.status === 'GRANTED' ? 'SUCCESS' : result.status === 'PENDING' ? 'PARTIAL' : 'FAILED',
          teamId,
          error: result.detail ?? null,
        },
      })
      .catch(() => undefined);
    return result;
  }

  /**
   * (Ré)tente la résolution/grant pour un projet (bouton « Vérifier l'accès » +
   * cron de retry). Charge le `msTeamId` puis délègue à `resolveAndGrant`.
   */
  async verify(orgId: string, projectId: string): Promise<SpResolveResult> {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: { msTeamId: true },
    });
    if (!p?.msTeamId) {
      throw new FileSourceError('FS_SOURCE_UNAVAILABLE', 'Team Microsoft non provisionnée pour ce projet.');
    }
    return this.resolveAndGrant(orgId, projectId, p.msTeamId);
  }

  /**
   * Test admin (bouton « Tester ») : résout/grant puis liste 1 page racine —
   * valide la chaîne complète sans passer par un agent. Ne persiste pas d'audit.
   */
  async testSharePoint(
    orgId: string,
    projectId: string,
  ): Promise<{ ok: boolean; message: string; siteId?: string | null; driveId?: string | null; itemCount?: number }> {
    const resolved = await this.verify(orgId, projectId).catch((e) => {
      throw e instanceof FileSourceError ? e : new FileSourceError('FS_SOURCE_UNAVAILABLE', (e as Error).message);
    });
    if (resolved.status !== 'GRANTED' || !resolved.driveId) {
      return {
        ok: false,
        message: resolved.detail ?? 'Accès non accordé (grant en attente).',
        siteId: resolved.siteId,
        driveId: resolved.driveId,
      };
    }
    try {
      const token = await this.readToken(orgId);
      const res = await this.graph.request(
        token,
        'GET',
        `/drives/${encodeURIComponent(resolved.driveId)}/root/children?$top=5&$select=id,name`,
      );
      if (!this.ok(res.status)) {
        return { ok: false, message: `Listing refusé (HTTP ${res.status}).`, siteId: resolved.siteId, driveId: resolved.driveId };
      }
      const itemCount = Array.isArray(res.json?.value) ? res.json.value.length : 0;
      return { ok: true, message: `OK — ${itemCount} item(s) à la racine.`, siteId: resolved.siteId, driveId: resolved.driveId, itemCount };
    } catch (e) {
      return { ok: false, message: (e as Error).message, siteId: resolved.siteId, driveId: resolved.driveId };
    }
  }

  /** Pose le grant `read` pour l'app lecteur sur un site (mode selected_granter). */
  private async grantReader(
    orgId: string,
    provisioningToken: string,
    siteId: string,
    driveId: string | null,
  ): Promise<SpResolveResult> {
    const sp = await this.settings.getSharePointContextConfig(orgId);
    if (!sp.readerClientId) {
      return { status: 'PENDING', siteId, driveId, detail: 'App lecteur non configurée.' };
    }
    const res = await this.graph.request(provisioningToken, 'POST', `/sites/${encodeURIComponent(siteId)}/permissions`, {
      body: {
        roles: ['read'],
        grantedToIdentities: [{ application: { id: sp.readerClientId, displayName: 'vaks-pm reader' } }],
      },
    });
    if (this.ok(res.status)) {
      return { status: 'GRANTED', siteId, driveId };
    }
    // 403 = l'app provisioning n'a pas Sites.FullControl.All (consentement manquant).
    const msg = res.json?.error?.message || `HTTP ${res.status}`;
    this.log.warn(`[sharepoint] grant reader failed (org=${orgId}, site=${siteId}): ${msg}`);
    return { status: 'PENDING', siteId, driveId, detail: `Grant refusé : ${msg}` };
  }

  // ------------------------------------------------------------
  // Lecture (list / fetch)
  // ------------------------------------------------------------

  async testConnection(ctx: FileSourceContext): Promise<ConnectorTestResult> {
    try {
      const token = await this.readToken(ctx.orgId);
      const driveId = ctx.project?.msTeamDriveId;
      if (!driveId) return { ok: true, detail: 'Identité résolue (aucun drive de test — team non provisionnée).' };
      const res = await this.graph.request(token, 'GET', `/drives/${encodeURIComponent(driveId)}/root?$select=id`);
      if (this.ok(res.status)) return { ok: true, detail: 'Lecture du drive OK.' };
      if (res.status === 403) return { ok: false, error: 'Accès refusé (grant à poser).' };
      return { ok: false, error: `Réponse inattendue (HTTP ${res.status}).` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async list(ctx: FileSourceContext, opts: { folderId?: string; cursor?: string }): Promise<FileListResult> {
    const driveId = ctx.project?.msTeamDriveId;
    if (!driveId) throw new FileSourceError('FS_SOURCE_UNAVAILABLE', 'Drive SharePoint non résolu pour ce projet.');
    const token = await this.readToken(ctx.orgId);
    const path = opts.cursor
      ? opts.cursor
      : opts.folderId
        ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(opts.folderId)}/children?$top=50&$select=${SELECT_ITEM}`
        : `/drives/${encodeURIComponent(driveId)}/root/children?$top=50&$select=${SELECT_ITEM}`;
    const res = await this.graph.request(token, 'GET', path);
    this.assertOk(res.status, res.headers);
    const items: FileEntry[] = (res.json?.value ?? []).map((it: any) => this.toEntry(it));
    const next = res.json?.['@odata.nextLink'] ? String(res.json['@odata.nextLink']) : null;
    return { items, nextCursor: next };
  }

  async fetch(ctx: FileSourceContext, itemId: string): Promise<{ meta: FileEntry; buffer: Buffer }> {
    const driveId = ctx.project?.msTeamDriveId;
    if (!driveId) throw new FileSourceError('FS_SOURCE_UNAVAILABLE', 'Drive SharePoint non résolu pour ce projet.');
    const token = await this.readToken(ctx.orgId);
    const base = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
    const metaRes = await this.graph.request(token, 'GET', `${base}?$select=${SELECT_ITEM}`);
    this.assertOk(metaRes.status, metaRes.headers);
    const meta = this.toEntry(metaRes.json);
    if (meta.isFolder) {
      throw new FileSourceError('FS_UNSUPPORTED_FORMAT', "L'item est un dossier, pas un fichier.");
    }
    const contentRes = await this.graph.request(token, 'GET', `${base}/content`, { binary: true });
    this.assertOk(contentRes.status, contentRes.headers);
    if (!contentRes.buffer) {
      throw new FileSourceError('FS_ITEM_NOT_FOUND', 'Contenu du fichier indisponible.');
    }
    return { meta, buffer: contentRes.buffer };
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  private ok(status: number): boolean {
    return status >= 200 && status < 300;
  }

  /** Mappe un statut Graph d'erreur en `FileSourceError`. No-op si 2xx. */
  private assertOk(status: number, headers?: Headers): void {
    if (this.ok(status)) return;
    if (status === 429) {
      const ra = headers?.get('retry-after');
      throw new FileSourceError('FS_THROTTLED', 'Microsoft Graph a limité le débit.', {
        retryAfter: ra ? Number(ra) : undefined,
      });
    }
    if (status === 403) {
      throw new FileSourceError('FS_GRANT_PENDING', "Accès SharePoint refusé (grant non posé ou révoqué).");
    }
    if (status === 404) throw new FileSourceError('FS_ITEM_NOT_FOUND', 'Item introuvable.');
    if (status === 401) throw new FileSourceError('FS_AUTH_FAILED', 'Authentification Graph refusée.');
    throw new FileSourceError('FS_SOURCE_UNAVAILABLE', `Réponse Graph inattendue (HTTP ${status}).`);
  }

  private toEntry(it: any): FileEntry {
    return {
      id: String(it?.id ?? ''),
      name: String(it?.name ?? ''),
      isFolder: !!it?.folder,
      size: typeof it?.size === 'number' ? it.size : undefined,
      mimeType: it?.file?.mimeType ? String(it.file.mimeType) : undefined,
      lastModified: it?.lastModifiedDateTime ? String(it.lastModifiedDateTime) : undefined,
      webUrl: it?.webUrl ? String(it.webUrl) : undefined,
    };
  }
}
