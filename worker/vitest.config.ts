import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the worker test suite.
 *
 * Unlike `api/vitest.config.ts`, no tsconfig-paths alias is needed here: the
 * worker never imports the generated Prisma client (`@db`) — it talks to the
 * API purely over HTTP (`fetch`/`safeFetch`). Imports are node builtins,
 * `@vaks-pm/shared`, and third-party packages (undici, bullmq, ioredis,
 * nodemailer), all resolved by vitest's defaults.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
