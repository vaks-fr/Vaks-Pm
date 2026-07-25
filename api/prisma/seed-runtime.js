// Seed compilé/standalone (sans ts-node), exécutable dans l'image runtime.
// Lit DATABASE_URL depuis l'env ; idempotent (upserts).
const { createPrismaClient } = require('./_client');
const argon2 = require('argon2');

const ROLES = {
  ORG_ADMIN: {
    name: 'Org Admin',
    scope: 'ORG',
    // Pilote l'organisation (users, rôles, équipes, settings). NE voit PAS
    // les rates / montants facturés — réservé à PORTFOLIO_MANAGER et
    // GLOBAL_REPORT_VIEWER (pas de `finance:view`).
    permissions: [
      'org:manage', 'org:settings', 'member:manage', 'role:manage',
      'project:create',
      'project:view', 'project:view_all',
      'project:update', 'project:archive', 'project:delete', 'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view', 'report:view_all', 'webhook:manage',
      'client:view', 'client:manage', 'crypto:manage', 'agent:manage',
    ],
  },
  PORTFOLIO_MANAGER: {
    name: 'Portfolio Manager',
    scope: 'ORG',
    // Rôle org-wide : portefeuille transverse. Bypass des policies de création
    // pour les projets facturables. Seul rôle (avec GLOBAL_REPORT_VIEWER) à
    // voir les rates / coûts / montants facturés (`finance:view`).
    permissions: [
      'project:create',
      'project:view', 'project:view_all',
      'project:update', 'project:archive', 'project:delete', 'project:assign_managers',
      'task:view', 'task:create', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view', 'report:view_all', 'finance:view', 'finance:manage',
      'client:view', 'client:manage',
    ],
  },
  GLOBAL_REPORT_VIEWER: {
    name: 'Global Report Viewer',
    scope: 'ORG',
    // Lecture seule transverse à des fins de reporting. Voit tout (projets,
    // tâches, rates, coûts) mais ne modifie rien.
    permissions: [
      'project:view', 'project:view_all',
      'task:view',
      'report:view', 'report:view_all', 'finance:view',
      'client:view',
    ],
  },
  TEAM_MANAGER: {
    name: 'Team Manager',
    scope: 'ORG',
    // Manager d'une (ou plusieurs) équipe(s). Peut créer un projet
    // (facturable ou non) si la policy org l'autorise. Peut basculer
    // `canCreateNonBillableProject` sur ses membres.
    permissions: [
      'project:create',
      'project:view',
      'project:update', 'project:archive', 'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view',
    ],
  },
  ORG_MEMBER: {
    name: 'Org Member',
    scope: 'ORG',
    // Membre standard. Peut créer un projet uniquement si la policy org
    // (`projectCreation.billable` ou `.nonBillable`) le permet via 'everyone',
    // ou via le mode 'teams' avec une équipe / un override utilisateur qui
    // l'autorise. Sans cette éligibilité, le POST /projects retourne 403.
    permissions: [
      'org:settings',
      'project:create',
      'project:view',
      'task:view', 'task:create', 'task:update',
      'comment:create', 'attachment:manage', 'time:log',
      'report:view',
    ],
  },
  PROJECT_MANAGER: {
    name: 'Project Manager',
    scope: 'PROJECT',
    // Doit rester identique à SYSTEM_ROLES.PROJECT_MANAGER (packages/shared).
    // `project:assign_managers` est projet-scoppé (évaluée par le guard avec
    // le projectId de la requête) : le PM ne peut éditer que les membres de
    // SON projet.
    permissions: [
      'project:view', 'project:update', 'project:archive',
      'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete', 'task:review',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view',
    ],
  },
  CONTRIBUTOR: {
    name: 'Contributor',
    scope: 'PROJECT',
    permissions: [
      'project:view', 'task:create', 'task:view', 'task:update',
      'comment:create', 'attachment:manage', 'time:log',
    ],
  },
  VIEWER: {
    name: 'Viewer',
    scope: 'PROJECT',
    permissions: ['project:view', 'task:view', 'report:view'],
  },
  GUEST: {
    name: 'Guest',
    scope: 'PROJECT',
    permissions: ['project:view', 'task:view'],
  },
};

(async () => {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@vaks-pm.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const prisma = createPrismaClient();
  try {
    const org = await prisma.organization.upsert({
      where: { id: 'seed-org' },
      update: {},
      create: { id: 'seed-org', name: 'Organisation Démo', timezone: 'Europe/Paris' },
    });

    for (const [key, def] of Object.entries(ROLES)) {
      await prisma.role.upsert({
        where: { organizationId_key: { organizationId: org.id, key } },
        update: {
          name: def.name,
          scope: def.scope,
          permissions: def.permissions,
          isSystem: true,
        },
        create: {
          organizationId: org.id,
          key,
          name: def.name,
          scope: def.scope,
          permissions: def.permissions,
          isSystem: true,
        },
      });
    }

    const adminRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: org.id, key: 'ORG_ADMIN' },
    });
    const hash = await argon2.hash(adminPassword);
    const admin = await prisma.user.upsert({
      where: { organizationId_email: { organizationId: org.id, email: adminEmail } },
      update: { passwordHash: hash, isAdmin: true, licensed: true },
      create: {
        organizationId: org.id,
        email: adminEmail,
        passwordHash: hash,
        name: 'Admin',
        isAdmin: true,
        licensed: true,
      },
    });
    await prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: admin.id } },
      update: { roleId: adminRole.id },
      create: { organizationId: org.id, userId: admin.id, roleId: adminRole.id },
    });

    console.log(JSON.stringify({ orgId: org.id, adminId: admin.id, email: admin.email }));
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
