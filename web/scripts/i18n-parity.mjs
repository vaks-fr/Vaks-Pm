/* ============================================================
   Vaks — Vérification de parité des traductions (porte CI)
   ----------------------------------------------------------------
   Garantit que CHAQUE clé présente en EN existe aussi en fr/it/de, avec les
   MÊMES placeholders `{{var}}`. Échoue (exit 1) sinon — bloque l'envoi de
   traductions incomplètes ou de placeholders divergents.
   Usage : `node scripts/i18n-parity.mjs` (depuis web/).
   ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'resources');
const LANGS = ['en', 'fr', 'it', 'de'];
const REF = 'en';

/** Aplatit un objet imbriqué en clés "a.b.c". */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

function placeholders(s) {
  return [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

function load(lang) {
  const dir = join(ROOT, lang);
  const merged = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('_old'))) {
    const ns = file.replace(/\.json$/, '');
    const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    merged[ns] = flatten(json);
  }
  return merged;
}

const ref = load(REF);
let errors = 0;

for (const lang of LANGS.filter((l) => l !== REF)) {
  const cur = load(lang);
  for (const ns of Object.keys(ref)) {
    const refKeys = ref[ns] || {};
    const curKeys = cur[ns] || {};
    for (const key of Object.keys(refKeys)) {
      if (!(key in curKeys)) {
        console.error(`[${lang}] clé manquante : ${ns}:${key}`);
        errors++;
        continue;
      }
      const a = placeholders(refKeys[key]);
      const b = placeholders(curKeys[key]);
      if (a.join('|') !== b.join('|')) {
        console.error(`[${lang}] placeholders divergents pour ${ns}:${key} — en=${a} ${lang}=${b}`);
        errors++;
      }
    }
  }
}

if (errors) {
  console.error(`\n✗ ${errors} problème(s) de parité i18n.`);
  process.exit(1);
}
console.log('✓ Parité i18n OK (en/fr/it/de alignés).');
