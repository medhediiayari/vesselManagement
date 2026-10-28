'use client';

import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Ship } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';

/**
 * Vessel Switcher (CDC §1.3) : un navire, plusieurs, ou toute la flotte accessible.
 * Ne propose QUE les navires du périmètre de l'utilisateur.
 */
export function VesselPicker() {
  const { me, selectedVesselIds, setSelectedVesselIds } = useSession();
  const [filter, setFilter] = useState('');
  const vessels = me.accessibleVessels;
  const label = useMemo(() => {
    if (!selectedVesselIds.length) return me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : `Mes navires (${vessels.length})`;
    if (selectedVesselIds.length === 1) return vessels.find((v) => v.id === selectedVesselIds[0])?.name ?? '1 navire';
    return `${selectedVesselIds.length} navires`;
  }, [selectedVesselIds, vessels, me.vesselScope]);
  const single = selectedVesselIds.length === 1 ? vessels.find((v) => v.id === selectedVesselIds[0]) : undefined;

  const toggle = (id: string) =>
    setSelectedVesselIds(selectedVesselIds.includes(id) ? selectedVesselIds.filter((x) => x !== id) : [...selectedVesselIds, id]);

  const shown = vessels.filter((v) => `${v.name} ${v.code} ${v.imoNumber ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(
          'inline-flex h-9 max-w-[340px] items-center gap-2 rounded-md border px-2.5 text-sm font-medium text-ink',
          // Un contexte navire restreint est signalé visuellement : les données affichées sont filtrées
          selectedVesselIds.length ? 'border-action/40 bg-action-50 hover:bg-action-100' : 'border-line-strong bg-white hover:bg-surface-sunken',
        )}
        aria-label={`Navires affichés : ${label}`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-navy text-white" aria-hidden>
          <Ship className="h-3.5 w-3.5" />
        </span>
        <span className="truncate">{label}</span>
        {single?.imoNumber && <span className="ref hidden shrink-0 text-xs font-normal text-ink-muted md:inline">IMO {single.imoNumber}</span>}
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-50 w-80 rounded-lg bg-white p-2 shadow-pop">
          <input
            className="input mb-2 h-8"
            placeholder="Rechercher un navire, code, IMO…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filtrer les navires"
          />
          <button
            type="button"
            onClick={() => setSelectedVesselIds([])}
            className={cn(
              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-navy-50',
              !selectedVesselIds.length && 'font-semibold text-navy',
            )}
          >
            {me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : 'Tous mes navires'}
            {!selectedVesselIds.length && <Check className="h-4 w-4 text-teal-700" aria-hidden />}
          </button>
          <div className="my-1 border-t border-line" />
          <ul className="max-h-72 overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label="Navires">
            {shown.map((v) => {
              const active = selectedVesselIds.includes(v.id);
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => toggle(v.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-navy-50"
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        active ? 'border-action bg-action text-white' : 'border-line-strong',
                      )}
                      aria-hidden
                    >
                      {active && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{v.name}</span>
                      <span className="ref block text-xs text-ink-muted">
                        {v.code}
                        {v.imoNumber ? ` · IMO ${v.imoNumber}` : ''}
                        {v.status !== 'ACTIVE' ? ` · ${v.status.toLowerCase()}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="px-2 py-3 text-sm text-ink-muted">Aucun navire dans votre périmètre.</li>}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
