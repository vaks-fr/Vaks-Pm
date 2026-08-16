#!/usr/bin/env bash
# Tier A — active le TLS interne PostgreSQL/Patroni sur un cluster déjà en marche.
# Contrairement à etcd, ssl=on se retrofit SANS danger : edit-config DCS + restart
# rolling (le quorum est préservé). Réplication chiffrée automatiquement (replica
# prefer→SSL). Réutilise les MÊMES chemins de certs que `infra/bootstrap/20-patroni.sh`.
#
# ⚠️ Le cert interne doit être le MÊME sur TOUS les nœuds (mTLS réplication) :
#    retrofit.mjs distribue /etc/vaks/server.{crt,key} à tous les hôtes AVANT
#    d'appeler ce script sur le leader. Si absent, on peut en générer un local
#    (HOST_IPS fourni) mais il faut alors le propager aux autres nœuds.
#
#   enable-pg-tls.sh --server      # ssl=on côté serveur/DCS + restart rolling
#   HOST_IPS="ip1 ip2 ip3"         # (optionnel) SAN si génération d'un cert self-signed
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/crypto/_common.sh
source "$SELF_DIR/_common.sh"
require_root
require_cmd patronictl

MASTER_CRT=/etc/vaks/server.crt
MASTER_KEY=/etc/vaks/server.key

ensure_master_cert() {
  [[ -f "$MASTER_CRT" && -f "$MASTER_KEY" ]] && { log "cert interne présent: $MASTER_CRT"; return 0; }
  [[ -n "${HOST_IPS:-}" ]] || die "cert interne absent ($MASTER_CRT) et HOST_IPS non fourni — distribuer le cert d'abord (retrofit.mjs) ou fournir HOST_IPS pour en générer un"
  require_cmd openssl
  warn "génération d'un cert self-signed local (À PROPAGER aux autres nœuds avant le restart)"
  local san="DNS:localhost,IP:127.0.0.1"; for ip in $HOST_IPS; do san+=",IP:$ip"; done
  mkdir -p /etc/vaks
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=vaks-internal" -addext "subjectAltName=$san" \
    -addext "extendedKeyUsage=serverAuth,clientAuth" \
    -keyout "$MASTER_KEY" -out "$MASTER_CRT" >/dev/null 2>&1
  chmod 600 "$MASTER_KEY"; chmod 644 "$MASTER_CRT"
}

install_pg_certs() {
  install -D -o postgres -g postgres -m 644 "$MASTER_CRT" /etc/vaks/pg/server.crt
  install -D -o postgres -g postgres -m 600 "$MASTER_KEY" /etc/vaks/pg/server.key
  install -D -o postgres -g postgres -m 644 "$MASTER_CRT" /etc/vaks/patroni/server.crt
  install -D -o postgres -g postgres -m 600 "$MASTER_KEY" /etc/vaks/patroni/server.key
}

scope_name() { awk -F': *' '/^scope:/{print $2; exit}' "$PATRONI_CONF"; }

case "${1:-}" in
  --server) ;;
  *) die "usage: enable-pg-tls.sh --server" ;;
esac

if grep -q 'ssl_cert_file' <(patronictl -c "$PATRONI_CONF" show-config 2>/dev/null) \
   && patronictl -c "$PATRONI_CONF" show-config 2>/dev/null | grep -qE 'ssl:\s*("?on"?|true)'; then
  result "pg_tls=already_on"; log "ssl déjà activé dans la DCS — rien à faire"; exit 0
fi

ensure_master_cert
install_pg_certs

local_role="$(patroni_local_role)"
[[ "$local_role" == "leader" ]] || warn "ce nœud n'est pas le leader ($local_role) — edit-config fonctionne quand même, mais lancer depuis le leader est plus sûr"

log "edit-config: ssl=on + chemins cert (appliqué à toute la DCS)"
confirm "Activer ssl=on sur le cluster PostgreSQL et redémarrer les membres en rolling ?"
patronictl -c "$PATRONI_CONF" edit-config --force \
  -s postgresql.parameters.ssl=on \
  -s postgresql.parameters.ssl_cert_file=/etc/vaks/pg/server.crt \
  -s postgresql.parameters.ssl_key_file=/etc/vaks/pg/server.key

SCOPE="$(scope_name)"; [[ -n "$SCOPE" ]] || die "scope Patroni introuvable dans $PATRONI_CONF"

# Restart ROLLING : réplicas d'abord, leader en dernier (ssl exige un restart pg).
mapfile -t MEMBERS < <(patroni_json | python3 -c '
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
reps=[r["Member"] for r in rows if "leader" not in (r.get("Role") or "").lower()]
lead=[r["Member"] for r in rows if "leader" in (r.get("Role") or "").lower()]
print("\n".join(reps+lead))
')
for m in "${MEMBERS[@]}"; do
  [[ -n "$m" ]] || continue
  log "restart membre $m"
  patronictl -c "$PATRONI_CONF" restart "$SCOPE" "$m" --force >/dev/null 2>&1 \
    || warn "restart $m a signalé une erreur (vérifier patronictl list)"
  sleep 5
done

if patroni_cluster_healthy; then
  result "pg_tls=ok"; log "TLS PostgreSQL activé (ssl=on). App→PG : flip PG_TLS=1 via le manifest + rolling api/worker (voir docs)."
else
  result "pg_tls=degraded"; die "cluster non sain après restart — investiguer (patronictl list)"
fi
