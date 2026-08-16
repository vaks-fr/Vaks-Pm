#!/usr/bin/env bash
# Tier B (FENÊTRE) — active le chiffrement IPsec du réseau overlay Swarm `vakspm`.
# Le flag `encrypted:"true"` n'est pas togglable à chaud : il faut RECRÉER le
# réseau = `docker stack rm` + redeploy (~1-2 min d'interruption applicative ; la
# DB native/HAProxy n'est PAS dans l'overlay, donc intacte) + re-peer Garage.
# À lancer sur le MANAGER. Couvre redis + Garage + HTTP/WS interne d'un coup.
#
#   STACK=vaks-pm                         (défaut)
#   STACK_FILE=~/vakspm-cluster/docker-stack.gen.yml   (auto-détecté sinon)
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/crypto/_common.sh
source "$SELF_DIR/_common.sh"
require_root
require_cmd docker
STACK="${STACK:-vaks-pm}"

# Le nœud doit être un manager Swarm.
docker node ls >/dev/null 2>&1 || die "ce nœud n'est pas un manager Swarm (docker node ls échoue)"

# Localiser le stack file (source de vérité du déploiement).
find_stack_file() {
  [[ -n "${STACK_FILE:-}" && -f "$STACK_FILE" ]] && { echo "$STACK_FILE"; return; }
  # ⚠️ Sous sudo, ~ = /root : chercher explicitement les homes utilisateurs aussi.
  local roots=(~ /root)
  for h in /home/*; do roots+=("$h"); done
  for r in "${roots[@]}"; do
    for sub in vakspm-cluster vakspm; do
      for f in docker-stack.gen.yml docker-stack.yml; do
        [[ -f "$r/$sub/$f" ]] && { echo "$r/$sub/$f"; return; }
      done
    done
  done
  echo ""
}
SF="$(find_stack_file)"
[[ -n "$SF" ]] || die "stack file introuvable — préciser STACK_FILE=/chemin/docker-stack.gen.yml"
log "stack file: $SF"

# GARDE : le stack file DOIT déjà déclarer l'overlay chiffré, sinon le redeploy
# recréerait un réseau EN CLAIR. Régénérer avec encryption.overlay=true (generate.mjs)
# ou patcher le gen file AVANT de lancer ce script.
if ! grep -qE 'encrypted:\s*"?true"?' "$SF"; then
  die "le stack file ne déclare pas 'encrypted: \"true\"' sur le réseau overlay — régénérer (encryption.overlay=true) ou patcher $SF d'abord"
fi

log "ATTENTION : interruption applicative ~1-2 min (stack rm + redeploy). DB/HAProxy natifs intacts."
confirm "Recréer le réseau overlay chiffré maintenant (fenêtre de maintenance) ?"

log "docker stack rm $STACK"
docker stack rm "$STACK"
# Attendre la disparition effective du réseau overlay avant de redéployer.
for i in $(seq 1 30); do
  docker network ls --format '{{.Name}}' | grep -q "^${STACK}_vakspm$" || break
  sleep 2
done
docker network ls --format '{{.Name}}' | grep -q "^${STACK}_vakspm$" \
  && die "le réseau ${STACK}_vakspm n'a pas disparu — attendre puis relancer"

log "docker stack deploy -c $SF $STACK"
docker stack deploy --with-registry-auth -c "$SF" "$STACK"

# Vérifier que le réseau est bien chiffré.
sleep 5
if docker network inspect "${STACK}_vakspm" -f '{{index .Options "encrypted"}}' 2>/dev/null | grep -qi true; then
  result "overlay_ipsec=ok"
  log "overlay chiffré. Garage se ré-appaire via le service garage-reconnect ; sinon: garage node connect <id>@<ip-overlay>:3901. Vérifier l'app 200 et 'garage status'."
else
  result "overlay_ipsec=unverified"
  warn "impossible de confirmer 'encrypted' sur ${STACK}_vakspm — vérifier docker network inspect"
fi
