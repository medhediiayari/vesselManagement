'use client';

import * as DM from '@radix-ui/react-dropdown-menu';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Copy,
  Eye,
  FilePlus2,
  FolderInput,
  Gavel,
  Hash,
  History,
  KeyRound,
  Maximize2,
  Pencil,
  Send,
  Share2,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { DownloadButton } from '@/components/amc/file-preview';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { AclEditorDialog } from './acl-editor';
import { ReferenceDecisionDialog, VersionDecisionDialog } from './decision-panel';
import { EditDocumentDialog, NewVersionDialog, ReferenceChangeDialog } from './document-forms';
import { FolderPickerDialog } from './folder-picker';
import { has, isPreviewable, useApprovals, useCsoRun, useCsoRunToast, versionOutcome, versionRights } from './lib';
import { CsoPreviewDialog } from './preview';
import { ShareDialog } from './share-dialog';
import type { CsoAction, CsoDocumentDetail, CsoVersion } from './types';
import { Notice, Reference, userName, VersionStatusBadge } from './ui';

/** Éligibilité réelle à décider (validateur désigné du dossier) : déduite de la boîte de validation. */
export function useDecisionEligibility(doc: CsoDocumentDetail | undefined, actions: CsoAction[] | undefined) {
  const { can, me } = useSession();
  const pending = doc?.pendingVersion?.status === 'PENDING_APPROVAL' ? doc.pendingVersion : null;
  const ref = doc?.pendingReferenceChange ?? null;
  const maybeVersion = !!pending && has(actions, 'approve') && pending.submittedBy.id !== me.id;
  const maybeRef = !!ref && has(actions, 'approve') && ref.requestedBy?.id !== me.id;
  const inbox = useApprovals(can('cso.approve') && (maybeVersion || maybeRef));
  return {
    decidableVersion: maybeVersion && inbox.data?.versions.some((v) => v.version.id === pending!.id) ? pending : null,
    decidableReference: maybeRef && inbox.data?.referenceChanges.some((r) => r.id === ref!.id) ? ref : null,
  };
}

/** Liste des versions (statuts, auteur, décision) + gestes par version selon les droits. */
export function VersionsList({ doc, actions, compact = false }: { doc: CsoDocumentDetail; actions: CsoAction[] | undefined; compact?: boolean }) {
  const { me, can } = useSession();
  const runToast = useCsoRunToast();
  const { decidableVersion } = useDecisionEligibility(doc, actions);
  const [preview, setPreview] = useState<CsoVersion | null>(null);
  const [deciding, setDeciding] = useState<CsoVersion | null>(null);
  const [cancelling, setCancelling] = useState<CsoVersion | null>(null);
  const run = useCsoRun();
  const list = compact ? doc.versions.slice(0, 5) : doc.versions;

  if (!doc.versions.length) return <p className="text-sm text-ink-muted">Aucune version visible avec vos droits.</p>;
  return (
    <>
      <ul className="divide-y divide-line rounded-md border border-line">
        {list.map((v) => {
          const r = versionRights(doc, v, actions);
          const mine = v.submittedBy.id === me.id;
          const canSubmit = mine && (v.status === 'DRAFT' || v.status === 'RETURNED') && can('cso.edit') && has(actions, 'edit') && doc.status !== 'ARCHIVED';
          const canCancel = mine && ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'].includes(v.status) && (can('cso.create') || can('cso.edit'));
          return (
            <li key={v.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-navy">v{v.versionNo}</span>
                <VersionStatusBadge status={v.status} />
                {v.id === doc.currentVersionId && v.status === 'PUBLISHED' && <span className="text-xs font-medium text-ok">Version officielle</span>}
                {v.isRestoration && <span className="text-xs text-ink-muted">Restauration</span>}
                <span className="ml-auto flex flex-wrap items-center gap-1">
                  {r.preview && isPreviewable(v.file?.kind) && (
                    <Button variant="ghost" size="sm" onClick={() => setPreview(v)} title={`Aperçu de la version ${v.versionNo}`}>
                      <Eye className="h-4 w-4" aria-hidden /> Aperçu
                    </Button>
                  )}
                  {r.download && <DownloadButton size="sm" path={`/cso/versions/${v.id}/download`} label="Télécharger" />}
                  {canSubmit && (
                    <Button
                      size="sm"
                      onClick={() =>
                        runToast(
                          () => api.post<CsoVersion>(`/cso/versions/${v.id}/submit`, { expectedLockVersion: v.lockVersion }),
                          (res) => `Version ${v.versionNo} ${versionOutcome(res.status)}`,
                        )
                      }
                    >
                      <Send className="h-4 w-4" aria-hidden /> {can('cso.self_approve') ? 'Publier' : 'Soumettre'}
                    </Button>
                  )}
                  {decidableVersion?.id === v.id && (
                    <Button size="sm" onClick={() => setDeciding(v)}>
                      <Gavel className="h-4 w-4" aria-hidden /> Décider
                    </Button>
                  )}
                  {canCancel && (
                    <Button variant="ghost" size="sm" onClick={() => setCancelling(v)}>
                      <XCircle className="h-4 w-4" aria-hidden /> Annuler
                    </Button>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">
                Déposée par {userName(v.submittedBy)} — {fmtDateTime(v.submittedAt ?? v.createdAt)}
                {v.file && !compact && ` — ${v.file.originalName} (${fmtBytes(v.file.sizeBytes)})`}
              </p>
              {v.changeNote && <p className="mt-0.5 text-sm">« {v.changeNote} »</p>}
              {v.decidedAt && v.status !== 'CANCELLED' && (
                <p className="mt-0.5 text-xs text-ink-muted">
                  Décision de {userName(v.decidedBy, 'un validateur')} le {fmtDateTime(v.decidedAt)}
                  {v.decisionComment && ` : « ${v.decisionComment} »`}
                </p>
              )}
              {!compact && v.file && <p className="mt-0.5 truncate font-mono text-[11px] text-ink-soft">SHA-256 {v.file.sha256}</p>}
            </li>
          );
        })}
      </ul>
      {compact && doc.versions.length > list.length && (
        <Link href={`/cso/documents/${doc.id}?tab=versions`} className="mt-1 inline-block text-sm text-action hover:underline">
          Voir les {doc.versions.length} versions
        </Link>
      )}
      {preview?.file && (
        <CsoPreviewDialog
          open={!!preview}
          onOpenChange={(o) => !o && setPreview(null)}
          title={`${doc.title} — v${preview.versionNo}`}
          previewPath={`/cso/versions/${preview.id}/preview`}
          downloadPath={`/cso/versions/${preview.id}/download`}
          canDownload={versionRights(doc, preview, actions).download}
          kind={preview.file.kind}
        />
      )}
      {deciding && (
        <VersionDecisionDialog
          open={!!deciding}
          onOpenChange={(o) => !o && setDeciding(null)}
          doc={doc}
          version={deciding}
          canPreview={versionRights(doc, deciding, actions).preview}
        />
      )}
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={`Annuler la version ${cancelling?.versionNo ?? ''} ?`}
        description="La version ne pourra plus être soumise. La version officielle actuelle n'est pas affectée."
        confirmLabel="Annuler la version"
        tone="danger"
        onConfirm={async () => {
          await run(() => api.post(`/cso/versions/${cancelling!.id}/cancel`, { expectedLockVersion: cancelling!.lockVersion }), 'Version annulée');
        }}
      />
    </>
  );
}

type Dialogs = 'preview' | 'version' | 'edit' | 'ref' | 'share' | 'copy' | 'move' | 'archive' | 'restore' | 'acl' | 'decide' | 'refDecide' | null;

function MenuItem({ icon, children, onSelect }: { icon: ReactNode; children: ReactNode; onSelect: () => void }) {
  return (
    <DM.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-navy-50"
    >
      {icon}
      {children}
    </DM.Item>
  );
}

/**
 * Barre d'actions d'un document : seuls les gestes autorisés par les droits EFFECTIFS
 * (et l'état du document) sont proposés ; l'API revalide chaque geste.
 */
export function DocumentActions({
  doc,
  actions,
  variant = 'panel',
  onOpenHistory,
}: {
  doc: CsoDocumentDetail;
  actions: CsoAction[] | undefined;
  variant?: 'panel' | 'page';
  onOpenHistory?: () => void;
}) {
  const { can } = useSession();
  const router = useRouter();
  const run = useCsoRun();
  const copyTitleId = useId();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [copyTitle, setCopyTitle] = useState(doc.title);
  const { decidableVersion, decidableReference } = useDecisionEligibility(doc, actions);
  useEffect(() => setCopyTitle(`${doc.title} (copie)`), [doc.title]);

  const archived = doc.status === 'ARCHIVED';
  const current = doc.currentVersion;
  const currentRights = current ? versionRights(doc, current, actions) : { preview: false, download: false };
  const can_ = {
    preview: !!current && currentRights.preview && isPreviewable(current.file?.kind),
    download: !!current && currentRights.download,
    newVersion: can('cso.edit') && has(actions, 'edit') && !archived && !doc.pendingVersion,
    edit: can('cso.edit') && has(actions, 'edit') && !archived,
    reference: can('cso.edit') && has(actions, 'edit') && !archived && !doc.pendingReferenceChange,
    share: can('cso.share') && has(actions, 'share') && doc.status === 'PUBLISHED',
    copy: can('cso.create') && has(actions, 'download') && doc.status === 'PUBLISHED',
    move: can('cso.folder.move') && has(actions, 'folder_move') && !archived,
    archive: can('cso.edit') && has(actions, 'edit') && !archived,
    restore: can('cso.restore') && has(actions, 'restore') && has(actions, 'view_archived') && archived,
    acl: can('cso.folder.acl_manage') && has(actions, 'acl_manage'),
    history: can('cso.audit.view'),
  };
  const close = (o: boolean) => !o && setDialog(null);
  const menuItems = [
    can_.edit && <MenuItem key="edit" icon={<Pencil className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('edit')}>Modifier les informations</MenuItem>,
    can_.reference && <MenuItem key="ref" icon={<Hash className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('ref')}>Changer la référence</MenuItem>,
    can_.copy && <MenuItem key="copy" icon={<Copy className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('copy')}>Copier vers…</MenuItem>,
    can_.move && <MenuItem key="move" icon={<FolderInput className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('move')}>Déplacer vers…</MenuItem>,
    can_.acl && <MenuItem key="acl" icon={<KeyRound className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('acl')}>Gérer les accès</MenuItem>,
    can_.history && variant === 'panel' && (
      <MenuItem key="hist" icon={<History className="h-4 w-4" aria-hidden />} onSelect={() => router.push(`/cso/documents/${doc.id}?tab=history`)}>
        Historique
      </MenuItem>
    ),
    can_.history && variant === 'page' && onOpenHistory && (
      <MenuItem key="hist" icon={<History className="h-4 w-4" aria-hidden />} onSelect={onOpenHistory}>
        Historique
      </MenuItem>
    ),
    can_.archive && <MenuItem key="arch" icon={<Archive className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('archive')}>Archiver</MenuItem>,
    can_.restore && <MenuItem key="rest" icon={<ArchiveRestore className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('restore')}>Restaurer</MenuItem>,
  ].filter(Boolean);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {decidableVersion && (
          <Button size="sm" onClick={() => setDialog('decide')}>
            <Gavel className="h-4 w-4" aria-hidden /> Décider (v{decidableVersion.versionNo})
          </Button>
        )}
        {decidableReference && (
          <Button size="sm" variant="secondary" onClick={() => setDialog('refDecide')}>
            <Gavel className="h-4 w-4" aria-hidden /> Décider la référence
          </Button>
        )}
        {can_.preview && (
          <Button size="sm" variant="secondary" onClick={() => setDialog('preview')}>
            <Maximize2 className="h-4 w-4" aria-hidden /> Aperçu
          </Button>
        )}
        {can_.download && current && <DownloadButton size="sm" path={`/cso/versions/${current.id}/download`} />}
        {can_.newVersion && (
          <Button size="sm" variant="secondary" onClick={() => setDialog('version')}>
            <FilePlus2 className="h-4 w-4" aria-hidden /> Nouvelle version
          </Button>
        )}
        {can_.share && (
          <Button size="sm" variant="secondary" onClick={() => setDialog('share')}>
            <Share2 className="h-4 w-4" aria-hidden /> Partager
          </Button>
        )}
        {menuItems.length > 0 && (
          <DM.Root>
            <DM.Trigger asChild>
              <Button size="sm" variant="secondary" aria-label="Autres actions sur le document">
                Plus <ChevronDown className="h-4 w-4" aria-hidden />
              </Button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content align="end" sideOffset={6} className="z-50 min-w-[220px] rounded-lg bg-white p-1 shadow-pop">
                {menuItems}
              </DM.Content>
            </DM.Portal>
          </DM.Root>
        )}
      </div>

      {current?.file && can_.preview && (
        <CsoPreviewDialog
          open={dialog === 'preview'}
          onOpenChange={close}
          title={`${doc.title} — v${current.versionNo}`}
          previewPath={`/cso/versions/${current.id}/preview`}
          downloadPath={`/cso/versions/${current.id}/download`}
          canDownload={can_.download}
          kind={current.file.kind}
        />
      )}
      {can_.newVersion && <NewVersionDialog open={dialog === 'version'} onOpenChange={close} doc={doc} />}
      {can_.edit && dialog === 'edit' && <EditDocumentDialog open onOpenChange={close} doc={doc} />}
      {can_.reference && <ReferenceChangeDialog open={dialog === 'ref'} onOpenChange={close} doc={doc} />}
      {can_.share && <ShareDialog open={dialog === 'share'} onOpenChange={close} doc={doc} canDownload={has(actions, 'download')} />}
      {can_.acl && dialog === 'acl' && <AclEditorDialog open onOpenChange={close} kind="document" id={doc.id} name={doc.title} canEdit />}
      {decidableVersion && (
        <VersionDecisionDialog
          open={dialog === 'decide'}
          onOpenChange={close}
          doc={doc}
          version={decidableVersion}
          canPreview={versionRights(doc, decidableVersion, actions).preview}
        />
      )}
      {decidableReference && (
        <ReferenceDecisionDialog
          open={dialog === 'refDecide'}
          onOpenChange={close}
          request={{ ...decidableReference, documentTitle: doc.title }}
        />
      )}
      {can_.copy && (
        <FolderPickerDialog
          open={dialog === 'copy'}
          onOpenChange={close}
          title="Copier le document"
          description="La copie est un nouveau document indépendant : nouvelle référence, nouveau cycle d'approbation, lien vers la source."
          requiredActions={['edit']}
          initialLibraryId={doc.libraryId}
          confirmLabel="Copier"
          extra={
            <Field label="Titre de la copie" htmlFor={copyTitleId}>
              <Input id={copyTitleId} value={copyTitle} onChange={(e) => setCopyTitle(e.target.value)} maxLength={300} />
            </Field>
          }
          onConfirm={async (t) => {
            const created = await run(
              () => api.post<CsoDocumentDetail>(`/cso/documents/${doc.id}/copy`, { targetFolderId: t.folderId, title: copyTitle.trim() || undefined }),
              (d) => `Copie créée${d.reference ? ` (${d.reference})` : ''} — ${d.status === 'PUBLISHED' ? 'publiée directement' : "en attente d'approbation"}`,
            );
            router.push(`/cso/documents/${created.id}`);
          }}
        />
      )}
      {can_.move && (
        <FolderPickerDialog
          open={dialog === 'move'}
          onOpenChange={close}
          title="Déplacer le document"
          description="Le document hérite des droits du dossier cible (ses exceptions propres le suivent). Entre navires, vos droits sont exigés des deux côtés."
          requiredActions={['edit']}
          disabledIds={[doc.folderId]}
          initialLibraryId={doc.libraryId}
          confirmLabel="Déplacer"
          onConfirm={async (t) => {
            await run(() => api.patch(`/cso/documents/${doc.id}/move`, { targetFolderId: t.folderId, expectedUpdatedAt: doc.updatedAt }), `Document déplacé vers « ${t.folderName} »`);
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === 'archive'}
        onOpenChange={close}
        title="Archiver ce document ?"
        description="Le document n'est jamais supprimé : il reste consultable par les personnes autorisées aux archives et peut être restauré (nouvelle approbation requise ; retour en brouillon s'il n'a jamais été approuvé). Ses partages actifs sont révoqués."
        confirmLabel="Archiver"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          await run(() => api.post(`/cso/documents/${doc.id}/archive`, { reason }), 'Document archivé');
        }}
      />
      <ConfirmDialog
        open={dialog === 'restore'}
        onOpenChange={close}
        title="Restaurer ce document ?"
        description={
          doc.restoreMode === 'DRAFT'
            ? "Ce document n'a jamais été approuvé : il reviendra en brouillon avec son dernier fichier, que vous pourrez soumettre ou annuler."
            : 'Une version de restauration sera soumise à une nouvelle approbation avant republication.'
        }
        confirmLabel="Restaurer"
        requireReason
        onConfirm={async (reason) => {
          await run(
            () => api.post<{ restoredAs: 'DRAFT' | 'PENDING_APPROVAL' }>(`/cso/documents/${doc.id}/restore`, { reason }),
            (r) => (r.restoredAs === 'DRAFT' ? 'Document restauré en brouillon (jamais approuvé)' : 'Document restauré — en attente de nouvelle approbation'),
          );
        }}
      />
    </>
  );
}

/** Bandeaux d'état : version en cours de validation, changement de référence en attente. */
export function DocumentStatusNotices({ doc }: { doc: CsoDocumentDetail }) {
  return (
    <>
      {doc.pendingVersion && (
        <Notice tone={doc.pendingVersion.status === 'RETURNED' ? 'danger' : 'warn'}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Version {doc.pendingVersion.versionNo} <VersionStatusBadge status={doc.pendingVersion.status} />
          </span>
          <span className="block text-xs text-ink-muted">
            {doc.currentVersion ? `La version officielle v${doc.currentVersion.versionNo} reste en vigueur pendant la validation.` : 'Aucune version officielle publiée à ce jour.'}
            {doc.pendingVersion.decisionComment && ` Commentaire : « ${doc.pendingVersion.decisionComment} »`}
          </span>
        </Notice>
      )}
      {doc.pendingReferenceChange && (
        <Notice tone="info">
          Changement de référence demandé : <Reference value={doc.pendingReferenceChange.oldReference} /> → <Reference value={doc.pendingReferenceChange.newReference} />
          <span className="block text-xs text-ink-muted">
            Par {userName(doc.pendingReferenceChange.requestedBy)} — l&apos;ancienne référence reste active jusqu&apos;à l&apos;approbation.
          </span>
        </Notice>
      )}
      {doc.status === 'ARCHIVED' && <Notice tone="info">Document archivé{doc.archivedAt ? ` le ${fmtDateTime(doc.archivedAt)}` : ''} — consultation des archives uniquement.</Notice>}
    </>
  );
}
