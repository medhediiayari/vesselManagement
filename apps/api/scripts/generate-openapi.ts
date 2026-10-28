/**
 * Génère apps/api/openapi.json sans démarrer le serveur HTTP (CI, documentation).
 * Usage : npm run openapi -w @amc/api
 */
import '../src/load-env';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { buildOpenApi } from '../src/openapi';

async function main() {
  process.env.WORKERS_ENABLED = 'false';
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  const doc = buildOpenApi(app);
  const out = resolve(__dirname, '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(doc, null, 2));
  // eslint-disable-next-line no-console
  console.log(`OpenAPI : ${Object.keys(doc.paths).length} routes -> ${out}`);
  await app.close().catch(() => undefined);
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
