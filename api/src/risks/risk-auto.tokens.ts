/**
 * Token d'injection différée de `RiskAutoService`.
 *
 * Fichier volontairement SANS import : il est importé par
 * `AutomationActionsService` pour résoudre `RiskAutoService` en lazy via
 * `ModuleRef` **sans** créer d'import de valeur dans le sens
 * automations → risks (qui n'a aucune raison d'exister — `RisksModule`
 * n'importe jamais `AutomationsModule`). `RisksModule` enregistre l'alias
 * `{ provide: LAZY_RISK_AUTO, useExisting: RiskAutoService }`.
 */
export const LAZY_RISK_AUTO = 'LAZY_RISK_AUTO';
