// Liste les bases tenant `<db>_<slug>` (+ la base de base) — utilitaire ops
// pour les migrations de schéma par tenant (cf. CLAUDE.md, mode pooled).
const { Client } = require('pg');

(async () => {
  const url = new URL(process.env.DATABASE_URL);
  const baseDb = url.pathname.replace(/^\//, '') || 'vakspm';
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2 ORDER BY 1`,
    [baseDb, baseDb + '\\_%'],
  );
  console.log(r.rows.map((x) => x.datname).join('\n'));
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
