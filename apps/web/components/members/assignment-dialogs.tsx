'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Anchor, CalendarPlus, LogOut, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { ApiError, api, errorMessage, type Page } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { MemberAvatar, MemberStatusBadge } from './member-ui';
import { useDebounced } from './use-debounced';
import { memberName, todayYmd, type CrewAssignmentDto, type MemberListItem, type Roster } from './types';

/** Requêtes à rafraîchir après toute transition d'affectation (fiche, roster, listes). */
export const CREW_QUERY_KEYS = [['member'], ['members'], ['vessel-roster'], ['member-self']];

function useInvalidateCrew() {
  const qc = useQueryClient();
  return () => Promise.all(CREW_QUERY_KEYS.map((k) => qc.invalidateQueries({ queryKey: k })));
}

function tomorrowYmd() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Erreurs de validation API -> message par champ. */
function apiFieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError ? e.fieldErrors : {};
}

// ---------------------------------------------------------------------------
// Sélection d'une fiche (planification depuis le roster)
// ---------------------------------------------------------------------------

export interface PickedMember {
  id: string;
  name: string;
  rank: string | null;
}

export function MemberPicker({ value, onChange }: { value: PickedMember | null; onChange: (m: PickedMember | null) => void }) {
  const id = useId();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const results = useQuery({
    queryKey: ['members', 'picker', q],
    queryFn: () => api.get<Page<MemberListItem>>('/members', { query: { search: q, limit: 8 } }),
    enabled: q.length >= 2 && !value,
  });
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line-strong bg-white px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{value.name}</span>
        {value.rank && <span className="hidden text-xs text-ink-muted sm:inline">{value.rank}</span>}
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Changer
        </Button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-soft" aria-hidden />
        <Input
          id={id}
          className="pl-8"
          placeholder="Nom, prénom, matricule, passeport…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Rechercher une fiche"
          autoComplete="off"
        />
      </div>
      {q.length >= 2 && (
        <ul className="mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-white" aria-label="Fiches trouvées">
          {results.isLoading && <li className="px-3 py-2 text-sm text-ink-muted">Recherche…</li>}
          {results.error ? <li className="px-3 py-2 text-sm text-danger">{errorMessage(results.error)}</li> : null}
          {results.data?.items.length === 0 && <li className="px-3 py-2 text-sm text-ink-muted">Aucune fiche visible ne correspond.</li>}
          {results.data?.items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-navy-50 disabled:opacity-50"
                disabled={m.status === 'INACTIVE'}
                onClick={() => onChange({ id: m.id, name: memberName(m), rank: m.rank })}
              >
                <MemberAvatar photoFileId={m.photoFileId} name={memberName(m)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{memberName(m)}</span>
                  <span className="block truncate text-xs text-ink-muted">{[m.amcRef, m.rank].filter(Boolean).join(' — ') || '—'}</span>
                </span>
                <MemberStatusBadge status={m.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Planification (PLANNED)
// ---------------------------------------------------------------------------

export function PlanAssignmentDialog({
  open,
  onOpenChange,
  member,
  vesselId: fixedVesselId,
  relieves,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Fiche imposée (onglet Embarquements) ; sinon sélection dans la boîte */
  member?: PickedMember | null;
  /** Navire imposé (roster) ; sinon choix parmi les navires du périmètre */
  vesselId?: string | null;
  /** Relève : affectation remplacée (même navire) */
  relieves?: { id: string; name: string; rank: string } | null;
}) {
  const { me } = useSession();
  const invalidate = useInvalidateCrew();
  const [picked, setPicked] = useState<PickedMember | null>(member ?? null);
  const [vesselId, setVesselId] = useState(fixedVesselId ?? '');
  const [form, setForm] = useState({ rank: '', position: '', plannedJoinDate: '', plannedSignOffDate: '', joinPort: '', notes: '', relievesAssignmentId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(member ?? null);
    setVesselId(fixedVesselId ?? '');
    setForm({
      rank: relieves?.rank ?? member?.rank ?? '',
      position: '',
      plannedJoinDate: '',
      plannedSignOffDate: '',
      joinPort: '',
      notes: '',
      relievesAssignmentId: relieves?.id ?? '',
    });
    setErrors({});
    // Réinitialisation à l'ouverture uniquement (les props objet sont recréées à chaque rendu parent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const vessels = me.accessibleVessels.filter((v) => v.status !== 'SOLD' && v.status !== 'INACTIVE');
  const roster = useQuery({
    queryKey: ['vessel-roster', vesselId, null],
    queryFn: () => api.get<Roster>(`/vessels/${vesselId}/crew`),
    enabled: open && !!vesselId && !relieves,
  });
  const reliefOptions = [...(roster.data?.onboard ?? []), ...(roster.data?.planned ?? [])].filter((a) => a.memberId !== picked?.id);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const local: Record<string, string> = {};
    if (!picked) local.memberId = 'Choisissez une fiche';
    if (!vesselId) local.vesselId = 'Choisissez un navire';
    if (!form.rank.trim()) local.rank = 'Fonction obligatoire';
    if (form.plannedJoinDate && form.plannedSignOffDate && form.plannedSignOffDate < form.plannedJoinDate) {
      local.plannedSignOffDate = 'Débarquement prévu antérieur à l’embarquement prévu';
    }
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const res = await api.post<CrewAssignmentDto>('/crew-assignments', {
        memberId: picked!.id,
        vesselId,
        rank: form.rank.trim(),
        position: form.position.trim() || null,
        plannedJoinDate: form.plannedJoinDate || null,
        plannedSignOffDate: form.plannedSignOffDate || null,
        joinPort: form.joinPort.trim() || null,
        notes: form.notes.trim() || null,
        relievesAssignmentId: form.relievesAssignmentId || null,
      });
      toast.success(`Embarquement planifié sur ${res.vessel.name}`);
      res.warnings?.forEach((w) => toast.warning(w, { duration: 10_000 }));
      await invalidate();
      onOpenChange(false);
    } catch (e) {
      setErrors(apiFieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const vesselName = me.accessibleVessels.find((v) => v.id === vesselId)?.name;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={relieves ? `Planifier la relève de ${relieves.name}` : 'Planifier un embarquement'}
      description="L'affectation est créée au statut « Planifié » ; l'embarquement réel se confirme le jour venu."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} loading={busy}>
            <CalendarPlus className="h-4 w-4" aria-hidden /> Planifier
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <p className="field-label">
            Marin<span className="ml-0.5 text-danger" aria-hidden>*</span>
          </p>
          {member ? (
            <p className="text-sm font-medium">{member.name}</p>
          ) : (
            <MemberPicker
              value={picked}
              onChange={(m) => {
                setPicked(m);
                if (m?.rank && !form.rank) set('rank', m.rank);
              }}
            />
          )}
          {errors.memberId && <p className="field-error">{errors.memberId}</p>}
        </div>
        <Field label="Navire" required htmlFor="plan-vessel" error={errors.vesselId} className="sm:col-span-2">
          {fixedVesselId ? (
            <p className="text-sm font-medium">{vesselName ?? '—'}</p>
          ) : (
            <Select id="plan-vessel" value={vesselId} onChange={(e) => setVesselId(e.target.value)} invalid={!!errors.vesselId}>
              <option value="">Choisir un navire de votre périmètre…</option>
              {vessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Fonction à bord (rank)" required htmlFor="plan-rank" error={errors.rank}>
          <Input id="plan-rank" list="amc-ranks" value={form.rank} onChange={(e) => set('rank', e.target.value)} maxLength={120} invalid={!!errors.rank} />
        </Field>
        <Field label="Poste (facultatif)" htmlFor="plan-position">
          <Input id="plan-position" value={form.position} onChange={(e) => set('position', e.target.value)} maxLength={120} />
        </Field>
        <Field label="Embarquement prévu" htmlFor="plan-join" error={errors.plannedJoinDate}>
          <Input id="plan-join" type="date" value={form.plannedJoinDate} onChange={(e) => set('plannedJoinDate', e.target.value)} />
        </Field>
        <Field label="Débarquement prévu" htmlFor="plan-off" error={errors.plannedSignOffDate}>
          <Input id="plan-off" type="date" value={form.plannedSignOffDate} min={form.plannedJoinDate || undefined} onChange={(e) => set('plannedSignOffDate', e.target.value)} />
        </Field>
        <Field label="Port d'embarquement" htmlFor="plan-port">
          <Input id="plan-port" value={form.joinPort} onChange={(e) => set('joinPort', e.target.value)} maxLength={120} />
        </Field>
        {relieves ? (
          <div>
            <p className="field-label">Relève de</p>
            <p className="text-sm">
              {relieves.name} — {relieves.rank}
            </p>
          </div>
        ) : (
          <Field label="Relève de (facultatif)" htmlFor="plan-relief" hint={vesselId ? undefined : 'Choisissez d’abord le navire'}>
            <Select id="plan-relief" value={form.relievesAssignmentId} onChange={(e) => set('relievesAssignmentId', e.target.value)} disabled={!vesselId}>
              <option value="">Aucune relève</option>
              {reliefOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {memberName(a.member)} — {a.rank} ({a.status === 'ONBOARD' ? 'à bord' : 'planifié'})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Notes" htmlFor="plan-notes" className="sm:col-span-2">
          <Textarea id="plan-notes" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={5000} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Embarquement confirmé (PLANNED -> ONBOARD)
// ---------------------------------------------------------------------------

export interface AssignmentRef {
  id: string;
  memberName: string;
  vesselName: string;
  rank: string;
  plannedJoinDate: string | null;
  plannedSignOffDate?: string | null;
  joinPort: string | null;
  relievesAssignmentId: string | null;
  relievesName?: string | null;
  actualJoinDate?: string | null;
}

export function JoinAssignmentDialog({ assignment, onOpenChange }: { assignment: AssignmentRef | null; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateCrew();
  const [date, setDate] = useState(todayYmd());
  const [port, setPort] = useState('');
  const [signOffRelieved, setSignOffRelieved] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!assignment) return;
    const planned = assignment.plannedJoinDate;
    setDate(planned && planned <= todayYmd() ? planned : todayYmd());
    setPort(assignment.joinPort ?? '');
    setSignOffRelieved(true);
  }, [assignment]);

  const submit = async () => {
    if (!assignment) return;
    setBusy(true);
    try {
      const res = await api.post<CrewAssignmentDto & { relievedAssignmentIds: string[] }>(`/crew-assignments/${assignment.id}/join`, {
        actualJoinDate: date,
        joinPort: port.trim() || null,
        signOffRelieved: !!assignment.relievesAssignmentId && signOffRelieved,
      });
      toast.success(
        `${assignment.memberName} embarqué(e) sur ${assignment.vesselName}${res.relievedAssignmentIds?.length ? ' — relève débarquée à la même date' : ''}`,
      );
      await invalidate();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e), { duration: 10_000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!assignment}
      onOpenChange={onOpenChange}
      title="Confirmer l'embarquement"
      description={assignment ? `${assignment.memberName} — ${assignment.rank} — ${assignment.vesselName}` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} loading={busy} disabled={!date}>
            <Anchor className="h-4 w-4" aria-hidden /> Confirmer l’embarquement
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Date d'embarquement réelle" required htmlFor="join-date" hint="Fait constaté : pas de saisie par anticipation.">
          <Input id="join-date" type="date" value={date} max={tomorrowYmd()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Port d'embarquement" htmlFor="join-port">
          <Input id="join-port" value={port} onChange={(e) => setPort(e.target.value)} maxLength={120} />
        </Field>
        {assignment?.relievesAssignmentId && (
          <Checkbox
            label={`Débarquer ${assignment.relievesName ?? 'la personne relevée'} à la même date`}
            description="Relève : le débarquement est enregistré dans la même transaction."
            checked={signOffRelieved}
            onChange={(e) => setSignOffRelieved(e.target.checked)}
          />
        )}
        {assignment?.plannedJoinDate && <p className="text-xs text-ink-muted">Embarquement prévu le {fmtDate(assignment.plannedJoinDate)}.</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Débarquement (ONBOARD -> COMPLETED)
// ---------------------------------------------------------------------------

export function SignOffAssignmentDialog({ assignment, onOpenChange }: { assignment: AssignmentRef | null; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateCrew();
  const [date, setDate] = useState(todayYmd());
  const [port, setPort] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!assignment) return;
    setDate(todayYmd());
    setPort('');
    setNotes('');
  }, [assignment]);

  const tooEarly = !!(assignment?.actualJoinDate && date && date < assignment.actualJoinDate);
  const submit = async () => {
    if (!assignment) return;
    setBusy(true);
    try {
      await api.post(`/crew-assignments/${assignment.id}/sign-off`, {
        actualSignOffDate: date,
        signOffPort: port.trim() || null,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success(`Débarquement de ${assignment.memberName} enregistré`);
      await invalidate();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!assignment}
      onOpenChange={onOpenChange}
      title="Enregistrer le débarquement"
      description={assignment ? `${assignment.memberName} — ${assignment.rank} — ${assignment.vesselName}` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} loading={busy} disabled={!date || tooEarly}>
            <LogOut className="h-4 w-4" aria-hidden /> Débarquer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Date de débarquement réelle"
          required
          htmlFor="off-date"
          error={tooEarly ? 'Antérieure à l’embarquement' : undefined}
          hint={assignment?.actualJoinDate ? `Embarqué(e) le ${fmtDate(assignment.actualJoinDate)}` : undefined}
        >
          <Input id="off-date" type="date" value={date} min={assignment?.actualJoinDate ?? undefined} max={tomorrowYmd()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Port de débarquement" htmlFor="off-port">
          <Input id="off-port" value={port} onChange={(e) => setPort(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Notes (remplacent les notes de l'affectation)" htmlFor="off-notes">
          <Textarea id="off-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Annulation d'une affectation planifiée (motif obligatoire)
// ---------------------------------------------------------------------------

export function CancelAssignmentDialog({ assignment, onOpenChange }: { assignment: AssignmentRef | null; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateCrew();
  return (
    <ConfirmDialog
      open={!!assignment}
      onOpenChange={onOpenChange}
      title="Annuler l'affectation planifiée"
      description={assignment ? `${assignment.memberName} — ${assignment.rank} — ${assignment.vesselName}` : undefined}
      confirmLabel="Annuler l'affectation"
      tone="danger"
      requireReason
      reasonLabel="Motif de l'annulation"
      onConfirm={async (reason) => {
        if (!assignment) return;
        await api.post(`/crew-assignments/${assignment.id}/cancel`, { reason });
        toast.success('Affectation annulée');
        await invalidate();
      }}
    />
  );
}

/** Classe d'action compacte des tableaux (boutons alignés à droite). */
export const rowActionsClass = cn('flex flex-wrap justify-end gap-1');
