'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, CheckCircle2, Navigation, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { FormError, Notice } from './common';
import { CP_STATUS_LABELS, voyageKeys } from './lib';
import { useLinkableCps } from './voyage-form';
import type { VoyageBase, VoyageStatus, VoyageWorkspace } from './types';
import { createdBySentence } from '@/components/amc/created-by';

type Command = 'plan' | 'activate' | 'complete' | 'cancel';

const COMMANDS: Record<Command, { to: VoyageStatus; label: string; title: string; done: string; perm: 'activate' | 'close'; icon: typeof Navigation }> = {
  plan: { to: 'PLANNED', label: 'Planifier', title: 'Planifier le voyage', done: 'Voyage planifié', perm: 'activate', icon: CalendarCheck2 },
  activate: { to: 'ACTIVE', label: 'Activer', title: 'Activer le voyage', done: 'Voyage activé', perm: 'activate', icon: Navigation },
  complete: { to: 'COMPLETED', label: 'Clôturer', title: 'Clôturer le voyage', done: 'Voyage clôturé', perm: 'close', icon: CheckCircle2 },
  cancel: { to: 'CANCELLED', label: 'Annuler le voyage', title: 'Annuler le voyage', done: 'Voyage annulé', perm: 'close', icon: XCircle },
};

interface Candidate {
  id: string;
  reference: string;
  status: string;
}

function candidatesOf(e: unknown): Candidate[] | null {
  if (!(e instanceof ApiError) || e.status !== 422 || !e.details || typeof e.details !== 'object') return null;
  const c = (e.details as { candidates?: Candidate[] }).candidates;
  return Array.isArray(c) ? c : null;
}

/**
 * Commandes d'état du voyage (DRAFT → PLANNED → ACTIVE → COMPLETED ; DRAFT/PLANNED → CANCELLED).
 * Jamais de modification directe du statut : chaque commande passe par l'API avec expectedVersion.
 */
export function VoyageCommands({ ws }: { ws: VoyageWorkspace }) {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const v = ws.overview;
  const [cmd, setCmd] = useState<Command | null>(null);
  const [comment, setComment] = useState('');
  const [cpId, setCpId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const linkable = useLinkableCps(v.vesselId, v.id, cmd === 'plan' && can('charter_party.view') && !v.charterPartyId && !v.charterPartyRestricted);

  const allowed = (Object.keys(COMMANDS) as Command[]).filter((c) => {
    const def = COMMANDS[c];
    return ws.permissions.allowedTransitions.includes(def.to) && ws.permissions[def.perm];
  });
  if (!allowed.length) return null;

  const open = (c: Command) => {
    setCmd(c);
    setComment('');
    setCpId('');
    setError(null);
    setCandidates(null);
  };
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: voyageKeys.ws(v.id) });
    setCmd(null);
  };

  async function run() {
    if (!cmd) return;
    setBusy(true);
    setError(null);
    try {
      let expectedVersion = v.lockVersion;
      // Activation : la CP doit déjà être rattachée (PATCH) ; la planification l'accepte dans la commande
      if (cmd === 'activate' && cpId) {
        const patched = await api.patch<VoyageBase>(`/voyages/${v.id}`, { charterPartyId: cpId, expectedVersion });
        expectedVersion = patched.lockVersion;
      }
      const body: Record<string, unknown> = { expectedVersion };
      if (cmd === 'cancel') body.reason = comment.trim();
      else if (comment.trim()) body.comment = comment.trim();
      if (cmd === 'plan' && cpId) body.charterPartyId = cpId;
      const res = await api.post<VoyageBase & { closureWarnings?: { openTasks: number; pendingNotices: number; draftNoonReports: number } }>(
        `/voyages/${v.id}/${cmd}`,
        body,
      );
      const w = res.closureWarnings;
      if (w && (w.openTasks || w.pendingNotices || w.draftNoonReports)) {
        toast.warning('Voyage clôturé avec des éléments ouverts', {
          description: `${w.openTasks} tâche(s) ouverte(s), ${w.pendingNotices} notice(s) non envoyée(s), ${w.draftNoonReports} Noon Report(s) non soumis — tracés dans l'audit.`,
          duration: 10_000,
        });
      } else {
        toast.success(`${COMMANDS[cmd].done} — ${res.reference}`);
      }
      await Promise.all([qc.invalidateQueries({ queryKey: voyageKeys.ws(v.id) }), qc.invalidateQueries({ queryKey: voyageKeys.list })]);
      setCmd(null);
    } catch (e) {
      const c = candidatesOf(e);
      if (c) setCandidates(c);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const def = cmd ? COMMANDS[cmd] : null;
  const openTasks = ws.tasks.filter((t) => t.status === 'OPEN').length;
  const pendingNotices = ws.notices.filter((n) => ['PLANNED', 'DRAFTED', 'VALIDATED'].includes(n.status)).length;
  const draftNoon = (ws.noonReports?.byStatus.DRAFT ?? 0) + (ws.noonReports?.byStatus.CORRECTION_REQUESTED ?? 0);
  const conflictActive =
    error instanceof ApiError && error.code === 'CONFLICT' && error.details && typeof error.details === 'object'
      ? (error.details as { activeVoyageId?: string; activeVoyage?: string })
      : null;
  const cpOptions = candidates ?? (cmd === 'plan' ? linkable.items.map((c) => ({ id: c.id, reference: c.reference, status: c.status })) : []);
  const reasonMissing = cmd === 'cancel' && comment.trim().length < 3;
  const needsCpChoice = !!candidates?.length && !cpId;

  return (
    <>
      {allowed.map((c) => {
        const d = COMMANDS[c];
        const Icon = d.icon;
        return (
          <Button key={c} variant={c === 'cancel' ? 'secondary' : c === 'complete' ? 'navy' : 'primary'} onClick={() => open(c)}>
            <Icon className="h-4 w-4" aria-hidden /> {d.label}
          </Button>
        );
      })}
      <Dialog
        open={!!cmd}
        onOpenChange={(o) => !o && setCmd(null)}
        title={def ? `${def.title} ${v.reference}` : ''}
        description={def ? `Transition ${v.status} → ${def.to}. L’action est journalisée.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCmd(null)}>
              Fermer
            </Button>
            <Button variant={cmd === 'cancel' ? 'danger' : 'primary'} onClick={run} loading={busy} disabled={reasonMissing || needsCpChoice}>
              {def?.label}
              {cpId && candidates ? ' avec la CP choisie' : ''}
            </Button>
          </>
        }
      >
        <FormError error={error} onReload={reload} />
        {conflictActive?.activeVoyageId && (
          <p className="mb-3 text-sm">
            Voyage actif :{' '}
            <Link className="font-medium text-action hover:underline" href={`/voyages/${conflictActive.activeVoyageId}`}>
              {conflictActive.activeVoyage}
            </Link>
          </p>
        )}
        {candidates && candidates.length > 0 && (
          <Notice tone="warn" title="Charter Party à rattacher" className="mb-3">
            L’API a identifié {candidates.length} Charter Party candidate(s) pour ce voyage (même navire, même charterer ou laycan qui se recoupe).
            Choisissez celle qui s’applique{cmd === 'activate' ? ' : elle sera rattachée puis le voyage activé.' : '.'}
          </Notice>
        )}
        {cmd === 'complete' && (openTasks > 0 || pendingNotices > 0 || draftNoon > 0) && (
          <Notice tone="warn" title="Éléments encore ouverts" className="mb-3">
            {openTasks} tâche(s) de checklist ouverte(s), {pendingNotices} notice(s) non envoyée(s), {draftNoon} Noon Report(s) non soumis. La
            clôture reste possible ; ces éléments seront tracés dans l’audit et le voyage passera en lecture seule.
          </Notice>
        )}
        {cmd === 'cancel' && (
          <Notice tone="warn" className="mb-3">
            Ce voyage a été {createdBySentence(v.createdBy, v.createdAt, 'créé')}
            {v.createdById !== me.id ? ' : vous n’en êtes pas l’auteur, prévenez-le avant d’annuler.' : '.'} Un voyage annulé passe en
            lecture seule ; aucun fichier ne peut plus y être ajouté.
          </Notice>
        )}
        {(cmd === 'plan' || candidates) && cpOptions.length > 0 && (
          <fieldset className="mb-3">
            <legend className="field-label">Charter Party {candidates ? '(obligatoire)' : '(facultatif)'}</legend>
            <div className="space-y-1.5">
              {!candidates && (
                <label className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <input type="radio" name="cp" checked={cpId === ''} onChange={() => setCpId('')} /> Ne pas rattacher maintenant
                </label>
              )}
              {cpOptions.map((c) => {
                const full = linkable.items.find((x) => x.id === c.id);
                return (
                  <label key={c.id} className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-canvas">
                    <input type="radio" name="cp" className="mt-1" checked={cpId === c.id} onChange={() => setCpId(c.id)} />
                    <span>
                      <span className="font-medium text-navy">{c.reference}</span> — {CP_STATUS_LABELS[c.status] ?? c.status}
                      {full && (
                        <span className="block text-xs text-ink-muted">
                          {full.charterer ?? 'Charterer non renseigné'} · laycan {fmtDate(full.laycanFrom)} → {fmtDate(full.laycanTo)}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {v.charterPartyRestricted && cmd === 'plan' && (
          <p className="mb-3 text-xs text-ink-muted">Une Charter Party confidentielle est rattachée à ce voyage.</p>
        )}
        <Field label={cmd === 'cancel' ? 'Motif d’annulation' : 'Commentaire'} required={cmd === 'cancel'} hint={cmd === 'cancel' ? 'Obligatoire — conservé dans le journal d’audit.' : 'Facultatif — repris dans la chronologie.'}>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} />
        </Field>
      </Dialog>
    </>
  );
}
