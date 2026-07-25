#!/usr/bin/env bash
# ============================================================================
# setup.sh — single entry point for the Vaks-PM deployment.
#
#   bash setup.sh                       # interactive wizard
#   bash setup.sh --manifest <file>     # non-interactive: (re)generate from a manifest
#   bash setup.sh --deploy              # wizard then run the orchestrator out/deploy-ssh.sh
#
# The wizard writes infra/cluster.json (git-ignored) then calls the generator
# (infra/cluster/generate.mjs) which produces out/. No app build happens here.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
command -v node >/dev/null || { echo "ERROR: node is required (for the generator)"; exit 1; }
[ -f .env.local ] && { set -a; . ./.env.local; set +a; } || true

DO_DEPLOY=0
MANIFEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2;;
    --deploy) DO_DEPLOY=1; shift;;
    *) echo "unknown option: $1"; exit 1;;
  esac
done

# Generate the artifacts and log the generator output to out/logs/ (timestamped).
# The manifest itself (infra/cluster.json) keeps the record of the choices.
gen() {
  mkdir -p out/logs
  local L="out/logs/generate-$(date +%Y%m%d-%H%M%S).log"
  echo "→ generation log: $L"
  node infra/cluster/generate.mjs --out out "$1" 2>&1 | tee "$L"
}

# --- Non-interactive mode ---
if [ -n "$MANIFEST" ]; then
  gen "$MANIFEST"
  [ "$DO_DEPLOY" = "1" ] && bash out/deploy-ssh.sh
  exit 0
fi

# --- Wizard ---
# Reads an answer and sanitizes it: strips CR (Windows paste) and leading/trailing
# whitespace, so a copy-pasted value with a stray space/newline can't slip into a
# hostname, IP or domain and break the deploy later.
ask() {
  local p="$1" d="${2:-}" v
  read -r -p "$p${d:+ [$d]}: " v
  v="${v:-$d}"
  v="${v//$'\r'/}"                       # drop carriage returns
  v="${v#"${v%%[![:space:]]*}"}"         # trim leading whitespace
  v="${v%"${v##*[![:space:]]}"}"         # trim trailing whitespace
  echo "$v"
}

echo "=== Vaks-PM — setup ==="
MODE="$(ask 'Mode (single|ha)' 'ha')"
IMGSRC="$(ask 'Images (ghcr|build) — ghcr = pull the pre-built public images, build = compile from source on the hosts (air-gapped)' 'ghcr')"
[ "$IMGSRC" = "build" ] || IMGSRC="ghcr"
LE_EMAIL="$(ask "Let's Encrypt contact email for a trusted TLS cert on the tenant domain(s) (blank = self-signed)" '')"
TLS_JSON=""; [ -n "$LE_EMAIL" ] && TLS_JSON="\"tls\": { \"acme\": { \"email\": \"$LE_EMAIL\" } },"

# Preflight: verify .env.local carries what the deploy will need for this mode,
# and tell the operator exactly what is missing rather than failing cryptically
# later inside out/deploy-ssh.sh.
check_env() {
  local mode="$1"; local -a miss=()
  [ -n "${VM_USER:-}" ] || miss+=("VM_USER — SSH/sudo user on the hosts")
  [ -n "${SSH_KEY:-}" ] || miss+=("SSH_KEY — path to the OpenSSH private key")
  { [ -n "${SSH_KEY:-}" ] && [ ! -f "$SSH_KEY" ]; } && miss+=("SSH_KEY file not found at: $SSH_KEY")
  if [ "$mode" = "ha" ]; then
    [ -n "${POSTGRES_PASSWORD:-}" ]            || miss+=("POSTGRES_PASSWORD — generate: openssl rand -hex 24")
    [ -n "${PATRONI_REPLICATION_PASSWORD:-}" ] || miss+=("PATRONI_REPLICATION_PASSWORD — generate: openssl rand -hex 24")
    [ -n "${PATRONI_SUPERUSER_PASSWORD:-}" ]   || miss+=("PATRONI_SUPERUSER_PASSWORD — generate: openssl rand -hex 24")
    [ -n "${JWT_ACCESS_SECRET:-}" ]            || miss+=("JWT_ACCESS_SECRET — generate: openssl rand -base64 48")
    [ -n "${JWT_REFRESH_SECRET:-}" ]           || miss+=("JWT_REFRESH_SECRET — generate: openssl rand -base64 48")
  fi
  if [ "${#miss[@]}" -gt 0 ]; then
    echo ""
    echo "✗ .env.local is incomplete for a '$mode' deployment. Missing / invalid:"
    for m in "${miss[@]}"; do echo "    - $m"; done
    echo ""
    echo "  Copy .env.example to .env.local and fill these. In HA the DB/JWT values"
    echo "  must be LITERAL (generate each once and paste the result — never \$(...))."
    echo "  Then re-run setup.sh."
    exit 1
  fi
  echo "✓ .env.local looks complete for a '$mode' deployment."
}
check_env "$MODE"

if [ "$MODE" = "single" ]; then
  IP="$(ask 'IP/hostname of the machine' "${VM_HOST1:-}")"
  BASE="$(ask 'Base domain ONLY (e.g. example.com — orgs are served at <slug>.<basedomain>, NOT the full host); blank for an IP/LAN test' '')"
  DBN="$(ask 'Database name' 'vakspm')"
  DM="$(ask 'deploymentMode (pooled|dedicated)' 'pooled')"
  # First organization — provisioned automatically at deploy (step 7), so no manual
  # org bootstrap is needed. Blank = create none now (bootstrap later by hand).
  echo ""
  echo "First organization (created automatically at deploy: org + admin, password shown once)."
  echo "  slug = short url-safe id ([a-z0-9-]); the org is reached at <slug>.${BASE:-<host>}."
  TSLUG="$(ask 'organization slug (blank = none)' '')"
  TEN_JSON=""
  if [ -n "$TSLUG" ]; then
    if echo "$TSLUG" | grep -qE '^[a-z0-9-]+$'; then
      TADMIN="$(ask "  first admin email for $TSLUG" "admin@$TSLUG.local")"
      TEN_JSON="
    { \"slug\": \"$TSLUG\", \"domain\": \"$TSLUG.$BASE\", \"profile\": \"$DM\", \"ha\": false, \"placement\": \"auto\", \"adminEmail\": \"$TADMIN\" }"
    else
      echo "  ✗ invalid slug \"$TSLUG\" (lowercase, digits, hyphens only) — no tenant created."
    fi
  fi
  cat > infra/cluster.json <<JSON
{
  "mode": "single",
  "baseDomain": "$BASE",
  "dbName": "$DBN",
  "deploymentMode": "$DM",
  "imageSource": "$IMGSRC",
  $TLS_JSON
  "sshKey": "\${SSH_KEY}",
  "hosts": [ { "name": "node1", "ip": "$IP", "sshUser": "\${VM_USER}", "roles": ["manager","db","etcd","cp","app"] } ],
  "tenants": [$TEN_JSON
  ]
}
JSON
  echo "→ infra/cluster.json written (single)."
  gen infra/cluster.json
  echo
  echo "Artifacts in out/. To deploy: bash out/deploy-ssh.sh  (or re-run: bash setup.sh --manifest infra/cluster.json --deploy)"
  [ "$DO_DEPLOY" = "1" ] && bash out/deploy-ssh.sh
  exit 0
fi

# --- HA ---
N="$(ask 'Number of hosts' '3')"
BASE="$(ask 'Base domain ONLY (e.g. example.com — orgs are served at <slug>.<basedomain>, NOT the full host)' 'vaks-pm.com')"
DBN="$(ask 'Database name' 'vakspm')"
echo ""
echo "Tip: press Enter at any prompt to keep the value shown in [brackets]."
echo ""
echo "The host NAME must be the server's real hostname (uname -n) — it is used"
echo "  for the Swarm node labels, Patroni and etcd. If your servers are already"
echo "  named host1/2/3, keep the defaults; otherwise set the hostname (e.g. srv-prod-01)."
echo "Roles per host: manager,db,etcd,cp,app (cp = control plane, >=2 required; etcd odd >=3)."
HOSTS_JSON=""
for i in $(seq 1 "$N"); do
  echo "--- host $i ---"
  while :; do
    NAME="$(ask "  name (server hostname)" "host$i")"
    if [ -z "$NAME" ]; then echo "    ✗ empty name"; continue; fi
    if echo "$NAME" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "    ✗ that looks like an IP — the name must be the HOSTNAME (the IP is asked right after)"; continue
    fi
    if [ "$NAME" = "yes" ] || [ "$NAME" = "no" ] || [ "$NAME" = "y" ] || [ "$NAME" = "n" ]; then
      echo "    ✗ this is not a yes/no question — it's the hostname (e.g. host1, srv-prod-01)"; continue
    fi
    break
  done
  while :; do
    IP="$(ask "  ip" "")"
    if [ -z "$IP" ]; then echo "    ✗ ip is required"; continue; fi
    if ! echo "$IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "    ✗ invalid ip format (e.g. 192.168.1.10)"; continue
    fi
    break
  done
  ROLES="$(ask "  roles (csv)" "$([ "$i" -le 2 ] && echo 'manager,db,etcd,cp,app' || echo 'worker,db,etcd,app')")"
  RJSON="$(echo "$ROLES" | awk -F, '{out="";for(j=1;j<=NF;j++){gsub(/ /,"",$j);out=out (j>1?",":"") "\"" $j "\""}; print out}')"
  SEP=""; [ -n "$HOSTS_JSON" ] && SEP=","
  HOSTS_JSON="${HOSTS_JSON}${SEP}
    { \"name\": \"$NAME\", \"ip\": \"$IP\", \"sshUser\": \"\${VM_USER}\", \"roles\": [$RJSON] }"
done
REDIS_H="$(ask 'Host for redis (single instance)' 'host1')"
GARAGE_H="$(ask 'Hosts for garage (csv; >=2 for S3 HA)' 'host1,host2,host3')"
GARAGE_JSON="$(echo "$GARAGE_H" | awk -F, '{out="";for(j=1;j<=NF;j++){gsub(/ /,"",$j);out=out (j>1?",":"") "\"" $j "\""}; print out}')"
VIP="$(ask 'keepalived VIP on the cp hosts (blank = DNS round-robin)' '')"

echo ""
echo "Tenants — each tenant has a SLUG (short url-safe id: a-z, 0-9, hyphens)."
echo "  The slug is used for: subdomain <slug>.$BASE, database name ${DBN}_<slug>,"
echo "  and — in dedicated mode — to name the services (api-<slug>, worker-<slug>)."
echo "  Valid examples: acme, globex, prod-org, client42 (no dot, no space, no uppercase)."
echo "Input: comma-separated slugs, or Enter to create no tenant now."
TLIST="$(ask 'slugs (csv)' '')"
TEN_JSON=""
if [ -n "$TLIST" ]; then
  IFS=',' read -ra TARR <<< "$TLIST"
  for t in "${TARR[@]}"; do
    t="$(echo "$t" | tr -d ' ')"
    if ! echo "$t" | grep -qE '^[a-z0-9-]+$'; then
      echo "  ✗ invalid slug \"$t\" — allowed: lowercase, digits, hyphens only. Tenant skipped."
      continue
    fi
    PROF="$(ask "  $t : profile (pooled|dedicated)" 'pooled')"
    HA='false'
    if [ "$PROF" = "dedicated" ]; then HA="$(ask "  $t : HA (true|false)" 'true')"; fi
    TADMIN="$(ask "  $t : first admin email" "admin@$t.local")"
    SEP=""; [ -n "$TEN_JSON" ] && SEP=","
    TEN_JSON="${TEN_JSON}${SEP}
    { \"slug\": \"$t\", \"domain\": \"$t.$BASE\", \"profile\": \"$PROF\", \"ha\": $HA, \"placement\": \"auto\", \"adminEmail\": \"$TADMIN\" }"
  done
fi

echo ""
echo "=== Encryption (DORA) ==="
echo "Data-volume encryption runs BEFORE PostgreSQL initializes its data"
echo "  (LUKS2 + Tang, network-bound key release). Recommended."
DISK="$(ask 'Encrypt data volumes at rest (LUKS/Tang)? (yes|no)' 'yes')"
PGV="$(ask 'Strictly verify the database TLS certificate against an internal CA? (yes|no)' 'no')"
DL=true;  case "$DISK" in no|n|non|false|N|No) DL=false;; esac
PV=false; PG_CA=""; PG_MODE="verify-ca"
case "$PGV" in yes|y|true|Yes|oui|O) PV=true;; esac
if [ "$PV" = "true" ]; then
  echo "  The CA (PEM) must live under infra/certs/ (only that folder is copied to the hosts)."
  PG_CA="$(ask '  path to the CA PEM' 'infra/certs/pg-ca.crt')"
  PG_MODE="$(ask '  mode (verify-ca recommended via HAProxy | verify-full)' 'verify-ca')"
fi
ENC_JSON="\"encryption\": { \"diskLuks\": $DL, \"pgVerify\": $PV"
[ "$PV" = "true" ] && ENC_JSON="$ENC_JSON, \"pgCaFile\": \"$PG_CA\", \"pgTlsMode\": \"$PG_MODE\""
ENC_JSON="$ENC_JSON }"

cat > infra/cluster.json <<JSON
{
  "mode": "ha",
  "baseDomain": "$BASE",
  "dbName": "$DBN",
  "deploymentMode": "pooled",
  "imageSource": "$IMGSRC",
  $TLS_JSON
  $ENC_JSON,
  "sshKey": "\${SSH_KEY}",
  "hosts": [$HOSTS_JSON
  ],
  "controlPlane": { "vip": $([ -n "$VIP" ] && echo "\"$VIP\"" || echo null) },
  "infraPlacement": { "redis": "$REDIS_H", "garage": [$GARAGE_JSON] },
  "tenants": [$TEN_JSON
  ]
}
JSON
echo "→ infra/cluster.json written (ha, $N hosts)."

gen infra/cluster.json
echo
echo "Artifacts in out/. To deploy: bash out/deploy-ssh.sh  (or re-run: bash setup.sh --manifest infra/cluster.json --deploy)"
[ "$DO_DEPLOY" = "1" ] && bash out/deploy-ssh.sh
