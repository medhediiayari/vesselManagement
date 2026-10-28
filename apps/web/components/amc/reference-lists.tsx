'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface RankRef {
  id: string;
  code: string;
  name: string;
  crewDepartment: string;
}

/**
 * Listes de suggestions HTML partagées (référentiels non sensibles). Les champs y accèdent via
 * l'attribut `list` (ex. `list="amc-ranks"`) : la saisie libre reste possible.
 */
export function ReferenceDatalists() {
  const ranks = useQuery({ queryKey: ['reference', 'ranks'], queryFn: () => api.get<RankRef[]>('/reference/ranks'), staleTime: 3_600_000 });
  return (
    <datalist id="amc-ranks">
      {ranks.data?.map((r) => (
        <option key={r.id} value={r.name.split(' / ')[0]}>
          {r.name}
        </option>
      ))}
    </datalist>
  );
}
