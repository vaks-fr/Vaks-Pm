#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIER 2 — Purge du WAL archivé devenu inutile (pg_archivecleanup, natif).
#
# Règle d'or : on ne supprime QUE le WAL antérieur au point de départ de la
# PLUS ANCIENNE base backup encore conservée. Supprimer plus récent que ça
# rendrait cette base non restaurable (WAL orphelin).
#
# À lancer juste APRÈS vaks-backup-base.sh (la rétention des bases a déjà tourné).
#
#   Usage :  ./vaks-wal-cleanup.sh
#   Conf  :  /etc/vaks-backup.env
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "$HERE/_common.sh"

PG_ARCHIVECLEANUP="${PG_ARCHIVECLEANUP:-/usr/lib/postgresql/17/bin/pg_archivecleanup}"

# Base la plus ancienne encore conservée = la BASE_RETENTION-ième plus récente.
OLDEST_BASE="$(ls -1dt "${BACKUP_DIR}"/base-* 2>/dev/null | head -n "$BASE_RETENTION" | tail -1)"
[[ -n "$OLDEST_BASE" ]] || die "aucune base backup trouvée dans $BACKUP_DIR"
MANIFEST="${OLDEST_BASE}/backup_manifest"
[[ -f "$MANIFEST" ]] || die "backup_manifest absent: $MANIFEST"

log "base la plus ancienne conservée: $OLDEST_BASE"

# Dérive le nom du segment WAL de départ depuis le manifeste (Start-LSN + Timeline).
OLDEST_WAL="$(python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
ranges = m.get("WAL-Ranges", [])
if not ranges:
    sys.exit("backup_manifest sans WAL-Ranges")
r = min(ranges, key=lambda x: x["Start-LSN"])
tli = int(r["Timeline"])
hi, lo = (int(p, 16) for p in r["Start-LSN"].split("/"))
seg = lo >> 24                      # segments de 16 Mo
print("%08X%08X%08X" % (tli, hi, seg))
PY
)" || die "calcul du segment WAL de départ échoué"

log "purge du WAL antérieur à $OLDEST_WAL"

# -x <suffixe> : pg_archivecleanup retire ce suffixe pour reconnaître le nom du
# segment. Nos segments sont gzippés (.gz), et .gz.age si chiffrés (cf. WAL_SUFFIX
# dans _common.sh). pg_archivecleanup supprime tout segment strictement plus
# ancien que OLDEST_WAL dans le répertoire d'archive.
"$PG_ARCHIVECLEANUP" -x "$WAL_SUFFIX" "$WAL_ARCHIVE_DIR" "$OLDEST_WAL" \
  || die "pg_archivecleanup a échoué"

# Même purge côté cible hors-cluster (best-effort).
case "${SHIP_MODE:-none}" in
  scp)
    ssh -i "$SHIP_SSH_KEY" "$SHIP_SSH" \
      "command -v pg_archivecleanup >/dev/null && pg_archivecleanup -x '$WAL_SUFFIX' '${SHIP_REMOTE_DIR}/wal' '$OLDEST_WAL'" \
      || log "purge WAL distante ignorée (pg_archivecleanup absent côté cible)"
    ;;
  s3)
    log "purge WAL S3 : appliquer une lifecycle rule sur le préfixe wal/ côté Garage"
    ;;
esac

log "purge WAL terminée."
