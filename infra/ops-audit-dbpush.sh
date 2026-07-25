#!/usr/bin/env bash
# Ops one-shot — Phase 8 audit log : applique le schéma Prisma (table AuditLog)
# sur la base de base ET chaque base tenant `<db>_<slug>`, depuis un container
# API (qui embarque le schéma + le CLI Prisma + le secret database_url).
# NB Prisma 7 : `db push` SANS `--skip-generate` (flag supprimé, exit 1 sinon).
# Usage : sudo bash ops-audit-dbpush.sh <api-container-id>
set -euo pipefail
CID="${1:?container id requis}"

docker cp /tmp/list-tenant-dbs.js "$CID:/app/api/prisma/list-tenant-dbs.js"

docker exec "$CID" sh -c '
  set -e
  RAW=$(cat /run/secrets/database_url)
  cd /app/api
  DBS=$(DATABASE_URL="$RAW" node prisma/list-tenant-dbs.js)
  echo "Bases cibles:"; echo "$DBS"
  for DB in $DBS; do
    URL=$(RAW="$RAW" DB="$DB" node -e "const u=new URL(process.env.RAW);u.pathname=\"/\"+process.env.DB;console.log(u.toString())")
    echo "=== db push -> $DB"
    DATABASE_URL="$URL" npx prisma db push --accept-data-loss 2>&1 | tail -3
  done
'
