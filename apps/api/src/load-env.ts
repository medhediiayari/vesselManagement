import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Charge le .env racine du monorepo si les variables ne sont pas déjà injectées (dotenv-cli, Docker…)
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env'), resolve(__dirname, '../../../.env')]) {
  if (existsSync(candidate)) {
    config({ path: candidate, override: false });
    break;
  }
}
