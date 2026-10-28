'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';

export interface VesselRef {
  id: string;
  code: string;
  name: string;
  imoNumber: string | null;
  status: string;
}

export interface Me {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  jobTitle: string | null;
  locale: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  vesselScope: 'ALL_FLEET' | 'SELECTED';
  memberId: string | null;
  roles: { id: string; key: string; name: string }[];
  departments: { id: string; code: string; name: string; isPrimary: boolean }[];
  permissions: string[];
  isSuperAdmin: boolean;
  accessibleVessels: VesselRef[];
  sessionId: string;
}

interface SessionValue {
  me: Me;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  /** Navires sélectionnés dans le Vessel Switcher ([] = toute la flotte accessible) */
  selectedVesselIds: string[];
  setSelectedVesselIds: (ids: string[]) => void;
  /** Navire unique sélectionné, sinon null */
  currentVessel: VesselRef | null;
  vesselById: (id: string | null | undefined) => VesselRef | undefined;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const STORAGE_KEY = 'amc.selectedVessels';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    retry: (count, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 403)) && count < 2,
    staleTime: 30_000,
  });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const ids = (JSON.parse(raw) as string[]).filter((id) => me.accessibleVessels.some((v) => v.id === id));
        setSelected(ids);
      }
    } catch {
      /* préférence locale facultative */
    }
  }, [me.accessibleVessels]);

  const setSelectedVesselIds = useCallback((ids: string[]) => {
    setSelected(ids);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<SessionValue>(() => {
    const perms = new Set(me.permissions);
    return {
      me,
      can: (p) => perms.has(p),
      canAny: (...ps) => ps.some((p) => perms.has(p)),
      selectedVesselIds: selected,
      setSelectedVesselIds,
      currentVessel: selected.length === 1 ? me.accessibleVessels.find((v) => v.id === selected[0]) ?? null : null,
      vesselById: (id) => me.accessibleVessels.find((v) => v.id === id),
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: ['me'] });
      },
    };
  }, [me, selected, setSelectedVesselIds, qc]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession hors SessionProvider');
  return ctx;
}

/** Redirige vers /login sur 401 et vers /change-password si mot de passe temporaire. */
export function useAuthRedirects() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const onUnauth = () => router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    const onPwd = () => router.replace('/change-password');
    window.addEventListener('amc:unauthenticated', onUnauth);
    window.addEventListener('amc:password-change-required', onPwd);
    return () => {
      window.removeEventListener('amc:unauthenticated', onUnauth);
      window.removeEventListener('amc:password-change-required', onPwd);
    };
  }, [router, pathname]);
}
