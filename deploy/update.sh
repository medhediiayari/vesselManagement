#!/usr/bin/env bash
# Serveur : mise à jour vers la dernière version poussée sur GitHub (migrations Prisma appliquées au démarrage).
# Ne touche jamais aux données : db-dump/ ne sert qu'au premier déploiement.
# Usage : cd /opt/amc && bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod ps
docker image prune -f >/dev/null
