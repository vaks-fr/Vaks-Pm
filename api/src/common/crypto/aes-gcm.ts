import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Primitive AES-256-GCM partagée (octets bruts), factorisée pour que
 * `CryptoService` (API string historique / blobs v1) et `LocalKeyProvider`
 * (wrap/unwrap des DEK) utilisent exactement le même chiffrement.
 *
 * Format du buffer de sortie : `nonce(12) || ciphertext || tag(16)`.
 * C'est le même layout que les blobs v1 existants — d'où la compatibilité.
 */
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** Surcharge fixe (nonce + tag) ajoutée au texte chiffré. */
export const GCM_OVERHEAD = NONCE_LEN + TAG_LEN;

/** Chiffre `plaintext` sous `key` (32 bytes). Renvoie `nonce||ct||tag`. */
export function gcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

/** Déchiffre un buffer `nonce||ct||tag` sous `key`. Lève si tronqué ou tag invalide. */
export function gcmDecrypt(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < GCM_OVERHEAD) throw new Error('Payload chiffré tronqué');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
