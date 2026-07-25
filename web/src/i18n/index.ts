/* ============================================================
   Vaks — Runtime i18next (chargé une fois dans main.tsx)
   ----------------------------------------------------------------
   - Ressources statiques importées (bundle Vite) : en/fr/it/de × N namespaces.
   - `fallbackLng: 'en'` + `returnEmptyString: false` → une clé manquante en
     fr/it/de retombe VISIBLEMENT sur l'anglais (la QA repère le trou).
   - `saveMissing` en dev → log console des clés utilisées mais absentes.
   La langue active est pilotée par <I18nSync> (cf. resolveLanguage), pas ici.
   ============================================================ */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './languageFromLocale';

import enCommon from './resources/en/common.json';
import enAuth from './resources/en/auth.json';
import enValidation from './resources/en/validation.json';
import enTasks from './resources/en/tasks.json';
import enTimeline from './resources/en/timeline.json';
import enWorkload from './resources/en/workload.json';
import enFinances from './resources/en/finances.json';
import enReports from './resources/en/reports.json';
import enAdmin from './resources/en/admin.json';
import enTeams from './resources/en/teams.json';
import enSkills from './resources/en/skills.json';
import enSecurity from './resources/en/security.json';
import enIntegrations from './resources/en/integrations.json';
import enProjects from './resources/en/projects.json';
import enCustomFields from './resources/en/customfields.json';
import enCustomStatuses from './resources/en/customstatuses.json';

import frCommon from './resources/fr/common.json';
import frAuth from './resources/fr/auth.json';
import frValidation from './resources/fr/validation.json';
import frTasks from './resources/fr/tasks.json';
import frTimeline from './resources/fr/timeline.json';
import frWorkload from './resources/fr/workload.json';
import frFinances from './resources/fr/finances.json';
import frReports from './resources/fr/reports.json';
import frAdmin from './resources/fr/admin.json';
import frTeams from './resources/fr/teams.json';
import frSkills from './resources/fr/skills.json';
import frSecurity from './resources/fr/security.json';
import frIntegrations from './resources/fr/integrations.json';
import frProjects from './resources/fr/projects.json';
import frCustomFields from './resources/fr/customfields.json';
import frCustomStatuses from './resources/fr/customstatuses.json';

import itCommon from './resources/it/common.json';
import itAuth from './resources/it/auth.json';
import itValidation from './resources/it/validation.json';
import itTasks from './resources/it/tasks.json';
import itTimeline from './resources/it/timeline.json';
import itWorkload from './resources/it/workload.json';
import itFinances from './resources/it/finances.json';
import itReports from './resources/it/reports.json';
import itAdmin from './resources/it/admin.json';
import itTeams from './resources/it/teams.json';
import itSkills from './resources/it/skills.json';
import itSecurity from './resources/it/security.json';
import itIntegrations from './resources/it/integrations.json';
import itProjects from './resources/it/projects.json';
import itCustomFields from './resources/it/customfields.json';
import itCustomStatuses from './resources/it/customstatuses.json';

import deCommon from './resources/de/common.json';
import deAuth from './resources/de/auth.json';
import deValidation from './resources/de/validation.json';
import deTasks from './resources/de/tasks.json';
import deTimeline from './resources/de/timeline.json';
import deWorkload from './resources/de/workload.json';
import deFinances from './resources/de/finances.json';
import deReports from './resources/de/reports.json';
import deAdmin from './resources/de/admin.json';
import deTeams from './resources/de/teams.json';
import deSkills from './resources/de/skills.json';
import deSecurity from './resources/de/security.json';
import deIntegrations from './resources/de/integrations.json';
import deProjects from './resources/de/projects.json';
import deCustomFields from './resources/de/customfields.json';
import deCustomStatuses from './resources/de/customstatuses.json';

export const NAMESPACES = [
  'common',
  'auth',
  'validation',
  'tasks',
  'timeline',
  'workload',
  'finances',
  'reports',
  'admin',
  'teams',
  'skills',
  'security',
  'integrations',
  'projects',
  'customfields',
  'customstatuses',
] as const;

export const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    validation: enValidation,
    tasks: enTasks,
    timeline: enTimeline,
    workload: enWorkload,
    finances: enFinances,
    reports: enReports,
    admin: enAdmin,
    teams: enTeams,
    skills: enSkills,
    security: enSecurity,
    integrations: enIntegrations,
    projects: enProjects,
    customfields: enCustomFields,
    customstatuses: enCustomStatuses,
  },
  fr: {
    common: frCommon,
    auth: frAuth,
    validation: frValidation,
    tasks: frTasks,
    timeline: frTimeline,
    workload: frWorkload,
    finances: frFinances,
    reports: frReports,
    admin: frAdmin,
    teams: frTeams,
    skills: frSkills,
    security: frSecurity,
    integrations: frIntegrations,
    projects: frProjects,
    customfields: frCustomFields,
    customstatuses: frCustomStatuses,
  },
  it: {
    common: itCommon,
    auth: itAuth,
    validation: itValidation,
    tasks: itTasks,
    timeline: itTimeline,
    workload: itWorkload,
    finances: itFinances,
    reports: itReports,
    admin: itAdmin,
    teams: itTeams,
    skills: itSkills,
    security: itSecurity,
    integrations: itIntegrations,
    projects: itProjects,
    customfields: itCustomFields,
    customstatuses: itCustomStatuses,
  },
  de: {
    common: deCommon,
    auth: deAuth,
    validation: deValidation,
    tasks: deTasks,
    timeline: deTimeline,
    workload: deWorkload,
    finances: deFinances,
    reports: deReports,
    admin: deAdmin,
    teams: deTeams,
    skills: deSkills,
    security: deSecurity,
    integrations: deIntegrations,
    projects: deProjects,
    customfields: deCustomFields,
    customstatuses: deCustomStatuses,
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  ns: [...NAMESPACES],
  defaultNS: 'common',
  returnEmptyString: false,
  interpolation: { escapeValue: false }, // React échappe déjà.
  saveMissing: import.meta.env.DEV,
  missingKeyHandler: import.meta.env.DEV
    ? (lngs, ns, key) => {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] clé manquante : ${ns}:${key} (langue active ${lngs.join(',')})`);
      }
    : undefined,
});

export default i18n;
