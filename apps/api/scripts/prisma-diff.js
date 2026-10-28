/**
 * Génère le SQL nécessaire pour passer de l'historique de migrations au schema.prisma courant.
 * Usage : npm run prisma:diff -w @amc/api > prisma/migrations/000X_nom/migration.sql
 * Relire le SQL : supprimer les DROP visant les objets de 0002_db_hardening (index partiels,
 * index trigrammes, colonne FTS générée) que Prisma ne sait pas représenter.
 */
const { spawnSync } = require('node:child_process');

const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) {
  console.error('SHADOW_DATABASE_URL manquant (voir .env)');
  process.exit(1);
}
const res = spawnSync(
  'npx',
  [
    'prisma', 'migrate', 'diff',
    '--from-migrations', 'prisma/migrations',
    '--to-schema-datamodel', 'prisma/schema.prisma',
    '--shadow-database-url', shadow,
    '--script',
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(res.status ?? 1);
