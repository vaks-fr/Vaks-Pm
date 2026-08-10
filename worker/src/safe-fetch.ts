import { isIP, BlockList } from 'node:net';
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
 * TOCTOU. On la ferme avec un `Agent` undici dont le `connect.lookup` applique
 * les MÊMES prédicats et renvoie l'IP validée à la connexion.
 *
 * **Mode on-prem (opt-in, chantier nudge)** : `safeFetch(url, init, allowCidrs)`
 * peut recevoir une liste de CIDR internes approuvés (passés depuis le job
 * `agent-nudge`, eux-mêmes gatés côté API par le mode déploiement / env). Les IP
 * privées qui matchent un de ces CIDR sont alors autorisées — SAUF loopback
 * (`127/8`, `::1`) et metadata (`169.254/16`), **toujours** bloqués. Sans
 * `allowCidrs` (tous les autres appels, ex. webhooks admin), le comportement est
 * strict inchangé (default-deny).
 */

/** BlockList à partir de CIDR "X.X.X.X/XX" (v4/v6). null si vide / aucun valide. */
export function buildAllowList(cidrs?: string[] | null): BlockList | null {
  if (!cidrs || cidrs.length === 0) return null;
  const bl = new BlockList();
  let added = 0;
  for (const raw of cidrs) {
    const m = String(raw).trim().match(/^(.+)\/(\d+)$/);
    if (!m) continue;
    const addr = m[1];
    const prefix = Number(m[2]);
    const v = isIP(addr);
    if (v === 4 && prefix >= 0 && prefix <= 32) {
      bl.addSubnet(addr, prefix, 'ipv4');
      added++;
    } else if (v === 6 && prefix >= 0 && prefix <= 128) {
      bl.addSubnet(addr, prefix, 'ipv6');
      added++;
    }
  }
  return added > 0 ? bl : null;
}

/** Toujours bloqué, même dans un CIDR approuvé : loopback 127/8 + metadata 169.254/16. */
function alwaysBlockedV4(ip: string): boolean {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  const [a, b] = p;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

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

/**
 * Une IP (littérale ou résolue) est-elle interdite ? `allow` peut ré-autoriser
 * une IP privée qui matche — jamais loopback/metadata.
 */
function ipBlocked(ip: string, allow: BlockList | null): boolean {
  const v = isIP(ip);
  if (v === 4) {
    if (alwaysBlockedV4(ip)) return true;
    if (isPrivateV4(ip)) return allow && allow.check(ip, 'ipv4') ? false : true;
    return false;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1') return true;
    const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m && alwaysBlockedV4(m[1])) return true;
    if (isPrivateV6(ip)) return allow && allow.check(ip, 'ipv6') ? false : true;
    return false;
  }
  return true;
}

function isBlockedHost(host: string, allow: BlockList | null): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v = isIP(host);
  if (v === 4 || v === 6) return ipBlocked(host, allow);
  // hostname non-IP : laissé passer ici, la résolution DNS le re-valide.
  return false;
}

async function assertSafe(raw: string, allow: BlockList | null): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL invalide.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('URL doit être en http(s).');
  }
  if (isBlockedHost(u.hostname, allow)) {
    throw new Error('Cible interne/privée interdite (anti-SSRF).');
  }
  if (isIP(u.hostname) === 0) {
    let addrs: { address: string }[];
    try {
      addrs = await dnsLookup(u.hostname, { all: true });
    } catch {
      throw new Error('Hôte introuvable (DNS).');
    }
    if (addrs.length === 0 || addrs.some((a) => ipBlocked(a.address, allow))) {
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
 * Fabrique un `dns.lookup`-compatible épinglé anti-SSRF, fermé sur `allow` :
 * résout l'hôte, rejette si UNE adresse est bloquée (loopback/metadata toujours,
 * privée sauf CIDR approuvé), sinon renvoie l'adresse validée au `connect`.
 */
function makePinnedLookup(allow: BlockList | null) {
  return function pinnedLookup(
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
      if (all.some((a) => ipBlocked(a.address, allow))) {
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
  };
}

/** Dispatcher strict (default-deny) réutilisé pour tous les appels sans allowlist. */
const strictDispatcher = new Agent({ connect: { lookup: makePinnedLookup(null) } });
/** Dispatchers on-prem mis en cache par clé de CIDR (évite un Agent par appel). */
const dispatcherCache = new Map<string, Agent>();

function getDispatcher(allow: BlockList | null, key: string): Agent {
  if (!allow) return strictDispatcher;
  let d = dispatcherCache.get(key);
  if (!d) {
    d = new Agent({ connect: { lookup: makePinnedLookup(allow) } });
    dispatcherCache.set(key, d);
  }
  return d;
}

/**
 * `fetch` durci anti-SSRF : valide+résout la cible avant chaque saut et suit les
 * redirects manuellement en re-validant le `Location`. `allowCidrs` (opt-in
 * on-prem) autorise les IP privées matchant un CIDR — jamais loopback/metadata.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { maxRedirects?: number } = {},
  allowCidrs?: string[] | null,
): Promise<Response> {
  const { maxRedirects = 3, ...rest } = init;
  const allow = buildAllowList(allowCidrs);
  const dispatcher = getDispatcher(allow, (allowCidrs ?? []).slice().sort().join(','));
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafe(url, allow);
    const res = await fetch(url, {
      ...rest,
      redirect: 'manual',
      dispatcher,
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
