/* ============================================================
   Miroir client-side de la password policy serveur
   (`api/src/auth/password-policy.service.ts`). Sert à valider en
   amont (avant l'appel API) et à afficher une checklist + un exemple
   vivant. La source de vérité reste le serveur — ceci n'est qu'un
   garde-fou UX.
   ============================================================ */
import type { PasswordPolicyDto } from '@vaks-pm/shared';

export interface PwRule {
  /** Clé i18n dans le namespace `common` sous `pwRule.*` (ex. "pwRule.uppercase"). */
  labelKey: string;
  /** Paramètres d'interpolation i18n (ex. `{ count }` pour la longueur min). */
  params?: Record<string, unknown>;
  test: (pw: string) => boolean;
}

/**
 * Règles effectives pour une policy donnée. Reproduit fidèlement la logique
 * serveur : Low = lettre+chiffre ; Medium = +min/maj ; High = +caractère spécial.
 * Les libellés sont renvoyés sous forme de clés i18n (`common:pwRule.*`) — le
 * call-site les traduit via `t()`.
 */
export function passwordRules(policy: PasswordPolicyDto): PwRule[] {
  const rules: PwRule[] = [
    {
      labelKey: 'pwRule.minLength',
      params: { count: policy.minLength },
      test: (pw) => pw.length >= policy.minLength,
    },
  ];
  const c = policy.complexity;
  if (c === 'Low') {
    rules.push({ labelKey: 'pwRule.letter', test: (pw) => /[a-zA-Z]/.test(pw) });
    rules.push({ labelKey: 'pwRule.digit', test: (pw) => /\d/.test(pw) });
  } else {
    // Medium & High
    rules.push({ labelKey: 'pwRule.lowercase', test: (pw) => /[a-z]/.test(pw) });
    rules.push({ labelKey: 'pwRule.uppercase', test: (pw) => /[A-Z]/.test(pw) });
    rules.push({ labelKey: 'pwRule.digit', test: (pw) => /\d/.test(pw) });
    if (c === 'High') {
      rules.push({
        labelKey: 'pwRule.special',
        test: (pw) => /[^A-Za-z0-9]/.test(pw),
      });
    }
  }
  return rules;
}

/** Renvoie les règles non satisfaites (vide = valide). Le call-site traduit `labelKey`. */
export function validatePassword(pw: string, policy: PasswordPolicyDto): PwRule[] {
  return passwordRules(policy).filter((r) => !r.test(pw));
}

/** Validation d'email simple (mêmes contraintes que le backend). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Construit un exemple de mot de passe **valide** selon la policy courante —
 * pour l'aperçu vivant. Déterministe (pas de hasard) afin de ne pas changer
 * à chaque frappe.
 */
export function examplePassword(policy: PasswordPolicyDto): string {
  // Brique de base couvrant min/maj/chiffre/spécial.
  let base = 'Sunrise';
  const c = policy.complexity;
  if (c !== 'Low') base = 'Sunrise'; // contient min + maj
  let pw = base;
  // Garantit chiffre.
  pw += '7';
  // Garantit spécial si High.
  if (c === 'High') pw += '$';
  // Complète jusqu'à la longueur min en répétant un motif neutre.
  const filler = 'breeze';
  let i = 0;
  while (pw.length < policy.minLength) {
    pw += filler[i % filler.length];
    i++;
  }
  return pw;
}
