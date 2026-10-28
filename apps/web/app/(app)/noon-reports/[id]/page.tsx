'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { noonKeys } from '@/components/noon/lib';
import { NoonReportView } from '@/components/noon/noon-report-view';
import type { NoonReportDetail } from '@/components/noon/types';

export default function NoonReportPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const q = useQuery({
    queryKey: noonKeys.detail(id),
    queryFn: () => api.get<NoonReportDetail>(`/noon-reports/${id}`),
    enabled: can('noon.view'),
    // La saisie en cours ne doit pas être écrasée par un rafraîchissement au focus
    refetchOnWindowFocus: false,
  });
  if (!can('noon.view')) return <Forbidden />;
  if (q.isLoading) return <LoadingBlock rows={12} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  // Remonté à chaque changement de statut : sections et modes repartent de l'état serveur
  return <NoonReportView key={`${q.data.id}:${q.data.status}`} report={q.data} refetch={() => q.refetch()} />;
}
