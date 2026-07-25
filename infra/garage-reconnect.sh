#!/bin/sh
# GÉNÉRÉ / livré par infra/ — réconciliateur de peering Garage (mode HA multi-nœud).
#
# POURQUOI : la config Garage multi-nœud n'a pas de `rpc_public_addr` statique
# (la VIP Swarm résoudrait vers UNE task) ni de `bootstrap_peers` (les IP overlay
# sont dynamiques). Après un redémarrage SIMULTANÉ des nœuds (reboot cluster,
# `stack deploy`, coupure), chacun repart isolé et NE se re-découvre pas seul →
# split-brain → perte du quorum S3 jusqu'à un `garage node connect` manuel.
#
# CE SERVICE rend le cluster AUTO-GUÉRISSANT : en boucle, il résout toutes les
# tasks Garage via le DNS Swarm (`tasks.<stack>_garage`), lit l'ID stable de
# chaque nœud via l'admin API, et pousse à CHAQUE nœud la liste complète des
# pairs (`/v1/connect`). Idempotent, sans IP en dur, sans secret nouveau (réutilise
# `garage_admin_token`). Les IDs de nœud sont stables (persistés dans meta/), seules
# les IP changent — on les re-résout à chaque tick.
set -eu

TASKS_DNS="${GARAGE_TASKS_DNS:-tasks.vaks-pm_garage}"
ADMIN_PORT="${GARAGE_ADMIN_PORT:-3903}"
RPC_PORT="${GARAGE_RPC_PORT:-3901}"
INTERVAL="${RECONNECT_INTERVAL:-60}"
TOKEN="$(cat /run/secrets/garage_admin_token)"

log() { echo "$(date -u +%FT%TZ) [garage-reconnect] $*"; }

# Dépendances (image alpine minimale) : curl (admin API), jq (JSON), bind-tools (dig).
if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v dig >/dev/null 2>&1; then
  log "installation des dépendances (curl jq bind-tools)…"
  apk add --no-cache curl jq bind-tools >/dev/null 2>&1 || log "apk add a échoué (déjà présent ?)"
fi

auth() { curl -sf -m 5 -H "Authorization: Bearer $TOKEN" "$@"; }

reconcile() {
  # 1. IP overlay courantes de toutes les tasks Garage.
  ips="$(dig +short "$TASKS_DNS" 2>/dev/null | sort -u || true)"
  [ -z "$ips" ] && { log "aucune task Garage résolue via $TASKS_DNS"; return 0; }

  # 2. ID stable de chaque nœud (admin API /v1/status → .node).
  peers=""
  n=0
  for ip in $ips; do
    id="$(auth "http://$ip:$ADMIN_PORT/v1/status" 2>/dev/null | jq -r '.node // empty' || true)"
    if [ -n "$id" ]; then
      peers="$peers $id@$ip:$RPC_PORT"
      n=$((n + 1))
    fi
  done
  [ -z "$peers" ] && { log "aucun nœud n'a répondu à l'admin API"; return 0; }

  # 3. Pousse la liste COMPLÈTE des pairs à CHAQUE nœud (couvre un cluster
  #    totalement splitté où chacun est isolé). Idempotent : reconnecter des
  #    pairs déjà connectés est sans effet.
  body="$(printf '%s\n' $peers | jq -R . | jq -s -c .)"
  ok=0
  for ip in $ips; do
    if auth -X POST "http://$ip:$ADMIN_PORT/v1/connect" -d "$body" >/dev/null 2>&1; then
      ok=$((ok + 1))
    fi
  done
  log "reconcile: $n nœud(s), connect poussé à $ok/$(echo $ips | wc -w)"
}

log "démarrage (dns=$TASKS_DNS interval=${INTERVAL}s)"
while true; do
  reconcile || log "tick en erreur (ignoré)"
  sleep "$INTERVAL"
done
