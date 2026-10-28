'use client';

import { useQuery } from '@tanstack/react-query';
import { BookOpenCheck, ChevronDown, ChevronRight, Eye, FilePlus2, Pencil, Send, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { DownloadButton, FilePreviewDialog } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { FormError, Notice, StoredText, TextAreaField, TextInputField } from './common';
import { nn, useOp, voyageKeys } from './lib';
import { InstructionStatusBadge } from './status';
import type { AcknowledgementList, InstructionFieldValue, InstructionRow, VoyageWorkspace } from './types';

const FIELD_LABELS: Record<string, string> = {
  masterChecklist: 'Master checklist',
  complianceChecks: 'Compliance checks',
  norLaytime: 'NOR / laytime (texte contractuel)',
  arrivalNotices: 'Arrival notices',
  cargo: 'Cargaison',
  route: 'Route',
};

function humanize(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Champs structurés affichés tels que stockés (listes, textes, booléens). */
function InstructionFields({ fields }: { fields: Record<string, InstructionFieldValue> | null }) {
  const entries = Object.entries(fields ?? {});
  if (!entries.length) return <p className="text-sm text-ink-muted">Aucun champ structuré.</p>;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-medium text-ink-muted">{humanize(k)}</dt>
          <dd className="mt-0.5 text-sm">
            {Array.isArray(v) ? (
              <ul className="list-disc space-y-0.5 pl-5">
                {v.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : typeof v === 'boolean' ? (
              v ? 'Oui' : 'Non'
            ) : v === null ? (
              '—'
            ) : (
              <StoredText>{String(v)}</StoredText>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// -----------------------------------------------------------------------------
// Création / modification d'une version (brouillon)
// -----------------------------------------------------------------------------

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

function InstructionDialog({
  open,
  onOpenChange,
  ws,
  instruction,
  base,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ws: VoyageWorkspace;
  /** Brouillon à modifier ; null = nouvelle version */
  instruction: InstructionRow | null;
  /** Version de référence pour pré-remplir une nouvelle version */
  base: InstructionRow | null;
}) {
  const src = instruction ?? base;
  const [title, setTitle] = useState('');
  const [notices, setNotices] = useState('');
  const [checklist, setChecklist] = useState('');
  const [compliance, setCompliance] = useState('');
  const [norLaytime, setNorLaytime] = useState('');
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open) return;
    const f = src?.fields ?? {};
    setTitle(src?.title ?? `Voyage Instructions — ${ws.overview.route ?? ws.overview.reference}`);
    setNotices(src?.notices ?? '');
    setChecklist(Array.isArray(f.masterChecklist) ? f.masterChecklist.join('\n') : '');
    setCompliance(Array.isArray(f.complianceChecks) ? f.complianceChecks.join('\n') : '');
    setNorLaytime(typeof f.norLaytime === 'string' ? f.norLaytime : '');
    setFile(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useOp(
    () => {
      // Les autres champs structurés existants sont conservés à l'identique
      const fields: Record<string, InstructionFieldValue> = { ...(src?.fields ?? {}) };
      const setOrDrop = (k: string, v: InstructionFieldValue) => {
        if (v === null || (Array.isArray(v) && !v.length)) delete fields[k];
        else fields[k] = v;
      };
      setOrDrop('masterChecklist', lines(checklist));
      setOrDrop('complianceChecks', lines(compliance));
      setOrDrop('norLaytime', nn(norLaytime));
      const body = { title: title.trim(), notices: nn(notices), fields, ...(file ? { fileId: file.id } : {}) };
      return instruction ? api.patch(`/voyage-instructions/${instruction.id}`, body) : api.post('/voyage-instructions', { voyageId: ws.overview.id, ...body });
    },
    {
      success: instruction ? 'Brouillon d’instructions mis à jour' : 'Nouvelle version créée en brouillon',
      invalidate: [voyageKeys.ws(ws.overview.id)],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  const nextNo = Math.max(0, ...ws.instructions.map((i) => i.versionNo)) + 1;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={instruction ? `Modifier le brouillon v${instruction.versionNo}` : `Nouvelle version d’instructions (v${nextNo})`}
      description="Brouillon invisible du bord tant qu’il n’est pas émis. À l’émission, la version précédente devient « remplacée »."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={title.trim().length < 3}>
            Enregistrer le brouillon
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <TextInputField label="Titre" required value={title} onChange={setTitle} maxLength={300} />
        <TextAreaField label="Notices (texte)" value={notices} onChange={setNotices} rows={3} maxLength={20000} hint="Ex. Fixing, daily, 12 hours definite ; 5/4/3/2/1 jours au load port." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Master checklist" hint="Un élément par ligne — peut générer les tâches de checklist à l’émission.">
            <Textarea rows={6} value={checklist} onChange={(e) => setChecklist(e.target.value)} />
          </Field>
          <Field label="Compliance checks" hint="Un élément par ligne (Class, P&I, ISM…).">
            <Textarea rows={6} value={compliance} onChange={(e) => setCompliance(e.target.value)} />
          </Field>
        </div>
        <TextAreaField label="NOR / laytime (texte contractuel)" value={norLaytime} onChange={setNorLaytime} rows={3} maxLength={5000} hint="Stocké tel quel : aucune règle n’est déduite." />
        {instruction?.fileId ? (
          <p className="text-sm text-ink-muted">Un document source est déjà joint à ce brouillon.</p>
        ) : (
          <div>
            <p className="field-label">Document source (PDF des instructions, facultatif)</p>
            <FileUploader context="VOYAGE" vesselId={ws.overview.vesselId} label="Déposer le document source" onUploaded={setFile} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function IssueDialog({ ws, instruction, onOpenChange }: { ws: VoyageWorkspace; instruction: InstructionRow | null; onOpenChange: (o: boolean) => void }) {
  const [generatePdf, setGeneratePdf] = useState(false);
  const [createTasks, setCreateTasks] = useState(false);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (instruction) {
      setGeneratePdf(!instruction.fileId);
      setCreateTasks(Array.isArray(instruction.fields?.masterChecklist) && instruction.fields!.masterChecklist.length > 0);
      setComment('');
    }
  }, [instruction]);
  const issue = useOp(
    () =>
      api.post<{ pdfGenerated: boolean; tasksCreated: number; superseded: { versionNo: number }[] }>(`/voyage-instructions/${instruction!.id}/issue`, {
        generatePdf,
        createChecklistTasks: createTasks,
        comment: nn(comment) ?? undefined,
      }),
    {
      success: (r) =>
        `Instructions émises${r.superseded.length ? ` (v${r.superseded.map((s) => s.versionNo).join(', ')} remplacée)` : ''}${r.pdfGenerated ? ' — PDF généré' : ''}${
          r.tasksCreated ? ` — ${r.tasksCreated} tâche(s) créée(s)` : ''
        }`,
      invalidate: [voyageKeys.ws(ws.overview.id)],
      onSuccess: () => onOpenChange(false),
    },
  );
  const hasChecklist = Array.isArray(instruction?.fields?.masterChecklist) && (instruction?.fields?.masterChecklist as string[]).length > 0;
  return (
    <Dialog
      open={!!instruction}
      onOpenChange={onOpenChange}
      title={`Émettre les instructions v${instruction?.versionNo ?? ''}`}
      description="Les Masters du navire sont notifiés et doivent accuser lecture. La version émise précédente devient « remplacée »."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => issue.mutate(undefined)} loading={issue.isPending}>
            <Send className="h-4 w-4" aria-hidden /> Émettre
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Checkbox
          label="Générer un PDF depuis les champs structurés"
          description={instruction?.fileId ? 'Un document source est déjà joint : il fait foi.' : 'Recommandé lorsqu’aucun document source n’est joint.'}
          checked={generatePdf}
          disabled={!!instruction?.fileId}
          onChange={(e) => setGeneratePdf(e.target.checked)}
        />
        <Checkbox
          label="Créer les tâches de checklist depuis la Master checklist"
          description={hasChecklist ? 'Sans doublon de titre avec les tâches existantes.' : 'Aucune Master checklist dans cette version.'}
          checked={createTasks}
          disabled={!hasChecklist}
          onChange={(e) => setCreateTasks(e.target.checked)}
        />
        <TextAreaField label="Commentaire" value={comment} onChange={setComment} rows={2} maxLength={2000} />
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Détail d'une version (dépliable)
// -----------------------------------------------------------------------------

function InstructionDetail({ instruction }: { instruction: InstructionRow }) {
  const acks = useQuery({
    queryKey: ['voyage-instruction', instruction.id, 'acks'],
    queryFn: () => api.get<AcknowledgementList>(`/voyage-instructions/${instruction.id}/acknowledgements`),
    enabled: instruction.status !== 'DRAFT',
  });
  return (
    <div className="space-y-4 border-t border-line bg-canvas/50 px-4 py-3">
      {instruction.notices && (
        <div>
          <p className="text-xs font-medium text-ink-muted">Notices</p>
          <StoredText>{instruction.notices}</StoredText>
        </div>
      )}
      <InstructionFields fields={instruction.fields} />
      {instruction.status !== 'DRAFT' && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-muted">
            <Users className="h-3.5 w-3.5" aria-hidden /> Accusés de lecture
          </p>
          {acks.isLoading && <LoadingBlock rows={1} />}
          {acks.error && <ErrorState error={acks.error} />}
          {acks.data && (
            <ul className="flex flex-wrap gap-1.5">
              {acks.data.acknowledgements.map((a) => (
                <li key={a.userId}>
                  <Badge tone="ok">
                    {a.displayName ?? a.userId} — {fmtDateTime(a.ackAt ?? a.acknowledgedAt)}
                  </Badge>
                </li>
              ))}
              {acks.data.pendingMasters.map((m) => (
                <li key={m.userId}>
                  <Badge tone="warn">{m.displayName ?? m.userId} — en attente</Badge>
                </li>
              ))}
              {!acks.data.acknowledgements.length && !acks.data.pendingMasters.length && <li className="text-sm text-ink-muted">Aucun Master attendu ni accusé enregistré.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function InstructionsTab({ ws }: { ws: VoyageWorkspace }) {
  const { can } = useSession();
  const id = ws.overview.id;
  const closed = ws.overview.status === 'COMPLETED' || ws.overview.status === 'CANCELLED';
  const manage = ws.permissions.manageInstructions && !closed;
  const [expanded, setExpanded] = useState<string | null>(ws.instructions.find((i) => i.status === 'ISSUED')?.id ?? null);
  const [dialog, setDialog] = useState<{ instruction: InstructionRow | null } | null>(null);
  const [issue, setIssue] = useState<InstructionRow | null>(null);
  const [preview, setPreview] = useState<InstructionRow | null>(null);
  const ack = useOp((i: InstructionRow) => api.post(`/voyage-instructions/${i.id}/acknowledge`), {
    success: 'Accusé de lecture enregistré',
    invalidate: [voyageKeys.ws(id), ['voyage-instruction']],
  });
  const latest = ws.instructions[0] ?? null;
  const hasDraft = ws.instructions.some((i) => i.status === 'DRAFT');

  return (
    <Panel
      title="Voyage Instructions"
      actions={
        manage &&
        !hasDraft && (
          <Button size="sm" onClick={() => setDialog({ instruction: null })}>
            <FilePlus2 className="h-4 w-4" aria-hidden /> Nouvelle version
          </Button>
        )
      }
      bodyClassName="p-0"
    >
      {ws.instructions.length === 0 ? (
        <EmptyState title="Aucune instruction émise" description="Les instructions de voyage versionnées (PDF source ou généré) apparaîtront ici avec leurs accusés de lecture." />
      ) : (
        <ul className="divide-y divide-line">
          {ws.instructions.map((i) => {
            const open = expanded === i.id;
            return (
              <li key={i.id}>
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : i.id)}
                  >
                    {open ? <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />}
                    <span className="rounded bg-navy-50 px-1.5 py-0.5 text-xs font-semibold tabular text-navy">v{i.versionNo}</span>
                    <span className="min-w-0 truncate font-medium text-navy">{i.title}</span>
                  </button>
                  <InstructionStatusBadge status={i.status} />
                  {i.status !== 'DRAFT' && (
                    <span className="text-xs text-ink-muted">
                      {i.issuedAt ? `Émise ${fmtDateTime(i.issuedAt)}` : ''} · {i.acknowledgements} accusé(s)
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    {i.fileId && (
                      <Button size="sm" variant="ghost" onClick={() => setPreview(i)}>
                        <Eye className="h-4 w-4" aria-hidden /> PDF
                      </Button>
                    )}
                    {i.fileId && <DownloadButton path={`/voyage-instructions/${i.id}/file?mode=download`} size="sm" label="Télécharger" />}
                    {i.status === 'ISSUED' &&
                      (i.acknowledgedByMe ? (
                        <Badge tone="ok">Lu le {fmtDateTime(i.acknowledgedByMe)}</Badge>
                      ) : (
                        can('noon.submit') && (
                          <Button size="sm" onClick={() => ack.mutate(i)} loading={ack.isPending}>
                            <BookOpenCheck className="h-4 w-4" aria-hidden /> Accuser lecture
                          </Button>
                        )
                      ))}
                    {manage && i.status === 'DRAFT' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ instruction: i })}>
                          <Pencil className="h-4 w-4" aria-hidden /> Modifier
                        </Button>
                        <Button size="sm" onClick={() => setIssue(i)}>
                          <Send className="h-4 w-4" aria-hidden /> Émettre
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {open && <InstructionDetail instruction={i} />}
              </li>
            );
          })}
        </ul>
      )}
      {!can('instructions.manage') && (
        <div className="border-t border-line px-4 py-2">
          <Notice>Seules les versions émises sont visibles. Le Master accuse lecture de la version en vigueur.</Notice>
        </div>
      )}
      <InstructionDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} ws={ws} instruction={dialog?.instruction ?? null} base={latest} />
      <IssueDialog ws={ws} instruction={issue} onOpenChange={(o) => !o && setIssue(null)} />
      {preview && (
        <FilePreviewDialog
          open={!!preview}
          onOpenChange={(o) => !o && setPreview(null)}
          title={`Voyage Instructions v${preview.versionNo}`}
          previewPath={`/voyage-instructions/${preview.id}/file?mode=preview`}
          downloadPath={`/voyage-instructions/${preview.id}/file?mode=download`}
          canDownload
        />
      )}
    </Panel>
  );
}
