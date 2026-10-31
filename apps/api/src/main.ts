import './load-env';
import './common/zod-fr';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ZodValidationPipe } from 'nestjs-zod';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { env } from './config/env';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { AuditService } from './modules/audit/audit.service';
import { buildOpenApi } from './openapi';

async function bootstrap() {
  const e = env(); // échoue au démarrage si la configuration est invalide
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  // Seuls les proxys internes sont crus pour l'IP client (throttling, audit) : pas d'usurpation par XFF
  app.set('trust proxy', e.TRUST_PROXY);
  if (e.NODE_ENV === 'production' && !e.COOKIE_SECURE) {
    logger.warn('COOKIE_SECURE=false en production : les cookies de session doivent être « Secure » derrière HTTPS');
  }
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.enableCors({ origin: e.WEB_ORIGIN, credentials: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter(app.get(AuditService)));
  app.enableShutdownHooks();

  // OpenAPI (CDC §11 / §18.1) — /api/docs (désactivé par défaut en production) + fichier openapi.json
  const document = buildOpenApi(app);
  if (e.SWAGGER_ENABLED ?? e.NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, document, { swaggerOptions: { persistAuthorization: true } });
  }
  if (e.NODE_ENV !== 'production') {
    try {
      writeFileSync(resolve(process.cwd(), 'openapi.json'), JSON.stringify(document, null, 2));
    } catch {
      /* non bloquant */
    }
  }

  await app.listen(e.API_PORT);
  logger.log(`API AMC démarrée sur http://localhost:${e.API_PORT}/api/v1 — docs : /api/docs`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
