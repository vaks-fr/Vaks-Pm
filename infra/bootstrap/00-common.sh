#!/usr/bin/env bash
# Prépare un hôte Debian 12 : paquets de base + Docker Engine.
# Idempotent. À exécuter en root (ou via sudo) sur CHAQUE VM.
set -euo pipefail

echo "[00] mise à jour & paquets de base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release ufw chrony

if ! command -v docker >/dev/null 2>&1; then
  echo "[00] installation de Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --no-tty --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

echo "[00] OK sur $(hostname)"
