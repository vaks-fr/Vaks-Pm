// Post-build step: rewrites the `@db` path alias (tsconfig `paths`) emitted by
// `nest build` into relative specifiers, so Node can resolve the generated
// Prisma client at runtime. Replaces `tsc-alias`, whose glob/watch dependency
// chain (chokidar 3 → braces) carries an advisory with no upstream fix.
//
//   @db      → dist/generated/prisma/client
//   @db/<x>  → dist/generated/prisma/<x>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const prismaDir = join(distDir, 'generated', 'prisma');

// require("@db"), from "@db", import("@db"), export ... from "@db/x"
const SPECIFIER = /(\brequire\(\s*|\bfrom\s+|\bimport\(\s*)(['"])@db(\/[^'"]*)?\2/g;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|d\.ts)$/.test(entry.name)) yield full;
  }
}

let files = 0;
for (const file of walk(distDir)) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('@db')) continue;
  const out = src.replace(SPECIFIER, (_m, head, quote, sub) => {
    const target = sub ? join(prismaDir, sub.slice(1)) : join(prismaDir, 'client');
    let rel = relative(dirname(file), target).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${head}${quote}${rel}${quote}`;
  });
  if (out !== src) {
    writeFileSync(file, out);
    files++;
  }
}
console.log(`rewrite-db-alias: rewrote @db in ${files} file(s)`);
