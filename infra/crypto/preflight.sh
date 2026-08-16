#!/usr/bin/env bash
# Garde de disponibilité (LECTURE SEULE) avant tout retrofit chiffrement.
# Tourne EN ROOT sur un hôte db du cluster. N'écrit rien, ne mute rien : il décide
# seulement si l'on peut toucher aux données sans risque.
#
# Émet des lignes `RESULT:<check>=<pass|warn|fail>` (stdout, pour retrofit.mjs) +
# un verdict final `RESULT:preflight=PASS|FAIL`. Un `warn` n'échoue pas le gate
# (l'orchestrateur décide), un `fail` le fait passer FAIL.
#
# Flags (ce qu'on s'apprête à activer → ce qu'on vérifie) :
#   --luks-pg        headroom disque pgdata + joignabilité Tang
#   --luks-garage    headroom disque garage + joignabilité Tang
#   --pg-tls         (rien de spécifique au-delà du quorum)
#   --backup         présence d'un artefact de sauvegarde récent
#   PEER_TANG_IPS="ip1,ip2"  requis si --luks-*
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/crypto/_common.sh
source "$SELF_DIR/_common.sh"
require_root

CHECK_LUKS_PG=0 CHECK_LUKS_GARAGE=0 CHECK_PG_TLS=0 CHECK_BACKUP=0
for a in "$@"; do
  case "$a" in
    --luks-pg) CHECK_LUKS_PG=1 ;;
    --luks-garage) CHECK_LUKS_GARAGE=1 ;;
    --pg-tls) CHECK_PG_TLS=1 ;;
    --backup) CHECK_BACKUP=1 ;;
    *) warn "flag preflight inconnu ignoré: $a" ;;
  esac
done

FAIL=0
emit() { # emit <check> <pass|warn|fail> [message]
  result "$1=$2"; [[ "$2" == "fail" ]] && FAIL=1
  [[ -n "${3:-}" ]] && log "  [$2] $1: $3" || true
}

# 1. Quorum Patroni — toujours (un retrofit sur un cluster dégradé est interdit).
if patroni_cluster_healthy; then emit patroni pass "1 leader, membres sains, lag OK"
else emit patroni fail "cluster non sain (voir résumé) — refuser tant que non rétabli"; fi

# 2. etcd — best-effort (peut exiger des certs mTLS ; warn si indéterminé).
if have etcdctl; then
  if ETCDCTL_API=3 etcdctl endpoint health >/dev/null 2>&1; then emit etcd pass
  else emit etcd warn "endpoint health KO ou TLS requis — vérifier manuellement"; fi
else emit etcd warn "etcdctl absent sur cet hôte — non vérifié"; fi

# 3. Headroom disque pour les volumes LUKS demandés.
if [[ "$CHECK_LUKS_PG" == "1" ]]; then
  if luks_already_present "$PG_LUKS_FILE" "$PG_LUKS_MAPPER" "$PG_DATA_DIR"; then
    emit disk_pg pass "pgdata déjà chiffré (nœud à sauter)"
  elif disk_headroom_ok "$PG_DATA_DIR" "$PG_LUKS_FILE"; then emit disk_pg pass
  else emit disk_pg fail "espace insuffisant pour le conteneur LUKS pgdata"; fi
fi
if [[ "$CHECK_LUKS_GARAGE" == "1" ]]; then
  if luks_already_present "$GARAGE_LUKS_FILE" "$GARAGE_LUKS_MAPPER" "$GARAGE_DATA_DIR"; then
    emit disk_garage pass "garage déjà chiffré (nœud à sauter)"
  elif disk_headroom_ok "$GARAGE_DATA_DIR" "$GARAGE_LUKS_FILE"; then emit disk_garage pass
  else emit disk_garage fail "espace insuffisant pour le conteneur LUKS garage"; fi
fi

# 4. Joignabilité Tang des pairs (indispensable pour déverrouiller le LUKS au boot).
if [[ "$CHECK_LUKS_PG" == "1" || "$CHECK_LUKS_GARAGE" == "1" ]]; then
  if [[ -z "${PEER_TANG_IPS:-}" ]]; then emit tang fail "PEER_TANG_IPS requis pour un retrofit LUKS"
  else
    ok=1; IFS=',' read -ra peers <<< "$PEER_TANG_IPS"
    for ip in "${peers[@]}"; do tang_reachable "$ip" || { ok=0; warn "Tang injoignable: $ip"; }; done
    [[ "$ok" == "1" ]] && emit tang pass "tous les pairs Tang répondent" \
                       || emit tang fail "au moins un pair Tang injoignable"
  fi
fi

# 5. Présence d'un backup récent — jamais toucher aux données sans point de restauration.
if [[ "$CHECK_BACKUP" == "1" ]]; then
  # Heuristique : un artefact base/logical de moins de BACKUP_MAX_AGE_H heures dans
  # BACKUP_LOCAL_DIR (défaut /var/backups/vaks). Ajustable selon le SHIP_MODE réel.
  bdir="${BACKUP_LOCAL_DIR:-/var/backups/vaks}"; maxh="${BACKUP_MAX_AGE_H:-48}"
  if [[ -d "$bdir" ]] && find "$bdir" -type f \( -name '*.age' -o -name '*.tar.gz' -o -name '*.dump' \) \
        -mmin "-$((maxh*60))" 2>/dev/null | grep -q .; then
    emit backup pass "artefact < ${maxh}h présent dans $bdir"
  else
    emit backup warn "aucun backup récent détecté dans $bdir — CONFIRMER un point de restauration avant de continuer"
  fi
fi

if [[ "$FAIL" == "0" ]]; then result "preflight=PASS"; log "PREFLIGHT PASS"; exit 0
else result "preflight=FAIL"; log "PREFLIGHT FAIL"; exit 1; fi
