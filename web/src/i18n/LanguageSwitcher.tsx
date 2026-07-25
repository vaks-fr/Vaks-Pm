/* ============================================================
   Vaks — Sélecteur de langue d'interface (menu déroulant + drapeaux)
   ----------------------------------------------------------------
   Déclencheur compact (drapeau SVG + code) qui ouvre un menu listant
   les langues activées (drapeau + nom natif, actif coché). SVG inline
   (PAS d'emoji drapeau : non rendu sur Windows). Liste des langues =
   `orgSettings.enabledLanguages`. Sélection : (1) changement optimiste
   i18next, (2) persistance profil (`PUT /me/preferences/language`),
   (3) refresh user → I18nSync reconverge.
   ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { resolveLanguage } from './resolveLanguage';
import type { SupportedLanguage } from './languageFromLocale';

/** Libellé natif de chaque langue (toujours dans sa propre langue). */
const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  fr: 'Français',
  it: 'Italiano',
  de: 'Deutsch',
};

/** Code court affiché sur le déclencheur. */
const LANGUAGE_CODES: Record<SupportedLanguage, string> = {
  en: 'EN',
  fr: 'FR',
  it: 'IT',
  de: 'DE',
};

/** Drapeau SVG par langue. EN → UK (défaut org `en-GB`). 18×12, décoratif. */
function Flag({ lang }: { lang: SupportedLanguage }) {
  const common = {
    width: 18,
    height: 12,
    viewBox: '0 0 18 12',
    className: 'flag',
    'aria-hidden': true,
  } as const;
  switch (lang) {
    case 'fr':
      return (
        <svg {...common}>
          <rect width="6" height="12" x="0" fill="#0055A4" />
          <rect width="6" height="12" x="6" fill="#fff" />
          <rect width="6" height="12" x="12" fill="#EF4135" />
        </svg>
      );
    case 'it':
      return (
        <svg {...common}>
          <rect width="6" height="12" x="0" fill="#009246" />
          <rect width="6" height="12" x="6" fill="#fff" />
          <rect width="6" height="12" x="12" fill="#CE2B37" />
        </svg>
      );
    case 'de':
      return (
        <svg {...common}>
          <rect width="18" height="4" y="0" fill="#111" />
          <rect width="18" height="4" y="4" fill="#DD0000" />
          <rect width="18" height="4" y="8" fill="#FFCE00" />
        </svg>
      );
    case 'en':
    default:
      return (
        <svg {...common}>
          <rect width="18" height="12" fill="#012169" />
          <path d="M0 0L18 12M18 0L0 12" stroke="#fff" strokeWidth="2.4" />
          <path d="M9 0V12M0 6H18" stroke="#fff" strokeWidth="3.4" />
          <path d="M9 0V12M0 6H18" stroke="#C8102E" strokeWidth="1.8" />
        </svg>
      );
  }
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const { user, orgSettings, refreshUser } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const enabled = (orgSettings.enabledLanguages?.length
    ? orgSettings.enabledLanguages
    : ['en', 'fr', 'it', 'de']) as SupportedLanguage[];

  // Langue effective courante (préférence user résolue contre l'org).
  const current = resolveLanguage({
    userPreferred: user?.preferredLanguage,
    orgDefault: orgSettings.defaultLanguage,
    orgLocale: orgSettings.locale,
    enabledLanguages: orgSettings.enabledLanguages,
  });

  // Ferme au clic extérieur / Échap.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Une seule langue activée → pas de sélecteur.
  if (enabled.length < 2) return null;

  const onChange = async (lang: SupportedLanguage) => {
    setOpen(false);
    if (lang === current) return;
    i18n.changeLanguage(lang); // optimiste
    try {
      await api.setMyLanguage(lang);
      await refreshUser(); // I18nSync reconverge sur la valeur persistée
    } catch {
      // best-effort : on garde le changement optimiste si le PATCH échoue.
    }
  };

  return (
    <div className={'lang-dd' + (className ? ' ' + className : '')} ref={ref}>
      <button
        type="button"
        className="lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={LANGUAGE_LABELS[current]}
        title={LANGUAGE_LABELS[current]}
        onClick={() => setOpen((o) => !o)}
      >
        <Flag lang={current} />
        <span>{LANGUAGE_CODES[current]}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="lang-caret">
          <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="lang-menu" role="listbox">
          {enabled.map((l) => {
            const active = l === current;
            return (
              <button
                key={l}
                type="button"
                role="option"
                aria-selected={active}
                className={'lang-menu-item' + (active ? ' is-active' : '')}
                onClick={() => onChange(l)}
              >
                <Flag lang={l} />
                <span className="grow">{LANGUAGE_LABELS[l]}</span>
                {active && (
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M3 7.5L6 10.5L11 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
