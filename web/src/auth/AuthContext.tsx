import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, getRefreshToken, setTokens } from '../api/client';
import type { AuthTokens, UserDto, LicenseStatusDto, LicenseFeature } from '@vaks-pm/shared';
import { DEMO } from '../demo/config';

/** Settings org-scopés lisibles par tout user authentifié (UI uniquement). */
export interface PublicOrgSettings {
  /** Locale BCP47 de formatage dates/nombres (ex. "fr-FR"). Axe distinct de la langue d'UI. */
  locale: string;
  /** Langue d'interface par défaut de l'org ('en'|'fr'|'it'|'de'). */
  defaultLanguage: string;
  /** Langues d'interface activées (options du sélecteur de langue). */
  enabledLanguages: string[];
  weekStart: 'monday' | 'sunday';
  hoursPerDay: number;
  /** Plafond du niveau de skill (1..N). Défaut 10. */
  skillsMaxLevel: number;
  /** Grille de référence configurée par l'admin : `[{ level, label }]` triée
   *  par level croissant. Vide → l'UI tombe sur les nombres bruts. */
  skillsLevelScale: Array<{ level: number; label: string }>;
  /** Mode de saisie du niveau de skill : `'number'` (stepper 1..N) ou
   *  `'scale'` (dropdown des libellés). Fallback silencieux sur `'number'`
   *  côté UI si la grille est vide. */
  skillsLevelInputMode: 'number' | 'scale';
  /** Mois de début d'exercice fiscal (1 = janvier … 12 = décembre). Défaut 1.
   *  Sert aux filtres période (trimestre / exercice) des panneaux projets/finance. */
  fiscalYearStartMonth: number;
}

const SUPPORTED_LANGUAGES = ['en', 'fr', 'it', 'de'];

const DEFAULT_PUBLIC_SETTINGS: PublicOrgSettings = {
  locale: 'en-GB',
  defaultLanguage: 'en',
  enabledLanguages: [...SUPPORTED_LANGUAGES],
  weekStart: 'monday',
  hoursPerDay: 8,
  skillsMaxLevel: 10,
  skillsLevelScale: [],
  skillsLevelInputMode: 'number',
  fiscalYearStartMonth: 1,
};

/**
 * Renvoie le libellé du palier le plus proche ≤ `level` dans la grille
 * configurée par l'admin. Retourne `null` si la grille est vide ou si aucun
 * palier ne couvre ce niveau (level < palier le plus bas). L'UI tombe alors
 * sur le nombre brut.
 */
export function labelForLevel(
  level: number,
  scale: Array<{ level: number; label: string }>,
): string | null {
  if (!Number.isFinite(level) || level < 1 || !Array.isArray(scale) || scale.length === 0) {
    return null;
  }
  // scale est triée croissante côté backend ; on prend le plus grand palier ≤ level.
  let match: string | null = null;
  for (const row of scale) {
    if (row.level <= level) match = row.label;
    else break;
  }
  return match;
}

/** Résultat de `login()` côté UI :
 *   - success : auth complète, tokens posés.
 *   - mfa : l'user a MFA activé, doit fournir un code TOTP.
 *   - enroll : l'org force MFA et l'user n'a pas encore enrollé — l'UI doit
 *     afficher le QR (récupéré via `mfaForcedEnrollStart`). */
export type LoginOutcome =
  | { kind: 'success' }
  | { kind: 'mfa'; challengeToken: string }
  | { kind: 'enroll'; enrollToken: string; email: string };

interface AuthState {
  user: UserDto | null;
  email: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  completeMfaLogin: (challengeToken: string, code: string) => Promise<void>;
  /** Termine l'enrôlement forcé : pose les tokens définitifs après vérif TOTP. */
  completeForcedEnrollment: (enrollToken: string, code: string) => Promise<void>;
  /** Finalise une session à partir de tokens déjà émis (callback SSO). */
  loginWithTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  /** Recharge `me` (utile après enrôlement MFA pour rafraîchir mfaEnabled). */
  refreshUser: () => Promise<void>;
  logout: () => void;
  /** True if user has the given permission (admin → always true). */
  can: (perm: string) => boolean;
  /** Convenience flags. */
  isAdmin: boolean;
  /** "Global project administrator" — can view every project in the org. */
  isProjectAdmin: boolean;
  /** Has PROJECT_MANAGER role on at least one project. */
  managesAnyProject: boolean;
  /** Team lead of at least one team (or admin) — can manage time off. */
  isTeamLead: boolean;
  /** Settings org public (locale, weekStart, hoursPerDay). Jamais null. */
  orgSettings: PublicOrgSettings;
  /** Force le rafraîchissement des settings (après save admin par ex). */
  refreshOrgSettings: () => Promise<void>;
  /** État de la licence du tenant (open-core). Null tant que pas chargé. */
  license: LicenseStatusDto | null;
  /** True si la feature premium est active (licence valide/grace). */
  hasFeature: (feature: LicenseFeature) => boolean;
  /** Recharge l'état de licence (après upload admin). */
  refreshLicense: () => Promise<void>;
}

const NO_LICENSE: LicenseStatusDto = {
  status: 'none',
  features: [],
  customer: null,
  issuedAt: null,
  expiresAt: null,
  daysRemaining: null,
  maxUsers: null,
  notes: null,
  signatureValid: false,
  requireOnline: false,
  organizationId: null,
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgSettings, setOrgSettings] = useState<PublicOrgSettings>(DEFAULT_PUBLIC_SETTINGS);
  const [license, setLicense] = useState<LicenseStatusDto | null>(null);

  const fetchLicense = async () => {
    try {
      setLicense(await api.getLicense());
    } catch {
      // Pas bloquant : on retombe sur « pas de licence » (core only).
      setLicense(NO_LICENSE);
    }
  };

  const fetchOrgSettings = async () => {
    try {
      const s = await api.getPublicSettings();
      setOrgSettings({
        locale: s.locale,
        defaultLanguage:
          typeof s.defaultLanguage === 'string' && SUPPORTED_LANGUAGES.includes(s.defaultLanguage)
            ? s.defaultLanguage
            : 'en',
        enabledLanguages: Array.isArray(s.enabledLanguages)
          ? s.enabledLanguages.filter((l) => SUPPORTED_LANGUAGES.includes(l))
          : [...SUPPORTED_LANGUAGES],
        weekStart: s.weekStart === 'sunday' ? 'sunday' : 'monday',
        hoursPerDay: Number.isFinite(s.hoursPerDay) && s.hoursPerDay > 0 ? s.hoursPerDay : 8,
        skillsMaxLevel:
          typeof s.skillsMaxLevel === 'number' && s.skillsMaxLevel >= 1 && s.skillsMaxLevel <= 100
            ? s.skillsMaxLevel
            : 10,
        skillsLevelScale: Array.isArray(s.skillsLevelScale)
          ? s.skillsLevelScale
              .filter(
                (r): r is { level: number; label: string } =>
                  !!r &&
                  typeof r === 'object' &&
                  Number.isFinite((r as { level: number }).level) &&
                  typeof (r as { label: string }).label === 'string' &&
                  (r as { label: string }).label.trim().length > 0,
              )
              .map((r) => ({ level: Math.floor(r.level), label: r.label.trim() }))
              .sort((a, b) => a.level - b.level)
          : [],
        skillsLevelInputMode: s.skillsLevelInputMode === 'scale' ? 'scale' : 'number',
        fiscalYearStartMonth:
          typeof s.fiscalYearStartMonth === 'number' &&
          s.fiscalYearStartMonth >= 1 &&
          s.fiscalYearStartMonth <= 12
            ? Math.floor(s.fiscalYearStartMonth)
            : 1,
      });
    } catch {
      // garder les defaults — l'UI doit rester utilisable.
    }
  };

  useEffect(() => {
    // Démo statique : auto-session au boot (jamais d'écran de login). Les tokens
    // sont factices — le faux backend les accepte et résout `me()`/settings.
    const access = DEMO ? 'demo-access-token' : localStorage.getItem('accessToken');
    const refresh = DEMO ? 'demo-refresh-token' : localStorage.getItem('refreshToken');
    if (access || refresh) {
      setTokens(access, refresh);
      api
        .me()
        .then((u) => {
          setUser(u);
          return Promise.all([fetchOrgSettings(), fetchLicense()]);
        })
        .catch(() => setTokens(null, null))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const finalizeWithTokens = async (tokens: AuthTokens) => {
    setTokens(tokens.accessToken, tokens.refreshToken);
    const u = await api.me();
    setUser(u);
    await Promise.all([fetchOrgSettings(), fetchLicense()]);
  };

  const login = async (email: string, password: string): Promise<LoginOutcome> => {
    const res = await api.login({ email, password });
    if ('mfaEnrollmentRequired' in res) {
      return { kind: 'enroll', enrollToken: res.enrollToken, email: res.email };
    }
    if ('mfaRequired' in res) {
      return { kind: 'mfa', challengeToken: res.challengeToken };
    }
    await finalizeWithTokens(res);
    return { kind: 'success' };
  };

  const completeMfaLogin = async (challengeToken: string, code: string) => {
    const tokens = await api.loginMfa({ challengeToken, code });
    await finalizeWithTokens(tokens);
  };

  const completeForcedEnrollment = async (enrollToken: string, code: string) => {
    const tokens = await api.mfaForcedEnrollVerify(enrollToken, code);
    await finalizeWithTokens(tokens);
  };

  const loginWithTokens = async (accessToken: string, refreshToken: string) => {
    await finalizeWithTokens({ accessToken, refreshToken });
  };

  const refreshUser = async () => {
    try {
      const u = await api.me();
      setUser(u);
    } catch {
      // ignore — handleUnauthorized aura déjà déclenché si 401.
    }
  };

  const logout = () => {
    const refresh = getRefreshToken();
    if (refresh) {
      // Best-effort : révoque la session côté backend. On ne bloque pas le
      // logout UI sur le succès de cet appel.
      api.logout(refresh).catch(() => { /* ignore */ });
    }
    setTokens(null, null);
    setUser(null);
    setOrgSettings(DEFAULT_PUBLIC_SETTINGS);
    setLicense(null);
  };

  const perms = user?.permissions ?? [];
  const isAdmin = !!user?.isAdmin;
  const can = (p: string) => isAdmin || perms.includes('*') || perms.includes(p);
  const isProjectAdmin = isAdmin || can('project:view_all');
  const managesAnyProject = !!user?.managesAnyProject;
  const isTeamLead = isAdmin || !!user?.isTeamLead;
  const hasFeature = (feature: LicenseFeature) => !!license?.features.includes(feature);

  return (
    <AuthContext.Provider
      value={{
        user,
        email: user?.email ?? null,
        isAuthenticated: !!user,
        loading,
        login,
        completeMfaLogin,
        completeForcedEnrollment,
        loginWithTokens,
        refreshUser,
        logout,
        can,
        isAdmin,
        isProjectAdmin,
        managesAnyProject,
        isTeamLead,
        orgSettings,
        refreshOrgSettings: fetchOrgSettings,
        license,
        hasFeature,
        refreshLicense: fetchLicense,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
