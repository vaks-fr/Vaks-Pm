import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LicenseService } from './license.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

/** Acteur d'une réconciliation de sièges (pour l'audit). */
export interface SeatActor {
  actorId?: string | null;
  actorLabel?: string | null;
  /** Origine : 'scim' (sync groupe IdP) ou 'team_auto' (ajout/retrait équipe). */
  via: 'scim' | 'team_auto';
}

/**
 * **Sièges de licence pilotés par appartenance d'équipe (auto-licence).**
 *
 * Une équipe `autoLicense=true` (typiquement le miroir du groupe SCIM/Entra des
 * utilisateurs licenciés) gouverne le siège de ses membres :
 *  - **grant** : un membre actif ajouté reçoit un siège (best-effort, dans la
 *    limite du plafond `maxUsers` — au-delà il reste *seat-pending*, jamais de
 *    403 vers l'IdP) ;
 *  - **revoke** : un membre retiré perd son siège **seulement s'il n'est plus
 *    membre d'AUCUNE équipe auto-licence active** (un user peut être couvert par
 *    plusieurs groupes), et on coupe alors ses sessions.
 *
 * Appelé depuis le provisioning SCIM (sync groupe) ET les mutations d'équipe
 * manuelles (le flag gouverne *toute* appartenance). Fire-and-forget côté
 * appelants : un échec ne casse jamais la mutation d'équipe.
 */
@Injectable()
export class SeatService {
  private readonly logger = new Logger(SeatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly licenses: LicenseService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Réconcilie les sièges après un changement d'appartenance à une équipe
   * auto-licence. `grant` = users ajoutés, `revoke` = users retirés. Un user à
   * la fois ajouté et retiré (cas tordu) est traité comme ajouté.
   */
  async reconcileAutoLicense(
    orgId: string,
    change: { grant?: string[]; revoke?: string[] },
    actor: SeatActor,
  ): Promise<void> {
    const grantIds = [...new Set(change.grant ?? [])];
    const revokeIds = [...new Set(change.revoke ?? [])].filter((id) => !grantIds.includes(id));
    try {
      if (grantIds.length) await this.grantSeats(orgId, grantIds, actor);
      if (revokeIds.length) await this.revokeOrphanedSeats(orgId, revokeIds, actor);
    } catch (err) {
      this.logger.warn(`Auto-license reconciliation failed: ${(err as Error).message}`);
    }
  }

  /** Attribue un siège (best-effort, plafond) aux candidats actifs sans siège. */
  private async grantSeats(orgId: string, ids: string[], actor: SeatActor): Promise<void> {
    const candidates = await this.prisma.user.findMany({
      // kind HUMAN : un agent IA ne consomme JAMAIS de siège (licensed=false à
      // vie — le licensing agents sera re-designé plus tard).
      where: { organizationId: orgId, id: { in: ids }, deletedAt: null, status: 'ACTIVE', licensed: false, kind: 'HUMAN' },
      select: { id: true, email: true },
    });
    if (!candidates.length) return;
    const remaining = await this.licenses.seatsRemaining(orgId); // null = illimité
    const toGrant = remaining == null ? candidates : candidates.slice(0, Math.max(0, remaining));
    if (!toGrant.length) {
      this.logger.warn(`Auto-license: seat cap reached, ${candidates.length} user(s) left without a seat.`);
      return;
    }
    const gIds = toGrant.map((u) => u.id);
    await this.prisma.user.updateMany({ where: { id: { in: gIds } }, data: { licensed: true } });
    for (const u of toGrant) this.auditSeat(orgId, true, actor, u);
  }

  /**
   * Retire le siège des users retirés **qui ne sont plus dans aucune équipe
   * auto-licence active** (et qui ont effectivement un siège). Coupe leurs
   * sessions (lockout au prochain refresh).
   */
  private async revokeOrphanedSeats(orgId: string, ids: string[], actor: SeatActor): Promise<void> {
    const autoTeams = await this.prisma.team.findMany({
      where: { organizationId: orgId, autoLicense: true, deletedAt: null },
      select: { id: true },
    });
    const autoTeamIds = autoTeams.map((t) => t.id);
    let stillCovered = new Set<string>();
    if (autoTeamIds.length) {
      const rows = await this.prisma.teamMember.findMany({
        where: { userId: { in: ids }, teamId: { in: autoTeamIds } },
        select: { userId: true },
      });
      stillCovered = new Set(rows.map((r) => r.userId));
    }
    const orphans = ids.filter((id) => !stillCovered.has(id));
    if (!orphans.length) return;
    const licensed = await this.prisma.user.findMany({
      where: { organizationId: orgId, id: { in: orphans }, licensed: true },
      select: { id: true, email: true },
    });
    if (!licensed.length) return;
    const lIds = licensed.map((u) => u.id);
    await this.prisma.user.updateMany({ where: { id: { in: lIds } }, data: { licensed: false } });
    await this.prisma.refreshToken.updateMany({
      where: { userId: { in: lIds }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    for (const u of licensed) this.auditSeat(orgId, false, actor, u);
  }

  private auditSeat(
    orgId: string,
    granted: boolean,
    actor: SeatActor,
    user: { id: string; email: string | null },
  ): void {
    void this.audit.logCritical({
      organizationId: orgId,
      action: granted ? AUDIT_ACTIONS.USER_SEAT_GRANTED : AUDIT_ACTIONS.USER_SEAT_REVOKED,
      actorType: actor.via === 'scim' ? 'API_TOKEN' : undefined,
      actorId: actor.actorId ?? null,
      actorLabel: actor.actorLabel ?? null,
      resourceType: 'user',
      resourceId: user.id,
      resourceLabel: user.email ?? null,
      detail: { via: actor.via, auto: true, licensed: { new: granted } },
    });
  }
}
