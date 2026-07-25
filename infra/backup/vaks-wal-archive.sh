#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TIER 2 — Cible de l'archive_command PostgreSQL (un segment WAL à la fois).
#
# Appelé par PostgreSQL lui-même, une fois par segment WAL terminé. PostgreSQL
# passe %p (chemin du segment) et %f (nom du fichier). Le script gzip le segment
# puis le copie en local + hors-cluster. Le segment empli de zéros (forcé par
# archive_timeout) se comprime à quelques Ko.
#
# IMPORTANT (règle PostgreSQL) :
#   - sortir 0 UNIQUEMENT si le segment est durablement archivé ;
#   - sortir != 0 sinon — PostgreSQL réessaiera et NE recyclera PAS le segment.
#   - ne JAMAIS écraser un segment déjà présent avec un contenu différent.
#
# Configuré côté Patroni (cf. doc backup-restore.html), PAS dans postgresql.conf :
#   archive_mode    = on
#   archive_command = '/opt/vaks-backup/vaks-wal-archive.sh %p %f'
#   archive_timeout = 900   # 15 min — plafond du RPO
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
VAKS_BACKUP_ENV="${VAKS_BACKUP_ENV:-/etc/vaks-backup.env}"
# shellcheck disable=SC1090
source "$VAKS_BACKUP_ENV"

SRC_PATH="$1"   # %p — chemin relatif/absolu du segment dans pg_wal
SEG_NAME="$2"   # %f — nom du segment (ex. 000000010000000000000A1)

mkdir -p "$WAL_ARCHIVE_DIR"

# Artefact final : .gz, ou .gz.age si chiffrement age activé (DORA). La clé
# PUBLIQUE (recipient) seule vit sur l'hôte ; déchiffrement = clé privée escrow.
ENCRYPT=0; [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && ENCRYPT=1
GZ_NAME="${SEG_NAME}.gz"
FINAL="${WAL_ARCHIVE_DIR}/${GZ_NAME}"
[[ "$ENCRYPT" == 1 ]] && FINAL="${FINAL}.age"

# Idempotence : si déjà archivé, succès. En clair on compare le contenu (refus si
# différent — règle PostgreSQL) ; chiffré, age n'est pas déterministe donc on ne
# peut pas comparer → présence = déjà archivé (succès).
if [[ -f "$FINAL" ]]; then
  if [[ "$ENCRYPT" == 1 ]]; then
    exit 0
  fi
  if zcmp -s "$SRC_PATH" <(gzip -dc "$FINAL"); then
    exit 0
  fi
  echo "archive WAL: $SEG_NAME existe déjà avec un contenu différent" >&2
  exit 1
fi

# Écriture atomique : .tmp puis rename (un crash ne laisse pas d'artefact tronqué).
GZ_TMP="${WAL_ARCHIVE_DIR}/.${GZ_NAME}.tmp.$$"
if ! gzip -c "$SRC_PATH" > "$GZ_TMP"; then
  rm -f "$GZ_TMP"; echo "archive WAL: gzip a échoué pour $SEG_NAME" >&2; exit 1
fi

if [[ "$ENCRYPT" == 1 ]]; then
  command -v age >/dev/null 2>&1 \
    || { rm -f "$GZ_TMP"; echo "archive WAL: 'age' introuvable mais BACKUP_AGE_RECIPIENT défini" >&2; exit 1; }
  # Recipients (inline — ce script ne source pas _common.sh) : fichier OU liste
  # `age1…`/`ssh-ed25519 …` séparée par des virgules.
  RARGS=()
  if [[ -f "$BACKUP_AGE_RECIPIENT" ]]; then
    RARGS=(-R "$BACKUP_AGE_RECIPIENT")
  else
    OLDIFS="$IFS"; IFS=','
    for r in $BACKUP_AGE_RECIPIENT; do
      r="$(echo "$r" | tr -d '[:space:]')"; [[ -n "$r" ]] && RARGS+=(-r "$r")
    done
    IFS="$OLDIFS"
  fi
  AGE_TMP="${FINAL}.tmp.$$"
  if ! age "${RARGS[@]}" -o "$AGE_TMP" "$GZ_TMP"; then
    rm -f "$GZ_TMP" "$AGE_TMP"; echo "archive WAL: age a échoué pour $SEG_NAME" >&2; exit 1
  fi
  rm -f "$GZ_TMP"
  mv -f "$AGE_TMP" "$FINAL"
else
  mv -f "$GZ_TMP" "$FINAL"
fi
sync "$FINAL" 2>/dev/null || true

SHIP_NAME="$(basename "$FINAL")"

# Expédition hors-cluster — si elle échoue, on échoue (le WAL ne doit pas être
# recyclé tant qu'il n'est pas en sécurité hors du cluster).
case "${SHIP_MODE:-none}" in
  none) ;;
  scp)
    ssh -i "$SHIP_SSH_KEY" "$SHIP_SSH" "mkdir -p '${SHIP_REMOTE_DIR}/wal'" \
      && rsync -a -e "ssh -i $SHIP_SSH_KEY" "$FINAL" "$SHIP_SSH:${SHIP_REMOTE_DIR}/wal/" \
      || { echo "archive WAL: expédition scp échouée pour $SEG_NAME" >&2; exit 1; }
    ;;
  s3)
    aws --endpoint-url "$S3_ENDPOINT" s3 cp "$FINAL" "s3://${S3_BUCKET}/wal/${SHIP_NAME}" \
      || { echo "archive WAL: expédition s3 échouée pour $SEG_NAME" >&2; exit 1; }
    ;;
esac

exit 0
