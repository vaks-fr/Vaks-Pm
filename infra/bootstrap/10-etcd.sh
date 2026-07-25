#!/usr/bin/env bash
# Installe et configure un nœud etcd (cluster N nœuds) pour Patroni.
# Variables attendues :
#   NODE_NAME, NODE_IP
#   ETCD_INITIAL_CLUSTER="name1=http://ip1:2380,name2=http://ip2:2380,..."  (N-host)
#   — sinon fallback legacy : HOST1_IP, HOST2_IP, HOST3_IP (cluster 3 nœuds).
set -euo pipefail
: "${NODE_NAME:?}"; : "${NODE_IP:?}"

# N-host : liste de cluster fournie directement. Sinon, construction legacy 3-host.
# Schéma https par défaut (TLS interne). Désactivable via ETCD_INTERNAL_TLS=0.
if [ -z "${ETCD_INITIAL_CLUSTER:-}" ]; then
  : "${HOST1_IP:?}"; : "${HOST2_IP:?}"; : "${HOST3_IP:?}"
  ETCD_INITIAL_CLUSTER="host1=https://${HOST1_IP}:2380,host2=https://${HOST2_IP}:2380,host3=https://${HOST3_IP}:2380"
fi

apt-get install -y etcd-server etcd-client || apt-get install -y etcd

# TLS interne (DORA — in-transit). Le cert maître a été posé par 12-certs.sh ;
# on en fait une copie etcd-owned (l'utilisateur `etcd` existe désormais) puis on
# configure etcd en **https d'emblée** (peer mTLS + client TLS). Le cert s'auto-
# ancre : trusted-ca = le cert lui-même. C'est facile au bootstrap (https dès le
# 1er démarrage) — le retrofit live d'etcd TLS est dangereux (cf. DORA_COMPLIANCE).
: "${ETCD_INTERNAL_TLS:=1}"
if [ "$ETCD_INTERNAL_TLS" = "1" ] && [ -f /etc/vaks/server.crt ]; then
  install -D -o etcd -g etcd -m 644 /etc/vaks/server.crt /etc/vaks/etcd/server.crt
  install -D -o etcd -g etcd -m 600 /etc/vaks/server.key /etc/vaks/etcd/server.key
  ETCD_SCHEME=https
  ETCD_TLS_BLOCK="ETCD_CERT_FILE=/etc/vaks/etcd/server.crt
ETCD_KEY_FILE=/etc/vaks/etcd/server.key
ETCD_TRUSTED_CA_FILE=/etc/vaks/etcd/server.crt
ETCD_CLIENT_CERT_AUTH=false
ETCD_PEER_CERT_FILE=/etc/vaks/etcd/server.crt
ETCD_PEER_KEY_FILE=/etc/vaks/etcd/server.key
ETCD_PEER_TRUSTED_CA_FILE=/etc/vaks/etcd/server.crt
ETCD_PEER_CLIENT_CERT_AUTH=true"
else
  echo "[10] WARN: TLS interne etcd désactivé (ETCD_INTERNAL_TLS!=1 ou cert absent) → http en clair" >&2
  ETCD_SCHEME=http
  ETCD_TLS_BLOCK=""
  # Réécrit le scheme de la liste cluster fournie en http si TLS off (cohérence).
  ETCD_INITIAL_CLUSTER="${ETCD_INITIAL_CLUSTER//https:/http:}"
fi

cat > /etc/default/etcd <<CFG
ETCD_NAME=${NODE_NAME}
ETCD_DATA_DIR=/var/lib/etcd/${NODE_NAME}
ETCD_LISTEN_PEER_URLS=${ETCD_SCHEME}://${NODE_IP}:2380
ETCD_LISTEN_CLIENT_URLS=${ETCD_SCHEME}://${NODE_IP}:2379,${ETCD_SCHEME}://127.0.0.1:2379
ETCD_INITIAL_ADVERTISE_PEER_URLS=${ETCD_SCHEME}://${NODE_IP}:2380
ETCD_ADVERTISE_CLIENT_URLS=${ETCD_SCHEME}://${NODE_IP}:2379
ETCD_INITIAL_CLUSTER=${ETCD_INITIAL_CLUSTER}
ETCD_INITIAL_CLUSTER_STATE=new
ETCD_INITIAL_CLUSTER_TOKEN=vakspm-etcd
${ETCD_TLS_BLOCK}
CFG

systemctl enable etcd
# etcd.service est Type=notify : avec un cluster 3 nœuds, il n'envoie « ready »
# qu'au quorum (>=2 nœuds en ligne). Comme l'orchestrateur configure les nœuds
# un par un, un `systemctl restart etcd` BLOQUANT timeouterait sur le 1er nœud
# (quorum impossible) et ferait échouer le bootstrap. On démarre donc en
# NON-BLOQUANT : etcd tourne et le quorum se forme dès que les nœuds suivants
# démarrent (Patroni tolère l'attente de la DCS et retente).
systemctl --no-block restart etcd
echo "[10] etcd configuré sur ${NODE_NAME} (start non-bloquant ; quorum au fil des nœuds)"
