import { timingSafeEqual } from 'node:crypto';

/**
 * Compare deux secrets (tokens de guard partagés : `X-Backup-Token`,
 * `X-Worker-Token`…) en temps constant, pour éviter qu'un attaquant ne
 * puisse déduire le secret octet par octet en mesurant la latence d'une
 * comparaison `!==` naïve (qui s'arrête au premier octet différent).
 *
 * `crypto.timingSafeEqual` throw une `RangeError` si les deux buffers n'ont
 * pas la même longueur — on doit donc comparer les longueurs AVANT l'appel.
 * Une longueur différente est déjà un mismatch, donc on retourne `false`
 * directement (cette fuite de longueur est acceptable : c'est la valeur du
 * secret qu'on protège, pas sa longueur).
 */
export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
