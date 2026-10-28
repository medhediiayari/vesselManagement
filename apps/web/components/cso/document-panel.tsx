'use client';

import { ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { IconButton } from '@/components/ui/button';
import { DefinitionGrid } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { CustomFieldsView } from './custom-fields';
import { CsoHistory } from './history';
import { DocumentActions, DocumentStatusNotices, VersionsList } from './document-actions';
import { InlinePreview } from './preview';
import { isPreviewable, useDocument, useDocumentAccess, versionRights } from './lib';
import type { CsoDocumentDetail } from './types';
import { DocStatusBadge, DueDate, EffectiveRights, Reference, userName } from './ui';

export function DocumentMetadata({ doc, columns = 2 }: { doc: CsoDocumentDetail; columns?: 2 | 3 }) {
  return (
    <DefinitionGrid
      columns={columns}
      items={[
        ['Référence', <Reference key="r" value={doc.reference} />],
        ['Catégorie', doc.category ? `${doc.category.name} (${doc.category.code})` : '—'],
        ['Dossier', doc.folder.name ?? '—'],
        ['Auteur', userName(doc.author)],
        ['Prochaine révision', <DueDate key="n" value={doc.nextReviewOn} />],
        ['Expiration', <DueDate key="e" value={doc.expiryOn} kind="expiry" />],
        ['Version officielle', doc.currentVersion ? `v${doc.currentVersion.versionNo} — publiée le ${fmtDate(doc.currentVersion.publishedAt)}` : 'Aucune'],
        ['Modifié', fmtDateTime(doc.updatedAt)],
        ...(doc.copiedFrom
          ? ([
              [
                'Copié de',
                <Link key="c" href={`/cso/documents/${doc.copiedFrom.id}`} className="text-action hover:underline">
                  {doc.copiedFrom.reference ?? doc.copiedFrom.title}
                </Link>,
              ],
            ] as [string, ReactNode][])
          : []),
      ]}
    />
  );
}

/** Aperçu du document courant si les droits le permettent ; sinon un message neutre. */
export function DocumentPreviewBlock({ doc, actions, tall = false }: { doc: CsoDocumentDetail; actions: CsoDocumentDetail['actions']; tall?: boolean }) {
  const v = doc.currentVersion;
  if (!v?.file) return <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">Aucune version officielle publiée.</p>;
  const r = versionRights(doc, v, actions);
  if (!r.preview) return <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">Aperçu non disponible avec vos droits.</p>;
  if (!isPreviewable(v.file.kind)) {
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">
        Aperçu intégré disponible pour les PDF et images uniquement ({v.file.extension.toUpperCase()}).
      </p>
    );
  }
  return <InlinePreview previewPath={`/cso/versions/${v.id}/preview`} title={doc.title} kind={v.file.kind} canDownload={r.download} className={tall ? 'h-[60vh]' : undefined} />;
}

/** Panneau « aperçu rapide » de l'explorateur (CDC §6.4 : quick preview + métadonnées + activité). */
export function DocumentQuickView({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { can } = useSession();
  const [activityOpen, setActivityOpen] = useState(false);
  const q = useDocument(documentId);
  const access = useDocumentAccess(documentId);
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const doc = q.data;
  const actions = access.data?.actions ?? doc.actions;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-md font-semibold">{doc.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <DocStatusBadge status={doc.status} />
            <Reference value={doc.reference} />
          </div>
        </div>
        <IconButton label="Fermer l'aperçu" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <Link href={`/cso/documents/${doc.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-action hover:underline">
        Ouvrir la fiche complète <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </Link>
      <EffectiveRights actions={actions} scope="document" viaShare={access.data?.viaShare ?? doc.viaShare} />
      <DocumentActions doc={doc} actions={actions} variant="panel" />
      <DocumentStatusNotices doc={doc} />
      <DocumentPreviewBlock doc={doc} actions={actions} />
      {doc.description && <p className="whitespace-pre-line text-sm text-ink">{doc.description}</p>}
      <DocumentMetadata doc={doc} />
      {doc.customFields.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Champs de la catégorie</h3>
          <CustomFieldsView fields={doc.customFields} />
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Versions</h3>
        <VersionsList doc={doc} actions={actions} compact />
      </section>
      {can('cso.audit.view') && (
        <details className="group" onToggle={(e) => setActivityOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-sm font-semibold text-navy">Activité récente</summary>
          <div className="mt-3">
            {activityOpen && <CsoHistory documentId={doc.id} limit={6} />}
            <Link href={`/cso/documents/${doc.id}?tab=history`} className="text-sm text-action hover:underline">
              Tout l&apos;historique
            </Link>
          </div>
        </details>
      )}
    </div>
  );
}
