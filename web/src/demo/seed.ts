/* ============================================================
   Vaks — Démo statique : jeu de données seed (org « Acme »).
   ----------------------------------------------------------------
   Contenu crédible et riche : ~10 users (dont le visiteur = PM), 4 projets
   (1 ACTIVE mis en avant), tâches réparties sur tous les statuts, labels,
   quelques time entries / allocations / commentaires. Formes DTO exactes.
   ============================================================ */
import {
  TaskStatus,
  TaskPriority,
  ProjectStatus,
  DependencyType,
  type DependencyDto,
  type UserDto,
  type ProjectDto,
  type BoardDto,
  type BoardColumnDto,
  type TaskDto,
  type LabelDto,
  type TimeEntryDto,
  type CommentDto,
  type ClientDto,
  type SkillDto,
  type AllocationDto,
  type TeamDto,
  type WorkspaceAgentDto,
} from '@vaks-pm/shared';
import type { DemoState } from './store';
import { DEMO_STATE_VERSION } from './config';

/* ---------- Helpers de date (relatifs à aujourd'hui) ---------- */
const MS_DAY = 86_400_000;
function iso(d: Date): string {
  return d.toISOString();
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dayOffset(n: number): Date {
  return new Date(Date.now() + n * MS_DAY);
}
/** Lundi de la semaine courante (00:00 locale approx). */
function mondayThisWeek(): Date {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0 = lundi
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - dow * MS_DAY);
}

/* ---------- Users ---------- */
const ME_ID = 'user_me';

/** Permissions d'un PM/portfolio riche — tout SAUF l'admin org pur. */
const PM_PERMISSIONS = [
  'project:create', 'project:view', 'project:view_all', 'project:update',
  'project:archive', 'project:delete', 'project:assign_managers',
  'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
  'comment:create', 'attachment:manage',
  'time:log', 'allocation:manage', 'timeoff:write',
  'report:view', 'report:view_all', 'finance:view', 'finance:manage',
  'client:view', 'client:manage',
  'team:create', 'team:delete', 'team:manage_members',
  'webhook:manage',
];

function mkUser(
  id: string,
  name: string,
  email: string,
  country: string,
  extra: Partial<UserDto> = {},
): UserDto {
  return {
    id,
    email,
    name,
    kind: 'HUMAN',
    isAdmin: false,
    licensed: true,
    timezone: 'Europe/Paris',
    status: 'ACTIVE',
    countryCode: country,
    preferredLanguage: null,
    authProvider: 'LOCAL',
    permissions: ['task:view', 'time:log', 'comment:create', 'project:view'],
    managesAnyProject: false,
    isTeamLead: false,
    ...extra,
  };
}

function seedUsers(): UserDto[] {
  return [
    mkUser(ME_ID, 'Camille Laurent', 'camille.laurent@acme.demo', 'FR', {
      permissions: PM_PERMISSIONS,
      managesAnyProject: true,
      isTeamLead: true,
    }),
    mkUser('user_2', 'Julien Meyer', 'julien.meyer@acme.demo', 'FR', { isTeamLead: true }),
    mkUser('user_3', 'Sophie Nguyen', 'sophie.nguyen@acme.demo', 'FR'),
    mkUser('user_4', 'Marco Rossi', 'marco.rossi@acme.demo', 'IT'),
    mkUser('user_5', 'Lena Schmidt', 'lena.schmidt@acme.demo', 'DE'),
    mkUser('user_6', 'Tom Becker', 'tom.becker@acme.demo', 'DE'),
    mkUser('user_7', 'Aïcha Benali', 'aicha.benali@acme.demo', 'FR'),
    mkUser('user_8', 'David Cohen', 'david.cohen@acme.demo', 'FR'),
    mkUser('user_9', 'Elena Popov', 'elena.popov@acme.demo', 'IT'),
    mkUser('user_10', 'Nora Andersson', 'nora.andersson@acme.demo', 'DE'),
  ];
}

/* ---------- Clients ---------- */
function seedClients(): ClientDto[] {
  const now = iso(new Date());
  return [
    {
      id: 'client_1', name: 'Globex', company: 'Globex Corp', email: 'contact@globex.demo',
      phone: '+33 1 23 45 67 89', address: 'Paris, France', notes: null,
      status: 'ACTIVE' as ClientDto['status'], createdAt: now, updatedAt: now, contacts: [],
    },
    {
      id: 'client_2', name: 'Initech', company: 'Initech SA', email: 'hello@initech.demo',
      phone: null, address: 'Lyon, France', notes: null,
      status: 'ACTIVE' as ClientDto['status'], createdAt: now, updatedAt: now, contacts: [],
    },
  ];
}

/* ---------- Skills ---------- */
function seedSkills(): SkillDto[] {
  const now = iso(new Date());
  const mk = (id: string, name: string, category: string, color: string): SkillDto => ({
    id, name, description: null, color, category, createdAt: now, updatedAt: now,
  });
  return [
    mk('skill_1', 'React', 'Frontend', '#61dafb'),
    mk('skill_2', 'TypeScript', 'Languages', '#3178c6'),
    mk('skill_3', 'NestJS', 'Backend', '#e0234e'),
    mk('skill_4', 'PostgreSQL', 'Databases', '#336791'),
    mk('skill_5', 'UX Design', 'Design', '#ff7262'),
    mk('skill_6', 'DevOps', 'DevOps', '#2496ed'),
  ];
}

/* ---------- Équipes ---------- */
/** Convention de membres (résolue par le compute des KPI équipe). */
export const DEMO_TEAM_MEMBERS: Record<string, string[]> = {
  team_delivery: [ME_ID, 'user_2', 'user_4', 'user_6', 'user_8'],
  team_design: ['user_3', 'user_5', 'user_7', 'user_9', 'user_10'],
};
function seedTeams(): TeamDto[] {
  return [
    {
      id: 'team_delivery', name: 'Delivery', displayName: null,
      description: 'Intégration & backend', color: '#3b82f6', source: 'LOCAL',
      externalId: null, memberCount: DEMO_TEAM_MEMBERS.team_delivery.length,
    },
    {
      id: 'team_design', name: 'Design & Produit', displayName: null,
      description: 'UX, UI et contenu', color: '#8b5cf6', source: 'LOCAL',
      externalId: null, memberCount: DEMO_TEAM_MEMBERS.team_design.length,
    },
  ];
}

/* ---------- Agents IA ---------- */
function seedAgents(): WorkspaceAgentDto[] {
  return [
    {
      id: 'agent_1', name: 'Docs Copilot', email: 'agent-docs-copilot@agents.invalid', status: 'ACTIVE', trustLevel: 'SUPERVISED',
      ownerId: ME_ID, ownerName: 'Camille Laurent', model: 'claude-sonnet-4-5', modelProvider: 'anthropic',
      capabilities: ['task:view', 'comment:create', 'attachment:manage'],
      skills: [{ skillId: 'skill_2', name: 'TypeScript', level: 4 }, { skillId: 'skill_1', name: 'React', level: 3 }],
      linkedAsOwner: true, linkedTeams: ['Delivery'],
    },
    {
      id: 'agent_2', name: 'QA Reviewer', email: 'agent-qa-reviewer@agents.invalid', status: 'ACTIVE', trustLevel: 'AUTONOMOUS',
      ownerId: ME_ID, ownerName: 'Camille Laurent', model: 'claude-opus-4', modelProvider: 'anthropic',
      capabilities: ['task:view', 'deliverables:validate'],
      skills: [{ skillId: 'skill_3', name: 'NestJS', level: 3 }],
      linkedAsOwner: true, linkedTeams: [],
    },
    {
      id: 'agent_3', name: 'Data Analyst Bot', email: 'agent-data-analyst-bot@agents.invalid', status: 'SUSPENDED', trustLevel: 'DRAFT_ONLY',
      ownerId: 'user_2', ownerName: 'Julien Meyer', model: 'claude-sonnet-4-5', modelProvider: 'anthropic',
      capabilities: ['task:view'],
      skills: [{ skillId: 'skill_4', name: 'PostgreSQL', level: 4 }],
      linkedAsOwner: false, linkedTeams: ['Delivery'],
    },
  ];
}

/* ---------- Projets ---------- */
function mkProject(
  id: string, key: string, name: string, status: ProjectStatus, extra: Partial<ProjectDto> = {},
): ProjectDto {
  return {
    id, key, name, description: null, status,
    startDate: ymd(dayOffset(-30)), dueDate: ymd(dayOffset(45)),
    createdAt: iso(dayOffset(-40)), billable: true,
    clientId: null, client: null, managers: [{ id: ME_ID, name: 'Camille Laurent' }],
    taskCounts: { total: 0, done: 0 }, agentsEnabled: false,
    ...extra,
  };
}

function seedProjects(): ProjectDto[] {
  return [
    mkProject('proj_web', 'WEB', 'Refonte du site vitrine', ProjectStatus.ACTIVE, {
      description: 'Nouveau site marketing : design, contenu, intégration et SEO.',
      clientId: 'client_1', client: { id: 'client_1', name: 'Globex', company: 'Globex Corp' },
    }),
    mkProject('proj_mob', 'MOB', 'Application mobile', ProjectStatus.ACTIVE, {
      description: 'App iOS/Android compagnon.',
      clientId: 'client_2', client: { id: 'client_2', name: 'Initech', company: 'Initech SA' },
    }),
    mkProject('proj_data', 'DATA', 'Plateforme analytique', ProjectStatus.ACTIVE, {
      description: 'Entrepôt de données + tableaux de bord.',
    }),
    mkProject('proj_srv', 'SRV', 'Migration serveurs Windows Server 2016 → 2025', ProjectStatus.ACTIVE, {
      description: 'Migration de la flotte on-prem vers WS2025 : inventaire, lab, pilote, déploiement par vagues (une tâche par serveur, un jalon par application), durcissement sécurité et décommissionnement.',
      billable: false,
      startDate: ymd(dayOffset(-14)), dueDate: ymd(dayOffset(48)),
    }),
    mkProject('proj_crm', 'CRM', 'Migration CRM', ProjectStatus.DRAFT, {
      description: 'Cadrage de la migration CRM (offre en cours).',
      billable: true,
    }),
  ];
}

/* ---------- Boards (4 colonnes / projet) ---------- */
function boardFor(projectId: string): BoardDto {
  const p = projectId.replace('proj_', '');
  const cols: BoardColumnDto[] = [
    { id: `col_${p}_todo`, boardId: `board_${p}`, name: 'À faire', order: 0, wipLimit: null, status: TaskStatus.TODO },
    { id: `col_${p}_prog`, boardId: `board_${p}`, name: 'En cours', order: 1, wipLimit: 5, status: TaskStatus.IN_PROGRESS },
    { id: `col_${p}_review`, boardId: `board_${p}`, name: 'En revue', order: 2, wipLimit: null, status: TaskStatus.IN_REVIEW },
    { id: `col_${p}_done`, boardId: `board_${p}`, name: 'Terminé', order: 3, wipLimit: null, status: TaskStatus.DONE },
  ];
  return { id: `board_${p}`, projectId, name: 'Tableau', columns: cols };
}

/* ---------- Labels ---------- */
function labelsFor(projectId: string): LabelDto[] {
  const p = projectId.replace('proj_', '');
  const defs: Array<[string, string]> = [
    ['Design', '#8b5cf6'],
    ['Frontend', '#3b82f6'],
    ['Backend', '#10b981'],
    ['Bug', '#ef4444'],
    ['Urgent', '#f59e0b'],
  ];
  return defs.map(([name, color], i) => ({ id: `label_${p}_${i}`, projectId, name, color }));
}

/* ---------- Tasks ---------- */
let taskNum = 0;
function mkTask(
  projectId: string, colKey: string, status: TaskStatus, title: string, extra: Partial<TaskDto> = {},
): TaskDto {
  taskNum += 1;
  const p = projectId.replace('proj_', '');
  const now = iso(new Date());
  return {
    id: `task_${p}_${taskNum}`,
    number: taskNum,
    projectId,
    parentTaskId: null,
    boardColumnId: `col_${p}_${colKey}`,
    title,
    description: null,
    status,
    subStatusId: null,
    holdReason: null,
    priority: TaskPriority.NORMAL,
    position: taskNum * 1000,
    estimateHours: 8,
    dueDate: null,
    startDate: null,
    endDate: null,
    progressPct: status === TaskStatus.DONE ? 100 : status === TaskStatus.IN_PROGRESS ? 45 : 0,
    isMilestone: false,
    isBug: false,
    isGroup: false,
    color: null,
    requiredSkillId: null,
    requiredSkillLevel: null,
    createdById: ME_ID,
    createdAt: now,
    updatedAt: now,
    assignees: [],
    labels: [],
    externalDependency: null,
    externalBlocked: false,
    commentCount: 0,
    attachmentCount: 0,
    ...extra,
  };
}

function assignee(u: UserDto) {
  return { userId: u.id, name: u.name, email: u.email, countryCode: u.countryCode ?? null };
}
function label(projectId: string, i: number): { id: string; name: string; color: string } {
  const l = labelsFor(projectId)[i];
  return { id: l.id, name: l.name, color: l.color };
}

function seedTasks(users: UserDto[]): TaskDto[] {
  const [me, u2, u3, u4, u5, u6, u7, u8] = users;
  const WEB = 'proj_web';
  const web: TaskDto[] = [
    mkTask(WEB, 'done', TaskStatus.DONE, 'Cadrage & arborescence', {
      assignees: [assignee(me)], labels: [label(WEB, 0)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(-12)), estimateHours: 12, commentCount: 3,
    }),
    mkTask(WEB, 'done', TaskStatus.DONE, 'Maquettes haute-fidélité', {
      assignees: [assignee(u3)], labels: [label(WEB, 0)], dueDate: ymd(dayOffset(-6)),
      estimateHours: 24, commentCount: 5, attachmentCount: 2,
    }),
    mkTask(WEB, 'done', TaskStatus.DONE, 'Charte graphique validée', {
      assignees: [assignee(u3)], labels: [label(WEB, 0)], isMilestone: true, dueDate: ymd(dayOffset(-4)),
    }),
    mkTask(WEB, 'prog', TaskStatus.IN_PROGRESS, 'Intégration page d’accueil', {
      assignees: [assignee(u2)], labels: [label(WEB, 1)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(2)), estimateHours: 16, commentCount: 2,
    }),
    mkTask(WEB, 'prog', TaskStatus.IN_PROGRESS, 'Composants réutilisables (design system)', {
      assignees: [assignee(u2), assignee(u5)], labels: [label(WEB, 1)], dueDate: ymd(dayOffset(5)),
      estimateHours: 20,
    }),
    mkTask(WEB, 'prog', TaskStatus.IN_PROGRESS, 'API contenus (CMS headless)', {
      assignees: [assignee(u4)], labels: [label(WEB, 2)], dueDate: ymd(dayOffset(4)), estimateHours: 18,
    }),
    mkTask(WEB, 'review', TaskStatus.IN_REVIEW, 'Formulaire de contact', {
      assignees: [assignee(u5)], labels: [label(WEB, 1)], dueDate: ymd(dayOffset(1)), estimateHours: 6,
      commentCount: 1,
    }),
    mkTask(WEB, 'review', TaskStatus.IN_REVIEW, 'Optimisation SEO on-page', {
      assignees: [assignee(u7)], labels: [label(WEB, 1)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(-1)), estimateHours: 10,
    }),
    mkTask(WEB, 'todo', TaskStatus.TODO, 'Page tarifs', {
      assignees: [assignee(u2)], labels: [label(WEB, 1)], dueDate: ymd(dayOffset(8)), estimateHours: 8,
    }),
    mkTask(WEB, 'todo', TaskStatus.TODO, 'Blog & articles', {
      assignees: [assignee(u7)], labels: [label(WEB, 1)], dueDate: ymd(dayOffset(12)), estimateHours: 14,
    }),
    mkTask(WEB, 'todo', TaskStatus.TODO, 'Bannière cookies & RGPD', {
      assignees: [assignee(u4)], labels: [label(WEB, 2)], priority: TaskPriority.URGENT,
      dueDate: ymd(dayOffset(3)), estimateHours: 5,
    }),
    mkTask(WEB, 'todo', TaskStatus.TODO, 'Correctif : header mobile cassé', {
      assignees: [assignee(u5)], labels: [label(WEB, 3)], isBug: true, priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(0)), estimateHours: 3,
    }),
    mkTask(WEB, 'todo', TaskStatus.TODO, 'Recette & tests cross-navigateurs', {
      assignees: [assignee(u6)], labels: [label(WEB, 4)], dueDate: ymd(dayOffset(18)), estimateHours: 12,
    }),
    mkTask(WEB, 'todo', TaskStatus.TODO, 'Mise en ligne (go-live)', {
      assignees: [assignee(me)], isMilestone: true, priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(21)), estimateHours: 4,
    }),
  ];

  const MOB = 'proj_mob';
  const mob: TaskDto[] = [
    mkTask(MOB, 'prog', TaskStatus.IN_PROGRESS, 'Écran de connexion', {
      assignees: [assignee(u6)], dueDate: ymd(dayOffset(3)), estimateHours: 10,
    }),
    mkTask(MOB, 'todo', TaskStatus.TODO, 'Notifications push', {
      assignees: [assignee(u4)], dueDate: ymd(dayOffset(9)), estimateHours: 12,
    }),
    mkTask(MOB, 'done', TaskStatus.DONE, 'Choix de la stack', {
      assignees: [assignee(me)], dueDate: ymd(dayOffset(-8)), estimateHours: 6,
    }),
  ];

  const DATA = 'proj_data';
  const data: TaskDto[] = [
    mkTask(DATA, 'prog', TaskStatus.IN_PROGRESS, 'Modèle de données', {
      assignees: [assignee(u4)], dueDate: ymd(dayOffset(6)), estimateHours: 16,
    }),
    mkTask(DATA, 'todo', TaskStatus.TODO, 'Connecteurs sources', {
      assignees: [assignee(users[8])], dueDate: ymd(dayOffset(11)), estimateHours: 20,
    }),
  ];

  const SRV = 'proj_srv';
  const srv: TaskDto[] = [
    // Phase 1 — Cadrage & inventaire
    mkTask(SRV, 'done', TaskStatus.DONE, 'Inventaire des serveurs Windows Server 2016', {
      id: 'task_srv_1', assignees: [assignee(u6)], labels: [label(SRV, 2)],
      dueDate: ymd(dayOffset(-14)), estimateHours: 16, commentCount: 2,
    }),
    mkTask(SRV, 'prog', TaskStatus.IN_PROGRESS, 'Analyse de compatibilité Windows Server 2025', {
      id: 'task_srv_2', assignees: [assignee(u2)], labels: [label(SRV, 2)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(3)), estimateHours: 24, commentCount: 1,
    }),
    mkTask(SRV, 'prog', TaskStatus.IN_PROGRESS, 'Plan de bascule et de rollback', {
      id: 'task_srv_3', assignees: [assignee(u2)], labels: [label(SRV, 2)],
      dueDate: ymd(dayOffset(5)), estimateHours: 12,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Cadrage validé', {
      id: 'task_srv_4', assignees: [assignee(me)], isMilestone: true, dueDate: ymd(dayOffset(6)),
    }),
    // Phase 2 — Préparation
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Image de référence Windows Server 2025', {
      id: 'task_srv_5', assignees: [assignee(u4)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(10)), estimateHours: 20,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Runbook de migration détaillé', {
      id: 'task_srv_6', assignees: [assignee(u2)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(12)), estimateHours: 12,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Lab prêt', {
      id: 'task_srv_7', assignees: [assignee(me)], isMilestone: true, dueDate: ymd(dayOffset(14)),
    }),
    // Phase 3 — Pilote
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migration du lot pilote (2-3 serveurs non critiques)', {
      id: 'task_srv_8', assignees: [assignee(u6)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(20)), estimateHours: 24,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Pilote validé', {
      id: 'task_srv_9', assignees: [assignee(me)], isMilestone: true, dueDate: ymd(dayOffset(24)),
    }),
    // Phase 4 — Déploiement (1 tâche / serveur, 1 jalon / application)
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migrer SRV-WEB01 — Intranet SharePoint (front web)', {
      id: 'task_srv_10', assignees: [assignee(u8)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(28)), estimateHours: 8,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migrer SRV-APP01 — Intranet SharePoint (couche appli)', {
      id: 'task_srv_11', assignees: [assignee(u8)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(29)), estimateHours: 8,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Intranet SharePoint migré', {
      id: 'task_srv_12', assignees: [assignee(me)], isMilestone: true, dueDate: ymd(dayOffset(30)),
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migrer SRV-DC01 — Active Directory (contrôleur 1)', {
      id: 'task_srv_13', assignees: [assignee(u2)], labels: [label(SRV, 4)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(33)), estimateHours: 12,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migrer SRV-DC02 — Active Directory (contrôleur 2)', {
      id: 'task_srv_14', assignees: [assignee(u2)], labels: [label(SRV, 4)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(36)), estimateHours: 12,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Active Directory migré', {
      id: 'task_srv_15', assignees: [assignee(me)], isMilestone: true, dueDate: ymd(dayOffset(37)),
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migrer SRV-SQL01 — Base SQL Server', {
      id: 'task_srv_16', assignees: [assignee(u4)], labels: [label(SRV, 4)], priority: TaskPriority.HIGH,
      dueDate: ymd(dayOffset(40)), estimateHours: 16,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Base SQL Server migrée', {
      id: 'task_srv_17', assignees: [assignee(me)], isMilestone: true, dueDate: ymd(dayOffset(41)),
    }),
    // Phase 5 — Durcissement & clôture
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Durcissement sécurité des serveurs migrés', {
      id: 'task_srv_18', assignees: [assignee(u7)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(44)), estimateHours: 20,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Décommissionnement des serveurs Windows Server 2016', {
      id: 'task_srv_19', assignees: [assignee(u4)], labels: [label(SRV, 2)], dueDate: ymd(dayOffset(46)), estimateHours: 12,
    }),
    mkTask(SRV, 'todo', TaskStatus.TODO, 'Migration terminée', {
      id: 'task_srv_20', assignees: [assignee(me)], isMilestone: true, priority: TaskPriority.HIGH, dueDate: ymd(dayOffset(48)),
    }),
  ];

  return [...web, ...mob, ...data, ...srv];
}

/* ---------- Dépendances (projet WEB) ----------
   Chaîne réaliste : cadrage → maquettes → charte → design system →
   intégration → (formulaire, SEO, pages) → recette → go-live. Donne un
   réseau PERT lisible + un chemin critique. */
function seedDependencies(): DependencyDto[] {
  const now = iso(new Date());
  const T = (n: number) => `task_web_${n}`;
  const links: Array<[number, number]> = [
    [1, 2], [2, 3], // cadrage → maquettes → charte
    [3, 5], [5, 4], // charte → design system → intégration accueil
    [6, 7], [4, 7], // API contenus + intégration → formulaire
    [4, 8], // intégration → SEO
    [4, 9], // intégration → page tarifs
    [3, 10], [3, 11], // charte → blog / bannière RGPD
    [9, 13], [10, 13], [11, 13], [12, 13], // pages + correctif → recette
    [13, 14], // recette → go-live
  ];
  const webDeps = links.map(([p, s], i) => ({
    id: `dep_${i + 1}`,
    projectId: 'proj_web',
    predecessorId: T(p),
    successorId: T(s),
    type: DependencyType.FS,
    lagDays: 0,
    createdAt: now,
  }));

  // Projet SRV : cadrage → lab → pilote → déploiement (internes puis critiques) → clôture.
  const S = (n: number) => `task_srv_${n}`;
  const srvLinks: Array<[number, number]> = [
    [1, 2], [1, 3], [2, 4], [3, 4], // inventaire → analyse/plan → cadrage validé
    [4, 5], [5, 6], [6, 7], // → image → runbook → lab prêt
    [7, 8], [8, 9], // → pilote → pilote validé
    [9, 10], [10, 11], [11, 12], // → Intranet (WEB01, APP01) → jalon Intranet
    [12, 13], [13, 14], [14, 15], // → Active Directory (DC01 → DC02) → jalon AD
    [15, 16], [16, 17], // → SQL Server → jalon SQL
    [17, 18], [18, 19], [19, 20], // → durcissement → décommissionnement → migration terminée
  ];
  const srvDeps = srvLinks.map(([p, s], i) => ({
    id: `dep_srv_${i + 1}`,
    projectId: 'proj_srv',
    predecessorId: S(p),
    successorId: S(s),
    type: DependencyType.FS,
    lagDays: 0,
    createdAt: now,
  }));

  return [...webDeps, ...srvDeps];
}

/* ---------- Time entries (semaine courante) ----------
   Chaque saisie est attribuée à l'ASSIGNÉ de la tâche (réalisme des KPI
   équipe / reports par utilisateur). On loggue sur les tâches actives. */
function seedTimeEntries(tasks: TaskDto[], users: UserDto[]): TimeEntryDto[] {
  const me = users[0];
  const usersById = new Map(users.map((u) => [u.id, u]));
  const mon = mondayThisWeek();
  const now = iso(new Date());
  const out: TimeEntryDto[] = [];
  const push = (task: TaskDto, userId: string, dayIdx: number, minutes: number) => {
    const u = usersById.get(userId);
    if (!u) return;
    out.push({
      id: `te_${out.length + 1}`, taskId: task.id, userId: u.id,
      user: { id: u.id, name: u.name, email: u.email },
      date: ymd(new Date(mon.getTime() + dayIdx * MS_DAY)),
      durationMinutes: minutes, overtimeMinutes: 0, description: null,
      createdAt: now, updatedAt: now,
    });
  };
  // Tâches actives (en cours / en revue / récemment terminées) → l'assigné loggue.
  const loggable = tasks.filter(
    (t) => t.assignees.length > 0 &&
      (t.status === TaskStatus.IN_PROGRESS || t.status === TaskStatus.IN_REVIEW || t.status === TaskStatus.DONE),
  );
  const durations = [180, 240, 120, 300, 150];
  loggable.forEach((t, i) => {
    const a = t.assignees[0];
    push(t, a.userId, i % 5, durations[i % durations.length]);
    if (i % 2 === 0) push(t, a.userId, (i + 1) % 5, durations[(i + 2) % durations.length]);
  });
  // Le visiteur (Camille) loggue aussi du temps sur sa tâche « go-live ».
  const mine = tasks.find((t) => t.assignees.some((a) => a.userId === me.id) && t.status !== TaskStatus.DONE);
  if (mine) {
    push(mine, me.id, 0, 120);
    push(mine, me.id, 2, 90);
  }
  return out;
}

/* ---------- Allocations (quelques-unes sur le projet WEB) ---------- */
function seedAllocations(tasks: TaskDto[], users: UserDto[]): AllocationDto[] {
  const now = iso(new Date());
  const out: AllocationDto[] = [];
  const webActive = tasks.filter(
    (t) => t.projectId === 'proj_web' &&
      (t.status === TaskStatus.IN_PROGRESS || t.status === TaskStatus.TODO),
  );
  webActive.slice(0, 5).forEach((t, i) => {
    const a = t.assignees[0];
    if (!a) return;
    out.push({
      id: `alloc_${i + 1}`, userId: a.userId, taskId: t.id, projectId: t.projectId,
      taskTitle: t.title, user: { id: a.userId, name: a.name, email: a.email },
      startDate: ymd(dayOffset(i)), endDate: ymd(dayOffset(i + 2)),
      hoursPerDay: 4, notes: null, createdAt: now,
    });
  });
  return out;
}

/* ---------- Commentaires ---------- */
function seedComments(tasks: TaskDto[], users: UserDto[]): CommentDto[] {
  const withComments = tasks.filter((t) => (t.commentCount ?? 0) > 0).slice(0, 4);
  const now = iso(new Date());
  const out: CommentDto[] = [];
  const bodies = [
    'On valide la direction, super travail 👍',
    'Attention au contraste sur les CTA en mode sombre.',
    'J’ai poussé une première version, retours bienvenus.',
    'Peut-on décaler l’échéance d’un jour ?',
  ];
  withComments.forEach((t, i) => {
    const author = users[(i + 1) % users.length];
    out.push({
      id: `comment_${i + 1}`, taskId: t.id,
      author: { id: author.id, name: author.name, email: author.email },
      body: bodies[i % bodies.length], createdAt: now, updatedAt: now,
    });
  });
  return out;
}

/** Construit un state seed complet et cohérent. */
export function buildSeed(): DemoState {
  taskNum = 0;
  const users = seedUsers();
  const projects = seedProjects();
  const boards = projects.map((p) => boardFor(p.id));
  const labels = projects.flatMap((p) => labelsFor(p.id));
  const tasks = seedTasks(users);
  // Recalage des compteurs de tâches par projet (taskCounts).
  for (const p of projects) {
    const own = tasks.filter((t) => t.projectId === p.id);
    p.taskCounts = { total: own.length, done: own.filter((t) => t.status === TaskStatus.DONE).length };
  }
  const timeEntries = seedTimeEntries(tasks, users);
  const allocations = seedAllocations(tasks, users);
  const comments = seedComments(tasks, users);

  return {
    version: DEMO_STATE_VERSION,
    meId: ME_ID,
    seq: 1000,
    users,
    projects,
    boards,
    tasks,
    labels,
    timeEntries,
    comments,
    allocations,
    teams: seedTeams(),
    clients: seedClients(),
    contacts: [],
    skills: seedSkills(),
    watching: [],
    agents: seedAgents(),
    dependencies: seedDependencies(),
  };
}
