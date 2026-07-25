/**
 * Schéma de provider encodé dans une `kekRef` (DORA workstream G — HSM/KMS).
 *
 * Une `kekRef` identifie la KEK qui a wrappé une DEK. Pour permettre plusieurs
 * sources de clés (keyring local, KMS cloud, HSM), on préfixe la ref par un
 * **schéma** : `local:v1`, `kms:<keyId>`, `hsm:<label>`.
 *
 * **Rétro-compatibilité** : les refs historiques ne sont PAS préfixées (`env`,
 * `v1`, `v2`…). Toute ref sans schéma connu est donc routée vers `local` — les
 * blobs existants restent déchiffrables sans migration.
 */
export const KEK_SCHEMES = ['local', 'kms', 'hsm', 'kmip'] as const;
export type KekScheme = (typeof KEK_SCHEMES)[number];

/** Provider propriétaire d'une `kekRef` (défaut `local` si non préfixée/inconnue). */
export function providerOfKekRef(kekRef: string): KekScheme {
  const i = kekRef.indexOf(':');
  if (i <= 0) return 'local'; // pas de schéma (env, v1…) → local (rétro-compat)
  const scheme = kekRef.slice(0, i);
  return (KEK_SCHEMES as readonly string[]).includes(scheme) ? (scheme as KekScheme) : 'local';
}
