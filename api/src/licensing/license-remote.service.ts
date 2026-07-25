import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LicenseService, type EvaluatedLicense } from './license.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { readNotificationsSettings } from '../notifications/notifications-settings';
import type { Lang } from '../notifications/email-templates';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Grâce hors-ligne par défaut (jours) si la licence ne précise pas maxOfflineDays. */
const DEFAULT_OFFLINE_DAYS = Math.max(1, Number(process.env.LICENSE_OFFLINE_GRACE_DAYS) || 7);

/**
 * Couche **en ligne** (hybride, SPEC §16). La politique est désormais **portée
 * par la licence** (`online.required` / `online.maxOfflineDays` / `online.serverUrl`),
 * décidée par l'éditeur à l'émission — plus par l'env du déploiement.
 *
 * Ce service est le **poller** : si une **clé d'activation** est configurée
 * (`LICENSE_ACTIVATION_KEY`, secret côté déploiement) et qu'une URL de serveur
 * est connue (env `LICENSE_SERVER_URL` **ou** claim `online.serverUrl` de la
 * licence active), il interroge périodiquement le serveur pour :
 *  - **renouveler** : adopter le token courant servi (auto-renew) ;
 *  - **révoquer** : `revoked` ⇒ désactive la licence locale ;
 *  - **rafraîchir `LicenseConnectivity.lastSuccessAt`** : référence du compteur
 *    de grâce hors-ligne ;
 *  - **prévenir les admins** (entrée en grâce, rappel quotidien, coupure) quand
 *    la licence active exige le online et que le serveur est injoignable.
 *
 * **La suspension elle-même est décidée par `LicenseService` à la lecture**
 * (compare `lastSuccessAt` à `maxOfflineDays`), donc elle s'applique **même sans
 * poller** (déploiement non provisionné). La signature est TOUJOURS re-vérifiée
 * localement. Un coup de réseau bref ne casse rien (grâce) ; le core et les
 * données restent toujours accessibles.
 */
@Injectable()
export class LicenseRemoteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenseRemoteService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly envUrl = (process.env.LICENSE_SERVER_URL || '').replace(/\/+$/, '');
  private readonly activationKey = process.env.LICENSE_ACTIVATION_KEY || '';
  private readonly pollMs =
    Math.max(5, Number(process.env.LICENSE_POLL_MINUTES) || 30) * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
    private readonly notifications: NotificationsService,
    private readonly settings: AdminSettingsService,
  ) {}

  onModuleInit() {
    // Le poller est armé en continu ; chaque cycle ne contacte le serveur que
    // pour une licence active à politique `online.required` avec une URL résolue
    // (env ou claim du token). Aucune clé d'activation requise (push token-only).
    this.logger.log(
      `Poller licence armé (push, poll ${this.pollMs / 60000} min ; URL ` +
        `${this.envUrl || '(depuis la licence)'} ; clé d'activation ` +
        `${this.activationKey ? 'présente (check-in)' : 'absente (token-only)'}).`,
    );
    // Premier poll différé : laisser le boot / db push se terminer.
    setTimeout(() => void this.pollSafe(), 10_000);
    this.timer = setInterval(() => void this.pollSafe(), this.pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async pollSafe() {
    let active: { token: string; createdAt: Date } | null = null;
    try {
      active = await this.prisma.license.findFirst({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
        select: { token: true, createdAt: true },
      });
    } catch {
      // Table absente / DB KO : on ne bloque rien.
    }
    if (!active) return; // pas de licence active → rien à vérifier en ligne.
    const evaluated = this.licenses.evaluateToken(active.token);
    // Seule une licence à politique en ligne déclenche un contact serveur.
    if (!evaluated.requireOnline) return;

    const url = this.envUrl || (evaluated.payload?.online?.serverUrl || '').replace(/\/+$/, '');
    if (!url) {
      // require-online mais aucune URL (env ni token) : impossible de vérifier →
      // traité comme injoignable (emails de grâce ; la suspension vient de la
      // lecture via LicenseService).
      await this.onUnreachable(evaluated, active.createdAt).catch(() => {});
      return;
    }

    try {
      const revoked = await this.validate(url, active.token);
      if (revoked) {
        const n = await this.prisma.license.updateMany({
          where: { active: true },
          data: { active: false },
        });
        if (n.count > 0) {
          this.licenses.invalidate();
          this.logger.warn('Licence révoquée par le serveur → désactivée localement.');
        }
        return;
      }
      await this.onReachable();
    } catch (e) {
      this.logger.warn(`Validation licence échouée : ${(e as Error).message}`);
      await this.onUnreachable(evaluated, active.createdAt).catch((err) =>
        this.logger.warn(`Suivi connectivité licence échoué : ${(err as Error).message}`),
      );
    }
  }

  /**
   * **Push** : envoie le token au serveur (`POST /v1/license/validate`) et renvoie
   * `true` s'il est révoqué. Le serveur ne fait QUE de la révocation ; la
   * signature reste re-vérifiée localement (déjà faite par `evaluateToken`). La
   * clé d'activation, si configurée, est jointe en Bearer pour un simple check-in
   * (le endpoint est token-only). Convient aux déploiements self-hosted derrière
   * NAT (sortie internet uniquement).
   */
  private async validate(url: string, token: string): Promise<boolean> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${url}/v1/license/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.activationKey ? { authorization: `Bearer ${this.activationKey}` } : {}),
        },
        body: JSON.stringify({ token }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { valid?: boolean; revoked?: boolean };
      return data.revoked === true;
    } finally {
      clearTimeout(to);
    }
  }

  // ============================================================
  // Connectivité / grâce hors-ligne (référence de suspension + emails)
  // ============================================================

  /** Poll réussi : rafraîchit la référence de grâce et lève toute suspension. */
  private async onReachable() {
    const now = new Date();
    await this.prisma.licenseConnectivity.upsert({
      where: { id: 1 },
      update: { lastSuccessAt: now, emailStage: null, lastEmailAt: null },
      create: { id: 1, lastSuccessAt: now },
    });
    // La suspension est dérivée à la lecture : on purge le cache pour la lever
    // immédiatement (sinon jusqu'à 60 s de TTL).
    this.licenses.invalidate();
  }

  /**
   * Poll en échec : si la licence active exige le online, prévient les admins
   * selon le palier (entrée en grâce → quotidien → coupure). La suspension
   * effective reste calculée par `LicenseService`. Dédup + multi-réplica via
   * `emailStage` + `lastEmailAt` (updates conditionnels atomiques).
   */
  private async onUnreachable(active: EvaluatedLicense | null, createdAt: Date | null) {
    if (!active || !active.requireOnline) return; // rien à signaler.
    const now = Date.now();
    const graceMs = (active.maxOfflineDays ?? DEFAULT_OFFLINE_DAYS) * DAY_MS;
    const row = await this.prisma.licenseConnectivity.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    const baseline = (row.lastSuccessAt ?? createdAt ?? new Date(now)).getTime();
    const offlineMs = now - baseline;

    if (offlineMs > graceMs) {
      // Grâce dépassée → coupure (une seule fois par épisode).
      const moved = await this.prisma.licenseConnectivity.updateMany({
        where: { id: 1, NOT: { emailStage: 'cutoff' } },
        data: { emailStage: 'cutoff', lastEmailAt: new Date(now) },
      });
      if (moved.count === 1) {
        this.licenses.invalidate(); // reflète la suspension sans attendre le TTL.
        this.logger.warn(
          `Serveur injoignable depuis ${Math.floor(offlineMs / DAY_MS)} j ` +
            `(> grâce ${graceMs / DAY_MS} j) → features premium SUSPENDUES.`,
        );
        await this.sendConnectivityEmail('cutoff', active, baseline);
      }
      return;
    }

    // Encore dans la fenêtre de grâce.
    if (row.emailStage == null) {
      // 1er email : entrée en grâce.
      const moved = await this.prisma.licenseConnectivity.updateMany({
        where: { id: 1, emailStage: null },
        data: { emailStage: 'entry', lastEmailAt: new Date(now) },
      });
      if (moved.count === 1) {
        this.logger.warn('Serveur de licences injoignable → entrée en grâce hors-ligne.');
        await this.sendConnectivityEmail('entry', active, baseline);
      }
      return;
    }

    // Rappel quotidien tant qu'on est en grâce (entry/daily).
    const dailyCutoff = new Date(now - DAY_MS);
    const claimed = await this.prisma.licenseConnectivity.updateMany({
      where: {
        id: 1,
        emailStage: { in: ['entry', 'daily'] },
        OR: [{ lastEmailAt: null }, { lastEmailAt: { lt: dailyCutoff } }],
      },
      data: { emailStage: 'daily', lastEmailAt: new Date(now) },
    });
    if (claimed.count === 1) {
      await this.sendConnectivityEmail('daily', active, baseline);
    }
  }

  // ============================================================
  // Emails admin
  // ============================================================

  private async sendConnectivityEmail(
    kind: 'entry' | 'daily' | 'cutoff',
    active: EvaluatedLicense,
    since: number,
  ): Promise<void> {
    let orgs: { id: string }[];
    try {
      orgs = await this.prisma.organization.findMany({ select: { id: true } });
    } catch (err) {
      this.logger.warn(`Email connectivité — orgs illisibles : ${(err as Error).message}`);
      return;
    }
    const graceDays = Math.round((active.maxOfflineDays ?? DEFAULT_OFFLINE_DAYS));
    const offlineDays = Math.max(0, Math.floor((Date.now() - since) / DAY_MS));
    const lastContact = new Date(since).toISOString().slice(0, 10);

    for (const org of orgs) {
      try {
        const prefs = readNotificationsSettings(await this.settings.getAll(org.id));
        const admins = await this.prisma.user.findMany({
          where: { organizationId: org.id, isAdmin: true, deletedAt: null, status: 'ACTIVE' },
          select: { email: true, name: true, preferredLanguage: true },
        });
        for (const a of admins) {
          const lang = await this.notifications.resolveRecipientLanguage(
            org.id,
            a.preferredLanguage,
          );
          const mail = this.buildConnectivityMail(kind, a.name, lang, {
            graceDays,
            offlineDays,
            lastContact,
          });
          await this.notifications.enqueue(org.id, a.email, 'license_offline', mail, prefs);
        }
      } catch (err) {
        this.logger.warn(`Email connectivité org=${org.id} échoué : ${(err as Error).message}`);
      }
    }
  }

  private buildConnectivityMail(
    kind: 'entry' | 'daily' | 'cutoff',
    recipientName: string,
    lang: Lang,
    v: { graceDays: number; offlineDays: number; lastContact: string },
  ): { subject: string; html: string; text: string } {
    type S = {
      hello: string;
      subjectEntry: string;
      subjectDaily: string;
      subjectCutoff: string;
      bodyEntry: string;
      bodyDaily: string;
      bodyCutoff: string;
      footer: string;
    };
    const table: Record<Lang, S> = {
      en: {
        hello: `Hello ${recipientName},`,
        subjectEntry: 'License server unreachable — premium features in grace period',
        subjectDaily: `License server still unreachable (offline ${v.offlineDays} day(s))`,
        subjectCutoff: 'Premium features suspended — license server unreachable',
        bodyEntry: `This deployment can no longer reach the license server (last successful check: <strong>${v.lastContact}</strong>). Premium features keep working for up to <strong>${v.graceDays} day(s)</strong>; after that they will be suspended until the connection is restored.`,
        bodyDaily: `The license server is still unreachable (offline ${v.offlineDays} day(s), last check ${v.lastContact}). Premium features will be suspended once the ${v.graceDays}-day grace period ends. Please restore connectivity to the license server.`,
        bodyCutoff: `The license server has been unreachable for more than ${v.graceDays} day(s). <strong>Premium features are now suspended.</strong> The application core and all your data remain fully accessible. Features resume automatically on the next successful contact.`,
        footer: 'This is an automated message about your Vaks-PM license connectivity.',
      },
      fr: {
        hello: `Bonjour ${recipientName},`,
        subjectEntry: 'Serveur de licences injoignable — features premium en période de grâce',
        subjectDaily: `Serveur de licences toujours injoignable (hors-ligne ${v.offlineDays} j)`,
        subjectCutoff: 'Features premium suspendues — serveur de licences injoignable',
        bodyEntry: `Ce déploiement ne parvient plus à joindre le serveur de licences (dernier contact réussi : <strong>${v.lastContact}</strong>). Les features premium continuent de fonctionner pendant <strong>${v.graceDays} j</strong> ; au-delà, elles seront suspendues jusqu'au rétablissement de la connexion.`,
        bodyDaily: `Le serveur de licences reste injoignable (hors-ligne ${v.offlineDays} j, dernier contact ${v.lastContact}). Les features premium seront suspendues à la fin de la période de grâce de ${v.graceDays} j. Merci de rétablir la connexion au serveur de licences.`,
        bodyCutoff: `Le serveur de licences est injoignable depuis plus de ${v.graceDays} j. <strong>Les features premium sont désormais suspendues.</strong> Le cœur de l'application et toutes vos données restent pleinement accessibles. Les features réapparaîtront automatiquement au prochain contact réussi.`,
        footer: 'Message automatique concernant la connectivité de votre licence Vaks-PM.',
      },
      it: {
        hello: `Buongiorno ${recipientName},`,
        subjectEntry: 'Server delle licenze irraggiungibile — funzioni premium in periodo di tolleranza',
        subjectDaily: `Server delle licenze ancora irraggiungibile (offline ${v.offlineDays} g)`,
        subjectCutoff: 'Funzioni premium sospese — server delle licenze irraggiungibile',
        bodyEntry: `Questo deployment non riesce più a raggiungere il server delle licenze (ultimo contatto riuscito: <strong>${v.lastContact}</strong>). Le funzioni premium continuano per <strong>${v.graceDays} g</strong>; oltre, verranno sospese fino al ripristino della connessione.`,
        bodyDaily: `Il server delle licenze è ancora irraggiungibile (offline ${v.offlineDays} g, ultimo contatto ${v.lastContact}). Le funzioni premium verranno sospese al termine del periodo di tolleranza di ${v.graceDays} g. Si prega di ripristinare la connessione.`,
        bodyCutoff: `Il server delle licenze è irraggiungibile da più di ${v.graceDays} g. <strong>Le funzioni premium sono ora sospese.</strong> Il core dell'applicazione e tutti i dati restano accessibili. Le funzioni riprendono automaticamente al prossimo contatto riuscito.`,
        footer: 'Messaggio automatico sulla connettività della licenza Vaks-PM.',
      },
      de: {
        hello: `Hallo ${recipientName},`,
        subjectEntry: 'Lizenzserver nicht erreichbar — Premium-Funktionen in Kulanzfrist',
        subjectDaily: `Lizenzserver weiterhin nicht erreichbar (offline ${v.offlineDays} Tag(e))`,
        subjectCutoff: 'Premium-Funktionen ausgesetzt — Lizenzserver nicht erreichbar',
        bodyEntry: `Dieses Deployment erreicht den Lizenzserver nicht mehr (letzter erfolgreicher Kontakt: <strong>${v.lastContact}</strong>). Premium-Funktionen bleiben bis zu <strong>${v.graceDays} Tag(e)</strong> aktiv; danach werden sie bis zur Wiederherstellung der Verbindung ausgesetzt.`,
        bodyDaily: `Der Lizenzserver ist weiterhin nicht erreichbar (offline ${v.offlineDays} Tag(e), letzter Kontakt ${v.lastContact}). Premium-Funktionen werden nach Ablauf der ${v.graceDays}-tägigen Kulanzfrist ausgesetzt. Bitte stellen Sie die Verbindung wieder her.`,
        bodyCutoff: `Der Lizenzserver ist seit mehr als ${v.graceDays} Tag(en) nicht erreichbar. <strong>Premium-Funktionen sind jetzt ausgesetzt.</strong> Der Anwendungskern und alle Daten bleiben zugänglich. Die Funktionen werden beim nächsten erfolgreichen Kontakt automatisch wiederhergestellt.`,
        footer: 'Automatische Nachricht zur Konnektivität Ihrer Vaks-PM-Lizenz.',
      },
    };
    const s = table[lang] ?? table.en;
    const subject =
      kind === 'entry' ? s.subjectEntry : kind === 'daily' ? s.subjectDaily : s.subjectCutoff;
    const body = kind === 'entry' ? s.bodyEntry : kind === 'daily' ? s.bodyDaily : s.bodyCutoff;
    const html = `<p>${s.hello}</p><p>${body}</p><p style="color:#888;font-size:12px">${s.footer}</p>`;
    const text = `${subject}. ${body.replace(/<[^>]+>/g, '')}`;
    return { subject, html, text };
  }
}
