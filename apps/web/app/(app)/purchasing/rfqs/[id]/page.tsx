'use client';

import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Ban, FilePlus2, Lock, MailCheck, MailX, Pencil, Plus, Trash2, Undo2, UserX } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { AuditTimeline } from '@/components/amc/audit-timeline';
import { FileRow } from '@/components/amc/file-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ComparisonTab, SelectionsTab } from '@/components/purchasing/comparison-view';
import { QuotationFormDialog } from '@/components/purchasing/quotation-form-dialog';
import {
  COMPLIANCE_LABELS,
  COMPLIANCE_TONES,
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUS_TONES,
  RFQ_SUPPLIER_STATUS_LABELS,
  RFQ_SUPPLIER_STATUS_TONES,
  commandError,
  isPast,
  purKeys,
  toDateInput,
  todayInput,
  useCommand,
  useUrlParams,
} from '@/components/purchasing/lib';
import type { PurchasingAttachment, Quotation, RfqDetail, RfqSupplier } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, FormField, Money, RfqStatusBadge, StatusPill, SupplierMultiPicker, TextActionDialog } from '@/components/purchasing/ui';

const OPEN = ['DRAFT', 'ISSUED', 'QUOTED'];

export default function RfqDetailPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <RfqDetailView />
    </Suspense>
  );
}

function RfqDetailView() {
  const { id } = useParams<{ id: string }>();
  const { get, set } = useUrlParams();
  const { can } = useSession();
  const run = useCommand();
  const [dialog, setDialog] = useState<null | 'edit' | 'addSuppliers' | 'quotation' | 'close' | 'cancel'>(null);
  const q = useQuery({ queryKey: purKeys.rfq(id), queryFn: () => api.get<RfqDetail>(`/rfqs/${id}`) });

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rfq = q.data;
  const manage = can('rfq.manage');
  const tab = get('tab') || 'lines';

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'RFQ & devis', href: '/purchasing/rfqs' }, { label: rfq.number }]}
        title={<>RFQ <span className="ref">{rfq.number}</span></>}
        description={rfq.title}
        meta={
          <>
            <RfqStatusBadge status={rfq.status} />
            <Badge tone="navy" icon={false}>
              {rfq.vessel.name}
            </Badge>
            {rfq.deadline && (
              <Badge tone={rfq.status === 'ISSUED' && isPast(rfq.deadline) ? 'danger' : 'neutral'} icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
                Réponse avant le {fmtDate(rfq.deadline)}
              </Badge>
            )}
          </>
        }
        actions={
          <>
            {can('quotation.record') && ['DRAFT', 'ISSUED', 'QUOTED', 'EVALUATED'].includes(rfq.status) && (
              <Button onClick={() => setDialog('quotation')}>
                <FilePlus2 className="h-4 w-4" aria-hidden /> Saisir un devis
              </Button>
            )}
            {/* L'API n'accepte la modification qu'en brouillon */}
            {manage && rfq.status === 'DRAFT' && (
              <Button variant="secondary" onClick={() => setDialog('edit')}>
                <Pencil className="h-4 w-4" aria-hidden /> Modifier
              </Button>
            )}
            {manage && ['ISSUED', 'QUOTED', 'EVALUATED'].includes(rfq.status) && (
              <Button variant="ghost" onClick={() => setDialog('close')}>
                <Lock className="h-4 w-4" aria-hidden /> Clôturer
              </Button>
            )}
            {manage && !['CLOSED', 'CANCELLED'].includes(rfq.status) && (
              <Button variant="ghost" onClick={() => setDialog('cancel')}>
                <Ban className="h-4 w-4" aria-hidden /> Annuler
              </Button>
            )}
          </>
        }
      />

      {OPEN.includes(rfq.status) && (
        <Callout tone="info" className="mb-4" title="Consultation hors plateforme">
          La plateforme n’envoie aucun e-mail aux fournisseurs : contactez-les directement, notez le contact si vous le souhaitez (onglet Fournisseurs) et saisissez les
          devis reçus.
        </Callout>
      )}

      <Panel className="mb-5">
        <DefinitionGrid
          columns={4}
          items={[
            ['Navire', rfq.vessel.name],
            ['Créée par', `${rfq.createdByName ?? '—'} le ${fmtDateTime(rfq.createdAt)}`],
            ['Émise le', rfq.issuedAt ? fmtDateTime(rfq.issuedAt) : null],
            ['Date limite', rfq.deadline ? fmtDate(rfq.deadline) : null],
            ['Port de livraison', rfq.deliveryPort],
            ['Conditions de livraison', rfq.deliveryTerms],
            ['Notes', rfq.notes ? <span className="whitespace-pre-line">{rfq.notes}</span> : null],
          ]}
        />
      </Panel>

      <Tabs value={tab} onValueChange={(t) => set({ tab: t === 'lines' ? null : t })}>
        <TabsList className="mb-4">
          <TabsTrigger value="lines" count={rfq.lines.length}>
            Lignes
          </TabsTrigger>
          <TabsTrigger value="suppliers" count={rfq.suppliers.length}>
            Fournisseurs
          </TabsTrigger>
          {/* Devis : uniquement avec quotation.view (l'API n'expose pas les devis sinon) */}
          {rfq.quotations && (
            <TabsTrigger value="quotations" count={rfq.quotations.filter((x) => x.status !== 'WITHDRAWN').length}>
              Devis
            </TabsTrigger>
          )}
          {can('quotation.view') && <TabsTrigger value="comparison">Comparaison</TabsTrigger>}
          {can('quotation.view') && <TabsTrigger value="selections">Sélection & BC</TabsTrigger>}
          <TabsTrigger value="files" count={rfq.attachments.length}>
            Pièces jointes
          </TabsTrigger>
          {can('audit.view.purchasing') && <TabsTrigger value="history">Historique</TabsTrigger>}
        </TabsList>

        <TabsContent value="lines">
          <LinesTab rfq={rfq} />
        </TabsContent>
        <TabsContent value="suppliers">
          <SuppliersTab rfq={rfq} onAdd={() => setDialog('addSuppliers')} />
        </TabsContent>
        <TabsContent value="quotations">
          <QuotationsTab rfq={rfq} onRecord={() => setDialog('quotation')} />
        </TabsContent>
        <TabsContent value="comparison">{tab === 'comparison' && <ComparisonTab rfq={rfq} />}</TabsContent>
        <TabsContent value="selections">{tab === 'selections' && <SelectionsTab rfq={rfq} />}</TabsContent>
        <TabsContent value="files">
          <Panel title="Pièces jointes de la RFQ">
            <AttachmentsPanel
              path={`/rfqs/${rfq.id}/attachments`}
              vesselId={rfq.vesselId}
              attachments={rfq.attachments}
              canManage={manage}
              onChanged={() => q.refetch()}
              hint="plans, photos, fiches techniques à partager avec les fournisseurs"
            />
          </Panel>
        </TabsContent>
        <TabsContent value="history">
          <Panel title="Journal d’audit">{tab === 'history' && <AuditTimeline entityType="rfq" entityId={rfq.id} module="purchasing" />}</Panel>
        </TabsContent>
      </Tabs>

      {dialog === 'edit' && <EditRfqDialog rfq={rfq} onClose={() => setDialog(null)} />}
      {dialog === 'addSuppliers' && <AddSuppliersDialog rfq={rfq} onClose={() => setDialog(null)} />}
      {dialog === 'quotation' && <QuotationFormDialog open onOpenChange={(o) => !o && setDialog(null)} rfq={rfq} />}
      <TextActionDialog
        open={dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Clôturer la RFQ ${rfq.number}`}
        description="La consultation est terminée : plus aucun devis ni sélection."
        confirmLabel="Clôturer"
        onConfirm={(comment) => run(() => api.post(`/rfqs/${rfq.id}/close`, { comment: comment || null }), 'RFQ clôturée')}
      />
      <TextActionDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Annuler la RFQ ${rfq.number}`}
        description="Impossible si des bons de commande actifs découlent de cette RFQ."
        label="Motif"
        required
        tone="danger"
        confirmLabel="Annuler la RFQ"
        onConfirm={(reason) => run(() => api.post(`/rfqs/${rfq.id}/cancel`, { reason }), 'RFQ annulée')}
      />
    </>
  );
}

function LinesTab({ rfq }: { rfq: RfqDetail }) {
  const open = useQuery({
    queryKey: [...purKeys.rfq(rfq.id), 'open-quantities'],
    queryFn: () => api.get<{ rfqLineId: string; prOpenQuantity: string }[]>(`/rfqs/${rfq.id}/open-quantities`),
  });
  const openBy = new Map((open.data ?? []).map((o) => [o.rfqLineId, o.prOpenQuantity]));
  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-panel">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col">N°</th>
            <th scope="col">Désignation</th>
            <th scope="col" className="text-right">
              Qté consultée
            </th>
            <th scope="col">PR d’origine</th>
            <th scope="col" className="text-right">
              Reste à commander (PR)
            </th>
            <th scope="col">Remarques</th>
          </tr>
        </thead>
        <tbody>
          {rfq.lines.map((l) => (
            <tr key={l.id}>
              <td className="tabular">{l.lineNo}</td>
              <td className="min-w-[200px]">
                {l.designation}
                {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
              </td>
              <td className="text-right tabular">
                {fmtDecimal(l.quantity)} {l.unit}
              </td>
              <td>
                <Link href={`/purchasing/requests/${l.prLine.prId}`} className="text-action hover:underline">
                  {l.prLine.pr.number}
                </Link>{' '}
                <span className="text-xs text-ink-muted">ligne {l.prLine.lineNo}</span>
              </td>
              <td className="text-right tabular">{openBy.has(l.id) ? fmtDecimal(openBy.get(l.id)) : '—'}</td>
              <td className="text-xs text-ink-muted">{l.remarks ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuppliersTab({ rfq, onAdd }: { rfq: RfqDetail; onAdd: () => void }) {
  const { can } = useSession();
  const run = useCommand();
  const manage = can('rfq.manage') && OPEN.includes(rfq.status);
  const [markSent, setMarkSent] = useState<RfqSupplier | null>(null);
  const [decline, setDecline] = useState<RfqSupplier | null>(null);
  const [remove, setRemove] = useState<RfqSupplier | null>(null);
  return (
    <div className="space-y-3">
      {manage && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onAdd}>
            <Plus className="h-4 w-4" aria-hidden /> Ajouter des fournisseurs
          </Button>
        </div>
      )}
      {!rfq.suppliers.length && <EmptyState title="Aucun fournisseur consulté" description="Ajoutez les fournisseurs que vous contactez pour cette consultation." />}
      <ul className="space-y-2">
        {rfq.suppliers.map((s) => (
          <li key={s.id} className="rounded-lg bg-white p-3 shadow-panel">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-navy">
                  <Link href={`/purchasing/suppliers?selected=${s.supplierId}`} className="hover:underline">
                    {s.supplier.name}
                  </Link>{' '}
                  <span className="text-xs text-ink-muted">{s.supplier.code}</span>
                </p>
                {s.supplier.email && <p className="text-xs text-ink-muted">{s.supplier.email}</p>}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <StatusPill status={s.status} labels={RFQ_SUPPLIER_STATUS_LABELS} tones={RFQ_SUPPLIER_STATUS_TONES} />
                  {s.sentAt && (
                    <span className="text-xs text-ink-muted">
                      {s.sentTo?.startsWith('MANUEL') ? 'Contacté' : 'Envoyée'} le {fmtDateTime(s.sentAt)} — {s.sentTo?.replace(/^MANUEL : /, '')}
                    </span>
                  )}
                </div>
                {s.status === 'SEND_FAILED' && s.sendError && (
                  <p className="mt-1 flex items-start gap-1 text-sm text-danger" role="alert">
                    <MailX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {s.sendError}
                  </p>
                )}
              </div>
              {manage && (
                <div className="flex flex-wrap gap-1">
                  {(s.status === 'PENDING' || s.status === 'SEND_FAILED') && (
                    <Button size="sm" variant="secondary" onClick={() => setMarkSent(s)}>
                      <MailCheck className="h-4 w-4" aria-hidden /> Noter le contact
                    </Button>
                  )}
                  {s.status !== 'QUOTED' && s.status !== 'DECLINED' && (
                    <Button size="sm" variant="ghost" onClick={() => setDecline(s)}>
                      <UserX className="h-4 w-4" aria-hidden /> A décliné
                    </Button>
                  )}
                  {(s.status === 'PENDING' || s.status === 'SEND_FAILED') && !s.sentAt && (
                    <Button size="sm" variant="ghost" onClick={() => setRemove(s)}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Retirer
                    </Button>
                  )}
                </div>
              )}
            </div>
            {s.sentDocuments.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-ink-muted">Demande(s) de prix envoyée(s) auparavant :</p>
                {s.sentDocuments.map((f) => (
                  <FileRow key={f.id} fileId={f.id} name={f.originalName} kind={f.kind} sizeBytes={f.sizeBytes} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {markSent && <MarkSentDialog rfq={rfq} supplier={markSent} onClose={() => setMarkSent(null)} />}
      <TextActionDialog
        open={!!decline}
        onOpenChange={(o) => !o && setDecline(null)}
        title={`${decline?.supplier.name ?? ''} a décliné la consultation`}
        confirmLabel="Enregistrer"
        onConfirm={(comment) => run(() => api.post(`/rfqs/${rfq.id}/suppliers/${decline!.supplierId}/decline`, { comment: comment || null }), 'Refus du fournisseur enregistré')}
      />
      <TextActionDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title={`Retirer ${remove?.supplier.name ?? ''} de la consultation`}
        description="Possible uniquement tant que rien ne lui a été transmis."
        label="Note (facultative)"
        confirmLabel="Retirer"
        tone="danger"
        onConfirm={() => run(() => api.delete(`/rfqs/${rfq.id}/suppliers/${remove!.supplierId}`), 'Fournisseur retiré')}
      />
    </div>
  );
}

function MarkSentDialog({ rfq, supplier, onClose }: { rfq: RfqDetail; supplier: RfqSupplier; onClose: () => void }) {
  const run = useCommand();
  const [recipient, setRecipient] = useState(supplier.supplier.email ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Noter le contact — ${supplier.supplier.name}`}
      description="Comment avez-vous consulté ce fournisseur (téléphone, e-mail personnel, rendez-vous) ? La déclaration vous est attribuée et tracée ; la plateforme n’envoie aucun e-mail."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={recipient.trim().length < 2}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(() => api.post(`/rfqs/${rfq.id}/suppliers/${supplier.supplierId}/mark-sent`, { channel: 'MANUAL', recipient: recipient.trim(), note: note.trim() || null }), 'Contact noté');
                onClose();
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <MailCheck className="h-4 w-4" aria-hidden /> Noter le contact
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Destinataire / moyen" required hint="ex. Téléphone +216 … (M. Dupont), remise au représentant">
          <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={300} />
        </FormField>
        <FormField label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </FormField>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}

function EditRfqDialog({ rfq, onClose }: { rfq: RfqDetail; onClose: () => void }) {
  const run = useCommand();
  const [v, setV] = useState({ title: rfq.title, deadline: toDateInput(rfq.deadline), deliveryPort: rfq.deliveryPort ?? '', deliveryTerms: rfq.deliveryTerms ?? '', notes: rfq.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Modifier ${rfq.number}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={v.title.trim().length < 2}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(
                  () =>
                    api.patch(`/rfqs/${rfq.id}`, {
                      title: v.title.trim(),
                      deadline: v.deadline || null,
                      deliveryPort: v.deliveryPort.trim() || null,
                      deliveryTerms: v.deliveryTerms.trim() || null,
                      notes: v.notes.trim() || null,
                    }),
                  'RFQ mise à jour',
                );
                onClose();
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Titre" required className="sm:col-span-2">
          <Input value={v.title} onChange={(e) => setV((x) => ({ ...x, title: e.target.value }))} maxLength={300} />
        </FormField>
        <FormField label="Date limite">
          <Input type="date" value={v.deadline} min={todayInput()} onChange={(e) => setV((x) => ({ ...x, deadline: e.target.value }))} />
        </FormField>
        <FormField label="Port de livraison">
          <Input value={v.deliveryPort} onChange={(e) => setV((x) => ({ ...x, deliveryPort: e.target.value }))} maxLength={120} />
        </FormField>
        <FormField label="Conditions de livraison" className="sm:col-span-2">
          <Input value={v.deliveryTerms} onChange={(e) => setV((x) => ({ ...x, deliveryTerms: e.target.value }))} maxLength={500} />
        </FormField>
        <FormField label="Notes" className="sm:col-span-2">
          <Textarea rows={3} value={v.notes} onChange={(e) => setV((x) => ({ ...x, notes: e.target.value }))} maxLength={5000} />
        </FormField>
        {error && (
          <div className="sm:col-span-2">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function AddSuppliersDialog({ rfq, onClose }: { rfq: RfqDetail; onClose: () => void }) {
  const run = useCommand();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ajouter des fournisseurs"
      description="Les nouveaux fournisseurs restent « à envoyer » jusqu’à la prochaine émission."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={!ids.length}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(() => api.post(`/rfqs/${rfq.id}/suppliers`, { supplierIds: ids }), `${ids.length} fournisseur(s) ajouté(s)`);
                onClose();
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Ajouter ({ids.length})
          </Button>
        </>
      }
    >
      <SupplierMultiPicker value={ids} onChange={setIds} exclude={rfq.suppliers.map((s) => s.supplierId)} />
      {error && <Callout tone="danger" className="mt-3">{error}</Callout>}
    </Dialog>
  );
}

function QuotationsTab({ rfq, onRecord }: { rfq: RfqDetail; onRecord: () => void }) {
  const { can } = useSession();
  const q = useQuery({ queryKey: [...purKeys.rfq(rfq.id), 'quotations'], queryFn: () => api.get<Quotation[]>(`/rfqs/${rfq.id}/quotations`), enabled: can('quotation.view') });
  if (!can('quotation.view')) return <EmptyState title="Devis non accessibles" description="La permission quotation.view est requise." />;
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const list = q.data ?? [];
  return (
    <div className="space-y-3">
      {!list.length && (
        <EmptyState
          title="Aucun devis saisi"
          description="Saisissez les offres reçues (PDF original conservé) pour les comparer."
          action={
            can('quotation.record') && ['DRAFT', 'ISSUED', 'QUOTED', 'EVALUATED'].includes(rfq.status) ? (
              <Button onClick={onRecord}>
                <FilePlus2 className="h-4 w-4" aria-hidden /> Saisir un devis
              </Button>
            ) : undefined
          }
        />
      )}
      {list.map((qt) => (
        <QuotationCard key={qt.id} rfq={rfq} quotation={qt} />
      ))}
    </div>
  );
}

function QuotationCard({ rfq, quotation: qt }: { rfq: RfqDetail; quotation: Quotation }) {
  const { can } = useSession();
  const run = useCommand();
  const [withdraw, setWithdraw] = useState(false);
  const [open, setOpen] = useState(qt.status !== 'WITHDRAWN');
  const lineById = new Map(rfq.lines.map((l) => [l.id, l]));
  const atts = useQuery({
    queryKey: [...purKeys.rfq(rfq.id), 'quotation-attachments', qt.id],
    queryFn: () => api.get<PurchasingAttachment[]>(`/quotations/${qt.id}/attachments`),
    enabled: open,
  });
  return (
    <div className={`rounded-lg bg-white shadow-panel ${qt.status === 'WITHDRAWN' ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <p className="font-semibold text-navy">
            {qt.supplier.name}
            {qt.reference ? <span className="font-normal text-ink-muted"> — {qt.reference}</span> : null}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <StatusPill status={qt.status} labels={QUOTATION_STATUS_LABELS} tones={QUOTATION_STATUS_TONES} />
            <span>Reçu le {fmtDateTime(qt.receivedAt)}</span>
            {qt.validUntil && <span>· valide jusqu’au {fmtDate(qt.validUntil)}</span>}
            {qt.leadTimeDays !== null && <span>· délai {qt.leadTimeDays} j</span>}
            {qt.incoterm && <span>· {qt.incoterm}</span>}
          </div>
          {qt.status === 'WITHDRAWN' && qt.evaluationNote && <p className="mt-1 text-xs text-danger">{qt.evaluationNote}</p>}
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold">
            <Money value={qt.totalAmount} currency={qt.currency} />
          </p>
          <p className="text-xs text-ink-muted">
            Sous-total <Money value={qt.subtotal} currency={qt.currency} />
            {qt.freightAmount ? (
              <>
                {' '}
                · fret <Money value={qt.freightAmount} currency={qt.currency} />
              </>
            ) : null}
            {qt.taxAmount ? (
              <>
                {' '}
                · taxes <Money value={qt.taxAmount} currency={qt.currency} />
              </>
            ) : null}
            {qt.discountAmount ? (
              <>
                {' '}
                · remise −<Money value={qt.discountAmount} currency={qt.currency} />
              </>
            ) : null}
          </p>
          <div className="mt-1 flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
              {open ? 'Replier' : 'Détail'}
            </Button>
            {can('quotation.record') && qt.status !== 'WITHDRAWN' && (
              <Button size="sm" variant="ghost" onClick={() => setWithdraw(true)}>
                <Undo2 className="h-4 w-4" aria-hidden /> Retirer
              </Button>
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="space-y-3 px-4 py-3">
          <div className="overflow-x-auto">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Ligne</th>
                  <th scope="col">Offre</th>
                  <th scope="col" className="text-right">
                    Qté offerte
                  </th>
                  <th scope="col" className="text-right">
                    PU
                  </th>
                  <th scope="col" className="text-right">
                    Total ligne
                  </th>
                  <th scope="col" className="text-right">
                    Délai
                  </th>
                  <th scope="col">Conformité</th>
                  <th scope="col">Remarques</th>
                </tr>
              </thead>
              <tbody>
                {qt.lines.map((l) => {
                  const rl = lineById.get(l.rfqLineId);
                  return (
                    <tr key={l.id}>
                      <td>{rl ? `${rl.lineNo}. ${rl.designation}` : '—'}</td>
                      <td>{l.isAvailable ? <Badge tone="ok">Disponible</Badge> : <Badge tone="danger">Indisponible</Badge>}</td>
                      <td className="text-right tabular">{l.quantityOffered !== null ? `${fmtDecimal(l.quantityOffered)} ${l.unit ?? ''}` : '—'}</td>
                      <td className="text-right">{l.unitPrice !== null ? <Money value={l.unitPrice} currency={qt.currency} /> : '—'}</td>
                      <td className="text-right">{l.lineTotal !== null ? <Money value={l.lineTotal} currency={qt.currency} /> : '—'}</td>
                      <td className="text-right tabular">{l.leadTimeDays !== null ? `${l.leadTimeDays} j` : '—'}</td>
                      <td>
                        <StatusPill status={l.compliance} labels={COMPLIANCE_LABELS} tones={COMPLIANCE_TONES} />
                      </td>
                      <td className="text-xs text-ink-muted">{l.remarks ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(qt.deliveryTerms || qt.paymentTerms || qt.comments) && (
            <DefinitionGrid
              columns={3}
              items={[
                ['Livraison', qt.deliveryTerms],
                ['Paiement', qt.paymentTerms],
                ['Commentaires', qt.comments],
              ]}
            />
          )}
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Devis original et pièces</p>
            {qt.fileId && <FileRow fileId={qt.fileId} name="Devis original (PDF fournisseur)" kind="PDF" />}
            <div className="mt-1.5">
              <AttachmentsPanel
                path={`/quotations/${qt.id}/attachments`}
                vesselId={rfq.vesselId}
                attachments={(atts.data ?? []).filter((a) => a.fileId !== qt.fileId)}
                canManage={can('quotation.record') && qt.status !== 'WITHDRAWN'}
                onChanged={() => atts.refetch()}
                emptyText={qt.fileId ? 'Aucune autre pièce.' : 'Aucun fichier : le PDF original du devis n’a pas été déposé.'}
              />
            </div>
          </div>
        </div>
      )}
      <TextActionDialog
        open={withdraw}
        onOpenChange={setWithdraw}
        title="Retirer ce devis"
        description="Un devis n’est jamais modifié : pour corriger une erreur de saisie, retirez-le puis saisissez un nouveau devis. Impossible si un BC actif l’utilise."
        label="Motif du retrait"
        required
        tone="danger"
        confirmLabel="Retirer le devis"
        onConfirm={(reason) => run(() => api.post(`/quotations/${qt.id}/withdraw`, { reason }), 'Devis retiré')}
      />
    </div>
  );
}

