#!/bin/sh
# Crée les buckets privés AMC (idempotent).
#  - amc-files       : blobs officiels (versioning activé => aucun écrasement silencieux)
#  - amc-quarantine  : dépôts en attente d'analyse antivirus / fichiers infectés
#  - amc-exports     : ZIP / CSV / XLSX / PDF générés, expirés automatiquement après 2 jours
set -e

mc alias set amc http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for b in "$S3_BUCKET_FILES" "$S3_BUCKET_QUARANTINE" "$S3_BUCKET_EXPORTS"; do
  mc mb --ignore-existing "amc/$b"
  # Aucun accès anonyme : toute lecture passe par l'API (URL signée courte)
  mc anonymous set none "amc/$b"
done

mc version enable "amc/$S3_BUCKET_FILES" || echo "versioning non supporté sur ce déploiement MinIO"

# Expiration automatique des exports générés (reset + ajout => idempotent ; l'image mc n'a pas grep)
mc ilm rule rm --all --force "amc/$S3_BUCKET_EXPORTS" >/dev/null 2>&1 || true
mc ilm rule add --expire-days 2 "amc/$S3_BUCKET_EXPORTS"

echo "MinIO buckets prêts : $S3_BUCKET_FILES, $S3_BUCKET_QUARANTINE, $S3_BUCKET_EXPORTS"
