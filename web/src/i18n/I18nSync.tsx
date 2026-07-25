/* ============================================================
   Vaks — Synchronisation de la langue active i18next
   ----------------------------------------------------------------
   Monté sous <AuthProvider>. Calcule la langue résolue à partir de
   l'utilisateur courant + settings org + navigateur, et la pousse à
   i18next. Source UNIQUE de la langue active (pas de double état).
   Pose aussi `document.documentElement.lang` (a11y + sélecteurs CSS).
   ============================================================ */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { resolveLanguage } from './resolveLanguage';

export function I18nSync() {
  const { i18n } = useTranslation();
  const { user, orgSettings } = useAuth();

  useEffect(() => {
    const lang = resolveLanguage({
      userPreferred: user?.preferredLanguage,
      orgDefault: orgSettings.defaultLanguage,
      orgLocale: orgSettings.locale,
      enabledLanguages: orgSettings.enabledLanguages,
    });
    if (i18n.language !== lang) i18n.changeLanguage(lang);
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [
    i18n,
    user?.preferredLanguage,
    orgSettings.defaultLanguage,
    orgSettings.locale,
    orgSettings.enabledLanguages,
  ]);

  return null;
}
