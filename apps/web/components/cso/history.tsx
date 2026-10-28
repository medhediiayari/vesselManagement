'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import type { CsoHistoryEvent } from './types';

const ACTION_LABELS: Record<string, string> = {
  'cso.document.created': 'Document créé',
  'cso.document.updated': 'Informations modifiées',
  'cso.document.copied': 'Document créé par copie',
  'cso.document.copy_made': 'Copie réalisée vers un autre dossier',
  'cso.document.moved': 'Document déplacé',
  'cso.document.moved_in': 'Document reçu d’une autre bibliothèque',
  'cso.document.archived': 'Document archivé',
  'cso.document.restored': 'Document restauré (nouvelle approbation requise)',
  'cso.document.reference_changed': 'Référence officielle modifiée',
  'cso.reference_change.requested': 'Changement de référence demandé',
  'cso.reference_change.rejected': 'Changement de référence refusé',
  'cso.version.created': 'Nouvelle version déposée',
  'cso.version.submitted': 'Version soumise pour approbation',
  'cso.version.cancelled': 'Version annulée par le déposant',
  'cso.version.approved': 'Version approuvée et publiée',
  'cso.version.rejected': 'Version refusée',
  'cso.version.returned': 'Version retournée pour correction',
  'cso.acl.updated': 'Droits d’accès modifiés',
  'cso.document_shared': 'Partagé en interne',
  'cso.share_revoked': 'Partage révoqué',
  'cso.shares_revoked_all': 'Tous les partages révoqués',
  'file.preview': 'Aperçu consulté',
  'file.download': 'Fichier téléchargé',
  'file.thumbnail': 'Vignette affichée',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'Titre',
  description: 'Description',
  nextReviewOn: 'Prochaine révision',
  expiryOn: 'Expiration',
  categoryId: 'Catégorie',
  reference: 'Référence',
  status: 'Statut',
  folderId: 'Dossier',
  inheritAcl: 'Héritage des droits',
};

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

function details(e: CsoHistoryEvent): string[] {
  const out: string[] = [];
  const before = (e.before ?? {}) as Record<string, unknown>;
  const after = (e.after ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(after).filter((k) => FIELD_LABELS[k])) {
    if ((k === 'inheritAcl' || k in before) && fmt(before[k]) !== fmt(after[k])) out.push(`${FIELD_LABELS[k]} : ${fmt(before[k])} → ${fmt(after[k])}`);
  }
  const m = (e.metadata ?? {}) as Record<string, unknown>;
  if (typeof m.comment === 'string' && m.comment) out.push(`Commentaire : ${m.comment}`);
  if (typeof m.reason === 'string' && m.reason) out.push(`Motif : ${m.reason}`);
  if (typeof m.versionNo === 'number') out.push(`Version ${m.versionNo}`);
  if (typeof after.versionNo === 'number') out.push(`Version ${after.versionNo}`);
  if (typeof after.changeNote === 'string' && after.changeNote) out.push(`Note : ${after.changeNote}`);
  if (typeof after.requestedReference === 'string') out.push(`Référence demandée : ${after.requestedReference}`);
  if (Array.isArray(m.customFields) && m.customFields.length) {
    out.push(`Champs : ${(m.customFields as { label?: string; key: string }[]).map((c) => c.label ?? c.key).join(', ')}`);
  }
  return out.slice(0, 6);
}

/** Activité du document (journal d'audit CSO : consultations, dépôts, décisions, droits). */
export function CsoHistory({ documentId, limit }: { documentId: string; limit?: number }) {
  const q = useQuery({
    queryKey: ['cso', 'history', documentId],
    queryFn: () => api.get<CsoHistoryEvent[]>(`/cso/documents/${documentId}/history`),
  });
  if (q.isLoading) return <LoadingBlock rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = limit ? (q.data ?? []).slice(0, limit) : q.data ?? [];
  if (!items.length) return <EmptyState title="Aucun événement" description="Les actions sur ce document apparaîtront ici." />;
  return (
    <ol className="relative ml-2 border-l border-line">
      {items.map((e) => {
        const lines = details(e);
        return (
          <li key={e.id} className="mb-4 ml-4">
            <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${e.result === 'SUCCESS' ? 'bg-teal' : 'bg-danger'}`} aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-ink">{ACTION_LABELS[e.action] ?? e.action}</span>
              {e.result !== 'SUCCESS' && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                  <ShieldAlert className="h-3 w-3" aria-hidden /> {e.result === 'DENIED' ? 'refusé' : 'échec'}
                </span>
              )}
            </div>
            <p className="text-xs text-ink-muted">
              {fmtDateTime(e.occurredAt)} — {e.actorLabel ?? 'système'}
            </p>
            {lines.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                {lines.map((l) => (
                  <li key={l} className="break-words">
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
