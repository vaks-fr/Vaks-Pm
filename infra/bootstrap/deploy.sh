#!/usr/bin/env bash
# ============================================================
# Orchestrateur de déploiement on-premise — piloté depuis TA machine.
# Fonctionne depuis Windows (Git Bash / WSL), Linux ou macOS.
#
# PRÉREQUIS sur la machine de pilotage :
#   - client SSH (OpenSSH : ssh/scp/ssh-agent/ssh-add) — Git Bash et Windows 10+ OK
#   - une clé privée OpenSSH dont le chemin est renseigné dans SSH_KEY (.env.local)
#   - la clé publique correspondante installée sur les 3 VMs (authorized_keys)
#   - le repo + .env.local complet
#   => AUCUN Docker requis en local : les images sont buildées sur host1.
#
# Auth : SSH par clés. Si la clé a une passphrase, elle est chargée UNE seule
# fois dans ssh-agent au démarrage (prompt interactif), puis utilisée
# automatiquement par tous les ssh/scp suivants.
# Le sudo distant utilise VM_PASS (sudo -S). Laisse VM_PASS vide si sudo sans mdp.
#
# Usage :
#   ./deploy.sh check   # teste SSH + sudo sur les 3 VMs   (À FAIRE EN PREMIER)
#   ./deploy.sh db      # tier base de données (etcd + Patroni + HAProxy)
#   ./deploy.sh app     # Swarm + build images sur host1 + déploiement stack
#   ./deploy.sh all     # check + db + app
# ============================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

[ -f "$ROOT/.env.local" ] || { echo "ERREUR: $ROOT/.env.local manquant"; exit 1; }
set -a; . "$ROOT/.env.local"; set +a
: "${VM_USER:?}"; : "${VM_HOST1:?}"; : "${VM_HOST2:?}"; : "${VM_HOST3:?}"
VM_PASS="${VM_PASS:-}"

HOST1_IP="$VM_HOST1"; HOST2_IP="$VM_HOST2"; HOST3_IP="$VM_HOST3"
HOSTS=("$VM_HOST1" "$VM_HOST2" "$VM_HOST3")
NAMES=("host1" "host2" "host3")

# --- Clé privée SSH (chemin OBLIGATOIRE, renseigné dans .env.local) ---
: "${SSH_KEY:?renseigner SSH_KEY dans .env.local (chemin de la clé privée OpenSSH)}"
# Chemin relatif → résolu depuis la racine du repo.
case "$SSH_KEY" in /*|?:*) ;; *) SSH_KEY="$ROOT/$SSH_KEY" ;; esac
if [ ! -f "$SSH_KEY" ]; then
  echo "ERREUR: clé SSH OpenSSH introuvable: $SSH_KEY"
  echo "  (PuTTYgen -> Conversions -> Export OpenSSH key)"
  exit 1
fi
chmod 600 "$SSH_KEY" 2>/dev/null || true

# --- ssh-agent (si la clé a une passphrase) ---
key_is_encrypted() {
  grep -q "ENCRYPTED" "$1" 2>/dev/null && return 0
  head -c 200 "$1" | grep -q "bcrypt" 2>/dev/null && return 0
  return 1
}
AGENT_STARTED=0
ensure_agent_loaded() {
  if ! key_is_encrypted "$SSH_KEY"; then return 0; fi
  command -v ssh-agent >/dev/null || { echo "ERREUR: ssh-agent introuvable"; exit 1; }
  if [ -z "${SSH_AUTH_SOCK:-}" ] || ! ssh-add -l >/dev/null 2>&1; then
    echo "[ssh-agent] démarrage"
    eval "$(ssh-agent -s)" >/dev/null
    AGENT_STARTED=1
  fi
  local fp; fp="$(ssh-keygen -lf "$SSH_KEY" 2>/dev/null | awk '{print $2}')"
  if ! ssh-add -l 2>/dev/null | grep -qF "$fp"; then
    echo "[ssh-agent] charge la clé (saisis la passphrase ; une seule fois)"
    ssh-add "$SSH_KEY"
  fi
}
cleanup_agent() {
  if [ "$AGENT_STARTED" = "1" ] && [ -n "${SSH_AGENT_PID:-}" ]; then
    kill "$SSH_AGENT_PID" 2>/dev/null || true
  fi
}
trap cleanup_agent EXIT
ensure_agent_loaded

SSHOPT="-o StrictHostKeyChecking=accept-new -i $SSH_KEY"

# --- Helpers ---
SSH()  { ssh $SSHOPT "$VM_USER@$1" "$2"; }
RSY()  { scp $SSHOPT -r "$2" "$VM_USER@$1:$3"; }
SUDO() {
  local host="$1" cmd="$2" b64
  b64="$(printf '%s' "$cmd" | base64 | tr -d '\n')"
  ssh $SSHOPT "$VM_USER@$host" "echo '$VM_PASS' | sudo -S -p '' bash -c \"echo $b64 | base64 -d | bash\""
}

check() {
  echo "=== Test d'accès aux 3 VMs ==="
  for h in "${HOSTS[@]}"; do
    printf -- "- %-15s : " "$h"
    SSH "$h" "true" 2>/dev/null || { echo "SSH KO (clé absente sur la VM ou refusée)"; exit 1; }
    if SUDO "$h" "true" >/dev/null 2>&1; then echo "SSH ok, sudo ok"; else echo "SSH ok mais SUDO KO"; exit 1; fi
  done
  echo "Accès validé sur les 3 VMs."
}

push_infra() {
  local host="$1"
  SSH "$host" "mkdir -p ~/vakspm/bootstrap"
  RSY "$host" "$HERE/." "~/vakspm/bootstrap/"
  RSY "$host" "$ROOT/infra/patroni.yml" "~/vakspm/bootstrap/patroni.yml"
  RSY "$host" "$ROOT/infra/haproxy.cfg" "~/vakspm/bootstrap/haproxy.cfg"
}

deploy_db() {
  echo "=== Tier base de données ==="
  for i in 0 1 2; do
    host="${HOSTS[$i]}"; name="${NAMES[$i]}"; ip="$host"
    echo "--- $name ($host) ---"
    push_infra "$host"
    SUDO "$host" "cd ~$VM_USER/vakspm/bootstrap && bash 00-common.sh"
    SUDO "$host" "cd ~$VM_USER/vakspm/bootstrap && NODE_NAME=$name NODE_IP=$ip HOST1_IP=$HOST1_IP HOST2_IP=$HOST2_IP HOST3_IP=$HOST3_IP bash 10-etcd.sh"
    SUDO "$host" "cd ~$VM_USER/vakspm/bootstrap && NODE_NAME=$name NODE_IP=$ip HOST1_IP=$HOST1_IP HOST2_IP=$HOST2_IP HOST3_IP=$HOST3_IP REPL_USER=${PATRONI_REPLICATION_USER:-replicator} REPL_PASSWORD=${PATRONI_REPLICATION_PASSWORD:?} SUPERUSER_PASSWORD=${PATRONI_SUPERUSER_PASSWORD:?} bash 20-patroni.sh"
    SUDO "$host" "cd ~$VM_USER/vakspm/bootstrap && HOST1_IP=$HOST1_IP HOST2_IP=$HOST2_IP HOST3_IP=$HOST3_IP bash 30-haproxy.sh"
  done

  # Création idempotente du rôle applicatif + de la base, sur le leader uniquement.
  # Le script 25-bootstrap-db.sh détecte automatiquement s'il tourne sur le leader.
  echo "--- bootstrap rôle + base (sur le leader) ---"
  SUDO "$VM_HOST1" "cd ~$VM_USER/vakspm/bootstrap && POSTGRES_USER=${POSTGRES_USER:?} POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?} POSTGRES_DB=${POSTGRES_DB:?} bash 25-bootstrap-db.sh"
  echo "DB OK. Vérifier: ssh -i $SSH_KEY $VM_USER@$VM_HOST1 'sudo patronictl -c /etc/patroni.yml list'"
}

build_images_on_host1() {
  echo "=== Build des images sur host1 ==="
  SSH "$VM_HOST1" "mkdir -p ~/vakspm/src"
  for d in package.json tsconfig.base.json packages api worker web mcp; do
    RSY "$VM_HOST1" "$ROOT/$d" "~/vakspm/src/"
  done
  # `mcp` est dans la liste : le service est déclaré dans le stack, donc sans
  # son image l'installation démarrerait un service qui ne peut pas se lancer.
  SUDO "$VM_HOST1" "cd ~$VM_USER/vakspm/src && docker build -t vaks-pm-web:latest -f web/Dockerfile . && docker build -t vaks-pm-api:latest -f api/Dockerfile . && docker build -t vaks-pm-worker:latest -f worker/Dockerfile . && docker build -t vaks-pm-mcp:latest -f mcp/Dockerfile ."

  echo "  export des images depuis host1"
  SUDO "$VM_HOST1" "docker save vaks-pm-web:latest vaks-pm-api:latest vaks-pm-worker:latest vaks-pm-mcp:latest -o /tmp/vakspm-images.tar && chown $VM_USER:$VM_USER /tmp/vakspm-images.tar"
  local tmp; tmp="$(mktemp)"
  scp $SSHOPT "$VM_USER@$VM_HOST1:/tmp/vakspm-images.tar" "$tmp"
  for host in "$VM_HOST2" "$VM_HOST3"; do
    echo "  -> chargement des images sur $host"
    RSY "$host" "$tmp" "/tmp/vakspm-images.tar"
    SUDO "$host" "docker load -i /tmp/vakspm-images.tar"
  done
  rm -f "$tmp"
}

deploy_app() {
  echo "=== Swarm + stack applicative ==="
  SUDO "$VM_HOST1" "cd ~$VM_USER/vakspm/bootstrap && bash 40-swarm.sh manager $HOST1_IP"
  TOKEN="$(SUDO "$VM_HOST1" "docker swarm join-token -q worker" | tr -d '\r\n')"
  SUDO "$VM_HOST2" "cd ~$VM_USER/vakspm/bootstrap && bash 40-swarm.sh worker $TOKEN $HOST1_IP"
  SUDO "$VM_HOST3" "cd ~$VM_USER/vakspm/bootstrap && bash 40-swarm.sh worker $TOKEN $HOST1_IP"

  build_images_on_host1

  RSY "$VM_HOST1" "$ROOT/docker-stack.yml" "~/vakspm/docker-stack.yml"
  SSH "$VM_HOST1" "mkdir -p ~/vakspm/infra"
  RSY "$VM_HOST1" "$ROOT/infra/traefik-dynamic.yml" "~/vakspm/infra/traefik-dynamic.yml"
  DB_URL="postgresql://${POSTGRES_USER:-vakspm}:${POSTGRES_PASSWORD:?}@${HOST1_IP}:5000/${POSTGRES_DB:-vakspm}?schema=public"
  # VAKS_IMAGE_PREFIX/VAKS_TAG forcent le stack à pointer vers les images buildées
  # localement à l'étape précédente (vaks-pm-<svc>:latest), pas vers le défaut GHCR
  # du template docker-stack.yml — sinon le build ci-dessus est buildé pour rien.
  SUDO "$VM_HOST1" "cd ~$VM_USER/vakspm/bootstrap && JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:?} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:?} DATABASE_URL='$DB_URL' VAKS_IMAGE_PREFIX=vaks-pm VAKS_TAG=latest bash 50-deploy.sh"
  echo "App déployée. Suivi: ssh -i $SSH_KEY $VM_USER@$VM_HOST1 'sudo docker stack ps vaks-pm'"
}

case "${1:-}" in
  check) check ;;
  db)    deploy_db ;;
  app)   deploy_app ;;
  all)   check; deploy_db; deploy_app ;;
  *) echo "usage: $0 [check|db|app|all]"; exit 1 ;;
esac
echo "=== Terminé ==="
