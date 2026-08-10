/**
 * Token d'injection différée de `AgentRunsService`.
 *
 * Fichier volontairement SANS import (surtout pas `@db`) : il est importé par
 * `McpToolQuotaInterceptor` pour résoudre `AgentRunsService` en lazy via
 * `ModuleRef` **sans** créer d'import de valeur (qui tirerait tout le graphe
 * Prisma dans les tests isolés de l'intercepteur, et rapprocherait d'un cycle).
 * `AgentRunsModule` enregistre l'alias `{ provide: LAZY_AGENT_RUNS, useExisting }`.
 */
export const LAZY_AGENT_RUNS = 'LAZY_AGENT_RUNS';
