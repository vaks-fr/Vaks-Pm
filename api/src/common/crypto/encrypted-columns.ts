/**
 * Registre **source unique** des colonnes de secrets chiffrés at-rest par tenant
 * (via {@link TenantCryptoService}). C'est la liste que la rotation DEK
 * (`CryptoAdminService.reencryptColumns`) balaie pour re-chiffrer TOUS les
 * secrets sous la nouvelle DEK avant de purger l'ancienne.
 *
 * ⚠️ **Tout nouveau consommateur de `TenantCryptoService` qui persiste un blob
 * chiffré dans une COLONNE dédiée DOIT être ajouté ici.** Sinon la rotation DEK
 * laisse son secret wrappé sous une DEK ensuite purgée = **irrécupérable** (perte
 * de données silencieuse). Le test `crypto-admin.coverage.spec.ts` échoue si un
 * modèle du schéma portant une colonne de secret (`secretEnc`, `mfaSecret`,
 * `oidcClientSecretEnc`) manque à ce registre.
 *
 * **Exception `OrgSetting`** : les secrets d'`OrgSetting` (clés `…Enc`) ne sont
 * pas une colonne dédiée — ils sont adressés par CLÉ de setting via
 * `SECRET_SETTINGS`, donc balayés dans une branche séparée de `reencryptColumns`,
 * hors de ce registre.
 */
export interface EncryptedColumn {
  /** Nom du delegate Prisma en camelCase (ex. `ciConnector`). */
  model: string;
  /** Colonne portant le blob chiffré (Base64 nonce||ciphertext||tag). */
  column: string;
}

export const ENCRYPTED_SECRET_COLUMNS: readonly EncryptedColumn[] = [
  { model: 'user', column: 'mfaSecret' },
  { model: 'ticketingConnector', column: 'secretEnc' },
  { model: 'identityProvider', column: 'oidcClientSecretEnc' },
  // OIDC private_key_jwt (mode certificat) — 2e colonne chiffrée du même modèle.
  { model: 'identityProvider', column: 'oidcPrivateKeyEnc' },
  { model: 'agentConnector', column: 'secretEnc' },
  { model: 'fileSourceConnector', column: 'secretEnc' },
  { model: 'ciConnector', column: 'secretEnc' },
];
