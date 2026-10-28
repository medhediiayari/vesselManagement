'use client';

import { VESSEL_STATUS_LABELS } from '@amc/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Camera, ExternalLink, Pencil, Ship } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { AuditTimeline } from '@/components/amc/audit-timeline';
import { FileRow } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { PermissionGate } from '@/components/amc/permission-gate';
import { Register, RegisterRow } from '@/components/amc/register';
import { SecureImage } from '@/components/amc/secure-image';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VesselFormDialog, type VesselDto } from '../vessel-form';

interface Workspace {
  vessel: VesselDto & { photo: StoredFileDto | null };
  sections: {
    crew?: { onboard: number; planned: number };
    certificates?: { total: number; expired: number; expiringWithin90Days: number; documentMissing: number; expiryUnknown: number; pendingApprovals: number };
    cso?: { publishedDocuments: number };
    purchasing?: { openPurchaseRequests: number; openOrders: number };
    voyages?: {
      active: { id: string; reference: string; charterer: string | null; eta: string | null; laycanFrom: string | null; laycanTo: string | null } | null;
      lastNoonReport: { id: string; reportDateUtc: string; status: string } | null;
    };
  };
}

interface Attachment {
  id: string;
  category: string;
  title: string;
  createdAt: string;
  archivedAt: string | null;
  file: StoredFileDto;
}

/** Caractéristiques d'identification (« ship particulars ») : références en chasse fixe, valeurs absentes explicites. */
function Particulars({ items }: { items: [label: string, value: string | null | undefined, identifier?: boolean][] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map(([k, val, identifier]) => (
        <div key={k} className="min-w-0">
          <dt className="text-2xs font-semibold uppercase tracking-[0.06em] text-ink-muted">{k}</dt>
          <dd className={val ? `${identifier ? 'ref' : ''} text-sm font-medium text-navy` : 'text-sm text-ink-soft'}>{val || 'Non renseigné'}</dd>
        </div>
      ))}
    </dl>
  );
}

function ModuleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-action hover:underline">
      {children} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

export default function VesselWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { refresh } = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [newStatus, setNewStatus] = useState<VesselDto['status']>('ACTIVE');
  const [attachOpen, setAttachOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<StoredFileDto | null>(null);
  const [attTitle, setAttTitle] = useState('');
  const [attCategory, setAttCategory] = useState('Plans & documents techniques');

  const ws = useQuery({ queryKey: ['vessel-workspace', id], queryFn: () => api.get<Workspace>(`/vessels/${id}/workspace`) });
  const attachments = useQuery({
    queryKey: ['vessel-attachments', id],
    queryFn: () => api.get<Attachment[]>(`/vessels/${id}/attachments`),
    enabled: !!ws.data,
  });

  const setPhoto = useAction((fileId: string) => api.put(`/vessels/${id}/photo`, { fileId }), {
    success: 'Photo mise à jour',
    invalidate: [['vessel-workspace', id]],
  });
  const addAttachment = useAction(
    () => api.post(`/vessels/${id}/attachments`, { fileId: pendingFile!.id, title: attTitle, category: attCategory }),
    {
      success: 'Pièce jointe ajoutée',
      invalidate: [['vessel-attachments', id]],
      onSuccess: () => {
        setAttachOpen(false);
        setPendingFile(null);
        setAttTitle('');
      },
    },
  );

  if (ws.isLoading) return <LoadingBlock rows={10} />;
  if (ws.error || !ws.data) return <ErrorState error={ws.error} onRetry={() => ws.refetch()} />;
  const v = ws.data.vessel;
  const s = ws.data.sections;
  const vq = `vesselId=${v.id}`;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Navires', href: '/vessels' }, { label: v.name }]}
        title={
          <span className="flex items-center gap-4">
            {v.photoFileId ? (
              <SecureImage fileId={v.photoFileId} alt={`Photo de ${v.name}`} className="h-14 w-20 rounded-md border border-line" />
            ) : (
              <span className="flex h-14 w-20 items-center justify-center rounded-md border border-line bg-navy-50 text-navy-600">
                <Ship className="h-6 w-6" aria-hidden />
              </span>
            )}
            <span className="min-w-0">
              <span className="block">{v.name}</span>
              <span className="mt-1 flex flex-wrap items-center gap-2 text-sm font-normal text-ink-muted">
                <StatusBadge status={v.status} labels={VESSEL_STATUS_LABELS} />
                {v.vesselType && <span>{v.vesselType}</span>}
              </span>
            </span>
          </span>
        }
        meta={
          <div className="mt-1 w-full rounded-md border border-line bg-white px-4 py-2.5">
            <Particulars
              items={[
                ['IMO', v.imoNumber, true],
                ['Code AMC', v.code, true],
                ['Pavillon', v.flag],
                ['Indicatif', v.callSign, true],
                ['MMSI', v.mmsi, true],
                ['Port d’immatriculation', v.portOfRegistry],
                ['Classe', v.classSociety],
              ]}
            />
          </div>
        }
        actions={
          <PermissionGate anyOf={['vessels.edit', 'vessel_documents.manage']}>
            <Button variant="secondary" onClick={() => setPhotoOpen(true)}>
              <Camera className="h-4 w-4" aria-hidden /> Photo
            </Button>
            <PermissionGate allOf={['vessels.edit']}>
              <Button variant="secondary" onClick={() => { setNewStatus(v.status); setStatusOpen(true); }}>
                Statut
              </Button>
              <Button onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" aria-hidden /> Modifier
              </Button>
            </PermissionGate>
          </PermissionGate>
        }
      />

      <Tabs defaultValue="overview">
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Vue d’ensemble</TabsTrigger>
          {s.crew && <TabsTrigger value="crew" count={s.crew.onboard}>Équipage</TabsTrigger>}
          {s.certificates && <TabsTrigger value="certificates" count={s.certificates.total}>Certificats</TabsTrigger>}
          {s.cso && <TabsTrigger value="cso">CSO</TabsTrigger>}
          {s.purchasing && <TabsTrigger value="purchasing">Achats</TabsTrigger>}
          {s.voyages && <TabsTrigger value="voyages">Voyages</TabsTrigger>}
          <TabsTrigger value="files">Pièces jointes</TabsTrigger>
          <TabsTrigger value="activity">Historique</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title="Caractéristiques et gestion">
            <DefinitionGrid
              columns={3}
              items={[
                ['Gestionnaire', v.managerName],
                ['Armateur', v.ownerName],
                ['Chantier / année', [v.builder, v.yearBuilt].filter(Boolean).join(' — ') || null],
                ['Jauge brute / nette', v.grossTonnage || v.netTonnage ? `${fmtDecimal(v.grossTonnage)} / ${fmtDecimal(v.netTonnage)}` : null],
                ['Port en lourd (t)', fmtDecimal(v.deadweight)],
                ['Dimensions (m)', v.lengthOverall || v.beam ? `${fmtDecimal(v.lengthOverall)} × ${fmtDecimal(v.beam)}` : null],
                ["Tirant d'eau été (m)", fmtDecimal(v.summerDraft)],
                ['Fuseau horaire', v.timezone],
                ['Contact bord', [v.contactEmail, v.contactPhone].filter(Boolean).join(' — ') || null],
                ['Mise à jour', fmtDateTime(v.updatedAt)],
              ]}
            />
            {v.notes && <p className="mt-4 whitespace-pre-line border-t border-line pt-3 text-sm text-ink-muted">{v.notes}</p>}
          </Panel>
          <div className="space-y-4">
            {s.voyages && (
              <Panel title="Voyage en cours" actions={<ModuleLink href={`/voyages?${vq}`}>Voyages</ModuleLink>}>
                {s.voyages.active ? (
                  <Link href={`/voyages/${s.voyages.active.id}`} className="group block">
                    <p className="ref font-semibold text-action group-hover:underline">{s.voyages.active.reference}</p>
                    <p className="text-sm text-ink-muted">
                      {s.voyages.active.charterer ?? 'Affréteur non renseigné'} · ETA <span className="tabular">{fmtDateTime(s.voyages.active.eta)}</span>
                    </p>
                  </Link>
                ) : (
                  <p className="text-sm text-ink-muted">Aucun voyage actif.</p>
                )}
                <p className="mt-2 border-t border-line pt-2 text-xs text-ink-muted">
                  Dernier Noon Report :{' '}
                  {s.voyages.lastNoonReport ? <span className="tabular text-ink">{fmtDateTime(s.voyages.lastNoonReport.reportDateUtc)}</span> : 'aucun rapport soumis'}
                </p>
              </Panel>
            )}
            {(s.certificates || s.crew || s.purchasing) && (
              <Panel title="Registre du navire" bodyClassName="space-y-4 px-4 pb-4 pt-3">
                {s.certificates && (
                  <Register title="Certificats">
                    <RegisterRow label="Expirés" value={s.certificates.expired} tone="danger" href={`/certificates?${vq}&validity=EXPIRED`} />
                    <RegisterRow label="Expirent sous 90 jours" value={s.certificates.expiringWithin90Days} tone="warn" href={`/certificates?${vq}&expiringWithinDays=90`} />
                    <RegisterRow label="Justificatifs manquants" value={s.certificates.documentMissing} tone="warn" href={`/certificates?${vq}&documentMissing=true`} />
                    <RegisterRow label="Approbations en attente" value={s.certificates.pendingApprovals} tone="warn" href={`/certificates?${vq}&pendingApproval=true`} />
                  </Register>
                )}
                {s.crew && (
                  <Register title="Équipage">
                    <RegisterRow label="Marins à bord" value={s.crew.onboard} href={`/members?${vq}`} />
                    <RegisterRow label="Embarquements prévus" value={s.crew.planned} tone="info" href={`/members?${vq}`} />
                  </Register>
                )}
                {s.purchasing && (
                  <Register title="Achats">
                    <RegisterRow label="PR ouvertes" value={s.purchasing.openPurchaseRequests} href={`/purchasing/requests?${vq}`} />
                    <RegisterRow label="Commandes en cours" value={s.purchasing.openOrders} href={`/purchasing/orders?${vq}`} />
                  </Register>
                )}
              </Panel>
            )}
          </div>
        </TabsContent>

        {s.crew && (
          <TabsContent value="crew">
            <Panel title="Équipage" actions={<ModuleLink href={`/members?${vq}`}>Liste détaillée et affectations</ModuleLink>}>
              <p className="text-sm text-ink-muted">
                {s.crew.onboard} marin(s) à bord, {s.crew.planned} embarquement(s) prévu(s). La gestion des affectations (embarquement,
                débarquement, relève) se fait depuis le module Marins & personnel.
              </p>
            </Panel>
          </TabsContent>
        )}
        {s.certificates && (
          <TabsContent value="certificates">
            <Panel title="Certificats du navire" actions={<ModuleLink href={`/certificates?${vq}&subjectKind=VESSEL`}>Explorateur de certificats</ModuleLink>}>
              <Register className="max-w-xl">
                <RegisterRow label="Certificats courants" value={s.certificates.total} href={`/certificates?${vq}&subjectKind=VESSEL`} />
                <RegisterRow label="Expirés" value={s.certificates.expired} tone="danger" href={`/certificates?${vq}&validity=EXPIRED`} />
                <RegisterRow label="Expirent sous 90 jours" value={s.certificates.expiringWithin90Days} tone="warn" href={`/certificates?${vq}&expiringWithinDays=90`} />
                <RegisterRow label="Justificatifs manquants" value={s.certificates.documentMissing} tone="warn" href={`/certificates?${vq}&documentMissing=true`} />
                <RegisterRow label="Échéance inconnue" hint="Date à compléter : aucune alerte d’expiration possible" value={s.certificates.expiryUnknown} href={`/certificates?${vq}&validity=EXPIRY_UNKNOWN`} />
                <RegisterRow label="Approbations en attente" value={s.certificates.pendingApprovals} tone="warn" href={`/certificates?${vq}&pendingApproval=true`} />
              </Register>
            </Panel>
          </TabsContent>
        )}
        {s.cso && (
          <TabsContent value="cso">
            <Panel title="Bibliothèque CSO du navire" actions={<ModuleLink href={`/cso?${vq}`}>Ouvrir la bibliothèque</ModuleLink>}>
              <p className="text-sm text-ink-muted">{s.cso.publishedDocuments} document(s) publié(s) visibles selon vos droits de dossier.</p>
            </Panel>
          </TabsContent>
        )}
        {s.purchasing && (
          <TabsContent value="purchasing">
            <Panel title="Achats du navire" actions={<ModuleLink href={`/purchasing/requests?${vq}`}>Purchase Requests</ModuleLink>}>
              <Register className="max-w-xl">
                <RegisterRow label="PR ouvertes" value={s.purchasing.openPurchaseRequests} href={`/purchasing/requests?${vq}`} />
                <RegisterRow label="Commandes en cours" value={s.purchasing.openOrders} href={`/purchasing/orders?${vq}`} />
              </Register>
            </Panel>
          </TabsContent>
        )}
        {s.voyages && (
          <TabsContent value="voyages">
            <Panel title="Voyages" actions={<ModuleLink href={`/voyages?${vq}`}>Tous les voyages du navire</ModuleLink>}>
              {s.voyages.active ? (
                <p className="text-sm">
                  Voyage actif :{' '}
                  <Link className="font-medium text-action hover:underline" href={`/voyages/${s.voyages.active.id}`}>
                    {s.voyages.active.reference}
                  </Link>{' '}
                  — laycan {fmtDate(s.voyages.active.laycanFrom)} au {fmtDate(s.voyages.active.laycanTo)}
                </p>
              ) : (
                <p className="text-sm text-ink-muted">Aucun voyage actif.</p>
              )}
            </Panel>
          </TabsContent>
        )}

        <TabsContent value="files">
          <Panel
            title="Pièces jointes du navire"
            actions={
              <PermissionGate allOf={['vessel_documents.manage']}>
                <Button size="sm" onClick={() => setAttachOpen(true)}>
                  Ajouter
                </Button>
              </PermissionGate>
            }
          >
            {attachments.isLoading && <LoadingBlock rows={3} />}
            {attachments.error && <ErrorState error={attachments.error} />}
            {attachments.data && attachments.data.length === 0 && (
              <EmptyState title="Aucune pièce jointe" description="Plans, rapports de visite, photos : déposez-les ici (stockage privé, accès contrôlé)." />
            )}
            <div className="space-y-2">
              {attachments.data?.map((a) => (
                <FileRow
                  key={a.id}
                  fileId={a.file.id}
                  name={`${a.title} — ${a.file.originalName}`}
                  kind={a.file.kind}
                  sizeBytes={a.file.sizeBytes}
                  extra={<Badge tone="neutral" icon={false}>{a.category}</Badge>}
                />
              ))}
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="activity">
          <Panel title="Historique des informations officielles">
            <AuditTimeline entityType="vessel" entityId={v.id} module="fleet" />
          </Panel>
        </TabsContent>
      </Tabs>

      {editing && (
        <VesselFormDialog
          open={editing}
          onOpenChange={setEditing}
          vessel={v}
          onSaved={async () => {
            await qc.invalidateQueries({ queryKey: ['vessel-workspace', id] });
            await refresh();
          }}
        />
      )}

      <Dialog open={photoOpen} onOpenChange={setPhotoOpen} title="Photo du navire" description="JPEG, PNG ou WebP. Une miniature sans métadonnées EXIF est générée.">
        <FileUploader
          context="VESSEL_PHOTO"
          vesselId={v.id}
          label="Déposer une photo"
          onUploaded={(f) => {
            setPhoto.mutate(f.id);
            setPhotoOpen(false);
          }}
        />
      </Dialog>

      <Dialog
        open={attachOpen}
        onOpenChange={(o) => {
          setAttachOpen(o);
          if (!o) setPendingFile(null);
        }}
        title="Ajouter une pièce jointe"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAttachOpen(false)}>Annuler</Button>
            <Button onClick={() => addAttachment.mutate(undefined)} disabled={!pendingFile || attTitle.trim().length < 2} loading={addAttachment.isPending}>
              <Archive className="h-4 w-4" aria-hidden /> Enregistrer
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FileUploader context="VESSEL_ATTACHMENT" vesselId={v.id} onUploaded={(f) => { setPendingFile(f); if (!attTitle) setAttTitle(f.originalName.replace(/\.[^.]+$/, '')); }} />
          <Field label="Titre" required htmlFor="att-title">
            <Input id="att-title" value={attTitle} onChange={(e) => setAttTitle(e.target.value)} />
          </Field>
          <Field label="Catégorie" htmlFor="att-cat">
            <Select id="att-cat" value={attCategory} onChange={(e) => setAttCategory(e.target.value)}>
              {['Plans & documents techniques', 'Rapports de visite', 'Photos', 'Contrats & assurances', 'Autres'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        title="Changer le statut du navire"
        description={
          <span className="mt-2 block">
            <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value as VesselDto['status'])} aria-label="Nouveau statut">
              {Object.entries(VESSEL_STATUS_LABELS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </Select>
          </span>
        }
        confirmLabel="Appliquer"
        requireReason
        onConfirm={async (reason) => {
          await api.post(`/vessels/${id}/status`, { status: newStatus, reason });
          await qc.invalidateQueries({ queryKey: ['vessel-workspace', id] });
          await refresh();
        }}
      />
    </>
  );
}
