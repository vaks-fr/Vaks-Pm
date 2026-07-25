#!/usr/bin/env bash
# Crée le rôle applicatif et la base de données après bootstrap Patroni.
# À exécuter UNIQUEMENT sur le leader Patroni (typiquement host1).
# Idempotent : ne fait rien si rôle / base existent déjà.
#
# Variables : POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
set -euo pipefail
: "${POSTGRES_USER:?}"; : "${POSTGRES_PASSWORD:?}"; : "${POSTGRES_DB:?}"

# Attend que PostgreSQL soit prêt (Patroni peut prendre quelques secondes au démarrage).
for i in $(seq 1 30); do
  if sudo -u postgres psql -p 5432 -tAc "SELECT 1" >/dev/null 2>&1; then break; fi
  sleep 2
done

# Vérifie qu'on est bien sur le leader (sinon l'écriture sera refusée).
# Tolérant : en bootstrap from-scratch un replica peut encore cloner
# (pg_basebackup) quand la boucle l'atteint — le socket 5432 n'existe pas encore.
# Il ne faut PAS faire échouer l'orchestrateur (set -e) dans ce cas : ce n'est de
# toute façon pas le leader. `|| echo unknown` neutralise l'échec psql ; tout ce
# qui n'est pas `f` (leader joignable) → skip propre (exit 0).
ROLE="$(sudo -u postgres psql -p 5432 -tAc "SELECT pg_is_in_recovery()" 2>/dev/null || echo unknown)"
if [ "$ROLE" != "f" ]; then
  echo "[25] non-leader ou PG pas encore prêt (role=$ROLE) — bootstrap-db ignoré"
  exit 0
fi

# Rôle applicatif
sudo -u postgres psql -p 5432 -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  -- CREATEDB requis : en mode pooled, l'app crée elle-même la base de chaque
  -- tenant (<db>_<slug>) via provision-tenant.js avec ce rôle.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
    CREATE ROLE ${POSTGRES_USER} LOGIN CREATEDB PASSWORD '${POSTGRES_PASSWORD}';
  ELSE
    ALTER ROLE ${POSTGRES_USER} WITH LOGIN CREATEDB PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END
\$\$;
SQL

# Base
EXISTS="$(sudo -u postgres psql -p 5432 -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'")"
if [ "$EXISTS" != "1" ]; then
  sudo -u postgres psql -p 5432 -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER}"
fi

echo "[25] rôle ${POSTGRES_USER} et base ${POSTGRES_DB} prêts (leader)"
