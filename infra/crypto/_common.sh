#!/usr/bin/env bash
# Helpers partagés par les scripts de retrofit chiffrement HOST-SIDE
# (preflight.sh, enable-luks.sh, enable-pg-tls.sh, …). Ces scripts tournent EN
# ROOT sur un hôte du cluster ; l'orchestrateur operator-side `retrofit.mjs` les
# copie puis les invoque via SSH. Ton calqué sur `infra/backup/_common.sh`.
#
# Convention de sortie : les lignes machine-lisibles pour l'orchestrateur sont
# préfixées `RESULT:` (une par ligne, `clé=valeur`), le reste est du log humain
# sur stderr → l'orchestrateur parse stdout, l'humain lit stderr.
set -euo pipefail

# ─── Constantes partagées avec le bootstrap (NE PAS diverger de 18-luks-data.sh) ─
# Un volume LUKS = { fichier backing, nom de mapper, point de montage }.
PG_LUKS_FILE="/var/lib/vaks-pgdata.luks"
PG_LUKS_MAPPER="pgdata_crypt"
PG_DATA_DIR="/var/lib/postgresql/17/main"

GARAGE_LUKS_FILE="/var/lib/vaks-garage.luks"
GARAGE_LUKS_MAPPER="garage_crypt"
GARAGE_DATA_DIR="/srv/vaks/garage"

PATRONI_CONF="${PATRONI_CONF:-/etc/patroni.yml}"

# ─── Logging (humain → stderr) ────────────────────────────────────────────────
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log()  { echo "[$(_ts)] $*" >&2; }
warn() { echo "[$(_ts)] WARN: $*" >&2; }
die()  { echo "[$(_ts)] ERREUR: $*" >&2; exit 1; }

# Résultat machine-lisible (stdout) pour l'orchestrateur.
result() { echo "RESULT:$*"; }

# ─── Garde-fous ───────────────────────────────────────────────────────────────
require_root() { [[ "$(id -u)" -eq 0 ]] || die "doit tourner en root (sudo)"; }
have()         { command -v "$1" >/dev/null 2>&1; }
require_cmd()  { have "$1" || die "commande requise absente: $1 (apt install $1)"; }

# Confirmation interactive, court-circuitée par FORCE=1 (l'orchestrateur passe
# --force → FORCE=1 pour un run non interactif ; documenté comme non sûr).
confirm() {
  local prompt="${1:-Continuer ?}"
  if [[ "${FORCE:-0}" == "1" ]]; then log "confirm() court-circuité (FORCE=1): $prompt"; return 0; fi
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || die "annulé par l'opérateur"
}

# ─── État Patroni (utilisé par preflight + enable-luks) ───────────────────────
# Rôle du nœud local ('leader'|'replica'|'unknown'). S'appuie sur le nom d'hôte
# tel que Patroni le voit (Member == hostname par défaut).
patroni_json() { patronictl -c "$PATRONI_CONF" list -f json 2>/dev/null || echo '[]'; }

patroni_local_role() {
  local host; host="$(hostname)"
  patroni_json | python3 -c '
import json,sys
host=sys.argv[1]
try: rows=json.load(sys.stdin)
except Exception: rows=[]
for r in rows:
    if r.get("Member")==host:
        role=(r.get("Role") or "").lower()
        print("leader" if "leader" in role else "replica"); break
else:
    print("unknown")
' "$host"
}

# Le cluster a-t-il exactement 1 leader et tous les membres "running", lag ≤ seuil ?
# Écrit un résumé et renvoie 0 (sain) / 1 (non sain). LAG_MAX en octets (déf 8 Mo).
patroni_cluster_healthy() {
  local lag_max="${LAG_MAX:-8388608}"
  patroni_json | LAG_MAX="$lag_max" python3 -c '
import json,os,sys
lag_max=int(os.environ.get("LAG_MAX","8388608"))
try: rows=json.load(sys.stdin)
except Exception: rows=[]
if not rows:
    print("patroni: aucune donnee (cluster injoignable)",file=sys.stderr); sys.exit(1)
leaders=[r for r in rows if "leader" in (r.get("Role") or "").lower()]
bad=[]
for r in rows:
    m=str(r.get("Member"))
    st=(r.get("State") or "").lower()
    if st not in ("running","streaming"): bad.append(m+"="+st)
    lag=r.get("Lag in MB")
    if isinstance(lag,(int,float)) and lag*1048576>lag_max: bad.append(m+" lag="+str(lag)+"MB")
ok = len(leaders)==1 and not bad
print("leaders="+str(len(leaders))+" membres="+str(len(rows))+" anomalies="+(",".join(bad) if bad else "aucune"),file=sys.stderr)
sys.exit(0 if ok else 1)
'
}

# ─── Espace disque ────────────────────────────────────────────────────────────
# Octets libres sur le FS portant $1 (le répertoire parent où vivra le .luks).
fs_free_bytes()  { df -PB1 "$(dirname "$1")" | awk 'NR==2{print $4}'; }
# Taille (octets) d'un répertoire de données existant.
dir_size_bytes() { du -sB1 "$1" 2>/dev/null | awk '{print $1}'; }

# Un volume LUKS de $data_dir tiendra-t-il, avec marge ? factor par défaut 1.5.
disk_headroom_ok() {
  local data_dir="$1" luks_file="$2" factor="${DISK_FACTOR:-15}" # dixièmes (15=1.5×)
  local used free need
  used="$(dir_size_bytes "$data_dir")"; used="${used:-0}"
  free="$(fs_free_bytes "$luks_file")"; free="${free:-0}"
  need=$(( used * factor / 10 ))
  log "disque $data_dir: utilisé=$((used/1048576))Mo libre=$((free/1048576))Mo requis≈$((need/1048576))Mo"
  [[ "$free" -ge "$need" ]]
}

# Un volume LUKS est-il DÉJÀ en place pour ce store (fichier + mapper + monté) ?
luks_already_present() {
  local luks_file="$1" mapper="$2" mnt="$3"
  [[ -f "$luks_file" ]] && [[ -b "/dev/mapper/$mapper" ]] && mountpoint -q "$mnt"
}

# Un pair Tang est-il joignable ? (advertisement HTTP)
tang_reachable() { curl -fsS -m 5 "http://$1:7500/adv" >/dev/null 2>&1; }
