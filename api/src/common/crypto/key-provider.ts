/**
 * Abstraction de la **source des clés** (KEK) pour le chiffrement at-rest, conçue
 * pour être HSM-ready : aujourd'hui `LocalKeyProvider` (keyring monté en fichier
 * + fallback env), demain `Pkcs11KeyProvider` / `KmipKeyProvider` sans toucher
 * aux appelants. Les verbes (`generateDataKey` / `wrapDek` / `unwrapDek`) sont
 * ceux de l'envelope encryption (PKCS#11 / KMIP / AWS-KMS GenerateDataKey).
 *
 * Le provider ne voit JAMAIS de données métier : il ne manipule que des DEK
 * (Data Encryption Keys) de 32 bytes. Le chiffrement du contenu se fait en local
 * sous la DEK ; la KEK ne fait qu'envelopper la DEK.
 */

/** Référence opaque d'une version de KEK : "env", "v0", "v3", plus tard "pkcs11:slot/label". */
export type KekRef = string;

/** Une DEK enveloppée : les octets wrappés + la KEK qui les a wrappés. */
export interface WrappedDek {
  kekRef: KekRef;
  /** Octets wrappés. Local : blob AES-256-GCM. HSM : handle/blob opaque du provider. */
  wrapped: Buffer;
}

export interface KeyProvider {
  /** Génère une DEK fraîche de 32 bytes (en clair, vit uniquement en mémoire). */
  generateDataKey(): Promise<Buffer>;
  /** Enveloppe une DEK sous une KEK (défaut : la KEK active). */
  wrapDek(dek: Buffer, kekRef?: KekRef): Promise<WrappedDek>;
  /** Désenveloppe une DEK avec la KEK nommée dans `wrapped.kekRef`. */
  unwrapDek(wrapped: WrappedDek): Promise<Buffer>;
  /** KEK sous laquelle les nouvelles DEK doivent être wrappées maintenant. */
  activeKekRef(): KekRef;
  /** Vrai si une KEK de cette référence est actuellement chargeable. */
  hasKek(kekRef: KekRef): boolean;
}

/** Token d'injection NestJS pour le `KeyProvider` actif. */
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

/** Levée quand une DEK référence une KEK absente du keyring (clé rotée / non montée). */
export class UnknownKekError extends Error {
  constructor(public readonly kekRef: KekRef) {
    super(`KEK introuvable dans le keyring : « ${kekRef} »`);
    this.name = 'UnknownKekError';
  }
}
