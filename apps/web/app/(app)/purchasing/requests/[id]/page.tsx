'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  Ban,
  CheckCircle2,
  CircleDashed,
  FileSearch,
  GitCompareArrows,
  Lock,
  MessagesSquare,
  PackageCheck,
  PauseCircle,
  PlayCircle,
  Send,
  ShoppingCart,
  Split,
  Stamp,
  Undo2,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ManualPoDialog } from '@/components/purchasing/manual-po-dialog';
import { PrDraftEditor, type PrDraftEditorHandle } from '@/components/purchasing/pr-draft-editor';
import { PrCommentsThread, PrLinkedDocuments } from '@/components/purchasing/pr-extras';
import { PRLineProgress, PRLineProgressLegend } from '@/components/purchasing/pr-line-progress';
import { PrRevisionsTab, REVISABLE } from '@/components/purchasing/pr-revisions';
import { PrSplitDialog } from '@/components/purchasing/pr-split-dialog';
import { LINE_BADGE_LABELS, dec, isPoReceivable, purKeys, useCommand, useUrlParams } from '@/components/purchasing/lib';
import type { PrDetail, PrLine } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, HistoryList, LineBadge, PdfActions, PriorityBadge, PrStatusBadge, TextActionDialog } from '@/components/purchasing/ui';

const SOURCEABLE = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'];
const ORDERABLE = ['APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED'];
const HOLDABLE = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'];
const CANCELLABLE = ['SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'APPROVED', 'SOURCING', 'ON_HOLD'];
const CLOSABLE = ['PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'];
const OPEN = ['SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'ON_HOLD'];

type DialogKind = 'submit' | 'discard' | 'startReview' | 'endorse' | 'approve' | 'reject' | 'hold' | 'resume' | 'cancel' | 'close';

export default function PurchaseRequestDetailPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <PrDetailView />
    </Suspense>
  );
}

function PrDetailView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { get, set } = useUrlParams();
  const { can, canAny, me } = useSession();
  const run = useCommand();
  const editor = useRef<PrDraftEditorHandle>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [poOpen, setPoOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);

  const q = useQuery({ queryKey: purKeys.pr(id), queryFn: () => api.get<PrDetail>(`/purchase-requests/${id}`) });

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const pr = q.data;
  const s = pr.status;
  const isRequester = pr.requesterId === me.id;
  const steps = pr.reviewCircuit?.steps ?? [];
  const pendingIdx = steps.findIndex((st) => st.status === 'PENDING');
  const intermediate = pendingIdx >= 0 && pendingIdx < steps.length - 1 ? steps[pendingIdx] : null;
  const inReview = s === 'SUBMITTED' || s === 'UNDER_REVIEW';
  // Seul le demandeur modifie / soumet son brouillon (le serveur refuse les autres : 403)
  const editable = s === 'DRAFT' && can('pr.edit') && isRequester;
  const overdue = !!pr.neededBy && OPEN.includes(s) && new Date(pr.neededBy) < new Date(new Date().toISOString().slice(0, 10));
  const tab = get('tab') || 'lines';
  const v = pr.lockVersion;
  const anyOrdered = pr.lines.some((l) => dec.gt0(l.progress?.allocated));
  const activeRfq = (pr.links.rfqs ?? []).some((r) => r.status !== 'CLOSED' && r.status !== 'CANCELLED');
  const canSplit = can('pr.approve') && !isRequester && !pr.parentId && ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(s) && !anyOrdered && !activeRfq && !intermediate;
  const canCounter = can('pr.revise') && !isRequester && REVISABLE.includes(s);
  const openCounter = () => set({ tab: 'revisions', counter: '1' });
  // Counter-PR déjà appliquée alors que la PR est encore en discussion : il reste à valider ou diviser
  const countered = s === 'UNDER_REVIEW' && pr.currentRevisionNo > 0;
  const decide = can('pr.approve') && !isRequester;
  // PR mère restée « Divisée » alors que toutes ses sous-PR sont terminées (avant correctif ACH-03)
  const splitDone = s === 'SPLIT' && pr.children.length > 0 && pr.children.every((c) => ['CLOSED', 'CANCELLED', 'REJECTED'].includes(c.status));

  const post = (path: string, body: Record<string, unknown>, success: string) => run(() => api.post(`/purchase-requests/${pr.id}/${path}`, body), success);

  const actions = (
    <>
      <PdfActions path={`/purchase-requests/${pr.id}/pdf`} title={`PR ${pr.number}`} />
      {s === 'DRAFT' && can('pr.submit') && isRequester && (
        <Button onClick={() => setDialog('submit')}>
          <Send className="h-4 w-4" aria-hidden /> Soumettre
        </Button>
      )}
      {s === 'DRAFT' && (can('pr.cancel') || (isRequester && can('pr.edit'))) && (
        <Button variant="ghost" onClick={() => setDialog('discard')}>
          <Ban className="h-4 w-4" aria-hidden /> Abandonner
        </Button>
      )}
      {inReview && intermediate && canAny('pr.approve', 'pr.submit') && (
        <Button variant="secondary" onClick={() => setDialog('endorse')} title={intermediate.roleKeys?.length ? `Réservé aux rôles : ${intermediate.roleKeys.join(', ')}` : undefined}>
          <Stamp className="h-4 w-4" aria-hidden /> Viser : {intermediate.label}
        </Button>
      )}
      {HOLDABLE.includes(s) && can('pr.approve') && (
        <Button variant="ghost" onClick={() => setDialog('hold')}>
          <PauseCircle className="h-4 w-4" aria-hidden /> Mettre en attente
        </Button>
      )}
      {s === 'ON_HOLD' && can('pr.approve') && (
        <Button onClick={() => setDialog('resume')}>
          <PlayCircle className="h-4 w-4" aria-hidden /> Reprendre
        </Button>
      )}
      {(CLOSABLE.includes(s) || splitDone) && can('pr.approve') && (
        <Button variant="ghost" onClick={() => setDialog('close')}>
          <Lock className="h-4 w-4" aria-hidden /> Clôturer
        </Button>
      )}
      {CANCELLABLE.includes(s) && can('pr.cancel') && (
        <Button variant="ghost" onClick={() => setDialog('cancel')}>
          <Ban className="h-4 w-4" aria-hidden /> Annuler la PR
        </Button>
      )}
    </>
  );

  const badgeCounts = pr.lines.reduce<Record<string, number>>((acc, l) => {
    const b = l.progress?.badge ?? 'NOT_ORDERED';
    acc[b] = (acc[b] ?? 0) + 1;
    return acc;
  }, {});
  const missingLines = pr.lines.filter((l) => l.progress && l.progress.badge !== 'CANCELLED' && dec.gt0(dec.sub(l.progress.effective, l.progress.accepted)));
  const toOrderLines = pr.lines.filter((l) => l.progress && l.status !== 'CANCELLED' && dec.gt0(l.progress.toOrder));
  const receivableOrders = (pr.links.orders ?? []).filter((o) => isPoReceivable(o));

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'Achats', href: '/purchasing' },
          { label: 'Purchase Requests', href: '/purchasing/requests' },
          ...(pr.parent ? [{ label: pr.parent.number, href: `/purchasing/requests/${pr.parent.id}` }] : []),
          { label: pr.number },
        ]}
        title={
          <>
            {pr.parentId ? 'Sous-PR' : 'PR'} <span className="ref">{pr.number}</span>
          </>
        }
        description={pr.subject}
        meta={
          <>
            <PrStatusBadge status={s} />
            <PriorityBadge priority={pr.priority} />
            <Badge tone="navy" icon={false}>
              {pr.vessel.name}
            </Badge>
            {overdue && (
              <Badge tone="danger" icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
                Besoin dépassé ({fmtDate(pr.neededBy)})
              </Badge>
            )}
            {pr.currentRevisionNo > 0 && <Badge tone="info">Counter-PR n°{pr.currentRevisionNo}</Badge>}
          </>
        }
        actions={actions}
      />

      {/* ------------------------------------------------------------- prochaine étape */}
      {s === 'SUBMITTED' && can('pr.approve') && !isRequester && (
        <NextStep tone="action" title="Nouvelle PR à étudier" text="Mettez-la en discussion : le demandeur est prévenu et vous décidez ensuite de la suite (continuer, Counter-PR ou division).">
          <Button onClick={() => setDialog('startReview')}>
            <MessagesSquare className="h-4 w-4" aria-hidden /> Mettre en discussion
          </Button>
          <Button variant="danger" onClick={() => setDialog('reject')}>
            <XCircle className="h-4 w-4" aria-hidden /> Rejeter
          </Button>
        </NextStep>
      )}
      {s === 'UNDER_REVIEW' && can('pr.approve') && !isRequester && (
        <section aria-labelledby="decision-title" className="mb-5 rounded-lg border border-action-100 bg-white shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-action-50 px-4 py-2.5">
            <h2 id="decision-title" className="text-sm font-semibold text-navy">
              {countered ? (
                <>
                  <CheckCircle2 className="mr-1.5 inline h-4 w-4 align-[-3px] text-ok" aria-hidden />
                  Counter-PR n°{pr.currentRevisionNo} appliquée — prochaine étape : valider la PR modifiée ou la diviser
                </>
              ) : (
                'PR en discussion — quelle suite ?'
              )}
            </h2>
            <span className="text-xs text-ink-muted">Le choix vaut validation ; le demandeur est notifié.</span>
          </div>
          <div className="grid gap-px bg-line md:grid-cols-3">
            <DecisionChoice
              icon={<CheckCircle2 className="h-5 w-5 text-ok" aria-hidden />}
              title={countered ? 'Continuer avec la PR modifiée' : 'Continuer avec cette PR'}
              text={
                countered
                  ? 'Valide la PR avec les quantités de la Counter-PR ; vous créez ensuite le BC (ou consultez des fournisseurs).'
                  : 'Validée telle quelle : BC direct ou consultation des fournisseurs.'
              }
              highlight={countered}
              action={
                <Button size="sm" onClick={() => setDialog('approve')} disabled={!!intermediate} title={intermediate ? `Étape en attente : ${intermediate.label}` : undefined}>
                  {countered ? 'Valider et continuer' : 'Continuer'}
                </Button>
              }
            />
            <DecisionChoice
              icon={<GitCompareArrows className="h-5 w-5 text-warn" aria-hidden />}
              title="Counter-PR"
              text={
                countered
                  ? 'Déjà appliquée (voir l’onglet Counter-PR) ; vous pouvez encore ajuster la demande.'
                  : 'Modifier quantités, articles ou date de besoin ; vous pourrez ensuite continuer ou diviser.'
              }
              action={
                <Button size="sm" variant="secondary" onClick={openCounter} disabled={!canCounter}>
                  {countered ? 'Modifier à nouveau' : 'Modifier la PR'}
                </Button>
              }
            />
            <DecisionChoice
              icon={<Split className="h-5 w-5 text-action" aria-hidden />}
              title="Diviser en sous-PR"
              text="Une sous-PR par fournisseur, lignes entières ; chacune aura son BC et son BL."
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSplitOpen(true)}
                  disabled={!canSplit}
                  title={!canSplit ? (activeRfq ? 'RFQ en cours sur cette PR' : pr.lines.length < 2 ? 'Une seule ligne' : undefined) : undefined}
                >
                  Diviser
                </Button>
              }
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-2">
            <Button size="sm" variant="ghost" onClick={() => set({ tab: 'discussion' })}>
              <MessagesSquare className="h-4 w-4" aria-hidden /> Discussion
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDialog('reject')}>
              <XCircle className="h-4 w-4" aria-hidden /> Rejeter
            </Button>
          </div>
        </section>
      )}
      {inReview && (isRequester || !can('pr.approve')) && (
        <NextStep
          title={s === 'SUBMITTED' ? 'En attente de prise en charge par les Achats' : 'Les Achats étudient la demande'}
          text="Vous serez notifié de leur décision (validation, Counter-PR ou division). Vous pouvez échanger dans l’onglet Discussion."
        >
          <Button variant="secondary" size="sm" onClick={() => set({ tab: 'discussion' })}>
            <MessagesSquare className="h-4 w-4" aria-hidden /> Discussion
          </Button>
        </NextStep>
      )}
      {['APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'].includes(s) && canAny('bc.create', 'rfq.manage', 'pr.approve') && !isRequester && (
        <NextStep
          tone="action"
          title={s === 'PARTIALLY_ORDERED' ? 'Commande partielle — reste à commander' : 'PR validée — prochaine étape : le bon de commande'}
          text={
            toOrderLines.length
              ? `${toOrderLines.length} ligne(s) à commander. Contactez les fournisseurs (dans ou hors plateforme), puis créez et émettez le BC : le demandeur le reçoit avec la date et le port de livraison.`
              : 'Toutes les lignes sont engagées sur un BC.'
          }
        >
          {ORDERABLE.includes(s) && can('bc.create') && toOrderLines.length > 0 && (
            <Button onClick={() => setPoOpen(true)}>
              <ShoppingCart className="h-4 w-4" aria-hidden /> Créer le BC
            </Button>
          )}
          {SOURCEABLE.includes(s) && can('rfq.manage') && (
            <Button variant="secondary" onClick={() => router.push(`/purchasing/rfqs/new?prId=${pr.id}&vesselId=${pr.vesselId}`)}>
              <FileSearch className="h-4 w-4" aria-hidden /> Consulter des fournisseurs (RFQ)
            </Button>
          )}
          {canSplit && (
            <Button variant="secondary" onClick={() => setSplitOpen(true)}>
              <Split className="h-4 w-4" aria-hidden /> Diviser
            </Button>
          )}
          {canCounter && (
            <Button variant="ghost" onClick={openCounter}>
              <GitCompareArrows className="h-4 w-4" aria-hidden /> Counter-PR
            </Button>
          )}
        </NextStep>
      )}
      {receivableOrders.length > 0 && can('receiving.record') && (
        <NextStep
          tone="action"
          title="Livraison attendue — répondez au BC par un BL"
          text="À la réception, saisissez les quantités reçues ou joignez le BL (PDF, Excel, photo). Tout écart est signalé aux Achats."
        >
          {receivableOrders.map((o) => (
            <Button key={o.id} variant="secondary" onClick={() => router.push(`/purchasing/deliveries/receive?poId=${o.id}`)}>
              <PackageCheck className="h-4 w-4" aria-hidden /> BL du BC {o.number}
            </Button>
          ))}
        </NextStep>
      )}
      {s === 'SPLIT' && (
        <Panel title="PR divisée en sous-PR" className="mb-5">
          <p className="mb-3 text-sm text-ink-muted">
            Cette PR est conservée en lecture seule. Chaque sous-PR suit son propre BC puis son propre BL ; la PR d’origine se clôture quand toutes ses sous-PR sont
            terminées.
          </p>
          <ul className="divide-y divide-line rounded-md border border-line">
            {pr.children.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <Link href={`/purchasing/requests/${c.id}`} className="min-w-0 font-medium text-action hover:underline">
                  <span className="ref">{c.number}</span> <span className="text-ink">— {c.subject}</span>
                </Link>
                <span className="flex items-center gap-2 text-xs text-ink-muted">
                  {c.lineCount} ligne(s) <PrStatusBadge status={c.status} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {pr.parent && (
        <Callout tone="info" className="mb-4" title={`Sous-PR de ${pr.parent.number}`}>
          Issue de la division de{' '}
          <Link href={`/purchasing/requests/${pr.parent.id}`} className="font-medium text-action hover:underline">
            {pr.parent.number}
          </Link>{' '}
          ({pr.parent.subject}). Elle suit son propre BC et son propre BL.
        </Callout>
      )}
      {s === 'CLOSED' && pr.closedAt && (
        <Callout tone="info" className="mb-4" title={`PR clôturée le ${fmtDateTime(pr.closedAt)}`}>
          {pr.children.length ? 'Toutes les sous-PR sont terminées.' : 'Les articles des bons de commande ont été reçus à bord.'}
        </Callout>
      )}
      {s === 'REVISED' && (
        <Callout tone="warn" className="mb-4" title="Ancienne Counter-PR en attente de décision">
          Une proposition de révision attend une décision.{' '}
          <button type="button" className="font-medium text-action hover:underline" onClick={() => set({ tab: 'revisions' })}>
            Ouvrir la Counter-PR
          </button>
        </Callout>
      )}
      {s === 'DRAFT' && !isRequester && (
        <Callout tone="info" className="mb-4" title="Brouillon en cours de saisie">
          Seul le demandeur ({pr.requesterName ?? '—'}) peut modifier et soumettre ce brouillon.
        </Callout>
      )}
      {(s === 'CANCELLED' || s === 'REJECTED') && (
        <Callout tone="danger" className="mb-4" title={s === 'CANCELLED' ? `PR annulée le ${fmtDateTime(pr.cancelledAt)}` : 'PR rejetée'}>
          {pr.cancelReason ?? 'Le motif figure dans la discussion et l’historique.'}
        </Callout>
      )}

      <Panel className="mb-5">
        <DefinitionGrid
          columns={4}
          items={[
            ['Navire', pr.vessel.name],
            ['Demandeur', pr.requesterName],
            ['Département', pr.department?.name ?? null],
            ['Catégorie', pr.category],
            ['Date de la demande', fmtDate(pr.requestDate)],
            ['Besoin pour le', pr.neededBy ? fmtDate(pr.neededBy) : null],
            ['Soumise le', pr.submittedAt ? fmtDateTime(pr.submittedAt) : null],
            ['Validée', pr.approvedAt ? `${fmtDateTime(pr.approvedAt)} par ${pr.approvedByName ?? '—'}` : null],
            ['Référence formulaire', pr.formRef],
            ['Commentaire', pr.comment ? <span className="whitespace-pre-line">{pr.comment}</span> : null],
          ]}
        />
      </Panel>

      <Tabs value={tab} onValueChange={(t) => set({ tab: t === 'lines' ? null : t, counter: null })}>
        <TabsList className="mb-4">
          <TabsTrigger value="lines" count={pr.lines.length}>
            {editable ? 'Brouillon' : 'Lignes & avancement'}
          </TabsTrigger>
          <TabsTrigger value="revisions" count={pr.revisions.length}>
            Counter-PR
          </TabsTrigger>
          <TabsTrigger value="discussion">Discussion</TabsTrigger>
          <TabsTrigger value="links">Documents liés</TabsTrigger>
          <TabsTrigger value="files" count={pr.attachments.length + pr.parentAttachments.length}>
            Pièces jointes
          </TabsTrigger>
          <TabsTrigger value="circuit">Circuit de revue</TabsTrigger>
          <TabsTrigger value="history">Historique</TabsTrigger>
        </TabsList>

        <TabsContent value="lines">
          {editable ? (
            <PrDraftEditor key={pr.id} ref={editor} pr={pr} onReload={() => q.refetch()} />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-4 py-3 shadow-panel">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(badgeCounts).map(([b, n]) => (
                    <span key={b} className="inline-flex items-center gap-1" title={LINE_BADGE_LABELS[b]}>
                      <LineBadge badge={b} />
                      <span className="text-xs font-semibold tabular">×{n}</span>
                    </span>
                  ))}
                </div>
                <PRLineProgressLegend />
              </div>
              {s === 'SPLIT' && <Callout tone="info">Lignes d’origine : l’avancement est suivi sur chaque sous-PR.</Callout>}
              {missingLines.length > 0 && ['PARTIALLY_RECEIVED', 'RECEIVED'].includes(s) && (
                <Callout tone="warn" title={`${missingLines.length} ligne(s) non entièrement reçue(s)`}>
                  Lignes {missingLines.map((l) => l.lineNo).join(', ')} : la PR se clôture automatiquement quand tout ce qui figure sur les BC est reçu.
                  {toOrderLines.length > 0 && ' Une quantité reste à commander : BC complémentaire, ou Counter-PR si elle n’est plus nécessaire.'}
                </Callout>
              )}
              <ul className="space-y-2">
                {pr.lines.map((l) => (
                  <LineCard key={l.id} line={l} />
                ))}
              </ul>
              {!pr.lines.length && <p className="text-sm text-ink-muted">Aucune ligne.</p>}
            </div>
          )}
        </TabsContent>

        <TabsContent value="revisions">
          <PrRevisionsTab
            pr={pr}
            onChanged={() => q.refetch()}
            startOpen={get('counter') === '1' && canCounter}
            onFormClosed={() => set({ counter: null })}
            onApplied={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            nextStep={
              countered && decide ? (
                <NextStep
                  tone="action"
                  title={`Counter-PR n°${pr.currentRevisionNo} appliquée — prochaine étape`}
                  text="Validez la PR modifiée (vous créerez ensuite le BC) ou divisez-la en sous-PR, une par fournisseur."
                >
                  <Button onClick={() => setDialog('approve')} disabled={!!intermediate}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Valider et continuer
                  </Button>
                  {canSplit && (
                    <Button variant="secondary" onClick={() => setSplitOpen(true)}>
                      <Split className="h-4 w-4" aria-hidden /> Diviser
                    </Button>
                  )}
                </NextStep>
              ) : undefined
            }
          />
        </TabsContent>
        <TabsContent value="discussion">
          <PrCommentsThread pr={pr} />
        </TabsContent>
        <TabsContent value="links">
          <PrLinkedDocuments pr={pr} />
        </TabsContent>
        <TabsContent value="files">
          <Panel title="Pièces jointes">
            <AttachmentsPanel
              path={`/purchase-requests/${pr.id}/attachments`}
              vesselId={pr.vesselId}
              attachments={pr.attachments}
              canManage={canAny('pr.create', 'pr.edit', 'pr.revise', 'pr.approve')}
              onChanged={() => q.refetch()}
              hint="photos, plaques signalétiques, fiches techniques (PDF, images, Excel, Word)"
            />
          </Panel>
          {pr.parent && pr.parentAttachments.length > 0 && (
            <Panel title={`Pièces jointes de la PR ${pr.parent.number}`} className="mt-4">
              <AttachmentsPanel path={`/purchase-requests/${pr.parent.id}/attachments`} vesselId={pr.vesselId} attachments={pr.parentAttachments} canManage={false} onChanged={() => q.refetch()} />
            </Panel>
          )}
        </TabsContent>
        <TabsContent value="circuit">
          <CircuitPanel pr={pr} />
        </TabsContent>
        <TabsContent value="history">
          <Panel title="Chronologie">
            <HistoryList path={`/purchase-requests/${pr.id}/history`} queryKey={purKeys.pr(pr.id)} />
          </Panel>
        </TabsContent>
      </Tabs>

      {/* ----------------------------------------------------------- dialogues de workflow */}
      <TextActionDialog
        open={dialog === 'submit'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Soumettre la PR ${pr.number}`}
        description="Le brouillon est enregistré puis transmis aux Achats : les lignes deviennent immuables (toute modification passera par une Counter-PR des Achats)."
        label="Message pour les Achats"
        confirmLabel="Soumettre"
        onConfirm={async (comment) => {
          let version = v;
          if (editor.current) {
            const flushed = await editor.current.flush();
            if (flushed === null) throw new Error('Le brouillon n’a pas pu être enregistré : corrigez la saisie (ou rechargez en cas de conflit) avant de soumettre.');
            if (!editor.current.validLineCount()) throw new Error('Une PR doit comporter au moins une ligne pour être soumise.');
            version = flushed;
          }
          await post('submit', { expectedVersion: version, comment: comment || undefined }, `PR ${pr.number} soumise`);
        }}
      />
      <TextActionDialog
        open={dialog === 'discard'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Abandonner le brouillon"
        label="Motif"
        required
        tone="danger"
        confirmLabel="Abandonner"
        onConfirm={(reason) => post('cancel', { expectedVersion: v, reason }, 'Brouillon abandonné')}
      />
      <TextActionDialog
        open={dialog === 'startReview'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Mettre la PR ${pr.number} en discussion`}
        description="Le demandeur est prévenu que les Achats étudient sa demande. Vous déciderez ensuite : continuer, Counter-PR ou division."
        label="Message au demandeur"
        confirmLabel="Mettre en discussion"
        onConfirm={(comment) => post('start-review', { expectedVersion: v, comment: comment || undefined }, 'PR en discussion')}
      />
      <TextActionDialog
        open={dialog === 'endorse'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Viser : ${intermediate?.label ?? ''}`}
        description="Visa d’une étape intermédiaire du circuit appliqué ; la décision des Achats reste nécessaire ensuite."
        confirmLabel="Viser"
        onConfirm={(comment) => post('endorse', { expectedVersion: v, comment: comment || undefined }, 'Visa enregistré')}
      />
      <TextActionDialog
        open={dialog === 'approve'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={countered ? `Valider la PR modifiée ${pr.number}` : `Continuer avec la PR ${pr.number}`}
        description={
          countered
            ? 'La PR est validée avec les quantités de la Counter-PR ; elles deviennent la référence du bon de commande. Le demandeur est notifié.'
            : 'La PR est validée telle quelle ; ses quantités deviennent la référence du bon de commande. Le demandeur est notifié.'
        }
        label="Message au demandeur"
        confirmLabel="Valider et continuer"
        onConfirm={(comment) => post('approve', { expectedVersion: v, comment: comment || undefined }, `PR ${pr.number} validée`)}
      />
      <TextActionDialog
        open={dialog === 'reject'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Rejeter la PR ${pr.number}`}
        label="Motif du rejet (visible du demandeur)"
        required
        tone="danger"
        confirmLabel="Rejeter"
        onConfirm={(comment) => post('reject', { expectedVersion: v, comment }, 'PR rejetée')}
      />
      <TextActionDialog
        open={dialog === 'hold'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Mettre la PR en attente"
        label="Motif"
        required
        confirmLabel="Mettre en attente"
        onConfirm={(reason) => post('hold', { expectedVersion: v, reason }, 'PR mise en attente')}
      />
      <TextActionDialog
        open={dialog === 'resume'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Reprendre la PR"
        confirmLabel="Reprendre"
        onConfirm={(comment) => post('resume', { expectedVersion: v, comment: comment || undefined }, 'PR reprise')}
      />
      <TextActionDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Annuler la PR ${pr.number}`}
        description="Impossible si des bons de commande actifs sont liés : annulez ou révisez d’abord les BC."
        label="Motif d’annulation"
        required
        tone="danger"
        confirmLabel="Annuler la PR"
        onConfirm={(reason) => post('cancel', { expectedVersion: v, reason }, 'PR annulée')}
      />
      <TextActionDialog
        open={dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Clôturer la PR ${pr.number}`}
        description={
          s === 'RECEIVED'
            ? 'Toutes les lignes sont reçues.'
            : splitDone
              ? 'Toutes les sous-PR sont clôturées, annulées ou rejetées.'
              : 'La PR n’est pas entièrement reçue : la clôture manuelle est une décision documentée, les reliquats non reçus ne seront plus suivis.'
        }
        label="Motif / décision"
        required={s !== 'RECEIVED' && !splitDone}
        confirmLabel="Clôturer"
        onConfirm={(reason) => post('close', { expectedVersion: v, reason: reason || undefined }, 'PR clôturée')}
      />
      {poOpen && <ManualPoDialog open={poOpen} onOpenChange={setPoOpen} initialPrId={pr.id} initialVesselId={pr.vesselId} />}
      {splitOpen && <PrSplitDialog pr={pr} open={splitOpen} onOpenChange={setSplitOpen} onDone={() => q.refetch()} />}
    </>
  );
}

/** Bandeau « prochaine étape » : qui agit maintenant, et l'action attendue. */
function NextStep({ title, text, tone = 'neutral', children }: { title: string; text: ReactNode; tone?: 'action' | 'neutral'; children?: ReactNode }) {
  return (
    <section
      aria-label={title}
      className={
        tone === 'action'
          ? 'mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-action-100 border-l-[3px] border-l-action bg-white px-4 py-3 shadow-panel'
          : 'mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3'
      }
    >
      <div className="min-w-0 max-w-2xl">
        <p className="text-sm font-semibold text-navy">{title}</p>
        <p className="text-sm text-ink-muted">{text}</p>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </section>
  );
}

function DecisionChoice({ icon, title, text, action, highlight = false }: { icon: ReactNode; title: string; text: string; action: ReactNode; highlight?: boolean }) {
  return (
    <div className={highlight ? 'flex flex-col gap-2 border-l-[3px] border-l-ok bg-ok-bg/50 px-4 py-3' : 'flex flex-col gap-2 bg-white px-4 py-3'}>
      <p className="flex items-center gap-2 text-sm font-semibold text-navy">
        {icon}
        {title}
      </p>
      <p className="flex-1 text-sm text-ink-muted">{text}</p>
      <div>{action}</div>
    </div>
  );
}

function LineCard({ line }: { line: PrLine }) {
  return (
    <li className="grid gap-3 rounded-lg bg-white p-3 shadow-panel lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-navy">
          <span className="mr-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-navy-50 px-1 text-xs tabular">{line.lineNo}</span>
          {line.designation}
        </p>
        <dl className="mt-1 space-y-0.5 text-xs text-ink-muted">
          {line.reference && (
            <div>
              <dt className="inline">Réf. </dt>
              <dd className="inline text-ink">{line.reference}</dd>
            </div>
          )}
          {line.rob && (
            <div>
              <dt className="inline">ROB (à bord) : </dt>
              <dd className="inline text-ink">{line.rob}</dd>
            </div>
          )}
          {line.remarks && <div className="italic">{line.remarks}</div>}
        </dl>
        <div className="mt-1 flex flex-wrap gap-1">
          {line.addedByRevisionId && <Badge tone="info">Ajoutée par Counter-PR</Badge>}
          {line.status === 'CANCELLED' && (
            <Badge tone="neutral" icon={<CircleDashed className="h-3.5 w-3.5" aria-hidden />}>
              Ligne annulée
            </Badge>
          )}
          {line.quantityApproved !== null && line.quantityApproved !== line.quantityRequested && (
            <Badge tone="warn" icon={<Undo2 className="h-3.5 w-3.5" aria-hidden />}>
              Qté modifiée (Counter-PR)
            </Badge>
          )}
        </div>
      </div>
      {line.progress ? <PRLineProgress progress={line.progress} unit={line.unit} showOrders /> : <p className="text-sm text-ink-muted">Avancement indisponible.</p>}
    </li>
  );
}

function CircuitPanel({ pr }: { pr: PrDetail }) {
  const c = pr.reviewCircuit;
  if (!c) {
    return (
      <Panel title="Circuit de revue">
        <p className="text-sm text-ink-muted">Le circuit applicable est déterminé et figé au moment de la soumission (règles paramétrables par les Achats).</p>
      </Panel>
    );
  }
  return (
    <Panel title={`Circuit appliqué : ${c.label}`}>
      <p className="mb-3 text-sm text-ink-muted">
        Règle {c.ruleId} évaluée le {fmtDateTime(c.evaluatedAt)} (demandeur : {c.facts.requesterRoles.join(', ') || '—'}, catégorie « {c.facts.category} »).{' '}
        {c.captainApprovalRequired ? 'Ce circuit exige un visa du Captain.' : 'Aucun visa Captain n’est requis par ce circuit.'}
      </p>
      <ol className="space-y-2">
        {c.steps.map((st, i) => (
          <li key={st.key} className="flex items-start gap-3 rounded-md border border-line px-3 py-2">
            <span className="mt-0.5">
              {st.status === 'DONE' ? <CheckCircle2 className="h-5 w-5 text-ok" aria-hidden /> : <CircleDashed className="h-5 w-5 text-warn" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                Étape {i + 1} — {st.label}{' '}
                <span className={st.status === 'DONE' ? 'text-ok' : 'text-warn'}>({st.status === 'DONE' ? 'faite' : 'en attente'})</span>
              </p>
              <p className="text-xs text-ink-muted">
                Permission {st.permission}
                {st.roleKeys?.length ? ` · rôles : ${st.roleKeys.join(', ')}` : ''}
                {st.actorName ? ` · ${st.actorName}, ${fmtDateTime(st.at)}` : ''}
              </p>
              {st.comment && <p className="mt-0.5 text-xs italic text-ink-muted">« {st.comment} »</p>}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-muted">
        Séparation des rôles : le demandeur ne peut jamais valider sa propre PR.
        {pr.status !== 'DRAFT' && (
          <>
            {' '}
            <Link href="/purchasing/settings" className="text-action hover:underline">
              Paramétrage des circuits
            </Link>
          </>
        )}
      </p>
    </Panel>
  );
}
