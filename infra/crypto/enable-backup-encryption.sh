#!/usr/bin/env bash
# Tier A — active le chiffrement `age` des artefacts de sauvegarde sur ce nœud.
# Purement ADDITIF : pose/actualise `BACKUP_AGE_RECIPIENT` dans l'env backup ; les
# NOUVEAUX artefacts sont chiffrés dès leur création (cf. infra/backup/_common.sh
# maybe_encrypt), les anciens restent lisibles. Réversible (vider la variable).
#
#   BACKUP_AGE_RECIPIENT="age1…|ssh-…|/chemin/recipients"   (requis)
#   VAKS_BACKUP_ENV=/etc/vaks-backup.env                    (défaut)
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/crypto/_common.sh
source "$SELF_DIR/_common.sh"
require_root
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT requis (recipient age/ssh ou chemin vers un fichier de recipients)}"

ENV_FILE="${VAKS_BACKUP_ENV:-/etc/vaks-backup.env}"
[[ -f "$ENV_FILE" ]] || die "env backup introuvable: $ENV_FILE (les sauvegardes host-side ne sont pas installées ?)"

# 'age' doit être présent, sinon les prochains backups échoueraient (maybe_encrypt die).
have age || die "'age' introuvable — installer d'abord (apt install age) avant d'activer le chiffrement des backups"

# Édition SÛRE : on retire l'éventuelle ligne existante (clé ancrée en début de ligne,
# JAMAIS un sed sur la valeur) puis on ré-ajoute — un backup .bak est laissé.
cp -f "$ENV_FILE" "${ENV_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp)"
grep -v '^[[:space:]]*BACKUP_AGE_RECIPIENT=' "$ENV_FILE" > "$tmp" || true
printf 'BACKUP_AGE_RECIPIENT=%s\n' "$BACKUP_AGE_RECIPIENT" >> "$tmp"
install -m 600 "$tmp" "$ENV_FILE"; rm -f "$tmp"
log "BACKUP_AGE_RECIPIENT posé dans $ENV_FILE — les prochains artefacts seront chiffrés (age)"

# Vérification best-effort : chiffrer un témoin avec le recipient prouve qu'il est valide.
probe="$(mktemp)"; echo "vaks-age-probe" > "$probe"
if ( set -a; source "$ENV_FILE"; set +a
     # réutilise la logique de parsing des recipients de _common backup
     args=(); if [[ -f "$BACKUP_AGE_RECIPIENT" ]]; then args=(-R "$BACKUP_AGE_RECIPIENT");
       else IFS=','; for r in $BACKUP_AGE_RECIPIENT; do r="${r// /}"; [[ -n "$r" ]] && args+=(-r "$r"); done; fi
     age "${args[@]}" -o "${probe}.age" "$probe" ) 2>/dev/null; then
  rm -f "$probe" "${probe}.age"
  result "backup_encryption=ok"; log "recipient age validé (témoin chiffré/supprimé)"
else
  rm -f "$probe" "${probe}.age"
  result "backup_encryption=recipient_invalid"
  die "le recipient age est invalide (chiffrement témoin échoué) — corriger BACKUP_AGE_RECIPIENT"
fi
