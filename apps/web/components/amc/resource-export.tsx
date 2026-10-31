'use client';

import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ExportButton } from '@/components/purchasing/ui';

type Resource = 'certificates' | 'vessels' | 'audit';

/**
 * Export XLSX générique (POST /exports) : affiché seulement avec `reports.export`.
 * Seuls les filtres connus de l'API sont transmis (les autres restent propres à l'écran).
 */
export function ResourceExportButton({ resource, filters = {}, title }: { resource: Resource; filters?: Record<string, string | undefined>; title?: string }) {
  const { can } = useSession();
  if (!can('reports.export')) return null;
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>;
  return (
    <ExportButton
      label="Exporter"
      title={title}
      load={async () => {
        const job = await api.post<{ itemCount: number | null; link: { url: string; fileName: string } }>('/exports', { resource, format: 'XLSX', filters: clean });
        return { url: job.link.url, fileName: job.link.fileName, itemCount: job.itemCount ?? 0 };
      }}
    />
  );
}
