#!/usr/bin/env node
// Orchestrateur day-2 du chiffrement — l'analogue de `infra/cluster/generate.mjs`
// pour ACTIVER le chiffrement sur un cluster DÉJÀ déployé (non chiffré au départ).
//
// Tourne sur la machine de pilotage (SSH par clé vers les hôtes, sudo par mot de
// passe — même schéma que generate.mjs). Copie les helpers HOST-SIDE d'infra/crypto/
// sur chaque hôte, lance le preflight, puis pilote chaque couche dans l'ordre de
// risque. NE bundle PAS les couches à downtime dans `all`.
//
//   node infra/crypto/retrofit.mjs <commande> [options]
//
// Commandes (Tier A — sûr, zéro-downtime) :
//   preflight                    garde de disponibilité sur les hôtes db
//   enable-backup-encryption     pose BACKUP_AGE_RECIPIENT, vérifie le prochain backup
//   enable-pg-tls                ssl=on Patroni (rolling) + flip app PG_TLS
//   enable-luks [--pg] [--garage] migration LUKS node-by-node (réplica d'abord)
//   all                          = backup-encryption + pg-tls + luks (Tier A UNIQUEMENT)
//
// Commandes (Tier B — fenêtre de maintenance, exigent --window) :
//   enable-overlay-ipsec         stack rm + redeploy + re-peer Garage (~1-2 min downtime)
//   rebuild-etcd-tls             rebuild etcd FRESH en https (jamais member-update live)
//
// Options : --dry-run  --force (non interactif)  --window  --hosts a,b,c
//           --recipient <age1…>  (enable-backup-encryption)
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REMOTE_DIR = '/tmp/vaks-crypto';

// ─── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (f) => argv.includes(f);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = has('--dry-run');
const FORCE = has('--force');
const WINDOW = has('--window');

const die = (m) => { console.error(`\x1b[31mERREUR:\x1b[0m ${m}`); process.exit(1); };
const log = (m) => console.error(`\x1b[36m[retrofit]\x1b[0m ${m}`);

// ─── Chargement .env.local (parse maison, pas de sed global) ───────────────────
function loadEnv() {
  const p = join(REPO, '.env.local');
  if (!existsSync(p)) die('.env.local introuvable à la racine du repo');
  const env = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, i).trim()] = v;
  }
  return env;
}
const ENV = loadEnv();
const VM_USER = ENV.VM_USER || die('VM_USER manquant dans .env.local');
const VM_PASS = ENV.VM_PASS || '';
const SSH_KEY = ENV.SSH_KEY || '';
const HOSTS = (opt('--hosts') || [ENV.VM_HOST1, ENV.VM_HOST2, ENV.VM_HOST3].filter(Boolean).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!HOSTS.length) die('aucun hôte (VM_HOST1..3 dans .env.local ou --hosts)');

// ─── Helpers SSH / sudo / scp ───────────────────────────────────────────────────
const sshOpts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
if (SSH_KEY) sshOpts.unshift('-i', SSH_KEY);

function ssh(host, remoteCmd, { capture = true } = {}) {
  const args = ['-n', ...sshOpts, `${VM_USER}@${host}`, remoteCmd];
  const r = spawnSync('ssh', args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

// Exécute une commande en root : on encode en base64 pour éviter tout enfer de
// quoting (miroir du ShWrap de generate.mjs). Le mot de passe alimente `sudo -S`.
function sudo(host, remoteCmd, o = {}) {
  const b64 = Buffer.from(remoteCmd, 'utf8').toString('base64');
  const wrapped = `echo '${VM_PASS}' | sudo -S -p '' bash -c 'echo ${b64} | base64 -d | bash'`;
  return ssh(host, wrapped, o);
}

function scpDir(host, localDir, remoteDir) {
  const args = [...sshOpts, '-r', localDir, `${VM_USER}@${host}:${remoteDir}`];
  const r = spawnSync('scp', args, { encoding: 'utf8', stdio: 'pipe' });
  if ((r.status ?? 1) !== 0) die(`scp vers ${host} échoué: ${r.stderr || r.stdout}`);
}

// Parse les lignes RESULT:clé=valeur émises par les scripts host-side.
function parseResults(out) {
  const res = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^RESULT:([^=]+)=(.*)$/);
    if (m) res[m[1].trim()] = m[2].trim();
  }
  return res;
}

async function confirmWindow(label) {
  if (FORCE) return;
  if (!WINDOW) die(`${label} exige une fenêtre de maintenance : relancer avec --window`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ans = await new Promise((r) => rl.question(`${label} implique une INTERRUPTION de service. Confirmer ? [y/N] `, r));
  rl.close();
  if (ans.trim().toLowerCase() !== 'y') die('annulé');
}

// Pousse infra/crypto/ sur un hôte (idempotent) et renvoie le chemin distant.
function pushHelpers(host) {
  if (DRY) { log(`[dry-run] scp infra/crypto → ${host}:${REMOTE_DIR}`); return REMOTE_DIR; }
  sudo(host, `rm -rf ${REMOTE_DIR}`);
  scpDir(host, join(HERE), REMOTE_DIR);
  sudo(host, `chmod +x ${REMOTE_DIR}/*.sh`);
  return REMOTE_DIR;
}

// ─── Découverte des rôles Patroni (pour le séquencement réplica-first du LUKS) ──
function patroniRoles() {
  // On interroge depuis le 1er hôte : patronictl donne une vue cluster complète.
  const r = sudo(HOSTS[0], `patronictl -c /etc/patroni.yml list -f json 2>/dev/null || echo '[]'`);
  let rows = [];
  try { rows = JSON.parse((r.out.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { rows = []; }
  const leader = rows.find((x) => /leader/i.test(x.Role || ''))?.Member || null;
  const members = rows.map((x) => x.Member);
  return { leader, members, rows };
}

// Map "Member" Patroni → hôte SSH. Par défaut Member == hostname ; on résout le
// hostname de chaque hôte SSH pour faire le lien (robuste si IP ≠ hostname).
function memberToHostMap() {
  const map = {};
  for (const h of HOSTS) {
    const r = ssh(h, 'hostname');
    if (r.code === 0) map[r.out.trim()] = h;
  }
  return map;
}

// ─── Preflight ──────────────────────────────────────────────────────────────────
function runPreflight(host, flags) {
  pushHelpers(host);
  const peer = peerTangFor(host);
  const cmd = `PEER_TANG_IPS='${peer}' bash ${REMOTE_DIR}/preflight.sh ${flags.join(' ')}`;
  if (DRY) { log(`[dry-run] preflight ${host}: ${flags.join(' ')}`); return { preflight: 'PASS' }; }
  const r = sudo(host, cmd);
  process.stderr.write(r.err);
  const res = parseResults(r.out);
  log(`preflight ${host}: ${res.preflight || '??'} (${Object.entries(res).filter(([k]) => k !== 'preflight').map(([k, v]) => `${k}=${v}`).join(' ')})`);
  return res;
}

// IPs Tang des PAIRS d'un hôte (tous les autres hôtes db) — jamais soi-même.
function peerTangFor(host) { return HOSTS.filter((h) => h !== host).join(','); }

// ─── Dispatch des couches ────────────────────────────────────────────────────────
async function layerPreflight() {
  let ok = true;
  for (const h of HOSTS) { const r = runPreflight(h, ['--backup']); if (r.preflight !== 'PASS') ok = false; }
  if (!ok) die('preflight FAIL sur au moins un hôte — refuser le retrofit');
  log('preflight PASS sur tous les hôtes');
}

async function layerBackupEncryption() {
  const recipient = opt('--recipient');
  if (!recipient) die('enable-backup-encryption exige --recipient <age1…|ssh-…|chemin>');
  for (const h of HOSTS) {
    pushHelpers(h);
    if (DRY) { log(`[dry-run] enable-backup-encryption ${h} recipient=${recipient}`); continue; }
    const r = sudo(h, `BACKUP_AGE_RECIPIENT='${recipient}' FORCE=${FORCE ? 1 : 0} bash ${REMOTE_DIR}/enable-backup-encryption.sh`);
    process.stderr.write(r.err);
    log(`backup-encryption ${h}: ${parseResults(r.out).backup_encryption || (r.code === 0 ? 'ok' : 'échec')}`);
    if (r.code !== 0) die(`enable-backup-encryption a échoué sur ${h}`);
  }
}

async function layerPgTls() {
  // ssl=on est piloté au niveau cluster : on lance le script sur le leader, il
  // fait patronictl edit-config + restart rolling ; puis flip app PG_TLS séparé.
  const { leader } = patroniRoles();
  const map = memberToHostMap();
  const leaderHost = map[leader] || HOSTS[0];
  pushHelpers(leaderHost);
  if (DRY) { log(`[dry-run] enable-pg-tls via leader ${leaderHost}`); return; }
  const r = sudo(leaderHost, `FORCE=${FORCE ? 1 : 0} bash ${REMOTE_DIR}/enable-pg-tls.sh --server`);
  process.stderr.write(r.err);
  if (r.code !== 0) die(`enable-pg-tls (serveur) a échoué sur ${leaderHost}`);
  log('PG TLS serveur activé (ssl=on). Flip app PG_TLS=1 : à faire via le manifest + rolling api/worker (voir docs).');
}

async function layerLuks() {
  const doPg = has('--pg') || (!has('--pg') && !has('--garage')); // défaut = pg
  const doGarage = has('--garage');
  await layerPreflight();

  const { leader, rows } = patroniRoles();
  if (!leader) die('leader Patroni introuvable — abandon');
  const map = memberToHostMap();
  const replicas = rows.map((x) => x.Member).filter((m) => m !== leader);
  log(`LUKS: leader=${leader} réplicas=[${replicas.join(', ')}]`);

  if (doPg) {
    // Réplicas d'abord (rebase sur volume chiffré), puis switchover, puis ex-leader.
    for (const m of replicas) {
      const h = map[m]; if (!h) { warnMissing(m); continue; }
      await luksNode(h, m, '--pg');
    }
    if (!DRY) {
      log(`switchover Patroni vers un réplica chiffré (leader actuel ${leader})`);
      sudo(map[leader] || HOSTS[0], `patronictl -c /etc/patroni.yml switchover --force >/dev/null 2>&1 || patronictl -c /etc/patroni.yml switchover --candidate ${replicas[0]} --force`);
    }
    const leaderHost = map[leader]; if (leaderHost) await luksNode(leaderHost, leader, '--pg');
  }
  if (doGarage) {
    for (const h of HOSTS) await luksNode(h, h, '--garage'); // Garage: un nœud à la fois
  }
  log('LUKS terminé. Un reboot d’un nœud doit auto-déverrouiller (Clevis/Tang) et rejoindre.');
}

function warnMissing(m) { log(`\x1b[33mmembre ${m} sans hôte SSH mappé — sauté\x1b[0m`); }

async function luksNode(host, member, storeFlag) {
  const peer = peerTangFor(host);
  log(`LUKS ${storeFlag} sur ${member} (${host})`);
  if (DRY) { log(`[dry-run] enable-luks ${storeFlag} @ ${host}`); return; }
  const r = sudo(host, `PEER_TANG_IPS='${peer}' FORCE=${FORCE ? 1 : 0} bash ${REMOTE_DIR}/enable-luks.sh ${storeFlag}`);
  process.stderr.write(r.err);
  const res = parseResults(r.out);
  if (r.code !== 0) die(`enable-luks ${storeFlag} a échoué sur ${host} (${res.luks || 'voir logs'})`);
  log(`  → ${host}: ${res.luks || 'ok'}`);
}

async function layerOverlay() {
  await confirmWindow('enable-overlay-ipsec');
  pushHelpers(HOSTS[0]);
  if (DRY) { log('[dry-run] enable-overlay-ipsec (stack rm + redeploy sur le manager)'); return; }
  const r = sudo(HOSTS[0], `FORCE=1 bash ${REMOTE_DIR}/enable-overlay-ipsec.sh`);
  process.stderr.write(r.err);
  if (r.code !== 0) die('enable-overlay-ipsec a échoué');
  log('Overlay IPsec activé. Vérifier le re-peer Garage (garage-reconnect) et l’app 200.');
}

async function layerEtcd() {
  await confirmWindow('rebuild-etcd-tls');
  pushHelpers(HOSTS[0]);
  if (DRY) { log('[dry-run] rebuild-etcd-tls (rebuild FRESH https — jamais member-update live)'); return; }
  const r = sudo(HOSTS[0], `FORCE=1 HOSTS='${HOSTS.join(',')}' bash ${REMOTE_DIR}/rebuild-etcd-tls.sh`);
  process.stderr.write(r.err);
  if (r.code !== 0) die('rebuild-etcd-tls a échoué');
}

// ─── Main ────────────────────────────────────────────────────────────────────────
const COMMANDS = {
  'preflight': layerPreflight,
  'enable-backup-encryption': layerBackupEncryption,
  'enable-pg-tls': layerPgTls,
  'enable-luks': layerLuks,
  'enable-overlay-ipsec': layerOverlay,
  'rebuild-etcd-tls': layerEtcd,
  'all': async () => { // Tier A UNIQUEMENT
    log('Tier A (sûr, zéro-downtime) : backup-encryption → pg-tls → luks');
    if (opt('--recipient')) await layerBackupEncryption();
    else log('(--recipient absent → backup-encryption sautée)');
    await layerPgTls();
    await layerLuks();
  },
};

if (!cmd || !COMMANDS[cmd]) {
  console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(cmd ? 1 : 0);
}
log(`hôtes: ${HOSTS.join(', ')}${DRY ? ' (DRY-RUN)' : ''}`);
COMMANDS[cmd]().catch((e) => die(e?.message || String(e)));
