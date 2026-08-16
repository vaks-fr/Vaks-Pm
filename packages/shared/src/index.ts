// ============================================================
// @vaks-pm/shared — types, enums et constantes partagés
// entre l'API, le worker et le web.
// ============================================================

// ---------- Permissions (format `ressource:action`) ----------
export const PERMISSIONS = [
  'org:manage',
  'org:settings',
  'member:manage',
  'role:manage',
  'project:create',
  'project:view',
  'project:view_all',
  'project:update',
  'project:archive',
  'project:delete',
  'project:assign_managers',
  'task:create',
  'task:view',
  'task:update',
  'task:delete',
  // Revue des livrables (chantier 2c) : approuver / demander des changements sur
  // une tâche en revue (IN_REVIEW → APPROVED / CHANGES_REQUESTED). **Jamais**
  // mappé par une capability d'agent (anti auto-approbation — un agent ne peut
  // pas valider son propre travail). Accordé aux rôles managers (humains).
  'task:review',
  'comment:create',
  'attachment:manage',
  // Gestion des clés de chiffrement (rotation KEK/DEK, DORA). Accordé aux
  // ORG_ADMIN ; pensé comme hook pour un rôle « key custodian » distinct (la
  // séparation des tâches réelle arrive avec l'HSM — un admin isAdmin bypasse).
  'crypto:manage',
  'time:log',
  'allocation:manage',
  // Écriture des absences (time-offs) UNIQUEMENT — scope étroit pensé pour les
  // clés org des connecteurs inbound RH (`POST /time-offs/bulk-upsert` et
  // `/time-offs/import-csv`). Inclus dans les rôles managers ; `allocation:manage`
  // reste requis pour les allocations / work schedules / time-offs unitaires.
  'timeoff:write',
  'report:view',
  'report:view_all',
  'finance:view',
  'finance:manage',
  'webhook:manage',
  'client:view',
  'client:manage',
  // Cycle de vie des équipes : create/delete réservés (ORG_ADMIN, ou un rôle
  // délégué plus tard). `team:manage_members` couvre l'édition de l'équipe et
  // de ses membres — accordé aux ORG_ADMIN et, de façon team-scopée, aux leads
  // de l'équipe ciblée (cf. RbacService.getEffectivePermissions).
  'team:create',
  'team:delete',
  'team:manage_members',
  // Lecture du journal d'audit via l'API publique (`GET /audit-logs` + export).
  // Pensé pour les clés ORG (pull SIEM / archivage externe) ; un PAT ne
  // fonctionne que si le user sous-jacent a la permission (admins).
  'audit:read',
  // Provisioning SCIM 2.0 (phase 10 lot 2). Porté par une **clé organisation**
  // que l'IdP (Entra) utilise comme bearer sur `/scim/v2/*`. N'ouvre QUE la
  // surface SCIM (pas l'app privée ni l'API publique).
  'scim:provision',
  // Marqueur de jeton MCP (phase 11). ⚠️ **N'est PAS un gate d'accès et n'est
  // dans AUCUN rôle tenant.** Historiquement pensé pour « conditionner le droit
  // d'emprunter la surface MCP », mais rien ne le vérifie au runtime :
  // `@PublicApi(scope)` ne lit que le booléen « route publique », pas le scope,
  // et `me/mcp-context` n'a pas de PermissionsGuard. Il est simplement accordé
  // par défaut à tout jeton OAuth MCP (`OAuthService.DEFAULT_SCOPES`) et annoncé
  // dans `scopes_supported` — un signal d'origine, pas une autorisation.
  // Ce qui gouverne RÉELLEMENT l'accès MCP : la licence `mcp` + le toggle
  // `mcp.enabled` (vérifiés à l'ÉMISSION du jeton) + la révocation de connexion
  // (Sécurité → Connexions IA) ; et chaque opération reste bornée par
  // RBAC(user) ∩ scopes(jeton) ∩ capabilities(agent). Retirer ce scope d'un
  // rôle est donc sans effet (il n'y est pas) : le laisser ici ne sert que le
  // vocabulaire OAuth, pas le RBAC.
  'mcp:access',
  // Gestion des agents IA (chantier agents 1) : CRUD des identités agents,
  // mint/revoke de leurs jetons, connecteurs d'annuaire, et enregistrement
  // entrant `POST /agents` (clé org scopée). Accordé aux ORG_ADMIN.
  'agent:manage',
  // Déclaration d'un espace de collaboration externe rattaché à un projet
  // (`PUT /projects/:id/collab-spaces/:provider`). Scope étroit pensé pour les
  // clés org d'un provisioner externe qui gère lui-même Teams/Slack/Google :
  // il DÉCLARE le lien, il ne modifie rien d'autre du projet (`project:update`
  // serait bien trop large). Pas dans les bundles de rôles : ORG_ADMIN l'a via ALL.
  'collab:link',
  // Gestion de l'abonnement de nudge sortant (réveil des agents). Scope
  // **volontairement minimal** pour une clé org dédiée collée dans le provider
  // (Copilot/n8n) : elle ne peut QUE créer/supprimer un abonnement de nudge sur
  // `POST/DELETE /me/webhook-subscriptions`, RIEN d'autre (pas de lecture de
  // tâches contrairement à `task:view`). Si elle fuite, elle n'expose aucune
  // donnée. Pas dans les rôles : réservé aux clés org générées par la feature.
  'nudge:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// ---------- Agents IA (AGENTS_ARCHITECTURE.md, chantier 1) ----------

export const ACTOR_KINDS = ['HUMAN', 'AGENT'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const AGENT_TRUST_LEVELS = ['DRAFT_ONLY', 'SUPERVISED', 'AUTONOMOUS'] as const;
export type AgentTrustLevel = (typeof AGENT_TRUST_LEVELS)[number];

/**
 * Permissions qu'AUCUNE capability d'agent ne peut mapper — interdits
 * structurels (ceinture ; les policies du chantier 3 seront les bretelles) :
 * finance, clients, administration, timesheet (strictement humaine), et plus
 * tard `task:review` (anti auto-approbation, chantier 2). Un test vitest
 * garantit la disjonction avec AGENT_CAPABILITIES.
 */
export const AGENT_FORBIDDEN_PERMISSIONS: readonly Permission[] = [
  'org:manage', 'org:settings', 'member:manage', 'role:manage',
  'finance:view', 'finance:manage', 'client:view', 'client:manage',
  'time:log', 'timeoff:write', 'crypto:manage', 'audit:read', 'scim:provision',
  'agent:manage', 'collab:link', 'webhook:manage', 'team:create', 'team:delete',
  'team:manage_members', 'project:delete', 'project:assign_managers',
  // Anti auto-approbation (chantier 2c) : un agent ne review jamais un livrable.
  'task:review',
] as const;

/**
 * Vocabulaire des capabilities d'agent → permissions effectives. Les droits
 * d'un agent = RBAC (rôle projet/org) ∩ scopes du jeton ∩ union de ces maps.
 * Dérivation vivante à l'auth — jamais de hardcode par nom d'agent.
 */
export const AGENT_CAPABILITIES = {
  /** Lecture du périmètre projet (board, tâches, rapports non financiers). */
  'read:project': ['project:view', 'task:view', 'report:view'],
  /** Exécuter des tâches : mise à jour de tâches assignées (statut, champs). */
  'tasks:execute': ['task:view', 'task:update'],
  /** Poster des commentaires (questions, comptes rendus d'avancement). */
  'comments:post': ['task:view', 'comment:create'],
  /**
   * Décomposer une tâche trop vaste en sous-tâches (lot B). Mappe `task:create`,
   * mais le POUVOIR est **restreint à l'action** côté serveur : un agent ne peut
   * créer que des **enfants de la tâche qu'il tient**, dans le même projet, sans
   * poser lui-même de champ de gouvernance (budget/enjeu/critères), et sans
   * descendre au-delà d'un niveau. Sans cette restriction, `task:create` serait
   * une porte de sortie : un agent plafonné sur une tâche s'ouvrirait une tâche
   * neuve, hors enveloppe et hors périmètre.
   */
  'tasks:decompose': ['task:view', 'task:create'],
  /** Contribuer à la documentation : commentaires + pièces jointes. */
  'docs:contribute': ['task:view', 'comment:create', 'attachment:manage'],
  /**
   * Soumettre des livrables (PJ ; endpoints Deliverable au chantier 2).
   * `task:update` est requis : `POST /tasks/:taskId/deliverables` exige cette
   * permission côté contrôleur — sans elle un agent porteur de la seule capability
   * `deliverables:submit` recevait 403 et ne pouvait jamais soumettre (audit sécu
   * 2026-08-01, finding #5).
   */
  'deliverables:submit': ['task:view', 'task:update', 'attachment:manage'],
  /**
   * Valider les livrables d'AUTRES agents (phase D `agent_validator`). Ne mappe
   * QUE `task:view` (lecture) — le POUVOIR de valider n'est PAS une permission
   * RBAC (jamais `task:review`, interdit aux agents) mais une capacité vérifiée
   * directement à l'action : `actorKind=AGENT` + cette capability + **validateur
   * ≠ auteur** (séparation des tâches par identité). Un verdict d'agent validateur
   * est une PREUVE (force 2), pas l'approbation humaine terminale.
   */
  'deliverables:validate': ['task:view'],
} as const satisfies Record<string, readonly Permission[]>;

export type AgentCapability = keyof typeof AGENT_CAPABILITIES;
export const AGENT_CAPABILITY_KEYS = Object.keys(AGENT_CAPABILITIES) as AgentCapability[];

/** Union des permissions accordées par un set de capabilities (clés inconnues ignorées). */
export function permissionsForCapabilities(capabilities: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const cap of capabilities) {
    const perms = (AGENT_CAPABILITIES as Record<string, readonly Permission[]>)[cap];
    if (perms) for (const p of perms) out.add(p);
  }
  return [...out];
}

// ---------- Moteur de policies agents (AGENTS_ARCHITECTURE.md, chantier 3) ----------

/**
 * Actions possibles d'une policy (AGENTS_ARCHITECTURE.md §chantier 3) :
 *  - `deny`           : la transition/le claim est refusé (403).
 *  - `require_review` : pas de clôture automatique — un livrable doit passer par
 *                       la porte de revue humaine (auto-close désactivé, l'agent
 *                       est bloqué au-delà d'IN_REVIEW).
 *  - `notify`         : autorisé mais on prévient (owner de l'agent / PM).
 */
export const AGENT_POLICY_ACTIONS = ['require_review', 'deny', 'notify'] as const;
export type AgentPolicyAction = (typeof AGENT_POLICY_ACTIONS)[number];

/**
 * « Enjeu » d'une tâche (spec vérification `AGENTS_VERIFICATION.md` §4). Sert de
 * dimension `scopeIn` des policies et, en phase B, à dériver `required_methods`
 * (enjeu × trust). Croissant en criticité.
 */
export const AGENT_TASK_STAKES = ['low', 'medium', 'high', 'critical'] as const;
export type AgentTaskStakes = (typeof AGENT_TASK_STAKES)[number];

/**
 * Condition d'une règle de policy. TOUS les prédicats présents doivent matcher
 * (ET logique) ; un prédicat absent est ignoré. Les listes matchent par
 * appartenance (OU). `labelIn`/`scopeIn` sont insensibles à la casse.
 */
export interface AgentPolicyCondition {
  /** Noms de labels de la tâche (au moins un présent). */
  labelIn?: string[];
  /** Type d'acteur ('AGENT' cible les agents, 'HUMAN' les humains). */
  actorKind?: ActorKind;
  /** Niveaux de confiance de l'agent auteur. */
  trustLevelIn?: AgentTrustLevel[];
  /** Enjeu de la tâche (dimension terrain — cf. AgentTaskStakes). */
  scopeIn?: AgentTaskStakes[];
  /** S'applique quand l'estimation dépasse ce seuil (heures). */
  estimateHoursGt?: number;
  /** Transition ciblée, ex. 'TODO->CLAIMED' ou 'IN_REVIEW->APPROVED'. */
  transition?: string;
}

/** Une règle de policy déclarative (stockée dans `OrgSetting agents.policies`). */
export interface AgentPolicyRule {
  /** Identifiant stable (pour l'audit / l'édition UI). */
  id?: string;
  /** Libellé lisible. */
  description?: string;
  if: AgentPolicyCondition;
  then: AgentPolicyAction;
  /**
   * Mode d'application (spec vérification) : `enforce` bloque, `report_only`
   * journalise l'écart sans bloquer (calibration). Défaut `enforce`.
   */
  mode?: 'enforce' | 'report_only';
}

/** Contexte évalué contre les règles (résolu par l'appelant, jamais côté client). */
export interface AgentPolicyContext {
  actorKind: ActorKind;
  trustLevel?: AgentTrustLevel | null;
  /** Noms de labels de la tâche. */
  labels?: string[];
  /** Enjeu de la tâche (défaut 'low' si non fixé). */
  scope?: AgentTaskStakes | null;
  estimateHours?: number | null;
  /** Transition 'from->to' (au claim : 'TODO->CLAIMED'). */
  transition?: string;
}

/** Résultat agrégé de l'évaluation (toutes règles matchées confondues). */
export interface AgentPolicyOutcome {
  /** Au moins une règle `deny` a matché → refuser. */
  deny: boolean;
  /** Au moins une règle `require_review` a matché → pas d'auto-close. */
  requireReview: boolean;
  /** Au moins une règle `notify` a matché → prévenir. */
  notify: boolean;
  /** En `enforce` (défaut) le deny bloque ; en `report_only` on journalise seulement. */
  enforce: boolean;
  /** Règles ayant matché (index dans le tableau source + action) — audit. */
  matched: { index: number; id?: string; action: AgentPolicyAction }[];
}

/** Un prédicat de condition matche-t-il le contexte ? (une règle sans condition
 *  ne matche jamais — garde-fou contre une règle « attrape-tout » accidentelle). */
function conditionMatches(cond: AgentPolicyCondition, ctx: AgentPolicyContext): boolean {
  let hasPredicate = false;
  if (cond.actorKind != null) {
    hasPredicate = true;
    if (cond.actorKind !== ctx.actorKind) return false;
  }
  if (cond.trustLevelIn && cond.trustLevelIn.length) {
    hasPredicate = true;
    if (!ctx.trustLevel || !cond.trustLevelIn.includes(ctx.trustLevel)) return false;
  }
  if (cond.labelIn && cond.labelIn.length) {
    hasPredicate = true;
    const want = cond.labelIn.map((s) => s.toLowerCase());
    const have = (ctx.labels ?? []).map((s) => s.toLowerCase());
    if (!want.some((w) => have.includes(w))) return false;
  }
  if (cond.scopeIn && cond.scopeIn.length) {
    hasPredicate = true;
    if (!cond.scopeIn.includes(ctx.scope ?? 'low')) return false;
  }
  if (cond.estimateHoursGt != null) {
    hasPredicate = true;
    if (!(typeof ctx.estimateHours === 'number' && ctx.estimateHours > cond.estimateHoursGt))
      return false;
  }
  if (cond.transition != null) {
    hasPredicate = true;
    if (cond.transition !== ctx.transition) return false;
  }
  return hasPredicate;
}

/**
 * Évalue un ensemble de règles contre un contexte — **fonction pure** (spec
 * exécutable, voir `policy-engine.spec.ts`). Agrège toutes les règles qui
 * matchent : `deny` l'emporte, `require_review` s'accumule, `notify` s'accumule.
 * `enforce` est faux seulement si TOUTES les règles matchées sont `report_only`.
 */
export function evaluateAgentPolicies(
  rules: readonly AgentPolicyRule[],
  ctx: AgentPolicyContext,
): AgentPolicyOutcome {
  const out: AgentPolicyOutcome = {
    deny: false,
    requireReview: false,
    notify: false,
    enforce: false,
    matched: [],
  };
  rules.forEach((rule, index) => {
    if (!rule || !rule.if || !conditionMatches(rule.if, ctx)) return;
    out.matched.push({ index, id: rule.id, action: rule.then });
    if (rule.then === 'deny') out.deny = true;
    else if (rule.then === 'require_review') out.requireReview = true;
    else if (rule.then === 'notify') out.notify = true;
    if (rule.mode !== 'report_only') out.enforce = true;
  });
  return out;
}

/**
 * Normalise/valide un tableau de règles brut (issu du JSON `agents.policies`).
 * Rejette les règles malformées (action inconnue, condition non-objet) en les
 * ignorant plutôt qu'en throw — l'appelant strict (validation admin) peut
 * comparer longueurs pour détecter une entrée rejetée.
 */
export function normalizeAgentPolicies(raw: unknown): AgentPolicyRule[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentPolicyRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (!AGENT_POLICY_ACTIONS.includes(r.then as AgentPolicyAction)) continue;
    if (!r.if || typeof r.if !== 'object' || Array.isArray(r.if)) continue;
    const c = r.if as Record<string, unknown>;
    const cond: AgentPolicyCondition = {};
    if (c.actorKind === 'AGENT' || c.actorKind === 'HUMAN') cond.actorKind = c.actorKind;
    if (Array.isArray(c.trustLevelIn)) {
      const v = c.trustLevelIn.filter(
        (x): x is AgentTrustLevel => (AGENT_TRUST_LEVELS as readonly string[]).includes(x as string),
      );
      if (v.length) cond.trustLevelIn = v;
    }
    if (Array.isArray(c.labelIn)) {
      const v = c.labelIn.filter((x): x is string => typeof x === 'string' && !!x.trim())
        .map((x) => x.trim());
      if (v.length) cond.labelIn = v;
    }
    if (Array.isArray(c.scopeIn)) {
      const v = c.scopeIn.filter(
        (x): x is AgentTaskStakes => (AGENT_TASK_STAKES as readonly string[]).includes(x as string),
      );
      if (v.length) cond.scopeIn = v;
    }
    if (typeof c.estimateHoursGt === 'number' && Number.isFinite(c.estimateHoursGt) && c.estimateHoursGt >= 0) {
      cond.estimateHoursGt = c.estimateHoursGt;
    }
    if (typeof c.transition === 'string' && c.transition.trim()) cond.transition = c.transition.trim();
    // Une règle sans aucun prédicat ne matcherait jamais : on la rejette.
    if (Object.keys(cond).length === 0) continue;
    const rule: AgentPolicyRule = { if: cond, then: r.then as AgentPolicyAction };
    if (typeof r.id === 'string' && r.id.trim()) rule.id = r.id.trim();
    if (typeof r.description === 'string' && r.description.trim()) rule.description = r.description.trim();
    if (r.mode === 'report_only' || r.mode === 'enforce') rule.mode = r.mode;
    out.push(rule);
  }
  return out;
}

/**
 * Allowlist de modèles d'agent par client (chantier 3). Un client peut
 * restreindre quels providers/modèles d'IA sont autorisés à travailler sur ses
 * projets (souveraineté, conformité). Entrées : `provider/model` exact ou
 * `provider/` suivi d'une étoile (tous les modèles d'un provider) ; une étoile
 * seule = tout autorisé. Liste vide = aucune restriction. Comparaison
 * **insensible à la casse**.
 *
 * ⚠️ Allowlist **active mais agent sans modèle déclaré** → refus (fail-closed) :
 * on ne peut pas prouver la conformité d'un agent qui n'annonce pas son modèle.
 */
export function isAgentModelAllowed(
  allowed: readonly string[] | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  const list = (allowed ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true; // pas de restriction
  if (list.includes('*') || list.includes('*/*')) return true;
  const p = (provider ?? '').trim().toLowerCase();
  const m = (model ?? '').trim().toLowerCase();
  if (!p || !m) return false; // fail-closed : modèle non déclaré
  return list.includes(`${p}/${m}`) || list.includes(`${p}/*`);
}

/** Normalise une allowlist de modèles (trim, minuscule, dédoublonne, non-vides,
 *  format `provider/model` ou `provider/*` ou `*`). Rejette silencieusement les
 *  entrées malformées. */
export function normalizeAllowedAgentModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim().toLowerCase();
    if (!v) continue;
    if (v === '*' || v === '*/*') { out.add(v); continue; }
    // provider/model ou provider/* — un seul slash, deux segments non vides.
    if (/^[a-z0-9][a-z0-9.\-_]*\/(?:\*|[a-z0-9][a-z0-9.\-_]*)$/.test(v)) out.add(v);
  }
  return [...out];
}

/** Règles par défaut si `agents.policies` n'a jamais été initialisé
 *  (AGENTS_ARCHITECTURE.md : label `production` → require_review). */
export const DEFAULT_AGENT_POLICIES: AgentPolicyRule[] = [
  {
    id: 'default-production-review',
    description: 'Toute tâche « production » produite par un agent exige une revue humaine.',
    if: { labelIn: ['production', 'prod'], actorKind: 'AGENT' },
    then: 'require_review',
  },
];

// ---------- Échelle d'un rôle ----------
export enum RoleScope {
  ORG = 'ORG',
  PROJECT = 'PROJECT',
}

// ---------- Rôles système prédéfinis ----------
export interface RoleDefinition {
  key: string;
  name: string;
  scope: RoleScope;
  permissions: Permission[];
}

const ALL: Permission[] = [...PERMISSIONS];

/**
 * Système de rôles — DEUX échelles complémentaires (ORG + PROJECT).
 *
 * - ORG : un seul rôle par user (table `Membership`). Définit ce que l'user
 *   peut faire au niveau organisation : gérer les membres, voir tous les
 *   projets, créer un projet, etc.
 *
 * - PROJECT : zéro ou plusieurs (un par projet, table `ProjectMember`).
 *   Surcharge / complète le rôle ORG sur ce projet précis.
 *
 * Permissions effectives = UNION (rôle org) ∪ (rôle projet sur le projet ciblé).
 * Un user avec `isAdmin: true` court-circuite ce calcul et a toutes les permissions.
 *
 * Garder ces définitions synchronisées avec `api/prisma/seed-runtime.js`
 * (seed runtime sans ts-node ; pas d'import possible).
 */
export const SYSTEM_ROLES: Record<string, RoleDefinition> = {
  // -------------------- Org-scoped --------------------
  ORG_ADMIN: {
    key: 'ORG_ADMIN',
    name: 'Org Admin',
    scope: RoleScope.ORG,
    permissions: ALL,
  },
  PORTFOLIO_MANAGER: {
    key: 'PORTFOLIO_MANAGER',
    name: 'Portfolio Manager',
    scope: RoleScope.ORG,
    // Rôle org-wide : pilote la vue transverse sur tous les projets
    // facturables de l'organisation (portefeuille). Bypass des policies de
    // création pour les projets facturables. Seul rôle (avec
    // GLOBAL_REPORT_VIEWER) à voir les rates / coûts / montants facturés.
    permissions: [
      'project:create', 'project:view', 'project:view_all',
      'project:update', 'project:archive', 'project:delete', 'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view', 'report:view_all', 'finance:view', 'finance:manage',
      'client:view', 'client:manage',
    ],
  },
  GLOBAL_REPORT_VIEWER: {
    key: 'GLOBAL_REPORT_VIEWER',
    name: 'Global Report Viewer',
    scope: RoleScope.ORG,
    // Lecture seule transverse sur toute l'organisation à des fins de
    // reporting. Voit tous les projets, toutes les tâches, et les données
    // financières (rates, coûts). Ne peut rien modifier. NB : ORG_ADMIN
    // (permissions = ALL) voit aussi la donnée financière — ce rôle-ci n'est
    // que la déclinaison lecture seule, sans pouvoir d'administration.
    permissions: [
      'project:view', 'project:view_all',
      'task:view',
      'report:view', 'report:view_all', 'finance:view',
      'client:view',
    ],
  },
  TEAM_MANAGER: {
    key: 'TEAM_MANAGER',
    name: 'Team Manager',
    scope: RoleScope.ORG,
    // Manager d'une (ou plusieurs) équipe(s). Peut créer un projet
    // (facturable ou non) si la policy org l'autorise (mode 'roles' incluant
    // TEAM_MANAGER, ou mode 'teams' incluant une de ses équipes). Peut
    // basculer le flag `canCreateNonBillableProject` sur ses membres.
    permissions: [
      'project:create', 'project:view',
      'project:update', 'project:archive', 'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view',
    ],
  },
  ORG_MEMBER: {
    key: 'ORG_MEMBER',
    name: 'Org Member',
    scope: RoleScope.ORG,
    // Rôle par défaut. Un membre d'équipe peut consulter et travailler sur
    // les projets assignés à son équipe (visibilité filtrée côté
    // ProjectsService.findAll via ProjectTeam ∩ TeamMember). Il peut ouvrir
    // le board, la liste, la timeline, voir le workload de son équipe,
    // logger du temps et commenter. Les actions structurantes (assigner les
    // PM, gérer les membres, gérer les allocations/time-offs) restent
    // réservées aux rôles PROJECT_MANAGER / PORTFOLIO_MANAGER / ORG_ADMIN.
    permissions: [
      'org:settings',
      // `project:create` retiré : seuls ORG_ADMIN et PORTFOLIO_MANAGER
      // peuvent initier un nouveau projet (cycle DRAFT → charter).
      'project:view',
      'task:view', 'task:create', 'task:update',
      'comment:create', 'attachment:manage', 'time:log',
      'report:view',
    ],
  },

  // ------------------- Project-scoped -------------------
  PROJECT_MANAGER: {
    key: 'PROJECT_MANAGER',
    name: 'Project Manager',
    scope: RoleScope.PROJECT,
    // Gère un projet précis : tâches, allocations, équipe du projet
    // (assigner/retirer Contributors, Viewers, Guests, ou d'autres PM
    // co-pilotes). NB : la permission `project:assign_managers` est
    // évaluée par le PermissionsGuard avec le `projectId` de la requête
    // — donc elle ne donne PAS le droit d'éditer les autres projets.
    // `member:manage` reste org-scopé (ORG_ADMIN uniquement).
    permissions: [
      'project:view', 'project:update', 'project:archive',
      'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view',
    ],
  },
  CONTRIBUTOR: {
    key: 'CONTRIBUTOR',
    name: 'Contributor',
    scope: RoleScope.PROJECT,
    permissions: [
      'project:view', 'task:create', 'task:view', 'task:update',
      'comment:create', 'attachment:manage', 'time:log',
    ],
  },
  VIEWER: {
    key: 'VIEWER',
    name: 'Viewer',
    scope: RoleScope.PROJECT,
    // Lecture seule + rapports.
    permissions: ['project:view', 'task:view', 'report:view'],
  },
  GUEST: {
    key: 'GUEST',
    name: 'Guest',
    scope: RoleScope.PROJECT,
    // Strictement consultation, pas de rapports.
    permissions: ['project:view', 'task:view'],
  },
};

/** DTO d'un rôle tel qu'exposé par l'API (`GET /admin/roles`). */
export interface RoleDto {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
  permissions: string[];
  isSystem: boolean;
}

// ---------- Enums métier ----------
export enum TaskStatus {
  TODO = 'TODO',
  // Étape agents (chantier 2) — additif, IN_REVIEW conservé.
  CLAIMED = 'CLAIMED',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  APPROVED = 'APPROVED',
  ON_HOLD = 'ON_HOLD',
  DONE = 'DONE',
}

/** Les 5 statuts « de base » = les 5 colonnes de board. Les 3 statuts agents
 *  (CLAIMED / CHANGES_REQUESTED / APPROVED) se replient sur l'un d'eux. */
export const BASE_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.ON_HOLD,
  TaskStatus.DONE,
];

/** Repli d'un statut agent vers sa colonne de base. SOURCE DE VÉRITÉ unique,
 *  partagée par le placement front (board / vues fold-driven) et le
 *  réalignement `boardColumnId` back — pour qu'ils ne divergent jamais.
 *  CLAIMED = agent au travail → IN_PROGRESS ; CHANGES_REQUESTED = retravail
 *  → IN_PROGRESS ; APPROVED = revue passée, pas encore clôturé → IN_REVIEW. */
export const AGENT_STATUS_FOLD: Readonly<Partial<Record<TaskStatus, TaskStatus>>> = {
  [TaskStatus.CLAIMED]: TaskStatus.IN_PROGRESS,
  [TaskStatus.CHANGES_REQUESTED]: TaskStatus.IN_PROGRESS,
  [TaskStatus.APPROVED]: TaskStatus.IN_REVIEW,
};

/** true si le statut appartient au cycle de vie agent (hors 5 colonnes de base). */
export function isAgentStatus(status: TaskStatus | string): boolean {
  return (
    status === TaskStatus.CLAIMED ||
    status === TaskStatus.CHANGES_REQUESTED ||
    status === TaskStatus.APPROVED
  );
}

/** Replie un statut sur sa colonne de base (l'une des 5). Un statut de base se
 *  renvoie lui-même ; un statut inconnu retombe sur TODO (défensif). */
export function foldToBaseStatus(status: TaskStatus | string): TaskStatus {
  const folded = AGENT_STATUS_FOLD[status as TaskStatus];
  if (folded) return folded;
  return BASE_TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : TaskStatus.TODO;
}

export enum TaskPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum ProjectStatus {
  DRAFT = 'DRAFT',
  OFFER_SENT = 'OFFER_SENT',
  CHARTER_REVIEW = 'CHARTER_REVIEW',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED',
}

/** Santé projet (RAG) éditoriale pour le point de statut client. Distincte de
 *  `ProjectStatus` (cycle de vie commercial). */
export type ProjectHealth = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';

export enum DependencyType {
  FS = 'FS', // finish-to-start
  SS = 'SS',
  FF = 'FF',
  SF = 'SF',
}

// ---------- DTO / contrats d'API ----------
export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** Source d'identité d'un user (cf. Prisma `AuthProvider`). */
export type AuthProvider = 'LOCAL' | 'OIDC' | 'SAML';

/** L'user a MFA activé : il doit fournir un code via /auth/login/mfa. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
}

/** La policy org force MFA mais l'user n'a pas encore enrollé : l'UI doit
 *  afficher le QR via /auth/mfa/forced-enroll/start avec ce token. */
export interface MfaEnrollmentRequiredResponse {
  mfaEnrollmentRequired: true;
  enrollToken: string;
  email: string;
}

/** Type union : succès direct ou demande de second facteur. */
export type LoginResponse =
  | AuthTokens
  | MfaChallengeResponse
  | MfaEnrollmentRequiredResponse;

export interface MfaLoginDto {
  challengeToken: string;
  code: string;
}

export interface MfaEnrollStartResponse {
  qrCodeDataUrl: string;
  /** Secret Base32 (à afficher pour saisie manuelle dans l'authenticator). */
  secret: string;
}

// ---------- SSO / identité fédérée (phase 10) ----------

/** Provider SSO exposé à l'écran de login (`GET /auth/sso/providers`). Public,
 *  rien de sensible. */
export interface SsoProviderPublicDto {
  slug: string;
  type: 'OIDC' | 'SAML';
  displayName: string;
}

/** Règle de mapping groupe/claim IdP → rôle org. */
export interface IdpRoleMapping {
  match: string;
  roleKey: string;
}

/** Fournisseur d'identité tel qu'exposé à l'admin. Ne contient JAMAIS de
 *  secret (le client secret OIDC vit en Swarm secret). */
export interface IdentityProviderDto {
  id: string;
  type: 'OIDC' | 'SAML';
  slug: string;
  displayName: string;
  enabled: boolean;
  oidcDiscoveryUrl: string | null;
  oidcClientId: string | null;
  oidcScopes: string[];
  /** True si le secret client (Swarm secret) est monté côté serveur. */
  clientSecretConfigured: boolean;
  /** True si l'auth **certificat** (private_key_jwt, secretless) est configurée. */
  certAuthConfigured: boolean;
  /** Empreinte (x5t) du certificat — non-secret, pour affichage. */
  oidcCertThumbprint: string | null;
  /** SAML — SSO URL de l'IdP. */
  samlEntryPoint: string | null;
  /** SAML — entityID du SP (nous). Null = défaut (URL des métadonnées). */
  samlIssuer: string | null;
  /** SAML — certificat X.509 de signature de l'IdP (PEM, public). */
  samlIdpCert: string | null;
  jitProvisioning: boolean;
  /** IdP fait autorité : rétrograde au rôle par défaut quand aucun groupe ne matche. */
  syncRolesOnLogin: boolean;
  defaultRoleKey: string | null;
  linkStrategy: string;
  /** Clé de rapprochement d'un compte LOCAL préexistant : 'upn' (défaut, sûr) | 'email'. */
  linkMatchKey: string;
  roleMappings: IdpRoleMapping[];
  claimMappings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertIdentityProviderDto {
  type?: 'OIDC' | 'SAML';
  slug?: string;
  displayName?: string;
  enabled?: boolean;
  oidcDiscoveryUrl?: string | null;
  oidcClientId?: string | null;
  /** Client secret en clair — **write-only**. Chiffré au repos par tenant ;
   *  jamais renvoyé. Omettre / chaîne vide = inchangé. */
  oidcClientSecret?: string | null;
  /** Clé privée PEM PKCS#8 (mode certificat, secretless) — **write-only**,
   *  chiffrée, jamais renvoyée. Omettre / vide = inchangé. Prime sur le secret. */
  oidcPrivateKey?: string | null;
  /** Empreinte (x5t, hex) du certificat Entra — non-secret, requise avec la clé privée. */
  oidcCertThumbprint?: string | null;
  oidcScopes?: string[];
  /** SAML — SSO URL de l'IdP (https). */
  samlEntryPoint?: string | null;
  /** SAML — entityID du SP. Omettre = défaut (URL des métadonnées). */
  samlIssuer?: string | null;
  /** SAML — certificat X.509 de signature de l'IdP (PEM public). */
  samlIdpCert?: string | null;
  jitProvisioning?: boolean;
  syncRolesOnLogin?: boolean;
  defaultRoleKey?: string | null;
  linkStrategy?: 'link' | 'reject';
  linkMatchKey?: 'upn' | 'email';
  roleMappings?: IdpRoleMapping[];
  claimMappings?: Record<string, string>;
}

/** Résultat du test de connexion d'un provider OIDC ou SAML. */
export interface IdpTestResultDto {
  ok: boolean;
  issuer?: string;
  discoveryOk?: boolean;
  clientIdConfigured?: boolean;
  clientSecretConfigured?: boolean;
  // SAML
  entryPointConfigured?: boolean;
  idpCertConfigured?: boolean;
  error?: string;
}

// ---- External ticketing connectors (ServiceNow, Jira, …) ----

/** Type d'un champ de config d'un connecteur, rendu par l'UI admin générique. */
export type ConnectorFieldType = 'text' | 'url' | 'password' | 'textarea' | 'multiselect';

/** Descripteur d'un champ de config propre à un fournisseur. */
export interface ConnectorFieldDescriptorDto {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required: boolean;
  /** Secret → write-only, jamais renvoyé. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Lien de documentation externe affiché à côté de l'aide. */
  helpUrl?: string;
  options?: { value: string; label: string }[];
  default?: string | string[];
}

/** Carte d'identité d'un type de fournisseur (catalogue admin). */
export interface ConnectorProviderDescriptorDto {
  source: string;
  label: string;
  blurb: string;
  /** Couleur de marque (hex) pour la tuile/logo de la carte. */
  accent?: string;
  /** Monogramme court (≤ 3 car.) affiché dans la tuile à défaut de logo. */
  short?: string;
  fields: ConnectorFieldDescriptorDto[];
}

/** Connecteur configuré — ne contient JAMAIS de secret en clair. */
export interface TicketingConnectorDto {
  id: string;
  source: string;
  label: string;
  enabled: boolean;
  /** Valeurs des champs NON secrets uniquement. */
  config: Record<string, unknown>;
  /** Noms des champs secrets renseignés (valeurs jamais renvoyées). */
  secretsConfigured: string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** Payload create/update — config et secrets séparés (secrets write-only). */
export interface UpsertTicketingConnectorDto {
  /** Requis à la création (type de fournisseur), figé ensuite. */
  source?: string;
  label?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Valeurs secrètes ; vide/absent = inchangé. */
  secrets?: Record<string, string>;
}

/** Résultat d'un test de connexion d'un connecteur. */
export interface ConnectorTestResultDto {
  ok: boolean;
  detail?: string;
  error?: string;
}

/**
 * Espace de collaboration (équipe Teams, canal Slack, espace Google) rattaché à
 * un projet. Deux origines : `provisioned` = créé par Vaks (provisioning Teams),
 * `external` = créé DEHORS par un outil tiers qui vient le déclarer via
 * `PUT /projects/:id/collab-spaces/:provider` (scope `collab:link`).
 */
export interface CollabSpaceDto {
  id: string;
  projectId: string;
  /** Slug du provider : `msteams`, `slack`, `gchat`, … (`[a-z0-9-]{2,32}`). */
  provider: string;
  /** Identifiant de l'espace côté fournisseur (group id Teams, channel id Slack…). */
  externalId: string | null;
  url: string;
  name: string | null;
  source: 'provisioned' | 'external';
  linkedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Payload de déclaration/mise à jour d'un espace externe (upsert idempotent). */
export interface UpsertCollabSpaceDto {
  /** URL de l'espace (https obligatoire — affichée comme lien sortant). */
  url: string;
  externalId?: string | null;
  name?: string | null;
}

export interface ActiveSessionDto {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  createdAt: string;
  expiresAt: string;
  lastActivityAt: string;
  /** User-Agent au login. Null pour les sessions historiques. */
  userAgent: string | null;
  /** IP cliente au login (premier hop de X-Forwarded-For). Null pour les sessions historiques. */
  ipAddress: string | null;
}

/** Policy de mot de passe org-courante, exposée par `GET /auth/password-policy`. */
export interface PasswordPolicyDto {
  minLength: number;
  complexity: 'Low' | 'Medium' | 'High';
  historyCount: number;
  expiryDays: number;
  /** True si le check anti mot-de-passe-commun est actif (top ~500 bloqués). */
  checkCommonPasswords: boolean;
}

export interface CreateUserDto {
  email: string;
  name: string;
  password?: string;
  isAdmin?: boolean;
  timezone?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  /** Org role assigned via Membership. Defaults to ORG_MEMBER. */
  roleKey?: string;
  /** Identifiant RH/employé interne (unique par organisation). */
  employeeId?: string;
  /** Attribuer un siège de licence (défaut true côté UI pour un user « normal »).
   *  false = compte sans siège (admin-only / parqué). Un passage à true vérifie
   *  le plafond `maxUsers` de la licence. */
  licensed?: boolean;
}

export interface UpdateUserDto {
  email?: string;
  name?: string;
  password?: string;
  isAdmin?: boolean;
  timezone?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  roleKey?: string;
  /** ISO 3166-1 alpha-2 ; '' / null pour hériter du défaut org. */
  countryCode?: string | null;
  /** Identifiant RH/employé interne. null pour effacer. */
  employeeId?: string | null;
  /** Langue d'interface préférée ('en'|'fr'|'it'|'de'). '' / null pour hériter. */
  preferredLanguage?: string | null;
  /** Siège de licence. true→false libère le siège (et coupe les sessions du
   *  user) ; false→true en attribue un (vérifie le plafond `maxUsers`). */
  licensed?: boolean;
  /** Grant « AI administrator » (Membership.isAgentAdmin) : accorde `agent:manage`
   *  par-dessus le rôle org. Réservé aux org-admins (`member:manage`). */
  isAgentAdmin?: boolean;
}

/**
 * Une ligne de l'annuaire admin paginé : un `UserDto` enrichi de son
 * `WorkScheduleDto` (batché côté serveur pour éviter le N+1 `GET /users/:id/work-schedule`).
 * `schedule` est null si l'utilisateur n'a pas encore de schedule explicite
 * (l'UI affiche alors le défaut org).
 */
export interface UserDirectoryRowDto extends UserDto {
  schedule?: WorkScheduleDto | null;
}

/** Une ligne analysée de l'import CSV utilisateurs (dry-run ou commit). */
export interface UserImportRowDto {
  line: number;
  email: string;
  name: string;
  roleKey: string;
  /** true = la ligne passera (ou est passée) ; false = rejetée (voir `error`). */
  valid: boolean;
  /** 'create' | 'skip-existing' : un email déjà présent est ignoré, pas écrasé. */
  action: 'create' | 'skip-existing' | 'error';
  error?: string;
}

/** Résultat d'un import CSV utilisateurs. `dryRun` = prévisualisation sans écriture. */
export interface UserImportResultDto {
  dryRun: boolean;
  total: number;
  /** Lignes valides qui créeront un compte. */
  willCreate: number;
  /** Comptes réellement créés (0 en dry-run). */
  created: number;
  /** Nombre de lignes ignorées car l'email existe déjà. */
  skipped: number;
  /** Nombre de lignes en erreur. */
  invalid: number;
  rows: UserImportRowDto[];
}

/** Page de l'annuaire admin (`GET /users/directory`). */
export interface UserDirectoryPageDto {
  items: UserDirectoryRowDto[];
  /** Nombre total de lignes correspondant au filtre (tous statuts confondus). */
  total: number;
  page: number;
  pageSize: number;
  /** Compteurs par statut sur l'ensemble du filtre (hors pagination). */
  counts: { active: number; suspended: number };
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  /** HUMAN (défaut) ou AGENT — présent pour badger les agents dans les pickers d'affectation. */
  kind?: ActorKind;
  isAdmin: boolean;
  /** Siège de licence : `true` = consomme un siège + accès dashboard ; `false` =
   *  sans siège (admin-only ou parqué, pas d'accès dashboard). */
  licensed?: boolean;
  timezone: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  /** Org-scoped role (Membership). Exposed by admin list/create/update only. */
  roleKey?: string | null;
  roleName?: string | null;
  /** Grant « AI administrator » (Membership.isAgentAdmin) : accorde `agent:manage`
   *  par-dessus le rôle org, sans consommer le slot de rôle. Exposé par l'admin. */
  isAgentAdmin?: boolean;
  /** Permissions org effectives (optionnel, renvoyé par `/auth/me`). `['*']` = admin. */
  permissions?: string[];
  /** True si l'utilisateur est PROJECT_MANAGER d'au moins un projet (renvoyé par `/auth/me`). */
  managesAnyProject?: boolean;
  /** True si l'utilisateur est team lead d'au moins une équipe — ou admin
   *  (renvoyé par `/auth/me`). Conditionne la gestion des congés (time off). */
  isTeamLead?: boolean;
  /** Pays ISO 3166-1 alpha-2 (ex. "FR", "LU") d'où l'utilisateur travaille.
   *  null = hérite du pays par défaut de l'organisation. */
  countryCode?: string | null;
  /** Identifiant RH/employé interne (unique par org). null si non défini. */
  employeeId?: string | null;
  /** Langue d'interface préférée ('en'|'fr'|'it'|'de'). null = hérite du
   *  défaut org / navigateur. Renvoyé par `/auth/me` et l'admin. */
  preferredLanguage?: string | null;
  // ---------- Security (renvoyés par `/auth/me` et l'admin) ----------
  /** Source d'identité (LOCAL = compte interne ; OIDC/SAML = provisionné par IdP). */
  authProvider?: AuthProvider;
  /** Clé stable de l'IdP (objectId Entra / id SCIM). Lecture seule côté admin. */
  externalId?: string | null;
  /** Origine du provisioning IdP ('scim', 'oidc', …) si l'user vient d'un IdP. */
  idpSource?: string | null;
  /** "Break-glass" : autorise le login mot de passe local malgré authProvider != LOCAL. */
  allowLocalLogin?: boolean;
  /** Vrai si l'user a complété l'enrôlement TOTP. */
  mfaEnabled?: boolean;
  /** Vrai si l'user doit changer son mot de passe au prochain login. */
  mustChangePassword?: boolean;
  /** Date (ISO) jusqu'à laquelle le compte est verrouillé (trop d'échecs de
   *  login). null / absent / passée = déverrouillé. Exposé par l'annuaire admin. */
  lockedUntil?: string | null;
}

// ---------- Agents IA — DTOs (chantier 1) ----------

/**
 * Unité de facturation d'un run d'agent. La plupart des providers facturent en
 * **tokens** (in/out distincts) ; Microsoft/GitHub Copilot facturent en
 * **crédits** (compteur unique, pas de séparation entrée/sortie). En crédits, la
 * quantité vit dans `tokensIn` (out=0) et seul le taux d'entrée (=€/1000 crédits)
 * compte — la formule `derivedCost` existante reste valable telle quelle.
 */
export type AgentBillingUnit = 'tokens' | 'credits';

/** Providers facturés en crédits (compteur unique) plutôt qu'en tokens. */
const CREDIT_BILLED_PROVIDERS = new Set(['microsoft-copilot', 'github-copilot']);

/** Déduit l'unité de facturation depuis le provider du modèle (défaut: tokens). */
export function billingUnitForProvider(provider?: string | null): AgentBillingUnit {
  return provider && CREDIT_BILLED_PROVIDERS.has(provider) ? 'credits' : 'tokens';
}

/** Fiche agent renvoyée par `/admin/agents` (jamais de secret). */
export interface AgentDto {
  id: string;
  name: string;
  /** Email synthétique `agent-<slug>@agents.invalid` (jamais de mail envoyé). */
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  trustLevel: AgentTrustLevel;
  /** Humain responsable — toujours présent (obligatoire). */
  ownerId: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  capabilities: string[];
  maxConcurrentTasks?: number | null;
  dailyRunBudget?: number | null;
  modelProvider?: string | null;
  model?: string | null;
  hostingRegion?: string | null;
  /** Unité de facturation dérivée du provider (tokens | credits). Renseignée
   *  serveur — jamais éditable. En crédits, `costRateOutPerKTokens` est null. */
  billingUnit?: AgentBillingUnit;
  /** Coût interne € / 1000 tokens d'ENTRÉE. Dérive le coût d'un run déclaré
   *  avec tokens mais sans `cost` explicite (l'output coûte plus cher → taux
   *  distinct ci-dessous). */
  costRateInPerKTokens?: number | null;
  /** Coût interne € / 1000 tokens de SORTIE. */
  costRateOutPerKTokens?: number | null;
  /** Taux facturé client € / 1000 tokens (fixe, in+out confondus) par défaut —
   *  hérité par les projets (override possible via `AgentProjectRate`). */
  defaultBillRatePerKTokens?: number | null;
  dailyCostBudget?: number | null;
  monthlyCostBudget?: number | null;
  /** Lot 2 — en mode d'application `per_agent`, l'agent suit les prix catalogue. */
  followCatalogPricing?: boolean;
  /** Lot 2 — prix catalogue résolu pour (provider, model) de l'agent, si connu.
   *  Sert au badge « drift » et au bouton « appliquer le prix catalogue ». */
  catalogPrice?: {
    unit: AgentBillingUnit;
    costInPerKUnits: number;
    costOutPerKUnits: number | null;
    source: 'feed' | 'manual' | 'builtin';
  } | null;
  /** Lot 2 — vrai si le taux de coût de l'agent dévie du catalogue (>5 %). */
  priceDrift?: boolean;
  /** Provenance : 'manual' | 'api' | 'entra-agent' | … (idpSource). */
  source: string;
  /** Id externe côté plateforme (object ID Entra, ARN…) si provisionné. */
  externalId?: string | null;
  /** Jetons PAT actifs de l'agent (métadonnées seulement). */
  tokens?: { id: string; name: string; prefix: string; expiresAt: string | null; lastUsedAt: string | null }[];
  createdAt: string;
}

/** Une entrée du catalogue de prix des modèles (`GET /admin/agents/model-catalog`).
 *  Fusion `ModelPrice` (DB, source feed|manual) par-dessus `KNOWN_AGENT_MODELS`
 *  (source builtin, fallback air-gap). */
export interface ModelCatalogEntryDto {
  provider: string;
  model: string;
  label?: string | null;
  unit: AgentBillingUnit;
  costInPerKUnits: number | null;
  costOutPerKUnits: number | null;
  source: 'feed' | 'manual' | 'builtin';
  feedUpdatedAt?: string | null;
}

/** Réponse de `GET /admin/agents/model-catalog`. */
export interface ModelCatalogDto {
  entries: ModelCatalogEntryDto[];
  /** État de la dernière synchro du feed (pour le panneau admin). */
  feedEnabled: boolean;
  applyMode: 'off' | 'all' | 'per_agent';
  usdToEurRate: number;
  lastSyncAt?: string | null;
  lastSyncOk?: boolean | null;
  lastSyncError?: string | null;
}

/**
 * Catalogue de modèles d'IA connus (pour le sélecteur de modèle côté owner/lead).
 * Le `provider` n'est PAS modifiable depuis le workspace — seul le `model` l'est,
 * dans la liste du provider de l'agent. Étendre à la demande.
 */
export interface KnownAgentModel {
  provider: string;
  model: string;
  label: string;
  /**
   * Tarifs PUBLICS INDICATIFS en €/1K tokens (entrée/sortie) — servent
   * uniquement à **pré-remplir** le profil de coût à la création manuelle d'un
   * agent. Approximatifs et datés : l'admin les remplace par ses tarifs
   * fournisseur/négociés réels. Absents = pas de suggestion (open-source auto-
   * hébergé, tarif inconnu). Air-gap : embarqués dans l'app, aucun appel réseau.
   */
  suggestedCostInPerKTokens?: number;
  suggestedCostOutPerKTokens?: number;
  /** Unité de facturation du modèle. Absent = tokens (défaut). Les modèles
   *  Copilot facturent en crédits (compteur unique, pas de taux sortie). */
  unit?: AgentBillingUnit;
}

export const KNOWN_AGENT_MODELS: KnownAgentModel[] = [
  { provider: 'anthropic', model: 'claude-opus-4-8', label: 'Claude Opus 4.8', suggestedCostInPerKTokens: 0.014, suggestedCostOutPerKTokens: 0.069 },
  { provider: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', suggestedCostInPerKTokens: 0.0028, suggestedCostOutPerKTokens: 0.014 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', suggestedCostInPerKTokens: 0.0009, suggestedCostOutPerKTokens: 0.0046 },
  { provider: 'anthropic', model: 'claude-fable-5', label: 'Claude Fable 5' },
  { provider: 'openai', model: 'gpt-5', label: 'GPT-5', suggestedCostInPerKTokens: 0.0011, suggestedCostOutPerKTokens: 0.0092 },
  { provider: 'openai', model: 'gpt-5-mini', label: 'GPT-5 mini', suggestedCostInPerKTokens: 0.0002, suggestedCostOutPerKTokens: 0.0018 },
  { provider: 'azure-openai', model: 'gpt-5', label: 'Azure GPT-5', suggestedCostInPerKTokens: 0.0011, suggestedCostOutPerKTokens: 0.0092 },
  { provider: 'azure-openai', model: 'gpt-4.1', label: 'Azure GPT-4.1', suggestedCostInPerKTokens: 0.0018, suggestedCostOutPerKTokens: 0.0073 },
  { provider: 'google', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', suggestedCostInPerKTokens: 0.0011, suggestedCostOutPerKTokens: 0.0092 },
  { provider: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', suggestedCostInPerKTokens: 0.0003, suggestedCostOutPerKTokens: 0.0023 },
  { provider: 'mistral', model: 'mistral-large', label: 'Mistral Large', suggestedCostInPerKTokens: 0.0018, suggestedCostOutPerKTokens: 0.0055 },
  // Providers facturés en crédits (compteur unique, pas de taux suggéré : le
  // prix d'un crédit dépend du contrat client). Unité = credits.
  { provider: 'github-copilot', model: 'copilot-premium-requests', label: 'GitHub Copilot (premium requests)', unit: 'credits' },
  { provider: 'microsoft-copilot', model: 'copilot-credits', label: 'Microsoft Copilot (credits)', unit: 'credits' },
];

/**
 * Grille tarifaire Copilot Studio (crédits Copilot par type d'activité), tirée de
 * la doc publique Microsoft `requirements-messages-management`. Déterministe et
 * publique → appliquée à l'activité observée d'un agent Copilot pour ESTIMER son
 * coût par tâche (agents hébergés non mesurables : l'inférence tourne chez
 * Microsoft, jamais routable par la passerelle). Le prix d'un crédit en € dépend
 * du contrat client (réglé séparément). Voir `estimateCopilotCredits`.
 */
export interface CopilotStudioRateCard {
  /** Réponse prédéfinie (statique). */
  classicResponse: number;
  /** Réponse générée dynamiquement par le modèle. */
  generativeResponse: number;
  /** Action d'agent (déclencheur, raisonnement, transition, CUA…). */
  agentAction: number;
  /** Ancrage RAG sur le Microsoft Graph du locataire. */
  tenantGraphGrounding: number;
  /** Actions de flux d'agent, facturées par lot de 100. */
  agentFlowActionsPer100: number;
  /** Outils texte/IA générative, crédits par 1K tokens (basic|standard|premium). */
  genAiToolsPer1kTokens: { basic: number; standard: number; premium: number };
  /** Traitement de contenu, par page. */
  contentProcessingPerPage: number;
}

export const COPILOT_STUDIO_RATE_CARD: CopilotStudioRateCard = {
  classicResponse: 1,
  generativeResponse: 2,
  agentAction: 5,
  tenantGraphGrounding: 10,
  agentFlowActionsPer100: 13,
  genAiToolsPer1kTokens: { basic: 0.1, standard: 1.5, premium: 10 },
  contentProcessingPerPage: 8,
};

/**
 * Activité observée d'un agent Copilot pour une tâche — sert de base à
 * l'estimation. Vaks n'observe que sa TRANCHE (actions MCP, livrables,
 * transitions) ; la part générative/tokens qu'il ne voit pas est couverte par un
 * `baselineCreditsPerTask` réglable, ajouté par l'appelant (hors de cette
 * fonction pure).
 */
export interface CopilotActivity {
  /** Actions d'agent observées (≈ appels MCP, livrables, transitions de statut). */
  agentActions?: number;
  /** Réponses génératives connues (souvent inconnu côté Vaks → 0). */
  generativeResponses?: number;
  /** Réponses classiques connues. */
  classicResponses?: number;
  /** Tokens de raisonnement premium connus. */
  premiumTokens?: number;
}

/**
 * Estime les crédits Copilot consommés par une activité, via la grille. PURE et
 * testable. N'inclut PAS la baseline par tâche (ajoutée par l'appelant). Les
 * compteurs négatifs sont clampés à 0.
 */
export function estimateCopilotCredits(
  a: CopilotActivity,
  card: CopilotStudioRateCard = COPILOT_STUDIO_RATE_CARD,
): number {
  const nn = (v?: number) => (typeof v === 'number' && v > 0 ? v : 0);
  const credits =
    nn(a.agentActions) * card.agentAction +
    nn(a.generativeResponses) * card.generativeResponse +
    nn(a.classicResponses) * card.classicResponse +
    (nn(a.premiumTokens) / 1000) * card.genAiToolsPer1kTokens.premium;
  return Math.round(credits * 100) / 100;
}

/** Un projet sur lequel un agent est affecté (`GET /me/agents/:id`). */
export interface WorkspaceAgentProjectDto {
  id: string;
  key: string;
  name: string;
  status: string;
  /** Tâches assignées à l'agent dans ce projet, non terminées. */
  activeTasks: number;
}

/** Détail d'un agent pour l'owner/lead (`GET /me/agents/:id`) — vue enrichie. */
export interface WorkspaceAgentDetailDto extends WorkspaceAgentDto {
  usage: {
    runCount: number;
    totalCost: number;
    /** Coût des runs du mois courant (UTC). */
    monthlyCost: number;
    avgCostPerTask: number | null;
    totalTokens: number;
  } | null;
  projects: WorkspaceAgentProjectDto[];
}

/** Agent tel que vu par un utilisateur dans le workspace (`GET /me/agents`) —
 *  vue allégée, sans jetons ni budgets, pour l'owner et les leads d'équipe. */
export interface WorkspaceAgentDto {
  id: string;
  name: string;
  /** Email synthétique `agent-<slug>@agents.invalid` (identifiant, jamais de mail envoyé). */
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  trustLevel: AgentTrustLevel;
  ownerId: string;
  ownerName: string | null;
  model: string | null;
  modelProvider: string | null;
  /** Unité de facturation dérivée du provider (tokens | credits). */
  billingUnit?: AgentBillingUnit;
  capabilities: string[];
  skills: { skillId: string; name: string; level: number }[];
  /** L'utilisateur courant est l'owner (responsable) de cet agent. */
  linkedAsOwner: boolean;
  /** Noms des équipes menées par l'utilisateur dont l'agent est membre. */
  linkedTeams: string[];
}

/** Réponse paginée de `GET /me/agents`. */
export interface WorkspaceAgentsPageDto {
  items: WorkspaceAgentDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateAgentDto {
  name: string;
  ownerId: string;
  trustLevel?: AgentTrustLevel; // défaut DRAFT_ONLY
  capabilities?: string[];
  maxConcurrentTasks?: number | null;
  dailyRunBudget?: number | null;
  modelProvider?: string | null;
  model?: string | null;
  hostingRegion?: string | null;
  /** Coût interne € / 1K tokens d'entrée. */
  costRateInPerKTokens?: number | null;
  /** Coût interne € / 1K tokens de sortie (typiquement 3–5× l'entrée). */
  costRateOutPerKTokens?: number | null;
  /** Taux facturé client € / 1K tokens (fixe) par défaut (hérité par les projets). */
  defaultBillRatePerKTokens?: number | null;
  dailyCostBudget?: number | null;
  monthlyCostBudget?: number | null;
  /** Lot 2 — l'agent suit les prix catalogue (mode `per_agent`). */
  followCatalogPricing?: boolean;
}

export type UpdateAgentDto = Partial<CreateAgentDto> & { status?: 'ACTIVE' | 'SUSPENDED' };

/**
 * Enregistrement entrant `POST /agents` (API publique, clé org `agent:manage`).
 * Upsert idempotent sur `(idpSource='api', externalId)`. L'agent arrive
 * DRAFT_ONLY, capabilities lecture seule, SANS jeton — activation humaine.
 */
export interface RegisterAgentDto {
  name: string;
  externalId: string;
  /** Résolu vers un humain actif de l'org, sinon 400. */
  ownerEmail: string;
  modelProvider?: string;
  model?: string;
  hostingRegion?: string;
}

/**
 * Mise à jour du **profil de coût interne** d'un agent par API publique
 * (`PATCH /agents/cost-profile`, clé org `agent:manage`). Agent désigné par
 * `externalId` (même clé que `POST /agents`). **Coût interne uniquement** —
 * le taux facturé client (`defaultBillRatePerKTokens`) N'EST PAS exposé ici :
 * une clé org ne fixe pas le prix de vente. Au moins un des deux taux requis.
 * `null` efface le taux (retour à « non défini »).
 */
export interface UpdateAgentCostProfileDto {
  externalId: string;
  /** Optionnel : désambiguïse si le même externalId existe sur plusieurs sources. */
  idpSource?: string;
  costRateInPerKTokens?: number | null;
  costRateOutPerKTokens?: number | null;
}

/** Connecteur d'annuaire d'agents (seam AgentDirectoryProvider). */
export interface AgentConnectorDto {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsConfigured: string[];
  defaultOwnerId?: string | null;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastSyncError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgentConnectorDto {
  provider?: string;
  label?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  defaultOwnerId?: string | null;
}

export interface AgentSyncResultDto {
  ok: boolean;
  created: number;
  updated: number;
  suspended: number;
  /** Nouvelles identités NON créées faute de place sous le plafond d'agents
   *  (freemium). Le sync ne 403 pas en bloc — il rapporte le débordement. */
  skippedOverLimit?: number;
  error?: string;
}

/** Credential machine d'un agent headless (refresh rotatif). Le secret n'est
 *  jamais renvoyé après la création — seulement ces métadonnées. */
export interface AgentCredentialDto {
  id: string;
  chainId: string;
  label: string | null;
  expiresAt: string;
  rotationCount: number;
  lastUsedAt: string | null;
  revoked: boolean;
  /** Vrai si un rejeu hors-grâce a déclenché la révocation défensive. */
  reuseDetected: boolean;
  createdAt: string;
}

/** Émetteur de confiance pour la fédération d'identité des agents (RFC 8693). */
export interface AgentTrustIssuerDto {
  id: string;
  label: string;
  enabled: boolean;
  issuer: string;
  audience: string;
  discoveryUrl?: string | null;
  jwksUri?: string | null;
  /** Le JWKS n'est jamais renvoyé en clair — seulement le nombre de clés. */
  jwksKeyCount: number;
  algorithms: string[];
  subjectClaim: string;
  idpSource: string;
  claimConstraints: Record<string, unknown>;
  requireJti: boolean;
  tokenTtlSec: number;
  autoDeclare: boolean;
  defaultOwnerId?: string | null;
  /** Provenance d'affichage : connecteur d'annuaire qui a pré-rempli l'émetteur. */
  connectorId?: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ProjectMemberDto {
  projectId: string;
  userId: string;
  user: { id: string; name: string; email: string; status?: string };
  role: { id: string; key: string; name: string };
  /** Tag sponsor (audience de communication — annonces, jalons, statut projet).
   *  Orthogonal au rôle, aucun droit associé. */
  isSponsor?: boolean;
  createdAt: string;
}

/** Matrice d'événements notifiés aux sponsors d'un projet (`Project.sponsorNotify`). */
export interface SponsorNotifyDto {
  /** Jalon (`isMilestone`) passé à DONE — défaut ON. */
  milestoneReached?: boolean;
  /** Changement de statut du projet — défaut ON. */
  projectStatus?: boolean;
  /** Jalon à risque (règle 7) — opt-in, défaut OFF. */
  milestoneAtRisk?: boolean;
  /** Paliers budget (règle 14), version QUALITATIVE sans montants — opt-in, défaut OFF. */
  budgetThresholds?: boolean;
}

export interface ProjectDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  /** Santé projet (RAG) pour le point de statut client. `null` = non renseignée. */
  statusHealth?: ProjectHealth | null;
  /** Résumé narratif du statut (rendu dans le deck client). */
  statusSummary?: string | null;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  /** Client (portefeuille) auquel le projet est rattaché, ou null. */
  clientId?: string | null;
  client?: { id: string; name: string; company: string | null } | null;
  /**
   * true = projet facturable (cycle complet avec charter signé) ;
   * false = projet non-facturable (DRAFT → ACTIVE direct).
   * Verrouillé une fois le projet sorti de DRAFT.
   */
  billable: boolean;
  /**
   * Étape commerciale « offre » (projets facturables). `offerRefusalCount` =
   * nombre de fois où le client a refusé l'offre (boucle refus → révision).
   * `offerSentAt` / `offerDecidedAt` = dernier envoi / dernière décision (ISO).
   */
  offerRefusalCount?: number;
  offerSentAt?: string | null;
  offerDecidedAt?: string | null;
  /**
   * Transitions de statut légales depuis le statut courant (machine à états
   * billable / non-billable côté serveur). Sert à griser les statuts
   * inatteignables dans l'UI. Optionnel (rétro-compat).
   */
  allowedTransitions?: ProjectStatus[];
  /** Avancement : nombre de tâches total / DONE (hors supprimées). Renvoyé par `GET /projects`. */
  taskCounts?: { total: number; done: number };
  /** Project Managers du projet (id + nom), pour les avatars des cartes. Renvoyé par `GET /projects`. */
  managers?: { id: string; name: string }[];
  // ---------- Agents IA (chantier 2 — contexte de travail) ----------
  /** Case « Agents autorisés » : si false, aucun agent n'est assignable/claimable. */
  agentsEnabled?: boolean;
  /** Notes libres lues par les agents (markdown). Rendues EN DERNIER dans le
   *  brief composé. `agentBrief` OU ce champ suffit quand `agentsEnabled`. */
  agentContext?: string | null;
  /** Brief STRUCTURÉ (4 champs) — le serveur le compose avec les faits qu'il
   *  connaît déjà. Hérite du défaut org champ par champ. */
  agentBrief?: AgentBriefDto | null;
  /** Garde-fous / hors-périmètre projet (contexte négatif) pour les agents. */
  agentGuardrails?: string | null;
  /** Enveloppe totale de coût agent (€) pour le projet (finance agents). */
  agentCostBudget?: number | null;
  /** Kill-switch par projet du contexte documentaire SharePoint (défaut true). */
  spContextEnabled?: boolean;
  /** État du droit de lecture SharePoint des agents : NONE|PENDING|GRANTED|FAILED. */
  msSpGrantStatus?: 'NONE' | 'PENDING' | 'GRANTED' | 'FAILED';
  /** Capacités de vérification mécaniques disponibles (chantier 3, phase B) :
   *  sous-ensemble de `tool_output`/`agent_validator`/`ci_signed`. */
  verificationCapabilities?: string[] | null;
  /** Enjeu du projet (chantier 3, phase B) : low/medium/high/critical — hérité
   *  par toutes les tâches. */
  stakes?: string | null;
  /** Mode de vérification (phase D) — override projet du défaut org : `enforce`
   *  (gate bloque + auto-transition agent_validator échantillonnée) /
   *  `report_only` / `null` = hérite de l'org. */
  verificationMode?: string | null;
  /** Dépôt(s) CI autorisé(s) (ex. `["owner/repo"]`) — lie la preuve `ci_signed`
   *  d'un livrable à ce dépôt (anti-réutilisation cross-dépôt). Vide = org-wide. */
  ciRepos?: string[];
  /** Matrice d'événements notifiés aux sponsors (null = défauts). */
  sponsorNotify?: SponsorNotifyDto | null;
}

/** Méthodes de vérification **mécaniques** configurables comme capacités d'un
 *  projet (chantier 3, phase B). `self_attest` et `human` sont toujours
 *  implicitement disponibles → jamais dans cette liste. */
export const AGENT_VERIFICATION_CAPABILITY_METHODS = ['tool_output', 'agent_validator', 'ci_signed'] as const;
export type AgentVerificationCapabilityMethod = (typeof AGENT_VERIFICATION_CAPABILITY_METHODS)[number];

export interface CreateProjectDto {
  key: string;
  name: string;
  description?: string;
  /** Client (portefeuille) optionnel à la création. */
  clientId?: string | null;
  /**
   * Équipes à rattacher au projet immédiatement. Obligatoire (au moins une)
   * pour les rôles team-scoped (TEAM_MANAGER) ; le backend vérifie que les
   * équipes listées sont bien pilotées par le créateur. Optionnel pour
   * ORG_ADMIN / PORTFOLIO_MANAGER (peuvent aussi les rattacher après-coup
   * via `POST /projects/:id/teams`).
   */
  teamIds?: string[];
  /**
   * true (défaut) = projet facturable ; false = non-facturable.
   * Conditionne le cycle de vie (charter requis ou pas) et la policy de
   * création appliquée côté serveur.
   */
  billable?: boolean;
  /** Autoriser les agents IA sur ce projet (défaut false). Si true, `agentContext` requis. */
  agentsEnabled?: boolean;
  /** Brief permanent lu par les agents (markdown). Requis si `agentsEnabled`. */
  agentContext?: string | null;
  /** Garde-fous / hors-périmètre projet pour les agents. */
  agentGuardrails?: string | null;
  /** Kill-switch par projet du contexte documentaire SharePoint (défaut true). */
  spContextEnabled?: boolean;
}

/** Capacités de création de projet du user courant, calculées d'après la
 *  policy org + ses rôles / équipes. Renvoyé par GET /projects/creation-policy/me. */
export interface ProjectCreationCapabilitiesDto {
  canBillable: boolean;
  canNonBillable: boolean;
}

// ---------- Contexte IA d'un projet (brief structuré + prévisualisation) ----------

/**
 * Brief agent STRUCTURÉ. Remplace le pavé libre où chaque PM réinventait sa
 * structure. Le serveur y ajoute les FAITS qu'il connaît déjà (reviewer, mode
 * de vérification, enjeu, langue) — plus besoin de les retaper.
 */
export interface AgentBriefDto {
  /** Qui est l'agent sur ce projet et ce qu'il doit accomplir. */
  role?: string | null;
  /** Format, style, langue, structure attendue des livrables. */
  outputConventions?: string | null;
  /** Où déposer les livrables (chemin SharePoint, dossier, dépôt…). */
  deliveryTarget?: string | null;
  /** Ce sur quoi l'agent n'intervient pas. */
  outOfScope?: string | null;
}

/** Rubriques du charter exposées aux agents (allowlist ; le reste est refusé). */
export interface AgentCharterViewDto {
  projectPurpose: string | null;
  objectives: string | null;
  scopeIn: string | null;
  scopeOut: string | null;
  deliverables: string | null;
  constraints: string | null;
  successCriteria: string | null;
}

/**
 * « Ce que voient les agents » — le pack de contexte assemblé, rendu à
 * l'identique pour l'humain et pour l'agent (MÊME code de composition, sinon
 * l'écran mentirait). Réponse de `GET /projects/:id/agent-context-preview`.
 */
export interface AgentContextPreviewDto {
  agentsEnabled: boolean;
  brief: {
    /** Le markdown RÉELLEMENT servi aux agents. */
    composed: string;
    /** Les 4 champs après fusion avec le défaut org. */
    structured: AgentBriefDto | null;
    /** Champs venus du défaut organisation (et non du projet). */
    orgDefaultApplied: string[];
    /** Notes libres (`agentContext`), rendues en dernier dans `composed`. */
    freeNotes: string | null;
  };
  facts: {
    reviewers: { id: string; name: string }[];
    verificationMode: string;
    verificationModeSource: 'project' | 'org';
    stakes: string;
    verificationCapabilities: string[];
    locale: string | null;
    /** Budget QUALITATIF — jamais de montant (le chiffré reste `finance:view`). */
    costBudget: { set: boolean; spentPct: number | null };
  };
  guardrails: { project: string | null };
  charter: AgentCharterViewDto | null;
  documents: {
    items: {
      id: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      /** Fraîcheur réelle : réécriture du contenu sinon dépôt initial. */
      freshAt: string;
      source: 'own' | 'folder';
    }[];
    total: number;
    returned: number;
    /** `true` = des documents de contexte ne sont PAS remontés aux agents. */
    truncated: boolean;
  };
  contextSources: { source: string; label: string; available: boolean; reason?: string }[];
  journalPreview: { title: string; summary: string | null; at: string }[];
}

// ---------- Project charter (PMBOK-style) ----------

export interface ProjectCharterDto {
  projectId: string;
  projectPurpose: string | null;
  objectives: string | null;
  scopeIn: string | null;
  scopeOut: string | null;
  deliverables: string | null;
  milestones: string | null;
  stakeholders: string | null;
  /** Sponsor exécutif — nom résolu (imprimé sur le .docx). Piloté par le sélecteur. */
  sponsor: string | null;
  /** userId du membre désigné sponsor exécutif (lien d'identité). null = aucun. */
  sponsorUserId: string | null;
  /** Membre résolu (lecture seule) pour pré-sélectionner le picker. */
  sponsorUser: { id: string; name: string } | null;
  assumptions: string | null;
  constraints: string | null;
  risks: string | null;
  budgetEstimate: string | null;
  successCriteria: string | null;
  extraSections: Record<string, string> | null;
  signedDocument: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
    uploadedBy: { id: string; name: string } | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export type UpsertProjectCharterDto = Partial<
  Omit<
    ProjectCharterDto,
    'projectId' | 'createdAt' | 'updatedAt' | 'signedDocument' | 'sponsorUser'
  >
>;

export type DocumentTemplateKind = 'CHARTER' | 'CLIENT_STATUS_PPTX';

export interface DocumentTemplateDto {
  kind: DocumentTemplateKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  updatedAt: string;
  uploadedBy: { id: string; name: string } | null;
}

/** Sections PMBOK recommandées dans le wizard d'initiation. */
export const CHARTER_SECTIONS: Array<{
  key: keyof UpsertProjectCharterDto;
  label: string;
  hint: string;
  rows: number;
}> = [
  { key: 'projectPurpose', label: 'Project purpose', hint: 'Problem or opportunity the project addresses', rows: 3 },
  { key: 'objectives', label: 'Objectives (SMART)', hint: 'Specific, measurable, achievable, relevant, time-bound', rows: 4 },
  { key: 'scopeIn', label: 'In scope', hint: 'What is explicitly inside the project boundary', rows: 3 },
  { key: 'scopeOut', label: 'Out of scope', hint: 'What is explicitly excluded', rows: 2 },
  { key: 'deliverables', label: 'Key deliverables', hint: 'Concrete artifacts the project will produce', rows: 3 },
  { key: 'milestones', label: 'Key milestones', hint: 'Major checkpoints with target dates', rows: 3 },
  { key: 'stakeholders', label: 'Stakeholders', hint: 'Who is impacted, who must be informed, who decides', rows: 3 },
  { key: 'assumptions', label: 'Assumptions', hint: 'Facts taken as true for planning purposes', rows: 2 },
  { key: 'constraints', label: 'Constraints', hint: 'Budget, timeline, resources, regulatory…', rows: 2 },
  { key: 'risks', label: 'Initial risks', hint: 'Top risks identified at kick-off', rows: 3 },
  { key: 'budgetEstimate', label: 'Budget estimate', hint: 'Ballpark amount with currency', rows: 1 },
  { key: 'successCriteria', label: 'Success criteria / KPIs', hint: 'How we will know the project succeeded', rows: 3 },
];

export interface UpdateProjectDto {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  /** Santé projet (RAG) pour le point de statut client. null pour effacer. */
  statusHealth?: ProjectHealth | null;
  /** Résumé narratif du statut. null/'' pour effacer. */
  statusSummary?: string | null;
  /** ISO date YYYY-MM-DD or null to clear */
  startDate?: string | null;
  dueDate?: string | null;
  /** Client (portefeuille) — id ou null pour détacher. */
  clientId?: string | null;
  // ---------- Agents IA (chantier 2 — contexte de travail) ----------
  /** Activer/désactiver les agents IA. Passer à true exige un `agentContext` non vide. */
  agentsEnabled?: boolean;
  /** Brief permanent lu par les agents (markdown). null/'' pour effacer. */
  agentContext?: string | null;
  /** Garde-fous / hors-périmètre projet pour les agents. null/'' pour effacer. */
  agentGuardrails?: string | null;
  /** Enveloppe totale de coût agent (€) pour le projet. null pour effacer. */
  agentCostBudget?: number | null;
  /** Capacités de vérification mécaniques disponibles (chantier 3, phase B). */
  verificationCapabilities?: string[] | null;
  /** Enjeu du projet (chantier 3, phase B) : low/medium/high/critical. */
  stakes?: string | null;
  /** Mode de vérification (phase D) : `report_only`/`enforce`/`null` (hérite org). */
  verificationMode?: string | null;
  /** Dépôt(s) CI autorisé(s) (ex. `["owner/repo"]`) — lie la preuve `ci_signed` au
   *  bon dépôt. `[]`/absent = comportement org-wide historique. */
  ciRepos?: string[];
  /** Matrice d'événements sponsors (whitelist serveur ; null = revenir aux défauts). */
  sponsorNotify?: SponsorNotifyDto | null;
}

// ---------- Finance (budget + taux par projet × personne) ----------
// Tous ces montants ne sont servis que via les routes gardées `finance:view`
// (lecture) / `finance:manage` (écriture). Devise = réglage org.

/** Origine du taux résolu pour une personne sur un projet :
 *  explicite (ProjectRate) > défaut user (User.defaultCostRate, édité par le
 *  Team Manager dans la vue équipe) > défaut projet > manquant. */
export type ProjectRateSource = 'explicit' | 'user_default' | 'default' | 'missing';

export interface ProjectMemberRateDto {
  userId: string;
  name: string;
  email: string;
  status: string;
  /** Coût interne / h résolu (explicite sinon défaut projet), null si manquant. */
  costRate: number | null;
  /** Taux facturé client / h résolu, null si non défini. */
  billRate: number | null;
  /** true = un ProjectRate explicite existe pour cette personne. */
  hasExplicitRate: boolean;
  source: ProjectRateSource;
}

export interface ProjectRatesDto {
  projectId: string;
  /** Code ISO 4217 (ex. EUR). */
  currency: string;
  billable: boolean;
  budgetAmount: number | null;
  defaultCostRate: number | null;
  defaultBillRate: number | null;
  members: ProjectMemberRateDto[];
}

export interface SetProjectRateBody {
  costRate: number;
  billRate?: number | null;
}

export interface UpdateProjectBudgetBody {
  budgetAmount?: number | null;
  defaultCostRate?: number | null;
  defaultBillRate?: number | null;
}

/** Re-fige les snapshots de taux des time entries aux taux courants. */
export interface RestampRatesBody {
  from?: string;
  to?: string;
  onlyMissing?: boolean;
}

export interface RestampRatesResultDto {
  updated: number;
}

export interface ProjectBudgetMemberDto {
  userId: string;
  name: string;
  costRate: number | null;
  billRate: number | null;
  actualHours: number;
  actualCost: number;
  plannedHours: number;
  plannedCost: number;
  billableRevenue: number;
  /** CA prévisionnel = heures d'allocation effectives × billRate. */
  plannedRevenue: number;
  hasRate: boolean;
}

/** Synthèse budgétaire d'un projet (réel + prévisionnel). Gardé `finance:view`. */
export interface ProjectBudgetSummaryDto {
  projectId: string;
  currency: string;
  billable: boolean;
  budgetAmount: number | null;
  /** Coût réel = heures loggées × costRate résolu. */
  actualCost: number;
  /** Coût prévisionnel = heures d'allocation effectives × costRate. */
  forecastCost: number;
  /**
   * CA facturable réalisé = heures loggées (sur projet facturable) × billRate
   * + dépenses encourues refacturées. null si projet non-facturable.
   */
  billableRevenue: number | null;
  /** Marge réalisée = CA facturable − coût réel (M.O. + dépenses). null si non-facturable. */
  margin: number | null;
  /**
   * CA prévisionnel (à terminaison) = heures d'allocation effectives × billRate
   * + dépenses planifiées refacturées. null si projet non-facturable.
   */
  forecastRevenue: number | null;
  /** Marge prévisionnelle = CA prévisionnel − coût prévisionnel (forecastCost). null si non-facturable. */
  forecastMargin: number | null;
  actualHours: number;
  plannedHours: number;
  /** % du budget consommé (réel). null si budget non défini. */
  spentPct: number | null;
  /** % du budget engagé (prévisionnel). null si budget non défini. */
  forecastPct: number | null;
  /** Budget − coût réel. null si budget non défini. */
  remaining: number | null;
  /** Nb de personnes sans taux de coût résolu (coût sous-estimé). */
  membersMissingRate: number;
  members: ProjectBudgetMemberDto[];
  /**
   * Décomposition main-d'œuvre vs hors main-d'œuvre. `actualCost`/`forecastCost`
   * ci-dessus sont les TOTAUX (labor + non-labor). Optionnels (rétro-compat).
   */
  laborActualCost?: number;
  laborForecastCost?: number;
  nonLaborActualCost?: number;
  nonLaborForecastCost?: number;
  /** Reste à faire main-d'œuvre (cost-to-complete) = Σ tâches non finies :
   *  estimate × (1 − avancement%) × taux moyen des assignés. Pour l'EAC. */
  remainingLaborCost?: number;
  /** Coûts hors M.O. agrégés par catégorie. */
  expensesByCategory?: ProjectExpenseCategoryTotalDto[];
  /** Lignes de coût hors M.O. (récurrence dépliée dans `effectiveCost`/`Bill`). */
  expenses?: ProjectExpenseDto[];
  // ---------- Coût agents IA (finance agents) ----------
  /** Coût agent réel = somme des runs déclarés (`AgentRun.cost`) sur ce projet. */
  agentCostReal?: number;
  /** Coût agent prévisionnel = tâches non terminées × coût moyen/tâche observé (30 j). null si pas de données. */
  agentCostForecast?: number | null;
  /** Enveloppe de coût agent du projet (`Project.agentCostBudget`). null si non défini. */
  agentCostBudget?: number | null;
  /**
   * CA agents facturé = kTokens des runs × taux résolu (override projet >
   * défaut agent). Déjà SOMMÉ dans `billableRevenue`/`forecastRevenue` (projet
   * facturable) — exposé pour l'affichage « dont agents » de la carte dédiée.
   * Le coût agents réel/EAC est de même sommé dans `actualCost`/`forecastCost`.
   */
  agentBilledReal?: number;
}

// ---------- Taux de facturation agents IA (€ / 1K tokens) ----------

/** Provenance du taux agent résolu (mirroir de `ProjectRateSource` humain). */
export type AgentRateSource = 'project' | 'agent_default' | null;

export interface AgentRateRowDto {
  agentId: string;
  name: string;
  /** Modèle du profil agent (ex. 'claude-sonnet-5'). */
  model: string | null;
  /** Unité de facturation dérivée du provider (tokens | credits). */
  billingUnit?: AgentBillingUnit;
  /** Taux résolu € / 1000 tokens (null = non facturable). */
  billRatePerKTokens: number | null;
  /** D'où vient le taux : override projet, défaut agent, ou aucun. */
  source: AgentRateSource;
  /** True si une ligne `AgentProjectRate` explicite existe pour ce projet. */
  hasProjectRate: boolean;
  /** Consommation réelle sur le projet (somme `AgentRun`). */
  runs: number;
  tokensIn: number;
  tokensOut: number;
  /** (tokensIn + tokensOut) / 1000, arrondi 2 déc. */
  kTokens: number;
  /** Coût réel déclaré (Σ `AgentRun.cost`). */
  cost: number;
  /** CA facturé = kTokens × taux résolu. null si pas de taux. */
  billed: number | null;
}

export interface ProjectAgentRatesDto {
  projectId: string;
  /** False si `Project.agentsEnabled` est off → l'UI n'affiche rien. */
  enabled: boolean;
  currency: string;
  agents: AgentRateRowDto[];
  /** Totaux projet (kTokens / coût / facturé). */
  totalKTokens: number;
  totalCost: number;
  totalBilled: number;
}

// ---------- Reporting non financier agents IA (par projet) ----------

export interface AgentReportPerAgentDto {
  agentId: string;
  name: string;
  /** Unité de facturation dérivée du provider (tokens | credits). */
  billingUnit?: AgentBillingUnit;
  /** Tâches passées à DONE par cet agent dans la fenêtre. */
  tasksCompleted: number;
  /** Chaînes de livrables soumises (finals, toutes revues confondues). */
  deliverables: number;
  /** Chaînes approuvées dans la fenêtre. */
  approved: number;
  /** % de chaînes approuvées du premier coup (version 1). null si aucune approuvée. */
  firstPassPct: number | null;
  /** Rounds de revue moyens par chaîne approuvée (1 = zéro re-travail). */
  avgRounds: number | null;
  runs: number;
  tokens: number;
}

export interface ProjectAgentReportDto {
  projectId: string;
  /** False si `Project.agentsEnabled` est off → l'UI n'affiche rien. */
  enabled: boolean;
  from: string;
  to: string;
  /** Throughput : tâches passées à DONE par un agent dans la fenêtre. */
  tasksCompleted: number;
  /** Série hebdo (lundi ISO) du throughput pour le bar chart. */
  weekly: { weekStart: string; count: number }[];
  /** Chaînes de livrables agent approuvées (reviewedAt dans la fenêtre). */
  approvedDeliverables: number;
  /** % approuvées dès la v1 (sans round CHANGES_REQUESTED). null si aucune. */
  firstPassApprovalPct: number | null;
  /** Rounds de revue moyens par chaîne approuvée (1 = premier coup). */
  avgReviewRounds: number | null;
  /** Délai moyen soumission → revue humaine (heures). null si aucune revue. */
  avgReviewTurnaroundHours: number | null;
  /** Agents distincts actifs (runs ou livrables) dans la fenêtre. */
  activeAgents: number;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  perAgent: AgentReportPerAgentDto[];
}

// ---------- Coûts hors main-d'œuvre (licence, matériel, cloud, sous-traitance) ----------

export type ProjectExpenseCategory = 'LICENSE' | 'HARDWARE' | 'CLOUD' | 'SUBCONTRACTOR' | 'OTHER';
export type ProjectExpenseStatus = 'PLANNED' | 'INCURRED';
export type ProjectExpenseRecurrence = 'ONE_OFF' | 'MONTHLY' | 'ANNUAL';

export interface ProjectExpenseDto {
  id: string;
  category: ProjectExpenseCategory;
  label: string;
  description: string | null;
  /** Coût interne unitaire (par période si récurrent). */
  amount: number | null;
  /** Montant refacturé client unitaire (null = non refacturé). */
  billAmount: number | null;
  quantity: number;
  status: ProjectExpenseStatus;
  recurrence: ProjectExpenseRecurrence;
  startDate: string | null;
  endDate: string | null;
  /** Coût total effectif (amount × quantity × périodes). */
  effectiveCost: number;
  /** Montant refacturé total effectif (billAmount × quantity × périodes). */
  effectiveBill: number;
  /** Nombre de périodes prises en compte (1 si ponctuel). */
  periods: number;
}

export interface ProjectExpenseCategoryTotalDto {
  category: ProjectExpenseCategory;
  actualCost: number;
  plannedCost: number;
  billAmount: number;
}

export interface CreateProjectExpenseBody {
  category: ProjectExpenseCategory;
  label: string;
  description?: string | null;
  amount: number;
  billAmount?: number | null;
  quantity?: number;
  status?: ProjectExpenseStatus;
  recurrence?: ProjectExpenseRecurrence;
  startDate?: string | null;
  endDate?: string | null;
}

export type UpdateProjectExpenseBody = Partial<CreateProjectExpenseBody>;

// ---------- Finance portefeuille (agrégée par client) ----------

export interface PortfolioProjectFinanceDto {
  id: string;
  key: string;
  name: string;
  budget: number | null;
  spent: number;
  revenue: number;
  margin: number;
}

export interface PortfolioClientFinanceDto {
  /** null = bucket « Internes / sans client ». */
  clientId: string | null;
  clientName: string;
  company: string | null;
  projectCount: number;
  budget: number;
  spent: number;
  revenue: number;
  margin: number;
  /** Marge / CA en %, null si pas de CA. */
  marginPct: number | null;
  /** Part agents IA du client sur la période — déjà INCLUSE dans spent/revenue. */
  agentCost?: number;
  agentBilled?: number;
  projects: PortfolioProjectFinanceDto[];
}

export type FiscalGranularity = 'quarter' | 'semester' | 'year';

export interface PortfolioPeriodDto {
  granularity: FiscalGranularity;
  offset: number;
  /** Fenêtre [from, to) en dates ISO (YYYY-MM-DD), `to` exclus. */
  from: string;
  to: string;
  /** Libellé humain, ex. « T2 · FY 2026 ». */
  label: string;
}

export interface PortfolioTeamFinanceDto {
  teamId: string | null; // null = « Sans équipe »
  teamName: string;
  projectCount: number;
  spent: number;
  revenue: number;
  margin: number;
}

export interface PortfolioBudgetBucketDto {
  key: string;
  label: string;
  count: number;
  budget: number;
}

export interface PortfolioFinanceDto {
  currency: string;
  /** Mois de début d'exercice (1-12) — pour le sélecteur de période. */
  fiscalYearStartMonth: number;
  period: PortfolioPeriodDto;
  /** Client filtré (null = tous). */
  clientId: string | null;
  clients: PortfolioClientFinanceDto[];
  totals: {
    projectCount: number;
    clientCount: number;
    budget: number;
    spent: number;
    revenue: number;
    margin: number;
    /** Part agents IA — déjà incluse dans spent/revenue. */
    agentCost?: number;
    agentBilled?: number;
  };
  byTeam: PortfolioTeamFinanceDto[];
  budgetBuckets: PortfolioBudgetBucketDto[];
  revenueByClient: Array<{ clientId: string | null; clientName: string; revenue: number }>;
  projectsByClient: Array<{ clientId: string | null; clientName: string; count: number }>;
  revenueByProject: Array<{ id: string; key: string; name: string; revenue: number }>;
  monthly: Array<{ month: string; cost: number; revenue: number }>;
  /** Itérations d'offre/budget avant approbation (offerRefusalCount + 1). Plus
   *  c'est élevé, plus la mise au point du budget a coûté de cycles. */
  offerIterations: {
    /** Moyenne d'itérations sur les projets facturables ayant une offre. */
    avgIterations: number | null;
    projects: Array<{
      id: string;
      key: string;
      name: string;
      /** Nombre de versions d'offre produites (refus + 1). */
      iterations: number;
      refusals: number;
      status: string;
    }>;
  };
  /** Valeur planifiée (estimés × taux) vs coût réel (heures loggées × taux),
   *  global et par équipe — révèle les équipes qui planifient mal. */
  pvVsCost: {
    total: { pv: number; cost: number };
    byTeam: Array<{ teamId: string | null; teamName: string; pv: number; cost: number }>;
  };
}

export interface PortfolioFinanceQuery {
  granularity?: FiscalGranularity;
  offset?: number;
  clientId?: string;
}

// ---------- EVM / qualité / CFD / rapport équipe ----------

export interface ProjectEvmDto {
  projectId: string;
  currency: string;
  budget: number;
  hasDates: boolean;
  /** % d'avancement (0-100). */
  percentComplete: number;
  /** Planned Value à aujourd'hui (null si pas de dates projet). */
  pv: number | null;
  /** Earned Value = budget × % avancement. */
  ev: number;
  /** Actual Cost cumulé. */
  ac: number;
  /** EV/AC (null si AC = 0). <1 = dépassement. */
  cpi: number | null;
  /** EV/PV (null si PV = 0). */
  spi: number | null;
  /** Écart budgétaire = PV − AC (null si pas de dates). */
  budgetVariance: number | null;
  /** Cost variance = EV − AC. */
  costVariance: number;
  monthly: Array<{ month: string; pv: number | null; ac: number; ev: number }>;
}

export interface ProjectCfdDto {
  projectId: string;
  from: string;
  to: string;
  granularity: 'day' | 'week';
  points: Array<{
    date: string;
    TODO: number;
    IN_PROGRESS: number;
    IN_REVIEW: number;
    ON_HOLD: number;
    DONE: number;
  }>;
}

export interface ProjectQualityDto {
  projectId: string;
  totalTasks: number;
  reworkedTasks: number;
  reworkRatePct: number;
  bugCount: number;
  bugRatePct: number;
  scopeAddedTasks: number;
  scopeAddedEstimateHours: number;
  hasBaselineDate: boolean;
}

export interface TeamReportMemberDto {
  userId: string;
  name: string;
  capacityHours: number;
  loggedHours: number;
  allocatedHours: number;
  utilizationPct: number | null;
  allocationPct: number | null;
  byProject: Array<{ projectKey: string; projectName: string; hours: number; pct: number | null }>;
  statusCounts: Record<TaskStatus, number>;
}

export interface TeamReportDto {
  teamId: string;
  teamName: string;
  from: string;
  to: string;
  members: TeamReportMemberDto[];
  totals: {
    memberCount: number;
    avgUtilizationPct: number | null;
    statusCounts: Record<TaskStatus, number>;
    capacityHours: number;
    loggedHours: number;
    allocatedHours: number;
  };
}

// ---------- KPI transverses (équipe & portefeuille) ----------

/** Répartition des heures/tâches d'un projet par équipe (via l'appartenance
 *  des assignés). Un assigné multi-équipes est réparti à parts égales ;
 *  les assignés sans équipe tombent dans le bucket `teamId: null`. */
export interface ProjectByTeamDto {
  projectId: string;
  hoursByTeam: Array<{ teamId: string | null; teamName: string; color: string | null; hours: number }>;
  tasksByTeam: Array<{ teamId: string | null; teamName: string; color: string | null; count: number }>;
}

/** KPI d'équipe (utilisation, conflits de ressources, marge de capacité). */
export interface TeamKpiDto {
  teamId: string;
  teamName: string;
  from: string;
  to: string;
  /** Taux d'utilisation : part du temps loggé facturable vs opérationnel. */
  utilization: {
    teamBillablePct: number | null;
    byUser: Array<{
      userId: string;
      name: string;
      billableHours: number;
      operationalHours: number;
      totalHours: number;
      billablePct: number | null;
    }>;
  };
  /** Fréquence des conflits de ressources = jours de sur-allocation (alloué
   *  au-delà de la capacité, sur ≥2 projets) — proxy, pas un retard prouvé. */
  conflict: {
    conflictDays: number;
    peopleAffected: number;
    worst: Array<{ userId: string; name: string; date: string; allocatedHours: number; capacityHours: number; projectCount: number }>;
  };
  /** Marge de capacité = heures dispo − heures déjà allouées. */
  capacity: {
    availableHours: number;
    allocatedHours: number;
    headroomHours: number;
    byUser: Array<{ userId: string; name: string; availableHours: number; allocatedHours: number; headroomHours: number }>;
  };
}

/** KPI projet portefeuille (transverse, filtrable par équipe). */
export interface PortfolioKpiDto {
  from: string;
  to: string;
  teamId: string | null;
  projectCount: number;
  currency: string;
  /** Conflits de ressources (sur-allocation multi-projets) sur le périmètre. */
  conflict: { conflictDays: number; peopleAffected: number };
  /** Schedule Variance = EV − PV agrégé sur le portefeuille. */
  schedule: { ev: number; pv: number; sv: number; svPct: number | null };
  /** Milestone Hit Rate : jalons (tâches isMilestone) atteints à temps. */
  milestones: { total: number; onTime: number; hitRatePct: number | null };
  /** Cycle time : jours moyens approbation → clôture des projets terminés. */
  cycleTime: {
    completedCount: number;
    avgDays: number | null;
    samples: Array<{ projectId: string; key: string; name: string; days: number }>;
  };
  /** Taux d'utilisation des ressources (facturable vs opérationnel). */
  utilization: { billablePct: number | null; billableHours: number; operationalHours: number };
}

export interface PortfolioKpiQuery {
  from?: string;
  to?: string;
  teamId?: string;
}

// ---------- Documents projet (offres commerciales, propositions…) ----------

export type ProjectDocumentKind = 'OFFER' | 'OTHER';

export interface ProjectDocumentDto {
  id: string;
  kind: ProjectDocumentKind;
  /** Dossier de l'espace documents (null = racine). */
  folderId: string | null;
  /** Drapeau PROPRE du document (ce que le toggle par fichier écrit). */
  aiContext: boolean;
  /** Exposition RÉELLE aux agents : drapeau propre OU dossier « contexte IA ». */
  aiContextEffective?: boolean;
  /** D'où vient l'exposition — `folder` ⇒ badge « hérité », toggle désactivé. */
  aiContextSource?: 'own' | 'folder' | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  /** Dernière réécriture du CONTENU (null = jamais → fraîcheur = uploadedAt). */
  contentUpdatedAt?: string | null;
  uploadedBy: { id: string; name: string } | null;
}

/** Dossier de l'espace documents d'un projet (arborescence libre). */
export interface ProjectDocumentFolderDto {
  id: string;
  parentId: string | null;
  name: string;
  /** Dossier « Contexte IA » : son contenu ET celui de ses sous-dossiers est
   *  exposé aux agents, sans cocher fichier par fichier. */
  aiContext?: boolean;
  /** Marqué OU descendant d'un dossier marqué (héritage calculé à la lecture). */
  aiContextEffective?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------- Portefeuille (Clients & Contacts) ----------

export enum ClientStatus {
  PROSPECT = 'PROSPECT',
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export interface ContactDto {
  id: string;
  clientId: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ClientDto {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  status: ClientStatus;
  /** Allowlist de modèles d'agent IA (`provider/model` / `provider/*`) — chantier agents 3. */
  allowedAgentModels?: string[];
  createdAt: string;
  updatedAt: string;
  contacts?: ContactDto[];
  /** Nombre de contacts actifs (renvoyé par la liste). */
  contactCount?: number;
  /** Nombre de projets rattachés (renvoyé par la liste). */
  projectCount?: number;
  /** Contact principal (renvoyé par la liste, pour affichage carte). */
  primaryContact?: { id: string; name: string; title: string | null } | null;
}

/** Réponse paginée de `GET /clients`. */
export interface ClientListDto {
  items: ClientDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Résultat d'un import CSV de clients. */
export interface ClientImportResultDto {
  created: number;
  updated: number;
  errors: Array<{ line: number; error: string }>;
}

export interface CreateClientDto {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  status?: ClientStatus;
  allowedAgentModels?: string[];
}

export interface UpdateClientDto {
  name?: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  status?: ClientStatus;
  allowedAgentModels?: string[];
}

export interface CreateContactDto {
  name: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}

export interface UpdateContactDto {
  name?: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  isPrimary?: boolean;
}

export interface CreateTaskDto {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  estimateHours?: number;
  dueDate?: string;
  parentTaskId?: string;
  boardColumnId?: string;
  assigneeIds?: string[];
  labelIds?: string[];
  isMilestone?: boolean;
  isBug?: boolean;
  isGroup?: boolean;
  color?: string | null;
  requiredSkillId?: string | null;
  requiredSkillLevel?: number | null;
  /** Note libre : dépendance vis-à-vis d'un prestataire externe (traçage de blocage). */
  externalDependency?: string | null;
  /** true = tâche bloquée par sa dépendance externe. */
  externalBlocked?: boolean;
}

export interface UpdateTaskDto {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  /** Sous-statut (Custom Status). Non-null → pose le sous-statut ET force
   *  `status` = son parent. `null` → efface. Absent + changement de statut →
   *  sous-statut effacé si son parent ne correspond plus. */
  subStatusId?: string | null;
  /**
   * Motif facultatif de mise en pause. Pris en compte au passage en `ON_HOLD`
   * (écrit dans l'historique + `holdReason`) ou, sans changement de statut,
   * pour éditer la raison d'une tâche déjà en pause. `null`/vide efface.
   */
  statusReason?: string | null;
  priority?: TaskPriority;
  estimateHours?: number | null;
  dueDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  progressPct?: number;
  isMilestone?: boolean;
  isBug?: boolean;
  isGroup?: boolean;
  /** Hex color (#rrggbb) or null to clear. Server keeps it only on groups. */
  color?: string | null;
  parentTaskId?: string | null;
  assigneeIds?: string[];
  labelIds?: string[];
  requiredSkillId?: string | null;
  requiredSkillLevel?: number | null;
  /**
   * Lors d'une transition vers `DONE` : si `true`, le serveur clôture d'abord
   * (en cascade) toutes les tâches précédentes non terminées. Sinon, la
   * transition est refusée (409) tant qu'un prédécesseur reste ouvert.
   */
  completePredecessors?: boolean;
  /** Garde-fous spécifiques à la tâche (agents IA, chantier 2c.2). */
  agentGuardrails?: string | null;
  /** Critères d'acceptation (checklist) — remplace la liste entière (chantier 2c.2). */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Enveloppe totale de coût agent (€) pour la tâche. null pour effacer. */
  agentCostBudget?: number | null;
  /** Dépendance prestataire externe (note libre). null/vide pour effacer. */
  externalDependency?: string | null;
  /** true = tâche bloquée par sa dépendance externe. */
  externalBlocked?: boolean;
}

/**
 * Déplacement Kanban : on indique la colonne cible et la nouvelle
 * position (rank fractionnaire — voir SPECIFICATION §7.3).
 * Optionnellement `beforeTaskId` / `afterTaskId` pour laisser le serveur
 * calculer la position entre deux cartes.
 */
export interface MoveTaskDto {
  boardColumnId: string;
  /** Sous-statut cible (drop dans un container). Non-null → doit appartenir au
   *  statut de la colonne ; `null` → zone principale ; absent → préservé si
   *  cohérent, effacé sinon. */
  subStatusId?: string | null;
  position?: number;
  beforeTaskId?: string;
  afterTaskId?: string;
  /** Motif facultatif si la colonne cible met la tâche en pause (`ON_HOLD`). */
  statusReason?: string;
  /**
   * Idem `UpdateTaskDto.completePredecessors` : autorise la clôture en cascade
   * des prédécesseurs non terminés quand la colonne cible a le statut `DONE`.
   */
  completePredecessors?: boolean;
}

/**
 * Payload d'erreur 409 renvoyé quand on tente de terminer une tâche dont des
 * prédécesseurs restent ouverts (sans `completePredecessors`).
 */
export interface PredecessorsNotDoneError {
  code: 'PREDECESSORS_NOT_DONE';
  message: string;
  predecessors: { id: string; number: number; title: string; status: TaskStatus }[];
}

export interface TaskAssigneeDto {
  userId: string;
  name: string;
  email: string;
  /** Pays ISO 3166-1 alpha-2 résolu (User.countryCode ou défaut org). */
  countryCode?: string | null;
}

export interface TaskLabelDto {
  id: string;
  name: string;
  color: string;
}

export interface TaskDto {
  id: string;
  /** Per-project sequential number. Combine with project key to display
   *  a human-readable id (e.g. `LIFE-12`). 0 = legacy row not yet backfilled. */
  number: number;
  projectId: string;
  parentTaskId: string | null;
  boardColumnId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  /** Sous-statut configurable (CustomStatusDto.id). Toujours cohérent avec
   *  `status` (= parentStatus du sous-statut). null = statut principal seul. */
  subStatusId: string | null;
  /** Raison courante de mise en pause (non-null surtout quand status=ON_HOLD). */
  holdReason: string | null;
  priority: TaskPriority;
  position: number;
  estimateHours: number | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  progressPct: number;
  isMilestone: boolean;
  isBug: boolean;
  isGroup: boolean;
  /** Hex color (#rrggbb). Only meaningful on groups; inherited by descendants. */
  color: string | null;
  requiredSkillId: string | null;
  requiredSkillLevel: number | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  assignees: TaskAssigneeDto[];
  labels: TaskLabelDto[];
  /** Live counts (Prisma _count) so UI badges don't require N round-trips. */
  commentCount?: number;
  attachmentCount?: number;
  /** Garde-fous spécifiques à la tâche (agents IA, chantier 2c). */
  agentGuardrails?: string | null;
  /** Critères d'acceptation / checklist de revue (chantier 2c.2). */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Enveloppe totale de coût agent (€) pour la tâche (finance agents). */
  agentCostBudget?: number | null;
  /** Dépendance vis-à-vis d'un prestataire externe (note libre, traçage blocage). */
  externalDependency: string | null;
  /** true = tâche actuellement bloquée par sa dépendance externe. */
  externalBlocked: boolean;
}

/** Un critère d'acceptation (chantier 2c.2). `done` = coché au moment de la revue. */
export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

export interface UpdateTaskInput {
  acceptanceCriteria?: AcceptanceCriterion[];
  agentGuardrails?: string | null;
}

// ============================================================
// Dépendances de tâches (Phase 4 — Gantt)
// ============================================================
export interface DependencyDto {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  createdAt: string;
}

export interface CreateDependencyDto {
  predecessorId: string;
  successorId: string;
  type?: DependencyType;
  lagDays?: number;
}

export interface UpdateDependencyDto {
  type?: DependencyType;
  lagDays?: number;
}

/** Tâche projetée sur la timeline (avec dates planifiées + flag chemin critique). */
export interface GanttTaskDto {
  id: string;
  title: string;
  status: TaskStatus;
  isMilestone: boolean;
  isGroup: boolean;
  /** Effective color (#rrggbb) — group's own color, or inherited from nearest ancestor group. */
  color: string | null;
  parentTaskId: string | null;
  progressPct: number;
  /** Date début planifiée (ISO date). startDate si fourni, sinon calculé via dépendances. */
  scheduledStart: string;
  /** Date fin planifiée (ISO date). endDate si fourni, sinon calculé via dépendances. */
  scheduledEnd: string;
  /** Marge totale en jours (>=0). 0 = sur le chemin critique. */
  totalSlack: number;
  /** true si tâche sur le chemin critique. */
  critical: boolean;
  assignees: TaskAssigneeDto[];
  labels: TaskLabelDto[];
}

export interface GanttDto {
  projectId: string;
  /** Date début globale (= min des starts). */
  projectStart: string;
  /** Date fin globale (= max des ends). */
  projectEnd: string;
  tasks: GanttTaskDto[];
  dependencies: DependencyDto[];
  /** Durée projet en jours selon le chemin critique. */
  criticalPathDays: number;
}

export interface ListTasksQuery {
  projectId: string;
  status?: TaskStatus | TaskStatus[];
  assigneeId?: string;
  labelId?: string;
  parentTaskId?: string | null;
  search?: string;
  /** dueBefore/dueAfter au format ISO */
  dueBefore?: string;
  dueAfter?: string;
  /** Tri (champ:direction). Ex: 'dueDate:asc' */
  sort?: string;
  /** Plafond serveur 2000. */
  limit?: number;
}

// Boards / colonnes
export interface BoardColumnDto {
  id: string;
  boardId: string;
  name: string;
  order: number;
  wipLimit: number | null;
  status: TaskStatus;
}

export interface BoardDto {
  id: string;
  projectId: string;
  name: string;
  columns: BoardColumnDto[];
}

/** Colonne de board telle qu'exposée par le board inter-projet « Mes tâches »
 *  (sans `boardId` — on regroupe par `projectId`). */
export interface MyTasksColumnDto {
  id: string;
  name: string;
  order: number;
  status: TaskStatus;
  wipLimit: number | null;
}

/** Réponse de `GET /me/tasks` : board inter-projet des tâches assignées à
 *  l'utilisateur courant (projets ACTIVE uniquement). */
export interface MyTasksDto {
  projects: Array<{ id: string; key: string; name: string }>;
  /** Colonnes de board indexées par `projectId` (mapping statut → colonne). */
  columns: Record<string, MyTasksColumnDto[]>;
  tasks: TaskDto[];
}

// ============================================================
// Dashboard personnel (GET /me/dashboard)
// ============================================================

/** Tâche compacte affichée dans la liste « Mes tâches » du dashboard. */
export interface DashboardTaskDto {
  id: string;
  /** Clé lisible (ex. `ATL-110`). */
  key: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** yyyy-mm-dd ou null. */
  dueDate: string | null;
  projectId: string;
  projectName: string;
  projectKey: string;
  assigneeIds: string[];
}

/** Événement du feed d'activité de l'équipe. */
export interface DashboardActivityDto {
  id: string;
  /** `move` = changement de statut ; `comment` = commentaire ; `created` = tâche créée. */
  kind: 'move' | 'comment' | 'created';
  /** ISO date-time UTC. */
  at: string;
  actor: { id: string; name: string };
  taskId: string;
  taskKey: string;
  taskTitle: string;
  /** Statut cible (pour `kind=move`). */
  toStatus: TaskStatus | null;
}

/** Réponse de `GET /me/dashboard` : vue d'accueil personnelle agrégée.
 *  Strictement self-only (le sujet est toujours l'utilisateur courant). */
export interface DashboardDto {
  /** Mes tâches actives (hors DONE), triées priorité/échéance, plafonnées. */
  tasks: DashboardTaskDto[];
  /** Répartition de mes tâches actives par statut (clé = TaskStatus). */
  statusCounts: Record<string, number>;
  /** Nb de mes tâches IN_PROGRESS. */
  inProgress: number;
  /** Nb de tâches que j'ai fait passer à DONE cette semaine (lun→auj). */
  completedThisWeek: number;
  /** Nb de tâches en retard assignées à un membre de mon équipe (moi inclus). */
  overdueTeam: number;
  /** Prochain jalon à venir sur un projet accessible. */
  nextMilestone: {
    taskId: string;
    key: string;
    title: string;
    dueDate: string;
    projectName: string;
  } | null;
  /** Activité récente de mon équipe (déplacements + commentaires). */
  activity: DashboardActivityDto[];
}

export interface CreateColumnDto {
  name: string;
  status: TaskStatus;
  wipLimit?: number;
}

export interface UpdateColumnDto {
  name?: string;
  wipLimit?: number | null;
  status?: TaskStatus;
}

export interface ReorderColumnsDto {
  /** IDs des colonnes dans l'ordre voulu */
  columnIds: string[];
}

// Labels
export interface LabelDto {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

export interface CreateLabelDto {
  name: string;
  color?: string;
}

export interface UpdateLabelDto {
  name?: string;
  color?: string;
}

// ============================================================
// Skills
// ============================================================
export interface SkillDto {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  /** Domaine/famille — sert de « dossier » dans le picker. */
  category: string | null;
  /** Synonymes/alias matchés par la recherche du picker. */
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamSkillDto {
  teamId: string;
  skillId: string;
  createdAt: string;
  skill?: SkillDto;
}

/** Réponse de GET /projects/:id/skills/available. */
export interface AvailableSkillsDto {
  /** false = aucune équipe sur le projet → fallback catalogue complet. */
  scoped: boolean;
  skills: SkillDto[];
  /** Vrai si l'appelant peut émettre une SkillRequest sur ce projet (PM only). */
  canRequestSkill: boolean;
}

export interface UserSkillDto {
  userId: string;
  skillId: string;
  level: number;
  setById?: string | null;
  /** Dernière validation formelle (lead/admin/clôture projet). */
  lastValidatedAt?: string | null;
  /** Expiration (ex. cert périme). UI affiche un warning si dépassée. */
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
  skill?: SkillDto;
}

export interface TaskRequiredSkillDto {
  taskId: string;
  skillId: string;
  level: number;
  skill?: SkillDto;
}

/** Statut de couverture d'une tâche pour une compétence donnée. */
export type SkillTaskCoverageStatus = 'fully' | 'splittable' | 'partial' | 'uncovered';

/** Détail d'un qualifié pour une tâche. */
export interface SkillQualifiedUserDto {
  userId: string;
  name: string;
  level: number;
  freeHours: number;
  assigned: boolean;
  canSolo: boolean;
}

/** Couverture d'une tâche par les qualifiés du pool projet. */
export interface SkillTaskCoverageDto {
  taskId: string;
  title: string;
  status: SkillTaskCoverageStatus;
  requiredLevel: number;
  estimateHours: number | null;
  /** Heures déjà loggées sur la tâche (TimeEntry). */
  loggedHours: number;
  /** Reste à faire = estimate − loggé (null si pas d'estimate). La couverture
   *  est évaluée contre CE chiffre, pas l'estimate total. */
  remainingHours: number | null;
  startDate: string | null;
  endDate: string | null;
  qualifiedUsers: SkillQualifiedUserDto[];
  /** Users à un niveau juste sous le requis (candidats formation). Affichage
   *  seulement — ne comptent pas dans les statuts de couverture. */
  nearQualified: SkillQualifiedUserDto[];
  totalFreeHours: number;
  /** Split greedy proposé quand status='splittable' : qui fait combien d'heures. */
  split?: Array<{ userId: string; name: string; hours: number }>;
}

/** Agrégation par compétence pour le dashboard de gap (Phase F). */
export interface SkillGapRowDto {
  skillId: string;
  name: string;
  color: string | null;
  category: string | null;
  totalTasks: number;
  fully: number;
  splittable: number;
  partial: number;
  uncovered: number;
  tasks: SkillTaskCoverageDto[];
}

/** Compteurs renvoyés par /skill-requests/mine/summary. */
export interface SkillRequestSummaryDto {
  OPEN: number;
  ACK: number;
  RESOLVED: number;
  REJECTED: number;
  /** OPEN + ACK */
  pending: number;
}

/** Résultat de l'import bulk UserSkill (CSV). */
export interface BulkImportUserSkillsResult {
  processed: number;
  created: number;
  updated: number;
  createdSkills: number;
  errors: Array<{ line: number; reason: string }>;
}

export interface ProjectSkillDto {
  projectId: string;
  skillId: string;
  createdAt: string;
  skill?: SkillDto;
}

// ============================================================
// Champs personnalisés (custom fields)
// ============================================================

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox';
export type CustomFieldEntity = 'task' | 'project';

/** Définition d'un champ personnalisé (catalogue org, géré par l'admin). */
export interface CustomFieldDefinitionDto {
  id: string;
  entityType: CustomFieldEntity;
  name: string;
  type: CustomFieldType;
  /** Options de la liste déroulante (type='select'), sinon []. */
  options: string[];
  order: number;
  /** projectIds auxquels le champ est restreint ; [] = tous les projets. */
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomFieldDto {
  entityType: CustomFieldEntity;
  name: string;
  type: CustomFieldType;
  options?: string[];
  order?: number;
  projectIds?: string[];
}

export interface UpdateCustomFieldDto {
  name?: string;
  options?: string[];
  order?: number;
  projectIds?: string[];
}

/**
 * Une paire définition + valeur pour une entité (`GET /tasks/:id/custom-fields`).
 * `value` est la sérialisation canonique en texte ; `null` = non renseigné.
 */
export interface CustomFieldValueDto {
  fieldId: string;
  value: string | null;
  definition: CustomFieldDefinitionDto;
}

export interface UpsertCustomFieldValuesDto {
  values: Array<{ fieldId: string; value: string }>;
}

/** Réponse de `GET /custom-fields/capabilities`. */
export interface CustomFieldCapabilitiesDto {
  canWrite: boolean;
}

// ============================================================
// Sous-statuts configurables (Custom Status)
// ============================================================

/** Statuts parents subdivisables. Le cycle agents (CLAIMED/CHANGES_REQUESTED/
 *  APPROVED) est système et n'accepte PAS de sous-statuts. */
export const SUB_STATUS_PARENTS = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'ON_HOLD',
  'DONE',
] as const;
export type SubStatusParent = (typeof SUB_STATUS_PARENTS)[number];

/** Sous-statut configurable — overlay sur un statut parent. `Task.status`
 *  reste la source de vérité moteur (= parentStatus, synchronisé serveur). */
export interface CustomStatusDto {
  id: string;
  parentStatus: SubStatusParent;
  name: string;
  color: string | null;
  order: number;
  /** Restriction projet ; vide = applicable à tous les projets. */
  projectIds: string[];
  /** Users notifiés (email + carte Teams) à l'ENTRÉE d'une tâche dans ce sous-statut. */
  notifyUserIds: string[];
  /** Équipes notifiées (tous les membres) à l'ENTRÉE. Vide + users vide = off. */
  notifyTeamIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomStatusDto {
  parentStatus: SubStatusParent;
  name: string;
  color?: string | null;
  order?: number;
  projectIds?: string[];
  notifyUserIds?: string[];
  notifyTeamIds?: string[];
}

export interface UpdateCustomStatusDto {
  /** `parentStatus` est immuable (changer le parent muterait le statut moteur
   *  des tâches existantes) — supprimer et recréer pour changer. */
  name?: string;
  color?: string | null;
  order?: number;
  projectIds?: string[];
  notifyUserIds?: string[];
  notifyTeamIds?: string[];
}

export interface CustomStatusCapabilitiesDto {
  canWrite: boolean;
}

export interface AssigneeSuggestionDto {
  userId: string;
  name: string;
  email: string;
  /** Niveau de l'user sur le skill requis (0 si non défini ou pas de skill). */
  level: number;
  /** True si l'user atteint le niveau requis (ou si pas de niveau requis). */
  meetsRequired: boolean;
  /** Heures libres estimées sur la fenêtre (capacité brute − allocations). */
  freeHours: number;
  allocatedHours: number;
  capacityHours: number;
  /** True si freeHours couvre l'estimate de la tâche. */
  availableForTask: boolean;
  /** Score composite skill × dispo (desc = meilleur). */
  score: number;
}

export interface CreateSkillDto {
  name: string;
  description?: string;
  color?: string;
  category?: string;
  aliases?: string[];
}

export interface UpdateSkillDto {
  name?: string;
  description?: string;
  color?: string;
  category?: string;
  aliases?: string[];
}

/** Origine d'un pack : BUILTIN (livré avec l'image) ou CUSTOM (DB, API). */
export type SkillPackSource = 'BUILTIN' | 'CUSTOM';

/** Pack de compétences prêt à l'emploi (catalogue par domaine/vertical). */
export interface SkillPackSummaryDto {
  id: string;
  label: string;
  color: string | null;
  /** BUILTIN si livré avec l'image, CUSTOM si enregistré via l'API. */
  source: SkillPackSource;
  /** Nombre total de compétences du pack. */
  total: number;
  /** Combien sont déjà présentes au catalogue de l'org. */
  seeded: number;
  /** Équipes auxquelles ce pack est réservé (vide = org-wide). */
  teamScope: string[];
}

/** Équipe rattachée comme propriétaire d'un pack. */
export interface PackScopeTeamDto {
  id: string;
  name: string;
  color: string | null;
}

/** Body de POST /skills/packs : crée/met à jour un pack custom. */
export interface CreateSkillPackDto {
  id: string;
  label: string;
  color?: string | null;
  skills: Array<{ name: string; description?: string | null }>;
}

export interface ApplySkillPackResultDto {
  packId: string;
  label: string;
  total: number;
  created: number;
  updated: number;
  /** Skills réactivés (étaient soft-deleted, ramenés via re-sync forcé). */
  restored: number;
  /** Skills désactivés par un user : non touchés sauf en mode force. */
  skippedDisabled: number;
  /** Nombre d'équipes auxquelles les skills ont été auto-rattachés (scope). */
  autoBoundToTeams: number;
}

export interface RemoveSkillPackResultDto {
  packId: string;
  label: string;
  /** Nombre de skills désactivés (soft-deleted) par l'opération. */
  removed: number;
}

// ----- Skill requests (PM → team lead) -----
export type SkillRequestType = 'ASSIGN_SKILL' | 'TRAINING' | 'EXTERNAL';
export type SkillRequestStatus = 'OPEN' | 'ACK' | 'RESOLVED' | 'REJECTED';

export interface CreateSkillRequestDto {
  teamId: string;
  type: SkillRequestType;
  skillId?: string;
  proposedName?: string;
  desiredLevel?: number;
  projectId?: string;
  taskId?: string;
  targetUserId?: string;
  note?: string;
}

export interface SkillRequestDto {
  id: string;
  organizationId: string;
  teamId: string;
  requestedById: string;
  type: SkillRequestType;
  status: SkillRequestStatus;
  skillId: string | null;
  proposedName: string | null;
  desiredLevel: number | null;
  projectId: string | null;
  taskId: string | null;
  targetUserId: string | null;
  note: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Champs enrichis côté service (libellés).
  team?: { id: string; name: string; color: string | null } | null;
  requestedBy?: { id: string; name: string; email: string } | null;
  targetUser?: { id: string; name: string; email: string } | null;
  resolvedBy?: { id: string; name: string; email: string } | null;
  skill?: { id: string; name: string; color: string | null; category: string | null } | null;
  project?: { id: string; name: string } | null;
  task?: { id: string; title: string; number: number } | null;
}

// Événements temps réel / webhooks
export const EVENTS = {
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated',
  TASK_DELETED: 'task.deleted',
  TASK_MOVED: 'task.moved',
  TASK_STATUS_CHANGED: 'task.status_changed',
  COLUMN_CREATED: 'column.created',
  COLUMN_UPDATED: 'column.updated',
  COLUMN_DELETED: 'column.deleted',
  COLUMNS_REORDERED: 'columns.reordered',
  LABEL_CREATED: 'label.created',
  LABEL_UPDATED: 'label.updated',
  LABEL_DELETED: 'label.deleted',
  COMMENT_CREATED: 'comment.created',
  TIME_ENTRY_CREATED: 'time_entry.created',
  DEPENDENCY_CREATED: 'dependency.created',
  DEPENDENCY_DELETED: 'dependency.deleted',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * Event de notification personnelle poussé dans la room `user:<id>` (canal
 * distinct des rooms projet). Alimente la cloche in-app pour les événements qui
 * concernent l'utilisateur où qu'il soit dans l'app, sans qu'il soit dans la
 * room du projet concerné.
 */
export const USER_NOTIFICATION_EVENT = 'notification' as const;

export type UserNotificationKind =
  | 'assignment'
  | 'mention'
  | 'status'
  | 'comment'
  | 'due'
  | 'over_estimate'
  | 'skill_request'
  | 'skill_expiring'
  | 'automation'
  | 'announcement'
  | 'admin_alert'
  | 'system';

/**
 * Élément de la boîte de réception in-app durable (cloche). Même forme que le
 * payload poussé en temps réel sur `USER_NOTIFICATION_EVENT` que la réponse de
 * `GET /me/notifications` — un seul mapper côté front. Les kinds « perso »
 * (assignment/mention/status/comment) portent le libellé dans les champs
 * structurés (rendu i18n front) ; les kinds serveur (automation/admin_alert/
 * announcement/…) portent `title`/`body` déjà rendus dans la langue du
 * destinataire.
 */
export interface InboxNotificationDto {
  /** Id de la ligne persistée. */
  id: string;
  kind: UserNotificationKind;
  /** Titre rendu serveur (kinds serveur) — absent pour les kinds « perso ». */
  title?: string;
  body?: string;
  taskId?: string;
  projectId?: string;
  /** URL du CTA (lien absolu tenant). */
  url?: string;
  taskTitle?: string;
  /** Auteur de l'action (assignation, mention, changement de statut). */
  actorName?: string;
  /** Extrait de commentaire (mention / commentaire). */
  excerpt?: string;
  fromStatus?: string;
  toStatus?: string;
  /** ISO 8601. */
  createdAt: string;
  /** Vue/traitée (pastille éteinte). */
  read: boolean;
}

/** Réponse paginée keyset de `GET /me/notifications`. */
export interface InboxListDto {
  items: InboxNotificationDto[];
  /** Nombre total de notifications non lues (indépendant de la pagination). */
  unreadCount: number;
  /** Curseur opaque de la page suivante, `null` si fin. */
  nextCursor: string | null;
}

/**
 * Payload temps réel poussé dans la room `user:<id>`. Depuis la cloche durable
 * c'est un {@link InboxNotificationDto} complet (avec `id`, `createdAt`,
 * `read:false`). Les champs restent optionnels pour la rétrocompat des anciens
 * clients.
 */
export type UserNotificationPayload = Partial<InboxNotificationDto> & {
  kind: UserNotificationKind;
};

// ============================================================
// Phase 5 — Workload (capacity vs allocation)
// ============================================================
export enum TimeOffType {
  VACATION = 'VACATION',
  SICK = 'SICK',
  PERSONAL = 'PERSONAL',
  PARENTAL = 'PARENTAL',
  OTHER = 'OTHER',
}

/** Capacité hebdo : 7 valeurs (Lundi..Dimanche), occupancy 0..100. */
export interface WorkScheduleDto {
  id: string;
  userId: string;
  effectiveFrom: string; // YYYY-MM-DD
  hoursMon: number;
  hoursTue: number;
  hoursWed: number;
  hoursThu: number;
  hoursFri: number;
  hoursSat: number;
  hoursSun: number;
  occupancyPct: number;
  /** True if the user has no custom WorkSchedule and inherits the org defaults. */
  isDefault?: boolean;
}

/** Settings d'organisation utilisés par le frontend. Inclut au minimum
 *  hoursPerDay et defaultWorkDays — d'autres clés peuvent exister selon
 *  ce qui a été persisté côté admin. */
export interface OrgSettingsDto {
  hoursPerDay?: number;
  defaultWorkDays?: { mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean };
  [key: string]: unknown;
}

export interface UpsertWorkScheduleDto {
  effectiveFrom?: string;
  hoursMon?: number;
  hoursTue?: number;
  hoursWed?: number;
  hoursThu?: number;
  hoursFri?: number;
  hoursSat?: number;
  hoursSun?: number;
  occupancyPct?: number;
}

export interface TimeOffDto {
  id: string;
  userId: string;
  user?: { id: string; name: string; email: string };
  startDate: string; // YYYY-MM-DD
  endDate: string;
  type: TimeOffType;
  notes: string | null;
  /** Origine de la ligne. MANUAL = créé dans l'UI, IMPORT = CSV, API = sync. */
  source?: 'MANUAL' | 'IMPORT' | 'API';
  /** Clé fournie par le système amont (sync idempotente). */
  externalId?: string | null;
  createdAt: string;
}

export interface CreateTimeOffDto {
  userId: string;
  startDate: string;
  endDate: string;
  type?: TimeOffType;
  notes?: string;
}

export interface UpdateTimeOffDto {
  startDate?: string;
  endDate?: string;
  type?: TimeOffType;
  notes?: string | null;
}

export interface AllocationDto {
  id: string;
  userId: string;
  taskId: string;
  projectId: string;
  taskTitle?: string;
  user?: { id: string; name: string; email: string };
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  notes: string | null;
  createdAt: string;
  /**
   * Effective workdays in [startDate, endDate] for this allocation's user :
   * respects WorkSchedule, TimeOff and holidays. Undefined for older clients.
   */
  workdays?: number;
  /**
   * Effective hours = sum over workdays of min(hoursPerDay, dailyCapacity).
   * A user à 4h/j sur une allocation à 8h/j n'absorbe que 4h × N jours.
   */
  effectiveHours?: number;
  /** Days in the range that were skipped (weekend / time-off / holiday). */
  blockedDays?: number;
}

export interface CreateAllocationDto {
  userId: string;
  taskId: string;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  notes?: string;
  /** Origine de l'allocation. `manual` (défaut) = posée à la main → protégée
   *  de l'auto-plan. `auto_split` = créée par l'auto-split d'une tâche. */
  origin?: 'manual' | 'auto_split';
}

export interface UpdateAllocationDto {
  userId?: string;
  startDate?: string;
  endDate?: string;
  hoursPerDay?: number;
  notes?: string | null;
}

export interface AutoSplitRequestDto {
  userId: string;
  taskId: string;
  startDate: string;
  totalHours: number;
  hoursPerDay: number;
  /** Plafond temporel : le split s'arrête au plus tard à cette date. */
  mustFinishBy?: string;
  /** Si true, ignore le plafond journalier du schedule (mode overtime). */
  allowOvertime?: boolean;
  /** Allocations à exclure du calcul de capacité (mode "replace" UI). */
  excludeAllocationIds?: string[];
}

export interface AutoSplitChunkDto {
  startDate: string;
  endDate: string;
  hoursPerDay: number;
}

export interface AutoSplitAlternativesDto {
  /** Date à laquelle on absorberait totalHours SANS contrainte de deadline. */
  extendedEndDate: string | null;
  /** Nombre de jours de dépassement par rapport à la deadline. */
  extraDaysNeeded: number | null;
  /** h/j requis pour rentrer dans la deadline (null si impossible même à 24h/j). */
  requiredHoursPerDayToHitDeadline: number | null;
}

export interface AutoSplitResultDto {
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  workdays: number;
  blockedDays: number;
  effectiveHours: number;
  requestedHours: number;
  /** Heures qu'on n'a pas pu placer (deadline atteinte avant épuisement). */
  shortfallHours: number;
  /** True si on a buté sur `mustFinishBy` avant la fin. */
  hitDeadline: boolean;
  /** Segments à créer : un par cadence distincte (ex. 10j à 4h + 1j à 1h
   *  pour absorber 41h sans surévaluer le dernier jour). */
  chunks: AutoSplitChunkDto[];
  /** Suggestions à afficher quand `shortfallHours > 0` et `mustFinishBy` est posé. */
  alternatives?: AutoSplitAlternativesDto;
}

/** Body de POST /allocations/:id/move-day */
export interface MoveAllocationDayDto {
  fromDate: string;
  toDate: string;
  toUserId?: string;
  /**
   * Résolution si le dépôt tombe sur un jour non ouvré / au-dessus de la
   * capacité. `overtime` (défaut) pose les heures telles quelles ;
   * `resplit` ré-étale les heures à la capacité réelle de la personne.
   */
  mode?: 'overtime' | 'resplit';
}

/** Réponse de POST /allocations/:id/move-day — inclut un snapshot pour undo. */
export interface MoveAllocationDayResultDto {
  source: AllocationDto | null;
  created: AllocationDto[];
  snapshot: {
    sourceId: string;
    userId: string;
    taskId: string;
    startDate: string;
    endDate: string;
    hoursPerDay: number;
    notes: string | null;
  } | null;
}

// ---------- Autoplan ----------
export interface AutoplanRequestDto {
  scope: 'project' | 'user' | 'global';
  projectId?: string;
  userId?: string;
  from?: string;
  to?: string;
  persist?: boolean;
  /** Ce que l'auto-plan préserve (ne remplace pas). Le passé/aujourd'hui est
   *  TOUJOURS gelé en plus de ça. Défaut `manual_autosplit`.
   *  - `manual_autosplit` : ne remplace que ses propres allocations auto-plan.
   *  - `manual` : remplace aussi les auto-split, préserve le manuel.
   *  - `none` : remplace toutes les allocations futures du scope. */
  preserve?: 'manual_autosplit' | 'manual' | 'none';
  /** Affectation assistée : propose le(s) meilleur(s) assignee(s) (skill +
   *  capacité réelle) pour les tâches SANS assigné, puis les planifie. Sans
   *  `persist` = suggestion (swappable via `assignmentOverrides`) ; avec
   *  `persist` = crée les TaskAssignee. Ignoré pour `scope=user`. */
  autoAssign?: boolean;
  /** Réassignation : en mode suggestion, propose AUSSI les tâches DÉJÀ
   *  assignées (par défaut sur leur assigné actuel — aucun changement) pour que
   *  le PM puisse en swapper l'assigné via `assignmentOverrides`. La
   *  réassignation effective n'a lieu qu'au swap. Ignoré pour `scope=user`.
   *  Indépendant du mode de préservation. */
  reassignAssigned?: boolean;
  /** Overrides PM du choix automatique d'assignees, par tâche. */
  assignmentOverrides?: { taskId: string; userIds: string[] }[];
  /** Stratégie de placement (Lot 2.1). `asap` (défaut) = comportement du lot
   *  1a. `deadline_aware` = seconde passe corrective (cf. autoplan.dto.ts),
   *  ne remplace le plan `asap` que si elle l'améliore strictement. */
  placementStrategy?: 'asap' | 'deadline_aware';
  /** Curseur de concentration (Lot 2.2) module l'affectation assistée
   *  (`autoAssign`) : `focus` favorise le moins de personnes possible,
   *  `spread` revient au comportement historique (une personne par tâche).
   *  Défaut : setting org `autoplan.concentration` (fallback `balanced`). */
  concentration?: 'focus' | 'balanced' | 'spread';
  /** Application partielle (Lot 2.5) : restreint la PERSISTANCE (pas
   *  l'aperçu) à ces users/tâches. */
  applyOnly?: { userIds?: string[]; taskIds?: string[] };
  /** Levée CIBLÉE du gel du passé (Lot 4.2, « Libérer cette journée ») — un
   *  seul user, un seul jour (aujourd'hui). N'a d'effet qu'avec `scope='user'`
   *  et `userId` identique ; toute autre combinaison est rejetée (400). */
  unfreezeUserDay?: { userId: string; date: string };
}

export interface ProposedAllocationDto {
  userId: string;
  taskId: string;
  projectId: string;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  userName?: string;
  taskTitle?: string;
  projectKey?: string;
}

export interface EnrichedAllocationDto {
  id: string;
  userId: string;
  taskId: string;
  projectId: string;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  isManual: boolean;
  isAutoPlan: boolean;
  userName?: string;
  taskTitle?: string;
  projectKey?: string;
}

export interface AutoplanWarningDto {
  taskId: string;
  taskTitle?: string;
  type:
    | 'missing_estimate'
    | 'deadline_overflow'
    | 'user_saturated'
    | 'unassigned'
    | 'outside_window'
    | 'dependency_cycle'
    | 'agent_assigned'
    | 'all_candidates_unavailable';
  message: string;
  missingHours?: number;
}

/** Candidat à l'affectation assistée d'une tâche (skill + capacité). */
export interface AssigneeCandidateDto {
  userId: string;
  name: string;
  level: number | null;
  meetsRequired: boolean;
  freeHours: number;
  score: number;
  /** Écarté du noyau par le filtre d'absence (Lot 1b.1) — sans capacité ou en
   *  absence longue durée sur la fenêtre. Reste swappable en `alternatives`. */
  unavailable?: boolean;
  /** Vrai si ce candidat est un agent IA (Lot 5, §5.2) — l'UI n'affiche pas
   *  `freeHours` (la capacité d'un agent n'est jamais des heures) mais un
   *  badge « Agent IA » + `trustLevel`. */
  isAgent?: boolean;
  /** Niveau de confiance de l'agent (candidats agent uniquement). */
  trustLevel?: AgentTrustLevel | null;
}

/** Affectation proposée pour une tâche sans assigné (feature autoAssign). */
export interface ProposedAssignmentDto {
  taskId: string;
  taskTitle?: string;
  projectId: string;
  projectKey?: string;
  chosen: AssigneeCandidateDto[];
  alternatives: AssigneeCandidateDto[];
  /** `agent_suggested` (Lot 5, §5.2) : un agent IA éligible a été proposé —
   *  MODE SUGGESTION UNIQUEMENT, il ne persiste jamais sans acceptation
   *  explicite du PM (override → `source` devient alors `override`). */
  source: 'auto' | 'override' | 'agent_suggested';
  warning?: 'no_candidates' | 'no_qualified' | 'capacity_short';
  /** Vrai si la tâche était DÉJÀ assignée (proposition de réassignation) ;
   *  faux/absent pour une tâche initialement sans assigné. */
  wasAssigned?: boolean;
}

export interface AutoplanResultDto {
  proposed: ProposedAllocationDto[];
  current: EnrichedAllocationDto[];
  diff: {
    added: ProposedAllocationDto[];
    removed: EnrichedAllocationDto[];
    modified: { before: EnrichedAllocationDto; after: ProposedAllocationDto }[];
  };
  warnings: AutoplanWarningDto[];
  /** Affectations proposées pour les tâches sans assigné (vide si autoAssign
   *  désactivé). Preview = suggestion ; persistées si `persist` + `autoAssign`. */
  assignments: ProposedAssignmentDto[];
}

/** Cellule jour×user agrégée pour la grille workload. */
export interface WorkloadCellDto {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Monday … 6 = Sunday
  capacityHours: number;
  allocatedHours: number;
  timeOffType: TimeOffType | null;
  /** true si le jour est férié pour cet utilisateur (selon son pays). */
  isHoliday?: boolean;
  /** Libellé du férié (ex. "Fête du Travail"), si `isHoliday`. */
  holidayName?: string | null;
  allocations: Array<{
    allocationId: string;
    taskId: string;
    taskTitle: string;
    projectKey: string;
    projectName?: string;
    /** Couleur effective héritée du groupe parent le plus proche (hex `#rrggbb`), ou null. */
    color?: string | null;
    hours: number;
    /** true = saisie manuellement par le PM (drag-drop, +Allocate). Optionnel : la sandbox
     * démo statique ne porte pas la distinction (le service réel les fournit toujours). */
    isManual?: boolean;
    /** true = posée par l'auto-plan projet (Lot 3.2, AUTOPLAN_IMPROVEMENTS.md §3.2). */
    isAutoPlan?: boolean;
  }>;
}

export interface WorkloadUserRowDto {
  userId: string;
  name: string;
  email: string;
  cells: WorkloadCellDto[];
}

/** Fraîcheur du dernier auto-plan appliqué sur un projet (Lot 3.3,
 *  AUTOPLAN_IMPROVEMENTS.md §3.3) — comparaison synchrone, pas de job. */
export interface PlanStatusDto {
  /** true si des tâches du projet ont bougé après la dernière application
   *  de l'auto-plan (le plan affiché ne reflète plus l'état des tâches). */
  stale: boolean;
  /** false si le projet n'a jamais reçu d'auto-plan appliqué — `stale` est
   *  alors toujours false (rien à comparer). */
  hasAutoPlan: boolean;
  maxTaskUpdatedAt: string | null;
  maxAutoAllocCreatedAt: string | null;
}

export interface WorkloadGridDto {
  from: string;
  to: string;
  days: Array<{ date: string; weekday: number }>;
  rows: WorkloadUserRowDto[];
}

// ============================================================
// Teams (regroupement transverse d'utilisateurs)
// ============================================================
export type TeamSource = 'LOCAL' | 'SCIM' | 'OIDC';

export interface TeamDto {
  id: string;
  name: string;
  /** Nom d'affichage personnalisé (override LOCAL). Si présent, l'UI l'utilise
   *  à la place de `name`. Pour une équipe SCIM/OIDC, `name` suit le groupe IdP
   *  alors que `displayName` reste un libellé local non synchronisé. */
  displayName: string | null;
  description: string | null;
  color: string | null;
  /** LOCAL = créée à la main ; SCIM/OIDC = synchronisée depuis l'IdP. */
  source: TeamSource;
  /** Identifiant côté IdP (groupe AAD, etc.). Null pour LOCAL. */
  externalId: string | null;
  memberCount?: number;
  /** Tag équipe : les membres (sans override user) peuvent créer un projet non-facturable. */
  canCreateNonBillableProject?: boolean;
  /** Auto-licence : tout membre actif reçoit un siège de licence (miroir du
   *  groupe SCIM/Entra des utilisateurs licenciés). Réservé aux Org Admins. */
  autoLicense?: boolean;
}

export interface TeamMemberDto {
  userId: string;
  isLead: boolean;
  user: {
    id: string;
    name: string;
    email: string;
    /** Override par utilisateur : null = hérite de l'équipe ; true/false = écrase. */
    canCreateNonBillableProject?: boolean | null;
    /** Coût interne / h par défaut du user. Présent UNIQUEMENT si l'appelant
     *  est Team Manager de l'équipe (ou admin) — absent sinon. */
    defaultCostRate?: number | null;
    /** Taux facturé / h par défaut. Même visibilité que defaultCostRate. */
    defaultBillRate?: number | null;
  };
}

export interface TeamWithMembersDto extends TeamDto {
  members: TeamMemberDto[];
}

// ============================================================
// Comments (Phase 6)
// ============================================================
export interface CommentDto {
  id: string;
  taskId: string;
  author: { id: string; name: string; email: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommentDto {
  body: string;
}

// ============================================================
// Watchers — abonnement passif (automatisations built-in, lot 4)
// ============================================================

/** Abonné à une tâche ou un projet. */
export interface WatcherDto {
  id: string;
  userId: string;
  name: string;
  email: string;
}

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

/** Récurrence d'une tâche (`GET /tasks/:id/recurrence`, null si absente). */
export interface RecurringTaskDto {
  id: string;
  projectId: string;
  templateTaskId: string;
  frequency: RecurrenceFrequency;
  /** Jour ISO 1-7 (weekly). */
  weekday: number | null;
  /** Jour du mois 1-28 (monthly). */
  monthDay: number | null;
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
}

export interface UpsertRecurrenceDto {
  frequency: RecurrenceFrequency;
  weekday?: number | null;
  monthDay?: number | null;
  active?: boolean;
}

/** Une ligne de « ce que je suis » (`GET /me/watching`). */
export interface WatchingEntryDto {
  id: string;
  kind: 'task' | 'project';
  /** null quand `kind === 'project'`. */
  taskId: string | null;
  projectId: string;
  /** Titre de la tâche, ou nom du projet si `kind === 'project'`. */
  title: string;
  projectName: string;
  createdAt: string;
}

// ============================================================
// Time entries (Phase 3)
// ============================================================
export interface TimeEntryDto {
  id: string;
  taskId: string;
  userId: string;
  user: { id: string; name: string; email: string };
  date: string; // YYYY-MM-DD
  durationMinutes: number;
  /** Sous-portion d'overtime (≤ durationMinutes). Défaut 0. */
  overtimeMinutes: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTimeEntryDto {
  taskId: string;
  date: string;
  durationMinutes: number;
  description?: string | null;
  /** Optionnel : marquer une partie comme heures sup. */
  overtimeMinutes?: number;
}

export interface UpdateTimeEntryDto {
  date?: string;
  durationMinutes?: number;
  overtimeMinutes?: number;
  description?: string | null;
}

// ============================================================
// Attachments (Phase 6)
// ============================================================
export interface AttachmentDto {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploader: { id: string; name: string; email: string };
  createdAt: string;
  downloadUrl: string;
}

// ============================================================
// Livrables (chantier 2c — cycle de vie agents)
// ============================================================
export type DeliverableReviewStatusDto = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED';

export interface DeliverableVerificationDto {
  method: 'self_attest' | 'tool_output' | 'agent_validator' | 'ci_signed' | 'human';
  status?: string;
  evidence?: string;
}

export interface DeliverableDto {
  id: string;
  taskId: string;
  title: string;
  url: string | null;
  attachmentId: string | null;
  justification: string | null;
  reviewStatus: DeliverableReviewStatusDto;
  version: number;
  supersedesId: string | null;
  verification: DeliverableVerificationDto | null;
  commitSha: string | null;
  /** Pièce jointe S3 (Garage) portant l'artefact, si le livrable en a une. */
  attachment: { id: string; filename: string; sizeBytes: number } | null;
  author: { id: string; name: string; isAgent: boolean };
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface CreateDeliverableDto {
  title: string;
  url?: string;
  attachmentId?: string;
  /** Contenu texte/markdown → persisté en S3 comme PJ (prioritaire sur attachmentId). */
  content?: string;
  filename?: string;
  justification?: string;
  verification?: DeliverableVerificationDto;
  commitSha?: string;
}

export interface ReviewDeliverableDto {
  decision: 'approve' | 'request_changes';
  note?: string;
}

// ============================================================
// Runs d'agent — coût déclaratif (chantier finance agents)
// ============================================================
export interface CreateAgentRunDto {
  taskId?: string;
  deliverableId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Coût réel en € déclaré par l'agent. */
  cost?: number;
  note?: string;
}

export interface AgentRunDto {
  id: string;
  agentId: string;
  taskId: string | null;
  projectId: string | null;
  deliverableId: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  /** Coût de référence recalculé serveur (tokens × taux profil) — garde-fou
   *  anti-triche, jamais facturé. Null si aucun taux/token. */
  derivedCost: number | null;
  /** Clé d'idempotence si l'agent en a fourni une (sinon null). */
  runKey: string | null;
  note: string | null;
  /** Provenance (Lot 3) : 'self' = déclaré par l'agent ; 'gateway' = mesuré par
   *  la passerelle LLM Vaks (usage exact). Défaut 'self' sur l'historique. */
  source: string;
  createdAt: string;
  /**
   * État des enveloppes de coût APRÈS ce run (coupe-circuit lot A). Présent
   * seulement pour un agent : c'est par ce canal qu'il apprend qu'il doit
   * s'arrêter, au moment exact où il déclare sa consommation.
   */
  budget?: AgentBudgetStatusDto;
  /**
   * `true` = l'enveloppe était dépassée ET le coupe-circuit
   * (`agents.budgetBreaker`) est actif : la tâche a été retirée à l'agent, qui
   * doit cesser immédiatement (elle attend une reprise humaine).
   */
  taskReleased?: boolean;
}

/** Périmètre d'une enveloppe de coût agent (€). */
export type AgentBudgetScope = 'agent_daily' | 'agent_monthly' | 'project' | 'task';

/** Une enveloppe de coût agent et sa consommation. */
export interface AgentBudgetEnvelopeDto {
  scope: AgentBudgetScope;
  budget: number;
  spent: number;
  remaining: number;
  exceeded: boolean;
}

/** Photographie des enveloppes applicables + verdict d'arrêt. */
export interface AgentBudgetStatusDto {
  envelopes: AgentBudgetEnvelopeDto[];
  exceeded: AgentBudgetScope[];
  /** `true` = au moins une enveloppe consommée : arrêter et soumettre l'existant. */
  stop: boolean;
}

// ---------- Workload — vue agrégée des agents IA (Lot 5, §5.1) ----------
//
// VISIBILITÉ, pas allocation : un agent n'a jamais d'heures — concurrence +
// budgets runs/€ + file de revue (le vrai goulot). Distincte de la grille
// people×jours (qui n'a aucun sens pour un agent).

/**
 * Une ligne d'agent dans la vue workload agrégée (`GET /workload/agents`).
 * Le bloc `budget` (montants €) est **OMIS** — jamais un placeholder — quand
 * l'appelant n'a pas `finance:view` (même discipline que les paliers budget
 * sponsors qualitatifs) : un PM sans droit finance voit la concurrence et la
 * file de revue, rien de plus, jamais une erreur.
 */
export interface AgentWorkloadItemDto {
  agentId: string;
  name: string;
  trustLevel: AgentTrustLevel | null;
  /** Tâches CLAIMED/IN_PROGRESS/CHANGES_REQUESTED assignées à cet agent —
   *  même ensemble que le refus 409 `BUDGET_CONCURRENCY` au claim. */
  activeTasks: number;
  maxConcurrentTasks: number | null;
  /** Livrables produits par cet agent en attente de revue humaine. */
  reviewQueuePending: number;
  /** Enveloppes de coût (agent×jour, agent×mois, projet, tâche) — présent
   *  SEULEMENT si `AgentWorkloadDto.canViewFinance`. */
  budget?: AgentBudgetStatusDto;
}

export interface AgentWorkloadDto {
  /** `false` si le scope demandé n'a aucun projet `agentsEnabled` — la vue
   *  N'EXISTE PAS (`agents` alors vide), même pattern que `agents-report`. */
  enabled: boolean;
  from: string;
  to: string;
  /** Vrai si l'appelant peut voir les montants € (`budget` alors présent
   *  sur chaque agent qui a des enveloppes définies). */
  canViewFinance: boolean;
  agents: AgentWorkloadItemDto[];
}

/**
 * Une ligne du journal transverse des runs d'agent (Admin > Agent runs) :
 * le run brut + les libellés résolus + le verdict d'anomalie recalculé à la
 * lecture (la règle peut évoluer sans migration de données).
 */
export interface AgentRunListItemDto extends AgentRunDto {
  agentName: string | null;
  projectName: string | null;
  taskTitle: string | null;
  taskNumber: number | null;
  anomaly: 'no_tokens' | 'zero_cost' | 'below_reference' | null;
}

/** Page du journal + totaux sur le PÉRIMÈTRE FILTRÉ (pas sur la page). */
export interface AgentRunsPageDto {
  items: AgentRunListItemDto[];
  page: number;
  pageSize: number;
  total: number;
  totals: { cost: number; tokensIn: number; tokensOut: number; derivedCost: number };
  /** Nombre de runs signalés anomalie sur le périmètre filtré (agent/projet/période),
   *  INDÉPENDANT du toggle `anomaliesOnly` — sert le compteur KPI. */
  anomalyCount: number;
}

/** Un run d'agent tel qu'affiché dans l'onglet AI d'une tâche. */
export interface TaskAgentRunDto {
  id: string;
  agentId: string;
  agentName: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  derivedCost: number | null;
  /** Motif d'anomalie recalculé à la lecture, ou null. */
  anomaly: 'no_tokens' | 'zero_cost' | 'below_reference' | null;
  note: string | null;
  createdAt: string;
}

/** Activité agent consolidée d'une tâche (onglet AI du détail de tâche). */
export interface TaskAgentActivityDto {
  agentsEnabled: boolean;
  budget: {
    /** Enveloppe `Task.agentCostBudget` (€) ou null si non plafonnée. */
    taskBudget: number | null;
    /** Coût agent réel cumulé sur la tâche. */
    spent: number;
    runCount: number;
  };
  claim: { agentId: string; agentName: string | null; claimedAt: string | null } | null;
  runs: TaskAgentRunDto[];
}

/** Synthèse d'usage d'un agent (lecture admin). */
export interface AgentRunSummaryDto {
  agentId: string;
  runCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  avgCostPerRun: number | null;
  /** Coût moyen par tâche distincte terminée (recalage). */
  avgCostPerTask: number | null;
  runs: AgentRunDto[];
}

// ============================================================
// Reports (Phase 3)
// ============================================================
export interface ProjectStatsDto {
  projectId: string;
  projectKey: string;
  projectName: string;
  /** ISO yyyy-mm-dd ou null si non renseigné sur le projet */
  startDate: string | null;
  dueDate: string | null;
  totalTasks: number;
  byStatus: { TODO: number; IN_PROGRESS: number; IN_REVIEW: number; DONE: number };
  completionPct: number;
  overdueTasks: number;
  totalEstimateHours: number;
  doneEstimateHours: number;
  remainingEstimateHours: number;
  totalSpentMinutes: number;
}

export interface BurndownPointDto {
  date: string;
  idealRemainingHours: number;
  actualRemainingHours: number;
  doneTasks: number;
}

export interface BurndownReportDto {
  projectId: string;
  from: string;
  to: string;
  /** Fenêtre de référence sur laquelle l'idéal est calculé (durée projet si dispo,
   *  sinon = from/to). Sert à signaler "vous regardez un zoom de X→Y". */
  referenceFrom: string;
  referenceTo: string;
  totalScopeHours: number;
  points: BurndownPointDto[];
}

// ---------- Timesheet (Phase 3, vue hebdo/mensuelle utilisateur) ----------

export interface TimesheetDayDto {
  /** yyyy-mm-dd */
  date: string;
  /** 0 = lundi … 6 = dimanche */
  dayOfWeek: number;
  /** Capacité du jour en heures = schedule[day] × occupancy, 0 si férié/timeOff */
  capacityHours: number;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  isTimeOff: boolean;
  timeOffType: string | null;
  timeOffNotes: string | null;
  /** Somme des hoursPerDay des allocations actives ce jour */
  allocatedHours: number;
  /** Somme des durationMinutes des time entries du jour */
  actualMinutes: number;
  /** max(0, actual - capacity) en minutes — heures sup. */
  overtimeMinutes: number;
}

export interface TimesheetTaskDto {
  id: string;
  title: string;
  status: 'TODO' | 'CLAIMED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'ON_HOLD' | 'DONE';
  number: number;
  estimateHours: number | null;
  projectId: string;
  projectKey: string;
  projectName: string;
  /** Ticket d'un outil de ticketing externe (projet conteneur `kind=EXTERNAL`,
   *  loggable en timesheet uniquement). null = tâche projet ordinaire. */
  externalSource?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
}

export interface TimesheetCellDto {
  taskId: string;
  date: string;
  allocatedHours: number;
  actualMinutes: number;
  /** Sous-portion d'overtime (somme des entries de la cellule). */
  overtimeMinutes: number;
  /** ids des TimeEntry sur cette cellule (au cas où on en aurait plusieurs) */
  entryIds: string[];
}

export interface TimesheetScheduleDto {
  hoursMon: number;
  hoursTue: number;
  hoursWed: number;
  hoursThu: number;
  hoursFri: number;
  hoursSat: number;
  hoursSun: number;
  occupancyPct: number;
  /** true si le schedule est dérivé des défauts d'org (pas de WorkSchedule explicite) */
  isDefault: boolean;
}

export interface TimesheetAddableTaskDto {
  id: string;
  title: string;
  number: number;
  estimateHours: number | null;
  projectId: string;
  projectKey: string;
  projectName: string;
  externalSource?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
}

/** Ticket d'outil externe upserté/recherché via /external-tasks. */
export interface ExternalTaskDto {
  id: string;
  title: string;
  status: 'TODO' | 'CLAIMED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'ON_HOLD' | 'DONE';
  externalSource: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  projectId: string;
  projectKey: string;
  projectName: string;
  clientId: string | null;
}

/**
 * Ligne « virtuelle » de la timesheet correspondant à une absence
 * (TimeOff). Auto-générée à partir des TimeOff de l'utilisateur, sans
 * créer de Task ni de TimeEntry réels. Lecture seule côté UI.
 */
export interface TimesheetTimeOffRowDto {
  /** Identifiant stable de la ligne (utilisable comme key React).
   *  Forme : `timeoff:<type>`. */
  id: string;
  /** Type d'absence (VACATION, SICK, PARENTAL, PERSONAL, ...). */
  type: string;
  /** Libellé court à afficher (« Vacation », « Sick leave », …). */
  label: string;
  /** Heures d'absence par date (yyyy-mm-dd → heures). Ne contient que
   *  les dates de la fenêtre où l'utilisateur est effectivement off. */
  hoursByDate: Record<string, number>;
}

export interface TimesheetDto {
  userId: string;
  from: string;
  to: string;
  user: { id: string; name: string; email: string; countryCode: string | null };
  schedule: TimesheetScheduleDto;
  days: TimesheetDayDto[];
  tasks: TimesheetTaskDto[];
  cells: TimesheetCellDto[];
  addableTasks: TimesheetAddableTaskDto[];
  /** Lignes virtuelles « Time off » auto-générées à partir des absences
   *  (TimeOff). Une ligne par type. Cellules en lecture seule. */
  timeOffRows: TimesheetTimeOffRowDto[];
}

export interface TaskInWindowDto {
  id: string;
  title: string;
  status: 'TODO' | 'CLAIMED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'ON_HOLD' | 'DONE';
  startDate: string | null;
  dueDate: string | null;
  estimateHours: number | null;
  progressPct: number;
  overdue: boolean;
  assignees: { id: string; name: string; email: string }[];
}

export interface TasksInWindowReportDto {
  projectId: string;
  from: string;
  to: string;
  tasks: TaskInWindowDto[];
}

/** Registre des widgets du rapport projet (ReportsView) — v1 : show/hide +
 *  reorder des sections existantes. Source de vérité unique, consommée par
 *  le front (registre de rendu + panneau de personnalisation) et par le back
 *  (validation à la persistance). L'ORDRE de ce tableau EST l'ordre par
 *  défaut (= comportement actuel, no-op pour qui ne personnalise rien). */
export const REPORT_WIDGET_KEYS = [
  'kpis',
  'burndown',
  'dueAdherence',
  'agentsQuality',
  'teamBreakdown',
  'quality',
  'agents',
  'cfd',
  'tasksInWindow',
  'breakdownTables',
  'skillGap',
] as const;

export type ReportWidgetKey = (typeof REPORT_WIDGET_KEYS)[number];

export interface ReportWidgetPreferenceDto {
  widgetOrder: ReportWidgetKey[];
  hiddenKeys: ReportWidgetKey[];
}

export interface DueAdherenceDto {
  projectId: string;
  totalCompleted: number;
  onTime: number;
  late: number;
  noDeadline: number;
  /** % à temps sur l'ensemble des tâches terminées (inclut sans-échéance). */
  onTimePct: number;
  /** % à temps parmi les seules tâches **avec** échéance (onTime/(onTime+late)).
   *  = « On-Time Completion Percentage ». null si aucune tâche à échéance. */
  onTimeCompletionPct: number | null;
}

export interface TimeBreakdownRowDto {
  projectId?: string;
  userId?: string;
  labelId?: string;
  key?: string;
  name: string;
  email?: string;
  minutes: number;
  billable?: number;
}

export interface TimeBreakdownDto {
  totalMinutes: number;
  billableMinutes: number;
  nonBillableMinutes: number;
  byProject: TimeBreakdownRowDto[];
  byUser: TimeBreakdownRowDto[];
  byLabel: TimeBreakdownRowDto[];
}

// ============================================================
// Project teams (membership)
// ============================================================
export interface ProjectTeamDto {
  projectId: string;
  teamId: string;
  /** Niveau d'accès project-scopé hérité par tous les membres de l'équipe.
   *  null = visibilité seule (liens legacy antérieurs à cette feature). */
  role: { id: string; key: string; name: string } | null;
  team: {
    id: string;
    name: string;
    color: string | null;
    members: Array<{ userId: string; user: { id: string; name: string; email: string } }>;
  };
}

// ============================================================
// Webhooks sortants (Phase 7)
// ============================================================
export type WebhookScopeType = 'ORG' | 'PROJECT' | 'TEAM';
export type WebhookFormat = 'raw' | 'teams';

export interface WebhookDto {
  id: string;
  url: string;
  label: string;
  secret: string;
  events: string[];
  active: boolean;
  /** Périmètre de routage : ORG (tous), PROJECT ou TEAM. */
  scopeType: WebhookScopeType;
  /** projectId/teamId selon scopeType ; null si ORG. */
  scopeId: string | null;
  /** Format du payload : 'raw' (enveloppe Vaks) ou 'teams' (Adaptive Card). */
  format: WebhookFormat;
  /** Posé si le webhook a été désactivé automatiquement (échecs répétés). */
  autoDisabledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreateDto {
  url: string;
  label?: string;
  events: string[];
  active?: boolean;
  secret?: string;
  scopeType?: WebhookScopeType;
  scopeId?: string | null;
  format?: WebhookFormat;
}

export interface WebhookUpdateDto {
  url?: string;
  label?: string;
  events?: string[];
  active?: boolean;
  secret?: string;
  scopeType?: WebhookScopeType;
  scopeId?: string | null;
  format?: WebhookFormat;
}

export type WebhookDeliveryStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface WebhookDeliveryDto {
  id: string;
  organizationId: string;
  webhookId: string;
  event: string;
  payload: unknown;
  status: WebhookDeliveryStatus;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  attemptCount: number;
  queuedAt: string;
  deliveredAt: string | null;
}

// ===== Audit log (Phase 8) =====

export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AuditOutcome = 'SUCCESS' | 'FAILURE';
export type AuditActorType = 'USER' | 'API_TOKEN' | 'AGENT' | 'SYSTEM' | 'ANONYMOUS';

export interface AuditLogDto {
  id: string;
  organizationId: string;
  createdAt: string;
  action: string;
  severity: AuditSeverity;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  route: string | null;
  method: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  detail: unknown;
}

/** Pagination keyset : `nextCursor` à repasser tel quel, null = fin. */
export interface AuditLogListResponse {
  items: AuditLogDto[];
  nextCursor: string | null;
}

export interface AuditLogListQuery {
  from?: string;
  to?: string;
  /** Préfixe d'action (startsWith), ex. "auth.login". */
  action?: string;
  actorId?: string;
  /** Filtre par origine de l'acteur (USER / API_TOKEN / AGENT / SYSTEM…). */
  actorType?: AuditActorType;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
  resourceType?: string;
  resourceId?: string;
  /** Recherche libre sur action + actorLabel. */
  q?: string;
  cursor?: string;
  pageSize?: number;
}

export interface AuditSyslogTestResult {
  ok: boolean;
  error?: string;
  at: string;
}

// ============================================================
// Licensing (open-core, gating des features premium — SPEC §16)
// ============================================================

/**
 * Catalogue des features **premium** gated derrière une licence payante.
 * Flags fins (les bundles commerciaux se composent côté éditeur). Une licence
 * absente ou expirée ⇒ `features = []` ⇒ ces features renvoient 403
 * `LICENSE_FEATURE_DISABLED`. Le core (phases 1-7) n'est jamais gated.
 */
export const LICENSE_FEATURES = [
  'sso-oidc', // Fédération OIDC (Entra ID)
  'sso-saml', // Fédération SAML 2.0
  'scim', // Provisioning SCIM 2.0
  'siem-export', // Forwarder syslog RFC 5424 / export CEF SIEM
  'audit-advanced', // Ancre d'intégrité, archivage froid, alerting brute-force
  'teams-provisioning', // Provisioning Microsoft Teams (Graph) à l'activation projet
  'ci-verification', // Preuve CI signée des livrables d'agents (webhook entrant HMAC + connecteurs GitHub/generic)
  // Agents IA « workforce » : lève le plafond gratuit de FREE_AGENT_LIMIT agents
  // (offre « illimité ») ET débloque la fédération d'identité des agents (RFC 8693,
  // auth keyless à l'échelle). En dessous du plafond, les agents tournent sans
  // licence avec des PAT mintés par un admin (freemium quota, cf. LicenseService).
  'agents',
  // ⚠️ DÉPRÉCIÉES — conservées uniquement pour que d'anciens tokens qui les portent
  // restent valides. Plus enforced nulle part :
  //  - `mcp` : le connecteur MCP conversationnel humain est désormais **core/gratuit**
  //    (piloté par le seul toggle admin `mcp.enabled`).
  //  - `agent-federation` : repliée dans `agents`.
  'mcp',
  'agent-federation',
] as const;

export type LicenseFeature = (typeof LICENSE_FEATURES)[number];

/**
 * Valeur spéciale (wildcard) admise dans le claim `features` d'une licence : le
 * produit l'étend à **toutes** les features de `LICENSE_FEATURES` connues à
 * l'exécution — y compris celles ajoutées dans une version ultérieure. Une
 * licence « all » gagne donc automatiquement les nouvelles features premium.
 */
export const LICENSE_FEATURE_ALL = 'all';

/** Libellés UI des features (pour la page licence + CTA des FeatureGate). */
export const LICENSE_FEATURE_LABELS: Record<LicenseFeature, string> = {
  'sso-oidc': 'Single sign-on (OIDC / Entra ID)',
  'sso-saml': 'Single sign-on (SAML 2.0)',
  scim: 'Provisioning automatique (SCIM 2.0)',
  'siem-export': 'Export SIEM (syslog / CEF)',
  'audit-advanced': "Audit avancé (intégrité, archivage, alerting)",
  'teams-provisioning': 'Provisioning Microsoft Teams (Graph)',
  'ci-verification': 'Vérification CI signée (livrables agents)',
  agents: 'Agents IA illimités (+ fédération)',
  mcp: 'Connecteur IA (MCP)',
  'agent-federation': "Fédération d'identité des agents IA",
};

/**
 * État de la licence du déploiement/tenant courant :
 *  - `none` : aucune licence chargée → core only.
 *  - `invalid` : signature invalide → traité comme `none` (jamais bloquant).
 *  - `active` : valide, > 30 j avant expiration.
 *  - `grace` : valide, ≤ 30 j avant expiration (features encore actives).
 *  - `expired` : passée la date d'expiration → features premium désactivées.
 *  - `suspended` : licence valide mais serveur de licences injoignable au-delà
 *    de la fenêtre de grâce hors-ligne (hybride en ligne) → features premium
 *    suspendues jusqu'au prochain contact réussi. Le core + les données restent
 *    accessibles. Distinct de `expired` (la licence n'est PAS périmée).
 */
export type LicenseStatus =
  | 'none'
  | 'invalid'
  | 'active'
  | 'grace'
  | 'expired'
  | 'suspended';

/** Réponse de `GET /license` — lisible par tout user authentifié (UI). */
export interface LicenseStatusDto {
  status: LicenseStatus;
  /** Features **effectivement actives** (vide si expired/none/invalid). */
  features: LicenseFeature[];
  customer: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /** Jours restants avant expiration (négatif si dépassé), null si pas de licence. */
  daysRemaining: number | null;
  /** Plafond d'utilisateurs actifs (null = illimité). */
  maxUsers: number | null;
  notes: string | null;
  /** Vrai si la signature cryptographique a été vérifiée avec succès. */
  signatureValid: boolean;
  /** Vrai si la licence exige un contact serveur récurrent (politique en ligne). */
  requireOnline: boolean;
  /**
   * UUID de l'organisation courante — affiché (lecture seule) dans le panneau
   * admin pour épingler une licence (`--org <uuid>`). null si indéterminable.
   */
  organizationId: string | null;
  /** Nombre de sièges **occupés** (utilisateurs `licensed=true` non supprimés).
   *  Permet à l'UI admin d'afficher « X / maxUsers ». null si indéterminable. */
  seatsUsed?: number | null;
  /** Plafond **effectif** de sièges humains (licence `maxUsers` si active, sinon
   *  plafond gratuit `FREE_SEAT_LIMIT`). null = illimité (licence sans plafond). */
  seatLimit?: number | null;
  /** Nombre d'identités agents actives (kind=AGENT, non supprimées/suspendues). */
  agentsUsed?: number | null;
  /** Plafond **effectif** d'agents (feature `agents` = illimité → null ; sinon
   *  `maxAgents` métré ou le plafond gratuit `FREE_AGENT_LIMIT`). */
  agentLimit?: number | null;
}

/**
 * Politique de vérification en ligne, **portée par la licence** (décidée par
 * l'éditeur à l'émission). Absente ⇒ licence 100 % hors-ligne (comportement
 * historique). Présente avec `required:true` ⇒ le produit exige un contact
 * récurrent avec le serveur de licences : au-delà de `maxOfflineDays` sans
 * contact réussi, les features premium sont suspendues (`status:'suspended'`),
 * le core + les données restant accessibles. La **clé d'activation** reste un
 * secret côté déploiement (jamais dans le token) ; `serverUrl` (non sensible)
 * peut être embarqué et surchargé par l'env du déploiement.
 */
export interface LicenseOnlinePolicy {
  required?: boolean;
  /** Fenêtre de grâce hors-ligne en jours (défaut produit si absent). */
  maxOfflineDays?: number | null;
  /** URL du serveur de licences (l'env `LICENSE_SERVER_URL` la surcharge). */
  serverUrl?: string;
}

/** Payload décodé d'un token de licence PASETO v4.public. */
export interface LicensePayload {
  iss: string;
  sub: string;
  customer: string;
  organizationId: string | null;
  issuedAt: string;
  expiresAt: string;
  features: string[];
  limits?: {
    maxUsers?: number | null;
    /** Plafond d'identités agents (null/absent = pas de palier métré ; la feature
     *  `agents` accorde l'illimité). Sans licence, le plafond gratuit s'applique. */
    maxAgents?: number | null;
  };
  online?: LicenseOnlinePolicy;
  notes?: string;
}

/** Corps de `POST /admin/license` (upload d'un nouveau fichier de licence). */
export interface UploadLicenseDto {
  /** Token PASETO `v4.public.…` collé par l'admin. */
  token: string;
}

/** Une ligne d'historique d'upload de licence (`GET /admin/license/history`). */
export interface LicenseHistoryRowDto {
  id: string;
  customer: string | null;
  features: string[];
  issuedAt: string | null;
  expiresAt: string | null;
  signatureValid: boolean;
  active: boolean;
  uploadedByEmail: string | null;
  createdAt: string;
}
