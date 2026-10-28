'use client';

import { RENEWAL_STATUS_LABELS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { Info, MessageSquarePlus, UserCheck } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea, TextField } from '@/components/ui/field';
import { DefinitionGrid } from '@/components/ui/page';
import { toDateInput } from './lib';
import type { PickOption } from './pickers';
import { RenewalBadge } from './status';
import type { CertificateDetail, RenewalStatus } from './types';

/**
 * Suivi opérationnel du renouvellement (ADM-048) : statut, responsable, échéance interne et
 * commentaires d'avancement. N'altère jamais la validité ni les rappels d'expiration (CERT-02).
 */
export function RenewalPanel({ certificate, onChanged }: { certificate: CertificateDetail; onChanged: () => void | Promise<void> }) {
  const { me } = useSession();
  const r = certificate.renewal;
  const editable = certificate.permissions.canManageRenewal;
  const [status, setStatus] = useState<RenewalStatus>(r.status);
  const [owner, setOwner] = useState<PickOption | null>(r.owner ? { id: r.owner.id, label: r.owner.displayName ?? 'Utilisateur' } : null);
  const [dueOn, setDueOn] = useState(toDateInput(r.dueOn));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const statusId = useId();
  const commentId = useId();
  const ownerId = useId();
  const candidates = useQuery({
    queryKey: ['certificate-renewal-owners', certificate.id],
    queryFn: () => api.get<{ id: string; displayName: string; jobTitle: string | null }[]>(`/certificates/${certificate.id}/renewal-owners`),
    enabled: editable,
    staleTime: 60_000,
  });

  const ownerKey = r.owner?.id ?? null;
  useEffect(() => {
    setStatus(r.status);
    setOwner(r.owner ? { id: r.owner.id, label: r.owner.displayName ?? 'Utilisateur' } : null);
    setDueOn(toDateInput(r.dueOn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.status, ownerKey, r.dueOn]);

  const dirty = status !== r.status || (owner?.id ?? null) !== (r.owner?.id ?? null) || (dueOn || null) !== (toDateInput(r.dueOn) || null);

  async function save() {
    setSaving(true);
    setErrors({});
    try {
      await api.put(`/certificates/${certificate.id}/renewal`, { status, ownerId: owner?.id ?? null, dueOn: dueOn || null });
      toast.success('Suivi du renouvellement mis à jour', { description: 'La validité et les rappels d’expiration sont inchangés.' });
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function addComment() {
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await api.post(`/certificates/${certificate.id}/comments`, { body: comment.trim() });
      setComment('');
      toast.success('Commentaire ajouté');
      await onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <RenewalBadge status={r.status} />
        {certificate.validity === 'EXPIRED' && r.status === 'IN_PROGRESS' && (
          <span className="text-xs text-danger">Le certificat reste expiré tant que le renouvellement n’est pas approuvé.</span>
        )}
      </div>
      <DefinitionGrid
        items={[
          ['Responsable', r.owner?.displayName ?? 'Non assigné'],
          ['Échéance interne', fmtDate(r.dueOn)],
          ['Suivi ouvert le', r.activeTask ? `${fmtDateTime(r.activeTask.createdAt)} par ${r.activeTask.createdBy?.displayName ?? '—'}` : '—'],
        ]}
      />
      <p className="flex items-start gap-1.5 text-xs text-ink-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        Le suivi du renouvellement est indépendant de la validité réelle : il ne masque jamais une expiration et n’interrompt aucun rappel.
      </p>

      {editable && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <h3 className="text-sm font-semibold text-navy">Mettre à jour le suivi</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Statut" htmlFor={statusId}>
              <Select id={statusId} value={status} onChange={(e) => setStatus(e.target.value as RenewalStatus)}>
                {(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] as RenewalStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {RENEWAL_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <TextField label="Échéance interne" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} error={errors.dueOn} />
          </div>
          <Field
            label="Responsable"
            htmlFor={ownerId}
            error={errors.ownerId}
            hint="Seuls les utilisateurs ayant réellement accès à ce certificat (permission et périmètre) sont proposés."
          >
            <Select
              id={ownerId}
              value={owner?.id ?? ''}
              onChange={(e) => {
                const u = candidates.data?.find((c) => c.id === e.target.value);
                setOwner(u ? { id: u.id, label: u.displayName } : null);
              }}
              disabled={candidates.isLoading}
            >
              <option value="">Non assigné</option>
              {owner && !candidates.data?.some((c) => c.id === owner.id) && <option value={owner.id}>{owner.label}</option>}
              {candidates.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                  {c.jobTitle ? ` — ${c.jobTitle}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            {owner?.id !== me.id && (
              <Button variant="ghost" size="sm" onClick={() => setOwner({ id: me.id, label: me.displayName })}>
                <UserCheck className="h-4 w-4" aria-hidden /> M’assigner
              </Button>
            )}
            {owner && (
              <Button variant="ghost" size="sm" onClick={() => setOwner(null)}>
                Retirer le responsable
              </Button>
            )}
            <Button size="sm" className="ml-auto" onClick={save} loading={saving} disabled={!dirty}>
              Enregistrer
            </Button>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-navy">Commentaires d’avancement</h3>
        {editable && (
          <div className="mb-3 space-y-2">
            <Field label="Nouveau commentaire" htmlFor={commentId}>
              <Textarea id={commentId} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} />
            </Field>
            <Button size="sm" variant="secondary" onClick={addComment} loading={posting} disabled={!comment.trim()}>
              <MessageSquarePlus className="h-4 w-4" aria-hidden /> Ajouter le commentaire
            </Button>
          </div>
        )}
        {certificate.comments.length === 0 ? (
          <p className="text-sm text-ink-muted">Aucun commentaire.</p>
        ) : (
          <ul className="space-y-2">
            {certificate.comments.map((c) => (
              <li key={c.id} className="rounded-md bg-canvas px-3 py-2">
                <p className="whitespace-pre-line text-sm text-ink">{c.body}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {c.author?.displayName ?? '—'} — {fmtDateTime(c.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {r.history.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-navy">Historique des suivis</h3>
          <ul className="space-y-1 text-sm">
            {r.history.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2">
                <RenewalBadge status={t.status} />
                <span className="text-xs text-ink-muted">
                  ouvert le {fmtDate(t.createdAt)} — responsable {t.owner?.displayName ?? 'non assigné'}
                  {t.dueOn ? ` — échéance ${fmtDate(t.dueOn)}` : ''}
                  {t.completedAt ? ` — terminé le ${fmtDate(t.completedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
