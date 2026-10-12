/* ============================================================
   Vaks — Extraction des clés i18n depuis le code source
   ----------------------------------------------------------------
   Usage : `npm run i18n:extract` (depuis web/, = `i18next-cli extract`).
   Scanne les appels `t('ns:key')` et met à jour les fichiers EN (source de
   vérité des clés). Les clés référencées dans le code mais absentes du JSON
   EN sont AJOUTÉES ; celles retirées du code sont supprimées.
   Ne génère que l'EN — les autres langues sont traduites séparément
   (Opus 4.8 + glossaire) et vérifiées par `scripts/i18n-parity.mjs`.
   (Remplace i18next-parser, dont la chaîne broccoli → sprintf-js porte une
   advisory sans correctif amont.)
   ============================================================ */
export default {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'src/i18n/resources/{{language}}/{{namespace}}.json',
    defaultNS: 'common',
    nsSeparator: ':',
    keySeparator: '.',
    sort: true,
    removeUnusedKeys: true,
    // Le développeur écrit `t('common:save')` sans default : valeur vide.
    defaultValue: '',
  },
};
