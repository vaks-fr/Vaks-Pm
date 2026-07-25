#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIER 2 — Base backup physique (pg_basebackup). Photo complète du cluster.
#          Combinée au flux WAL archivé → restauration à la seconde près (PITR).
#
# TIER 2b (optionnel, PostgreSQL 17+) — base INCRÉMENTALE :
#          ./vaks-backup-base.sh --incremental /chemin/backup_manifest_precedent
#          Ne sauve que les pages modifiées depuis la base de référence ;
#          restauration via pg_combinebackup (full + incréments).
#
#   Usage :  ./vaks-backup-base.sh                       # base complète
#            ./vaks-backup-base.sh --incremental <MANIFEST>
#   Conf  :  /etc/vaks-backup.env
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "$HERE/_common.sh"
export BACKUP_TIER="base"   # palier renvoyé dans l'alerte backup.failed

MODE="full"; PREV_MANIFEST=""
if [[ "${1:-}" == "--incremental" ]]; then
  MODE="incremental"
  PREV_MANIFEST="${2:?--incremental requiert le chemin du backup_manifest de référence}"
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/base-${MODE}-${TS}"
mkdir -p "$DEST"
log "Tier 2 — pg_basebackup ($MODE) → $DEST"

# -Ft -z : tar gzip. -Xs : stream le WAL généré pendant le backup (auto-suffisant).
# -C -S : slot de réplication temporaire pour ne pas perdre de WAL pendant le run.
ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER"
      -D "$DEST" -Ft -z -Xs -P
      --checkpoint=fast --no-password)

if [[ "$MODE" == "incremental" ]]; then
  # PostgreSQL 17 : sauvegarde incrémentale relative à un manifeste précédent.
  ARGS+=(--incremental "$PREV_MANIFEST")
fi

pg_basebackup "${ARGS[@]}" || die "pg_basebackup ($MODE) a échoué"

# Chiffrement age optionnel (DORA) : on chiffre la CHARGE (les tar.gz = données)
# mais on laisse `backup_manifest` en clair — métadonnées sans données de ligne,
# requises localement pour chaîner une base INCRÉMENTALE (--incremental <MANIFEST>).
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  for f in "$DEST"/*.tar.gz; do
    [[ -e "$f" ]] || continue
    maybe_encrypt "$f" >/dev/null
  done
fi

# Empreintes d'intégrité sur les artefacts finaux (.tar.gz ou .tar.gz.age).
sha256sum "$DEST"/*.tar.gz* > "${DEST}/SHA256SUMS" 2>/dev/null || true
SIZE="$(du -sh "$DEST" | cut -f1)"
log "base backup OK (${SIZE})${BACKUP_AGE_RECIPIENT:+ [tar.gz chiffrés age]}"

# Expédie tout le répertoire de la base (tar + backup_manifest).
ship_file "$DEST" "base"

# Rétention : garder les BASE_RETENTION bases les plus récentes (toutes confondues).
mapfile -t OLD < <(ls -1dt "${BACKUP_DIR}"/base-* 2>/dev/null | tail -n "+$((BASE_RETENTION+1))")
for d in "${OLD[@]:-}"; do
  [[ -n "$d" ]] || continue
  log "purge base ancienne: $d"
  rm -rf "$d"
done

log "Tier 2 (base $MODE) terminé. Pense à lancer vaks-wal-cleanup.sh pour purger le WAL orphelin."
