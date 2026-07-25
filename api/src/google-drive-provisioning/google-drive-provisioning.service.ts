import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import {
  GoogleTokenProvider,
  SaKeyTokenProvider,
  WifTokenProvider,
  generateWifKeypair,
} from '../google-chat-provisioning/google-token-provider';
import { DRIVE_WRITE_SCOPE, GoogleDriveClient } from './google-drive-client';

const PRIVATE_KEY_KEY = 'gdrive.provisioning.privateKey';
const WIF_SIGNING_KEY_KEY = 'gdrive.provisioning.wifSigningKey';

/** Mode d'authentification vers Google (voir `google-token-provider`). */
export type GoogleAuthMode = 'sa_key' | 'wif';

/** Config résolue du provisioning Google Drive (clés OrgSetting `gdrive.provisioning.*`). */
interface GoogleDriveConfig {
  enabled: boolean;
  authMode: GoogleAuthMode;
  serviceAccountEmail: string;
  subjectEmail: string;
  drivePrefix: string;
  /** Ajouter les membres du projet au Drive partagé (défaut ON). */
  invite: boolean;
  /** Rôle donné aux membres invités (`reader` par défaut — moindre privilège). */
  memberRole: 'reader' | 'writer';
  // Mode WIF uniquement.
  wifAudience: string;
  wifIssuer: string;
  wifKeyId: string;
}

/**
 * Provisioning d'un **Drive partagé Google par projet** (4ᵉ fournisseur collab,
 * après Teams, Slack et Google Chat) — l'équivalent Google du site SharePoint
 * qui accompagne une équipe Teams.
 *
 * À l'activation d'un projet, crée un Shared Drive nommé d'après le projet,
 * y ajoute les membres, puis inscrit une ligne `ProjectCollabSpace`
 * (`provider:'gdrive'`, `externalId` = driveId, `source:'provisioned'`). Le
 * provider de LECTURE (`filesources`) lit ensuite ce drive **par projet**, au
 * lieu de la racine org unique.
 *
 * ⚠️ **Deux identités volontairement séparées** : ce service écrit (scope
 * `drive`), alors que la lecture des documents reste sur `drive.readonly`. La
 * config vit dans son propre namespace `gdrive.provisioning.*` — un client peut
 * provisionner sans activer Google Chat, et inversement.
 *
 * ⚠️ Créer un Drive partagé exige un **acteur humain réel** : le compte de
 * service seul ne suffit pas, d'où l'impersonation domain-wide (`subjectEmail`)
 * obligatoire dans les deux modes d'auth. L'utilisateur impersonné doit avoir le
 * droit de créer des Drives partagés (paramètre Workspace).
 */
@Injectable()
export class GoogleDriveProvisioningService {
  private readonly logger = new Logger(GoogleDriveProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly tenantUrl: TenantUrlService,
  ) {}

  private async getConfig(orgId: string): Promise<GoogleDriveConfig> {
    const all = await this.settings.getAll(orgId);
    const str = (k: string, d: string) => (typeof all[k] === 'string' ? (all[k] as string).trim() : d);
    const authMode: GoogleAuthMode = all['gdrive.provisioning.authMode'] === 'wif' ? 'wif' : 'sa_key';
    return {
      enabled: all['gdrive.provisioning.enabled'] === true,
      authMode,
      serviceAccountEmail: str('gdrive.provisioning.serviceAccountEmail', ''),
      subjectEmail: str('gdrive.provisioning.subjectEmail', ''),
      drivePrefix: str('gdrive.provisioning.drivePrefix', 'Projet '),
      invite: all['gdrive.provisioning.invite'] !== false, // défaut ON
      memberRole: all['gdrive.provisioning.memberRole'] === 'writer' ? 'writer' : 'reader',
      wifAudience: str('gdrive.provisioning.wifAudience', ''),
      wifIssuer: str('gdrive.provisioning.wifIssuer', ''),
      wifKeyId: str('gdrive.provisioning.wifKeyId', ''),
    };
  }

  /**
   * Construit le provider de jeton selon le mode d'auth. Le scope d'écriture est
   * porté par le **credential** (les implémentations lisent `cred.scopes`).
   */
  private async buildTokenProvider(orgId: string, cfg: GoogleDriveConfig): Promise<GoogleTokenProvider> {
    if (!cfg.serviceAccountEmail || !cfg.subjectEmail) {
      throw new BadRequestException('Configuration incomplète (compte de service / utilisateur impersonné).');
    }
    const scopes = [DRIVE_WRITE_SCOPE];
    if (cfg.authMode === 'wif') {
      if (!cfg.wifAudience || !cfg.wifIssuer || !cfg.wifKeyId) {
        throw new BadRequestException(
          "Mode Workload Identity : audience du pool, issuer et clé de signature requis (générer la clé, puis renseigner l'audience).",
        );
      }
      const signingKeyPem = await this.settings.getDecryptedSecret(orgId, WIF_SIGNING_KEY_KEY);
      if (!signingKeyPem) {
        throw new BadRequestException('Mode Workload Identity : clé de signature non générée (bouton « Générer la clé »).');
      }
      return new WifTokenProvider({
        serviceAccountEmail: cfg.serviceAccountEmail,
        subjectEmail: cfg.subjectEmail,
        wifAudience: cfg.wifAudience,
        issuer: cfg.wifIssuer,
        keyId: cfg.wifKeyId,
        signingKeyPem,
        scopes,
      });
    }
    const privateKeyPem = await this.settings.getDecryptedSecret(orgId, PRIVATE_KEY_KEY);
    if (!privateKeyPem) throw new BadRequestException('Clé privée du compte de service non configurée.');
    return new SaKeyTokenProvider({
      clientEmail: cfg.serviceAccountEmail,
      privateKeyPem,
      subjectEmail: cfg.subjectEmail,
      scopes,
    });
  }

  private async buildClient(orgId: string, cfg: GoogleDriveConfig): Promise<GoogleDriveClient> {
    return new GoogleDriveClient(await this.buildTokenProvider(orgId, cfg));
  }

  /** Nom du Drive partagé : préfixe + nom de projet. */
  static driveName(prefix: string, projectName: string): string {
    return `${prefix}${projectName}`.trim().slice(0, 100);
  }

  /** Emails des membres humains du projet (membres directs + équipes affectées). */
  private async memberEmails(projectId: string): Promise<string[]> {
    const emails = new Set<string>();
    const human = { status: 'ACTIVE' as const, kind: 'HUMAN' as const };
    const pms = await this.prisma.projectMember.findMany({
      where: { projectId, user: human },
      select: { user: { select: { email: true } } },
    });
    for (const pm of pms) if (pm.user.email) emails.add(pm.user.email);
    const pts = await this.prisma.projectTeam.findMany({
      where: { projectId },
      select: {
        team: { select: { members: { where: { user: human }, select: { user: { select: { email: true } } } } } },
      },
    });
    for (const pt of pts) {
      for (const tm of pt.team.members) if (tm.user.email) emails.add(tm.user.email);
    }
    return [...emails];
  }

  /** Ajoute les membres du projet au Drive. Best-effort, jamais bloquant. */
  private async addMembers(
    client: GoogleDriveClient,
    driveId: string,
    projectId: string,
    role: 'reader' | 'writer',
  ): Promise<{ invited: number; already: number; errors: string[] }> {
    const emails = await this.memberEmails(projectId);
    const out = { invited: 0, already: 0, errors: [] as string[] };
    for (const email of emails) {
      try {
        await client.addMember(driveId, email, role);
        out.invited++;
      } catch (e) {
        const msg = (e as Error).message;
        if (/already|duplicate/i.test(msg)) out.already++;
        else {
          out.errors.push(`${email}: ${msg}`);
          this.logger.warn(`Google Drive member add failed for ${email} on drive=${driveId}: ${msg}`);
        }
      }
    }
    return out;
  }

  /** Teste l'auth configurée (bouton « Tester » de la carte admin). */
  async testConnection(orgId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const cfg = await this.getConfig(orgId);
      const client = await this.buildClient(orgId, cfg);
      await client.testConnection();
      const how = cfg.authMode === 'wif' ? 'Workload Identity' : 'clé de compte de service';
      return { ok: true, message: `Connecté via ${how} (impersonation ${cfg.subjectEmail}).` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * Hook d'activation de projet — best-effort, jamais bloquant (comme Slack et
   * Google Chat). Le gating (toggle org, config) est fait dans `provisionForProject`.
   */
  async onProjectActivated(orgId: string, projectId: string): Promise<void> {
    try {
      await this.provisionForProject(orgId, projectId);
    } catch (e) {
      this.logger.warn(`Google Drive provisioning failed for project=${projectId}: ${(e as Error).message}`);
    }
  }

  /**
   * Provisionne le Drive partagé d'un projet. Idempotent : si une ligne existe
   * déjà, on ne recrée pas le Drive mais on re-synchronise les membres (sens de
   * « Re-synchroniser » côté UI).
   */
  async provisionForProject(
    orgId: string,
    projectId: string,
  ): Promise<{ status: 'skipped' | 'done'; reason?: string; driveId?: string }> {
    const cfg = await this.getConfig(orgId);
    if (!cfg.enabled) return { status: 'skipped', reason: 'Google Drive provisioning disabled' };

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, kind: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (project.kind !== 'STANDARD') return { status: 'skipped', reason: 'Projet externe' };

    const existing = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'gdrive' },
      select: { id: true, externalId: true },
    });
    if (existing) {
      if (!existing.externalId) {
        return { status: 'skipped', reason: 'Drive partagé déjà lié (id inconnu)' };
      }
      if (!cfg.invite) {
        return { status: 'skipped', reason: 'Drive déjà provisionné (invitation désactivée)', driveId: existing.externalId };
      }
      const rc = await this.buildClient(orgId, cfg);
      const r = await this.addMembers(rc, existing.externalId, projectId, cfg.memberRole);
      this.logger.log(
        `Google Drive reconcile: project=${projectId} drive=${existing.externalId} added=${r.invited} already=${r.already} errors=${r.errors.length}`,
      );
      return {
        status: 'done',
        reason: `Membres re-synchronisés (${r.invited} ajouté(s), ${r.already} déjà présent(s), ${r.errors.length} en erreur)`,
        driveId: existing.externalId,
      };
    }

    const client = await this.buildClient(orgId, cfg);
    const name = GoogleDriveProvisioningService.driveName(cfg.drivePrefix, project.name);
    this.logger.log(`Google Drive provisioning: creating shared drive "${name}" for project=${projectId}`);

    let drive;
    try {
      drive = await client.createSharedDrive(name);
    } catch (e) {
      throw new BadRequestException(`Création du Drive partagé refusée : ${(e as Error).message}`);
    }

    let invited = 0;
    let errored = 0;
    if (cfg.invite) {
      const r = await this.addMembers(client, drive.id, projectId, cfg.memberRole);
      invited = r.invited;
      errored = r.errors.length;
    }

    await this.prisma.projectCollabSpace.create({
      data: {
        organizationId: orgId,
        projectId,
        provider: 'gdrive',
        externalId: drive.id,
        url: `https://drive.google.com/drive/folders/${drive.id}`,
        name: drive.name ?? name,
        source: 'provisioned',
      },
    });
    this.logger.log(
      `Google Drive provisioning done: project=${projectId} drive=${drive.id} added=${invited} errors=${errored}`,
    );
    return {
      status: 'done',
      reason: `Drive partagé créé (${invited} membre(s) ajouté(s)${errored ? `, ${errored} en erreur` : ''})`,
      driveId: drive.id,
    };
  }

  /**
   * Supprime le Drive partagé d'un projet côté Google PUIS délie la ligne locale.
   * **Destructif et définitif** (Drive n'a pas d'archivage). Si le Drive a déjà
   * disparu (404), on délie quand même localement (idempotent).
   */
  async deleteSpaceForProject(
    orgId: string,
    projectId: string,
  ): Promise<{ status: 'deleted' | 'skipped'; reason: string }> {
    const cfg = await this.getConfig(orgId);
    const existing = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'gdrive' },
      select: { id: true, externalId: true },
    });
    if (!existing) return { status: 'skipped', reason: 'Aucun Drive partagé lié à ce projet.' };

    if (existing.externalId) {
      const client = await this.buildClient(orgId, cfg);
      try {
        await client.deleteDrive(existing.externalId);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/NOT_FOUND|HTTP 404|notFound/i.test(msg)) {
          throw new BadRequestException(`Suppression du Drive partagé refusée : ${msg}`);
        }
        this.logger.warn(`Google Drive already gone for project=${projectId}: ${msg}`);
      }
    }
    await this.prisma.projectCollabSpace.deleteMany({
      where: { organizationId: orgId, projectId, provider: 'gdrive' },
    });
    this.logger.log(`Google Drive deleted: project=${projectId} drive=${existing.externalId ?? '(unknown)'}`);
    return { status: 'deleted', reason: 'Drive partagé supprimé et délié.' };
  }

  /**
   * Génère (ou régénère) la paire de clés RS256 du mode WIF. Persiste la clé
   * privée chiffrée, expose le JWKS public et le `kid` à coller côté Google.
   */
  async generateWifKey(
    orgId: string,
    actor?: { id?: string; email?: string },
  ): Promise<{ keyId: string; jwks: unknown; issuer: string }> {
    const { privateKeyPem, keyId, jwks } = await generateWifKeypair();
    const issuer = `${this.tenantUrl.publicBaseUrl()}/federation/gdrive-provisioning`;
    await this.settings.upsertMany(
      orgId,
      {
        [WIF_SIGNING_KEY_KEY]: privateKeyPem,
        'gdrive.provisioning.wifKeyId': keyId,
        'gdrive.provisioning.wifIssuer': issuer,
        'gdrive.provisioning.wifJwksPublic': JSON.stringify(jwks),
      },
      actor,
    );
    return { keyId, jwks, issuer };
  }

  /**
   * Drive partagé provisionné pour un projet, s'il existe. Consommé par le
   * provider de LECTURE pour scoper les documents au projet.
   */
  async driveIdForProject(orgId: string, projectId: string): Promise<string | null> {
    const row = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'gdrive' },
      select: { externalId: true },
    });
    return row?.externalId ?? null;
  }
}
