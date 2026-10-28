'use client';

import { ArrowDown, ArrowUp, Mail, MapPin, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/states';
import { FormError, SelectField, StoredText, TextAreaField, TextInputField, UtcDateTimeField } from './common';
import { AGENT_ROLE_SUGGESTIONS, PORT_CALL_LABELS, fmtUtc, fromUtcInput, nn, toUtcInput, useOp, voyageKeys } from './lib';
import type { VoyageAgent, VoyagePort, VoyageWorkspace } from './types';

// -----------------------------------------------------------------------------
// Escale
// -----------------------------------------------------------------------------

interface PortForm {
  type: string;
  portName: string;
  country: string;
  unlocode: string;
  berth: string;
  agentId: string;
  eta: string;
  ata: string;
  etd: string;
  atd: string;
  cargoOperations: string;
  notes: string;
}

const portInit = (p?: VoyagePort | null): PortForm => ({
  type: p?.type ?? 'LOAD',
  portName: p?.portName ?? '',
  country: p?.country ?? '',
  unlocode: p?.unlocode ?? '',
  berth: p?.berth ?? '',
  agentId: p?.agentId ?? '',
  eta: toUtcInput(p?.eta),
  ata: toUtcInput(p?.ata),
  etd: toUtcInput(p?.etd),
  atd: toUtcInput(p?.atd),
  cargoOperations: p?.cargoOperations ?? '',
  notes: p?.notes ?? '',
});

const portPayload = (f: PortForm) => ({
  type: f.type,
  portName: f.portName.trim(),
  country: nn(f.country)?.toUpperCase() ?? null,
  unlocode: nn(f.unlocode)?.toUpperCase() ?? null,
  berth: nn(f.berth),
  agentId: f.agentId || null,
  eta: fromUtcInput(f.eta),
  ata: fromUtcInput(f.ata),
  etd: fromUtcInput(f.etd),
  atd: fromUtcInput(f.atd),
  cargoOperations: nn(f.cargoOperations),
  notes: nn(f.notes),
});

function PortDialog({
  open,
  onOpenChange,
  voyageId,
  port,
  agents,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  voyageId: string;
  port: VoyagePort | null;
  agents: VoyageAgent[];
}) {
  const [f, setF] = useState<PortForm>(() => portInit(port));
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setF(portInit(port));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof PortForm) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = useOp(
    () => {
      const body = portPayload(f);
      if (!port) return api.post(`/voyages/${voyageId}/ports`, body);
      const before = portPayload(portInit(port));
      const changes = Object.fromEntries(Object.entries(body).filter(([k, v]) => before[k as keyof typeof before] !== v));
      return api.patch(`/voyages/${voyageId}/ports/${port.id}`, changes);
    },
    {
      success: port ? 'Escale mise à jour' : 'Escale ajoutée',
      invalidate: [voyageKeys.ws(voyageId), voyageKeys.list],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  const errs: Partial<Record<keyof PortForm, string>> = {};
  if (f.country && !/^[A-Za-z]{2}$/.test(f.country)) errs.country = 'Code pays ISO à 2 lettres (ex. TN)';
  if (f.unlocode && !/^[A-Za-z]{2}[A-Za-z0-9]{3}$/.test(f.unlocode)) errs.unlocode = 'UN/LOCODE : 5 caractères (ex. TNGAE)';
  if (f.eta && f.etd && f.eta > f.etd) errs.etd = 'ETD antérieure à l’ETA';
  if (f.ata && f.atd && f.ata > f.atd) errs.atd = 'ATD antérieure à l’ATA';
  const invalid = f.portName.trim().length < 2 || Object.keys(errs).length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={port ? `Escale ${port.sequence} — ${port.portName}` : 'Ajouter une escale'}
      description="Horodatages en UTC. Les dates réelles (ATA/ATD) alimentent la chronologie du voyage."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={invalid}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField label="Type d’escale" value={f.type} onChange={set('type')} options={Object.entries(PORT_CALL_LABELS).map(([value, label]) => ({ value, label }))} />
          <TextInputField label="Port" required value={f.portName} onChange={set('portName')} maxLength={120} placeholder="Ex. Gabès" />
          <div className="grid grid-cols-2 gap-3">
            <TextInputField label="Pays" value={f.country} onChange={set('country')} maxLength={2} placeholder="TN" error={errs.country} />
            <TextInputField label="UN/LOCODE" value={f.unlocode} onChange={set('unlocode')} maxLength={5} placeholder="TNGAE" error={errs.unlocode} />
          </div>
          <TextInputField label="Berth (poste)" value={f.berth} onChange={set('berth')} maxLength={120} />
          <SelectField
            label="Agent"
            value={f.agentId}
            onChange={set('agentId')}
            placeholder={agents.length ? 'Aucun' : 'Aucun agent saisi pour ce voyage'}
            options={agents.map((a) => ({ value: a.id, label: `${a.name} — ${a.role}` }))}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <UtcDateTimeField label="ETA" value={f.eta} onChange={set('eta')} />
          <UtcDateTimeField label="ETD" value={f.etd} onChange={set('etd')} error={errs.etd} />
          <UtcDateTimeField label="ATA" value={f.ata} onChange={set('ata')} hint="Arrivée réelle" />
          <UtcDateTimeField label="ATD" value={f.atd} onChange={set('atd')} error={errs.atd} hint="Départ réel" />
        </div>
        <TextAreaField label="Opérations commerciales (cargo operations)" value={f.cargoOperations} onChange={set('cargoOperations')} rows={2} maxLength={5000} />
        <TextAreaField label="Notes" value={f.notes} onChange={set('notes')} rows={2} maxLength={5000} hint="Ex. clause NOR / horaires d’ouverture : texte stocké tel quel, jamais interprété." />
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Agent
// -----------------------------------------------------------------------------

interface AgentForm {
  role: string;
  name: string;
  city: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
}

const agentInit = (a?: VoyageAgent | null): AgentForm => ({
  role: a?.role ?? '',
  name: a?.name ?? '',
  city: a?.city ?? '',
  email: a?.email ?? '',
  phone: a?.phone ?? '',
  address: a?.address ?? '',
  notes: a?.notes ?? '',
});

function AgentDialog({ open, onOpenChange, voyageId, agent }: { open: boolean; onOpenChange: (o: boolean) => void; voyageId: string; agent: VoyageAgent | null }) {
  const [f, setF] = useState<AgentForm>(() => agentInit(agent));
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setF(agentInit(agent));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof AgentForm) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = useOp(
    () => {
      const body = {
        role: f.role.trim().toUpperCase().replace(/\s+/g, '_'),
        name: f.name.trim(),
        city: nn(f.city),
        email: nn(f.email),
        phone: nn(f.phone),
        address: nn(f.address),
        notes: nn(f.notes),
      };
      return agent ? api.patch(`/voyages/${voyageId}/agents/${agent.id}`, body) : api.post(`/voyages/${voyageId}/agents`, body);
    },
    {
      success: agent ? 'Agent mis à jour' : 'Agent ajouté',
      invalidate: [voyageKeys.ws(voyageId)],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  const emailError = f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()) ? 'Adresse e-mail invalide' : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={agent ? `Agent — ${agent.name}` : 'Ajouter un agent'}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={f.name.trim().length < 2 || f.role.trim().length < 2 || !!emailError}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <datalist id="agent-roles">
        {AGENT_ROLE_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInputField label="Rôle" required value={f.role} onChange={set('role')} list="agent-roles" placeholder="LOAD_AGENT" maxLength={40} />
        <TextInputField label="Nom" required value={f.name} onChange={set('name')} maxLength={200} placeholder="Ex. CHIMAG" />
        <TextInputField label="Ville" value={f.city} onChange={set('city')} maxLength={120} />
        <TextInputField label="E-mail" type="email" value={f.email} onChange={set('email')} error={emailError} maxLength={320} />
        <TextInputField label="Téléphone" type="tel" value={f.phone} onChange={set('phone')} maxLength={64} />
        <TextInputField label="Adresse" value={f.address} onChange={set('address')} maxLength={500} />
        <TextAreaField label="Notes" value={f.notes} onChange={set('notes')} rows={2} className="sm:col-span-2" maxLength={5000} />
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Onglet
// -----------------------------------------------------------------------------

export function PortsTab({ ws }: { ws: VoyageWorkspace }) {
  const id = ws.overview.id;
  const canEdit = ws.permissions.edit;
  const [portDialog, setPortDialog] = useState<{ port: VoyagePort | null } | null>(null);
  const [agentDialog, setAgentDialog] = useState<{ agent: VoyageAgent | null } | null>(null);
  const [removePort, setRemovePort] = useState<VoyagePort | null>(null);
  const [removeAgent, setRemoveAgent] = useState<VoyageAgent | null>(null);

  const reorder = useOp((portIds: string[]) => api.put(`/voyages/${id}/ports/order`, { portIds }), {
    success: 'Ordre des escales mis à jour',
    invalidate: [voyageKeys.ws(id), voyageKeys.list],
  });
  const move = (index: number, delta: number) => {
    const ids = ws.ports.map((p) => p.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorder.mutate(ids);
  };
  const delPort = useOp((portId: string) => api.delete(`/voyages/${id}/ports/${portId}`), {
    success: 'Escale supprimée',
    invalidate: [voyageKeys.ws(id), voyageKeys.list],
  });
  const delAgent = useOp((agentId: string) => api.delete(`/voyages/${id}/agents/${agentId}`), {
    success: 'Agent supprimé',
    invalidate: [voyageKeys.ws(id)],
  });

  return (
    <div className="space-y-5">
      <Panel
        title="Escales (ordre de passage)"
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setPortDialog({ port: null })}>
              <Plus className="h-4 w-4" aria-hidden /> Ajouter une escale
            </Button>
          )
        }
        bodyClassName="p-0"
      >
        {ws.ports.length === 0 ? (
          <EmptyState title="Aucune escale" description="Ajoutez le load port, le discharge port et les éventuelles escales intermédiaires." />
        ) : (
          <ol className="divide-y divide-line">
            {ws.ports.map((p, i) => (
              <li key={p.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start">
                <div className="flex items-start gap-3 lg:w-72">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-semibold tabular text-white">
                    {p.sequence}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1 font-semibold text-navy">
                      <MapPin className="h-4 w-4 text-teal-700" aria-hidden /> {p.portName}
                      {p.country && <span className="font-normal text-ink-muted">({p.country})</span>}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge tone="navy" icon={false}>
                        {PORT_CALL_LABELS[p.type] ?? p.type}
                      </Badge>
                      {p.unlocode && (
                        <Badge tone="neutral" icon={false}>
                          {p.unlocode}
                        </Badge>
                      )}
                    </div>
                    {p.berth && <p className="mt-1 text-xs text-ink-muted">Berth : {p.berth}</p>}
                    <p className="mt-1 text-xs text-ink-muted">Agent : {p.agent ? `${p.agent.name} (${p.agent.role})` : '—'}</p>
                  </div>
                </div>
                <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  {(
                    [
                      ['ETA', p.eta],
                      ['ATA', p.ata],
                      ['ETD', p.etd],
                      ['ATD', p.atd],
                    ] as const
                  ).map(([k, val]) => (
                    <div key={k}>
                      <dt className="text-xs text-ink-muted">{k}</dt>
                      <dd className={`tabular ${val ? 'text-ink' : 'text-ink-soft'}`}>{fmtUtc(val)}</dd>
                    </div>
                  ))}
                  {(p.cargoOperations || p.notes) && (
                    <div className="col-span-2 mt-1 space-y-1 sm:col-span-4">
                      {p.cargoOperations && (
                        <div>
                          <dt className="text-xs text-ink-muted">Cargo operations</dt>
                          <dd>
                            <StoredText>{p.cargoOperations}</StoredText>
                          </dd>
                        </div>
                      )}
                      {p.notes && (
                        <div>
                          <dt className="text-xs text-ink-muted">Notes</dt>
                          <dd>
                            <StoredText>{p.notes}</StoredText>
                          </dd>
                        </div>
                      )}
                    </div>
                  )}
                </dl>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1 self-end lg:self-start">
                    <IconButton label={`Monter ${p.portName}`} disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={`Descendre ${p.portName}`} disabled={i === ws.ports.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                    <Button size="sm" variant="secondary" onClick={() => setPortDialog({ port: p })}>
                      <Pencil className="h-4 w-4" aria-hidden /> ETA / ATA…
                    </Button>
                    <IconButton label={`Supprimer ${p.portName}`} disabled={!!(p.ata || p.atd)} onClick={() => setRemovePort(p)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title="Agents"
        actions={
          canEdit && (
            <Button size="sm" variant="secondary" onClick={() => setAgentDialog({ agent: null })}>
              <Plus className="h-4 w-4" aria-hidden /> Ajouter un agent
            </Button>
          )
        }
        bodyClassName="p-0"
      >
        {ws.agents.length === 0 ? (
          <EmptyState title="Aucun agent" description="Load agent, discharge agent, protecting agent…" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-amc">
              <caption className="sr-only">Agents du voyage</caption>
              <thead>
                <tr>
                  <th scope="col">Rôle</th>
                  <th scope="col">Nom</th>
                  <th scope="col">Ville</th>
                  <th scope="col">Contact</th>
                  <th scope="col" className="hidden md:table-cell">
                    Escales
                  </th>
                  {canEdit && <th scope="col" className="text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {ws.agents.map((a) => {
                  const ports = ws.ports.filter((p) => p.agentId === a.id);
                  return (
                    <tr key={a.id}>
                      <td>
                        <Badge tone="navy" icon={false}>
                          {a.role}
                        </Badge>
                      </td>
                      <td className="font-medium text-navy">{a.name}</td>
                      <td>{a.city ?? '—'}</td>
                      <td className="text-xs">
                        {a.email && (
                          <a href={`mailto:${a.email}`} className="flex items-center gap-1 text-action hover:underline">
                            <Mail className="h-3.5 w-3.5" aria-hidden /> {a.email}
                          </a>
                        )}
                        {a.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3.5 w-3.5" aria-hidden /> {a.phone}
                          </span>
                        )}
                        {!a.email && !a.phone && '—'}
                      </td>
                      <td className="hidden md:table-cell">{ports.map((p) => p.portName).join(', ') || '—'}</td>
                      {canEdit && (
                        <td className="text-right">
                          <IconButton label={`Modifier ${a.name}`} onClick={() => setAgentDialog({ agent: a })}>
                            <Pencil className="h-4 w-4" />
                          </IconButton>
                          <IconButton label={`Supprimer ${a.name}`} disabled={ports.length > 0} onClick={() => setRemoveAgent(a)}>
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <PortDialog open={!!portDialog} onOpenChange={(o) => !o && setPortDialog(null)} voyageId={id} port={portDialog?.port ?? null} agents={ws.agents} />
      <AgentDialog open={!!agentDialog} onOpenChange={(o) => !o && setAgentDialog(null)} voyageId={id} agent={agentDialog?.agent ?? null} />
      <ConfirmDialog
        open={!!removePort}
        onOpenChange={(o) => !o && setRemovePort(null)}
        title={`Supprimer l’escale ${removePort?.portName ?? ''} ?`}
        description="Impossible si l’escale porte des dates réelles ou est référencée par une NOR, une tâche ou une notice."
        confirmLabel="Supprimer"
        tone="danger"
        onConfirm={async () => {
          if (removePort) await delPort.mutateAsync(removePort.id).catch(() => undefined);
        }}
      />
      <ConfirmDialog
        open={!!removeAgent}
        onOpenChange={(o) => !o && setRemoveAgent(null)}
        title={`Supprimer l’agent ${removeAgent?.name ?? ''} ?`}
        confirmLabel="Supprimer"
        tone="danger"
        onConfirm={async () => {
          if (removeAgent) await delAgent.mutateAsync(removeAgent.id).catch(() => undefined);
        }}
      />
    </div>
  );
}
