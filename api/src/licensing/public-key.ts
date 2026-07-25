/**
 * Clé **publique** Ed25519 de l'éditeur, embarquée en dur dans l'image Docker
 * de l'API (SPEC §16.2). Sert uniquement à **vérifier** les licences signées.
 *
 * La clé **privée** correspondante ne quitte JAMAIS le coffre de l'éditeur
 * (dépôt séparé `vaks-pm-licensing`, hors de ce repo source-available).
 * Régénérer la paire invalide toutes les licences déjà émises — ne le faire
 * qu'en cas de compromission.
 *
 * Format SPKI/PEM (32 octets de clé Ed25519). On accepte qu'un attaquant
 * motivé puisse remplacer cette constante et recompiler (SPEC §16.7) — ce n'est
 * pas du DRM, c'est un contrat technique avec un client de bonne foi.
 *
 * Override possible par variable d'environnement `LICENSE_PUBLIC_KEY_PEM`
 * (utile pour un déploiement éditeur multi-clés / rotation sans rebuild).
 */
const EMBEDDED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9da1Tz/s3iA6TE2XvAieutAUKAHHumC4phMxqpGhP8k=
-----END PUBLIC KEY-----`;

export function licensePublicKeyPem(): string {
  const fromEnv = process.env.LICENSE_PUBLIC_KEY_PEM;
  if (fromEnv && fromEnv.includes('BEGIN PUBLIC KEY')) {
    // Autorise les `\n` littéraux dans l'env (Docker secret/inline).
    return fromEnv.replace(/\\n/g, '\n');
  }
  return EMBEDDED_PUBLIC_KEY_PEM;
}

/**
 * Clé publique **dédiée aux essais** (portail Netlify `site/trial.html`),
 * distincte de la clé produit ci-dessus. Objectif : la clé privée
 * correspondante peut vivre en ligne (variable d'env Netlify) pour signer les
 * essais à la volée, sans jamais exposer la clé produit — dont la fuite
 * forgerait des licences illimitées pour n'importe quel client.
 *
 * En contrepartie, tout token vérifié avec CETTE clé est plafonné à une durée
 * courte par `LicenseService` (cf. `TRIAL_KEY_MAX_DAYS`) : une fuite de la clé
 * d'essai ne permet donc jamais de forger mieux qu'un essai borné, jamais une
 * licence permanente.
 */
const EMBEDDED_TRIAL_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiee/UJLuQZSe9ffpCcxEs05TuaaJsbMjllvPkjeButQ=
-----END PUBLIC KEY-----`;

export function licenseTrialPublicKeyPem(): string {
  const fromEnv = process.env.LICENSE_TRIAL_PUBLIC_KEY_PEM;
  if (fromEnv && fromEnv.includes('BEGIN PUBLIC KEY')) {
    return fromEnv.replace(/\\n/g, '\n');
  }
  return EMBEDDED_TRIAL_PUBLIC_KEY_PEM;
}
