#!/bin/sh
# tenant-dbpush.sh <slug>
# Lit le secret database_url DANS le conteneur, dérive la base tenant
# (<db>_<slug>) et applique `prisma db push` (additif). Ne JAMAIS imprimer l'URL.
set -e
SLUG="$1"
[ -n "$SLUG" ] || { echo "usage: tenant-dbpush.sh <slug>"; exit 1; }
BASE=$(cat /run/secrets/database_url)
# Insère _<slug> à la fin du nom de base (dernier segment de path, avant ? ou fin).
TENANT=$(printf '%s' "$BASE" | sed -E "s#/([^/?]+)(\?|$)#/\1_${SLUG}\2#")
export DATABASE_URL="$TENANT"
cd /app/api
echo "→ prisma db push sur tenant '${SLUG}' …"
npx prisma db push
echo "✓ done (${SLUG})"
