'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Camera, RefreshCw, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FileUploader } from '@/components/amc/file-uploader';
import { MemberAssignments } from '@/components/members/member-assignments';
import { MemberCertificates } from '@/components/members/member-certificates';
import { MemberDocuments } from '@/components/members/member-documents';
import { MemberHeader } from '@/components/members/member-header';
import { MemberHistory } from '@/components/members/member-history';
import { MemberProfile } from '@/components/members/member-profile';
import { MANUAL_STATUS_LABELS, memberName, type ManualMemberStatus, type MemberDetail } from '@/components/members/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, canAny, me } = useSession();
  const qc = useQueryClient();
  // Onglet initial ?tab= (liens de la synthèse de la liste) ; un onglet non autorisé retombe sur le profil (activeTab)
  const initialTab = useSearchParams().get('tab');
  const [tab, setTab] = useState(initialTab && ['profile', 'certificates', 'sea', 'documents', 'history'].includes(initialTab) ? initialTab : 'profile');
  const [photoOpen, setPhotoOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [newStatus, setNewStatus] = useState<ManualMemberStatus>('AVAILABLE');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  const q = useQuery({ queryKey: ['member', id], queryFn: () => api.get<MemberDetail>(`/members/${id}`) });
  const reload = async () => (await q.refetch()).data;
  const refreshAll = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['member', id] }), qc.invalidateQueries({ queryKey: ['members'] })]);
  };

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const m = q.data;
  const name = memberName(m);
  const canEdit = m.permissions.canEdit;
  const canRestore = !!m.archivedAt && can('members.edit');
  const showCertificates = can('members.certificates.view') && m.certificates !== undefined;
  const showHistory = canAny('audit.view.members', 'members.personal_fields.manage');
  const activeTab = (tab === 'certificates' && !showCertificates) || (tab === 'history' && !showHistory) ? 'profile' : tab;
  const activeAssignments = m.currentAssignments.length;

  const setPhoto = async (fileId: string | null) => {
    setPhotoBusy(true);
    try {
      await api.put(`/members/${id}/photo`, { fileId });
      toast.success(fileId ? 'Photo mise à jour' : 'Photo retirée');
      setPhotoOpen(false);
      await refreshAll();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <>
      <MemberHeader
        member={m}
        breadcrumb={[{ label: 'Marins & personnel', href: '/members' }, { label: name }]}
        photoAction={
          canEdit ? (
            <button
              type="button"
              onClick={() => setPhotoOpen(true)}
              className="absolute -bottom-1 -right-1 rounded-full border border-line bg-white p-1 text-navy shadow-panel hover:bg-navy-50"
              aria-label="Changer la photo"
              title="Changer la photo"
            >
              <Camera className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : undefined
        }
        actions={
          <>
            {me.memberId === m.id && (
              <Link href="/members/me" className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-action hover:bg-navy-50">
                <UserRound className="h-4 w-4" aria-hidden /> Ma fiche (libre-service)
              </Link>
            )}
            <Button variant="ghost" onClick={() => q.refetch()} aria-label="Actualiser la fiche" title="Actualiser">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
            {canEdit && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setNewStatus(m.status === 'ON_LEAVE' || m.status === 'INACTIVE' ? m.status : 'AVAILABLE');
                    setStatusOpen(true);
                  }}
                >
                  Changer le statut
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setArchiveOpen(true)}
                  disabled={activeAssignments > 0}
                  title={activeAssignments > 0 ? 'Débarquer ou annuler les affectations en cours avant archivage' : undefined}
                >
                  <Archive className="h-4 w-4" aria-hidden /> Archiver
                </Button>
              </>
            )}
            {canRestore && (
              <Button onClick={() => setRestoreOpen(true)}>
                <ArchiveRestore className="h-4 w-4" aria-hidden /> Restaurer
              </Button>
            )}
          </>
        }
      />

      {m.archivedAt && (
        <p className="mb-4 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink-muted">
          Fiche archivée : consultation seule. Restaurez-la pour la modifier ou l’affecter à un navire.
        </p>
      )}

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="profile">Profil</TabsTrigger>
          {showCertificates && (
            <TabsTrigger value="certificates" count={m.certificates?.length ?? null}>
              Certificats
            </TabsTrigger>
          )}
          <TabsTrigger value="sea" count={m.currentAssignments.length + m.assignmentHistory.length}>
            Embarquements
          </TabsTrigger>
          <TabsTrigger value="documents" count={m.documentsCount}>
            Documents
          </TabsTrigger>
          {showHistory && <TabsTrigger value="history">Historique</TabsTrigger>}
        </TabsList>

        <TabsContent value="profile">
          <MemberProfile member={m} mode="staff" reload={reload} />
        </TabsContent>
        {showCertificates && (
          <TabsContent value="certificates">
            <MemberCertificates member={m} />
          </TabsContent>
        )}
        <TabsContent value="sea">
          <MemberAssignments member={m} />
        </TabsContent>
        <TabsContent value="documents">
          <MemberDocuments member={m} />
        </TabsContent>
        {showHistory && (
          <TabsContent value="history">
            <Panel title="Historique des modifications">
              <MemberHistory memberId={m.id} />
            </Panel>
          </TabsContent>
        )}
      </Tabs>

      <Dialog
        open={photoOpen}
        onOpenChange={setPhotoOpen}
        title="Photo de la fiche"
        description="JPEG, PNG ou WebP. Une miniature sans métadonnées EXIF est générée."
        footer={
          m.photoFileId ? (
            <Button variant="secondary" onClick={() => setPhoto(null)} loading={photoBusy}>
              Retirer la photo
            </Button>
          ) : undefined
        }
      >
        <FileUploader context="MEMBER_PHOTO" label="Déposer une photo" onUploaded={(f) => setPhoto(f.id)} disabled={photoBusy} />
      </Dialog>

      <ConfirmDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        title="Changer le statut administratif"
        description={
          <span className="mt-2 block space-y-2">
            <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value as ManualMemberStatus)} aria-label="Nouveau statut">
              {Object.entries(MANUAL_STATUS_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
            <span className="block text-xs">« À bord » et « Embarquement prévu » sont déduits des affectations et ne se saisissent pas ici.</span>
          </span>
        }
        confirmLabel="Appliquer"
        requireReason
        onConfirm={async (reason) => {
          await api.post(`/members/${id}/status`, { status: newStatus, reason });
          toast.success('Statut mis à jour');
          await refreshAll();
        }}
      />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archiver la fiche de ${name}`}
        description="La fiche n'est jamais supprimée : elle reste consultable et peut être restaurée. Les affectations en cours doivent être clôturées."
        confirmLabel="Archiver"
        tone="danger"
        requireReason
        reasonLabel="Motif de l'archivage"
        onConfirm={async (reason) => {
          await api.post(`/members/${id}/archive`, { reason });
          toast.success('Fiche archivée');
          await refreshAll();
        }}
      />

      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title={`Restaurer la fiche de ${name}`}
        description="La fiche redevient modifiable et affectable. Cette action est journalisée."
        confirmLabel="Restaurer"
        onConfirm={async () => {
          await api.post(`/members/${id}/restore`);
          toast.success('Fiche restaurée');
          await refreshAll();
        }}
      />
    </>
  );
}
