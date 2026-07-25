import { createPublicKey, verify as edVerify } from 'node:crypto';

/**
 * Implémentation **minimale et sans dépendance** de PASETO `v4.public`
 * (signature détachée Ed25519) — côté serveur, **VÉRIFICATION UNIQUEMENT**
 * (SPEC §16.2). On évite une lib tierce : air-gap friendly, surface réduite,
 * pas de risque d'alg-confusion (le header est figé en dur).
 *
 * ⚠️ Aucune capacité de **signature** ici : la clé privée et le code de
 * signature vivent dans un **dépôt éditeur séparé** (`vaks-pm-licensing`, hors
 * de ce repo source-available et hors image Docker client). Ne JAMAIS
 * réintroduire `sign()` ni de clé privée dans ce repo — il est public/livré au
 * client.
 *
 * Réf : https://github.com/paseto-standard/paseto-spec — v4.public =
 *   token = "v4.public." || b64url(message || signature)
 *   signature = Ed25519(sk, PAE([header, message, footer, implicit]))
 *
 * On n'utilise ni footer ni implicit assertion (chaînes vides) — les claims
 * (issuer, expiration, …) vivent dans le message JSON et sont validés par
 * l'appelant (`LicenseService`), jamais ici : la vérif PASETO ne porte QUE sur
 * l'intégrité cryptographique.
 */

const HEADER = 'v4.public.';

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** LE64 : entier non signé sur 8 octets little-endian, bit de poids fort effacé. */
function le64(n: number): Buffer {
  const b = Buffer.alloc(8);
  let big = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  b[7] &= 0x7f; // efface le MSB (anti-ambiguïté de la spec PAE)
  return b;
}

/** Pre-Authentication Encoding (PAE) des pièces — préfixes de longueur. */
function pae(pieces: Buffer[]): Buffer {
  const parts: Buffer[] = [le64(pieces.length)];
  for (const p of pieces) {
    parts.push(le64(p.length), p);
  }
  return Buffer.concat(parts);
}

/**
 * Vérifie la signature d'un token `v4.public` avec la clé publique embarquée
 * et renvoie le payload JSON décodé. **Lève** si le header est faux, la
 * signature invalide, ou le JSON illisible. Ne valide AUCUN claim métier.
 */
export function verifyV4Public<T = unknown>(token: string, publicKeyPem: string): T {
  if (typeof token !== 'string' || !token.startsWith(HEADER)) {
    throw new Error('Format PASETO invalide (header attendu v4.public.)');
  }
  const body = b64urlDecode(token.slice(HEADER.length));
  if (body.length <= 64) {
    throw new Error('Token PASETO tronqué (signature manquante)');
  }
  const message = body.subarray(0, body.length - 64);
  const signature = body.subarray(body.length - 64);
  const m2 = pae([Buffer.from(HEADER, 'utf8'), message, Buffer.alloc(0), Buffer.alloc(0)]);
  const key = createPublicKey(publicKeyPem);
  if (!edVerify(null, m2, key, signature)) {
    throw new Error('Signature de licence invalide');
  }
  return JSON.parse(message.toString('utf8')) as T;
}
