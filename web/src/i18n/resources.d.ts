/* ============================================================
   Vaks — Clés de traduction typées (sécurité TypeScript)
   ----------------------------------------------------------------
   Augmente react-i18next pour que `t('ns:key')` soit autocomplété et
   qu'une faute de frappe sur une clé soit une ERREUR DE COMPILATION
   (`tsc --noEmit`, déjà dans `web build`). Les types sont dérivés des
   ressources ANGLAISES (source de vérité des clés).
   ============================================================ */
import 'react-i18next';
import type { resources } from './index';

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['en'];
  }
}
