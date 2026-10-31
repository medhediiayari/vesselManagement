#!/usr/bin/env bash
# Sauvegarde de la base de production (format custom pg_dump), 14 jours conservés.
# Lancé chaque nuit par /etc/cron.d/amc-backup (voir server-setup.sh), depuis /opt/amc.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod"
STAMP=$(date -u +%Y%m%d-%H%M%S)
$COMPOSE exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "deploy/backups/amc-$STAMP.dump"
find deploy/backups -name 'amc-*.dump' -mtime +14 -delete
echo "$(date -u +%FT%TZ) sauvegarde amc-$STAMP.dump OK"
