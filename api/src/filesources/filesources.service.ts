import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { LicenseService } from '../licensing/license.service';
import { CacheService } from '../common/cache.service';
import { FileSourceProviderRegistry } from './file-source-provider.registry';
import { ConnectorsFileSourceAdminService } from './filesources-admin.service';
import { TeamsProvisioningService } from '../teams-provisioning/teams-provisioning.service';
import {
  FileEntry,
  FileListResult,
  FileSourceContext,
  FileSourceError,
} from './file-source-provider.types';
import { extractText } from './text-extraction';

const FEATURE = 'teams-provisioning' as const;

/**
 * Audience d'une lecture de source. `agent` = contexte de travail IA (route
 * `@PublicApi`, gate `agentsEnabled`). `human` = navigation dans l'UI projet
 * (route app-privée, gate d'appartenance à la team au lieu de `agentsEnabled`).
 */
type Audience = 'agent' | 'human';

/** Projet résolu depuis une tâche, avec les coordonnées de contexte SharePoint. */
type ProjectRow = {
  id: string;
  agentsEnabled: boolean;
  spContextEnabled: boolean;
  msTeamId: string | null;
  msTeamStatus: string;
  msTeamSiteId: string | null;
  msTeamDriveId: string | null;
  msSpGrantStatus: string;
};

/**
 * Service de lecture des sources de fichiers externes par les agents IA (proxy
 * live). Résout le projet depuis une tâche (même périmètre que le work-context),
 * évalue les gates, dispatche vers le provider et sert le texte extrait.
 */
@Injectable()
export class FileSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly licenses: LicenseService,
    private readonly cache: CacheService,
    private readonly registry: FileSourceProviderRegistry,
    private readonly connectors: ConnectorsFileSourceAdminService,
    private readonly teams: TeamsProvisioningService,
  ) {}

  /** Sources disponibles + dispo (gates) pour une tâche — alimente le work-context. */
  async availabilityForTask(
    orgId: string,
    taskId: string,
  ): Promise<{ source: string; label: string; available: boolean; reason?: string }[]> {
    const project = await this.projectForTask(orgId, taskId).catch(() => null);
    const out: { source: string; label: string; available: boolean; reason?: string }[] = [];
    for (const desc of this.registry.list()) {
      let available = false;
      let reason: string | undefined;
      if (!project) {
        reason = 'FS_SOURCE_UNAVAILABLE';
      } else {
        try {
          await this.assertGates(orgId, project, desc.source);
          available = true;
        } catch (e) {
          reason = e instanceof FileSourceError ? e.code : 'FS_DISABLED';
        }
      }
      out.push({ source: desc.source, label: desc.label, available, reason });
    }
    return out;
  }

  /** Liste un dossier d'une source pour une tâche (paginé, caché 60 s). */
  async listForTask(
    orgId: string,
    taskId: string,
    source: string,
    folderId?: string,
    cursor?: string,
  ): Promise<{ source: string } & FileListResult> {
    const { project, ctx, provider } = await this.resolve(orgId, taskId, source);
    const res = await this.cache.wrap(
      [orgId, project.id, 'fs-list', source, folderId ?? '', cursor ?? ''],
      60,
      () => provider.list(ctx, { folderId, cursor }),
    );
    return { source, ...res };
  }

  /** Renvoie le texte extrait d'un fichier d'une source pour une tâche (caché 300 s). */
  async getFileForTask(
    orgId: string,
    taskId: string,
    source: string,
    itemId: string,
  ): Promise<{ source: string; document: FileEntry; truncated: boolean; content: string }> {
    const { ctx, provider } = await this.resolve(orgId, taskId, source);
    const { meta, buffer } = await provider.fetch(ctx, itemId);
    const { content, truncated } = await extractText(buffer, meta.mimeType ?? '', meta.name);
    return { source, document: meta, truncated, content };
  }

  // ------------------------------------------------------------
  // Audience HUMAINE — navigation dans l'UI projet
  // ------------------------------------------------------------

  /** Sources dispo (gates + appartenance team) pour un projet — pilote l'affichage de l'onglet. */
  async availabilityForProject(
    orgId: string,
    projectId: string,
    userId: string,
  ): Promise<{ source: string; label: string; available: boolean; reason?: string }[]> {
    const project = await this.projectById(orgId, projectId).catch(() => null);
    const out: { source: string; label: string; available: boolean; reason?: string }[] = [];
    for (const desc of this.registry.list()) {
      let available = false;
      let reason: string | undefined;
      if (!project) {
        reason = 'FS_SOURCE_UNAVAILABLE';
      } else {
        try {
          await this.assertGates(orgId, project, desc.source, 'human');
          // Appartenance à la team Microsoft = gate SPÉCIFIQUE à SharePoint. Les
          // sources autonomes (Google Drive, …) se contentent de l'accès projet
          // (déjà imposé par le controller : @ProjectAccess + project:view).
          if (desc.source === 'sharepoint') await this.assertHumanMembership(orgId, projectId, userId);
          available = true;
        } catch (e) {
          reason = e instanceof FileSourceError ? e.code : 'FS_FORBIDDEN';
        }
      }
      out.push({ source: desc.source, label: desc.label, available, reason });
    }
    return out;
  }

  /** Liste un dossier d'une source pour un humain membre de la team (paginé, caché 60 s). */
  async listForProject(
    orgId: string,
    projectId: string,
    userId: string,
    source: string,
    folderId?: string,
    cursor?: string,
  ): Promise<{ source: string } & FileListResult> {
    const { ctx, provider } = await this.resolveForProject(orgId, projectId, userId, source);
    const res = await this.cache.wrap(
      [orgId, projectId, 'fs-list', source, folderId ?? '', cursor ?? ''],
      60,
      () => provider.list(ctx, { folderId, cursor }),
    );
    return { source, ...res };
  }

  /** Texte extrait d'un fichier d'une source pour un humain membre de la team (caché 300 s). */
  async getFileForProject(
    orgId: string,
    projectId: string,
    userId: string,
    source: string,
    itemId: string,
  ): Promise<{ source: string; document: FileEntry; truncated: boolean; content: string }> {
    const { ctx, provider } = await this.resolveForProject(orgId, projectId, userId, source);
    const { meta, buffer } = await provider.fetch(ctx, itemId);
    const { content, truncated } = await extractText(buffer, meta.mimeType ?? '', meta.name);
    return { source, document: meta, truncated, content };
  }

  /** Résout provider + contexte pour un humain après gates + appartenance team. */
  private async resolveForProject(
    orgId: string,
    projectId: string,
    userId: string,
    source: string,
  ): Promise<{ project: ProjectRow; ctx: FileSourceContext; provider: NonNullable<ReturnType<FileSourceProviderRegistry['get']>> }> {
    const project = await this.projectById(orgId, projectId);
    await this.assertGates(orgId, project, source, 'human');
    // Gate d'appartenance team = SharePoint uniquement (cf. availabilityForProject).
    if (source === 'sharepoint') await this.assertHumanMembership(orgId, projectId, userId);
    return { project, ...(await this.buildResolution(orgId, project, source)) };
  }

  // ------------------------------------------------------------
  // Résolution + gates
  // ------------------------------------------------------------

  private readonly PROJECT_SELECT = {
    id: true,
    agentsEnabled: true,
    spContextEnabled: true,
    msTeamId: true,
    msTeamStatus: true,
    msTeamSiteId: true,
    msTeamDriveId: true,
    msSpGrantStatus: true,
  } as const;

  private async projectForTask(orgId: string, taskId: string): Promise<ProjectRow> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    const project = await this.prisma.project.findFirst({
      where: { id: task.projectId, organizationId: orgId },
      select: this.PROJECT_SELECT,
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    return project as ProjectRow;
  }

  private async projectById(orgId: string, projectId: string): Promise<ProjectRow> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId },
      select: this.PROJECT_SELECT,
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    return project as ProjectRow;
  }

  /**
   * Gate d'appartenance humaine : l'utilisateur doit faire partie des membres
   * invités dans la team Microsoft du projet. Un membre projet non invité (compte
   * local sans `externalId`, ou hors du mode de membership configuré) → 403.
   */
  private async assertHumanMembership(orgId: string, projectId: string, userId: string): Promise<void> {
    const memberIds = await this.teams.resolveMemberUserIds(orgId, projectId);
    if (!memberIds.has(userId)) {
      throw new FileSourceError(
        'FS_FORBIDDEN',
        "Vous ne faites pas partie de l'équipe Microsoft de ce projet.",
      );
    }
  }

  /**
   * Évalue toutes les portes de lecture. Jette `FileSourceError` si une échoue.
   * `audience='agent'` exige `agentsEnabled` (contexte IA) ; `audience='human'`
   * l'ignore (le découplage) — l'appartenance à la team est vérifiée à part.
   */
  private async assertGates(
    orgId: string,
    project: ProjectRow,
    source: string,
    audience: Audience = 'agent',
  ): Promise<void> {
    if (!this.registry.has(source)) {
      throw new FileSourceError('FS_SOURCE_UNAVAILABLE', `Source inconnue : ${source}`);
    }
    if (!(await this.licenses.hasFeature(FEATURE))) {
      throw new FileSourceError('FS_DISABLED', 'Licence requise.');
    }
    if (!project.spContextEnabled) {
      throw new FileSourceError('FS_DISABLED', 'Documents externes désactivés pour ce projet.');
    }
    if (audience === 'agent' && !project.agentsEnabled) {
      throw new FileSourceError('FS_DISABLED', 'Contexte documentaire IA désactivé pour ce projet.');
    }

    if (source === 'sharepoint') {
      const sp = await this.settings.getSharePointContextConfig(orgId);
      if (!sp.enabled) throw new FileSourceError('FS_DISABLED', 'Source SharePoint désactivée (admin).');
      if (!project.msTeamId || !['ACTIVE', 'ARCHIVED'].includes(project.msTeamStatus)) {
        throw new FileSourceError('FS_SOURCE_UNAVAILABLE', 'Team Microsoft non provisionnée.');
      }
      if (project.msSpGrantStatus !== 'GRANTED') {
        throw new FileSourceError('FS_GRANT_PENDING', "Accès SharePoint pas encore accordé.");
      }
      if (!project.msTeamDriveId) {
        throw new FileSourceError('FS_SOURCE_UNAVAILABLE', 'Drive SharePoint non résolu.');
      }
    } else {
      // Source à connecteur autonome (Google Drive, …) : un connecteur de ce
      // type doit exister ET être activé pour l'org.
      const pc = await this.connectors.resolveProviderContext(orgId, source);
      if (!pc) {
        throw new FileSourceError('FS_DISABLED', `Source « ${source} » non configurée ou désactivée.`);
      }
    }
  }

  /** Résout provider + contexte après validation des gates (audience agent, task-based). */
  private async resolve(
    orgId: string,
    taskId: string,
    source: string,
  ): Promise<{ project: ProjectRow; ctx: FileSourceContext; provider: NonNullable<ReturnType<FileSourceProviderRegistry['get']>> }> {
    const project = await this.projectForTask(orgId, taskId);
    await this.assertGates(orgId, project, source);
    return { project, ...(await this.buildResolution(orgId, project, source)) };
  }

  /** Construit `{ ctx, provider }` pour un projet déjà résolu + gates validées. */
  private async buildResolution(
    orgId: string,
    project: ProjectRow,
    source: string,
  ): Promise<{ ctx: FileSourceContext; provider: NonNullable<ReturnType<FileSourceProviderRegistry['get']>> }> {
    const provider = this.registry.get(source)!;

    // Providers à connecteur (google/s3/webdav) : config+secret déchiffrés.
    // SharePoint : géré via l'identité de provisioning (config/secret vides).
    const pc =
      source === 'sharepoint'
        ? { config: {}, secret: {} }
        : (await this.connectors.resolveProviderContext(orgId, source)) ?? { config: {}, secret: {} };

    // Drive partagé provisionné pour ce projet (s'il existe) : il prime sur la
    // racine org du connecteur — un drive par projet, comme le site SharePoint
    // d'une équipe Teams. Lu à la demande, seulement pour la source concernée.
    let gdriveId: string | null = null;
    if (source === 'google-drive') {
      const row = await this.prisma.projectCollabSpace.findFirst({
        where: { organizationId: orgId, projectId: project.id, provider: 'gdrive' },
        select: { externalId: true },
      });
      gdriveId = row?.externalId ?? null;
    }

    const ctx: FileSourceContext = {
      orgId,
      projectId: project.id,
      config: pc.config,
      secret: pc.secret,
      project: {
        msTeamId: project.msTeamId,
        msTeamSiteId: project.msTeamSiteId,
        msTeamDriveId: project.msTeamDriveId,
        gdriveId,
      },
    };
    return { ctx, provider };
  }
}
