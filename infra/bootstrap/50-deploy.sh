#!/usr/bin/env bash
# Crée les secrets Swarm puis déploie la stack applicative. À exécuter sur le MANAGER.
# Variables : JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, DATABASE_URL
# DATABASE_URL doit pointer vers HAProxy, ex: postgresql://vakspm:***@<HOST1_IP>:5000/vakspm
# STACK_FILE : chemin du docker-stack.yml (défaut: ../docker-stack.yml depuis ce script).
#
# Le stockage S3 (Garage) nécessite en plus les secrets garage_rpc_secret,
# garage_admin_token, s3_secret_key et l'init via `garage layout`/`bucket
# create`/`key create` — à faire après le premier déploiement (cf. README).
set -euo pipefail
: "${JWT_ACCESS_SECRET:?}"; : "${JWT_REFRESH_SECRET:?}"; : "${DATABASE_URL:?}"
STACK_FILE="${STACK_FILE:-$(cd "$(dirname "$0")/.." && pwd)/docker-stack.yml}"
[ -f "$STACK_FILE" ] || { echo "ERREUR: stack introuvable: $STACK_FILE"; exit 1; }

create_secret() {
  local name="$1" value="$2"
  if docker secret inspect "$name" >/dev/null 2>&1; then
    echo "  secret $name existe déjà (rotation: docker secret rm puis recréer)"
  else
    printf '%s' "$value" | docker secret create "$name" -
    echo "  secret $name créé"
  fi
}

echo "[50] création des secrets Swarm"
create_secret jwt_access_secret   "$JWT_ACCESS_SECRET"
create_secret jwt_refresh_secret  "$JWT_REFRESH_SECRET"
create_secret database_url        "$DATABASE_URL"

echo "[50] déploiement de la stack ($STACK_FILE)"
docker stack deploy -c "$STACK_FILE" vaks-pm
docker stack ps vaks-pm
