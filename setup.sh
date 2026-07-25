#!/usr/bin/env bash
# ============================================================================
# setup.sh — point d'entrée unique du déploiement Vaks-PM.
#
#   bash setup.sh                       # wizard interactif
#   bash setup.sh --manifest <file>     # non-interactif : (re)génère depuis un manifeste
#   bash setup.sh --deploy              # wizard puis lance l'orchestrateur out/deploy-ssh.sh
#
# Le wizard écrit infra/cluster.json (git-ignoré) puis appelle le générateur
# (infra/cluster/generate.mjs) qui produit out/. Aucun build d'app ici.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
command -v node >/dev/null || { echo "ERREUR: node requis (pour le générateur)"; exit 1; }
[ -f .env.local ] && { set -a; . ./.env.local; set +a; } || true

DO_DEPLOY=0
MANIFEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2;;
    --deploy) DO_DEPLOY=1; shift;;
    *) echo "option inconnue: $1"; exit 1;;
  esac
done

# Génère les artefacts et journalise la sortie du générateur dans out/logs/
# (horodaté). Le manifeste lui-même (infra/cluster.json) garde la trace des choix.
gen() {
  mkdir -p out/logs
  local L="out/logs/generate-$(date +%Y%m%d-%H%M%S).log"
  echo "→ log de génération : $L"
  node infra/cluster/generate.mjs --out out "$1" 2>&1 | tee "$L"
}

# --- Mode non-interactif ---
if [ -n "$MANIFEST" ]; then
  gen "$MANIFEST"
  [ "$DO_DEPLOY" = "1" ] && bash out/deploy-ssh.sh
  exit 0
fi

# --- Wizard ---
ask() { local p="$1" d="${2:-}" v; read -r -p "$p${d:+ [$d]}: " v; echo "${v:-$d}"; }

echo "=== Vaks-PM — setup ==="
MODE="$(ask 'Mode (single|ha)' 'ha')"
IMGSRC="$(ask 'Images (ghcr|build) — ghcr = tirer les images publiques pré-buildées, build = compiler depuis les sources sur les hôtes (air-gapped)' 'ghcr')"
[ "$IMGSRC" = "build" ] || IMGSRC="ghcr"

if [ "$MODE" = "single" ]; then
  IP="$(ask 'IP/hostname de la machine' "${VM_HOST1:-}")"
  BASE="$(ask 'Domaine racine (<slug>.<domaine>), vide si aucun' '')"
  DBN="$(ask 'Nom de base' 'vakspm')"
  DM="$(ask 'deploymentMode (pooled|dedicated)' 'pooled')"
  cat > infra/cluster.json <<JSON
{
  "mode": "single",
  "baseDomain": "$BASE",
  "dbName": "$DBN",
  "deploymentMode": "$DM",
  "imageSource": "$IMGSRC",
  "sshKey": "\${SSH_KEY}",
  "hosts": [ { "name": "node1", "ip": "$IP", "sshUser": "\${VM_USER}", "roles": ["manager","db","etcd","cp","app"] } ],
  "tenants": []
}
JSON
  echo "→ infra/cluster.json écrit (single)."
  gen infra/cluster.json
  echo
  echo "Artefacts dans out/. Pour déployer : bash out/deploy-ssh.sh  (ou relance: bash setup.sh --manifest infra/cluster.json --deploy)"
  [ "$DO_DEPLOY" = "1" ] && bash out/deploy-ssh.sh
  exit 0
fi

# --- HA ---
N="$(ask 'Nombre de hosts' '3')"
BASE="$(ask 'Domaine racine (<slug>.<domaine>)' 'vaks-pm.com')"
DBN="$(ask 'Nom de base' 'vakspm')"
echo ""
echo "Astuce : appuie sur Entrée à chaque prompt pour garder la valeur entre [crochets]."
echo ""
echo "Le NOM du host doit être le hostname réel du serveur (uname -n) — il sert"
echo "  pour les labels Swarm, Patroni et etcd. Si tes serveurs s'appellent déjà"
echo "  host1/2/3, garde les défauts ; sinon mets le hostname (ex: srv-prod-01)."
echo "Rôles par host : manager,db,etcd,cp,app (cp = control plane, >=2 requis ; etcd impair >=3)."
HOSTS_JSON=""
for i in $(seq 1 "$N"); do
  echo "--- host $i ---"
  while :; do
    NAME="$(ask "  nom (hostname du serveur)" "host$i")"
    if [ -z "$NAME" ]; then echo "    ✗ nom vide"; continue; fi
    if echo "$NAME" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "    ✗ ça ressemble à une IP — le nom doit être le HOSTNAME (l'IP est demandée juste après)"; continue
    fi
    if [ "$NAME" = "oui" ] || [ "$NAME" = "non" ] || [ "$NAME" = "y" ] || [ "$NAME" = "n" ]; then
      echo "    ✗ ce n'est pas une question oui/non — c'est le hostname (ex: host1, srv-prod-01)"; continue
    fi
    break
  done
  while :; do
    IP="$(ask "  ip" "")"
    if [ -z "$IP" ]; then echo "    ✗ ip obligatoire"; continue; fi
    if ! echo "$IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "    ✗ format ip invalide (ex: 192.168.1.10)"; continue
    fi
    break
  done
  ROLES="$(ask "  rôles (csv)" "$([ "$i" -le 2 ] && echo 'manager,db,etcd,cp,app' || echo 'worker,db,etcd,app')")"
  RJSON="$(echo "$ROLES" | awk -F, '{out="";for(j=1;j<=NF;j++){gsub(/ /,"",$j);out=out (j>1?",":"") "\"" $j "\""}; print out}')"
  SEP=""; [ -n "$HOSTS_JSON" ] && SEP=","
  HOSTS_JSON="${HOSTS_JSON}${SEP}
    { \"name\": \"$NAME\", \"ip\": \"$IP\", \"sshUser\": \"\${VM_USER}\", \"roles\": [$RJSON] }"
done
REDIS_H="$(ask 'Host pour redis (mono-instance)' 'host1')"
GARAGE_H="$(ask 'Hosts pour garage (csv ; >=2 pour la HA du S3)' 'host1,host2,host3')"
GARAGE_JSON="$(echo "$GARAGE_H" | awk -F, '{out="";for(j=1;j<=NF;j++){gsub(/ /,"",$j);out=out (j>1?",":"") "\"" $j "\""}; print out}')"
VIP="$(ask 'VIP keepalived sur les hosts cp (vide = DNS round-robin)' '')"

echo ""
echo "Tenants — chaque tenant a un SLUG (identifiant court url-safe : a-z, 0-9, tirets)."
echo "  Le slug sert pour : sous-domaine <slug>.$BASE, nom de base ${DBN}_<slug>,"
echo "  et — en mode dédié — pour nommer les services (api-<slug>, worker-<slug>)."
echo "  Exemples valides : acme, globex, prod-org, client42 (pas de point, pas d'espace, pas de MAJ)."
echo "Saisie : slugs séparés par des virgules, ou Entrée pour ne créer aucun tenant maintenant."
TLIST="$(ask 'slugs (csv)' '')"
TEN_JSON=""
if [ -n "$TLIST" ]; then
  IFS=',' read -ra TARR <<< "$TLIST"
  for t in "${TARR[@]}"; do
    t="$(echo "$t" | tr -d ' ')"
    if ! echo "$t" | grep -qE '^[a-z0-9-]+$'; then
      echo "  ✗ slug invalide « $t » — autorisés : minuscules, chiffres, tirets uniquement. Tenant ignoré."
      continue
    fi
    PROF="$(ask "  $t : profile (pooled|dedicated)" 'pooled')"
    HA='false'
    if [ "$PROF" = "dedicated" ]; then HA="$(ask "  $t : HA (true|false)" 'true')"; fi
    SEP=""; [ -n "$TEN_JSON" ] && SEP=","
    TEN_JSON="${TEN_JSON}${SEP}
    { \"slug\": \"$t\", \"domain\": \"$t.$BASE\", \"profile\": \"$PROF\", \"ha\": $HA, \"placement\": \"auto\" }"
  done
fi

echo ""
echo "=== Chiffrement (DORA) ==="
echo "Le chiffrement des volumes de données s'exécute AVANT que PostgreSQL initialise"
echo "  ses données (LUKS2 + Tang, libération de clé liée au réseau). Recommandé."
DISK="$(ask 'Chiffrer les volumes de données au repos (LUKS/Tang) ? (oui|non)' 'oui')"
PGV="$(ask 'Vérifier strictement le certificat TLS de la base avec une CA interne ? (oui|non)' 'non')"
DL=true;  case "$DISK" in non|n|no|false|N) DL=false;; esac
PV=false; PG_CA=""; PG_MODE="verify-ca"
case "$PGV" in oui|o|y|yes|true|O) PV=true;; esac
if [ "$PV" = "true" ]; then
  echo "  La CA (PEM) doit vivre sous infra/certs/ (seul ce dossier est copié vers les hôtes)."
  PG_CA="$(ask '  chemin du PEM de la CA' 'infra/certs/pg-ca.crt')"
  PG_MODE="$(ask '  mode (verify-ca recommandé via HAProxy | verify-full)' 'verify-ca')"
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
echo "→ infra/cluster.json écrit (ha, $N hosts)."

gen infra/cluster.json
echo
echo "Artefacts dans out/. Pour déployer : bash out/deploy-ssh.sh  (ou relance: bash setup.sh --manifest infra/cluster.json --deploy)"
[ "$DO_DEPLOY" = "1" ] && bash out/deploy-ssh.sh
