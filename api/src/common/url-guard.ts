import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Garde anti-SSRF — implémentation UNIQUE côté API (WebhooksService délègue
 * ici ; `worker/src/safe-fetch.ts` en est la copie pour le package worker).
 * Refuse les hôtes loopback / privés / link-local / internes. Ne fait PAS de
 * résolution DNS dans `isBlockedHost` (voir `assertSafeExternalUrlResolved`).
 *
 * Pièges couverts (cf. audits 2026-08 / 2026-09) :
 *  - `new URL().hostname` renvoie un littéral IPv6 AVEC crochets (`[::1]`) →
 *    `isIP` = 0 → laissé passer comme un hostname. On strip les crochets.
 *  - `new URL()` NORMALISE l'IPv4-mapped pointée (`::ffff:127.0.0.1`) en hexa
 *    (`::ffff:7f00:1`), qui échappait à la regex décimale. On décode les deux.
 *  - `allowInternal` (mode on-prem, nudge agents) ré-autorise une IP privée
 *    matchant un CIDR approuvé — JAMAIS loopback (127/8, ::1) ni metadata
 *    (169.254/16).
 */

/** Retire les crochets d'un littéral IPv6 tel que renvoyé par `URL.hostname`. */
export function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

export function isPrivateV4(ip: string): boolean {
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

/** Toujours bloqué, même dans un CIDR approuvé : loopback 127/8 + metadata 169.254/16. */
export function alwaysBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map((n) => parseInt(n, 10));
  return a === 127 || (a === 169 && b === 254);
}

/**
 * Extrait l'IPv4 d'une adresse IPv6 IPv4-mapped (`::ffff:x`), en forme pointée
 * (`::ffff:127.0.0.1`) ou hexa (compressée `::ffff:7f00:1` ou non). `null` si
 * ce n'est pas une IPv4-mapped.
 */
export function ipv4Mapped(ip6: string): string | null {
  const x = ip6.toLowerCase().trim();
  const dotted = x.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  if (!x.includes('ffff')) return null;
  const halves = x.split('::');
  if (halves.length > 2) return null;
  const headParts = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let hextets: string[];
  if (halves.length === 2) {
    const fill = 8 - headParts.length - tail.length;
    if (fill < 0) return null;
    hextets = [...headParts, ...Array(fill).fill('0'), ...tail];
  } else {
    hextets = headParts;
  }
  if (hextets.length !== 8) return null;
  const h = hextets.map((v) => parseInt(v || '0', 16));
  if (h.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  if (h[0] || h[1] || h[2] || h[3] || h[4] || h[5] !== 0xffff) return null;
  return `${(h[6] >> 8) & 255}.${h[6] & 255}.${(h[7] >> 8) & 255}.${h[7] & 255}`;
}

export function isPrivateV6(ip: string): boolean {
  const x = stripBrackets(ip.toLowerCase());
  if (x === '::1' || x === '::') return true;
  if (x.startsWith('fe80')) return true; // link-local
  if (x.startsWith('fc') || x.startsWith('fd')) return true; // ULA fc00::/7
  const mapped = ipv4Mapped(x); // IPv4-mapped (pointée OU hexa)
  if (mapped !== null) return isPrivateV4(mapped);
  return false;
}

/**
 * Une IP littérale (v4/v6, crochets tolérés) est-elle interdite ?
 * `allowInternal` ré-autorise les privées matchantes — jamais loopback/metadata.
 * Forme non reconnue → bloquée par prudence.
 */
export function ipBlocked(ipRaw: string, allowInternal: BlockList | null = null): boolean {
  const ip = stripBrackets(ipRaw);
  const v = isIP(ip);
  if (v === 4) {
    if (alwaysBlockedV4(ip)) return true;
    if (isPrivateV4(ip)) return allowInternal && allowInternal.check(ip, 'ipv4') ? false : true;
    return false;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    const mapped = ipv4Mapped(x);
    if (mapped !== null) return ipBlocked(mapped, allowInternal);
    if (isPrivateV6(x)) return allowInternal && allowInternal.check(x, 'ipv6') ? false : true;
    return false;
  }
  return true;
}

/**
 * Vrai si l'hôte est loopback / privé / link-local / interne (SSRF). Accepte le
 * `hostname` brut de `new URL()` (crochets IPv6 inclus). Hostname non-IP :
 * laissé passer (la variante `Resolved` le re-valide après DNS).
 */
export function isBlockedHost(hostRaw: string, allowInternal: BlockList | null = null): boolean {
  if (!hostRaw) return true;
  const host = stripBrackets(hostRaw.toLowerCase());
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v = isIP(host);
  if (v === 4 || v === 6) return ipBlocked(host, allowInternal);
  return false;
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
  return ipBlocked(ip, null);
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
  if (isIP(stripBrackets(u.hostname)) === 0) {
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
