'use client';

import type { ReactNode } from 'react';
import { useSession } from '@/lib/session';

/**
 * Affiche le contenu seulement si l'utilisateur possède la/les permission(s).
 * Indication d'interface uniquement : le serveur revérifie systématiquement (CDC §0.1).
 */
export function PermissionGate({
  allOf,
  anyOf,
  fallback = null,
  children,
}: {
  allOf?: string[];
  anyOf?: string[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { can, canAny } = useSession();
  const ok = (!allOf || allOf.every((p) => can(p))) && (!anyOf || canAny(...anyOf));
  return <>{ok ? children : fallback}</>;
}
