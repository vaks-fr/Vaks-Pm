#!/usr/bin/env bash
# Installe le certificat TLS **interne** (self-signed, DORA — in-transit) dans
# /etc/vaks. Posé AVANT etcd (10) car etcd démarre en https d'emblée.
#
# Le cert/clé sont **partagés** par tous les nœuds (mêmes octets) — requis pour le
# mTLS pair etcd auto-ancré : chaque nœud fait confiance au cert présenté par ses
# pairs en l'utilisant lui-même comme CA (trusted-ca = le cert). L'orchestrateur
# (infra/cluster → deploy.gen.sh) le génère une fois et le distribue dans ./certs.
#
# Ce script ne pose QUE la copie maître root-owned. Les copies par-service
# (/etc/vaks/{etcd,pg,patroni}) sont créées par 10-etcd.sh et 20-patroni.sh une
# fois les utilisateurs système (etcd, postgres) créés par apt.
#
# Cert auto-signé = chiffrement sans vérification d'identité (rejectUnauthorized
# off côté app/etcd). Pour une vraie PKI client (verify-full), cf.
# docs/{en,fr}/tls-internal-custom-ca.html.
set -euo pipefail

CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")" && pwd)/certs}"
SRC_CRT="$CERT_DIR/server.crt"
SRC_KEY="$CERT_DIR/server.key"

if [ ! -f "$SRC_CRT" ] || [ ! -f "$SRC_KEY" ]; then
  echo "[12] FATAL: cert source absent dans $CERT_DIR — l'orchestrateur doit le générer/distribuer (deploy.gen.sh étape 0)." >&2
  exit 1
fi

install -d -m 755 /etc/vaks
install -m 644 "$SRC_CRT" /etc/vaks/server.crt
install -m 600 "$SRC_KEY" /etc/vaks/server.key

echo "[12] cert interne installé: /etc/vaks/server.{crt,key} (copies par-service posées par 10/20)"
