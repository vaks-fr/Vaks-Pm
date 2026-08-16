import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest config for the API test suite.
 *
 * The only thing this adds over the defaults is resolution of the `@db`
 * tsconfig-paths alias (generated Prisma client). Most specs never trigger it
 * because they import `@db` names only in type positions, which esbuild elides.
 * A spec that exercises a service using `@db` as a *value* (e.g.
 * `Prisma.Decimal`, a `TaskStatus` enum member) needs the alias resolved at
 * runtime — hence this mapping, kept in lock-step with `api/tsconfig.json`
 * (`"@db": ["src/generated/prisma/client"]`, `"@db/*": ["src/generated/prisma/*"]`).
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@db$/, replacement: here('./src/generated/prisma/client.ts') },
      { find: /^@db\//, replacement: here('./src/generated/prisma/') },
    ],
  },
});
