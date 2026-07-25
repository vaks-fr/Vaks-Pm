#!/usr/bin/env bash
# Installe Tang (serveur de clés réseau) + Clevis pour le déverrouillage
# **network-bound** des volumes de données chiffrés (LUKS) — voir 18-luks-data.sh.
# tangd écoute sur :7500 (socket-activé). Stateless : aucun secret par client.
# Idempotent.
set -euo pipefail

apt-get install -y tang clevis clevis-luks cryptsetup-bin

# tangd.socket de base écoute sur :80 → on le bascule sur :7500 (réseau interne).
mkdir -p /etc/systemd/system/tangd.socket.d
cat > /etc/systemd/system/tangd.socket.d/override.conf <<'EOF'
[Socket]
ListenStream=
ListenStream=0.0.0.0:7500
EOF
systemctl daemon-reload
systemctl enable --now tangd.socket

# Première génération des clés de signature/échange (via une 1ʳᵉ requête).
sleep 1
if curl -fsS http://localhost:7500/adv >/dev/null 2>&1; then
  echo "[15] Tang prêt sur :7500 (advertisement OK)"
else
  echo "[15] Tang activé sur :7500 (advertisement pas encore servi — normal au 1er boot)"
fi
