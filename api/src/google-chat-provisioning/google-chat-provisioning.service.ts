import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import { GoogleChatClient } from './google-chat-client';
import {
  CHAT_DELETE_SCOPE,
  GoogleTokenProvider,
  SaKeyTokenProvider,
  WifTokenProvider,
  generateWifKeypair,
} from './google-token-provider';

const PRIVATE_KEY_KEY = 'gchat.provisioning.privateKey';
const WIF_SIGNING_KEY_KEY = 'gchat.provisioning.wifSigningKey';

/** Mode d'authentification vers Google (voir `google-token-provider`). */
export type GoogleAuthMode = 'sa_key' | 'wif';

/** Config résolue du provisioning Google Chat (clés OrgSetting `gchat.provisioning.*`). */
interface GoogleChatConfig {
  enabled: boolean;
  authMode: GoogleAuthMode;
  serviceAccountEmail: string;
  subjectEmail: string;
  spacePrefix: string;
  invite: boolean;
  // Mode WIF uniquement.
  wifAudience: string;
  wifIssuer: string;
  wifKeyId: string;
}

/**
 * Provisioning d'espaces de collaboration **Google Chat** (3ᵉ fournisseur
 * après Teams et Slack).
 *
 * À l'activation d'un projet (`onProjectActivated`, best-effort), crée un
 * espace Chat, invite les membres (résolus par email → membre Chat), puis
 * inscrit une ligne `ProjectCollabSpace` (`source:'provisioned'`, provider
 * `gchat`). Même modèle que Slack : inline, fire-and-forget, idempotent.
 *
 * ⚠️ **Auth structurellement différente de Slack** : Google Chat exige un
 * acteur humain réel pour créer un espace et y ajouter des membres — un compte
 * de service seul n'y suffit pas. La config porte donc, en plus du compte de
 * service (clé privée), l'email d'un utilisateur Workspace **impersonné** par
 * délégation domain-wide (`subjectEmail`). Contrairement à Slack, un espace
 * Chat n'a pas de notion public/privé — pas de champ `visibility` ici.
 */
@Injectable()
export class GoogleChatProvisioningService {
  private readonly logger = new Logger(GoogleChatProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly tenantUrl: TenantUrlService,
  ) {}

  private async getConfig(orgId: string): Promise<GoogleChatConfig> {
    const all = await this.settings.getAll(orgId);
    const str = (k: string, d: string) => (typeof all[k] === 'string' ? (all[k] as string).trim() : d);
    const authMode: GoogleAuthMode = all['gchat.provisioning.authMode'] === 'wif' ? 'wif' : 'sa_key';
    return {
      enabled: all['gchat.provisioning.enabled'] === true,
      authMode,
      serviceAccountEmail: str('gchat.provisioning.serviceAccountEmail', ''),
      subjectEmail: str('gchat.provisioning.subjectEmail', ''),
      spacePrefix: str('gchat.provisioning.spacePrefix', 'proj-'),
      invite: all['gchat.provisioning.invite'] !== false, // défaut ON
      wifAudience: str('gchat.provisioning.wifAudience', ''),
      wifIssuer: str('gchat.provisioning.wifIssuer', ''),
      wifKeyId: str('gchat.provisioning.wifKeyId', ''),
    };
  }

  /**
   * Construit le provider de jeton selon le mode d'auth configuré.
   * `scopes` optionnel : par défaut `CHAT_SCOPES` (create/memberships). La
   * suppression d'espace passe `[CHAT_DELETE_SCOPE]` — non inclus par défaut
   * pour que l'absence de ce scope dans la délégation ne casse QUE la suppression.
   */
  private async buildTokenProvider(
    orgId: string,
    cfg: GoogleChatConfig,
    scopes?: string[],
  ): Promise<GoogleTokenProvider> {
    if (!cfg.serviceAccountEmail || !cfg.subjectEmail) {
      throw new BadRequestException('Configuration incomplète (compte de service / utilisateur impersonné).');
    }
    if (cfg.authMode === 'wif') {
      if (!cfg.wifAudience || !cfg.wifIssuer || !cfg.wifKeyId) {
        throw new BadRequestException(
          'Mode Workload Identity : audience du pool, issuer et clé de signature requis (générer la clé, puis renseigner l’audience).',
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

  /** Construit le client Chat depuis les settings résolus, ou lève un message actionnable. */
  private async buildClient(orgId: string, cfg: GoogleChatConfig, scopes?: string[]): Promise<GoogleChatClient> {
    return new GoogleChatClient(await this.buildTokenProvider(orgId, cfg, scopes));
  }

  /**
   * Génère (ou régénère) la paire de clés RS256 du mode WIF. Persiste la clé
   * privée chiffrée, expose le JWKS public et le `kid` à coller côté Google.
   * Régénérer invalide l'ancienne clé — le JWKS côté provider WIF doit être
   * mis à jour en conséquence.
   */
  async generateWifKey(
    orgId: string,
    actor?: { id?: string; email?: string },
  ): Promise<{ keyId: string; jwks: unknown; issuer: string }> {
    const { privateKeyPem, keyId, jwks } = await generateWifKeypair();
    // Issuer = origine RÉELLE du tenant (host unique par tenant, résolvable),
    // pas un placeholder. Google ne le résout pas (JWKS collé), il exige
    // seulement que `iss` du JWT le matche — mais l'utiliser rend l'issuer
    // unique par tenant et auto-documenté côté config Google.
    const issuer = `${this.tenantUrl.publicBaseUrl()}/federation/gchat`;
    // La clé privée passe par `plainKey` → chiffrée at-rest par upsertMany ;
    // le JWKS public et le kid ne sont pas secrets.
    await this.settings.upsertMany(
      orgId,
      {
        [WIF_SIGNING_KEY_KEY]: privateKeyPem,
        'gchat.provisioning.wifKeyId': keyId,
        'gchat.provisioning.wifIssuer': issuer,
        'gchat.provisioning.wifJwksPublic': JSON.stringify(jwks),
      },
      actor,
    );
    return { keyId, jwks, issuer };
  }

  /** Nom d'espace : préfixe + nom de projet tel quel (Chat n'impose pas de slug, contrairement aux canaux Slack). */
  static spaceName(prefix: string, projectName: string): string {
    return `${prefix}${projectName}`.slice(0, 128);
  }

  /**
   * Emails des membres HUMAINS du projet (membres directs + équipes affectées),
   * actifs. Les **agents IA** sont exclus : identités applicatives sur un domaine
   * fictif (`…@agents.invalid`), sans compte Workspace — les chercher échoue
   * toujours et pollue les diagnostics. (Même correctif que côté Slack.)
   */
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

  /**
   * Ajoute les membres du projet à l'espace. Best-effort et diagnostiquable :
   * chaque échec est journalisé avec la raison Google. `ALREADY_EXISTS` n'est
   * pas une erreur (idempotence des re-synchronisations).
   */
  private async addMembers(
    client: { addMember: (space: string, email: string) => Promise<unknown> },
    spaceName: string,
    projectId: string,
  ): Promise<{ invited: number; already: number; errors: string[] }> {
    const emails = await this.memberEmails(projectId);
    const out = { invited: 0, already: 0, errors: [] as string[] };
    for (const email of emails) {
      try {
        await client.addMember(spaceName, email);
        out.invited++;
      } catch (e) {
        const msg = (e as Error).message;
        if (/ALREADY_EXISTS|already a member/i.test(msg)) out.already++;
        else {
          out.errors.push(`${email}: ${msg}`);
          this.logger.warn(`Google Chat invite failed for ${email} on space=${spaceName}: ${msg}`);
        }
      }
    }
    return out;
  }

  /** Teste le compte de service + l'impersonation configurés (bouton « Tester » de la carte admin). */
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

  /** Hook fire-and-forget : projet passé ACTIVE → provisionne un espace Google Chat. */
  async onProjectActivated(orgId: string, projectId: string): Promise<void> {
    try {
      await this.provisionForProject(orgId, projectId);
    } catch (e) {
      this.logger.warn(`Google Chat provisioning failed for project=${projectId}: ${(e as Error).message}`);
    }
  }

  /** Provisionne (idempotent) l'espace Google Chat d'un projet. */
  async provisionForProject(
    orgId: string,
    projectId: string,
  ): Promise<{ status: 'skipped' | 'done'; reason?: string; spaceId?: string }> {
    const cfg = await this.getConfig(orgId);
    if (!cfg.enabled) return { status: 'skipped', reason: 'Google Chat provisioning disabled' };

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, kind: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (project.kind !== 'STANDARD') return { status: 'skipped', reason: 'Projet externe' };

    // Idempotence : déjà un espace Google Chat pour ce projet → ne rien refaire.
    const existing = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'gchat' },
      select: { id: true, externalId: true },
    });
    // Déjà provisionné → on ne recrée PAS l'espace, mais on re-synchronise les
    // membres (sens de « Re-synchroniser » côté UI). Sans ça, un membre ajouté
    // au projet après coup ne pourrait jamais rejoindre l'espace.
    if (existing) {
      if (!existing.externalId) {
        return { status: 'skipped', reason: 'Espace Google Chat déjà lié (id inconnu)' };
      }
      if (!cfg.invite) {
        return { status: 'skipped', reason: 'Espace déjà provisionné (invitation désactivée)', spaceId: existing.externalId };
      }
      const rc = await this.buildClient(orgId, cfg);
      const r = await this.addMembers(rc, existing.externalId, projectId);
      this.logger.log(
        `Google Chat reconcile: project=${projectId} space=${existing.externalId} invited=${r.invited} already=${r.already} errors=${r.errors.length}`,
      );
      return {
        status: 'done',
        reason: `Membres re-synchronisés (${r.invited} ajouté(s), ${r.already} déjà présent(s), ${r.errors.length} en erreur)`,
        spaceId: existing.externalId,
      };
    }

    const client = await this.buildClient(orgId, cfg);
    const name = GoogleChatProvisioningService.spaceName(cfg.spacePrefix, project.name);
    this.logger.log(`Google Chat provisioning: creating space "${name}" for project=${projectId}`);

    let space;
    try {
      space = await client.createSpace(name);
    } catch (e) {
      throw new BadRequestException(`Création de l'espace Google Chat refusée : ${(e as Error).message}`);
    }

    // Invitation des membres (best-effort, jamais bloquant pour la création).
    let invited = 0;
    let errored = 0;
    if (cfg.invite) {
      const r = await this.addMembers(client, space.name, projectId);
      invited = r.invited;
      errored = r.errors.length;
    }

    // Format de lien best-effort — non vérifié contre un tenant Workspace réel
    // (aucun credential de démo disponible). `spaceId` = suffixe après `spaces/`.
    const spaceId = space.name.replace(/^spaces\//, '');
    const url = `https://mail.google.com/chat/u/0/#chat/space/${spaceId}`;
    await this.prisma.projectCollabSpace.create({
      data: {
        organizationId: orgId,
        projectId,
        provider: 'gchat',
        externalId: space.name,
        url,
        name: space.displayName,
        source: 'provisioned',
      },
    });
    this.logger.log(
      `Google Chat provisioning done: project=${projectId} space=${space.name} invited=${invited} errors=${errored}`,
    );
    return {
      status: 'done',
      reason: `Espace créé (${invited} membre(s) ajouté(s)${errored ? `, ${errored} en erreur` : ''})`,
      spaceId: space.name,
    };
  }

  /**
   * Supprime l'espace Chat d'un projet côté Google (`spaces.delete`) PUIS délie
   * la ligne locale. **Destructif et définitif** — Chat n'a pas d'archivage.
   * Exige le scope `chat.delete` dans la délégation domain-wide : on construit
   * donc un client dédié scopé `[CHAT_DELETE_SCOPE]`. Si l'espace a déjà disparu
   * côté Google (404), on délie quand même localement (idempotent).
   */
  async deleteSpaceForProject(
    orgId: string,
    projectId: string,
  ): Promise<{ status: 'deleted' | 'skipped'; reason: string }> {
    const cfg = await this.getConfig(orgId);
    const existing = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'gchat' },
      select: { id: true, externalId: true },
    });
    if (!existing) return { status: 'skipped', reason: 'Aucun espace Google Chat lié à ce projet.' };

    if (existing.externalId) {
      const client = await this.buildClient(orgId, cfg, [CHAT_DELETE_SCOPE]);
      try {
        await client.deleteSpace(existing.externalId);
      } catch (e) {
        const msg = (e as Error).message;
        // Déjà supprimé côté Google → on continue le nettoyage local (idempotent).
        if (!/NOT_FOUND|HTTP 404/i.test(msg)) {
          throw new BadRequestException(`Suppression de l'espace Google Chat refusée : ${msg}`);
        }
        this.logger.warn(`Google Chat space already gone for project=${projectId}: ${msg}`);
      }
    }
    await this.prisma.projectCollabSpace.deleteMany({
      where: { organizationId: orgId, projectId, provider: 'gchat' },
    });
    this.logger.log(`Google Chat space deleted: project=${projectId} space=${existing.externalId ?? '(unknown)'}`);
    return { status: 'deleted', reason: 'Espace Google Chat supprimé et délié.' };
  }
}
