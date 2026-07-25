// Fabrique de PrismaClient pour les scripts Node standalone (seed, provision…).
// Prisma 7 : (1) le client est généré en TS sous src/generated/prisma puis
// compilé dans dist/ ; (2) le client Rust-free exige un driver adapter et ne
// lit plus `datasource.url` implicitement. On centralise les deux ici.
//
// Ces scripts tournent dans l'image runtime (cwd = /app/api), où le client
// compilé existe sous dist/generated/prisma/client.
const fs = require('fs');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// DORA — TLS app↔Postgres. Doit rester ALIGNÉ avec api/src/prisma/pg-adapter.ts
// (buildPgSsl) : PG_TLS=1 = chiffré ; + PG_TLS_CA = vérification anti-MITM contre
// la CA fournie (PG_TLS_MODE=verify-full défaut, ou verify-ca = chaîne sans hostname).
function buildPgSsl() {
  if (process.env.PG_TLS !== '1') return {};
  const caPath = process.env.PG_TLS_CA;
  if (!caPath) return { ssl: { rejectUnauthorized: false } };
  const ssl = { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  if ((process.env.PG_TLS_MODE || 'verify-full') === 'verify-ca') {
    ssl.checkServerIdentity = () => undefined;
  }
  return { ssl };
}

/** @param {string} [url] connectionString ; défaut = process.env.DATABASE_URL */
function createPrismaClient(url) {
  const connectionString = url || process.env.DATABASE_URL;
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, ...buildPgSsl() }) });
}

module.exports = { createPrismaClient, PrismaClient };
