import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Garde anti-SSRF partagée — refuse les hôtes loopback / privés / link-local /
 * internes. Même logique que `WebhooksService.isBlockedHost` (extraite ici pour
 * réutilisation par les connecteurs externes de ticketing). Ne fait PAS de
 * résolution DNS : la frontière réseau Swarm + l'allowlist de domaine couvrent
 * le reste.
 */

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = p;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true;
  if (x.startsWith('fe80')) return true; // link-local
  if (x.startsWith('fc') || x.startsWith('fd')) return true; // ULA fc00::/7
  const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (m) return isPrivateV4(m[1]);
  return false;
}

/** Vrai si l'hôte est loopback / privé / link-local / interne (SSRF). */
export function isBlockedHost(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v = isIP(host);
  if (v === 4) return isPrivateV4(host);
  if (v === 6) return isPrivateV6(host);
  return false; // hostname non-IP : laissé passer (cf. en-tête).
}

/**
 * Valide qu'une URL est une cible externe HTTPS sûre. Jette `Error(message)` si
 * le protocole n'est pas http(s) ou si l'hôte est interne/privé. Retourne l'URL
 * parsée sinon.
 */
export function assertSafeExternalUrl(raw: string, opts: { httpsOnly?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL invalide.');
  }
  const proto = u.protocol;
  if (opts.httpsOnly ? proto !== 'https:' : proto !== 'https:' && proto !== 'http:') {
    throw new Error(opts.httpsOnly ? 'URL doit être en https.' : 'URL doit être en http(s).');
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error('Cible interne/privée interdite (anti-SSRF).');
  }
  return u;
}

/** Vrai si une IP (v4 ou v6) résolue est interne/privée/loopback/link-local. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // forme inconnue → bloque par prudence
}

/**
 * Variante DNS-aware de {@link assertSafeExternalUrl} : valide le protocole et
 * l'hôte littéral PUIS **résout le DNS** et rejette si une adresse résolue est
 * interne. Bloque le DNS-rebinding « hôte public qui résout en 169.254.169.254 ».
 * NB : une fenêtre TOCTOU théorique subsiste (re-bind entre lookup et connexion) ;
 * la frontière réseau Swarm + {@link safeFetch} (redirects manuels) la couvrent.
 */
export async function assertSafeExternalUrlResolved(
  raw: string,
  opts: { httpsOnly?: boolean } = {},
): Promise<URL> {
  const u = assertSafeExternalUrl(raw, opts);
  if (isIP(u.hostname) === 0) {
    let addrs: { address: string }[];
    try {
      addrs = await dnsLookup(u.hostname, { all: true });
    } catch {
      throw new Error('Hôte introuvable (DNS).');
    }
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      throw new Error('Cible interne/privée interdite (anti-SSRF, DNS).');
    }
  }
  return u;
}

/**
 * `fetch` durci anti-SSRF : valide+résout la cible avant CHAQUE saut, et suit
 * les redirects **manuellement** en re-validant le `Location` (un 302 vers
 * `http://169.254.169.254/…` est bloqué). À utiliser pour tout appel sortant
 * dont l'URL vient (même indirectement) d'une entrée tenant/utilisateur.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { httpsOnly?: boolean; maxRedirects?: number } = {},
): Promise<Response> {
  const { httpsOnly, maxRedirects = 3, ...rest } = init;
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeExternalUrlResolved(url, { httpsOnly });
    const res = await fetch(url, { ...rest, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new Error('Trop de redirections (anti-SSRF).');
}
