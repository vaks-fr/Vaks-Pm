import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb, LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { Agent } from 'undici';

/**
 * Garde anti-SSRF autonome (le worker est un package séparé, sans accès à
 * `api/src/common/url-guard.ts`). Même logique : refuse les hôtes/IP internes,
 * résout le DNS, et suit les redirects manuellement en re-validant chaque saut.
 * Indispensable côté worker : c'est lui qui POST réellement les webhooks vers
 * des URLs choisies par le tenant.
 *
 * Anti DNS-rebinding : `assertSafe` valide le DNS AVANT chaque saut, mais
 * `fetch` (undici) re-résout l'hôte indépendamment à la connexion — fenêtre
 * TOCTOU où un tenant qui contrôle le DNS de sa cible peut servir une IP
 * publique à la validation puis une IP privée/metadata au connect. On ferme
 * cette fenêtre avec un `Agent` undici dont le `connect.lookup` applique les
 * MÊMES prédicats et renvoie l'IP validée à la connexion — validation et
 * connexion utilisent donc la même résolution DNS. Le Host/SNI reste
 * l'hostname (undici s'en charge), on ne réécrit jamais l'URL en https://<ip>.
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

type NodeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `dns.lookup`-compatible, épinglé anti-SSRF : résout l'hôte, rejette si UNE
 * des adresses (A/AAAA) est privée/bloquée (même sémantique que `assertSafe`),
 * sinon renvoie l'adresse validée à l'appelant (ici : l'`Agent` undici au
 * moment du `connect`). C'est cette résolution — pas celle d'`assertSafe` —
 * qui ferme réellement la fenêtre TOCTOU du DNS-rebinding.
 */
function pinnedLookup(
  hostname: string,
  options: LookupOneOptions | LookupAllOptions | NodeLookupCallback,
  callback?: NodeLookupCallback,
): void {
  const cb = typeof options === 'function' ? options : (callback as NodeLookupCallback);
  const opts = typeof options === 'function' ? {} : options;
  dnsLookupCb(hostname, { all: true }, (err, addresses) => {
    if (err) {
      cb(err, '');
      return;
    }
    const all = addresses as unknown as LookupAddress[];
    if (all.length === 0) {
      cb(new Error('Hôte introuvable (DNS).'), '');
      return;
    }
    if (all.some((a) => isPrivateIp(a.address))) {
      cb(new Error('Cible interne/privée interdite (anti-SSRF, DNS).'), '');
      return;
    }
    if ((opts as LookupAllOptions).all) {
      cb(null, all);
      return;
    }
    const first = all[0];
    cb(null, first.address, first.family);
  });
}

/**
 * `Agent` undici dédié : sockets connectés exclusivement via `pinnedLookup`.
 * Module-level (réutilisé/keep-alive entre requêtes) — un socket réutilisé
 * reste sur l'IP déjà validée, aucune re-résolution tant qu'il vit.
 */
const ssrfDispatcher = new Agent({ connect: { lookup: pinnedLookup } });

/**
 * `fetch` durci anti-SSRF : valide+résout la cible avant chaque saut et suit les
 * redirects manuellement en re-validant le `Location`. La connexion elle-même
 * passe par `ssrfDispatcher`, qui re-valide l'IP au `connect` — anti
 * DNS-rebinding (cf. commentaire d'en-tête).
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { maxRedirects?: number } = {},
): Promise<Response> {
  const { maxRedirects = 3, ...rest } = init;
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafe(url);
    const res = await fetch(url, {
      ...rest,
      redirect: 'manual',
      dispatcher: ssrfDispatcher,
    } as unknown as RequestInit);
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
