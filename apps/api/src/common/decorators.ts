import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { AuthContext } from '../modules/access/auth-context';

export const IS_PUBLIC_KEY = 'amc:isPublic';
export const PERMISSIONS_KEY = 'amc:permissions';
export const ANY_PERMISSIONS_KEY = 'amc:anyPermissions';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'amc:allowPwdPending';
export const SKIP_CSRF = 'amc:skipCsrf';

/** Route accessible sans session (login, health…). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Exige TOUTES les permissions listées (vérifiées serveur à chaque requête). */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Exige AU MOINS UNE des permissions listées. */
export const RequireAnyPermission = (...permissions: string[]) => SetMetadata(ANY_PERMISSIONS_KEY, permissions);

/** Route utilisable alors que le changement du mot de passe temporaire est en attente. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

/** Injecte le contexte d'autorisation calculé par SessionGuard. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
  if (!req.auth) throw new Error('AuthContext absent : route publique ?');
  return req.auth;
});
