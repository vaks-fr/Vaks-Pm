#!/usr/bin/env bash
# Installe HAProxy (LB devant Patroni — N backends).
# Variables :
#   DB_SERVERS="name1:ip1,name2:ip2,..."  (N-host)
#   — sinon fallback legacy : HOST1_IP, HOST2_IP, HOST3_IP.
# Le template infra/haproxy.cfg (marqueur __PG_SERVERS__) doit être présent à côté.
set -euo pipefail

# N-host : liste de serveurs fournie. Sinon, construction legacy 3-host.
if [ -z "${DB_SERVERS:-}" ]; then
  : "${HOST1_IP:?}"; : "${HOST2_IP:?}"; : "${HOST3_IP:?}"
  DB_SERVERS="host1:${HOST1_IP},host2:${HOST2_IP},host3:${HOST3_IP}"
fi

# Bloc de directives `server` (une ligne par nœud DB), inséré aux 2 marqueurs.
gen_servers() {
  local IFS=','
  for p in $DB_SERVERS; do
    printf '    server %s %s:5432 maxconn 200 check port 8008\n' "${p%%:*}" "${p#*:}"
  done
}
BLOCK="$(gen_servers)"

apt-get install -y haproxy
awk -v b="$BLOCK" '/__PG_SERVERS__/{printf "%s\n", b; next} {print}' \
    "$(dirname "$0")/haproxy.cfg" > /etc/haproxy/haproxy.cfg

systemctl enable --now haproxy
systemctl reload haproxy
echo "[30] HAProxy actif (write :5000, read :5001, stats :7000)"
