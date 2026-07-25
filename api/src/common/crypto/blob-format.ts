/**
 * Format de blob chiffré **versionné**, base64 en sortie comme les blobs v1.
 *
 *  v1 (legacy, jamais ré-écrit) : base64(`nonce(12) || ct || tag(16)`) — chiffré
 *     directement sous la KEK `env` (clé maître historique). Détecté par ABSENCE
 *     du magic v2.
 *
 *  v2 (envelope, DEK par tenant) :
 *     magic(2)=0x76 0x32 ("v2") || refLen(1) || dekRef(ascii) || nonce(12) || ct || tag(16)
 *     `dekRef` pointe la ligne DataEncryptionKey du tenant ; la KEK qui a wrappé
 *     la DEK vit sur cette ligne (pas dans le blob) → re-wrap d'une DEK sans
 *     invalider les blobs existants.
 *
 * Le magic 2 bytes + la cohérence de longueur rendent la confusion v1/v2
 * impossible en pratique (un blob v1 commence par un octet de nonce aléatoire).
 */
export const V2_MAGIC = Buffer.from([0x76, 0x32]); // "v2"

export interface V2Parsed {
  dekRef: string;
  /** Corps chiffré sous la DEK : `nonce(12) || ct || tag(16)`. */
  body: Buffer;
}

/** Vrai si le blob base64 est au format v2 (sinon = v1 legacy). */
export function isV2(blobB64: string): boolean {
  try {
    const buf = Buffer.from(blobB64, 'base64');
    return parseV2Buffer(buf) !== null;
  } catch {
    return false;
  }
}

/** Encode un blob v2 (base64). `body` = sortie de gcmEncrypt sous la DEK. */
export function encodeV2(dekRef: string, body: Buffer): string {
  const ref = Buffer.from(dekRef, 'ascii');
  if (ref.length === 0 || ref.length > 255) {
    throw new Error('dekRef hors limites (1..255 octets)');
  }
  return Buffer.concat([V2_MAGIC, Buffer.from([ref.length]), ref, body]).toString('base64');
}

/** Parse un blob v2 base64 ; renvoie null si ce n'est pas un v2 valide (⇒ v1). */
export function decodeV2(blobB64: string): V2Parsed | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(blobB64, 'base64');
  } catch {
    return null;
  }
  return parseV2Buffer(buf);
}

function parseV2Buffer(buf: Buffer): V2Parsed | null {
  // magic(2) + refLen(1) + refLen + au moins un corps GCM (nonce 12 + tag 16).
  if (buf.length < 3) return null;
  if (buf[0] !== V2_MAGIC[0] || buf[1] !== V2_MAGIC[1]) return null;
  const refLen = buf[2];
  const bodyStart = 3 + refLen;
  // refLen plausible + corps GCM minimal (28 octets) → sinon on retombe sur v1.
  if (refLen === 0 || buf.length < bodyStart + 28) return null;
  const dekRef = buf.subarray(3, bodyStart).toString('ascii');
  const body = buf.subarray(bodyStart);
  return { dekRef, body };
}
