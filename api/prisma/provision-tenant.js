// ============================================================================
// provision-tenant.js — provisionne la base d'UN tenant (mode pooled).
//   1. crée la base `<db>_<slug>` (si absente) sur le même serveur,
//   2. applique le schéma Prisma (db push) à cette base,
//   3. bootstrap org + rôles + admin dans cette base (réutilise bootstrap-org),
//      OU — avec `--seed <name>` — charge le jeu `seed-<name>.js` à la place
//      (ex. `--seed demo` : org démo + données, pour un tenant `demo` dont le
//      slug est réservé côté bootstrap-org).
//
// Usage (depuis le container API) :
//   export DATABASE_URL=$(cat /run/secrets/database_url)   # base de référence
//   node prisma/provision-tenant.js <slug> [adminEmail] [adminPassword]
//   node prisma/provision-tenant.js <slug> --seed demo     # jeu de démo
//
// La base du tenant suit la convention `<db_de_base>_<slug>` (slugs `-` -> `_`),
// cohérente avec TenantConnectionService.databaseUrlFor.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createPrismaClient } = require('./_client');

function tenantUrl(baseUrl, slug) {
  const u = new URL(baseUrl);
  const db = u.pathname.replace(/^\//, '') || 'vakspm';
  u.pathname = `/${db}_${slug.replace(/-/g, '_')}`;
  return u.toString();
}

async function ensureDatabase(url) {
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, '');
  const adminU = new URL(url);
  adminU.pathname = '/postgres';
  const admin = createPrismaClient(adminU.toString());
  try {
    const rows = await admin.$queryRawUnsafe(
      `SELECT 1 AS x FROM pg_database WHERE datname = '${dbName}'`,
    );
    if (!rows.length) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`✓ base créée : ${dbName}`);
    } else {
      console.log(`= base déjà présente : ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const slug = argv[0];
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    console.error('Usage: node prisma/provision-tenant.js <slug:[a-z0-9-]> [email] [password] [--seed <name>]');
    process.exit(1);
  }
  // `--seed <name>` : route vers prisma/seed-<name>.js au lieu de bootstrap-org.
  const seedIdx = argv.indexOf('--seed');
  const seedName = seedIdx !== -1 ? argv[seedIdx + 1] : null;
  if (seedIdx !== -1 && (!seedName || !/^[a-z0-9-]+$/.test(seedName))) {
    console.error('--seed requiert un nom valide (ex: --seed demo)');
    process.exit(1);
  }
  // email/password = positionnels après le slug, en excluant la paire --seed.
  const pos = argv.slice(1).filter((_, i) => {
    const realIdx = i + 1; // index dans argv
    return realIdx !== seedIdx && realIdx !== seedIdx + 1;
  });
  const adminEmail = pos[0] || `admin@${slug}.local`;
  const adminPassword = pos[1] || null;

  const base = process.env.DATABASE_URL;
  if (!base) { console.error('DATABASE_URL manquant'); process.exit(1); }
  const url = tenantUrl(base, slug);

  // 1. base
  await ensureDatabase(url);

  // 2. schéma
  console.log(`→ prisma db push sur ${slug} …`);
  execSync('npx prisma db push --accept-data-loss', {
    cwd: '/app/api',
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const database = new URL(url).pathname.slice(1);

  // 3a. Jeu de seed dédié (ex. démo) — remplace le bootstrap-org standard.
  //     Le seed crée sa propre org/admin/données ; idempotent.
  if (seedName) {
    const seedFile = path.join(__dirname, `seed-${seedName}.js`);
    if (!fs.existsSync(seedFile)) {
      console.error(`✖ seed introuvable : prisma/seed-${seedName}.js`);
      process.exit(1);
    }
    console.log(`→ seed « ${seedName} » sur ${slug} …`);
    execSync(`node prisma/seed-${seedName}.js`, {
      cwd: '/app/api',
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
    });
    console.log(JSON.stringify({ ok: true, slug, database, seed: seedName }));
    return;
  }

  // 3b. bootstrap org + admin (réutilise bootstrap-org.js)
  const cfg = {
    organization: { id: slug, name: slug, slug, timezone: 'Europe/Paris' },
    admin: { email: adminEmail, name: `${slug} Admin`, password: adminPassword },
  };
  const cfgPath = `/tmp/provision-${slug}.json`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  console.log(`→ bootstrap admin (${adminEmail}) …`);
  execSync(`node prisma/bootstrap-org.js ${cfgPath}`, {
    cwd: '/app/api',
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  console.log(JSON.stringify({ ok: true, slug, database, adminEmail }));
})().catch((e) => { console.error(e); process.exit(1); });
