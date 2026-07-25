#!/usr/bin/env bash
# Chiffrement at-rest des **données** (DORA) : conteneurs LUKS2 file-backed pour
# Postgres (pgdata) et/ou Garage (S3), montés à leur emplacement de données. La
# clé est **released network-bound** via Clevis+Tang (SSS t=1 sur les PEERS) →
# un disque volé seul ne peut pas se déverrouiller. N'encrypte PAS le disque hôte
# ni l'OS : seuls les volumes de données, sans impact sur les autres charges.
#
# À lancer AVANT 20-patroni.sh (pgdata monté vide → initdb dedans) et avant le
# déploiement du stack (garage monté avant docker). Idempotent.
#
# Variables :
#   PEER_TANG_IPS="ip1,ip2"   (requis) IPs des hôtes Tang pairs (jamais soi-même)
#   SETUP_PG=1                (défaut 1) prépare le volume pgdata
#   SETUP_GARAGE=1            (défaut 1) prépare le volume garage
#   PG_SIZE=4G  GARAGE_SIZE=2G
set -euo pipefail
: "${PEER_TANG_IPS:?IPs Tang pairs requises (séparées par des virgules)}"
SETUP_PG="${SETUP_PG:-1}"; SETUP_GARAGE="${SETUP_GARAGE:-1}"
PG_SIZE="${PG_SIZE:-4G}"; GARAGE_SIZE="${GARAGE_SIZE:-2G}"

# Politique Clevis SSS t=1 sur les Tang pairs (déverrouille si ≥1 pair joignable).
build_pins() {
  local IFS=','; local arr=() ip
  for ip in $PEER_TANG_IPS; do arr+=("{\"url\":\"http://${ip}:7500\"}"); done
  local joined; joined=$(IFS=,; echo "${arr[*]}")
  echo "{\"t\":1,\"pins\":{\"tang\":[${joined}]}}"
}
PINS="$(build_pins)"

# Helper de déverrouillage+montage au boot (idempotent, attend un pair Tang).
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

# setup_store <file> <mapper> <mountpoint> <size> <unit-name> <before-unit>
setup_store() {
  local F="$1" N="$2" M="$3" SIZE="$4" UNIT="$5" BEFORE="$6"
  mkdir -p "$M"
  if [ ! -f "$F" ]; then
    fallocate -l "$SIZE" "$F"
    local PASS; PASS=$(openssl rand -base64 32)
    printf '%s' "$PASS" | cryptsetup luksFormat --type luks2 --batch-mode "$F" -
    printf '%s' "$PASS" | clevis luks bind -d "$F" -k - -y sss "$PINS"
    # Passphrase de secours (keyslot 0) : à exfiltrer hors cluster puis supprimer.
    printf '%s\n' "$PASS" > "/root/$(basename "$F").recovery.key"
    chmod 600 "/root/$(basename "$F").recovery.key"
  fi
  [ -b "/dev/mapper/$N" ] || clevis luks unlock -d "$F" -n "$N"
  blkid "/dev/mapper/$N" >/dev/null 2>&1 || mkfs.ext4 -q "/dev/mapper/$N"
  mountpoint -q "$M" || mount "/dev/mapper/$N" "$M"
  rm -rf "$M/lost+found"
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
}

if [ "$SETUP_PG" = "1" ]; then
  setup_store /var/lib/vaks-pgdata.luks pgdata_crypt /var/lib/postgresql/17/main \
    "$PG_SIZE" vaks-cryptmount-pgdata.service patroni.service
  # Patroni ne doit démarrer qu'une fois le volume monté.
  mkdir -p /etc/systemd/system/patroni.service.d
  printf '[Unit]\nRequires=vaks-cryptmount-pgdata.service\nAfter=vaks-cryptmount-pgdata.service\n' \
    > /etc/systemd/system/patroni.service.d/10-cryptmount.conf
  # chown/chmod différés à 20-patroni (l'utilisateur postgres n'existe pas encore).
fi

if [ "$SETUP_GARAGE" = "1" ]; then
  setup_store /var/lib/vaks-garage.luks garage_crypt /srv/vaks/garage \
    "$GARAGE_SIZE" vaks-cryptmount-garage.service docker.service
fi

systemctl daemon-reload
echo "[18] Volumes de données chiffrés prêts (pg=$SETUP_PG garage=$SETUP_GARAGE), déverrouillage Clevis/Tang via: $PEER_TANG_IPS"
