import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AutomationAlert } from '../automations/automation-actions.service';
import { autoUpsertPayload, deriveRiskFromAlert } from './risk-derivation';

/**
 * Auto-alimentation du registre de risques depuis le chokepoint `emit` des
 * automatisations (`AutomationActionsService.emit`). Résolu en LAZY côté
 * `AutomationActionsService` (ModuleRef, `strict:false`) — voir le
 * commentaire à l'appel là-bas — pour ne créer AUCUNE dépendance de module
 * dans le sens Automations → Risks (fail-open si le module n'est pas monté).
 *
 * Invariant central : `reconcileFromAlert` fait un UPSERT sur
 * `idempotencyKey` dont la clause `update` ne touche JAMAIS
 * status/mitigation/ownerId/resolvedAt (cf. `risk-derivation.autoUpsertPayload`
 * et son test) — un risque AUTO résolu ou édité par un humain n'est donc ni
 * ré-ouvert ni écrasé quand la règle source se redéclenche.
 *
 * `reapStale` est la réconciliation « condition levée » best-effort : `emit`
 * ne se rejoue pas quand la condition disparaît, donc rien ne rafraîchit
 * `updatedAt` sur ce risque — on le referme après `olderThanDays` jours sans
 * rafraîchissement. Auto-résolution APPROXIMATIVE (par péremption), pas la
 * détection exacte de la levée de la condition (cf. `incomplete` du plan).
 */
@Injectable()
export class RiskAutoService {
  private readonly log = new Logger(RiskAutoService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reconcileFromAlert(orgId: string, alert: AutomationAlert): Promise<void> {
    try {
      const derived = deriveRiskFromAlert(alert);
      if (!derived) return;
      const { create, update } = autoUpsertPayload(derived, orgId);
      await this.prisma.risk.upsert({
        where: { idempotencyKey: derived.idempotencyKey },
        create: create as never,
        update: update as never,
      });
    } catch (err) {
      this.log.warn(`reconcileFromAlert(${alert.kind}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Referme (RESOLVED) les risques AUTO encore OPEN/MITIGATING dont
   * `updatedAt` n'a plus été rafraîchi depuis `olderThanDays` jours — signal
   * que la règle source ne se redéclenche plus, donc que la condition a
   * vraisemblablement disparu. Best-effort, fail-open, appelé après le tick
   * cron d'évaluation d'un tenant (cf. `AutomationsCronService`).
   */
  async reapStale(orgId: string, olderThanDays: number): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
      const res = await this.prisma.risk.updateMany({
        where: {
          organizationId: orgId,
          source: 'AUTO',
          status: { in: ['OPEN', 'MITIGATING'] },
          deletedAt: null,
          updatedAt: { lt: cutoff },
        },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      return res.count;
    } catch (err) {
      this.log.warn(`reapStale failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
