'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

function fmt(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

function offsetLabel(d: Date, timeZone: string) {
  const part = new Intl.DateTimeFormat('fr-FR', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;
  return part?.replace('GMT', 'UTC') ?? timeZone;
}

/**
 * Heure de référence passerelle : UTC (Noon Reports, ETA, NOR) et, si un seul navire est sélectionné,
 * l'heure bord selon le fuseau déclaré sur la fiche navire. Purement informatif : aucune date officielle
 * n'est calculée ici (le serveur reste la source des horodatages).
 */
export function WatchClock() {
  const { currentVessel, can } = useSession();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    // Mise à jour à chaque changement de minute
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, []);

  const vessel = useQuery({
    queryKey: ['vessel', currentVessel?.id],
    queryFn: () => api.get<{ id: string; timezone: string | null }>(`/vessels/${currentVessel!.id}`),
    enabled: !!currentVessel && can('vessels.view'),
    staleTime: 300_000,
  });
  const tz = vessel.data?.timezone ?? null;

  if (!now) return null;
  // Fuseau invalide sur la fiche navire : on masque l'heure bord plutôt que de faire planter l'en-tête (audit FLT-01)
  let board: { time: string; offset: string } | null = null;
  if (currentVessel && tz) {
    try {
      board = { time: fmt(now, tz), offset: offsetLabel(now, tz) };
    } catch {
      board = null;
    }
  }
  return (
    <div className="hidden items-stretch divide-x divide-line rounded-md border border-line bg-surface-sunken text-xs xl:flex" aria-label="Heures de référence">
      <div className="flex items-baseline gap-1.5 px-2.5 py-1">
        <span className="font-semibold text-ink-muted">UTC</span>
        <time dateTime={now.toISOString()} className="tabular font-semibold text-navy">
          {fmt(now, 'UTC')}
        </time>
      </div>
      {currentVessel && tz && board && (
        <div className="flex items-baseline gap-1.5 px-2.5 py-1" title={`Heure bord ${currentVessel.name} — ${tz}`}>
          <span className="font-semibold text-ink-muted">Bord</span>
          <time className="tabular font-semibold text-navy">{board.time}</time>
          <span className="tabular text-2xs text-ink-muted">{board.offset}</span>
        </div>
      )}
      {currentVessel && tz && !board && (
        <div className="flex items-baseline gap-1.5 px-2.5 py-1" title={`Fuseau « ${tz} » non reconnu sur la fiche ${currentVessel.name}`}>
          <span className="font-semibold text-ink-muted">Bord</span>
          <span className="text-ink-muted">fuseau invalide</span>
        </div>
      )}
    </div>
  );
}
