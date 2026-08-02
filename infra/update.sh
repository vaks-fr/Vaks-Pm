#!/usr/bin/env bash
# ============================================================
# Mise à jour d'une installation Vaks-PM DÉJÀ déployée — piloté depuis TA machine.
# Pour une PREMIÈRE installation, utiliser infra/bootstrap/deploy.sh (pas ce script).
#
# Pull direct des images publiques depuis ghcr.io/vaks-fr/vakspm-<svc>
# (aucun identifiant requis) — nécessite que les 3 VMs aient une sortie HTTPS vers
# ghcr.io. Pas de reconstruction locale : ce script ne fait jamais de `docker build`.
#
# Pour un client SANS sortie Internet sur ses serveurs (air-gapé), la procédure de
# récupération manuelle des images (télécharger sur un poste tiers qui a Internet,
# transporter le fichier obtenu jusqu'à host1) est documentée sur le site vitrine,
# pas dans ce script — voir documentation/UPGRADE_ONPREM.md pour le pointeur exact.
#
# PRÉREQUIS sur la machine de pilotage : identiques à deploy.sh (SSH par clés,
# .env.local complet). AUCUN Docker requis en local.
#
# Usage :
#   ./update.sh [options] check     # teste l'accès + vérifie qu'un stack existe déjà
#   ./update.sh [options] acquire   # vérifie juste que les images du tag existent
#                                    # (utile pour préparer avant une fenêtre de maintenance)
#   ./update.sh [options] update    # mise à jour complète (suppose 'check' déjà fait)
#   ./update.sh [options] all       # check + update
#
# Options :
#   --tag <valeur>                 override le tag utilisé (défaut: sha-<git-short>)
#   --yes                          non-interactif (répond "oui" aux confirmations, SAUF
#                                  la vérification de sauvegarde — voir --skip-backup-check)
#   --skip-backup-check            saute la confirmation/lancement de sauvegarde (jamais
#                                  implicite via --yes ; à utiliser sciemment, ex. pour
#                                  relancer après une coupure réseau sans re-sauvegarder)
#   --backup-host <ip>             hôte sur lequel lancer/chercher la sauvegarde Tier 1
#                                  (défaut: VM_HOST1)
# ============================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

[ -f "$ROOT/.env.local" ] || { echo "ERREUR: $ROOT/.env.local manquant"; exit 1; }
set -a; . "$ROOT/.env.local"; set +a
: "${VM_USER:?}"; : "${VM_HOST1:?}"; : "${VM_HOST2:?}"; : "${VM_HOST3:?}"
VM_PASS="${VM_PASS:-}"

HOST1_IP="$VM_HOST1"; HOST2_IP="$VM_HOST2"; HOST3_IP="$VM_HOST3"
HOSTS=("$VM_HOST1" "$VM_HOST2" "$VM_HOST3")

# --- Clé privée SSH (chemin OBLIGATOIRE, renseigné dans .env.local) ---
: "${SSH_KEY:?renseigner SSH_KEY dans .env.local (chemin de la clé privée OpenSSH)}"
case "$SSH_KEY" in /*|?:*) ;; *) SSH_KEY="$ROOT/$SSH_KEY" ;; esac
if [ ! -f "$SSH_KEY" ]; then
  echo "ERREUR: clé SSH OpenSSH introuvable: $SSH_KEY"
  exit 1
fi
chmod 600 "$SSH_KEY" 2>/dev/null || true

# --- ssh-agent (si la clé a une passphrase) — identique à deploy.sh ---
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

# --- Helpers (identiques à deploy.sh) ---
SSH()  { ssh $SSHOPT "$VM_USER@$1" "$2"; }
RSY()  { scp $SSHOPT -r "$2" "$VM_USER@$1:$3"; }
SUDO() {
  local host="$1" cmd="$2" b64
  b64="$(printf '%s' "$cmd" | base64 | tr -d '\n')"
  ssh $SSHOPT "$VM_USER@$host" "echo '$VM_PASS' | sudo -S -p '' bash -c \"echo $b64 | base64 -d | bash\""
}

# --- Constantes registre public ---
GH_OWNER="vaks-fr"
GH_REPO_BASE="vakspm"
IMG_PREFIX="ghcr.io/${GH_OWNER}/${GH_REPO_BASE}"
STATE_FILE_REMOTE="vakspm/.update-state"

# --- Options / flags ---
TAG_OVERRIDE=""
YES=0
SKIP_BACKUP=0
BACKUP_HOST="$VM_HOST1"
CMD=""

usage() {
  echo "usage: $0 [--tag <valeur>] [--yes] [--skip-backup-check] [--backup-host <ip>] {check|acquire|update|all}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG_OVERRIDE="${2:?--tag requiert une valeur}"; shift 2 ;;
    --yes) YES=1; shift ;;
    --skip-backup-check) SKIP_BACKUP=1; shift ;;
    --backup-host) BACKUP_HOST="${2:?--backup-host requiert une valeur}"; shift 2 ;;
    check|acquire|update|all) CMD="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1"; usage; exit 1 ;;
  esac
done

# --- État partagé entre fonctions ---
TAG=""
APP_VERSION=""
STACK_CHANGED=0
LOCAL_STACK_HASH=""

image_basename_for_service() {
  case "$1" in
    controlplane) echo "api" ;;
    *) echo "$1" ;;
  esac
}

# ------------------------------------------------------------------
check() {
  echo "=== Test d'accès aux 3 VMs ==="
  local h
  for h in "${HOSTS[@]}"; do
    printf -- "- %-15s : " "$h"
    SSH "$h" "true" 2>/dev/null || { echo "SSH KO (clé absente sur la VM ou refusée)"; exit 1; }
    if SUDO "$h" "true" >/dev/null 2>&1; then echo "SSH ok, sudo ok"; else echo "SSH ok mais SUDO KO"; exit 1; fi
  done
  echo "Accès validé sur les 3 VMs."

  echo "=== Vérification qu'un stack vaks-pm existe déjà ==="
  if SUDO "$VM_HOST1" "docker stack ls --format '{{.Name}}'" 2>/dev/null | grep -qx "vaks-pm"; then
    echo "Stack 'vaks-pm' trouvé sur $VM_HOST1 — update.sh peut être utilisé."
  else
    echo "ERREUR: aucun stack 'vaks-pm' déployé sur $VM_HOST1."
    echo "  Ce script sert à METTRE À JOUR une installation existante."
    echo "  Pour une première installation, utiliser infra/bootstrap/deploy.sh (commande 'all')."
    exit 1
  fi
}

# ------------------------------------------------------------------
compute_version() {
  cd "$ROOT"
  local head dirty=""
  head="$(git rev-parse --short HEAD)"
  if [ -n "$(git status --porcelain)" ]; then
    dirty="-dirty"
    echo "ATTENTION: modifications locales non commitées détectées (git status --porcelain non vide)."
    if [ "$YES" = "1" ]; then
      echo "  --yes fourni : on continue quand même (déconseillé pour un déploiement traçable)."
    else
      read -r -p "Continuer un déploiement basé sur un état local non commité ? [o/N] " ans
      case "$ans" in o|O|oui|O) ;; *) echo "Annulé."; exit 1 ;; esac
    fi
  fi
  APP_VERSION="${head}${dirty}"
  TAG="${TAG_OVERRIDE:-sha-${head}}"
  echo "Version locale : $APP_VERSION   (tag à déployer : $TAG)"
}

# ------------------------------------------------------------------
confirm_backup() {
  echo "=== Sauvegarde avant mise à jour ==="
  cat <<'EOF'
Rappel des paliers de sauvegarde (voir infra/backup/README.md) :
  - Palier 1 (logique, pg_dump)   RPO ~24h   - vaks-backup-logical.sh
  - Palier 2 (PITR, base+WAL)     RPO ~15min - vaks-backup-base.sh + archivage WAL
La réplication Patroni n'EST PAS une sauvegarde (elle réplique aussi les erreurs :
DROP, mauvaise migration... instantanément sur les 3 nœuds).
EOF
  if [ "$SKIP_BACKUP" = "1" ]; then
    echo "--skip-backup-check fourni : vérification de sauvegarde sautée."
    return 0
  fi

  if SUDO "$BACKUP_HOST" "test -x /opt/vaks-backup/vaks-backup-logical.sh" 2>/dev/null; then
    echo "Sauvegarde Tier 1 (pg_dump) installée sur $BACKUP_HOST."
    local run_backup=1
    if [ "$YES" = "1" ]; then
      echo "Lancement automatique (--yes) d'une sauvegarde avant mise à jour…"
    else
      read -r -p "Lancer une sauvegarde maintenant avant de continuer ? [O/n] " ans
      case "$ans" in n|N) run_backup=0 ;; esac
    fi
    if [ "$run_backup" = "1" ]; then
      SUDO "$BACKUP_HOST" "sudo -u postgres /opt/vaks-backup/vaks-backup-logical.sh" \
        || { echo "ERREUR: la sauvegarde a échoué — mise à jour annulée (ne pas toucher une DB juste après un backup en échec)."; exit 1; }
      echo "Sauvegarde OK."
    fi
  else
    echo "ATTENTION: aucun script de sauvegarde Tier 1 détecté sur $BACKUP_HOST"
    echo "  (/opt/vaks-backup/vaks-backup-logical.sh absent). Voir infra/backup/README.md pour l'installer."
    if [ "$YES" = "1" ]; then
      echo "--yes fourni : on continue SANS confirmation de sauvegarde (assure-toi d'en avoir une récente)."
    else
      read -r -p "Confirmer que tu as une sauvegarde récente et veux continuer sans backup automatique ? [o/N] " ans
      case "$ans" in o|O) ;; *) echo "Annulé — installe une sauvegarde d'abord, ou relance avec --skip-backup-check."; exit 1 ;; esac
    fi
  fi
}

# ------------------------------------------------------------------
detect_stack_changes() {
  echo "=== Détection de changement de docker-stack.yml / traefik-dynamic.yml ==="
  LOCAL_STACK_HASH="$(cat "$ROOT/docker-stack.yml" "$ROOT/infra/traefik-dynamic.yml" | sha256sum | awk '{print $1}')"
  local remote_hash
  remote_hash="$(SSH "$VM_HOST1" "cat ~/$STATE_FILE_REMOTE 2>/dev/null || true")"
  if [ -z "$remote_hash" ]; then
    echo "Aucun état précédent trouvé (premier run d'update.sh sur cette install) — traité comme changé."
    STACK_CHANGED=1
  elif [ "$LOCAL_STACK_HASH" != "$remote_hash" ]; then
    echo "docker-stack.yml / traefik-dynamic.yml ont changé depuis le dernier update."
    STACK_CHANGED=1
  else
    echo "Pas de changement de configuration stack détecté."
    STACK_CHANGED=0
  fi
}

# ------------------------------------------------------------------
ghcr_tag_exists() {
  local base="$1" repo="${GH_OWNER}/${GH_REPO_BASE}-${base}"
  local remote_cmd
  remote_cmd=$(cat <<EOF
TOKEN=\$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
[ -n "\$TOKEN" ] || exit 1
ACCEPT="application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json"
CODE=\$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer \$TOKEN" -H "Accept: \$ACCEPT" "https://ghcr.io/v2/${repo}/manifests/${TAG}")
[ "\$CODE" = "200" ]
EOF
)
  SUDO "$VM_HOST1" "$remote_cmd" >/dev/null 2>&1
}

acquire_images() {
  echo "=== Vérification des images ghcr.io/${GH_OWNER}/${GH_REPO_BASE}-*:${TAG} ==="
  local base missing=0
  for base in api web worker mcp; do
    printf -- "- %-8s : " "$base"
    if ghcr_tag_exists "$base"; then
      echo "OK"
    else
      echo "MANQUANT"
      missing=1
    fi
  done
  if [ "$missing" = "1" ]; then
    echo "ERREUR: au moins une image manque pour le tag '${TAG}' sur le registre public."
    echo "  Vérifier que la CI a terminé de builder ce commit sur le repo public,"
    echo "  ou relancer avec --tag latest."
    echo "  Serveurs sans sortie Internet (air-gapé) : voir la procédure manuelle sur"
    echo "  le site vitrine (documentation/UPGRADE_ONPREM.md pour le pointeur)."
    exit 1
  fi
  echo "Toutes les images sont disponibles — rien à puller ici, chaque nœud Swarm"
  echo "pullera l'image publique lui-même au moment du rolling update."
}

# ------------------------------------------------------------------
wait_for_convergence() {
  local svc="$1" timeout="${2:-180}" waited=0 states
  echo "  attente de convergence de $svc (timeout ${timeout}s)…"
  while [ "$waited" -lt "$timeout" ]; do
    states="$(SUDO "$VM_HOST1" "docker service ps $svc --format '{{.CurrentState}}' --filter 'desired-state=running'" 2>/dev/null || true)"
    if [ -n "$states" ] && ! printf '%s\n' "$states" | grep -qvE '^Running'; then
      echo "  $svc convergé."
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo "ERREUR: $svc n'a pas convergé après ${timeout}s."
  SUDO "$VM_HOST1" "docker service ps $svc --no-trunc" || true
  echo ""
  echo "  Diagnostic : docker service logs $svc --tail 100"
  echo "  Rollback possible : docker service rollback $svc"
  echo "  ATTENTION : si cette mise à jour a modifié le schéma (nouvelle colonne ajoutée),"
  echo "  un rollback d'image NE SUFFIT PAS — l'ancienne image refusera de démarrer"
  echo "  (elle voudrait DROP la colonne). Restaurer la sauvegarde DB à la place."
  exit 1
}

# ------------------------------------------------------------------
update_services() {
  echo "=== Rolling update des services (ordre : api -> controlplane -> web/worker/mcp) ==="
  local svc base
  for svc in api controlplane; do
    base="$(image_basename_for_service "$svc")"
    echo "--- $svc (image ${IMG_PREFIX}-${base}:${TAG}) ---"
    SUDO "$VM_HOST1" "docker service update --force --image ${IMG_PREFIX}-${base}:${TAG} vaks-pm_${svc}"
    wait_for_convergence "vaks-pm_${svc}"
  done
  for svc in web worker mcp; do
    base="$(image_basename_for_service "$svc")"
    echo "--- $svc (image ${IMG_PREFIX}-${base}:${TAG}) ---"
    SUDO "$VM_HOST1" "docker service update --force --image ${IMG_PREFIX}-${base}:${TAG} vaks-pm_${svc}"
    wait_for_convergence "vaks-pm_${svc}"
  done
}

# ------------------------------------------------------------------
maybe_stack_deploy() {
  [ "$STACK_CHANGED" = "1" ] || return 0
  echo "=== docker-stack.yml a changé — re-déploiement complet du stack ==="
  RSY "$VM_HOST1" "$ROOT/docker-stack.yml" "~/vakspm/docker-stack.yml"
  SSH "$VM_HOST1" "mkdir -p ~/vakspm/infra"
  RSY "$VM_HOST1" "$ROOT/infra/traefik-dynamic.yml" "~/vakspm/infra/traefik-dynamic.yml"
  SUDO "$VM_HOST1" "cd ~$VM_USER/vakspm && VAKS_TAG=$TAG docker stack deploy -c docker-stack.yml vaks-pm"
  local svc
  for svc in api controlplane web worker mcp; do
    wait_for_convergence "vaks-pm_${svc}"
  done
  SSH "$VM_HOST1" "printf '%s' '$LOCAL_STACK_HASH' > ~/$STATE_FILE_REMOTE"
  echo "État stack enregistré (~/$STATE_FILE_REMOTE)."
}

# ------------------------------------------------------------------
post_update_verify() {
  echo "=== Vérification post-update ==="
  local i=0 ok=0
  while [ "$i" -lt 12 ]; do
    if SUDO "$VM_HOST1" "curl -k -sf https://127.0.0.1/api/v1/health/ready" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 5
    i=$((i + 1))
  done
  if [ "$ok" = "1" ]; then
    echo "/health/ready : OK"
  else
    echo "ERREUR: /health/ready ne répond pas OK après 60s — vérifier manuellement :"
    echo "  ssh -i $SSH_KEY $VM_USER@$VM_HOST1 'sudo docker service logs vaks-pm_api --tail 100'"
    exit 1
  fi
  echo ""
  echo "Pour confirmer la version effectivement servie (tag déployé : $TAG) :"
  echo "  UI -> Admin -> Sécurité & Conformité -> Diagnostics support"
}

# ------------------------------------------------------------------
run_update() {
  compute_version
  confirm_backup
  detect_stack_changes
  acquire_images
  update_services
  maybe_stack_deploy
  post_update_verify
}

case "$CMD" in
  check) check ;;
  acquire) compute_version; acquire_images ;;
  update) run_update ;;
  all) check; run_update ;;
  *) usage; exit 1 ;;
esac
echo "=== Terminé ==="
