'use client';

import { useQuery } from '@tanstack/react-query';
import { Mail, Pencil, Phone, Plus, Power, Star, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, type Page } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input, Textarea } from '@/components/ui/field';
import { DefinitionGrid } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { commandError, purKeys, useCommand } from './lib';
import type { PoListItem, Supplier, SupplierContact } from './types';
import { Callout, CurrencyInput, FormField, Money, PoStatusBadge, TextActionDialog } from './ui';

interface SupplierFormState {
  code: string;
  name: string;
  legalName: string;
  email: string;
  phone: string;
  address: string;
  country: string;
  currency: string;
  paymentTerms: string;
  taxId: string;
  notes: string;
}

const fromSupplier = (s?: Supplier): SupplierFormState => ({
  code: s?.code ?? '',
  name: s?.name ?? '',
  legalName: s?.legalName ?? '',
  email: s?.email ?? '',
  phone: s?.phone ?? '',
  address: s?.address ?? '',
  country: s?.country ?? '',
  currency: s?.currency ?? '',
  paymentTerms: s?.paymentTerms ?? '',
  taxId: s?.taxId ?? '',
  notes: s?.notes ?? '',
});

/** Code fournisseur proposé à partir du nom (A-Z 0-9 -), modifiable avant création. */
function codeFromName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : '';
}

/**
 * Création / modification d'un fournisseur (suppliers.manage). Le code est figé après création ; à la création il
 * est proposé à partir du nom (modifiable). Utilisé aussi directement depuis le bon de commande.
 */
export function SupplierFormDialog({ supplier, onClose, onSaved }: { supplier?: Supplier; onClose: () => void; onSaved?: (s: Supplier) => void }) {
  const run = useCommand();
  const [f, setF] = useState<SupplierFormState>(() => fromSupplier(supplier));
  const [codeTouched, setCodeTouched] = useState(!!supplier);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (p: Partial<SupplierFormState>) => setF((x) => ({ ...x, ...p }));
  const errs = {
    code: !supplier && !/^[A-Z0-9-]{2,32}$/.test(f.code.trim().toUpperCase()) ? '2 à 32 caractères A-Z 0-9 -' : null,
    name: f.name.trim().length < 2 ? '2 caractères minimum' : null,
    email: f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim()) ? 'Adresse e-mail invalide' : null,
    country: f.country.trim() && !/^[A-Za-z]{2}$/.test(f.country.trim()) ? 'Code pays ISO à 2 lettres (ex. TN, FR)' : null,
    currency: f.currency.trim() && !/^[A-Z]{3}$/.test(f.currency.trim()) ? 'Code devise ISO à 3 lettres' : null,
  };
  const valid = Object.values(errs).every((e) => !e);
  const body = {
    name: f.name.trim(),
    legalName: f.legalName.trim() || null,
    email: f.email.trim() || null,
    phone: f.phone.trim() || null,
    address: f.address.trim() || null,
    country: f.country.trim().toUpperCase() || null,
    currency: f.currency.trim() || null,
    paymentTerms: f.paymentTerms.trim() || null,
    taxId: f.taxId.trim() || null,
    notes: f.notes.trim() || null,
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={supplier ? `Modifier ${supplier.name}` : 'Nouveau fournisseur'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setFieldErrors({});
              try {
                const saved = await run(
                  () => (supplier ? api.patch<Supplier>(`/suppliers/${supplier.id}`, body) : api.post<Supplier>('/suppliers', { code: f.code.trim().toUpperCase(), ...body })),
                  supplier ? 'Fournisseur mis à jour' : 'Fournisseur créé',
                );
                onSaved?.(saved);
                onClose();
              } catch (e) {
                setError(commandError(e));
                if (e && typeof e === 'object' && 'fieldErrors' in e) setFieldErrors((e as { fieldErrors: Record<string, string> }).fieldErrors);
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
        <FormField label="Nom" required error={errs.name ?? fieldErrors.name}>
          <Input value={f.name} onChange={(e) => set(codeTouched ? { name: e.target.value } : { name: e.target.value, code: codeFromName(e.target.value) })} maxLength={200} autoFocus={!supplier} />
        </FormField>
        <FormField label="Code" required={!supplier} error={errs.code ?? fieldErrors.code} hint={supplier ? 'Non modifiable' : 'Proposé à partir du nom, modifiable'}>
          <Input
            value={f.code}
            onChange={(e) => {
              setCodeTouched(true);
              set({ code: e.target.value.toUpperCase() });
            }}
            disabled={!!supplier}
            maxLength={32}
          />
        </FormField>
        <FormField label="Raison sociale">
          <Input value={f.legalName} onChange={(e) => set({ legalName: e.target.value })} maxLength={250} />
        </FormField>
        <FormField label="E-mail" error={errs.email ?? fieldErrors.email} hint="Coordonnées de contact (la plateforme n’envoie pas d’e-mail aux fournisseurs).">
          <Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} maxLength={320} />
        </FormField>
        <FormField label="Téléphone">
          <Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={64} />
        </FormField>
        <FormField label="Pays" error={errs.country ?? fieldErrors.country}>
          <Input value={f.country} onChange={(e) => set({ country: e.target.value.toUpperCase().slice(0, 2) })} placeholder="TN" />
        </FormField>
        <FormField label="Devise habituelle" error={errs.currency ?? fieldErrors.currency}>
          <CurrencyInput value={f.currency} onChange={(v) => set({ currency: v })} />
        </FormField>
        <FormField label="Conditions de paiement">
          <Input value={f.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} maxLength={250} />
        </FormField>
        <FormField label="Identifiant fiscal">
          <Input value={f.taxId} onChange={(e) => set({ taxId: e.target.value })} maxLength={64} />
        </FormField>
        <FormField label="Adresse" className="sm:col-span-2">
          <Textarea rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} maxLength={500} />
        </FormField>
        <FormField label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={5000} />
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

function ContactDialog({ supplier, contact, onClose }: { supplier: Supplier; contact?: SupplierContact; onClose: () => void }) {
  const run = useCommand();
  const [f, setF] = useState({ name: contact?.name ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', role: contact?.role ?? '', isPrimary: contact?.isPrimary ?? false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailErr = f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim()) ? 'Adresse e-mail invalide' : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={contact ? `Modifier le contact ${contact.name}` : `Nouveau contact — ${supplier.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={f.name.trim().length < 2 || !!emailErr}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const body = { name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null, role: f.role.trim() || null, isPrimary: f.isPrimary };
              try {
                await run(
                  () => (contact ? api.patch(`/suppliers/${supplier.id}/contacts/${contact.id}`, body) : api.post(`/suppliers/${supplier.id}/contacts`, body)),
                  contact ? 'Contact mis à jour' : 'Contact ajouté',
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
      <div className="space-y-3">
        <FormField label="Nom" required>
          <Input value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} maxLength={200} />
        </FormField>
        <FormField label="Fonction">
          <Input value={f.role} onChange={(e) => setF((x) => ({ ...x, role: e.target.value }))} maxLength={120} />
        </FormField>
        <FormField label="E-mail" error={emailErr ?? undefined}>
          <Input type="email" value={f.email} onChange={(e) => setF((x) => ({ ...x, email: e.target.value }))} maxLength={320} />
        </FormField>
        <FormField label="Téléphone">
          <Input value={f.phone} onChange={(e) => setF((x) => ({ ...x, phone: e.target.value }))} maxLength={64} />
        </FormField>
        <Checkbox label="Contact principal" description="Destinataire des RFQ et BC en complément de l’adresse du fournisseur." checked={f.isPrimary} onChange={(e) => setF((x) => ({ ...x, isPrimary: e.target.checked }))} />
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}

/** Fiche fournisseur (panneau latéral ?selected=) : coordonnées, contacts, activation, derniers BC. */
export function SupplierPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const run = useCommand();
  const manage = can('suppliers.manage');
  const [dialog, setDialog] = useState<null | 'edit' | 'contact' | 'toggle'>(null);
  const [editContact, setEditContact] = useState<SupplierContact | undefined>(undefined);
  const [removeContact, setRemoveContact] = useState<SupplierContact | null>(null);
  const q = useQuery({ queryKey: purKeys.supplier(id), queryFn: () => api.get<Supplier>(`/suppliers/${id}`) });
  const orders = useQuery({
    queryKey: [...purKeys.orders, 'by-supplier', id],
    queryFn: () => api.get<Page<PoListItem>>('/orders', { query: { supplierId: id, limit: 8 } }),
    enabled: can('bc.view'),
  });
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{s.name}</h2>
          <p className="text-sm text-ink-muted">
            {s.code}
            {s.legalName ? ` — ${s.legalName}` : ''}
          </p>
          <div className="mt-1">{s.isActive ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>}</div>
        </div>
        <IconButton label="Fermer la fiche" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {manage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>
            <Pencil className="h-4 w-4" aria-hidden /> Modifier
          </Button>
          <Button size="sm" variant={s.isActive ? 'ghost' : 'primary'} onClick={() => setDialog('toggle')}>
            <Power className="h-4 w-4" aria-hidden /> {s.isActive ? 'Désactiver' : 'Réactiver'}
          </Button>
        </div>
      )}
      {!s.email && (
        <Callout tone="warn" title="Aucune adresse e-mail">
          RFQ et BC ne pourront pas être envoyés automatiquement à ce fournisseur (déclaration d’envoi manuel uniquement), sauf via un contact disposant d’une adresse.
        </Callout>
      )}
      <DefinitionGrid
        columns={2}
        items={[
          ['E-mail', s.email],
          ['Téléphone', s.phone],
          ['Pays', s.country],
          ['Devise', s.currency],
          ['Paiement', s.paymentTerms],
          ['Identifiant fiscal', s.taxId],
          ['Adresse', s.address ? <span className="whitespace-pre-line">{s.address}</span> : null],
          ['Mis à jour', fmtDateTime(s.updatedAt)],
        ]}
      />
      {s.notes && <p className="whitespace-pre-line text-sm text-ink-muted">{s.notes}</p>}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-navy">Contacts ({s.contacts.length})</h3>
          {manage && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditContact(undefined);
                setDialog('contact');
              }}
            >
              <Plus className="h-4 w-4" aria-hidden /> Ajouter
            </Button>
          )}
        </div>
        {s.contacts.length ? (
          <ul className="space-y-1.5">
            {s.contacts.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.name}
                    {c.isPrimary && (
                      <Badge tone="info" className="ml-1.5" icon={<Star className="h-3 w-3" aria-hidden />}>
                        Principal
                      </Badge>
                    )}
                  </p>
                  {c.role && <p className="text-xs text-ink-muted">{c.role}</p>}
                  <p className="flex flex-wrap gap-x-3 text-xs text-ink-muted">
                    {c.email && (
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3 w-3" aria-hidden />
                        {c.email}
                      </span>
                    )}
                    {c.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3 w-3" aria-hidden />
                        {c.phone}
                      </span>
                    )}
                  </p>
                </div>
                {manage && (
                  <div className="flex shrink-0">
                    <IconButton
                      label={`Modifier ${c.name}`}
                      onClick={() => {
                        setEditContact(c);
                        setDialog('contact');
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton label={`Supprimer ${c.name}`} onClick={() => setRemoveContact(c)} className="hover:text-danger">
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Aucun contact.</p>
        )}
      </section>

      {can('bc.view') && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-navy">Derniers bons de commande</h3>
          {orders.data?.items.length ? (
            <ul className="divide-y divide-line">
              {orders.data.items.map((o) => (
                <li key={o.id}>
                  <Link href={`/purchasing/orders/${o.id}`} className="flex items-center justify-between gap-2 py-1.5 text-sm hover:bg-action-50/40">
                    <span>
                      <span className="font-medium text-action">{o.number}</span>
                      <span className="block text-xs text-ink-muted">
                        {o.vessel.name} · {fmtDate(o.createdAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Money value={o.totalAmount} currency={o.currency} />
                      <PoStatusBadge status={o.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">{orders.isLoading ? 'Chargement…' : 'Aucun BC dans votre périmètre.'}</p>
          )}
        </section>
      )}

      {dialog === 'edit' && <SupplierFormDialog supplier={s} onClose={() => setDialog(null)} />}
      {dialog === 'contact' && <ContactDialog supplier={s} contact={editContact} onClose={() => setDialog(null)} />}
      <TextActionDialog
        open={dialog === 'toggle'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={s.isActive ? `Désactiver ${s.name}` : `Réactiver ${s.name}`}
        description={s.isActive ? 'Le fournisseur ne pourra plus être consulté ni commandé ; son historique est conservé (aucune suppression).' : undefined}
        label="Motif"
        required={s.isActive}
        tone={s.isActive ? 'danger' : 'primary'}
        confirmLabel={s.isActive ? 'Désactiver' : 'Réactiver'}
        onConfirm={(reason) => run(() => api.post(`/suppliers/${s.id}/active`, { isActive: !s.isActive, reason: reason || undefined }), s.isActive ? 'Fournisseur désactivé' : 'Fournisseur réactivé')}
      />
      <TextActionDialog
        open={!!removeContact}
        onOpenChange={(o) => !o && setRemoveContact(null)}
        title={`Supprimer le contact ${removeContact?.name ?? ''}`}
        label="Note (facultative)"
        tone="danger"
        confirmLabel="Supprimer"
        onConfirm={() => run(() => api.delete(`/suppliers/${s.id}/contacts/${removeContact!.id}`), 'Contact supprimé')}
      />
    </div>
  );
}
