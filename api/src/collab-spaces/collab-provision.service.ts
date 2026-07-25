import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TeamsProvisioningService } from '../teams-provisioning/teams-provisioning.service';
import { SlackProvisioningService } from '../slack-provisioning/slack-provisioning.service';
import { GoogleChatProvisioningService } from '../google-chat-provisioning/google-chat-provisioning.service';
import { GoogleDriveProvisioningService } from '../google-drive-provisioning/google-drive-provisioning.service';

/** Fournisseurs de provisioning sortant exposés au niveau projet. */
export const COLLAB_PROVIDERS = ['msteams', 'slack', 'gchat', 'gdrive'] as const;
export type CollabProvider = (typeof COLLAB_PROVIDERS)[number];

/** Ligne d'état par fournisseur, consommée par l'onglet Intégrations du projet. */
export interface CollabProvisionStatusDto {
  provider: CollabProvider;
  label: string;
  /** Fournisseur activé au niveau organisation (toggle admin). */
  enabled: boolean;
  /** Un espace existe pour ce projet chez ce fournisseur. */
  provisioned: boolean;
  /** Statut détaillé (Teams : NONE/PENDING/ACTIVE/ARCHIVED/FAILED). */
  status: string;
  /** Lien vers l'espace, quand connu. */
  url: string | null;
}

const LABELS: Record<CollabProvider, string> = {
  msteams: 'Microsoft Teams',
  slack: 'Slack',
  gchat: 'Google Chat',
  gdrive: 'Google Drive (Drive partagé)',
};

/** Clé OrgSetting du toggle d'activation, par fournisseur. */
const ENABLED_KEYS: Record<CollabProvider, string> = {
  msteams: 'teams.provisioning.enabled',
  slack: 'slack.provisioning.enabled',
  gchat: 'gchat.provisioning.enabled',
  gdrive: 'gdrive.provisioning.enabled',
};

/**
 * Vue **projet** du provisioning des espaces de collaboration : agrège les trois
 * fournisseurs derrière une seule API pour l'onglet Intégrations (une tuile par
 * fournisseur, avec son logo et son bouton). Teams garde son état riche sur
 * `Project.msTeam*` ; Slack et Google Chat s'appuient sur `ProjectCollabSpace`.
 */
@Injectable()
export class CollabProvisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly teams: TeamsProvisioningService,
    private readonly slack: SlackProvisioningService,
    private readonly gchat: GoogleChatProvisioningService,
    private readonly gdrive: GoogleDriveProvisioningService,
  ) {}

  static assertProvider(p: string): CollabProvider {
    if (!(COLLAB_PROVIDERS as readonly string[]).includes(p)) {
      throw new BadRequestException(`Fournisseur inconnu : ${p}`);
    }
    return p as CollabProvider;
  }

  private async assertProject(orgId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, msTeamStatus: true, msTeamId: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
    return p;
  }

  /** État des trois fournisseurs pour un projet (une tuile chacun côté UI). */
  async status(orgId: string, projectId: string): Promise<CollabProvisionStatusDto[]> {
    const project = await this.assertProject(orgId, projectId);
    const all = await this.settings.getAll(orgId);
    const spaces = await this.prisma.projectCollabSpace.findMany({
      where: { organizationId: orgId, projectId },
      select: { provider: true, url: true },
    });
    const byProvider = new Map(spaces.map((s) => [s.provider, s.url]));

    return COLLAB_PROVIDERS.map((provider) => {
      const enabled = all[ENABLED_KEYS[provider]] === true;
      if (provider === 'msteams') {
        const status = String(project.msTeamStatus ?? 'NONE');
        return {
          provider,
          label: LABELS[provider],
          enabled,
          provisioned: status !== 'NONE' && status !== 'FAILED',
          status,
          // Teams : l'URL vit dans ProjectCollabSpace quand le worker l'a remontée.
          url: byProvider.get('msteams') ?? null,
        };
      }
      const url = byProvider.get(provider) ?? null;
      return {
        provider,
        label: LABELS[provider],
        enabled,
        provisioned: !!url,
        status: url ? 'ACTIVE' : 'NONE',
        url,
      };
    });
  }

  /**
   * Provisionne l'espace d'un fournisseur pour ce projet, **sans** transition de
   * statut (le hook automatique ne se déclenche qu'à l'entrée en ACTIVE ; rejouer
   * un aller-retour aurait des effets de bord : autre provisioning, notifications
   * sponsors, webhooks). Idempotent côté chaque service.
   */
  async provision(
    orgId: string,
    projectId: string,
    providerRaw: string,
  ): Promise<{ status: string; reason?: string }> {
    const provider = CollabProvisionService.assertProvider(providerRaw);
    await this.assertProject(orgId, projectId);
    if (provider === 'msteams') {
      // Teams passe par la file du worker (Graph asynchrone).
      return this.teams.enqueue(orgId, projectId, 'provision');
    }
    const svc =
      provider === 'slack' ? this.slack : provider === 'gdrive' ? this.gdrive : this.gchat;
    return svc.provisionForProject(orgId, projectId);
  }

  /**
   * Archive l'espace d'un fournisseur pour ce projet. Teams passe par sa file
   * worker (Graph) et conserve son état `msTeamStatus=ARCHIVED` ; Slack archive
   * le canal puis **délie** l'espace (`ProjectCollabSpace` supprimé), faute de
   * colonne de statut sur ce modèle.
   */
  async archive(
    orgId: string,
    projectId: string,
    providerRaw: string,
  ): Promise<{ status: string; reason?: string }> {
    const provider = CollabProvisionService.assertProvider(providerRaw);
    await this.assertProject(orgId, projectId);
    if (provider === 'msteams') return this.teams.enqueue(orgId, projectId, 'archive');
    if (provider === 'slack') return this.slack.archiveForProject(orgId, projectId);
    // Google Chat et Google Drive n'ont pas d'archivage : suppression ou détachement.
    throw new BadRequestException(
      `${LABELS[provider]} n'a pas d'archivage — utilisez « Supprimer l'espace » (définitif) ou « Détacher le lien ».`,
    );
  }

  /**
   * Suppression d'espace — **Google Chat uniquement** : Chat n'a pas d'archivage,
   * seule la suppression (`spaces.delete`) existe. Destructif et définitif côté
   * Google. Teams/Slack utilisent « Archiver » (réversible) à la place.
   */
  async deleteSpace(
    orgId: string,
    projectId: string,
    providerRaw: string,
  ): Promise<{ status: string; reason: string }> {
    const provider = CollabProvisionService.assertProvider(providerRaw);
    await this.assertProject(orgId, projectId);
    if (provider !== 'gchat' && provider !== 'gdrive') {
      throw new BadRequestException(
        'La suppression d’espace ne concerne que Google Chat et Google Drive. Utilisez « Archiver » pour Microsoft Teams / Slack.',
      );
    }
    return provider === 'gdrive'
      ? this.gdrive.deleteSpaceForProject(orgId, projectId)
      : this.gchat.deleteSpaceForProject(orgId, projectId);
  }

  /**
   * **Détache** le lien local sans toucher au fournisseur distant. Échappatoire
   * quand l'espace/équipe a été supprimé côté fournisseur (Teams admin, Slack,
   * Google) : archive/re-sync partent alors en 404 et le projet reste bloqué.
   * Ne fait AUCUN appel réseau — on remet juste le projet à l'état « non
   * provisionné » pour ce fournisseur, ce qui réautorise un « Provisionner
   * maintenant » propre. N'archive rien : à n'utiliser que si le distant est
   * déjà parti (d'où la confirmation côté UI).
   */
  async detach(
    orgId: string,
    projectId: string,
    providerRaw: string,
  ): Promise<{ status: 'detached'; reason: string }> {
    const provider = CollabProvisionService.assertProvider(providerRaw);
    await this.assertProject(orgId, projectId);

    // La ligne ProjectCollabSpace existe pour les trois fournisseurs (Teams la
    // pose aussi quand le worker remonte l'URL) : on la supprime dans tous les cas.
    const del = await this.prisma.projectCollabSpace.deleteMany({
      where: { organizationId: orgId, projectId, provider },
    });

    // Teams garde en plus son état riche sur Project.msTeam* : on le remet à zéro
    // pour que la tuile repasse à « Provisionner maintenant » et que l'idempotence
    // (msTeamId sentinelle) ne bloque pas une recréation ultérieure.
    if (provider === 'msteams') {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          msTeamId: null,
          msTeamStatus: 'NONE',
          msTeamProvisionedAt: null,
          msTeamSiteId: null,
          msTeamDriveId: null,
          msSpGrantStatus: 'NONE',
        },
      });
    }

    return {
      status: 'detached',
      reason: `Lien ${LABELS[provider]} détaché (${del.count} espace(s) délié(s)). Le fournisseur distant n'a pas été modifié.`,
    };
  }
}
