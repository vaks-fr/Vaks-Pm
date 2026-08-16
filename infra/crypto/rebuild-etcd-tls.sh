#!/usr/bin/env bash
# Tier B/C — active le TLS interne d'etcd (peer + client mTLS) sur un cluster déjà
# en marche. ⚠️ Le RETROFIT LIVE d'etcd par `etcdctl member update` + restart a
# DÉJÀ cassé la prod (DCS HS, DB read-only ~15 min). La SEULE méthode sanctionnée
# est le REBUILD FRESH en https : la donnée etcd est jetable, Patroni recrée le
# DCS. Ce script REFUSE tout mode member-update live (garde Tier C) — ce chemin
# n'est pas implémenté, par design.
#
# À lancer sur le MANAGER de pilotage etcd (host1). Fenêtre de maintenance requise.
#   HOSTS="ip1,ip2,ip3"       liste des nœuds etcd (passée par retrofit.mjs)
#   MODE=live-update          → REFUSÉ explicitement (démonstration du garde-fou)
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/crypto/_common.sh
source "$SELF_DIR/_common.sh"
require_root

# ─── Garde-fou Tier C : le member-update live est INTERDIT ────────────────────
if [[ "${MODE:-}" == "live-update" ]]; then
  cat >&2 <<'MSG'
REFUS : le retrofit etcd-TLS par `etcdctl member update` sur un cluster vivant
n'est PAS supporté (il a déjà provoqué une panne DCS de ~15 min). Ce chemin n'est
pas implémenté. Procédure sanctionnée = REBUILD FRESH :
  1. Fenêtre de maintenance (DCS momentanément indisponible → PG read-only bref).
  2. Arrêter patroni sur les 3 nœuds, puis etcd.
  3. Jeter la donnée etcd (/var/lib/etcd/*) — elle est reconstruite par Patroni.
  4. Re-bootstrapper etcd EN HTTPS d'emblée (infra/bootstrap/10-etcd.sh,
     ETCD_INTERNAL_TLS=1) sur les 3 nœuds — cert maître /etc/vaks/server.crt.
  5. Redémarrer patroni : il recrée le DCS (ssl=on PG re-capturé seul).
Relancer ce script SANS MODE=live-update pour exécuter ce rebuild-fresh de façon guidée.
MSG
  result "etcd_tls=refused_live_update"
  exit 2
fi

require_cmd etcdctl 2>/dev/null || true
[[ -f /etc/vaks/server.crt ]] || die "cert interne /etc/vaks/server.crt absent — le distribuer sur tous les nœuds etcd avant le rebuild"
: "${HOSTS:?HOSTS requis (nœuds etcd, séparés par des virgules)}"

log "REBUILD FRESH etcd en https — DCS momentanément indisponible (PG read-only bref)."
log "Nœuds etcd cibles : $HOSTS"
confirm "Rebuild FRESH d'etcd en TLS maintenant (fenêtre de maintenance) ?"

# Ce script tourne sur UN nœud ; le rebuild est cross-host. Il exécute LOCALEMENT
# sa part et documente la séquence globale — retrofit.mjs (ou l'opérateur) enchaîne
# les nœuds. On NE jette PAS aveuglément la donnée etcd sans que patroni soit arrêté.
LOCAL_STEP() {
  log "[local] arrêt patroni + etcd, purge data etcd, re-bootstrap https"
  systemctl stop patroni 2>/dev/null || true
  systemctl stop etcd 2>/dev/null || true
  # Donnée etcd jetable (Patroni recrée le DCS). Sauvegarde horodatée par prudence.
  if [[ -d /var/lib/etcd ]] && [[ -n "$(ls -A /var/lib/etcd 2>/dev/null)" ]]; then
    mv /var/lib/etcd "/var/lib/etcd.pretls.$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p /var/lib/etcd
  fi
  # Re-bootstrap etcd EN HTTPS via le script bootstrap (source de vérité TLS).
  local boot=""
  for p in "$SELF_DIR/../bootstrap/10-etcd.sh" ~/vakspm-cluster/bootstrap/10-etcd.sh ~/vakspm/bootstrap/10-etcd.sh; do
    [[ -f "$p" ]] && { boot="$p"; break; }
  done
  [[ -n "$boot" ]] || die "10-etcd.sh introuvable — impossible de re-bootstrapper etcd en https"
  ETCD_INTERNAL_TLS=1 bash "$boot"
  systemctl start patroni
}

LOCAL_STEP
if wait_seconds=60; sleep 5; patroni_cluster_healthy 2>/dev/null; then
  result "etcd_tls=ok_local"
  log "Nœud local rebâti en https. Répéter sur les autres nœuds etcd puis vérifier patronictl list + endpoints https."
else
  result "etcd_tls=pending"
  warn "cluster pas encore sain — normal tant que les autres nœuds etcd ne sont pas rebâtis. Enchaîner les nœuds restants."
fi
