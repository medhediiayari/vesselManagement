'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Page } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { AuditEvent } from '@/components/amc/audit-timeline';

export interface SystemStatus {
  checks: Record<string, string>;
  configuration: Record<string, unknown> & { buckets: Record<string, string> };
  scheduledJobs: { name: string; lastRun: { status: string; started_at: string; finished_at: string | null; detail: unknown } | null }[];
  emails: Record<string, number>;
  failedEmails: { id: string; toAddress: string; subject: string; attempts: number; lastError: string | null; createdAt: string }[];
  fileScans: Record<string, number>;
  filesByKind: { kind: string; count: number; bytes: number }[];
  migrations: { migration_name: string; finished_at: string | null }[];
}

export interface LockedUser {
  id: string;
  displayName: string;
  username: string;
  lockedAt: string | null;
  failedLogins: number;
}

export const JOB_LABELS: Record<string, string> = {
  'certificate-reminders': 'Rappels certificats',
  'cso-reminders': 'Rappels documents CSO',
  'purchasing-followup': 'Suivi achats',
  'voyage-notices': 'Notices de voyage',
  'orphan-files-cleanup': 'Purge des dépôts non rattachés',
};

/** Compteur borné par la pagination serveur (200 max) : « 200+ » plutôt qu'un chiffre faux. */
export function boundedCount(page: Page<unknown> | undefined): string | number | undefined {
  if (!page) return undefined;
  return page.nextCursor ? `${page.items.length}+` : page.items.length;
}

/**
 * Synthèse d'administration : uniquement des endpoints existants, chacun appelé seulement si la permission
 * correspondante est présente (le serveur refuse de toute façon). Aucune donnée n'est déduite côté client.
 */
export function useAdminOverview() {
  const { can } = useSession();
  const canUsers = can('users.view');
  const canAuthAudit = can('audit.view.admin');
  const canSystem = can('settings.manage');
  // Fenêtre glissante de 24 h figée au montage (évite une clé de requête différente à chaque rendu)
  const [since] = useState(() => new Date(Date.now() - 86_400_000).toISOString());

  const [active, deactivated, locked] = useQueries({
    queries: (['ACTIVE', 'DEACTIVATED', 'LOCKED'] as const).map((status) => ({
      queryKey: ['dashboard-admin', 'users', status],
      queryFn: () => api.get<Page<LockedUser>>('/users', { query: { status, limit: status === 'LOCKED' ? 5 : 1 } }),
      enabled: canUsers,
      staleTime: 60_000,
    })),
  });
  const loginFailures = useQuery({
    queryKey: ['dashboard-admin', 'login-failed', since],
    queryFn: () => api.get<Page<AuditEvent>>('/audit', { query: { module: 'auth', action: 'auth.login_failed', from: since, limit: 200 } }),
    enabled: canAuthAudit,
    staleTime: 60_000,
  });
  const denied = useQuery({
    queryKey: ['dashboard-admin', 'denied', since],
    queryFn: () => api.get<Page<AuditEvent>>('/audit', { query: { result: 'DENIED', from: since, limit: 200 } }),
    enabled: canAuthAudit,
    staleTime: 60_000,
  });
  // Seuil de verrouillage réel (paramètre), lisible seulement avec settings.manage (ADM-17)
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ 'auth.maxFailedLogins'?: number }>('/settings'),
    enabled: canSystem,
    staleTime: 60_000,
  });
  const system = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/system/status'),
    enabled: canSystem,
    refetchInterval: 60_000,
  });

  const sys = system.data;
  const depsDown = sys ? Object.values(sys.checks).filter((v) => v !== 'up').length : 0;
  const failedJobs = sys ? sys.scheduledJobs.filter((j) => j.lastRun && /FAIL|ERROR/.test(j.lastRun.status)) : [];
  const infectedFiles = sys?.fileScans.INFECTED ?? 0;
  const failedEmails = sys?.emails.FAILED ?? 0;
  const antivirusOff = sys ? sys.configuration.antivirus !== 'clamav' : false;
  const systemState: 'down' | 'attention' | 'ok' | null = !sys ? null : depsDown || failedJobs.length || infectedFiles ? 'down' : antivirusOff || failedEmails ? 'attention' : 'ok';

  return {
    since,
    permissions: { canUsers, canAuthAudit, canSystem, any: canUsers || canAuthAudit || canSystem },
    users: {
      active: active.data?.total,
      deactivated: deactivated.data?.total,
      locked: locked.data?.total,
      lockedList: locked.data?.items ?? [],
      maxFailedLogins: settings.data?.['auth.maxFailedLogins'],
      loading: active.isLoading || deactivated.isLoading || locked.isLoading,
      error: active.error ?? deactivated.error ?? locked.error,
    },
    security: {
      loginFailures: loginFailures.data,
      denied: denied.data,
      loading: loginFailures.isLoading || denied.isLoading,
      error: loginFailures.error ?? denied.error,
    },
    system: { data: sys, loading: system.isLoading, error: system.error, depsDown, failedJobs, infectedFiles, failedEmails, antivirusOff, state: systemState },
  };
}

export type AdminOverview = ReturnType<typeof useAdminOverview>;
