'use client';

import * as DM from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight, FileSpreadsheet, Plus, Settings2, UserRound, UsersRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SKY_SEA, SeaScene } from '@/components/dashboard/fleet-hero';
import { useSession } from '@/lib/session';

/**
 * En-tête de la page Marins & personnel : titre et contexte sur fond clair, scène maritime fondue à droite
 * (décorative). Une seule action principale ; les autres accès restent des liens secondaires lisibles.
 */
export function MembersHeader({ description, vesselId, onCreate }: { description: ReactNode; vesselId: string; onCreate: () => void }) {
  const { can, canAny, me } = useSession();
  const canCreate = can('members.create');
  const canImport = can('members.import');
  const links = [
    me.memberId && { href: '/members/me', label: 'Ma fiche', icon: UserRound },
    canAny('members.view', 'vessel_crew.assign') && { href: vesselId ? `/members/crew?vesselId=${vesselId}` : '/members/crew', label: 'Équipage par navire', icon: UsersRound },
    can('members.fields.manage') && { href: '/members/fields', label: 'Champs personnalisés', icon: Settings2 },
  ].filter(Boolean) as { href: string; label: string; icon: typeof UserRound }[];

  return (
    <header className="relative isolate -mx-4 -mt-6 mb-5 overflow-hidden px-4 pb-5 pt-5 lg:-mx-6 lg:px-6">
      {/* Scène fondue dans le fond de page : masquée sous la tablette, où le texte occupe toute la largeur */}
      <div className="absolute inset-y-0 right-0 -z-10 hidden w-[62%] md:block" style={{ background: SKY_SEA }} aria-hidden>
        <SeaScene className="absolute right-0 top-0 aspect-[9/2] h-full w-auto max-w-none" />
      </div>
      <div
        className="absolute inset-0 -z-10 hidden bg-[linear-gradient(90deg,#F3F6F8_0%,#F3F6F8_42%,rgba(243,246,248,0.55)_62%,rgba(243,246,248,0)_82%)] md:block"
        aria-hidden
      />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-10 bg-gradient-to-t from-canvas to-transparent" aria-hidden />

      <nav aria-label="Fil d'Ariane" className="mb-1.5 flex items-center gap-1 text-xs text-ink-muted">
        <Link href="/" className="hover:text-action hover:underline">
          Accueil
        </Link>
        <ChevronRight className="h-3 w-3 text-ink-soft" aria-hidden />
        <span aria-current="page" className="text-ink">
          Marins &amp; personnel
        </span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <h1 className="text-2xl font-semibold leading-tight">Marins &amp; personnel</h1>
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
          {links.length > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="inline-flex items-center gap-1.5 font-medium text-action hover:underline">
                    <l.icon className="h-4 w-4" aria-hidden /> {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {(canCreate || canImport) && (
          <div className="flex shrink-0 rounded-md shadow-raised">
            {canCreate && (
              <button
                type="button"
                onClick={onCreate}
                className="inline-flex h-10 items-center gap-2 rounded-l-md bg-action px-4 text-base font-medium text-white hover:bg-action-700 [&:last-child]:rounded-r-md"
              >
                <Plus className="h-4 w-4" aria-hidden /> Nouvelle fiche
              </button>
            )}
            {canImport && (
              <DM.Root>
                <DM.Trigger
                  className="inline-flex h-10 items-center gap-1.5 rounded-r-md border-l border-white/25 bg-action px-2.5 text-white hover:bg-action-700 [&:first-child]:rounded-l-md [&:first-child]:border-l-0 [&:first-child]:px-4"
                  aria-label="Autres façons d'ajouter des fiches"
                >
                  {!canCreate && <span className="text-base font-medium">Ajouter des fiches</span>}
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </DM.Trigger>
                <DM.Portal>
                  <DM.Content align="end" sideOffset={6} className="z-50 min-w-[240px] rounded-lg bg-white p-1 shadow-pop">
                    <DM.Item asChild>
                      <Link href="/members/import" className="flex items-start gap-2.5 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-navy-50">
                        <FileSpreadsheet className="mt-0.5 h-4 w-4 text-action" aria-hidden />
                        <span>
                          <span className="block font-medium text-ink">Importer un fichier Excel</span>
                          <span className="block text-xs text-ink-muted">Prévisualisation et contrôle des doublons</span>
                        </span>
                      </Link>
                    </DM.Item>
                  </DM.Content>
                </DM.Portal>
              </DM.Root>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
