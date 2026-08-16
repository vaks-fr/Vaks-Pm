#!/usr/bin/env bash
# Retrofit LUKS d'UN store sur le nœud LOCAL (host-side, root). Migration
# node-by-node ZÉRO-DOWNTIME : le séquencement cross-cluster (réplica d'abord,
# gate de lag, switchover, ex-leader en dernier) est piloté par `retrofit.mjs`.
# Ce script ne fait que la bascule locale d'un store, de façon idempotente.
#
# Réutilise la MÊME recette Clevis/Tang que `infra/bootstrap/18-luks-data.sh`
# (conteneur LUKS2 file-backed + bind SSS t=1 sur les pairs + unit systemd), mais
# pour un volume dont les DONNÉES EXISTENT DÉJÀ : on met le clair de côté
# (`<data>.preluks`, purge manuelle après validation), on monte le volume chiffré
# VIDE, et on laisse la couche métier re-peupler (Patroni basebackup / Garage
# re-réplication depuis les pairs).
#
#   enable-luks.sh --pg        # migre pgdata (nœud DOIT être un réplica, ou l'ex-leader après switchover)
#   enable-luks.sh --garage    # migre le store Garage
#   PEER_TANG_IPS="ip1,ip2"    # requis (pairs Tang, jamais soi-même)
#   PURGE_PLAINTEXT=1          # (défaut 0) shred le .preluks après rebase (sinon laissé pour validation)
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/crypto/_common.sh
source "$SELF_DIR/_common.sh"
require_root
require_cmd cryptsetup; require_cmd clevis; require_cmd openssl
: "${PEER_TANG_IPS:?PEER_TANG_IPS requis (pairs Tang, séparés par des virgules)}"
PURGE_PLAINTEXT="${PURGE_PLAINTEXT:-0}"

STORE=""
for a in "$@"; do case "$a" in --pg) STORE=pg ;; --garage) STORE=garage ;; esac; done
[[ -n "$STORE" ]] || die "préciser --pg ou --garage"

# Politique Clevis SSS t=1 sur les pairs (identique à 18-luks-data.sh:build_pins).
build_pins() {
  local IFS=','; local arr=() ip
  for ip in $PEER_TANG_IPS; do arr+=("{\"url\":\"http://${ip}:7500\"}"); done
  local joined; joined=$(IFS=,; echo "${arr[*]}")
  echo "{\"t\":1,\"pins\":{\"tang\":[${joined}]}}"
}

# Crée le conteneur LUKS, le bind à Tang, formate, monte + pose l'unit systemd.
# (Reprend setup_store de 18-luks-data.sh ; le point de montage est déjà vide ici.)
luks_create_and_mount() {
  local F="$1" N="$2" M="$3" SIZE="$4" UNIT="$5" BEFORE="$6" PINS
  PINS="$(build_pins)"
  if [[ ! -f "$F" ]]; then
    fallocate -l "$SIZE" "$F"
    local PASS; PASS=$(openssl rand -base64 32)
    printf '%s' "$PASS" | cryptsetup luksFormat --type luks2 --batch-mode "$F" -
    printf '%s' "$PASS" | clevis luks bind -d "$F" -k - -y sss "$PINS"
    printf '%s\n' "$PASS" > "/root/$(basename "$F").recovery.key"; chmod 600 "/root/$(basename "$F").recovery.key"
    log "conteneur LUKS créé + bind Tang : $F (clé de secours dans /root/$(basename "$F").recovery.key — à exfiltrer puis supprimer)"
  fi
  [[ -b "/dev/mapper/$N" ]] || clevis luks unlock -d "$F" -n "$N"
  blkid "/dev/mapper/$N" >/dev/null 2>&1 || mkfs.ext4 -q "/dev/mapper/$N"
  mountpoint -q "$M" || mount "/dev/mapper/$N" "$M"
  rm -rf "$M/lost+found"
  # Unit de déverrouillage+montage au boot (le helper est déjà posé par 18-luks ;
  # on le (re)pose ici au cas où le retrofit tourne sur un hôte jamais bootstrappé LUKS).
  if [[ ! -x /usr/local/sbin/vaks-cryptmount.sh ]]; then
    cat > /usr/local/sbin/vaks-cryptmount.sh <<'SH'
#!/bin/bash
set -e
F="$1"; N="$2"; M="$3"
for i in $(seq 1 30); do
  [ -e "/dev/mapper/$N" ] && break
  clevis luks unlock -d "$F" -n "$N" 2>/dev/null && break || true
  sleep 2
done
[ -e "/dev/mapper/$N" ] || { echo "cryptmount: unlock failed $F" >&2; exit 1; }
mountpoint -q "$M" || mount "/dev/mapper/$N" "$M"
SH
    chmod 755 /usr/local/sbin/vaks-cryptmount.sh
  fi
  cat > "/etc/systemd/system/$UNIT" <<UNIT
[Unit]
Description=Unlock+mount encrypted data ($N) via Clevis/Tang
DefaultDependencies=no
Wants=network-online.target
After=network-online.target
Before=$BEFORE
ConditionPathExists=$F
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/vaks-cryptmount.sh $F $N $M
ExecStop=/bin/umount $M
ExecStop=/sbin/cryptsetup close $N
[Install]
WantedBy=multi-user.target
UNIT
  systemctl enable "$UNIT" >/dev/null 2>&1
  systemctl daemon-reload
}

# Met le répertoire de données CLAIR de côté (même FS → rename instantané), puis
# recrée un point de montage vide. Idempotent : ne réécrase jamais un .preluks.
move_plaintext_aside() {
  local dir="$1"; local aside="${dir}.preluks"
  if mountpoint -q "$dir"; then die "$dir est déjà un point de montage — état inattendu, abandon"; fi
  if [[ -e "$aside" ]]; then
    warn "$aside existe déjà (retrofit précédent ?) — on ne touche pas au clair, on repart du dir courant"
  elif [[ -d "$dir" ]] && [[ -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
    mv "$dir" "$aside"; log "clair mis de côté : $aside (à purger APRÈS validation)"
  fi
  mkdir -p "$dir"
}

purge_plaintext() {
  local dir="$1"; local aside="${dir}.preluks"
  [[ -d "$aside" ]] || return 0
  if [[ "$PURGE_PLAINTEXT" == "1" ]]; then
    log "purge du clair résiduel $aside (shred best-effort)"
    find "$aside" -type f -exec shred -u {} + 2>/dev/null || true
    rm -rf "$aside"
  else
    warn "clair résiduel conservé : $aside — le SUPPRIMER après validation (PURGE_PLAINTEXT=1 ou rm manuel)"
  fi
}

# Attend que le postgres local revienne 'running'/'streaming' (timeout WAIT_S, déf 900s).
wait_patroni_local_healthy() {
  local host; host="$(hostname)"; local deadline=$(( SECONDS + ${WAIT_S:-900} ))
  while (( SECONDS < deadline )); do
    local role; role="$(patroni_local_role)"
    local state; state="$(patroni_json | python3 -c '
import json,sys
host=sys.argv[1]
try: rows=json.load(sys.stdin)
except Exception: rows=[]
for r in rows:
    if r.get("Member")==host: print((r.get("State") or "").lower()); break
else: print("unknown")
' "$host")"
    log "  patroni local: role=$role state=$state"
    [[ "$state" == "running" || "$state" == "streaming" ]] && return 0
    sleep 10
  done
  return 1
}

case "$STORE" in
  pg)
    if luks_already_present "$PG_LUKS_FILE" "$PG_LUKS_MAPPER" "$PG_DATA_DIR"; then
      result "luks=skipped"; log "pgdata déjà chiffré sur ce nœud — rien à faire"; exit 0
    fi
    local_role="$(patroni_local_role)"
    [[ "$local_role" == "leader" ]] && die "ce nœud est LEADER — ne jamais migrer le leader (faire un switchover d'abord, cf. retrofit.mjs)"
    log "arrêt de patroni (le réplica va se re-cloner sur le volume chiffré)"
    systemctl stop patroni
    move_plaintext_aside "$PG_DATA_DIR"
    luks_create_and_mount "$PG_LUKS_FILE" "$PG_LUKS_MAPPER" "$PG_DATA_DIR" "${PG_SIZE:-4G}" \
      vaks-cryptmount-pgdata.service patroni.service
    # Patroni doit démarrer APRÈS le montage (dépendance systemd, comme au bootstrap).
    mkdir -p /etc/systemd/system/patroni.service.d
    printf '[Unit]\nRequires=vaks-cryptmount-pgdata.service\nAfter=vaks-cryptmount-pgdata.service\n' \
      > /etc/systemd/system/patroni.service.d/10-cryptmount.conf
    chown -R postgres:postgres "$PG_DATA_DIR"; chmod 700 "$PG_DATA_DIR"
    systemctl daemon-reload
    log "redémarrage de patroni → basebackup depuis le leader sur le volume chiffré"
    systemctl start patroni
    if wait_patroni_local_healthy; then
      purge_plaintext "$PG_DATA_DIR"
      result "luks=ok"; log "pgdata chiffré, réplica re-synchronisé"
    else
      result "luks=degraded"; die "patroni n'est pas revenu sain dans le délai — investiguer AVANT de continuer (clair conservé dans ${PG_DATA_DIR}.preluks)"
    fi
    ;;
  garage)
    if luks_already_present "$GARAGE_LUKS_FILE" "$GARAGE_LUKS_MAPPER" "$GARAGE_DATA_DIR"; then
      result "luks=skipped"; log "garage déjà chiffré sur ce nœud — rien à faire"; exit 0
    fi
    # ⚠️ Un seul nœud Garage à la fois (quorum). retrofit.mjs sérialise les nœuds ;
    # ce script suppose que le quorum est sain à l'entrée (preflight).
    log "arrêt du conteneur Garage local (re-réplication depuis les pairs après montage)"
    cid="$(docker ps -q -f name=garage | head -n1 || true)"
    [[ -n "$cid" ]] && docker stop "$cid" >/dev/null 2>&1 || warn "aucun conteneur garage local trouvé (déjà arrêté ?)"
    move_plaintext_aside "$GARAGE_DATA_DIR"
    luks_create_and_mount "$GARAGE_LUKS_FILE" "$GARAGE_LUKS_MAPPER" "$GARAGE_DATA_DIR" "${GARAGE_SIZE:-2G}" \
      vaks-cryptmount-garage.service docker.service
    # Swarm relance la tâche garage sur ce nœud → elle repart d'un store vide et
    # se re-réplique depuis les pairs (garage-reconnect ré-appaire le cluster).
    log "Swarm va relancer la tâche Garage ; laisser le layout re-converger (garage status)"
    purge_plaintext "$GARAGE_DATA_DIR"
    result "luks=ok"; log "store Garage chiffré (re-réplication en cours — vérifier 'garage status' avant le nœud suivant)"
    ;;
esac
