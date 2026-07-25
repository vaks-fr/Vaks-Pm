#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIER 1 — Sauvegarde logique (pg_dump). RPO ≈ 1 jour.
#
# Produit un dump au format custom (compressé, restaurable sélectivement) à
# lancer de préférence depuis un RÉPLICA pour ne pas charger le primaire.
# Outil 100 % natif PostgreSQL (paquet postgresql-client-17 déjà installé).
#
#   Usage :  ./vaks-backup-logical.sh
#   Conf  :  /etc/vaks-backup.env  (cf. backup.env.example)
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "$HERE/_common.sh"
export BACKUP_TIER="logical"   # palier renvoyé dans l'alerte backup.failed

TS="$(date -u +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/vakspm-${TS}.dump"

mkdir -p "$BACKUP_DIR"
log "Tier 1 — pg_dump de ${PGDATABASE}@${PGHOST}:${PGPORT} → $OUT"

# -Fc : format custom (compressé). -Z6 : niveau de compression.
# --no-owner / --no-acl : restauration portable sur un autre rôle.
PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" PGDATABASE="$PGDATABASE" \
pg_dump -Fc -Z6 --no-owner --no-acl -f "$OUT" \
  || die "pg_dump a échoué"

# Chiffrement age optionnel (DORA) — remplace $OUT par $OUT.age, supprime le clair.
OUT="$(maybe_encrypt "$OUT")"

# Empreinte d'intégrité (vérifiable à la restauration) — sur l'artefact final.
sha256sum "$OUT" > "${OUT}.sha256"
SIZE="$(du -h "$OUT" | cut -f1)"
log "dump OK (${SIZE})${BACKUP_AGE_RECIPIENT:+ [chiffré age]}"

# Expédition hors-cluster
ship_file "$OUT"            "logical"
ship_file "${OUT}.sha256"   "logical"

# Rétention locale : on supprime les dumps plus vieux que RETENTION_DAYS jours.
find "$BACKUP_DIR" -maxdepth 1 -name 'vakspm-*.dump*' -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete | sed 's/^/purge: /'

log "Tier 1 terminé."
