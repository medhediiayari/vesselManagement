# Running the AMC platform with the exact current data

This repo ships a snapshot of the real development data, taken on 2026-10-28:

| File | Content |
|---|---|
| `db-dump/amc.dump` | PostgreSQL 16 dump (`pg_dump -Fc`) of the `amc` database: schema, migrations table, every row |
| `db-dump/minio-data.tgz` | Contents of the MinIO volume (buckets `amc-files`, `amc-quarantine`, `amc-exports`): PDFs, images and Excel files the database points to |

Restore **both**. If you skip MinIO, the database rows still reference files, and previews and downloads will fail.

## Prerequisites

- Node.js ≥ 20.10
- Docker Desktop (with Docker Compose v2)
- Free ports: 5434 (Postgres), 6380 (Redis), 9100/9101 (MinIO), 1025/8025 (Mailpit), 4000 (API), 3100 (Web)

## 1. Install

```bash
git clone https://github.com/medhediiayari/vesselManagement.git
cd vesselManagement
cp .env.example .env
npm install
```

## 2. Start the infrastructure

```bash
npm run infra:up
```

This starts the `amc_postgres`, `amc_minio` (+ bucket init), `amc_redis` and `amc_mailpit` containers. Compose project name `amc`, so the MinIO volume is called `amc_amc_minio`.

## 3. Restore the database

Do **not** run `db:migrate` or `db:seed` first: the dump already contains the schema, the migration history and all data.

```bash
docker cp db-dump/amc.dump amc_postgres:/tmp/amc.dump
docker exec amc_postgres pg_restore -U amc -d amc --clean --if-exists --no-owner /tmp/amc.dump
```

You can ignore errors that only say "does not exist" during `--clean`. Check the restore:

```bash
docker exec amc_postgres psql -U amc -d amc -c "select count(*) from users;"
```

## 4. Restore the MinIO files

```bash
docker compose -f infra/docker-compose.yml --env-file .env stop minio
docker run --rm -v amc_amc_minio:/data -v "$(pwd)/db-dump:/in" alpine sh -c "rm -rf /data/* /data/.minio.sys && tar xzf /in/minio-data.tgz -C /data"
docker compose -f infra/docker-compose.yml --env-file .env start minio
```

On Windows PowerShell, replace `$(pwd)` with `${PWD}`.

## 5. Run the apps

```bash
npm run build:types
npm run db:generate     # Prisma client only, does not touch the data
npm run dev:api         # http://localhost:4000/api/v1  (Swagger: /api/docs)
npm run dev:web         # http://localhost:3100
```

Other services: MinIO console http://localhost:9101 (`amc_minio` / `amc_minio_dev_password`), Mailpit http://localhost:8025.

## 6. Log in

The accounts are the ones in the database, not freshly seeded ones. They match the seed list in `README.md` §2:
`admin` / `ChangeMe!2026`, and the other accounts (`technical`, `crewing`, `purchasing`, `cso`, `operations`, `dpa`, `ops.manager`, `commercial`, …) with `Demo!2026pass`.

## Refreshing the snapshot (on the source machine)

```bash
docker exec amc_postgres pg_dump -U amc -d amc -Fc --no-owner -f /tmp/amc.dump
docker cp amc_postgres:/tmp/amc.dump db-dump/amc.dump
docker run --rm -v amc_amc_minio:/data -v "$(pwd)/db-dump:/out" alpine tar czf /out/minio-data.tgz -C /data .
```

## Starting from scratch instead (synthetic demo data)

```bash
npm run db:migrate && npm run db:seed
```
