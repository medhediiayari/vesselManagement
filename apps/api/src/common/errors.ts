import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Codification d'erreurs uniforme (CDC §11.1 / §13.3) :
 *  403 FORBIDDEN / SCOPE_DENIED / ACL_DENIED, 409 STALE_VERSION / CONFLICT,
 *  422 VALIDATION_FAILED / BUSINESS_RULE, 404 NOT_FOUND, 401 UNAUTHENTICATED.
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'ACCOUNT_LOCKED'
  | 'FORBIDDEN'
  | 'SCOPE_DENIED'
  | 'ACL_DENIED'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'CSRF_INVALID'
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'ALREADY_PROCESSED'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'VALIDATION_FAILED'
  | 'BUSINESS_RULE'
  | 'INVALID_STATE'
  | 'FILE_REJECTED'
  | 'FILE_NOT_AVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ statusCode: status, code, message, details }, status);
  }
}

export const Errors = {
  unauthenticated: (msg = 'Authentification requise') => new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', msg),
  forbidden: (msg = 'Permission insuffisante', details?: unknown) =>
    new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', msg, details),
  scopeDenied: (msg = 'Navire hors de votre périmètre') => new AppError(HttpStatus.FORBIDDEN, 'SCOPE_DENIED', msg),
  aclDenied: (msg = 'Accès refusé par les droits documentaires') => new AppError(HttpStatus.FORBIDDEN, 'ACL_DENIED', msg),
  selfApproval: () =>
    new AppError(HttpStatus.FORBIDDEN, 'SELF_APPROVAL_FORBIDDEN', 'Un demandeur ne peut jamais approuver sa propre demande'),
  notFound: (what = 'Ressource') => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} introuvable`),
  staleVersion: (msg = 'Version périmée : la ressource a été modifiée, rechargez-la', details?: unknown) =>
    new AppError(HttpStatus.CONFLICT, 'STALE_VERSION', msg, details),
  alreadyProcessed: (msg = 'Demande déjà traitée') => new AppError(HttpStatus.CONFLICT, 'ALREADY_PROCESSED', msg),
  conflict: (msg: string, details?: unknown) => new AppError(HttpStatus.CONFLICT, 'CONFLICT', msg, details),
  duplicate: (msg: string, details?: unknown) => new AppError(HttpStatus.CONFLICT, 'DUPLICATE', msg, details),
  validation: (msg: string, details?: unknown) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', msg, details),
  business: (msg: string, details?: unknown) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'BUSINESS_RULE', msg, details),
  invalidState: (msg: string, details?: unknown) =>
    new AppError(HttpStatus.CONFLICT, 'INVALID_STATE', msg, details),
  fileRejected: (msg: string, details?: unknown) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'FILE_REJECTED', msg, details),
  fileNotAvailable: (msg: string) => new AppError(HttpStatus.CONFLICT, 'FILE_NOT_AVAILABLE', msg),
  /** Même clé d'idempotence réutilisée avec un contenu différent */
  idempotencyConflict: (msg = "Clé d'idempotence déjà utilisée pour une autre requête") =>
    new AppError(HttpStatus.CONFLICT, 'IDEMPOTENCY_CONFLICT', msg),
};
