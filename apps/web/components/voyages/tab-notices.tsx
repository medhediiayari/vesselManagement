'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ClipboardCopy, Eye, FilePlus2, Mail, Pencil, Plus, Send, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import { DownloadButton, FilePreviewDialog } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { FormError, Notice, SelectField, StoredText, TextAreaField, TextInputField, UtcDateTimeField } from './common';
import { NOTICE_KIND_SUGGESTIONS, copyText, fmtUtc, fromUtcInput, nn, nowUtcInput, toUtcInput, useOp, voyageKeys } from './lib';
import { NoticeStatusBadge } from './status';
import type { NoticeEmail, NoticeRow, NorRow, VoyageWorkspace } from './types';

const STEPS = ['PLANNED', 'DRAFTED', 'VALIDATED', 'SENT'] as const;
const STEP_LABELS: Record<string, string> = { PLANNED: 'Planifiée', DRAFTED: 'Brouillon', VALIDATED: 'Validée', SENT: 'Envoyée (manuel)' };

function NoticeSteps({ status }: { status: string }) {
  if (status === 'CANCELLED') return null;
  // SENT : toutes les étapes sont accomplies
  const idx = status === 'SENT' ? STEPS.length : STEPS.indexOf(status as (typeof STEPS)[number]);
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Étapes de la notice">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-1">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
              i < idx ? 'bg-ok-bg text-ok' : i === idx ? 'bg-navy text-white' : 'bg-neutral-bg text-ink-muted',
            )}
            aria-current={i === idx ? 'step' : undefined}
          >
            {i < idx && <Check className="h-3 w-3" aria-hidden />}
            {STEP_LABELS[s]}
          </span>
          {i < STEPS.length - 1 && <span className="text-ink-soft" aria-hidden>›</span>}
        </li>
      ))}
    </ol>
  );
}

// -----------------------------------------------------------------------------
// Notice : création / modification
// -----------------------------------------------------------------------------

interface NoticeForm {
  kind: string;
  scheduleLabel: string;
  portId: string;
  dueAt: string;
  recipients: string;
  draftBody: string;
}
const noticeInit = (n?: NoticeRow | null): NoticeForm => ({
  kind: n?.kind ?? 'ETA_NOTICE',
  scheduleLabel: n?.scheduleLabel ?? '',
  portId: n?.portId ?? '',
  dueAt: toUtcInput(n?.dueAt),
  recipients: n?.recipients ?? '',
  draftBody: n?.draftBody ?? '',
});

function NoticeDialog({ open, onOpenChange, ws, notice }: { open: boolean; onOpenChange: (o: boolean) => void; ws: VoyageWorkspace; notice: NoticeRow | null }) {
  const id = ws.overview.id;
  const [f, setF] = useState<NoticeForm>(() => noticeInit(notice));
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setF(noticeInit(notice));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof NoticeForm) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const kindOk = /^[A-Za-z0-9_]{2,40}$/.test(f.kind.trim());
  const save = useOp(
    () => {
      const toBody = (x: NoticeForm) => ({
        kind: x.kind.trim().toUpperCase(),
        scheduleLabel: nn(x.scheduleLabel),
        portId: x.portId || null,
        dueAt: fromUtcInput(x.dueAt),
        recipients: nn(x.recipients),
        draftBody: nn(x.draftBody),
      });
      const body = toBody(f);
      if (!notice) return api.post(`/voyages/${id}/notices`, body);
      const before = toBody(noticeInit(notice));
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => before[k as keyof typeof before] !== v));
      return api.patch(`/voyages/${id}/notices/${notice.id}`, changed);
    },
    {
      success: notice ? 'Notice mise à jour' : 'Notice planifiée',
      invalidate: [voyageKeys.ws(id)],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={notice ? `Notice — ${notice.scheduleLabel ?? notice.kind}` : 'Planifier une notice'}
      description="Aucune notice n’est envoyée automatiquement : brouillon → validation humaine → envoi depuis votre messagerie → marquage manuel."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!kindOk}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      {notice?.status === 'VALIDATED' && (
        <Notice tone="warn" className="mb-3">
          Cette notice est validée : toute modification annule la validation (retour en brouillon).
        </Notice>
      )}
      <datalist id="notice-kinds">
        {NOTICE_KIND_SUGGESTIONS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField label="Type" required value={f.kind} onChange={set('kind')} list="notice-kinds" maxLength={40} error={kindOk ? undefined : '2 à 40 caractères A-Z 0-9 _'} />
          <TextInputField label="Libellé de l’échéance" value={f.scheduleLabel} onChange={set('scheduleLabel')} maxLength={120} placeholder="Ex. Arrival notice 5 jours avant Gabès" />
          <SelectField
            label="Escale"
            value={f.portId}
            onChange={set('portId')}
            placeholder="Voyage (sans escale précise)"
            options={ws.ports.map((p) => ({ value: p.id, label: `${p.sequence}. ${p.portName}` }))}
          />
          <UtcDateTimeField label="Échéance" value={f.dueAt} onChange={set('dueAt')} hint="Un rappel est envoyé dans l’application à l’approche de l’échéance." />
        </div>
        <TextInputField label="Destinataires" value={f.recipients} onChange={set('recipients')} maxLength={1000} hint="Requis pour valider. Ex. charterer, agent CHIMAG (adresses e-mail ou libellés)." />
        <TextAreaField
          label="Texte de la notice"
          value={f.draftBody}
          onChange={set('draftBody')}
          rows={10}
          maxLength={20000}
          hint="Laisser vide puis utiliser « Générer le brouillon » pour partir d’un modèle. Une 1re ligne « Subject: … » est reprise comme objet."
        />
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Brouillon d'e-mail + marquage envoyé
// -----------------------------------------------------------------------------

function EmailDialog({ voyageId, notice, onOpenChange }: { voyageId: string; notice: NoticeRow | null; onOpenChange: (o: boolean) => void }) {
  const q = useQuery({
    queryKey: voyageKeys.sub(voyageId, 'notice-email', notice?.id),
    queryFn: () => api.get<NoticeEmail>(`/voyages/${voyageId}/notices/${notice!.id}/email`),
    enabled: !!notice,
    gcTime: 0,
  });
  const all = q.data ? [q.data.to ? `To: ${q.data.to}` : '', q.data.subject ? `Subject: ${q.data.subject}` : '', '', q.data.body ?? ''].join('\n').trim() : '';
  return (
    <Dialog
      open={!!notice}
      onOpenChange={onOpenChange}
      size="lg"
      title="Brouillon d’e-mail à copier"
      description={notice?.scheduleLabel ?? notice?.kind}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
          <Button onClick={() => copyText(all, 'Brouillon copié dans le presse-papiers')} disabled={!q.data?.body}>
            <ClipboardCopy className="h-4 w-4" aria-hidden /> Tout copier
          </Button>
        </>
      }
    >
      {q.isLoading && <LoadingBlock rows={4} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-3">
          <Notice tone={q.data.validated ? 'info' : 'warn'} title={q.data.validated ? 'Brouillon validé' : 'Brouillon non validé'}>
            {q.data.notice}
          </Notice>
          {(
            [
              ['À', q.data.to],
              ['Objet', q.data.subject],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-start gap-2">
              <span className="w-14 shrink-0 pt-1.5 text-xs font-medium text-ink-muted">{label}</span>
              <p className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-3 py-1.5 text-sm">{value ?? <span className="text-ink-soft">—</span>}</p>
              {value && (
                <Button size="sm" variant="ghost" onClick={() => copyText(value, `${label} copié`)} aria-label={`Copier ${label}`}>
                  <ClipboardCopy className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          ))}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">Corps du message</span>
              {q.data.body && (
                <Button size="sm" variant="ghost" onClick={() => copyText(q.data!.body!, 'Corps copié')}>
                  <ClipboardCopy className="h-4 w-4" aria-hidden /> Copier le corps
                </Button>
              )}
            </div>
            {q.data.body ? (
              <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-canvas p-3 font-mono text-xs leading-5 text-ink">{q.data.body}</pre>
            ) : (
              <p className="text-sm text-ink-muted">Aucun texte : générez ou rédigez le brouillon.</p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function MarkSentDialog({ voyageId, notice, onOpenChange }: { voyageId: string; notice: NoticeRow | null; onOpenChange: (o: boolean) => void }) {
  const [sentAt, setSentAt] = useState(nowUtcInput());
  const [channel, setChannel] = useState('E-mail');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (notice) {
      setSentAt(nowUtcInput());
      setComment('');
      setError(null);
    }
  }, [notice]);
  const future = sentAt && new Date(`${sentAt}:00Z`).getTime() > Date.now() + 5 * 60_000;
  const mark = useOp(
    () => api.post(`/voyages/${voyageId}/notices/${notice!.id}/mark-sent`, { sentAt: fromUtcInput(sentAt) ?? undefined, channel: nn(channel) ?? undefined, comment: nn(comment) ?? undefined }),
    {
      success: 'Notice marquée envoyée',
      invalidate: [voyageKeys.ws(voyageId)],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  return (
    <Dialog
      open={!!notice}
      onOpenChange={onOpenChange}
      title="Marquer comme envoyé"
      description="Confirme un envoi effectué hors plateforme (la plateforme n’envoie rien elle-même)."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => mark.mutate(undefined)} loading={mark.isPending} disabled={!sentAt || !!future}>
            <Send className="h-4 w-4" aria-hidden /> Marquer comme envoyé
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <UtcDateTimeField label="Heure réelle d’envoi" value={sentAt} onChange={setSentAt} required error={future ? 'Date d’envoi dans le futur' : undefined} />
        <TextInputField label="Canal" value={channel} onChange={setChannel} maxLength={60} hint="Ex. E-mail, VHF, Inmarsat-C" />
        <TextAreaField label="Commentaire" value={comment} onChange={setComment} rows={2} maxLength={2000} />
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// NOR
// -----------------------------------------------------------------------------

function NorDialog({ open, onOpenChange, ws, nor }: { open: boolean; onOpenChange: (o: boolean) => void; ws: VoyageWorkspace; nor: NorRow | null }) {
  const id = ws.overview.id;
  const [portId, setPortId] = useState('');
  const [tenderedAt, setTenderedAt] = useState('');
  const [acceptedAt, setAcceptedAt] = useState('');
  const [acceptedBy, setAcceptedBy] = useState('');
  const [remarks, setRemarks] = useState('');
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setPortId(nor?.portId ?? ws.ports[0]?.id ?? '');
      setTenderedAt(toUtcInput(nor?.tenderedAt) || nowUtcInput());
      setAcceptedAt(toUtcInput(nor?.acceptedAt));
      setAcceptedBy(nor?.acceptedBy ?? '');
      setRemarks(nor?.remarks ?? '');
      setFile(null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const future = tenderedAt && new Date(`${tenderedAt}:00Z`).getTime() > Date.now() + 5 * 60_000;
  const acceptBefore = tenderedAt && acceptedAt && acceptedAt < tenderedAt;
  const save = useOp(
    () => {
      const common = {
        tenderedAt: fromUtcInput(tenderedAt),
        acceptedAt: fromUtcInput(acceptedAt),
        acceptedBy: nn(acceptedBy),
        remarks: nn(remarks),
        ...(file ? { fileId: file.id } : {}),
      };
      return nor ? api.patch(`/voyages/${id}/nor/${nor.id}`, common) : api.post(`/voyages/${id}/nor`, { portId, ...common });
    },
    {
      success: nor ? 'NOR mise à jour' : 'NOR enregistrée',
      invalidate: [voyageKeys.ws(id)],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={nor ? `NOR — ${nor.port?.portName ?? ''}` : 'Enregistrer une NOR'}
      description="Notice of Readiness : enregistrement des faits (remise, acceptation). Aucun calcul de laytime n’est effectué."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!portId || !tenderedAt || !!future || !!acceptBefore}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Escale"
            required
            value={portId}
            onChange={setPortId}
            disabled={!!nor}
            placeholder={ws.ports.length ? undefined : 'Aucune escale : ajoutez-en une'}
            options={ws.ports.map((p) => ({ value: p.id, label: `${p.sequence}. ${p.portName}` }))}
          />
          <UtcDateTimeField label="NOR remise (tendered)" value={tenderedAt} onChange={setTenderedAt} required error={future ? 'NOR remise dans le futur' : undefined} />
          <UtcDateTimeField label="NOR acceptée" value={acceptedAt} onChange={setAcceptedAt} error={acceptBefore ? 'Acceptation antérieure à la remise' : undefined} />
          <TextInputField label="Acceptée par" value={acceptedBy} onChange={setAcceptedBy} maxLength={200} />
        </div>
        <TextAreaField label="Remarques" value={remarks} onChange={setRemarks} rows={3} maxLength={5000} />
        {nor?.fileId ? (
          <p className="text-sm text-ink-muted">Un document est déjà joint à cette NOR.</p>
        ) : (
          <div>
            <p className="field-label">Document NOR signé (facultatif)</p>
            <FileUploader context="VOYAGE" vesselId={ws.overview.vesselId} label="Déposer la NOR" onUploaded={setFile} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function NorFile({ voyageId, nor }: { voyageId: string; nor: NorRow }) {
  const [open, setOpen] = useState(false);
  if (!nor.fileId) return <span className="text-ink-soft">—</span>;
  const base = `/voyages/${voyageId}/nor/${nor.id}/file`;
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Eye className="h-4 w-4" aria-hidden /> Aperçu
      </Button>
      <DownloadButton path={`${base}?mode=download`} size="sm" label="Télécharger" />
      <FilePreviewDialog open={open} onOpenChange={setOpen} title={`NOR — ${nor.port?.portName ?? ''}`} previewPath={`${base}?mode=preview`} downloadPath={`${base}?mode=download`} canDownload />
    </span>
  );
}

// -----------------------------------------------------------------------------
// Onglet
// -----------------------------------------------------------------------------

export function NoticesTab({ ws }: { ws: VoyageWorkspace }) {
  const id = ws.overview.id;
  const qc = useQueryClient();
  const { canAny } = useSession();
  const canEdit = ws.permissions.edit;
  const closed = ws.overview.status === 'COMPLETED' || ws.overview.status === 'CANCELLED';
  const canNor = !closed && canAny('voyages.edit', 'noon.submit');

  const notices = useQuery({ queryKey: voyageKeys.sub(id, 'notices'), queryFn: () => api.get<NoticeRow[]>(`/voyages/${id}/notices`) });
  const nors = useQuery({ queryKey: voyageKeys.sub(id, 'nor'), queryFn: () => api.get<NorRow[]>(`/voyages/${id}/nor`) });

  const [edit, setEdit] = useState<{ notice: NoticeRow | null } | null>(null);
  const [email, setEmail] = useState<NoticeRow | null>(null);
  const [sent, setSent] = useState<NoticeRow | null>(null);
  const [cancel, setCancel] = useState<NoticeRow | null>(null);
  const [regen, setRegen] = useState<NoticeRow | null>(null);
  const [norDialog, setNorDialog] = useState<{ nor: NorRow | null } | null>(null);

  const generate = useOp(
    ({ n, overwrite }: { n: NoticeRow; overwrite: boolean }) => api.post<{ generated: boolean }>(`/voyages/${id}/notices/${n.id}/draft`, { overwrite }),
    {
      success: (r) => (r.generated ? 'Brouillon généré — à relire avant validation' : 'Brouillon existant conservé'),
      invalidate: [voyageKeys.ws(id)],
      onSuccess: (_r, { n }) => setEmail(n),
    },
  );
  const validate = useOp((n: NoticeRow) => api.post(`/voyages/${id}/notices/${n.id}/validate`), {
    success: 'Notice validée : copiez le brouillon dans votre messagerie puis marquez-la envoyée',
    invalidate: [voyageKeys.ws(id)],
  });

  const rows = notices.data ?? ws.notices;
  const overdue = rows.filter((n) => n.overdue).length;

  return (
    <div className="space-y-5">
      <Panel
        title="Notices d’arrivée"
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setEdit({ notice: null })}>
              <Plus className="h-4 w-4" aria-hidden /> Planifier une notice
            </Button>
          )
        }
        bodyClassName="p-0"
      >
        <div className="border-b border-line px-4 py-2">
          <Notice>
            Aucune notice n’est envoyée automatiquement : générez ou rédigez le brouillon, faites-le valider, copiez-le dans votre messagerie puis
            cliquez « Marquer comme envoyé ».
          </Notice>
          {overdue > 0 && (
            <p className="mt-2 flex items-center gap-1 text-sm font-medium text-danger">
              <AlertTriangle className="h-4 w-4" aria-hidden /> {overdue} notice(s) en retard sur leur échéance.
            </p>
          )}
        </div>
        {notices.error && <ErrorState error={notices.error} onRetry={() => notices.refetch()} />}
        {rows.length === 0 ? (
          <EmptyState title="Aucune notice planifiée" description="Fixing, daily, 12 hours definite, arrival notices 5/4/3/2/1 jours…" />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((n) => {
              const active = n.status !== 'SENT' && n.status !== 'CANCELLED';
              return (
                <li key={n.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-navy">{n.scheduleLabel ?? n.kind.replace(/_/g, ' ')}</p>
                      <p className="text-xs text-ink-muted">
                        <span className="font-mono">{n.kind}</span>
                        {n.port ? ` · ${n.port.portName}` : ''} · échéance <span className="tabular">{fmtUtc(n.dueAt)}</span>
                        {n.recipients ? ` · à : ${n.recipients}` : ' · destinataires non renseignés'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {n.overdue && <Badge tone="danger">En retard</Badge>}
                      <NoticeStatusBadge status={n.status} />
                    </div>
                  </div>
                  <NoticeSteps status={n.status} />
                  {(n.validatedAt || n.sentAt) && (
                    <p className="text-xs text-ink-muted">
                      {n.validatedAt && `Validée le ${fmtUtc(n.validatedAt)} par ${n.validatedBy ?? '—'}`}
                      {n.sentAt && ` · marquée envoyée (${fmtUtc(n.sentAt)}) par ${n.sentBy ?? '—'}`}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => setEmail(n)} disabled={!n.draftBody}>
                      <Mail className="h-4 w-4" aria-hidden /> Brouillon e-mail
                    </Button>
                    {canEdit && active && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEdit({ notice: n })}>
                          <Pencil className="h-4 w-4" aria-hidden /> Modifier
                        </Button>
                        {n.status !== 'VALIDATED' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={generate.isPending && generate.variables?.n.id === n.id}
                            onClick={() => (n.draftBody ? setRegen(n) : generate.mutate({ n, overwrite: false }))}
                          >
                            <Sparkles className="h-4 w-4" aria-hidden /> {n.draftBody ? 'Régénérer' : 'Générer le brouillon'}
                          </Button>
                        )}
                        {n.status === 'DRAFTED' && (
                          <Button size="sm" onClick={() => validate.mutate(n)} loading={validate.isPending && validate.variables?.id === n.id}>
                            <ShieldCheck className="h-4 w-4" aria-hidden /> Valider
                          </Button>
                        )}
                        {n.status === 'VALIDATED' && (
                          <Button size="sm" onClick={() => setSent(n)}>
                            <Send className="h-4 w-4" aria-hidden /> Marquer comme envoyé
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setCancel(n)}>
                          <XCircle className="h-4 w-4" aria-hidden /> Annuler
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="NOR (Notice of Readiness)"
        actions={
          canNor && (
            <Button size="sm" variant="secondary" onClick={() => setNorDialog({ nor: null })} disabled={!ws.ports.length}>
              <FilePlus2 className="h-4 w-4" aria-hidden /> Enregistrer une NOR
            </Button>
          )
        }
        bodyClassName="p-0"
      >
        {nors.isLoading && <LoadingBlock rows={2} />}
        {nors.error && <ErrorState error={nors.error} onRetry={() => nors.refetch()} />}
        {nors.data && nors.data.length === 0 && (
          <EmptyState title="Aucune NOR enregistrée" description="Remise et acceptation de la NOR par escale, avec le document signé." />
        )}
        {nors.data && nors.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-amc">
              <caption className="sr-only">NOR du voyage</caption>
              <thead>
                <tr>
                  <th scope="col">Escale</th>
                  <th scope="col">Remise (tendered)</th>
                  <th scope="col">Acceptée</th>
                  <th scope="col" className="hidden lg:table-cell">
                    Remarques
                  </th>
                  <th scope="col">Document</th>
                  {canNor && <th scope="col" className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {nors.data.map((n) => (
                  <tr key={n.id}>
                    <td className="font-medium text-navy">{n.port?.portName ?? '—'}</td>
                    <td className="tabular">
                      {fmtUtc(n.tenderedAt)}
                      <span className="block text-xs text-ink-muted">par {n.createdBy ?? '—'}</span>
                    </td>
                    <td className="tabular">
                      {n.acceptedAt ? fmtUtc(n.acceptedAt) : <Badge tone="warn">Non acceptée</Badge>}
                      {n.acceptedBy && <span className="block text-xs text-ink-muted">par {n.acceptedBy}</span>}
                    </td>
                    <td className="hidden max-w-xs lg:table-cell">
                      <StoredText className="text-xs">{n.remarks}</StoredText>
                    </td>
                    <td>
                      <NorFile voyageId={id} nor={n} />
                    </td>
                    {canNor && (
                      <td className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setNorDialog({ nor: n })}>
                          <Pencil className="h-4 w-4" aria-hidden /> Compléter
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <NoticeDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} ws={ws} notice={edit?.notice ?? null} />
      <EmailDialog voyageId={id} notice={email} onOpenChange={(o) => !o && setEmail(null)} />
      <MarkSentDialog voyageId={id} notice={sent} onOpenChange={(o) => !o && setSent(null)} />
      <NorDialog open={!!norDialog} onOpenChange={(o) => !o && setNorDialog(null)} ws={ws} nor={norDialog?.nor ?? null} />
      <ConfirmDialog
        open={!!regen}
        onOpenChange={(o) => !o && setRegen(null)}
        title="Remplacer le brouillon existant ?"
        description="Le texte actuel sera remplacé par un nouveau brouillon généré depuis les données du voyage (les données absentes apparaissent « TO BE CONFIRMED »)."
        confirmLabel="Régénérer"
        onConfirm={async () => {
          if (regen) await generate.mutateAsync({ n: regen, overwrite: true }).catch(() => undefined);
        }}
      />
      <ConfirmDialog
        open={!!cancel}
        onOpenChange={(o) => !o && setCancel(null)}
        title="Annuler la notice"
        confirmLabel="Annuler la notice"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          if (!cancel) return;
          await api.post(`/voyages/${id}/notices/${cancel.id}/cancel`, { reason });
          await qc.invalidateQueries({ queryKey: voyageKeys.ws(id) });
        }}
      />
    </div>
  );
}
