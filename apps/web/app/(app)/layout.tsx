'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { SessionProvider, useAuthRedirects, useMe } from '@/lib/session';
import { AppShell } from '@/components/shell/app-shell';
import { ErrorState } from '@/components/ui/states';

/** Zone authentifiée : profil + droits effectifs chargés depuis l'API (recalculés à chaque requête). */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useMe();
  useAuthRedirects();

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    if (me.data?.mustChangePassword) router.replace('/change-password');
  }, [me.error, me.data, router]);

  if (me.isLoading || (me.error instanceof ApiError && me.error.status === 401) || me.data?.mustChangePassword) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-navy-50 border-t-action" aria-hidden />
        <span className="sr-only">Chargement de la session…</span>
      </div>
    );
  }
  if (me.error || !me.data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  return (
    <SessionProvider me={me.data}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
