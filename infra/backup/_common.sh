#!/usr/bin/env bash
# Fonctions partagées par les scripts de sauvegarde Vaks PM.
# Sourcé par vaks-backup-logical.sh, vaks-backup-base.sh, vaks-wal-cleanup.sh.
set -euo pipefail

# Charge la conf : VAKS_BACKUP_ENV ou /etc/vaks-backup.env
VAKS_BACKUP_ENV="${VAKS_BACKUP_ENV:-/etc/vaks-backup.env}"
if [[ -f "$VAKS_BACKUP_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$VAKS_BACKUP_ENV"
else
  echo "FATAL: fichier de conf introuvable: $VAKS_BACKUP_ENV" >&2
  exit 1
fi

log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die()  { log "ERREUR: $*"; alert "$*"; exit 1; }

# ─── Chiffrement des artefacts (DORA — at-rest & in-transit) ──────────────────
# Si BACKUP_AGE_RECIPIENT est défini, chaque artefact est chiffré avec `age`
# (asymétrique) DÈS sa création, AVANT toute expédition : l'hôte ne porte que la
# clé PUBLIQUE (recipient) — rien à voler — la clé privée est en escrow hors
# cluster. Vide ⇒ no-op (artefacts en clair, back-compat des déploiements existants).
#
# Suffixe des segments WAL (cf. vaks-wal-cleanup.sh : pg_archivecleanup -x).
# Chiffré ⇒ `.gz.age`, sinon `.gz`.
WAL_SUFFIX=".gz"; [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] && WAL_SUFFIX=".gz.age"

# Construit les arguments `-r/-R` de age depuis BACKUP_AGE_RECIPIENT, qui accepte :
#   - un ou plusieurs recipients `age1…`/`ssh-ed25519 …` séparés par des virgules ;
#   - OU le chemin d'un fichier de recipients (une entrée par ligne).
age_recipient_args() {
  if [[ -f "$BACKUP_AGE_RECIPIENT" ]]; then
    printf '%s\0' -R "$BACKUP_AGE_RECIPIENT"
  else
    local IFS=','; local r
    for r in $BACKUP_AGE_RECIPIENT; do
      r="${r#"${r%%[![:space:]]*}"}"; r="${r%"${r##*[![:space:]]}"}"  # trim
      [[ -n "$r" ]] && printf '%s\0' -r "$r"
    done
  fi
}

# Chiffre $1 avec age si un recipient est configuré, supprime le clair, et
# renvoie (sur stdout) le chemin de l'artefact final (.age) — sinon renvoie $1.
# Écriture atomique (.tmp puis rename) pour ne jamais laisser de .age tronqué.
maybe_encrypt() {
  local path="$1"
  if [[ -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then echo "$path"; return 0; fi
  command -v age >/dev/null 2>&1 || die "BACKUP_AGE_RECIPIENT défini mais 'age' introuvable (apt install age)"
  local out="${path}.age"
  local -a rargs=(); mapfile -d '' -t rargs < <(age_recipient_args)
  [[ ${#rargs[@]} -gt 0 ]] || die "BACKUP_AGE_RECIPIENT vide après parsing"
  if ! age "${rargs[@]}" -o "${out}.tmp.$$" "$path"; then
    rm -f "${out}.tmp.$$"; die "age: chiffrement échoué pour $path"
  fi
  mv -f "${out}.tmp.$$" "$out"
  sync "$out" 2>/dev/null || true
  rm -f "$path"
  echo "$out"
}

# Alerte best-effort (ne fait jamais échouer le script lui-même).
# POST vers POST /api/v1/ops/backup-alert (cf. backup.env.example). Le palier
# (tier) peut être renseigné par le script appelant via BACKUP_TIER.
alert() {
  local msg="$1"
  [[ -z "${ALERT_WEBHOOK:-}" ]] && return 0
  local payload
  payload=$(BACKUP_HOST="$(hostname)" BACKUP_TIER="${BACKUP_TIER:-}" BACKUP_MSG="$msg" \
    python3 -c 'import json,os; print(json.dumps({"event":"backup.failed","host":os.environ["BACKUP_HOST"],"tier":os.environ.get("BACKUP_TIER") or None,"message":os.environ["BACKUP_MSG"]}))')
  local args=(-fsS -m 10 -X POST -H 'Content-Type: application/json')
  [[ -n "${ALERT_TOKEN:-}" ]] && args+=(-H "X-Backup-Token: ${ALERT_TOKEN}")
  # shellcheck disable=SC2206  # word-split volontaire (ex. ALERT_CURL_OPTS=-k)
  [[ -n "${ALERT_CURL_OPTS:-}" ]] && args+=(${ALERT_CURL_OPTS})
  curl "${args[@]}" -d "$payload" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
}

# Expédie un fichier local hors-cluster selon SHIP_MODE (none|scp|s3).
ship_file() {
  local path="$1" subdir="${2:-}"
  case "${SHIP_MODE:-none}" in
    none)
      log "SHIP_MODE=none — $path reste en local uniquement"
      ;;
    scp)
      local dest="${SHIP_REMOTE_DIR}/${subdir}"
      ssh -i "$SHIP_SSH_KEY" "$SHIP_SSH" "mkdir -p '$dest'" \
        || die "ship scp: mkdir distant échoué"
      rsync -a -e "ssh -i $SHIP_SSH_KEY" "$path" "$SHIP_SSH:$dest/" \
        || die "ship scp: rsync échoué pour $path"
      log "expédié (scp) → $SHIP_SSH:$dest/"
      ;;
    s3)
      local key="${subdir:+$subdir/}$(basename "$path")"
      aws --endpoint-url "$S3_ENDPOINT" s3 cp "$path" "s3://${S3_BUCKET}/${key}" \
        || die "ship s3: aws s3 cp échoué pour $path"
      log "expédié (s3) → s3://${S3_BUCKET}/${key}"
      ;;
    *)
      die "SHIP_MODE inconnu: ${SHIP_MODE}"
      ;;
  esac
}
