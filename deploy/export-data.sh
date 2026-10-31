#!/usr/bin/env bash
# Poste de développement : met à jour db-dump/ avec la base locale actuelle, pour l'environnement de test.
#   db-dump/amc.dump   : base complète (pg_dump format custom)
#   db-dump/files.tgz  : fichiers référencés par la base, rangés en <bucket>/<clé> (pas le volume MinIO brut)
# Usage (Git Bash, racine du dépôt, Docker Desktop démarré) : bash deploy/export-data.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p db-dump "$WORK/files/amc-files"

docker exec amc_postgres pg_dump -U amc -d amc -Fc -f /tmp/amc-export.dump
docker cp amc_postgres:/tmp/amc-export.dump "$(cygpath -w "$PWD/db-dump/amc.dump")"
docker exec amc_postgres rm -f /tmp/amc-export.dump

docker exec amc_postgres psql -U amc -d amc -At -c \
  "select object_key from files where deleted_at is null union select thumbnail_key from files where deleted_at is null and thumbnail_key is not null" \
  > "$WORK/keys.txt"
MINIO_USER=$(grep '^MINIO_ROOT_USER=' .env | cut -d= -f2)
MINIO_PASS=$(grep '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2)
while IFS= read -r key; do
  [ -z "$key" ] && continue
  docker run --rm --network amc_network -e MC_HOST_l="http://$MINIO_USER:$MINIO_PASS@minio:9000" \
    -v "$(cygpath -w "$WORK/files")":/out minio/mc:latest cp --quiet "l/amc-files/$key" "/out/amc-files/$key" >/dev/null
done < "$WORK/keys.txt"
tar -czf db-dump/files.tgz -C "$WORK/files" .

echo "db-dump/amc.dump  : $(du -h db-dump/amc.dump | cut -f1)"
echo "db-dump/files.tgz : $(grep -c . "$WORK/keys.txt") fichier(s), $(du -h db-dump/files.tgz | cut -f1)"
