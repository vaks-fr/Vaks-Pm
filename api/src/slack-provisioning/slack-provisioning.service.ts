import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { SlackClient } from './slack-client';

const TOKEN_KEY = 'slack.provisioning.botToken';

/** Config résolue du provisioning Slack (clés OrgSetting `slack.provisioning.*`). */
interface SlackConfig {
  enabled: boolean;
  channelPrefix: string;
  visibility: 'public' | 'private';
  invite: boolean;
}

/**
 * Provisioning d'espaces de collaboration **Slack** (2ᵉ fournisseur après Teams).
 *
 * À l'activation d'un projet (`onProjectActivated`, best-effort), crée un canal
 * Slack, invite les membres (résolus par email → id Slack), puis inscrit une
 * ligne `ProjectCollabSpace` (`source:'provisioned'`, provider `slack`) — d'où
 * l'apparition de l'espace dans l'onglet Intégrations du projet, et le garde-fou
 * 409 (un tiers ne détourne pas un espace géré par Vaks).
 *
 * Contrairement à Teams (Graph asynchrone → worker), l'API Slack est synchrone
 * et rapide : le provisioning tourne **inline** dans l'API, en fire-and-forget
 * (jamais bloquant pour la mutation projet). Idempotent : un projet ayant déjà
 * un canal Slack n'en recrée pas.
 */
@Injectable()
export class SlackProvisioningService {
  private readonly logger = new Logger(SlackProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  private async getConfig(orgId: string): Promise<SlackConfig> {
    const all = await this.settings.getAll(orgId);
    const str = (k: string, d: string) => (typeof all[k] === 'string' ? (all[k] as string).trim() : d);
    return {
      enabled: all['slack.provisioning.enabled'] === true,
      channelPrefix: str('slack.provisioning.channelPrefix', 'proj-'),
      visibility: str('slack.provisioning.visibility', 'private') === 'public' ? 'public' : 'private',
      invite: all['slack.provisioning.invite'] !== false, // défaut ON
    };
  }

  /**
   * Nom de canal Slack valide : minuscules, tirets, ≤ 80 car., alphanum/-/_ .
   * `prefix` + slug du nom de projet. Slack refuse les noms vides / trop longs.
   */
  static channelName(prefix: string, projectName: string): string {
    const slug = projectName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // diacritiques combinants (accents)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const base = `${prefix}${slug || 'projet'}`.replace(/[^a-z0-9_-]/g, '-');
    return base.slice(0, 80).replace(/-+$/g, '') || 'projet';
  }

  /**
   * Emails des membres HUMAINS du projet (membres directs + équipes affectées),
   * actifs. Les **agents IA** sont exclus : ce sont des identités applicatives
   * (`…@agents.invalid`), sans compte Slack — les chercher est au mieux inutile,
   * au pire trompeur dans les diagnostics.
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
   * Invite les membres du projet dans le canal. **Best-effort et diagnostiquable** :
   * chaque email non résolu est journalisé avec la raison exacte renvoyée par
   * Slack (`users_not_found` vs `missing_scope`), au lieu d'échouer en silence.
   * Idempotent : `already_in_channel` n'est pas une erreur.
   */
  private async inviteMembers(
    client: SlackClient,
    channelId: string,
    projectId: string,
  ): Promise<{ invited: number; already: number; notFound: string[]; errors: string[] }> {
    const emails = await this.memberEmails(projectId);
    const out = { invited: 0, already: 0, notFound: [] as string[], errors: [] as string[] };
    for (const email of emails) {
      const { id, error } = await client.lookupByEmail(email);
      if (!id) {
        if (error && !/users_not_found/.test(error)) out.errors.push(`${email}: ${error}`);
        else out.notFound.push(email);
        continue;
      }
      const r = await client.inviteOne(channelId, id);
      if (r === 'ok') out.invited++;
      else if (r === 'already') out.already++;
      else out.errors.push(`${email}: ${r}`);
    }
    if (out.notFound.length) {
      this.logger.warn(
        `Slack invite: ${out.notFound.length} member(s) have no Slack account matching their Vaks email (${out.notFound.join(', ')})`,
      );
    }
    for (const e of out.errors) this.logger.warn(`Slack invite error — ${e}`);
    return out;
  }

  /**
   * Teste le bot token configuré (bouton « Tester » de la carte admin). Ne
   * vérifie que l'authentification (`auth.test`) — comme pour Teams, un scope
   * manquant (ex. `channels:manage`) passe ce test et n'échoue qu'au premier
   * provisioning réel.
   */
  async testConnection(orgId: string): Promise<{ ok: boolean; message: string }> {
    const token = await this.settings.getDecryptedSecret(orgId, TOKEN_KEY);
    if (!token) return { ok: false, message: 'Aucun bot token Slack configuré.' };
    try {
      const workspace = await new SlackClient(token).authTest();
      return { ok: true, message: `Connecté à l'espace de travail Slack « ${workspace.team} ».` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * Archive le canal Slack du projet et **délie** l'espace (suppression de la
   * ligne `ProjectCollabSpace`) — la tuile projet repasse alors à « Provisionner
   * maintenant ». Slack ne sait pas supprimer un canal par API : archiver est le
   * seul nettoyage possible.
   *
   * Refuse un espace `source:'external'` : il a été déclaré par un outil tiers,
   * Vaks ne le possède pas et n'a pas à agir dessus côté Slack.
   *
   * ⚠️ Le nom du canal reste RÉSERVÉ côté Slack même archivé : re-provisionner le
   * même projet retombera sur `name_taken` tant que le canal archivé porte ce nom.
   */
  async archiveForProject(
    orgId: string,
    projectId: string,
  ): Promise<{ status: 'done' | 'skipped'; reason?: string }> {
    const row = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'slack' },
      select: { id: true, externalId: true, source: true },
    });
    if (!row) return { status: 'skipped', reason: 'Aucun canal Slack pour ce projet' };
    if (row.source !== 'provisioned') {
      throw new ConflictException(
        "Cet espace a été déclaré par un outil externe — Vaks ne l'archive pas.",
      );
    }

    const token = await this.settings.getDecryptedSecret(orgId, TOKEN_KEY);
    if (!token) return { status: 'skipped', reason: 'Aucun bot token Slack configuré' };

    let archived: 'ok' | 'already' = 'ok';
    if (row.externalId) {
      archived = await new SlackClient(token).archive(row.externalId);
    }
    await this.prisma.projectCollabSpace.delete({ where: { id: row.id } });
    this.logger.log(
      `Slack archive: project=${projectId} channel=${row.externalId ?? '?'} result=${archived} (space unlinked)`,
    );
    return {
      status: 'done',
      reason:
        archived === 'already'
          ? 'Canal déjà archivé côté Slack — lien retiré.'
          : 'Canal archivé et lien retiré.',
    };
  }

  /** Hook fire-and-forget : projet passé ACTIVE → provisionne un canal Slack. */
  async onProjectActivated(orgId: string, projectId: string): Promise<void> {
    try {
      await this.provisionForProject(orgId, projectId);
    } catch (e) {
      this.logger.warn(`Slack provisioning failed for project=${projectId}: ${(e as Error).message}`);
    }
  }

  /**
   * Provisionne (idempotent) le canal Slack d'un projet. Utilisable aussi depuis
   * un futur bouton « provisionner maintenant ». Renvoie un statut lisible.
   */
  async provisionForProject(
    orgId: string,
    projectId: string,
  ): Promise<{ status: 'queued' | 'skipped' | 'done'; reason?: string; channelId?: string }> {
    const cfg = await this.getConfig(orgId);
    if (!cfg.enabled) return { status: 'skipped', reason: 'Slack provisioning disabled' };

    const token = await this.settings.getDecryptedSecret(orgId, TOKEN_KEY);
    if (!token) return { status: 'skipped', reason: 'No Slack bot token configured' };

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, kind: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (project.kind !== 'STANDARD') return { status: 'skipped', reason: 'Projet externe' };

    // Déjà provisionné → on ne recrée PAS le canal, mais on re-synchronise les
    // membres (c'est le sens de « Re-synchroniser » côté UI). Sans ça, un membre
    // ajouté au projet après coup — ou dont l'email n'avait pas résolu — ne
    // pourrait jamais rejoindre le canal sans repartir de zéro.
    const existing = await this.prisma.projectCollabSpace.findFirst({
      where: { organizationId: orgId, projectId, provider: 'slack' },
      select: { id: true, externalId: true },
    });
    if (existing) {
      if (!existing.externalId) {
        return { status: 'skipped', reason: 'Canal Slack déjà lié (id inconnu)' };
      }
      if (!cfg.invite) {
        return { status: 'skipped', reason: 'Canal déjà provisionné (invitation désactivée)', channelId: existing.externalId };
      }
      const client = new SlackClient(token);
      const r = await this.inviteMembers(client, existing.externalId, projectId);
      this.logger.log(
        `Slack reconcile: project=${projectId} channel=${existing.externalId} invited=${r.invited} already=${r.already} notFound=${r.notFound.length} errors=${r.errors.length}`,
      );
      return {
        status: 'done',
        reason: `Membres re-synchronisés (${r.invited} invité(s), ${r.already} déjà présent(s), ${r.notFound.length} sans compte Slack)`,
        channelId: existing.externalId,
      };
    }

    const client = new SlackClient(token);
    const workspace = await client.authTest(); // valide le token + domaine workspace
    const name = SlackProvisioningService.channelName(cfg.channelPrefix, project.name);
    this.logger.log(`Slack provisioning: creating channel "${name}" for project=${projectId}`);

    let channel;
    try {
      channel = await client.createChannel(name, cfg.visibility === 'private');
    } catch (e) {
      // `name_taken` : un canal du même nom existe déjà côté Slack — on ne
      // devine pas son id de façon fiable, on remonte l'erreur (best-effort côté hook).
      throw new BadRequestException(`Création du canal Slack refusée : ${(e as Error).message}`);
    }

    // Invitation des membres (best-effort, jamais bloquant pour la création).
    let invited = 0;
    let notFound = 0;
    if (cfg.invite) {
      const r = await this.inviteMembers(client, channel.id, projectId);
      invited = r.invited;
      notFound = r.notFound.length;
    }

    const url = `${workspace.url.replace(/\/$/, '')}/archives/${channel.id}`;
    await this.prisma.projectCollabSpace.create({
      data: {
        organizationId: orgId,
        projectId,
        provider: 'slack',
        externalId: channel.id,
        url,
        name: `#${channel.name}`,
        source: 'provisioned',
      },
    });
    this.logger.log(
      `Slack provisioning done: project=${projectId} channel=${channel.id} invited=${invited} notFound=${notFound}`,
    );
    return {
      status: 'done',
      reason: `Canal créé (${invited} membre(s) invité(s), ${notFound} sans compte Slack)`,
      channelId: channel.id,
    };
  }
}
