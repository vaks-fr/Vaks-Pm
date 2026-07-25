#!/usr/bin/env bash
# Initialise Swarm sur le manager, ou joint le cluster sur un worker.
# Usage : 40-swarm.sh manager <MANAGER_IP>
#         40-swarm.sh worker  <JOIN_TOKEN> <MANAGER_IP>
set -euo pipefail
ROLE="${1:?role manquant: manager|worker}"

if [ "$ROLE" = "manager" ]; then
  MANAGER_IP="${2:?IP manager manquante}"
  if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
    docker swarm init --advertise-addr "$MANAGER_IP"
  fi
  echo "[40] manager prêt. Token worker :"
  docker swarm join-token -q worker
else
  TOKEN="${2:?token manquant}"; MANAGER_IP="${3:?IP manager manquante}"
  if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
    docker swarm join --token "$TOKEN" "${MANAGER_IP}:2377"
  fi
  echo "[40] worker joint au cluster"
fi
