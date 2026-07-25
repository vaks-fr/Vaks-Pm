import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Garde anti-SSRF autonome (le worker est un package séparé, sans accès à
 * `api/src/common/url-guard.ts`). Même logique : refuse les hôtes/IP internes,
 * résout le DNS, et suit les redirects manuellement en re-validant chaque saut.
 * Indispensable côté worker : c'est lui qui POST réellement les webhooks vers
 * des URLs choisies par le tenant.
 */

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local / metadata cloud
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true;
  if (x.startsWith('fe80')) return true;
  if (x.startsWith('fc') || x.startsWith('fd')) return true;
  const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateV4(m[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

function isBlockedHost(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v = isIP(host);
  if (v === 4) return isPrivateV4(host);
  if (v === 6) return isPrivateV6(host);
  return false;
}

async function assertSafe(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL invalide.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('URL doit être en http(s).');
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error('Cible interne/privée interdite (anti-SSRF).');
  }
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
 * `fetch` durci anti-SSRF : valide+résout la cible avant chaque saut et suit les
 * redirects manuellement en re-validant le `Location`.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const { maxRedirects = 3, ...rest } = init;
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafe(url);
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
