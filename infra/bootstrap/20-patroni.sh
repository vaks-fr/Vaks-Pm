#!/usr/bin/env bash
# Installe PostgreSQL 17 + Patroni (natif, hors Swarm) et rend patroni.yml.
# Variables : NODE_NAME, NODE_IP, REPL_USER, REPL_PASSWORD, SUPERUSER_PASSWORD
#   ETCD_ENDPOINTS="ip1:2379,ip2:2379,..."  (N-host)
#   — sinon fallback legacy : HOST1_IP, HOST2_IP, HOST3_IP.
# Le template infra/patroni.yml (marqueur __ETCD_HOSTS__) doit être présent à côté.
set -euo pipefail
: "${NODE_NAME:?}"; : "${NODE_IP:?}"; : "${REPL_USER:?}"; : "${REPL_PASSWORD:?}"; : "${SUPERUSER_PASSWORD:?}"

# N-host : endpoints etcd fournis. Sinon, construction legacy 3-host.
if [ -z "${ETCD_ENDPOINTS:-}" ]; then
  : "${HOST1_IP:?}"; : "${HOST2_IP:?}"; : "${HOST3_IP:?}"
  ETCD_ENDPOINTS="${HOST1_IP}:2379,${HOST2_IP}:2379,${HOST3_IP}:2379"
fi
# Bloc YAML `    - ip:2379` (une ligne par endpoint) pour etcd3.hosts.
gen_etcd_hosts() {
  local IFS=','
  for e in $ETCD_ENDPOINTS; do printf '    - %s\n' "$e"; done
}
ETCD_HOSTS_BLOCK="$(gen_etcd_hosts)"

apt-get install -y postgresql-17 postgresql-client-17 python3-pip python3-psycopg2
pip3 install --break-system-packages "patroni[etcd3]"

# PostgreSQL est piloté par Patroni : on désactive le service par défaut.
systemctl disable --now postgresql || true
# Si le data_dir est un point de montage (volume LUKS chiffré, cf. 18-luks-data.sh),
# on vide son CONTENU sans le démonter ; sinon comportement historique.
if mountpoint -q /var/lib/postgresql/17/main; then
  find /var/lib/postgresql/17/main -mindepth 1 -delete
else
  rm -rf /var/lib/postgresql/17/main && mkdir -p /var/lib/postgresql/17/main
fi
chown -R postgres:postgres /var/lib/postgresql/17
chmod 0700 /var/lib/postgresql/17/main

# TLS interne (DORA — in-transit). Copies postgres-owned du cert maître (posé par
# 12-certs.sh) : /etc/vaks/pg = serveur PostgreSQL (ssl=on dans la DCS), /etc/vaks/
# patroni = client etcd de Patroni (mTLS). L'utilisateur `postgres` existe depuis
# l'apt postgresql-17 ci-dessus. Le template patroni.yml référence ces chemins.
: "${PG_INTERNAL_TLS:=1}"
if [ "$PG_INTERNAL_TLS" = "1" ] && [ -f /etc/vaks/server.crt ]; then
  install -D -o postgres -g postgres -m 644 /etc/vaks/server.crt /etc/vaks/pg/server.crt
  install -D -o postgres -g postgres -m 600 /etc/vaks/server.key /etc/vaks/pg/server.key
  install -D -o postgres -g postgres -m 644 /etc/vaks/server.crt /etc/vaks/patroni/server.crt
  install -D -o postgres -g postgres -m 600 /etc/vaks/server.key /etc/vaks/patroni/server.key
else
  echo "[20] WARN: TLS interne PostgreSQL/etcd-client désactivé (cert absent ou PG_INTERNAL_TLS!=1)" >&2
fi

# Multi-DC : si STANDBY_PRIMARY_HOST est fourni, ce cluster est un STANDBY
# (réplication async depuis la primary via son HAProxy :5000). Sinon, primary.
if [ -n "${STANDBY_PRIMARY_HOST:-}" ]; then
  STANDBY_BLOCK="    standby_cluster:
      host: ${STANDBY_PRIMARY_HOST}
      port: 5000
      create_replica_methods:
        - basebackup"
else
  STANDBY_BLOCK=""
fi

# TLS interne (DORA) : blocs YAML injectés dans le template si activé. etcd3 passe
# en https (client mTLS vers etcd) ; PostgreSQL démarre avec ssl=on dès le bootstrap
# (params dans la DCS → pas de edit-config a posteriori). Cert maître auto-ancré.
if [ "${PG_INTERNAL_TLS:-1}" = "1" ] && [ -f /etc/vaks/server.crt ]; then
  ETCD_TLS_BLOCK="  protocol: https
  cacert: /etc/vaks/server.crt
  cert: /etc/vaks/patroni/server.crt
  key: /etc/vaks/patroni/server.key"
  PG_SSL_BLOCK="        ssl: \"on\"
        ssl_cert_file: /etc/vaks/pg/server.crt
        ssl_key_file: /etc/vaks/pg/server.key"
else
  ETCD_TLS_BLOCK=""
  PG_SSL_BLOCK=""
fi

# Rendu du template patroni.yml -> /etc/patroni.yml
# 1) scalaires via sed ; 2) blocs multi-ligne (etcd3.hosts, standby, TLS etcd, PG ssl) via awk.
sed -e "s|__NODE_NAME__|${NODE_NAME}|g" \
    -e "s|__NODE_IP__|${NODE_IP}|g" \
    -e "s|__REPL_USER__|${REPL_USER}|g" \
    -e "s|__REPL_PASSWORD__|${REPL_PASSWORD}|g" \
    -e "s|__SUPERUSER_PASSWORD__|${SUPERUSER_PASSWORD}|g" \
    "$(dirname "$0")/patroni.yml" \
  | awk -v b="$ETCD_TLS_BLOCK"   '/__ETCD_TLS__/{if(length(b))printf "%s\n", b; next} {print}' \
  | awk -v b="$ETCD_HOSTS_BLOCK" '/__ETCD_HOSTS__/{printf "%s\n", b; next} {print}' \
  | awk -v b="$STANDBY_BLOCK"    '/__STANDBY_CLUSTER__/{if(length(b))printf "%s\n", b; next} {print}' \
  | awk -v b="$PG_SSL_BLOCK"     '/__PG_SSL__/{if(length(b))printf "%s\n", b; next} {print}' \
  > /etc/patroni.yml
chown postgres:postgres /etc/patroni.yml

cat > /etc/systemd/system/patroni.service <<UNIT
[Unit]
Description=Patroni PostgreSQL HA
After=network.target etcd.service
[Service]
User=postgres
Group=postgres
ExecStart=/usr/local/bin/patroni /etc/patroni.yml
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now patroni
echo "[20] Patroni démarré sur ${NODE_NAME} (patronictl -c /etc/patroni.yml list)"
