import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';

let patched = false;

/** Document OpenAPI (CDC §11 / §18.1) — schémas issus des DTO Zod. */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  if (!patched) {
    patchNestJsSwagger();
    patched = true;
  }
  const config = new DocumentBuilder()
    .setTitle('AMC Platform API')
    .setDescription(
      'API REST /api/v1 — plateforme maritime AMC. Authentification par cookie de session HttpOnly ' +
        '(amc_sid) + en-tête x-csrf-token (double-submit) pour les mutations. Codes d’erreur : 403 FORBIDDEN / ' +
        'SCOPE_DENIED / ACL_DENIED, 409 STALE_VERSION / ALREADY_PROCESSED, 422 VALIDATION_FAILED / BUSINESS_RULE.',
    )
    .setVersion('1.0.0')
    .addCookieAuth('amc_sid')
    .build();
  return SwaggerModule.createDocument(app, config);
}
