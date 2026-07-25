// ============================================================================
// bootstrap-org.js — provisionne UNE organisation de prod à partir d'un fichier
// de config (infra/org-bootstrap.json), au lieu de valeurs codées en dur.
//
// Remplace, pour la prod, le seed à defaults (seed-runtime.js / seed.ts).
// Crée : Organization (avec slug + domaine pour le routing SaaS), les rôles
// système, et le premier Org Admin.
//
// Usage (depuis le container API) :
//   # 1. remplir infra/org-bootstrap.json (copie de .example.json) et l'injecter :
//   #    docker cp infra/org-bootstrap.json <api-cid>:/app/api/org-bootstrap.json
//   # 2. lancer :
//   export DATABASE_URL=$(cat /run/secrets/database_url)
//   node prisma/bootstrap-org.js                      # lit ./org-bootstrap.json
//   node prisma/bootstrap-org.js /chemin/config.json  # ou un chemin explicite
//
// Garde-fous :
//   - email admin OBLIGATOIRE (aucun défaut silencieux en prod) ;
//   - slug [a-z0-9-] obligatoire ;
//   - namespace de la DÉMO réservé (refus de `demo`/`demo-it-services` et de
//     tout email/domaine en @vaks-demo.local) → impossible d'écraser la démo ;
//   - mot de passe : fourni, OU généré aléatoirement (affiché une seule fois) +
//     changement forcé au 1er login (`mustChangePassword`).
// ============================================================================
const fs = require('fs');
const crypto = require('crypto');
const { createPrismaClient } = require('./_client');
const argon2 = require('argon2');

// Namespace strictement réservé à la démo (seed-demo.js) — interdit en prod.
const RESERVED_SLUGS = new Set(['demo', 'demo-it-services']);
const RESERVED_EMAIL_DOMAIN = 'vaks-demo.local';

// Rôles système (identiques à seed-runtime.js / SYSTEM_ROLES).
const ROLES = {
  ORG_ADMIN: {
    name: 'Org Admin', scope: 'ORG',
    permissions: [
      'org:manage', 'org:settings', 'member:manage', 'role:manage',
      'project:create', 'project:view', 'project:view_all',
      'project:update', 'project:archive', 'project:delete', 'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view', 'report:view_all', 'webhook:manage',
      'client:view', 'client:manage', 'agent:manage',
    ],
  },
  PORTFOLIO_MANAGER: {
    name: 'Portfolio Manager', scope: 'ORG',
    permissions: [
      'project:create', 'project:view', 'project:view_all',
      'project:update', 'project:archive', 'project:delete', 'project:assign_managers',
      'task:view', 'task:create', 'task:update', 'task:delete',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write',
      'report:view', 'report:view_all', 'finance:view', 'finance:manage', 'client:view', 'client:manage',
    ],
  },
  GLOBAL_REPORT_VIEWER: {
    name: 'Global Report Viewer', scope: 'ORG',
    permissions: [
      'project:view', 'project:view_all', 'task:view',
      'report:view', 'report:view_all', 'finance:view', 'client:view',
    ],
  },
  TEAM_MANAGER: {
    name: 'Team Manager', scope: 'ORG',
    permissions: [
      'project:create', 'project:view', 'project:update', 'project:archive',
      'project:assign_managers', 'task:create', 'task:view', 'task:update', 'task:delete',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write', 'report:view',
    ],
  },
  ORG_MEMBER: {
    name: 'Org Member', scope: 'ORG',
    permissions: [
      'org:settings', 'project:create', 'project:view',
      'task:view', 'task:create', 'task:update',
      'comment:create', 'attachment:manage', 'time:log', 'report:view',
    ],
  },
  PROJECT_MANAGER: {
    name: 'Project Manager', scope: 'PROJECT',
    permissions: [
      'project:view', 'project:update', 'project:archive', 'project:assign_managers',
      'task:create', 'task:view', 'task:update', 'task:delete',
      'comment:create', 'attachment:manage', 'time:log', 'allocation:manage', 'timeoff:write', 'report:view',
    ],
  },
  CONTRIBUTOR: {
    name: 'Contributor', scope: 'PROJECT',
    permissions: [
      'project:view', 'task:create', 'task:view', 'task:update',
      'comment:create', 'attachment:manage', 'time:log',
    ],
  },
  VIEWER: { name: 'Viewer', scope: 'PROJECT', permissions: ['project:view', 'task:view', 'report:view'] },
  GUEST: { name: 'Guest', scope: 'PROJECT', permissions: ['project:view', 'task:view'] },
};

function fail(msg) {
  console.error(`✖ bootstrap-org: ${msg}`);
  process.exit(1);
}

function loadConfig() {
  const path = process.argv[2] || process.env.ORG_BOOTSTRAP_CONFIG || './org-bootstrap.json';
  if (!fs.existsSync(path)) {
    fail(`config introuvable: ${path}\n  → copier infra/org-bootstrap.example.json en infra/org-bootstrap.json, le remplir, puis l'injecter dans le container.`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`config JSON invalide (${path}): ${e.message}`);
  }
  return { cfg, path };
}

function validate(cfg) {
  const org = cfg.organization || {};
  const admin = cfg.admin || {};
  const errs = [];

  if (!org.id) errs.push('organization.id manquant');
  if (!org.name) errs.push('organization.name manquant');
  if (!org.slug) errs.push('organization.slug manquant (requis pour le routing par sous-domaine)');
  else if (!/^[a-z0-9-]+$/.test(org.slug)) errs.push('organization.slug doit être en [a-z0-9-]');
  if (!admin.email) errs.push('admin.email manquant (obligatoire — aucun défaut en prod)');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(admin.email)) errs.push('admin.email invalide');

  // Garde-fous anti-collision avec la démo.
  if (org.slug && RESERVED_SLUGS.has(org.slug.toLowerCase())) errs.push(`organization.slug "${org.slug}" est réservé à la démo`);
  if (org.id && RESERVED_SLUGS.has(String(org.id).toLowerCase())) errs.push(`organization.id "${org.id}" est réservé à la démo`);
  if (admin.email && admin.email.toLowerCase().endsWith(`@${RESERVED_EMAIL_DOMAIN}`)) {
    errs.push(`admin.email ne doit pas utiliser le domaine de la démo (@${RESERVED_EMAIL_DOMAIN})`);
  }
  if (org.primaryDomain && String(org.primaryDomain).toLowerCase().includes(RESERVED_EMAIL_DOMAIN)) {
    errs.push(`organization.primaryDomain ne doit pas utiliser le domaine de la démo`);
  }

  if (errs.length) fail('config invalide:\n  - ' + errs.join('\n  - '));
}

(async () => {
  const { cfg, path } = loadConfig();
  validate(cfg);

  const org = cfg.organization;
  const admin = cfg.admin;
  const timezone = org.timezone || 'Europe/Paris';

  // Mot de passe : fourni, ou généré (affiché une seule fois) + changement forcé.
  let password = admin.password;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url'); // ~16 chars
    generated = true;
  }

  const prisma = createPrismaClient();
  try {
    // Refuser de réutiliser un slug/domaine/id déjà pris par une AUTRE org.
    const clashes = await prisma.organization.findMany({
      where: {
        AND: [
          { id: { not: org.id } },
          { OR: [
            { slug: org.slug },
            ...(org.primaryDomain ? [{ primaryDomain: org.primaryDomain }] : []),
          ] },
        ],
      },
      select: { id: true, slug: true, primaryDomain: true },
    });
    if (clashes.length) {
      fail(`slug/domaine déjà utilisé par une autre organisation: ${JSON.stringify(clashes)}`);
    }

    const organization = await prisma.organization.upsert({
      where: { id: org.id },
      update: { name: org.name, slug: org.slug, primaryDomain: org.primaryDomain || null, timezone },
      create: { id: org.id, name: org.name, slug: org.slug, primaryDomain: org.primaryDomain || null, timezone },
    });

    for (const [key, def] of Object.entries(ROLES)) {
      await prisma.role.upsert({
        where: { organizationId_key: { organizationId: organization.id, key } },
        update: { name: def.name, scope: def.scope, permissions: def.permissions, isSystem: true },
        create: { organizationId: organization.id, key, name: def.name, scope: def.scope, permissions: def.permissions, isSystem: true },
      });
    }
    const adminRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: organization.id, key: 'ORG_ADMIN' },
    });

    const passwordHash = await argon2.hash(password);
    const adminUser = await prisma.user.upsert({
      where: { organizationId_email: { organizationId: organization.id, email: admin.email } },
      // The bootstrap admin is the org's only way into the admin portal, which is
      // seat-gated — always give this account a license seat, or a from-scratch
      // deploy locks itself out ("no license seat assigned").
      update: { isAdmin: true, licensed: true, mustChangePassword: generated },
      create: {
        organizationId: organization.id,
        email: admin.email,
        name: admin.name || 'Org Admin',
        passwordHash,
        isAdmin: true,
        licensed: true,
        timezone,
        mustChangePassword: generated,
      },
    });
    await prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: adminUser.id } },
      update: { roleId: adminRole.id },
      create: { organizationId: organization.id, userId: adminUser.id, roleId: adminRole.id },
    });

    // Construire l'URL de login. Priorité :
    //   1. organization.primaryDomain  (domaine custom, ex. pm.acme.com)
    //   2. <slug>.TENANCY_BASE_DOMAIN   (mode pooled multi-tenant, ex. acme.vaks-pm.com)
    //   3. fallback : note explicative si on n'a aucun des deux.
    const baseDomain = (process.env.TENANCY_BASE_DOMAIN || '').trim();
    const loginUrl = organization.primaryDomain
      ? `https://${organization.primaryDomain}`
      : (baseDomain ? `https://${organization.slug}.${baseDomain}` : null);

    console.log(JSON.stringify({
      ok: true,
      config: path,
      organization: { id: organization.id, name: organization.name, slug: organization.slug, primaryDomain: organization.primaryDomain },
      admin: { email: adminUser.email, mustChangePassword: generated },
      // ⚠️ Affiché une seule fois. Non re-récupérable.
      generatedPassword: generated ? password : '(fourni dans la config)',
      loginUrl: loginUrl || '(définir TENANCY_BASE_DOMAIN ou organization.primaryDomain pour obtenir l\'URL)',
    }, null, 2));
    if (loginUrl) {
      console.log(`\n🌐 URL de connexion : ${loginUrl}`);
      console.log(`   Identifiant      : ${adminUser.email}`);
    }
    if (generated) {
      console.log('\n⚠️  Mot de passe admin généré ci-dessus — NOTEZ-LE : il ne sera plus jamais affiché.');
      console.log('   L\'admin devra le changer au premier login (mustChangePassword).');
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
