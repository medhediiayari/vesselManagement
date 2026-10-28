'use client';

import { FolderTree as FolderTreeIcon, Gavel, Inbox, Search, Settings2, Upload } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/ui/page';
import { useApprovals } from './lib';

export type CsoSection = 'library' | 'search' | 'approvals' | 'shared' | 'import' | 'categories';

function NavLink({ href, active, icon, children, count }: { href: string; active: boolean; icon: ReactNode; children: ReactNode; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium',
        active ? 'border-action bg-action-50 text-navy' : 'border-line-strong bg-white text-ink hover:bg-canvas',
      )}
    >
      {icon}
      {children}
      {typeof count === 'number' && count > 0 && (
        <span className="rounded-full bg-warn px-1.5 text-xs font-semibold tabular text-white" aria-label={`${count} en attente`}>
          {count}
        </span>
      )}
    </Link>
  );
}

/** En-tête commun du module CSO : navigation entre bibliothèque, recherche, validations, partages, import, catégories. */
export function CsoPageHeader({
  section,
  title,
  description,
  breadcrumb,
  extra,
}: {
  section: CsoSection;
  title?: ReactNode;
  description?: ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  extra?: ReactNode;
}) {
  const { can } = useSession();
  const approvals = useApprovals(can('cso.approve'));
  const pending = approvals.data ? approvals.data.versions.length + approvals.data.referenceChanges.length : undefined;
  return (
    <PageHeader
      breadcrumb={breadcrumb}
      title={title ?? 'Documents CSO'}
      description={
        description ?? 'Bibliothèque documentaire de sûreté (Company Security Officer) : bibliothèque centrale et bibliothèques des navires. Seuls les éléments autorisés par vos droits apparaissent.'
      }
      actions={
        <nav aria-label="Navigation du module CSO" className="flex flex-wrap items-center gap-2">
          <NavLink href="/cso" active={section === 'library'} icon={<FolderTreeIcon className="h-4 w-4" aria-hidden />}>
            Bibliothèque
          </NavLink>
          <NavLink href="/cso/search" active={section === 'search'} icon={<Search className="h-4 w-4" aria-hidden />}>
            Rechercher
          </NavLink>
          {can('cso.approve') && (
            <NavLink href="/cso/approvals" active={section === 'approvals'} icon={<Gavel className="h-4 w-4" aria-hidden />} count={pending}>
              À valider
            </NavLink>
          )}
          <NavLink href="/cso/shared-with-me" active={section === 'shared'} icon={<Inbox className="h-4 w-4" aria-hidden />}>
            Partagés avec moi
          </NavLink>
          {can('cso.import') && (
            <NavLink href="/cso/import" active={section === 'import'} icon={<Upload className="h-4 w-4" aria-hidden />}>
              Import en masse
            </NavLink>
          )}
          {can('cso.categories.manage') && (
            <NavLink href="/cso/categories" active={section === 'categories'} icon={<Settings2 className="h-4 w-4" aria-hidden />}>
              Catégories
            </NavLink>
          )}
          {extra}
        </nav>
      }
    />
  );
}
