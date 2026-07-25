// Prisma 7 — configuration CLI. En v7, le chargement automatique de .env est
// supprimé : on le réintroduit via `dotenv/config` pour le dev local.
//
// L'URL de connexion (Migrate / `db push`) vit ici (plus dans le schéma, où
// `url` n'est plus supporté). On la lit via `process.env` plutôt que le helper
// `env()` de prisma/config, qui est *eager* et planterait `prisma generate` au
// build (DATABASE_URL absent). Le bloc `datasource` n'est ajouté que si l'URL
// est présente → `generate` (build, sans DB) passe, `db push` (runtime, URL
// exportée dans l'env — cf. docker-stack.yml & provision-tenant.js) l'utilise.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(url ? { datasource: { url } } : {}),
});
