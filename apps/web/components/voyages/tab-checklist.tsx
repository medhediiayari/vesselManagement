'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Paperclip, Pencil, Plus, RotateCcw, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { FormError, SelectField, StoredFileRow, StoredText, TextAreaField, TextInputField, UtcDateTimeField } from './common';
import { TASK_CATEGORY_SUGGESTIONS, fmtUtc, fromUtcInput, nn, toUtcInput, useOp, voyageKeys } from './lib';
import { TaskStatusBadge } from './status';
import type { TaskRow, VoyageWorkspace } from './types';

function TaskDialog({ open, onOpenChange, ws, task }: { open: boolean; onOpenChange: (o: boolean) => void; ws: VoyageWorkspace; task: TaskRow | null }) {
  const id = ws.overview.id;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('CHECKLIST');
  const [portId, setPortId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setTitle(task?.title ?? '');
      setDescription(task?.description ?? '');
      setCategory(task?.category ?? 'CHECKLIST');
      setPortId(task?.portId ?? '');
      setDueAt(toUtcInput(task?.dueAt));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const catOk = /^[A-Za-z0-9_]{2,40}$/.test(category.trim());
  const save = useOp(
    () => {
      const body = { title: title.trim(), description: nn(description), category: category.trim().toUpperCase(), portId: portId || null, dueAt: fromUtcInput(dueAt) };
      return task ? api.patch(`/voyages/${id}/tasks/${task.id}`, body) : api.post(`/voyages/${id}/tasks`, body);
    },
    {
      success: task ? 'Tâche mise à jour' : 'Tâche ajoutée',
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
      title={task ? 'Modifier la tâche' : 'Nouvelle tâche de checklist'}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={title.trim().length < 2 || !catOk}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <datalist id="task-categories">
        {TASK_CATEGORY_SUGGESTIONS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="space-y-3">
        <TextInputField label="Titre" required value={title} onChange={setTitle} maxLength={300} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField label="Catégorie" value={category} onChange={setCategory} list="task-categories" maxLength={40} error={catOk ? undefined : '2 à 40 caractères A-Z 0-9 _'} />
          <SelectField label="Escale" value={portId} onChange={setPortId} placeholder="Tout le voyage" options={ws.ports.map((p) => ({ value: p.id, label: `${p.sequence}. ${p.portName}` }))} />
          <UtcDateTimeField label="Échéance" value={dueAt} onChange={setDueAt} className="sm:col-span-2" />
        </div>
        <TextAreaField label="Description" value={description} onChange={setDescription} rows={3} maxLength={5000} />
      </div>
    </Dialog>
  );
}

function CompleteDialog({ ws, task, onOpenChange }: { ws: VoyageWorkspace; task: TaskRow | null; onOpenChange: (o: boolean) => void }) {
  const id = ws.overview.id;
  const [comment, setComment] = useState('');
  const [evidence, setEvidence] = useState<StoredFileDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (task) {
      setComment('');
      setEvidence(null);
      setError(null);
    }
  }, [task]);
  const done = useOp(
    () => api.post(`/voyages/${id}/tasks/${task!.id}/complete`, { comment: nn(comment) ?? undefined, evidenceFileId: evidence?.id }),
    {
      success: 'Tâche marquée réalisée',
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
      open={!!task}
      onOpenChange={onOpenChange}
      title={`Réaliser : ${task?.title ?? ''}`}
      description="Commentaire et preuve (photo, PDF) facultatifs, conservés avec la tâche."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => done.mutate(undefined)} loading={done.isPending}>
            <CheckSquare className="h-4 w-4" aria-hidden /> Marquer réalisée
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <TextAreaField label="Commentaire" value={comment} onChange={setComment} rows={3} maxLength={2000} />
        <div>
          <p className="field-label">Preuve (facultatif)</p>
          <FileUploader context="VOYAGE" vesselId={ws.overview.vesselId} label="Déposer une preuve" onUploaded={setEvidence} />
        </div>
      </div>
    </Dialog>
  );
}

export function ChecklistTab({ ws }: { ws: VoyageWorkspace }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const id = ws.overview.id;
  const canEdit = ws.permissions.edit;
  const q = useQuery({ queryKey: voyageKeys.sub(id, 'tasks'), queryFn: () => api.get<TaskRow[]>(`/voyages/${id}/tasks`) });
  const [dialog, setDialog] = useState<{ task: TaskRow | null } | null>(null);
  const [complete, setComplete] = useState<TaskRow | null>(null);
  const [reason, setReason] = useState<{ task: TaskRow; action: 'reopen' | 'cancel' } | null>(null);
  const [hideClosed, setHideClosed] = useState(false);

  const tasks = (q.data ?? []).filter((t) => !hideClosed || t.status === 'OPEN');
  const groups = [
    { key: 'voyage', label: 'Tout le voyage', tasks: tasks.filter((t) => !t.portId) },
    ...ws.ports.map((p) => ({ key: p.id, label: `Escale ${p.sequence} — ${p.portName}`, tasks: tasks.filter((t) => t.portId === p.id) })),
  ].filter((g) => g.tasks.length > 0);
  const total = q.data?.length ?? 0;
  const doneCount = q.data?.filter((t) => t.status === 'DONE').length ?? 0;
  const now = Date.now();

  return (
    <Panel
      title="Checklist et tâches"
      actions={
        <>
          <label className="flex items-center gap-1.5 text-sm text-ink-muted">
            <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} className="h-4 w-4 rounded border-line-strong" />
            Masquer les tâches closes
          </label>
          {canEdit && (
            <Button size="sm" onClick={() => setDialog({ task: null })}>
              <Plus className="h-4 w-4" aria-hidden /> Ajouter
            </Button>
          )}
        </>
      }
      bodyClassName="p-0"
    >
      {q.isLoading && <LoadingBlock rows={4} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <>
          <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm text-ink-muted">
            <span className="tabular">
              {doneCount} / {total} réalisée(s)
            </span>
            <div className="h-1.5 max-w-xs flex-1 overflow-hidden rounded-full bg-navy-50" role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={total} aria-label="Avancement de la checklist">
              <div className="h-full bg-teal" style={{ width: total ? `${(doneCount / total) * 100}%` : '0%' }} />
            </div>
          </div>
          {groups.length === 0 && <EmptyState title="Aucune tâche" description="Les tâches peuvent être créées depuis la Master checklist des instructions émises." />}
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h3 className="bg-canvas px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">{g.label}</h3>
              <ul className="divide-y divide-line">
                {g.tasks.map((t) => {
                  const late = t.status === 'OPEN' && t.dueAt && new Date(t.dueAt).getTime() < now;
                  return (
                    <li key={t.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-medium ${t.status === 'CANCELLED' ? 'text-ink-soft line-through' : 'text-navy'}`}>{t.title}</span>
                          <TaskStatusBadge status={t.status} />
                          <Badge tone="neutral" icon={false}>
                            {t.category}
                          </Badge>
                          {late && <Badge tone="danger">En retard</Badge>}
                        </div>
                        {t.description && <StoredText className="mt-1 text-ink-muted">{t.description}</StoredText>}
                        <p className="mt-1 text-xs text-ink-muted">
                          {t.dueAt ? `Échéance ${fmtUtc(t.dueAt)}` : 'Sans échéance'}
                          {t.assignee ? ` · Responsable : ${t.assignee}` : ''}
                          {t.completedAt && ` · Réalisée le ${fmtDateTime(t.completedAt)} par ${t.completedBy ?? '—'}`}
                        </p>
                        {t.comment && <p className="mt-1 rounded-md bg-canvas px-2 py-1 text-sm">{t.comment}</p>}
                        {t.evidenceFileId && (
                          <div className="mt-2 max-w-lg">
                            <p className="mb-1 flex items-center gap-1 text-xs text-ink-muted">
                              <Paperclip className="h-3.5 w-3.5" aria-hidden /> Preuve
                            </p>
                            <StoredFileRow fileId={t.evidenceFileId} />
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-1">
                        {t.status === 'OPEN' && t.canComplete && (
                          <Button size="sm" onClick={() => setComplete(t)}>
                            <CheckSquare className="h-4 w-4" aria-hidden /> Réaliser
                          </Button>
                        )}
                        {canEdit && t.status === 'OPEN' && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ task: t })}>
                              <Pencil className="h-4 w-4" aria-hidden /> Modifier
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setReason({ task: t, action: 'cancel' })}>
                              <XCircle className="h-4 w-4" aria-hidden /> Annuler
                            </Button>
                          </>
                        )}
                        {canEdit && t.status === 'DONE' && can('voyages.edit') && (
                          <Button size="sm" variant="ghost" onClick={() => setReason({ task: t, action: 'reopen' })}>
                            <RotateCcw className="h-4 w-4" aria-hidden /> Rouvrir
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
      <TaskDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} ws={ws} task={dialog?.task ?? null} />
      <CompleteDialog ws={ws} task={complete} onOpenChange={(o) => !o && setComplete(null)} />
      <ConfirmDialog
        open={!!reason}
        onOpenChange={(o) => !o && setReason(null)}
        title={reason?.action === 'reopen' ? `Rouvrir « ${reason.task.title} »` : `Annuler « ${reason?.task.title ?? ''} »`}
        confirmLabel={reason?.action === 'reopen' ? 'Rouvrir' : 'Annuler la tâche'}
        tone={reason?.action === 'cancel' ? 'danger' : 'primary'}
        requireReason
        onConfirm={async (r) => {
          if (!reason) return;
          await api.post(`/voyages/${id}/tasks/${reason.task.id}/${reason.action}`, { reason: r });
          await qc.invalidateQueries({ queryKey: voyageKeys.ws(id) });
        }}
      />
    </Panel>
  );
}
