'use client';

import * as DM from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, LogOut, Menu, Search, Ship, UserCircle2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { cn, initials } from '@/lib/format';
import { useSession } from '@/lib/session';
import { ReferenceDatalists } from '@/components/amc/reference-lists';
import { VesselPicker } from '@/components/amc/vessel-picker';
import { AmcMark } from './brand';
import { NAV } from './nav';
import { WatchClock } from './watch-clock';

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { canAny, me } = useSession();
  const fleetCount = me.accessibleVessels.length;
  return (
    <nav aria-label="Navigation principale" className="flex h-full flex-col bg-navy-950 text-white">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
        <AmcMark />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">Africa Marine Company</p>
          <p className="text-2xs font-medium text-white/55">Exploitation de flotte</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-color:rgba(255,255,255,0.18)_transparent] [scrollbar-width:thin]">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.anyOf || canAny(...i.anyOf));
          if (!items.length) return null;
          return (
            <div key={group.label} className="mt-4">
              <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-white/40">{group.label}</p>
              <ul>
                {items.map((item) => {
                  const active = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex items-center gap-2.5 rounded px-2 py-[7px] text-[13.5px] leading-5 transition-colors',
                          active ? 'bg-white/[0.09] font-medium text-white' : 'text-white/70 hover:bg-white/[0.05] hover:text-white',
                        )}
                      >
                        {active && <span className="absolute -left-3 inset-y-1 w-[3px] rounded-r bg-teal" aria-hidden />}
                        <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-teal' : 'text-white/50')} aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {/* Périmètre effectif : rappel permanent de ce que l'utilisateur est autorisé à voir */}
      <div className="shrink-0 border-t border-white/[0.08] px-4 py-3">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-white/40">Périmètre</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-white/80">
          <Ship className="h-3.5 w-3.5 text-teal" aria-hidden />
          {me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : 'Navires affectés'}
          <span className="tabular text-white/55">· {fleetCount} navire{fleetCount > 1 ? 's' : ''}</span>
        </p>
      </div>
    </nav>
  );
}

function NotificationBell() {
  const q = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ unread: number; urgent: number }>('/notifications/unread-count'),
    refetchInterval: 60_000,
  });
  const unread = q.data?.unread ?? 0;
  const urgent = q.data?.urgent ?? 0;
  return (
    <Link
      href="/notifications"
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-navy-50 hover:text-ink"
      aria-label={`Notifications : ${unread} non lue(s)${urgent ? `, dont ${urgent} urgente(s)` : ''}`}
    >
      <Bell className="h-5 w-5" aria-hidden />
      {unread > 0 && (
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full px-1 text-center text-[11px] font-semibold leading-[18px] text-white',
            urgent ? 'bg-danger' : 'bg-action',
          )}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  return (
    <form
      role="search"
      className="relative hidden w-full max-w-sm md:block"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim().length >= 2) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
      }}
    >
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-soft" aria-hidden />
      <input
        className="input pl-8"
        placeholder="Rechercher navire, marin, PR, BC, voyage…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Recherche globale"
      />
    </form>
  );
}

function UserMenu() {
  const { me } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  return (
    <DM.Root>
      <DM.Trigger className="inline-flex h-9 items-center gap-2 rounded-md pl-1 pr-2 hover:bg-navy-50" aria-label="Menu du compte">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">
          {initials(me.displayName)}
        </span>
        <span className="hidden max-w-[160px] truncate text-sm font-medium lg:inline">{me.displayName}</span>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={6} className="z-50 min-w-[240px] rounded-lg bg-white p-1 shadow-pop">
          <div className="px-3 py-2">
            <p className="text-sm font-semibold text-navy">{me.displayName}</p>
            <p className="text-xs text-ink-muted">{me.roles.map((r) => r.name).join(', ') || 'Aucun rôle'}</p>
          </div>
          <DM.Separator className="my-1 h-px bg-line" />
          <DM.Item asChild>
            <Link href="/account" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-navy-50">
              <UserCircle2 className="h-4 w-4" aria-hidden /> Mon compte et mes sessions
            </Link>
          </DM.Item>
          <DM.Item
            onSelect={async () => {
              try {
                await api.post('/auth/logout');
              } finally {
                qc.clear();
                router.replace('/login');
              }
            }}
            className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-danger outline-none data-[highlighted]:bg-danger-bg"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Se déconnecter
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="flex min-h-screen">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Aller au contenu
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-[248px] lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-navy-900/50" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[264px]">
            <Sidebar onNavigate={() => setDrawer(false)} />
            <button className="absolute right-2 top-3 rounded p-1 text-white/80" onClick={() => setDrawer(false)} aria-label="Fermer la navigation">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-[248px]">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white px-4 lg:px-6">
          <button className="rounded-md p-1.5 text-ink-muted hover:bg-navy-50 lg:hidden" onClick={() => setDrawer(true)} aria-label="Ouvrir la navigation">
            <Menu className="h-5 w-5" />
          </button>
          <VesselPicker />
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <WatchClock />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main id="contenu" className="w-full min-w-0 flex-1 px-4 py-6 lg:px-6">
          {children}
        </main>
        <ReferenceDatalists />
      </div>
    </div>
  );
}
