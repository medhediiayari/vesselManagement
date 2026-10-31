import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import type { AuthContext } from '../../modules/access/auth-context';
import { AuditService } from '../../modules/audit/audit.service';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/**
 * Format d'erreur uniforme. Ne divulgue jamais de détails internes (SQL, stack, secrets).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly audit?: AuditService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string; auth?: AuthContext }>();
    const body = this.toBody(exception);
    body.requestId = req.requestId;

    // Tout refus d'accès d'un utilisateur authentifié laisse une trace exploitable (CDC §13.3)
    if (body.statusCode === 403 && req.auth && this.audit) {
      this.audit.recordAsync(req.auth, {
        action: 'access.denied',
        module: 'platform',
        entityType: 'route',
        entityId: null,
        result: 'DENIED',
        metadata: { method: req.method, path: req.originalUrl?.split('?')[0], code: body.code, message: body.message, details: body.details },
      });
    }

    if (body.statusCode >= 500) {
      this.logger.error(
        JSON.stringify({ requestId: req.requestId, method: req.method, path: req.path, error: describe(exception) }),
      );
    }
    if (!res.headersSent) res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as ZodError;
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        message: 'Données invalides',
        details: zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      };
    }
    if (exception instanceof ZodError) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_FAILED',
        message: 'Données invalides',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      if (typeof r === 'object' && r && 'code' in r) {
        const o = r as ErrorBody;
        return { statusCode: status, code: o.code, message: o.message, details: o.details };
      }
      const message =
        typeof r === 'string' ? r : Array.isArray((r as { message?: unknown }).message)
          ? ((r as { message: string[] }).message).join(', ')
          : String((r as { message?: string }).message ?? exception.message);
      return { statusCode: status, code: httpCode(status), message: frenchFrameworkMessage(status, message) };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            statusCode: HttpStatus.CONFLICT,
            code: 'DUPLICATE',
            message: 'Valeur déjà utilisée (contrainte d’unicité)',
            details: { fields: (exception.meta as { target?: unknown })?.target },
          };
        case 'P2025':
          return { statusCode: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Ressource introuvable' };
        case 'P2003':
          return { statusCode: HttpStatus.CONFLICT, code: 'CONFLICT', message: 'Référence invalide ou utilisée' };
        case 'P2034':
          return { statusCode: HttpStatus.CONFLICT, code: 'STALE_VERSION', message: 'Conflit concurrent, réessayez' };
      }
    }
    // Violations de contraintes PostgreSQL (CHECK, triggers d'immuabilité, index partiels)
    const pgMessage = extractPgMessage(exception);
    if (pgMessage) return pgMessage;
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL', message: 'Erreur interne' };
  }
}

function extractPgMessage(e: unknown): ErrorBody | null {
  const msg = (e as { message?: string })?.message ?? '';
  if (/violates check constraint "([^"]+)"/.test(msg)) {
    const name = /violates check constraint "([^"]+)"/.exec(msg)?.[1];
    return { statusCode: 422, code: 'BUSINESS_RULE', message: `Contrainte métier violée (${name})` };
  }
  if (/duplicate key value violates unique constraint "([^"]+)"/.test(msg)) {
    const name = /unique constraint "([^"]+)"/.exec(msg)?.[1];
    return { statusCode: 409, code: 'CONFLICT', message: `Conflit d’unicité (${name})` };
  }
  if (/append-only|immuable|suppression interdite|propriétaire déjà défini|révision figée/.test(msg)) {
    return { statusCode: 409, code: 'INVALID_STATE', message: 'Donnée immuable : opération refusée par la base' };
  }
  return null;
}

/**
 * Messages anglais produits par le framework (Throttler, ParseUUIDPipe, Multer…) traduits avant d'atteindre
 * l'interface (audit ADM-18 / ADM-19). Les messages applicatifs, déjà en français, passent tels quels.
 */
function frenchFrameworkMessage(status: number, message: string): string {
  if (status === 429) return 'Trop de tentatives. Réessayez dans une minute.';
  if (/uuid is expected/i.test(message)) return 'Identifiant invalide';
  if (/numeric string is expected/i.test(message)) return 'Nombre attendu';
  if (/file too large/i.test(message) || status === 413) return 'Fichier trop volumineux';
  if (/too many files/i.test(message)) return 'Trop de fichiers';
  if (/unexpected field/i.test(message)) return 'Champ de fichier inattendu';
  if (/^cannot (get|post|put|patch|delete) /i.test(message)) return 'Ressource introuvable';
  if (/^(unauthorized|forbidden|not found|bad request|internal server error)$/i.test(message)) {
    return { 400: 'Requête invalide', 401: 'Authentification requise', 403: 'Accès refusé', 404: 'Ressource introuvable' }[
      status as 400 | 401 | 403 | 404
    ] ?? 'Erreur interne';
  }
  return message;
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'FILE_REJECTED';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL' : 'ERROR';
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 2000);
  return String(e).slice(0, 2000);
}
