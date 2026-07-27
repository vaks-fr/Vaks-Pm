#!/usr/bin/env node
// ============================================================================
// generate.mjs — manifeste de cluster (JSON) → artefacts de déploiement.
//
// Usage :
//   node infra/cluster/generate.mjs [--check] [--out <dir>] [manifest.json]
//     --check        valide les invariants et sort (n'écrit rien)
//     --out <dir>    répertoire de sortie (défaut: out/)
//     manifest       défaut: infra/cluster.json
//
// Produit dans <out>/ :
//   docker-stack.gen.yml      stack Swarm (placement par labels + controlplane
//                             + pool data-plane + une cellule par tenant dédié)
//   traefik-dynamic.gen.yml   routers (auth→controlplane, cellules par Host, pool)
//   labels.sh                 node labels Swarm (vaks.cp/app/tenant.*)
//   secrets.md                mémo des `docker secret` à créer
//   host-<name>.sh            script autonome par host (tier DB selon rôles)
//   deploy-ssh.sh             orchestrateur SSH (exécute tout dans l'ordre)
//
// Node stdlib uniquement (pas de dépendance). Le manifeste est du JSON pour
// éviter un parseur YAML.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- args ----------
const argv = process.argv.slice(2);
let checkOnly = false;
let outDir = 'out';
let manifestPath = 'infra/cluster.json';
let selectedZone = null; // multi-DC : rend le bundle d'une seule zone
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') checkOnly = true;
  else if (a === '--out') outDir = argv[++i];
  else if (a === '--zone') selectedZone = argv[++i];
  else manifestPath = a;
}

// ---------- helpers ----------
const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/** Remplace ${VAR} par process.env.VAR (récursif sur strings d'objet). */
function resolveEnv(v) {
  if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? `\${${k}}`);
  if (Array.isArray(v)) return v.map(resolveEnv);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = resolveEnv(val);
    return o;
  }
  return v;
}

// ---------- load ----------
let raw;
try {
  raw = readFileSync(manifestPath, 'utf8');
} catch (e) {
  console.error(`ERROR: manifest not found: ${manifestPath}`);
  process.exit(1);
}
let m;
try {
  m = JSON.parse(raw);
} catch (e) {
  console.error(`ERROR: invalid JSON in ${manifestPath}: ${e.message}`);
  process.exit(1);
}
m = resolveEnv(m);

// ---------- defaults ----------
m.mode = m.mode || 'ha';
m.dbName = m.dbName || 'vakspm';
m.deploymentMode = m.deploymentMode || 'pooled';
m.baseDomain = m.baseDomain || '';
m.hosts = m.hosts || [];
m.tenants = m.tenants || [];
m.infraPlacement = m.infraPlacement || {};
m.controlPlane = m.controlPlane || {};

// ---------- images ----------
// imageSource : 'ghcr' (défaut) = tirer les images pré-buildées depuis un registre
//   (docker stack deploy récupère `<imagePrefix>-<svc>:<imageTag>`) ; 'build' =
//   builder depuis les sources sur l'hôte de déploiement (air-gapped / sans egress).
// imagePrefix/imageTag ne servent qu'en mode ghcr (surchargeables pour un miroir).
const imageSource = m.imageSource === 'build' ? 'build' : 'ghcr';
const imagePrefix = m.imagePrefix || 'ghcr.io/thomasvaxelaire-vaks/vakspm';
const imageTag = m.imageTag || 'latest';
const img = (svc) => (imageSource === 'build' ? `vaks-pm/${svc}:latest` : `${imagePrefix}-${svc}:${imageTag}`);

// ---------- encryption options ----------
// Manifeste `encryption` : { diskLuks, pgVerify, pgCaFile, pgTlsMode }.
//   diskLuks  (défaut true)  : chiffrement at-rest LUKS/Tang des volumes db (HA).
//                              false ⇒ les host-*.sh n'exécutent PAS 15-tang/18-luks.
//   pgVerify  (défaut false) : vérification stricte du certificat TLS app↔Postgres.
//                              true ⇒ monte la CA en config `pg_ca_v1` sur api/controlplane
//                              (+ cellules) et pose PG_TLS_CA/PG_TLS_MODE.
//   pgCaFile  (défaut infra/certs/pg-ca.crt) : PEM de la CA, relatif au repo.
//   pgTlsMode (verify-ca|verify-full)        : mode de vérification (défaut verify-ca).
const enc = m.encryption || {};
const encDiskLuks = enc.diskLuks !== false;
const encPgVerify = enc.pgVerify === true;
const encPgMode = enc.pgTlsMode === 'verify-full' ? 'verify-full' : 'verify-ca';

// ---------- ACME / Let's Encrypt (TLS public trusted) ----------
// tls.acme: { email, staging?, domains?: [...] }. Si présent, Traefik émet un
// vrai certificat via Let's Encrypt (challenge TLS-ALPN-01 sur le port 443) ;
// le self-signed reste le fallback (defaultCertificate). Domaines = ceux fournis
// sinon dérivés des domaines de tenants. ⚠️ le stockage acme.json est mono-writer
// → Traefik est épinglé à UN seul nœud cp quand ACME est actif (cf. bloc traefik).
const acme = (m.tls && m.tls.acme) || null;
const acmeStaging = acme ? acme.staging === true : false;
const acmeDomains = acme
  ? (Array.isArray(acme.domains) && acme.domains.length
      ? acme.domains
      : (m.tenants || []).map((t) => t.domain).filter(Boolean))
  : [];
// Nœud qui porte Traefik quand ACME est actif (stockage acme.json épinglé) :
// le 1er cp en HA, l'unique hôte en single.
const traefikNode = (m.hosts || []).find((h) => (h.roles || []).includes('cp')) || (m.hosts || [])[0];
if (acme && !acme.email) err("tls.acme.email requis (email de contact Let's Encrypt).");
if (acme && !acmeDomains.length) warn('tls.acme sans domaine : Traefik émettra un cert à la demande par Host (risque de rate-limit). Renseigner tls.acme.domains ou déclarer des tenants.');
const encPgCaFile = (enc.pgCaFile || 'infra/certs/pg-ca.crt').replace(/^\.?\//, '');
const PG_CA_TARGET = '/etc/vaks/pg-ca/ca.crt';
if (encPgVerify && !encPgCaFile.startsWith('infra/certs/')) {
  warn(`encryption.pgCaFile is outside infra/certs/ (${encPgCaFile}): deploy-ssh.sh only copies infra/certs/ to the hosts — put the CA under infra/certs/.`);
}

// ---------- multi-DC (zones) ----------
// Chaque `host.zone` désigne un datacenter. >1 zone ⇒ on génère UN bundle par
// zone (= 1 Swarm/DC). La zone `primaryZone` porte le Postgres R/W ; les autres
// zones tournent un Patroni STANDBY (réplication async depuis la primary).
const zoneOf = (h) => h.zone || null;
const allZones = [...new Set(m.hosts.map(zoneOf).filter(Boolean))];
const multiZone = allZones.length > 1;
const primaryZone = m.primaryZone || allZones[0] || null;
let isPrimaryZone = true;
let standbyPrimaryHost = null;

if (multiZone && !selectedZone) {
  // Dispatcher : ré-invoque ce script une fois par zone (--zone), puis runbook.
  const self = fileURLToPath(import.meta.url);
  for (const z of allZones) {
    const a2 = checkOnly ? ['--check'] : [];
    a2.push('--zone', z, '--out', join(outDir, z), manifestPath);
    const r = spawnSync(process.execPath, [self, ...a2], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
  if (!checkOnly) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'multidc.md'), multidcRunbook(m, allZones, primaryZone));
    console.log(`✓ multi-DC: ${allZones.length} zone(s) → ${outDir}/<zone>/ + multidc.md`);
  }
  process.exit(0);
}

if (selectedZone) {
  const full = m.hosts;
  isPrimaryZone = selectedZone === primaryZone;
  if (!isPrimaryZone) {
    const primDb = full.find((h) => zoneOf(h) === primaryZone && (h.roles || []).includes('db'));
    standbyPrimaryHost = primDb ? primDb.ip : null;
  }
  m.hosts = full.filter((h) => zoneOf(h) === selectedZone);
  // Scope infraPlacement à la zone (redis/garage sont par-DC).
  if (m.infraPlacement.redis && !m.hosts.some((h) => h.name === m.infraPlacement.redis)) delete m.infraPlacement.redis;
  if (Array.isArray(m.infraPlacement.garage)) m.infraPlacement.garage = m.infraPlacement.garage.filter((n) => m.hosts.some((h) => h.name === n));
}

const s3 = m.s3 || {};
s3.endpoint = s3.endpoint || 'garage';
s3.port = String(s3.port || 3900);
s3.region = s3.region || 'garage';
s3.accessKey = s3.accessKey || '';

// Garage : `infraPlacement.garage` accepte un host (string) OU une liste (HA).
const garageHosts = m.infraPlacement.garage == null
  ? []
  : Array.isArray(m.infraPlacement.garage)
    ? m.infraPlacement.garage
    : [m.infraPlacement.garage];
const garageMulti = garageHosts.length > 1;
// Réplication Garage : 3 nœuds → 3, 2 nœuds → 2, sinon 1 (single-node, pas HA).
const garageReplication = garageHosts.length >= 3 ? 3 : garageHosts.length === 2 ? 2 : 1;

const role = (h, r) => Array.isArray(h.roles) && h.roles.includes(r);
const hostsWith = (r) => m.hosts.filter((h) => role(h, r));
const hostByName = (n) => m.hosts.find((h) => h.name === n);

// ---------- validation ----------
if (!['single', 'ha'].includes(m.mode)) err(`invalid mode: ${m.mode} (single|ha)`);
if (!m.hosts.length) err('aucun host défini');

const names = new Set();
for (const h of m.hosts) {
  if (!h.name) err('un host sans `name`');
  if (names.has(h.name)) err(`host name dupliqué: ${h.name}`);
  names.add(h.name);
  if (!h.ip) err(`host ${h.name} sans \`ip\``);
}

if (m.mode === 'single') {
  if (m.hosts.length !== 1) warn(`mode single avec ${m.hosts.length} hosts — seul le premier est utilisé`);
} else {
  const cp = hostsWith('cp');
  const etcd = hostsWith('etcd');
  const app = hostsWith('app');
  if (cp.length < 2) err(`mode ha: control plane non-HA — il faut >=2 hosts avec le rôle "cp" (actuel: ${cp.length})`);
  for (const h of cp) if (!role(h, 'manager')) err(`cp host ${h.name} must also be a "manager" (Traefik binds host ports)`);
  if (etcd.length < 3 || etcd.length % 2 === 0) warn(`etcd: ${etcd.length} membre(s) — recommandé impair >=3 (quorum)`);
  if (!app.length) err('mode ha: aucun host avec le rôle "app" (services data)');
  if (!m.infraPlacement.redis) warn('infraPlacement.redis not set: redis is unconstrained → Swarm reschedules it on a healthy node on crash (empty volume after the move, soft state → OK; queued jobs are lost)');
  else if (!hostByName(m.infraPlacement.redis)) err(`infraPlacement.redis = "${m.infraPlacement.redis}": unknown host`);
  else warn('redis is pinned: on its host crash it stays down until the host returns (the volume — hence the BullMQ queue — is preserved). Omit infraPlacement.redis for Swarm auto-heal.');
  if (!garageHosts.length) err('infraPlacement.garage is missing');
  for (const n of garageHosts) if (!hostByName(n)) err(`infraPlacement.garage: unknown host "${n}"`);
  if (garageHosts.length === 1) warn('garage sur 1 seul host : SPOF (pas de HA du S3). Mettre une liste de >=2 hosts pour répliquer.');
  if (!m.controlPlane.vip && cp.length >= 2) warn('controlPlane.vip is absent: set up DNS round-robin over the cp hosts for a single entry point');
}

const slugs = new Set();
for (const t of m.tenants) {
  if (!/^[a-z0-9-]+$/.test(t.slug || '')) err(`invalid tenant slug: ${t.slug}`);
  if (slugs.has(t.slug)) err(`slug tenant dupliqué: ${t.slug}`);
  slugs.add(t.slug);
  if (!['pooled', 'dedicated'].includes(t.profile || 'pooled')) err(`tenant ${t.slug}: invalid profile (pooled|dedicated)`);
  if (Array.isArray(t.placement)) {
    for (const hn of t.placement) {
      const h = hostByName(hn);
      if (!h) err(`tenant ${t.slug}: unknown placement host "${hn}"`);
      else if (m.mode === 'ha' && !role(h, 'app')) err(`tenant ${t.slug}: host "${hn}" n'a pas le rôle "app"`);
    }
  }
}
if (m.deploymentMode === 'pooled' && !m.baseDomain) warn('deploymentMode pooled sans baseDomain : la résolution par Host ne marchera pas');

// ---------- report ----------
for (const w of warnings) console.error(`⚠  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✖  ${e}`);
  console.error(`\n${errors.length} error(s) — nothing generated.`);
  process.exit(1);
}
if (checkOnly) {
  console.log(`✓ manifest valid (${m.mode}, ${m.hosts.length} host(s), ${m.tenants.length} tenant(s))${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
  process.exit(0);
}

// ---------- rendering ----------
const dedicated = m.tenants.filter((t) => t.profile === 'dedicated');
const slugUnderscore = (s) => s.replace(/-/g, '_');
const ha = m.mode === 'ha';

// --- secrets command block partagé (lecture /run/secrets → env) ---
const secretExports = [
  'export JWT_ACCESS_SECRET=$$(cat /run/secrets/jwt_access_secret)',
  'export JWT_REFRESH_SECRET=$$(cat /run/secrets/jwt_refresh_secret)',
  'export DATABASE_URL=$$(cat /run/secrets/database_url)',
  'export MFA_ENCRYPTION_KEY=$$(cat /run/secrets/mfa_encryption_key)',
  'export WORKER_API_TOKEN=$$(cat /run/secrets/worker_api_token)',
  'export SSO_OIDC_CLIENT_SECRET=$$(cat /run/secrets/sso_oidc_secret)',
];
const appSecrets = ['jwt_access_secret', 'jwt_refresh_secret', 'database_url', 's3_secret_key', 'mfa_encryption_key', 'worker_api_token', 'sso_oidc_secret'];

function appEnv(extra = {}) {
  const base = {
    NODE_ENV: 'production',
    API_PORT: '"3000"',
    REDIS_URL: 'redis://redis:6379',
    S3_ENDPOINT: s3.endpoint,
    S3_PORT: `"${s3.port}"`,
    S3_ACCESS_KEY: s3.accessKey || '""',
    S3_REGION: s3.region,
    APP_URL: 'http://localhost',
    DEPLOYMENT_MODE: m.deploymentMode,
    TENANCY_BASE_DOMAIN: m.baseDomain,
    // TLS interne (DORA) : app↔PostgreSQL chiffré. Activé en HA (Patroni écoute en
    // SSL via le bootstrap). En single, PostgreSQL tourne en conteneur SANS SSL →
    // PG_TLS="1" ferait crash-looper l'api ('server does not support SSL') → "0".
    PG_TLS: ha ? '"1"' : '"0"',
    // Vérification stricte du cert serveur Postgres si encryption.pgVerify (sinon
    // chiffré-sans-vérification, défaut). La CA est montée en config (cf. pg_ca_v1).
    ...(encPgVerify ? { PG_TLS_CA: PG_CA_TARGET, PG_TLS_MODE: encPgMode } : {}),
    ...extra,
  };
  return Object.entries(base)
    .map(([k, v]) => `      ${k}: ${v}`)
    .join('\n');
}

function deployBlock({ replicas, constraint, spread, startFirst = true }) {
  const lines = ['    deploy:', `      replicas: ${replicas}`];
  if (startFirst) lines.push('      update_config: { parallelism: 1, order: start-first }');
  if (constraint || spread) {
    lines.push('      placement:');
    if (constraint) lines.push(`        constraints: [${constraint}]`);
    if (spread) lines.push(`        preferences: [{ spread: node.id }]`);
  }
  return lines.join('\n');
}

function appCommand(withDbPush) {
  // Mêmes exports de secrets dans les deux rôles ; seul le `prisma db push`
  // (réservé au data-plane qui possède le schéma) diffère.
  const exps = [...secretExports];
  const tail = withDbPush
    ? 'npx prisma db push --accept-data-loss && node dist/main.js'
    : 'node dist/main.js';
  return ['    command: >', '      sh -c "' + exps.join(' &&\n             ') + ' &&\n             ' + tail + '"'].join('\n');
}

function service(name, { env, secrets, command, deploy, configs }) {
  const parts = [`  ${name}:`, `    image: ${img('api')}`, '    environment:', env];
  if (secrets) parts.push('    secrets:\n' + secrets.map((s) => `      - ${s}`).join('\n'));
  if (configs && configs.length) parts.push('    configs:\n' + configs.map((c) => `      - source: ${c.source}\n        target: ${c.target}`).join('\n'));
  if (command) parts.push(command);
  parts.push('    networks: [vakspm]', deploy);
  return parts.join('\n');
}

// ----- services data/control -----
const cpConstraint = ha ? 'node.labels.vaks.cp == true' : null;
const appConstraint = ha ? 'node.labels.vaks.app == true' : null;
const cpReplicas = ha ? hostsWith('cp').length : 1;

const services = [];

// Montage de la CA Postgres (config Swarm) sur les services qui ouvrent une
// connexion à la base, quand la vérification stricte est demandée.
const pgCaMount = encPgVerify ? [{ source: 'pg_ca_v1', target: PG_CA_TARGET }] : undefined;

// control plane
services.push(
  service('controlplane', {
    env: appEnv({ SERVICE_ROLE: 'control-plane' }),
    secrets: appSecrets,
    command: appCommand(false),
    deploy: deployBlock({ replicas: cpReplicas, constraint: cpConstraint, spread: ha }),
    configs: pgCaMount,
  }),
);

// pool api (data-plane)
services.push(
  service('api', {
    env: appEnv({ SERVICE_ROLE: 'data-plane' }),
    secrets: appSecrets,
    command: appCommand(true),
    deploy: deployBlock({ replicas: ha ? 2 : 1, constraint: appConstraint, spread: ha }),
    configs: pgCaMount,
  }),
);

// worker
{
  const wenv = ['      NODE_ENV: production', '      REDIS_URL: redis://redis:6379', '      INTERNAL_API_URL: http://api:3000'].join('\n');
  const wcmd = ['    command: >', '      sh -c "export SMTP_PASSWORD=$$(cat /run/secrets/smtp_password) &&', '             export WORKER_API_TOKEN=$$(cat /run/secrets/worker_api_token) &&', '             node dist/main.js"'].join('\n');
  services.push(
    [
      '  worker:',
      `    image: ${img('worker')}`,
      '    environment:',
      wenv,
      '    secrets:\n      - smtp_password\n      - worker_api_token\n      - syslog_client_key',
      wcmd,
      '    networks: [vakspm]',
      deployBlock({ replicas: ha ? 2 : 1, constraint: appConstraint, spread: false, startFirst: false }),
    ].join('\n'),
  );
}

// ----- cellules (tenants dédiés) : clones pool-api routés par Host -----
for (const t of dedicated) {
  let constraint = appConstraint;
  if (Array.isArray(t.placement)) constraint = `node.labels.vaks.tenant.${slugUnderscore(t.slug)} == true`;
  const reps = ha && t.ha ? 2 : 1;
  services.push(
    service(`api-${t.slug}`, {
      env: appEnv({ SERVICE_ROLE: 'data-plane' }),
      secrets: appSecrets,
      command: appCommand(false),
      deploy: deployBlock({ replicas: reps, constraint, spread: t.ha }),
      configs: pgCaMount,
    }),
  );
  const wenv = ['      NODE_ENV: production', '      REDIS_URL: redis://redis:6379', `      INTERNAL_API_URL: http://api-${t.slug}:3000`].join('\n');
  const wcmd = ['    command: >', '      sh -c "export SMTP_PASSWORD=$$(cat /run/secrets/smtp_password) &&', '             export WORKER_API_TOKEN=$$(cat /run/secrets/worker_api_token) &&', '             node dist/main.js"'].join('\n');
  services.push(
    [
      `  worker-${t.slug}:`,
      `    image: ${img('worker')}`,
      '    environment:',
      wenv,
      '    secrets:\n      - smtp_password\n      - worker_api_token\n      - syslog_client_key',
      wcmd,
      '    networks: [vakspm]',
      deployBlock({ replicas: reps, constraint, spread: t.ha, startFirst: false }),
    ].join('\n'),
  );
}

// ----- web -----
services.push(
  [
    '  web:',
    `    image: ${img('web')}`,
    '    networks: [vakspm]',
    deployBlock({ replicas: ha ? 2 : 1, constraint: null, spread: false }),
  ].join('\n'),
);

// ----- redis / garage / traefik / (postgres en single) -----
// redis : mono-instance. Épinglée si infraPlacement.redis est fourni (volume
// stable, mais bloquée au crash de l'hôte) ; sinon SANS contrainte → Swarm
// l'auto-répare sur un nœud sain (volume neuf au déplacement). Soft state.
const redisNode = ha && m.infraPlacement.redis ? `node.hostname == ${m.infraPlacement.redis}` : null;
services.push(
  [
    '  redis:',
    '    image: redis:7-alpine',
    '    volumes: [redisdata:/data]',
    '    networks: [vakspm]',
    deployBlock({ replicas: 1, constraint: redisNode, spread: false, startFirst: false }),
  ].join('\n'),
);
// garage : multi-nœud (HA, réplication native) si plusieurs hosts, sinon single.
const garageSecrets = '    secrets:\n      - source: garage_rpc_secret\n        target: garage_rpc_secret\n        mode: 0400\n      - source: garage_admin_token\n        target: garage_admin_token\n        mode: 0400';
let garageDeploy;
if (garageMulti) {
  // mode global sur les nœuds labellisés vaks.garage : 1 instance/nœud, chacune
  // avec son volume local → réplication garage entre nœuds (replication_factor).
  garageDeploy = ['    deploy:', '      mode: global', '      placement:', '        constraints: [node.labels.vaks.garage == true]'].join('\n');
} else {
  garageDeploy = deployBlock({ replicas: 1, constraint: ha ? `node.hostname == ${garageHosts[0]}` : null, spread: false, startFirst: false });
}
services.push(
  [
    '  garage:',
    '    image: dxflrs/garage:v1.0.1',
    '    configs:\n      - source: garage_config_gen\n        target: /etc/garage.toml',
    garageSecrets,
    // Bind sur le volume LUKS chiffré (cf. 18-luks-data.sh, monté avant docker).
    "    volumes: ['/srv/vaks/garage:/var/lib/garage']",
    '    networks: [vakspm]',
    garageDeploy,
  ].join('\n'),
);
// garage-reconnect : réconciliateur de peering (HA multi-nœud uniquement). La
// config Garage n'a ni `rpc_public_addr` statique ni `bootstrap_peers` (IP overlay
// dynamiques) → après un redémarrage SIMULTANÉ des nœuds, chacun repart isolé et
// ne se re-découvre pas (split-brain → perte du quorum S3). Ce service résout en
// boucle les tasks Garage (DNS Swarm) et les reconnecte via l'admin API →
// cluster AUTO-GUÉRISSANT. Idempotent, réutilise `garage_admin_token`.
if (garageMulti) {
  services.push(
    [
      '  garage-reconnect:',
      '    image: alpine:3.20',
      '    command: sh /garage-reconnect.sh',
      '    configs:\n      - source: garage_reconnect_gen\n        target: /garage-reconnect.sh',
      '    secrets:\n      - source: garage_admin_token\n        target: garage_admin_token\n        mode: 0400',
      '    environment:\n      GARAGE_TASKS_DNS: tasks.vaks-pm_garage',
      '    networks: [vakspm]',
      // 1 seule instance suffit (elle pousse la liste de pairs à TOUS les nœuds).
      deployBlock({ replicas: 1, constraint: null, spread: false, startFirst: false }),
    ].join('\n'),
  );
}
// traefik
{
  const cmd = [
    '    command:',
    '      - --providers.file.filename=/etc/traefik/dynamic.yml',
    '      - --providers.file.watch=true',
    '      - --entrypoints.web.address=:80',
    '      - --entrypoints.websecure.address=:443',
    '      - --entrypoints.web.http.redirections.entrypoint.to=websecure',
    '      - --entrypoints.web.http.redirections.entrypoint.scheme=https',
    // Logs JSON sur stdout (docker service logs vaks-pm_traefik). Access log =
    // 1 ligne/requête (IP, host, path, status, durée). En-têtes droppés par
    // défaut (jamais d'Authorization/cookie journalisé), sauf UA + XFF.
    '      - --log.format=json',
    '      - --accesslog=true',
    '      - --accesslog.format=json',
    '      - --accesslog.fields.headers.defaultmode=drop',
    '      - --accesslog.fields.headers.names.User-Agent=keep',
    '      - --accesslog.fields.headers.names.X-Forwarded-For=keep',
    // ACME / Let's Encrypt : émission d'un vrai cert (challenge TLS-ALPN-01 sur
    // :443). Le defaultCertificate self-signed reste le fallback. domains[i].main
    // = domaines demandés d'avance (évite un appel ACME par Host inconnu).
    ...(acme ? [
      `      - --certificatesresolvers.le.acme.email=${acme.email}`,
      '      - --certificatesresolvers.le.acme.storage=/acme/acme.json',
      '      - --certificatesresolvers.le.acme.tlschallenge=true',
      ...(acmeStaging ? ['      - --certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory'] : []),
      '      - --entrypoints.websecure.http.tls.certresolver=le',
      ...acmeDomains.map((d, i) => `      - --entrypoints.websecure.http.tls.domains[${i}].main=${d}`),
    ] : []),
  ].join('\n');
  const cfgs = [
    '    configs:',
    '      - source: traefik_dynamic_gen',
    '        target: /etc/traefik/dynamic.yml',
    '      - source: tls_cert_v1',
    '        target: /certs/wildcard.crt',
    '      - source: tls_key_v1',
    '        target: /certs/wildcard.key',
    '        mode: 0400',
  ].join('\n');
  const ports = ['    ports:', '      - target: 80\n        published: 80\n        mode: host', '      - target: 443\n        published: 443\n        mode: host'].join('\n');
  // Stockage ACME persistant (acme.json) : bind mount sur le nœud épinglé.
  const tvols = acme ? "    volumes:\n      - '/srv/vaks/acme:/acme'" : null;
  // ACME = acme.json single-writer store → in HA pin Traefik to ONE cp node
  // (else 2 replicas race on acme.json → double issuance / Let's Encrypt rate-limit).
  // In single mode there is only one node, so DON'T add a node.hostname constraint
  // (the placeholder name would never match the real uname -n → nothing schedules).
  const tdeploy = acme
    ? (ha
        ? ['    deploy:', '      replicas: 1', '      placement:', `        constraints: [node.hostname == ${traefikNode.name}]`].join('\n')
        : deployBlock({ replicas: 1, constraint: null, spread: false, startFirst: false }))
    : ha
      ? ['    deploy:', '      mode: global', '      placement:', `        constraints: [${cpConstraint}]`].join('\n')
      : deployBlock({ replicas: 1, constraint: null, spread: false, startFirst: false });
  services.push(['  traefik:', '    image: traefik:v3.6.24', cmd, cfgs, ...(tvols ? [tvols] : []), ports, '    networks: [vakspm]', tdeploy].join('\n'));
}
// postgres (single uniquement)
if (!ha) {
  services.push(
    [
      '  postgres:',
      '    image: postgres:17-alpine',
      '    environment:',
      '      POSTGRES_USER: vakspm',
      `      POSTGRES_DB: ${m.dbName}`,
      '    secrets:\n      - postgres_password',
      "    command: sh -c 'export POSTGRES_PASSWORD=$$(cat /run/secrets/postgres_password) && docker-entrypoint.sh postgres'",
      '    volumes: [pgdata:/var/lib/postgresql/data]',
      '    networks: [vakspm]',
      deployBlock({ replicas: 1, constraint: null, spread: false, startFirst: false }),
    ].join('\n'),
  );
}

// ----- assemble stack -----
const stackSecrets = [
  'jwt_access_secret',
  'jwt_refresh_secret',
  'database_url',
  'mfa_encryption_key',
  'smtp_password',
  'worker_api_token',
  // Clé privée mTLS du forward syslog (audit) — placeholder 'none' si inutilisée.
  'syslog_client_key',
  'sso_oidc_secret',
  'garage_rpc_secret',
  'garage_admin_token',
  's3_secret_key',
  ...(ha ? [] : ['postgres_password']),
];
const volumes = ['redisdata:', 'garagedata:', ...(ha ? [] : ['pgdata:'])];

const stack = `# GÉNÉRÉ par infra/cluster/generate.mjs — NE PAS éditer à la main.
# Manifeste: ${manifestPath}  ·  mode: ${m.mode}
version: "3.9"

networks:
  vakspm:
    driver: overlay
    attachable: true
    # DORA — chiffrement en transit du trafic inter-conteneurs (IPsec overlay) :
    # redis, garage (S3), HTTP/WS interne. Le réseau doit être recréé pour changer
    # ce flag (stack rm + deploy), cf. DORA_COMPLIANCE.md §D.
    driver_opts:
      encrypted: "true"

volumes:
${volumes.map((v) => `  ${v}`).join('\n')}

secrets:
${stackSecrets.map((s) => `  ${s}:\n    external: true`).join('\n')}

configs:
  traefik_dynamic_gen:
    file: ./infra/traefik-dynamic.gen.yml
  garage_config_gen:
    file: ./infra/garage.gen.toml
${garageMulti ? '  garage_reconnect_gen:\n    file: ./infra/garage-reconnect.sh\n' : ''}  tls_cert_v1:
    file: ./infra/certs/wildcard.crt
  tls_key_v1:
    file: ./infra/certs/wildcard.key
${encPgVerify ? `  pg_ca_v1:\n    file: ./${encPgCaFile}\n` : ''}
services:
${services.join('\n\n')}
`;

// ----- traefik dynamic -----
const celluleRouters = dedicated
  .map(
    (t) => `    api-${t.slug}:
      rule: "Host(\`${t.domain}\`) && PathPrefix(\`/api\`)"
      entryPoints: [web, websecure]
      service: api-${t.slug}
      priority: 50
      middlewares: [security-headers]
      tls: {}`,
  )
  .join('\n');
const celluleServices = dedicated
  .map((t) => `    api-${t.slug}:\n      loadBalancer:\n        servers:\n          - url: "http://api-${t.slug}:3000"`)
  .join('\n');

const traefik = `# GÉNÉRÉ par infra/cluster/generate.mjs — NE PAS éditer à la main.
http:
  middlewares:
    security-headers:
      headers:
        stsSeconds: 31536000
        stsIncludeSubdomains: true
        frameDeny: true
        contentTypeNosniff: true
        referrerPolicy: "strict-origin-when-cross-origin"
        browserXssFilter: false
        permissionsPolicy: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)"
        contentSecurityPolicy: >-
          default-src 'self'; script-src 'self';
          style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
          font-src 'self' https://fonts.gstatic.com data:;
          img-src 'self' data: blob: https:;
          connect-src 'self' ws: wss:;
          frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';
    # Compression de réponse (gzip / brotli / zstd). Appliquée aux routers web
    # (bundle) et api (JSON volumineux). Pas sur ws (Socket.IO) ni mcp (streaming).
    compress:
      compress:
        minResponseBodyBytes: 1024

    # Refuse au bord toute route interne worker→API (/api/v1/internal). Plage
    # TEST-NET-1 (RFC 5737) qui ne matche aucun client réel => 403 systématique.
    deny-internal:
      ipAllowList:
        sourceRange:
          - "192.0.2.1/32"

  routers:
    # Garde-fou bord : bloque /api/v1/internal AVANT tout autre router (priorité
    # 200). Le trafic worker→api passe par le DNS overlay api:3000, pas Traefik.
    internal-deny:
      rule: "PathPrefix(\`/api/v1/internal\`)"
      entryPoints: [web, websecure]
      service: api
      priority: 200
      middlewares: [security-headers, deny-internal]
      tls: {}
    auth:
      rule: "PathPrefix(\`/api/v1/auth\`)"
      entryPoints: [web, websecure]
      service: controlplane
      priority: 100
      middlewares: [security-headers, compress]
      tls: {}
${celluleRouters ? celluleRouters + '\n' : ''}    api:
      rule: "PathPrefix(\`/api\`)"
      entryPoints: [web, websecure]
      service: api
      middlewares: [security-headers, compress]
      tls: {}
    ws:
      rule: "PathPrefix(\`/ws\`) || PathPrefix(\`/socket.io\`)"
      entryPoints: [web, websecure]
      service: api
      middlewares: [security-headers]
      tls: {}
    web:
      rule: "PathPrefix(\`/\`)"
      entryPoints: [web, websecure]
      service: web
      priority: 1
      middlewares: [security-headers, compress]
      tls: {}

  services:
    controlplane:
      loadBalancer:
        servers:
          - url: "http://controlplane:3000"
${celluleServices ? celluleServices + '\n' : ''}    api:
      loadBalancer:
        servers:
          - url: "http://api:3000"
    web:
      loadBalancer:
        servers:
          - url: "http://web:80"

tls:
  stores:
    default:
${acme && acmeDomains.length ? `      defaultGeneratedCert:
        resolver: le
        domain:
          main: ${acmeDomains[0]}${acmeDomains.length > 1 ? '\n          sans:\n' + acmeDomains.slice(1).map((d) => '            - ' + d).join('\n') : ''}` : `      defaultCertificate:
        certFile: /certs/wildcard.crt
        keyFile: /certs/wildcard.key
  certificates:
    - certFile: /certs/wildcard.crt
      keyFile: /certs/wildcard.key`}
`;

// ----- labels.sh -----
const labelLines = ['#!/usr/bin/env bash', '# GÉNÉRÉ — applique les node labels Swarm (à lancer sur le manager).', 'set -euo pipefail'];
if (ha) {
  for (const h of m.hosts) {
    if (role(h, 'cp')) labelLines.push(`docker node update --label-add vaks.cp=true ${h.name}`);
    if (role(h, 'app')) labelLines.push(`docker node update --label-add vaks.app=true ${h.name}`);
  }
  if (garageMulti) for (const hn of garageHosts) labelLines.push(`docker node update --label-add vaks.garage=true ${hn}`);
  for (const t of dedicated) {
    if (Array.isArray(t.placement)) for (const hn of t.placement) labelLines.push(`docker node update --label-add vaks.tenant.${slugUnderscore(t.slug)}=true ${hn}`);
  }
} else {
  labelLines.push('# mode single : un seul nœud, aucun label de placement nécessaire.');
}
labelLines.push('echo "labels appliqués"');

// ----- secrets.md -----
const secretsMd = `# Secrets Swarm à créer (une fois, sur le manager)

> \`docker secret create\` est idempotent par nom : si déjà créé, ignorer.

\`\`\`bash
# Auth
openssl rand -base64 48 | docker secret create jwt_access_secret -
openssl rand -base64 48 | docker secret create jwt_refresh_secret -
openssl rand -base64 32 | docker secret create mfa_encryption_key -

# DB (DSN de la base de connexion ${m.dbName} via ${ha ? 'HAProxy :5000' : 'postgres:5432'})
printf 'postgresql://USER:PASS@${ha ? 'HOST:5000' : 'postgres:5432'}/${m.dbName}?schema=public' | docker secret create database_url -
${ha ? '' : "printf 'CHANGER_MOI' | docker secret create postgres_password -\n"}
# SMTP (mot de passe ; mode anonymous = valeur bidon acceptée)
printf 'SMTP_PASS' | docker secret create smtp_password -

# Interne — REQUIS par la stack même si la feature n'est pas utilisée
# (secrets external: le déploiement échoue s'il en manque un)
openssl rand -hex 32 | docker secret create worker_api_token -
openssl rand -hex 16 | docker secret create sso_oidc_secret -
printf 'none' | docker secret create syslog_client_key -

# Garage (S3 on-premise)
openssl rand -hex 32 | docker secret create garage_rpc_secret -
openssl rand -hex 32 | docker secret create garage_admin_token -
printf 'S3_SECRET' | docker secret create s3_secret_key -
\`\`\`

Cellules dédiées (${dedicated.map((t) => t.slug).join(', ') || 'aucune'}) : **pas** de secret par tenant — l'api-<slug> tourne en mode pooled et dérive sa base \`${m.dbName}_<slug>\` depuis le Host.
`;

// ----- garage.gen.toml (replication_factor dérivé du nombre de nœuds) -----
const garageToml = `## GÉNÉRÉ par infra/cluster/generate.mjs — NE PAS éditer à la main.
## Garage v1 — ${garageMulti ? `cluster ${garageHosts.length} nœuds (HA)` : 'single-node'}.
metadata_dir = "/var/lib/garage/meta"
data_dir     = "/var/lib/garage/data"
db_engine    = "lmdb"

replication_factor = ${garageReplication}

rpc_bind_addr   = "[::]:3901"
${garageMulti
    ? '# Multi-nœud : pas de rpc_public_addr statique (résoudrait vers UNE seule\n# task via la VIP). Les nœuds se connectent au bootstrap via `garage node\n# connect <id>@<ip-overlay>:3901` — voir garage-cluster.md.'
    : 'rpc_public_addr = "garage:3901"'}
rpc_secret_file = "/run/secrets/garage_rpc_secret"

[s3_api]
s3_region     = "${s3.region}"
api_bind_addr = "[::]:3900"
root_domain   = ".s3.garage.local"

[admin]
api_bind_addr      = "[::]:3903"
admin_token_file   = "/run/secrets/garage_admin_token"
metrics_token_file = "/run/secrets/garage_admin_token"
`;

// ----- garage-cluster.md (runbook bootstrap, mode multi-nœud uniquement) -----
const garageClusterMd = `# Bootstrap du cluster Garage (HA, ${garageHosts.length} nœuds)

> Étape **unique** après le premier \`stack deploy\`. Garage génère un node_id
> par nœud au démarrage (dans \`metadata_dir\`) → le layout ne peut PAS être
> statique, il faut le faire une fois ici.
>
> ℹ️ **Peering automatique** : le service \`garage-reconnect\` (déployé avec la
> stack) reconnecte en continu les nœuds via l'admin API (résolution DNS Swarm
> \`tasks.<stack>_garage\`). Il rend le cluster **auto-guérissant** après un
> redémarrage simultané (reboot, \`stack deploy\`) — sans lui, la config n'a ni
> \`rpc_public_addr\` statique ni \`bootstrap_peers\` (IP overlay dynamiques) et
> chaque nœud repartirait isolé (split-brain → perte du quorum S3). Le \`g node
> connect\` manuel ci-dessous n'est donc utile QUE pour le tout premier layout,
> ou si \`garage-reconnect\` est arrêté. Logs : \`docker service logs <stack>_garage-reconnect\`.
>
> ⚠️ Non validé contre un cluster live : adapter zones/capacités à ton infra.

Nœuds garage : ${garageHosts.join(', ')}  ·  replication_factor = ${garageReplication}

\`\`\`bash
# Sur un nœud garage (récupérer le container id)
CID=$(docker ps -q -f name=vaks-pm_garage | head -1)
alias g="docker exec $CID /garage"

# 1. Lister les nœuds vus + leurs IDs (chaque task s'annonce sur l'overlay)
g status                       # note les <node_id> (et connecter les manquants:
                               #   g node connect <node_id>@<ip-overlay>:3901)

# 2. Assigner une zone + capacité à CHAQUE node_id (1 zone par host pour répartir)
g layout assign -z dc1 -c 100G <node_id_host_a>
g layout assign -z dc2 -c 100G <node_id_host_b>
g layout assign -z dc3 -c 100G <node_id_host_c>

# 3. Appliquer
g layout apply --version 1

# 4. Bucket + clé S3 (réutiliser la clé existante si déjà créée)
g bucket create vakspm
g key create vakspm-app          # → note l'Access Key + Secret Key
g bucket allow --read --write vakspm --key vakspm-app
# Le Secret Key va dans le secret Swarm s3_secret_key ; l'Access Key dans
# S3_ACCESS_KEY de la stack (api/worker).
\`\`\`

Perte d'un nœud : avec replication_factor = ${garageReplication}, les objets restent servis par les autres nœuds. Remplacement → \`g layout assign\` du nouveau node_id + \`apply\`.
`;

// ----- per-host scripts + orchestrateur -----
const etcdMembers = hostsWith('etcd');
const dbHosts = hostsWith('db');
// TLS interne par défaut → etcd https d'emblée (cf. bootstrap 10-etcd.sh / 12-certs.sh).
const etcdInitial = etcdMembers.map((h) => `${h.name}=https://${h.ip}:2380`).join(',');

function hostScript(h) {
  const L = ['#!/usr/bin/env bash', `# GÉNÉRÉ — bootstrap du host ${h.name} (rôles: ${(h.roles || []).join(',')}).`, '# À lancer EN LOCAL sur cette machine (sudo). Pré-requis: bootstrap/ présent.', 'set -euo pipefail', 'HERE="$(cd "$(dirname "$0")" && pwd)"', 'cd "$HERE/bootstrap"', ''];
  if (m.mode === 'single') {
    L.push(
      '# single-node : pas de tier DB natif (postgres est conteneurisé dans la stack),',
      '# mais Docker Engine est requis pour faire tourner le Swarm single-node.',
      '# 00-common.sh installe Docker (idempotent), copié dans out/bootstrap/ par le générateur.',
      'bash 00-common.sh',
      'echo "[single] Docker installed. Next: bash out/deploy-ssh.sh from the control workstation (or secrets + stack deploy by hand, see the doc)."',
    );
    return L.join('\n');
  }
  if (role(h, 'db')) {
    const standbyEnv = !isPrimaryZone && standbyPrimaryHost ? `STANDBY_PRIMARY_HOST=${standbyPrimaryHost} ` : '';
    if (!isPrimaryZone) L.push(`# Zone STANDBY (${selectedZone}) : Patroni réplique en async depuis ${standbyPrimaryHost}:5000 (primary).`);
    L.push('bash 00-common.sh');
    // TLS interne (DORA) : pose le cert maître partagé AVANT etcd (qui démarre
    // https). L'orchestrateur a distribué bootstrap/certs/server.{crt,key}.
    L.push('bash 12-certs.sh');
    if (role(h, 'etcd')) L.push(`NODE_NAME=${h.name} NODE_IP=${h.ip} ETCD_INITIAL_CLUSTER="${etcdInitial}" bash 10-etcd.sh`);
    // Chiffrement at-rest des DONNÉES (DORA) : Tang (clé réseau) + conteneurs
    // LUKS Clevis-bound aux PAIRS, montés AVANT patroni (pgdata) / docker (garage).
    // N'encrypte pas le disque hôte ni les autres charges. cf. 15/18-*.sh.
    if (encDiskLuks) {
      const peerTangIps = dbHosts.filter((d) => d.ip !== h.ip).map((d) => d.ip).join(',');
      L.push('bash 15-tang.sh');
      L.push(`PEER_TANG_IPS="${peerTangIps}" SETUP_PG=1 SETUP_GARAGE=${garageHosts.includes(h.name) ? '1' : '0'} bash 18-luks-data.sh`);
    } else {
      L.push('# Chiffrement disque (LUKS/Tang) DÉSACTIVÉ dans le manifeste (encryption.diskLuks=false).');
      L.push('# Les volumes pgdata/garage ne sont PAS chiffrés au repos par cet installeur.');
    }
    L.push(
      `NODE_NAME=${h.name} NODE_IP=${h.ip} ETCD_ENDPOINTS="${etcdMembers.map((e) => `${e.ip}:2379`).join(',')}" ${standbyEnv}\\`,
      '  REPL_USER="${REPL_USER:?}" REPL_PASSWORD="${REPL_PASSWORD:?}" SUPERUSER_PASSWORD="${SUPERUSER_PASSWORD:?}" bash 20-patroni.sh',
    );
    L.push(`DB_SERVERS="${dbHosts.map((d) => `${d.name}:${d.ip}`).join(',')}" bash 30-haproxy.sh`);
  } else {
    L.push(`# ${h.name} ne porte pas le rôle "db" — rien à bootstrapper côté base.`);
  }
  return L.join('\n');
}

const managers = m.hosts.filter((h) => role(h, 'manager'));
const firstManager = managers[0] || m.hosts[0];
const leaderDb = (hostsWith('db')[0] || m.hosts[0]);
const workerManagers = managers.slice(1);
const workers = m.hosts.filter((h) => !role(h, 'manager'));
// Données host interpolées pour le script bash (name|ip|isDb|isManager).
const hostRows = m.hosts.map((h) => `${h.name}|${h.ip}|${role(h, 'db') ? 1 : 0}|${role(h, 'manager') ? 1 : 0}`).join('\n');
const provisionLines = m.tenants
  .map((t) => `provision_tenant ${t.slug} "${t.adminEmail || ''}"${t.seed ? ` ${t.seed}` : ''}`)
  .join('\n');

// Étapes conditionnelles primary/standby — consts au MÊME niveau que deployOrch
// (échappement bash d'origine, pas de double-niveau de template literal).
const bootstrapStep = isPrimaryZone
  ? `echo "=== bootstrap role + database — Patroni elects SOME leader; we try on each db node (replicas skip themselves via pg_is_in_recovery) ==="
while IFS='|' read -r bname bip bisdb bismgr; do
  [ "\$bisdb" = "1" ] || continue
  SUDO "\$bip" "cd \$REMOTE/bootstrap && POSTGRES_USER='\${POSTGRES_USER:?}' POSTGRES_PASSWORD='\${POSTGRES_PASSWORD:?}' POSTGRES_DB='\${POSTGRES_DB:?}' bash 25-bootstrap-db.sh"
done <<< "\$HOSTS_DATA"`
  : `echo "=== STANDBY zone (${selectedZone}): no bootstrap-db — Patroni clones the primary (${standbyPrimaryHost}) asynchronously ==="`;

const provisionStep = isPrimaryZone
  ? `echo "=== 7) Provision tenants ==="
provision_tenant(){
  # \$1 = slug, \$2 = admin email (optional, quoted so it may be empty), \$3 = seed (optional).
  local EMAIL="\${2:-}" SEED="\${3:-}" EMAIL_ARG="" SEED_ARG="";
  [ -n "\$EMAIL" ] && EMAIL_ARG="\$EMAIL";
  [ -n "\$SEED" ] && SEED_ARG="--seed \$SEED";
  echo "  -> tenant \$1 \${EMAIL:+<\$EMAIL>}\${SEED:+ (seed: \$SEED)} (runs provision-tenant.js in an api container)";
  SUDO "\$MANAGER_IP" "CID=\\\$(docker ps -q -f name=vaks-pm_api | head -1); [ -n \\\"\\\$CID\\\" ] && docker exec \\\$CID sh -c 'export DATABASE_URL=\\\$(cat /run/secrets/database_url) && cd /app/api && node prisma/provision-tenant.js \$1 \$EMAIL_ARG \$SEED_ARG' || echo 'api not ready yet — re-run'";
}
${provisionLines || 'echo "  (no tenant declared)"'}`
  : `echo "=== 6) STANDBY zone: no provisioning — tenants arrive by replication from the primary ==="`;

const singleHost = m.hosts[0];
const deployOrch = m.mode === 'single'
  ? `#!/usr/bin/env bash
# GÉNÉRÉ — orchestrateur SSH (mode single, ${singleHost.name} @ ${singleHost.ip}). Piloté depuis ta machine.
# Pré-requis: .env.local avec VM_USER + SSH_KEY (et VM_PASS si le sudo demande un mot de passe).
# POSTGRES_PASSWORD / JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / SMTP_PASSWORD sont
# OPTIONNELS : générés si absents (le mot de passe Postgres est persisté dans
# .pg-creds, gitignoré — le garder : psql direct, sauvegardes, restauration).
# Le repo (infra/, packages, api, web, worker) doit être présent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
mkdir -p "$HERE/logs"
VAKS_DEPLOY_LOG="$HERE/logs/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$VAKS_DEPLOY_LOG") 2>&1
echo "# deployment log → $VAKS_DEPLOY_LOG"
set -a; . "$ROOT/.env.local"; set +a
: "\${VM_USER:?}"; : "\${SSH_KEY:?}"; : "\${VM_PASS:=}"
case "\$SSH_KEY" in /*) ;; *) SSH_KEY="\$ROOT/\$SSH_KEY";; esac  # relative key = from repo root, so the script runs from any CWD
SSHOPT="-o StrictHostKeyChecking=accept-new -i \$SSH_KEY"
SSH(){ ssh -n $SSHOPT "\${VM_USER}@\$1" "\$2"; }
SCP(){ scp $SSHOPT -r "\$2" "\${VM_USER}@\$1:\$3"; }
SUDO(){ local b; b="$(printf '%s' "\$2" | base64 | tr -d '\\n')"; ssh -n $SSHOPT "\${VM_USER}@\$1" "echo '\${VM_PASS}' | sudo -S -p '' bash -c \\"echo \$b | base64 -d | bash\\""; }

REMOTE="/home/\${VM_USER}/vakspm-cluster"
NODE_IP="${singleHost.ip}"
MANAGER_IP="\$NODE_IP"   # alias : les étapes partagées (provisioning) parlent au même nœud

echo "=== 1) Docker Engine on ${singleHost.name} (\$NODE_IP) ==="
SSH "\$NODE_IP" "mkdir -p \$REMOTE"
SCP "\$NODE_IP" "\$ROOT/infra/bootstrap" "\$REMOTE/"
SCP "\$NODE_IP" "\$HERE/host-${singleHost.name}.sh" "\$REMOTE/host-${singleHost.name}.sh"
SUDO "\$NODE_IP" "cd \$REMOTE && bash host-${singleHost.name}.sh"

echo "=== 2) Swarm single-node ==="
SUDO "\$NODE_IP" "docker swarm init --advertise-addr \$NODE_IP 2>/dev/null || true"

echo "=== 3) Secrets (generated; Postgres + S3 persisted on the control machine) ==="
mk_secret(){ SUDO "\$NODE_IP" "docker secret inspect \$1 >/dev/null 2>&1 || printf '%s' '\$2' | docker secret create \$1 -"; }
# Postgres conteneurisé : mot de passe choisi 1× puis persisté (idempotent au re-run ;
# .pg-creds est gitignoré). La MÊME valeur doit vivre dans postgres_password ET database_url.
if [ -f "\$ROOT/.pg-creds" ]; then . "\$ROOT/.pg-creds"; else PGPASS="\${POSTGRES_PASSWORD:-\$(openssl rand -hex 24)}"; printf 'PGPASS=%s\\n' "\$PGPASS" > "\$ROOT/.pg-creds"; fi
# Paire S3 au format Garage (access GK+24hex, secret 64hex), persistée localement
# (idempotente au re-run ; .s3-creds est gitignoré).
if [ -f "\$ROOT/.s3-creds" ]; then . "\$ROOT/.s3-creds"; else S3_ACCESS="GK\$(openssl rand -hex 12)"; S3_SECRET="\$(openssl rand -hex 32)"; printf 'S3_ACCESS=%s\\nS3_SECRET=%s\\n' "\$S3_ACCESS" "\$S3_SECRET" > "\$ROOT/.s3-creds"; fi
mk_secret jwt_access_secret "\${JWT_ACCESS_SECRET:-\$(openssl rand -base64 48)}"
mk_secret jwt_refresh_secret "\${JWT_REFRESH_SECRET:-\$(openssl rand -base64 48)}"
mk_secret postgres_password "\$PGPASS"
mk_secret database_url "postgresql://vakspm:\$PGPASS@postgres:5432/${m.dbName}?schema=public"
mk_secret mfa_encryption_key "\$(openssl rand -base64 32)"
mk_secret worker_api_token "\$(openssl rand -hex 32)"
# Secret SSO OIDC global (fallback ; les secrets clients per-tenant vivent chiffrés en DB).
# Doit exister même vide, sinon le stack deploy échoue (service api/controlplane le monte).
mk_secret sso_oidc_secret "\$(openssl rand -hex 16)"
mk_secret smtp_password "\${SMTP_PASSWORD:-changeme-smtp}"
# mTLS syslog (audit) : placeholder — remplacer par la vraie clé PEM pour activer.
mk_secret syslog_client_key "none"
mk_secret garage_rpc_secret "\$(openssl rand -hex 32)"
mk_secret garage_admin_token "\$(openssl rand -hex 32)"
mk_secret s3_secret_key "\$S3_SECRET"
echo "  S3 access key (stack + Garage) : \$S3_ACCESS"
echo "  Postgres password → .pg-creds (keep it: psql, backups, restore)"

if ${imageSource === 'build' ? 'true' : 'false'}; then
echo "=== 4) Images: build on the node ==="
SSH "\$NODE_IP" "mkdir -p \$REMOTE/src"
for d in package.json package-lock.json tsconfig.base.json packages api web worker; do
  [ -e "\$ROOT/\$d" ] && SCP "\$NODE_IP" "\$ROOT/\$d" "\$REMOTE/src/" || true
done
SUDO "\$NODE_IP" "cd \$REMOTE/src && for s in api web worker; do docker build -t vaks-pm/\\\$s:latest -f \\\$s/Dockerfile . ; done"
else
echo "=== 4) Images : pull ${imagePrefix}-{api,web,worker}:${imageTag} at deploy time (docker stack deploy) ==="
echo "  (private/mirror registry: run 'docker login' + deploy with --with-registry-auth)"
fi

echo "=== 5) Stack deploy ==="
${encPgVerify ? `[ -f "$ROOT/${encPgCaFile}" ] || { echo "ERREUR: encryption.pgVerify=true mais CA Postgres absente: ${encPgCaFile} (placer le PEM avant le déploiement)"; exit 1; }\n` : ''}# Certs TLS : self-signed si absent (sinon le SCP échoue et Traefik n'a pas de cert)
[ -f "\$ROOT/infra/certs/wildcard.crt" ] || { mkdir -p "\$ROOT/infra/certs"; openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=*.${m.baseDomain || 'local'}" -keyout "\$ROOT/infra/certs/wildcard.key" -out "\$ROOT/infra/certs/wildcard.crt"; }
# Injecter l'access key S3 (générée à l'étape 3) dans le stack
sed -i -E "s|S3_ACCESS_KEY:.*|S3_ACCESS_KEY: \$S3_ACCESS|g" "\$HERE/docker-stack.gen.yml"
SSH "\$NODE_IP" "mkdir -p \$REMOTE/infra && rm -rf \$REMOTE/infra/certs"
SCP "\$NODE_IP" "\$HERE/docker-stack.gen.yml" "\$REMOTE/docker-stack.gen.yml"
SCP "\$NODE_IP" "\$HERE/traefik-dynamic.gen.yml" "\$REMOTE/infra/traefik-dynamic.gen.yml"
SCP "\$NODE_IP" "\$HERE/garage.gen.toml" "\$REMOTE/infra/garage.gen.toml"
SCP "\$NODE_IP" "\$ROOT/infra/certs" "\$REMOTE/infra/certs"
# Garage bind-monte /srv/vaks/garage ; en single il n'y a pas de LUKS pour le
# créer → le garantir sinon Garage refuse de démarrer (bind source manquante).
SUDO "\$NODE_IP" "mkdir -p /srv/vaks/garage"
${acme ? 'SUDO "\\$NODE_IP" "mkdir -p /srv/vaks/acme"\n' : ''}SUDO "\$NODE_IP" "cd \$REMOTE && docker stack deploy -c docker-stack.gen.yml vaks-pm"

echo "=== 6) Init Garage (single node) ==="
SUDO "\$NODE_IP" "for i in \\\$(seq 1 40); do docker ps -q -f name=vaks-pm_garage | grep -q . && break; sleep 5; done"
GG="C=\\\$(docker ps -q -f name=vaks-pm_garage | head -1); docker exec \\\$C /garage"
GID="\$(SUDO "\$NODE_IP" "C=\\\$(docker ps -q -f name=vaks-pm_garage | head -1); docker exec \\\$C /garage node id 2>/dev/null | grep -m1 -oE '^[0-9a-f]{64}'")"
[ -n "\$GID" ] || { echo "ERREUR: node id Garage introuvable (service pas prêt ? relancer ce script)"; exit 1; }
SUDO "\$NODE_IP" "\$GG layout assign -z dc1 -c 100G \$GID" || true
SUDO "\$NODE_IP" "\$GG layout apply --version 1" || true
SUDO "\$NODE_IP" "\$GG key import --yes -n vakspm-app \$S3_ACCESS \$S3_SECRET" || true
SUDO "\$NODE_IP" "\$GG key allow --create-bucket \$S3_ACCESS" || true
SUDO "\$NODE_IP" "docker service update --force vaks-pm_api" || true
echo "  Garage initialized; the API recreates its buckets on restart."

# Postgres conteneurisé démarre AVEC la stack : l'api peut redémarrer quelques fois
# le temps que la base soit prête (prisma db push au boot). On attend sa présence.
SUDO "\$NODE_IP" "for i in \\\$(seq 1 40); do docker ps -q -f name=vaks-pm_api | grep -q . && break; sleep 5; done"

${provisionStep}
${m.deploymentMode === 'dedicated' && !m.tenants.length ? `echo "  deploymentMode=dedicated with no tenant: bootstrap the first organization via infra/org-bootstrap.json + prisma/bootstrap-org.js (see the deploy-swarm doc, single-host section)."\n` : ''}
echo ""
echo "======================================================================"
echo "  SAVE THESE CREDENTIALS — they are shown only once"
echo "======================================================================"
echo "  PostgreSQL user     : vakspm"
echo "  PostgreSQL password : \$PGPASS"
echo "  S3 access key       : \$S3_ACCESS"
echo "  S3 secret key       : \$S3_SECRET"
echo ""
echo "  Also persisted (git-ignored) on THIS control machine:"
echo "    \$ROOT/.pg-creds   — Postgres password (needed for psql, backups, restore)"
echo "    \$ROOT/.s3-creds   — S3 keys"
echo "  -> Back up both files somewhere safe, off this machine."
echo "  -> The org admin password was printed above under 'Provision' (if a tenant"
echo "     was created) — note it now; a change is forced at first login."
echo "  -> JWT / MFA / token secrets live inside Swarm (encrypted); nothing to save."
echo "======================================================================"
echo ""
echo "=== Done. Check: docker stack ps vaks-pm (on ${singleHost.name}) ==="
echo "# full log of this deployment → $VAKS_DEPLOY_LOG"
`
  : `#!/usr/bin/env bash
# GÉNÉRÉ — orchestrateur SSH (mode ha, ${m.hosts.length} hosts). Piloté depuis ta machine.
# Pré-requis: .env.local avec SSH_KEY, VM_PASS, PATRONI_REPLICATION_PASSWORD,
#   PATRONI_SUPERUSER_PASSWORD, POSTGRES_USER/PASSWORD/DB, JWT_ACCESS/REFRESH_SECRET.
# Le repo (infra/, packages, api, web, worker, docker-stack.gen.yml) doit être présent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# Journalisation automatique : toute la sortie (stdout+stderr) est tee'd vers un
# fichier horodaté dans out/logs/ EN PLUS du terminal. Pas de secret imprimé (les
# valeurs sensibles transitent via SUDO base64, jamais echo).
mkdir -p "$HERE/logs"
VAKS_DEPLOY_LOG="$HERE/logs/deploy-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$VAKS_DEPLOY_LOG") 2>&1
echo "# deployment log → $VAKS_DEPLOY_LOG"
set -a; . "$ROOT/.env.local"; set +a
: "\${SSH_KEY:?}"; : "\${VM_PASS:=}"
case "\$SSH_KEY" in /*) ;; *) SSH_KEY="\$ROOT/\$SSH_KEY";; esac  # relative key = from repo root, so the script runs from any CWD
SSHOPT="-o StrictHostKeyChecking=accept-new -i \$SSH_KEY"
# -n : stdin depuis /dev/null. SANS ça, un ssh dans une boucle while-read sur
# un here-string consomme le here-string et la boucle ne traite que le 1er
# host (bug classique). Le mot de passe sudo passe par un pipe DISTANT
# (echo|sudo -S), donc -n ne le gêne pas.
SSH(){ ssh -n $SSHOPT "\${VM_USER}@\$1" "\$2"; }
SCP(){ scp $SSHOPT -r "\$2" "\${VM_USER}@\$1:\$3"; }
SUDO(){ local b; b="$(printf '%s' "\$2" | base64 | tr -d '\\n')"; ssh -n $SSHOPT "\${VM_USER}@\$1" "echo '\${VM_PASS}' | sudo -S -p '' bash -c \\"echo \$b | base64 -d | bash\\""; }

REMOTE="/home/\${VM_USER}/vakspm-cluster"
MANAGER_IP="${firstManager.ip}"
LEADER_IP="${leaderDb.ip}"

# Données: name|ip|isDb|isManager
HOSTS_DATA="${hostRows}"

echo "=== 0) Internal TLS (DORA): SHARED self-signed cert (generated once, distributed) ==="
# Le cert/clé doivent être identiques sur tous les nœuds (mTLS pair etcd auto-ancré).
# Généré sur le leader db (openssl natif Debian), réutilisé s'il existe déjà
# (idempotent), distribué dans bootstrap/certs/ de chaque host (12-certs.sh l'installe).
CERT_TMP="\$(mktemp -d)"
if SUDO "\$LEADER_IP" "test -f /etc/vaks/server.crt && test -f /etc/vaks/server.key"; then
  echo "  cert already present on the leader (\$LEADER_IP) — reusing"
  SUDO "\$LEADER_IP" "cat /etc/vaks/server.crt" > "\$CERT_TMP/server.crt"
  SUDO "\$LEADER_IP" "cat /etc/vaks/server.key" > "\$CERT_TMP/server.key"
else
  SAN="IP:127.0.0.1,DNS:localhost"
  while IFS='|' read -r cn cip cisdb cismgr; do [ "\$cisdb" = "1" ] && SAN="IP:\$cip,\$SAN"; done <<< "\$HOSTS_DATA"
  echo "  generating on the leader \$LEADER_IP (SAN=\$SAN)"
  SUDO "\$LEADER_IP" "openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout /tmp/vaks-srv.key -out /tmp/vaks-srv.crt -subj '/CN=vaks-internal' -addext 'subjectAltName=\$SAN' -addext 'keyUsage=critical,digitalSignature,keyEncipherment' -addext 'extendedKeyUsage=serverAuth,clientAuth'"
  SUDO "\$LEADER_IP" "cat /tmp/vaks-srv.crt" > "\$CERT_TMP/server.crt"
  SUDO "\$LEADER_IP" "cat /tmp/vaks-srv.key" > "\$CERT_TMP/server.key"
  SUDO "\$LEADER_IP" "rm -f /tmp/vaks-srv.crt /tmp/vaks-srv.key"
fi
[ -s "\$CERT_TMP/server.crt" ] && [ -s "\$CERT_TMP/server.key" ] || { echo "FATAL: cert interne génération/pull échoué" >&2; exit 1; }
chmod 600 "\$CERT_TMP/server.key"

echo "=== 1) Database tier (etcd+patroni+haproxy) on the 'db' hosts ==="
# Pass A — distribution sur tous les db-hosts + (si LUKS) pré-passe Tang.
# Le bind LUKS (18-luks) pinne les serveurs Tang des PAIRS : ils doivent TOUS être
# up AVANT la moindre liaison, sinon le 1er hôte échoue (pairs pas encore
# provisionnés car les hôtes sont bootstrappés en série). Tang est indépendant
# (certs/etcd non requis) donc on peut le monter en amont, puis host-\$name.sh le
# re-lance idempotemment.
while IFS='|' read -r name ip isdb ismgr; do
  [ "\$isdb" = "1" ] || continue
  echo "--- distribute \$name (\$ip) ---"
  SSH "\$ip" "mkdir -p \$REMOTE"
  SCP "\$ip" "\$ROOT/infra/bootstrap" "\$REMOTE/"
  SCP "\$ip" "\$ROOT/infra/patroni.yml" "\$REMOTE/bootstrap/patroni.yml"
  SCP "\$ip" "\$ROOT/infra/haproxy.cfg" "\$REMOTE/bootstrap/haproxy.cfg"
  SSH "\$ip" "mkdir -p \$REMOTE/bootstrap/certs"
  SCP "\$ip" "\$CERT_TMP/server.crt" "\$REMOTE/bootstrap/certs/server.crt"
  SCP "\$ip" "\$CERT_TMP/server.key" "\$REMOTE/bootstrap/certs/server.key"
  SCP "\$ip" "\$HERE/host-\$name.sh" "\$REMOTE/host-\$name.sh"
${encDiskLuks ? '  SUDO "$ip" "cd $REMOTE/bootstrap && bash 15-tang.sh"  # Tang up AVANT tout bind LUKS des pairs\n' : ''}done <<< "\$HOSTS_DATA"
# Pass B — bootstrap complet : 15-tang idempotent, 18-luks trouve tous les Tang pairs up.
while IFS='|' read -r name ip isdb ismgr; do
  [ "\$isdb" = "1" ] || continue
  echo "--- bootstrap \$name (\$ip) ---"
  SUDO "\$ip" "cd \$REMOTE && REPL_USER='\${PATRONI_REPLICATION_USER:-replicator}' REPL_PASSWORD='\${PATRONI_REPLICATION_PASSWORD:?}' SUPERUSER_PASSWORD='\${PATRONI_SUPERUSER_PASSWORD:?}' bash host-\$name.sh"
done <<< "\$HOSTS_DATA"
rm -rf "\$CERT_TMP"

${bootstrapStep}

echo "=== 2) Swarm: init manager + join ==="
SUDO "\$MANAGER_IP" "docker swarm init --advertise-addr \$MANAGER_IP 2>/dev/null || true"
TOKEN_W="\$(SUDO "\$MANAGER_IP" "docker swarm join-token -q worker" | tr -d '\\r\\n')"
TOKEN_M="\$(SUDO "\$MANAGER_IP" "docker swarm join-token -q manager" | tr -d '\\r\\n')"
while IFS='|' read -r name ip isdb ismgr; do
  [ "\$ip" = "\$MANAGER_IP" ] && continue
  if [ "\$ismgr" = "1" ]; then SUDO "\$ip" "docker swarm join --token \$TOKEN_M \$MANAGER_IP:2377 2>/dev/null || true";
  else SUDO "\$ip" "docker swarm join --token \$TOKEN_W \$MANAGER_IP:2377 2>/dev/null || true"; fi
done <<< "\$HOSTS_DATA"

echo "=== node labels ==="
SCP "\$MANAGER_IP" "\$HERE/labels.sh" "\$REMOTE/labels.sh"
SUDO "\$MANAGER_IP" "cd \$REMOTE && bash labels.sh"

echo "=== 3) Secrets (all: core from .env.local + generated) ==="
mk_secret(){ SUDO "\$MANAGER_IP" "docker secret inspect \$1 >/dev/null 2>&1 || printf '%s' '\$2' | docker secret create \$1 -"; }
# Paire S3 au format Garage (access GK+24hex, secret 64hex), persistée localement
# (idempotente au re-run ; .s3-creds est gitignoré).
if [ -f "\$ROOT/.s3-creds" ]; then . "\$ROOT/.s3-creds"; else S3_ACCESS="GK\$(openssl rand -hex 12)"; S3_SECRET="\$(openssl rand -hex 32)"; printf 'S3_ACCESS=%s\\nS3_SECRET=%s\\n' "\$S3_ACCESS" "\$S3_SECRET" > "\$ROOT/.s3-creds"; fi
mk_secret jwt_access_secret "\${JWT_ACCESS_SECRET:?}"
mk_secret jwt_refresh_secret "\${JWT_REFRESH_SECRET:?}"
mk_secret database_url "postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@\${MANAGER_IP}:5000/\${POSTGRES_DB}?schema=public"
mk_secret mfa_encryption_key "\$(openssl rand -base64 32)"
mk_secret worker_api_token "\$(openssl rand -hex 32)"
# Secret SSO OIDC global (fallback ; les secrets clients per-tenant vivent chiffrés en DB).
# Doit exister même vide, sinon le stack deploy échoue (service api/controlplane le monte).
mk_secret sso_oidc_secret "\$(openssl rand -hex 16)"
mk_secret smtp_password "\${SMTP_PASSWORD:-changeme-smtp}"
# mTLS syslog (audit) : placeholder — remplacer par la vraie clé PEM pour activer.
mk_secret syslog_client_key "none"
mk_secret garage_rpc_secret "\$(openssl rand -hex 32)"
mk_secret garage_admin_token "\$(openssl rand -hex 32)"
mk_secret s3_secret_key "\$S3_SECRET"
echo "  S3 access key (stack + Garage) : \$S3_ACCESS"

if ${imageSource === 'build' ? 'true' : 'false'}; then
echo "=== 4) Images: build on the manager + distribute to the other nodes ==="
SSH "\$MANAGER_IP" "mkdir -p \$REMOTE/src"
for d in package.json package-lock.json tsconfig.base.json packages api web worker; do
  [ -e "\$ROOT/\$d" ] && SCP "\$MANAGER_IP" "\$ROOT/\$d" "\$REMOTE/src/" || true
done
SUDO "\$MANAGER_IP" "cd \$REMOTE/src && for s in api web worker; do docker build -t vaks-pm/\\\$s:latest -f \\\$s/Dockerfile . ; done"
SUDO "\$MANAGER_IP" "docker save vaks-pm/api:latest vaks-pm/web:latest vaks-pm/worker:latest -o /tmp/vakspm-imgs.tar && chown \${VM_USER}:\${VM_USER} /tmp/vakspm-imgs.tar"
TARTMP="\$(mktemp)"; scp \$SSHOPT "\${VM_USER}@\$MANAGER_IP:/tmp/vakspm-imgs.tar" "\$TARTMP"
while IFS='|' read -r name ip isdb ismgr; do
  [ "\$ip" = "\$MANAGER_IP" ] && continue
  SCP "\$ip" "\$TARTMP" "/tmp/vakspm-imgs.tar"
  SUDO "\$ip" "docker load -i /tmp/vakspm-imgs.tar"
done <<< "\$HOSTS_DATA"
rm -f "\$TARTMP"
else
echo "=== 4) Images : pull ${imagePrefix}-{api,web,worker}:${imageTag} at deploy time (each node pulls from the registry) ==="
echo "  (private/mirror registry: 'docker login' on each node + deploy with --with-registry-auth)"
fi

echo "=== 5) Stack deploy ==="
${encPgVerify ? `[ -f "$ROOT/${encPgCaFile}" ] || { echo "ERREUR: encryption.pgVerify=true mais CA Postgres absente: ${encPgCaFile} (placer le PEM avant le déploiement)"; exit 1; }\n` : ''}# Certs TLS : self-signed si absent (sinon le SCP échoue et Traefik n'a pas de cert)
[ -f "\$ROOT/infra/certs/wildcard.crt" ] || { mkdir -p "\$ROOT/infra/certs"; openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=*.${m.baseDomain || 'local'}" -keyout "\$ROOT/infra/certs/wildcard.key" -out "\$ROOT/infra/certs/wildcard.crt"; }
# Injecter l'access key S3 (générée à l'étape 3) dans le stack
sed -i -E "s|S3_ACCESS_KEY:.*|S3_ACCESS_KEY: \$S3_ACCESS|g" "\$HERE/docker-stack.gen.yml"
SSH "\$MANAGER_IP" "mkdir -p \$REMOTE/infra && rm -rf \$REMOTE/infra/certs"
SCP "\$MANAGER_IP" "\$HERE/docker-stack.gen.yml" "\$REMOTE/docker-stack.gen.yml"
SCP "\$MANAGER_IP" "\$HERE/traefik-dynamic.gen.yml" "\$REMOTE/infra/traefik-dynamic.gen.yml"
SCP "\$MANAGER_IP" "\$HERE/garage.gen.toml" "\$REMOTE/infra/garage.gen.toml"
${garageMulti ? 'SCP "$MANAGER_IP" "$ROOT/infra/garage-reconnect.sh" "$REMOTE/infra/garage-reconnect.sh"\n' : ''}SCP "\$MANAGER_IP" "\$ROOT/infra/certs" "\$REMOTE/infra/certs"
# Garage bind-monte /srv/vaks/garage : le garantir sur chaque garage-host. Ce
# dossier est créé par le mount LUKS quand diskLuks=on ; s'il est off, rien ne le
# crée → Garage refuse de démarrer. mkdir -p = no-op si le volume LUKS y est monté.
for gip in ${garageHosts.map((hn) => hostByName(hn).ip).join(' ')}; do SUDO "\$gip" "mkdir -p /srv/vaks/garage"; done
${acme ? `SUDO "${traefikNode.ip}" "mkdir -p /srv/vaks/acme"  # stockage ACME persistant (acme.json)\n` : ''}SUDO "\$MANAGER_IP" "cd \$REMOTE && docker stack deploy -c docker-stack.gen.yml vaks-pm"

echo "=== 6) Init Garage (S3 cluster) ==="
GARAGE_IPS="${garageHosts.map((n) => { const h = m.hosts.find((x) => x.name === n); return h ? h.ip : ''; }).filter(Boolean).join(' ')}"
for gip in \$GARAGE_IPS; do SUDO "\$gip" "for i in \\\$(seq 1 40); do docker ps -q -f name=vaks-pm_garage | grep -q . && break; sleep 5; done"; done
GNODES=""
for gip in \$GARAGE_IPS; do
  L="\$(SUDO "\$gip" "C=\\\$(docker ps -q -f name=vaks-pm_garage | head -1); I=\\\$(docker exec \\\$C /garage node id 2>/dev/null | grep -m1 -oE '^[0-9a-f]{64}'); A=\\\$(docker exec \\\$C /garage status 2>/dev/null | grep -oE '[0-9]+\\.[0-9.]+:3901' | head -1); echo \\\$I@\\\$A")"
  GNODES="\$GNODES \$L"
done
echo "  noeuds garage : \$GNODES"
GG="C=\\\$(docker ps -q -f name=vaks-pm_garage | head -1); docker exec \\\$C /garage"
for n in \$GNODES; do SUDO "\$MANAGER_IP" "\$GG node connect \$n" || true; done
sleep 3
zi=1; for n in \$GNODES; do SUDO "\$MANAGER_IP" "\$GG layout assign -z dc\$zi -c 100G \${n%@*}" || true; zi=\$((zi+1)); done
SUDO "\$MANAGER_IP" "\$GG layout apply --version 1" || true
SUDO "\$MANAGER_IP" "\$GG key import --yes -n vakspm-app \$S3_ACCESS \$S3_SECRET" || true
SUDO "\$MANAGER_IP" "\$GG key allow --create-bucket \$S3_ACCESS" || true
SUDO "\$MANAGER_IP" "docker service update --force vaks-pm_api" || true
echo "  Garage initialized; the API recreates its buckets on restart."

${provisionStep}

echo ""
echo "======================================================================"
echo "  SAVE THESE CREDENTIALS — they are shown only once"
echo "======================================================================"
echo "  S3 access key : \$S3_ACCESS"
echo "  S3 secret key : \$S3_SECRET"
echo "     (persisted git-ignored in \$ROOT/.s3-creds — back it up off this machine)"
echo ""
echo "  -> The DB / JWT secrets you set in .env.local are the source of truth — keep"
echo "     .env.local safe (changing them breaks the DB connection or every session)."
echo "  -> The org admin password was printed above under 'Provision' (if a tenant"
echo "     was created) — note it now; a change is forced at first login."
echo "  -> MFA / garage / other secrets live inside Swarm (encrypted); nothing to save."
echo "======================================================================"
echo ""
echo "=== Done. Check: docker stack ps vaks-pm ==="
echo "# full log of this deployment → $VAKS_DEPLOY_LOG"
`;

// ---------- multidc runbook (dispatcher) ----------
function multidcRunbook(mf, zones, primary) {
  const standby = zones.filter((z) => z !== primary);
  const L = [];
  L.push(`# Déploiement multi-datacenter (${zones.length} zones)`);
  L.push('');
  L.push('> ⚠️ **Préparé mais NON validé contre 2 clusters réels.** Adapter au réseau inter-DC (latence, VPN/peering, GeoDNS).');
  L.push('');
  L.push(`Zones : ${zones.map((z) => (z === primary ? `**${z}** (primary, R/W)` : `${z} (standby)`)).join(' · ')}`);
  L.push('');
  L.push('Modèle **actif/passif** : la zone primary porte le Postgres R/W ; chaque zone standby tourne un **Patroni standby cluster** (réplication async depuis la primary). Chaque zone = **son propre Swarm** (bundle `out/<zone>/`).');
  L.push('');
  L.push('## Ordre de déploiement');
  L.push('```bash');
  L.push(`# 1. Zone PRIMARY (${primary}) — cluster complet + bootstrap DB + provisioning`);
  L.push(`bash out/${primary}/deploy-ssh.sh`);
  for (const z of standby) {
    L.push(`# 2. Zone STANDBY (${z}) — Patroni clone la primary en async (ni bootstrap-db ni provisioning)`);
    L.push(`bash out/${z}/deploy-ssh.sh`);
  }
  L.push('```');
  L.push('');
  L.push('## Garage inter-DC');
  L.push(`Garage forme UN cluster sur toutes les zones : au \`garage layout assign\`, donner une **zone distincte par DC** (${zones.map((z) => `\`-z ${z}\``).join(' / ')}) pour répliquer entre datacenters. Voir le \`garage-cluster.md\` de chaque zone.`);
  L.push('');
  L.push('## Entrée (GeoDNS)');
  L.push('Mettre un **GeoDNS / LB global** devant les control planes : route l\'utilisateur vers la zone active. En actif/passif : DNS sur la primary, bascule sur une standby au sinistre.');
  L.push('');
  L.push('## Bascule DR (perte de la zone primary)');
  L.push('```bash');
  L.push('# Sur un nœud db de la zone standby à promouvoir :');
  L.push('patronictl -c /etc/patroni.yml edit-config   # retirer le bloc standby_cluster');
  L.push('# Patroni promeut le cluster en primary autonome (R/W). Puis basculer le GeoDNS.');
  L.push('# RPO = lag de réplication async ; RTO = promotion + TTL DNS.');
  L.push('```');
  return L.join('\n') + '\n';
}

// ---------- write ----------
const out = (f, content, exec = false) => {
  const p = resolve(outDir, f);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (exec) try { chmodSync(p, 0o755); } catch {}
};
mkdirSync(outDir, { recursive: true });
out('docker-stack.gen.yml', stack);
out('traefik-dynamic.gen.yml', traefik);
out('garage.gen.toml', garageToml);
out('labels.sh', labelLines.join('\n') + '\n', true);
out('secrets.md', secretsMd);
out('deploy-ssh.sh', deployOrch, true);
if (garageMulti) out('garage-cluster.md', garageClusterMd);
for (const h of m.hosts) out(`host-${h.name}.sh`, hostScript(h) + '\n', true);
// En single, deploy-ssh.sh SCP infra/bootstrap/ comme en HA, mais on embarque
// aussi 00-common.sh dans out/bootstrap/ pour le chemin MANUEL (out/ transféré
// seul sur la machine cible, sans le repo).
if (m.mode === 'single') {
  const here = dirname(fileURLToPath(import.meta.url));
  const common = readFileSync(join(here, '..', 'bootstrap', '00-common.sh'), 'utf8');
  out('bootstrap/00-common.sh', common, true);
}

console.log(`✓ generated in ${outDir}/: docker-stack.gen.yml, traefik-dynamic.gen.yml, garage.gen.toml, labels.sh, secrets.md, deploy-ssh.sh${garageMulti ? ', garage-cluster.md' : ''}, ${m.hosts.length} host-*.sh`);
if (warnings.length) console.log(`  (${warnings.length} warning(s) above)`);
