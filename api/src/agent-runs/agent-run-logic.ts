/**
 * Logique PURE des runs d'agent (sans Prisma/DB) — testable en isolation
 * (`__tests__/agent-run-source.spec.ts`). Décision de provenance (Lot 3) +
 * détection d'anomalie de déclaration.
 */
import { timingSafeEqual } from 'node:crypto';

/** En dessous de ce ratio (coût déclaré / coût de référence), le coût déclaré
 *  est jugé implausiblement bas → anomalie `below_reference`. */
export const ANOMALY_UNDERREPORT_RATIO = 0.5;

/**
 * Provenance d'un run :
 *  - `self`        : déclaré par l'agent (`vaks_report_run`) — seul cas suspecté ;
 *  - `gateway`     : mesuré sur le fil par une passerelle (interne Vaks OU externe
 *                    type LiteLLM, indistinguables — même secret partagé) ;
 *  - `runtime_log` : mesuré via les logs d'usage du runtime (Claude Code / Agent SDK),
 *                    tokens exacts issus de la réponse API journalisée localement ;
 *  - `estimated`   : estimé via grille tarifaire (Copilot), coût posé explicitement.
 */
export type RunSource = 'self' | 'gateway' | 'runtime_log' | 'estimated';
export type RunAnomaly = 'no_tokens' | 'zero_cost' | 'below_reference' | null;

/** Sources dont le montant n'est PAS une déclaration de l'agent : mesuré exact
 *  (`gateway`/`runtime_log`) ou posé par le serveur (`estimated`). Jamais suspectées. */
export const MEASURED_OR_ESTIMATED: ReadonlySet<string> = new Set([
  'gateway',
  'runtime_log',
  'estimated',
]);

/**
 * Résout la provenance d'un run. 'gateway' UNIQUEMENT si un secret non vide est
 * fourni ET égal au secret partagé attendu de l'org. Sinon 'self'. Jamais
 * dérivé du DTO — le secret vient d'un header, l'attendu d'un OrgSetting.
 * Comparaison en temps constant (anti timing side-channel sur le secret).
 */
export function resolveRunSource(
  provided: string | null | undefined,
  expected: string | null | undefined,
): RunSource {
  const p = provided?.trim();
  const e = expected?.trim();
  if (!p || !e) return 'self';
  const pb = Buffer.from(p, 'utf8');
  const eb = Buffer.from(e, 'utf8');
  // timingSafeEqual exige des longueurs égales ; une longueur différente n'est
  // jamais un match (l'égalité de longueur seule ne révèle pas le secret).
  if (pb.length !== eb.length) return 'self';
  return timingSafeEqual(pb, eb) ? 'gateway' : 'self';
}

/**
 * Décide si un run déclaré est suspect. Signaux binaires :
 *  - `no_tokens`       : un livrable produit mais 0 token déclaré ;
 *  - `zero_cost`       : coût déclaré 0 alors qu'un coût de référence > 0 existe ;
 *  - `below_reference` : coût déclaré < 50 % du coût de référence dérivé.
 *
 * Un run MESURÉ (`gateway`/`runtime_log`) ou ESTIMÉ (`estimated`) n'est jamais
 * suspect : ses tokens sont exacts (mesurés) ou son coût est posé par le serveur.
 */
export function detectAnomaly(x: {
  hasDeliverable: boolean;
  tokensTotal: number;
  declaredCost: number | null;
  derivedCost: number | null;
  source?: string | null;
}): RunAnomaly {
  if (x.source && MEASURED_OR_ESTIMATED.has(x.source)) return null;
  if (x.hasDeliverable && x.tokensTotal === 0) return 'no_tokens';
  if (x.declaredCost === 0 && (x.derivedCost ?? 0) > 0) return 'zero_cost';
  if (
    x.declaredCost != null &&
    x.declaredCost > 0 &&
    x.derivedCost != null &&
    x.derivedCost > 0 &&
    x.declaredCost < x.derivedCost * ANOMALY_UNDERREPORT_RATIO
  ) {
    return 'below_reference';
  }
  return null;
}
