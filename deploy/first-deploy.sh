#!/usr/bin/env bash
# Serveur : premier démarrage. Restaure db-dump/amc.dump (si la base est vide), démarre la pile, importe db-dump/files.tgz.
# Usage : cd /opt/amc && bash deploy/first-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/docker-compose.prod.yml ${COMPOSE_OVERRIDE:+-f $COMPOSE_OVERRIDE} --env-file deploy/.env.prod"
[ -f deploy/.env.prod ] || { echo "deploy/.env.prod absent : lancer d'abord server-setup.sh" >&2; exit 1; }

echo "1/3 Base de données"
$COMPOSE up -d postgres
until $COMPOSE exec -T postgres pg_isready -h 127.0.0.1 -U amc -d amc >/dev/null 2>&1; do sleep 2; done
# -h 127.0.0.1 : pendant l'initialisation du volume, PostgreSQL n'écoute que sur le socket local ; le TCP signale la fin de l'init
tables=$($COMPOSE exec -T postgres psql -U amc -d amc -At -c "select count(*) from information_schema.tables where table_schema='public'")
if [ "$tables" = "0" ]; then
  $COMPOSE exec -T postgres pg_restore -U amc -d amc --no-owner --exit-on-error < db-dump/amc.dump
  echo "   base restaurée depuis db-dump/amc.dump"
else
  echo "   base déjà présente ($tables tables) : pas de restauration"
fi

echo "2/3 Construction et démarrage (premier build : plusieurs minutes)"
$COMPOSE up -d --build

echo "3/3 Fichiers"
if [ -f db-dump/files.tgz ]; then
  rm -rf /tmp/amc-files && mkdir -p /tmp/amc-files && tar -xzf db-dump/files.tgz -C /tmp/amc-files
  # Conteneur mc du service minio-init : identifiants MinIO déjà fournis, même réseau que MinIO
  $COMPOSE run --rm --no-deps -v /tmp/amc-files:/in:ro --entrypoint sh minio-init -c \
    'mc alias set p http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc cp --recursive --quiet /in/amc-files/ p/amc-files/'
  rm -rf /tmp/amc-files
fi

$COMPOSE ps
set -a; . deploy/.env.prod; set +a
echo "Application : https://$DOMAIN"
