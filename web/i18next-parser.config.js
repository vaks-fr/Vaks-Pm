/* ============================================================
   Vaks — Extraction des clés i18n depuis le code source
   ----------------------------------------------------------------
   Usage : `npx i18next-parser` (depuis web/). Scanne les appels `t('ns:key')`
   et met à jour les fichiers EN (source de vérité des clés). Les clés
   référencées dans le code mais absentes du JSON EN sont AJOUTÉES ; celles
   retirées du code sont déplacées dans `*_old.json` (à nettoyer).
   Ne génère que l'EN — les autres langues sont traduites séparément
   (Opus 4.8 + glossaire) et vérifiées par `scripts/i18n-parity.mjs`.
   ============================================================ */
export default {
  input: ['src/**/*.{ts,tsx}'],
  output: 'src/i18n/resources/$LOCALE/$NAMESPACE.json',
  locales: ['en'],
  defaultNamespace: 'common',
  namespaceSeparator: ':',
  keySeparator: '.',
  sort: true,
  keepRemoved: false,
  createOldCatalogs: true,
  // Conserve l'anglais comme valeur par défaut quand la clé n'a pas encore
  // de valeur (le développeur écrit `t('common:save')` sans default).
  defaultValue: (locale, ns, key) => '',
};
