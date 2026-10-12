/**
 * Dérivation PURE d'un `Risk` AUTO depuis une alerte d'automatisation
 * (`AutomationAlert`) — aucune I/O, aucune dépendance Nest. C'est la surface
 * testée en vitest ; l'écriture Prisma (upsert) vit dans `RiskAutoService`.
 *
 * Whitelist volontairement étroite : seules les règles qui portent un
 * `projectId` ET dont la sémantique est clairement « ceci est un risque
 * projet » sont mappées. `overload`/`underload` sont user-scoped (pas de
 * `projectId`) — hors périmètre par construction, pas un oubli.
 *
 * Idempotence (le piège central du registre auto-alimenté) : `riskIdempotencyKey`
 * est déterministe pour un (kind, projectId, entityId) donné — la même
 * condition qui se redéclenche produit TOUJOURS la même clé, donc un UPSERT
 * (jamais un CREATE) côté `RiskAutoService`. `autoUpsertPayload` documente et
 * verrouille (via test) l'autre moitié de l'invariant : la clause `update` de
 * cet upsert ne doit JAMAIS contenir `status`/`mitigation`/`ownerId`/`resolvedAt`
 * — un risque AUTO résolu ou édité par un humain n'est ni ré-ouvert ni écrasé
 * quand la règle source se redéclenche.
 */
import type { RiskCategory } from '@vaks-pm/shared';
import type { AutomationAlert } from '../automations/automation-actions.service';
import type { AutomationKind } from '../automations/automation-rules';
import { automationMessage } from '../automations/automations-i18n';

/**
 * Règles source de l'auto-feed risques. Limité aux règles project-scoped qui
 * signalent un risque de calendrier/budget — `milestone_at_risk` (jalon),
 * `budget_threshold` (palier de coût réel franchi), `forecast_overrun`
 * (prévisionnel à terminaison qui dépasserait le budget).
 */
export const RISK_SOURCE_KINDS = [
  'milestone_at_risk',
  'budget_threshold',
  'forecast_overrun',
] as const;
export type RiskSourceKind = (typeof RISK_SOURCE_KINDS)[number];

function isRiskSourceKind(kind: AutomationKind): kind is RiskSourceKind {
  return (RISK_SOURCE_KINDS as readonly string[]).includes(kind);
}

/** Clé d'upsert déterministe — stable pour un (kind, projectId, entityId) identique. */
export function riskIdempotencyKey(kind: AutomationKind, projectId: string, entityId: string): string {
  return `auto:${kind}:${projectId}:${entityId}`;
}

/**
 * Sévérité (probabilité/impact, échelle 1-5) par règle source. Heuristique
 * volontairement simple au MVP — affinable plus tard sans casser le contrat
 * d'idempotence (seule la clause `update` de l'upsert change de valeurs).
 */
function severityFor(kind: RiskSourceKind, alert: AutomationAlert): { probability: number; impact: number } {
  switch (kind) {
    case 'milestone_at_risk':
      // Jalon proche (fenêtre d'alerte) avec prédécesseur(s) non fini(s) :
      // probabilité et impact élevés par construction de la règle elle-même.
      return { probability: 4, impact: 4 };
    case 'budget_threshold': {
      const tier = alert.params.tier ?? 0;
      const probability = tier >= 100 ? 5 : tier >= 90 ? 4 : 3;
      return { probability, impact: 4 };
    }
    case 'forecast_overrun':
      // Projection à terminaison seulement (le réel tient encore) : probabilité
      // légèrement plus basse que budget_threshold, impact financier égal.
      return { probability: 3, impact: 4 };
  }
}

export interface DerivedRisk {
  idempotencyKey: string;
  projectId: string;
  probability: number;
  impact: number;
  score: number;
  category: RiskCategory;
  title: string;
  autoRuleKind: AutomationKind;
}

/**
 * `null` si `alert.kind` n'est pas une règle source risques, ou si l'alerte
 * ne porte pas de `projectId` (défensif — toutes les règles whitelistées en
 * portent un en pratique, mais `deriveRiskFromAlert` ne doit jamais throw).
 */
export function deriveRiskFromAlert(alert: AutomationAlert): DerivedRisk | null {
  if (!isRiskSourceKind(alert.kind)) return null;
  if (!alert.projectId) return null;
  const { probability, impact } = severityFor(alert.kind, alert);
  // Titre = phrase courte déjà localisée (EN) de la même source que les
  // emails/webhooks — pas de duplication de vocabulaire pour cette règle.
  const title = automationMessage(alert.kind, 'en', alert.params).text;
  return {
    idempotencyKey: riskIdempotencyKey(alert.kind, alert.projectId, alert.entityId),
    projectId: alert.projectId,
    probability,
    impact,
    score: probability * impact,
    category: 'RISK',
    title,
    autoRuleKind: alert.kind,
  };
}

/** Payload Prisma `upsert({ create, update })` — extrait en fonction pure pour
 *  verrouiller par test l'invariant central (cf. commentaire d'en-tête). */
export function autoUpsertPayload(
  derived: DerivedRisk,
  organizationId: string,
): { create: Record<string, unknown>; update: Record<string, unknown> } {
  const shared = {
    probability: derived.probability,
    impact: derived.impact,
    score: derived.score,
    title: derived.title,
  };
  return {
    create: {
      organizationId,
      projectId: derived.projectId,
      idempotencyKey: derived.idempotencyKey,
      source: 'AUTO',
      status: 'OPEN',
      category: derived.category,
      autoRuleKind: derived.autoRuleKind,
      ...shared,
    },
    // ⚠️ NE JAMAIS ajouter status/mitigation/ownerId/resolvedAt ici : voir
    // le commentaire d'en-tête et `risk-derivation.spec.ts`.
    update: { ...shared },
  };
}
