'use client';

import { PO_STATUS_LABELS, PR_STATUS_LABELS, RFQ_STATUS_LABELS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleDashed, Eye, FileSpreadsheet, Flag, Info, Paperclip, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { cloneElement, isValidElement, useId, useState, type ClipboardEventHandler, type ComponentProps, type KeyboardEventHandler, type ReactElement, type ReactNode, type Ref } from 'react';
import { toast } from 'sonner';
import { api, type Page, type StoredFileDto } from '@/lib/api';
import { cn, fmtDateTime, fmtDecimal, fmtMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileRow, FilePreviewDialog, DownloadButton } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import {
  COMMON_CURRENCIES,
  HISTORY_ACTION_LABELS,
  LINE_BADGE_LABELS,
  LINE_BADGE_TONES,
  PO_STATUS_TONES,
  PRIORITY_LABELS,
  PRIORITY_TONES,
  PR_STATUS_TONES,
  RFQ_STATUS_TONES,
  commandError,
  useDebounced,
} from './lib';
import type { HistoryEvent, PurchasingAttachment, Supplier } from './types';

// =============================================================================
// Badges de statut (texte + icône, jamais la couleur seule)
// =============================================================================

export function StatusPill({ status, labels, tones, title }: { status: string; labels: Record<string, string>; tones: Record<string, Tone>; title?: string }) {
  const tone = tones[status] ?? 'neutral';
  const icon = tone === 'neutral' || tone === 'navy' || tone === 'teal' ? <CircleDashed className="h-3.5 w-3.5 shrink-0" aria-hidden /> : undefined;
  return (
    <Badge tone={tone} icon={icon} title={title}>
      {labels[status] ?? status}
    </Badge>
  );
}

export const PrStatusBadge = ({ status }: { status: string }) => <StatusPill status={status} labels={PR_STATUS_LABELS} tones={PR_STATUS_TONES} />;
export const PoStatusBadge = ({ status }: { status: string }) => <StatusPill status={status} labels={PO_STATUS_LABELS} tones={PO_STATUS_TONES} />;
export const RfqStatusBadge = ({ status }: { status: string }) => <StatusPill status={status} labels={RFQ_STATUS_LABELS} tones={RFQ_STATUS_TONES} />;
export const LineBadge = ({ badge }: { badge: string }) => <StatusPill status={badge} labels={LINE_BADGE_LABELS} tones={LINE_BADGE_TONES} />;

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge tone={PRIORITY_TONES[priority] ?? 'neutral'} icon={<Flag className="h-3.5 w-3.5 shrink-0" aria-hidden />}>
      {PRIORITY_LABELS[priority] ?? priority}
    </Badge>
  );
}

// =============================================================================
// Nombres
// =============================================================================

/** Quantité (chaîne décimale) + unité saisie telle quelle. */
export function Qty({ value, unit, className, strong }: { value: string | null | undefined; unit?: string | null; className?: string; strong?: boolean }) {
  return (
    <span className={cn('tabular whitespace-nowrap', strong && 'font-semibold', className)}>
      {fmtDecimal(value)}
      {unit && value !== null && value !== undefined && value !== '' ? <span className="ml-1 text-xs font-normal text-ink-muted">{unit}</span> : null}
    </span>
  );
}

export function Money({ value, currency, className, strong }: { value: string | null | undefined; currency?: string | null; className?: string; strong?: boolean }) {
  return <span className={cn('tabular whitespace-nowrap', strong && 'font-semibold', className)}>{fmtMoney(value, currency)}</span>;
}

// =============================================================================
// Mise en page
// =============================================================================

export function Callout({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn' | 'danger'; title?: ReactNode; children?: ReactNode; className?: string }) {
  const styles = {
    info: 'border-info-line bg-info-bg text-info',
    warn: 'border-warn-line bg-warn-bg text-warn',
    danger: 'border-danger-line bg-danger-bg text-danger',
  }[tone];
  const Icon = tone === 'info' ? Info : tone === 'warn' ? AlertTriangle : ShieldAlert;
  return (
    <div className={cn('flex gap-2 rounded-md border px-3 py-2 text-sm', styles, className)} role={tone === 'danger' ? 'alert' : 'note'}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-ink">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-ink-muted')}>{children}</div>}
      </div>
    </div>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  children,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-muted">
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm">
        {children}
      </Select>
    </div>
  );
}

export function FilterText({
  label,
  value,
  onChange,
  placeholder,
  className,
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  list?: string;
}) {
  const id = useId();
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-muted">
        {label}
      </label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 text-sm" list={list} />
    </div>
  );
}

/** Tuile de compteur cliquable (board, synthèses). */
export function CounterTile({ label, value, href, tone, hint }: { label: string; value: number | string | null | undefined; href?: string; tone?: 'danger' | 'warn' | 'ok'; hint?: string }) {
  const n = typeof value === 'number' ? value : null;
  const color = n && tone === 'danger' ? 'text-danger' : n && tone === 'warn' ? 'text-warn' : n && tone === 'ok' ? 'text-ok' : 'text-navy';
  const body = (
    <>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={cn('text-xl font-semibold tabular', color)}>{value ?? '—'}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-soft">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="gauge block">
      {body}
    </Link>
  ) : (
    <div className="gauge">{body}</div>
  );
}

export function EntityLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('font-medium text-action hover:underline', className)} onClick={(e) => e.stopPropagation()}>
      {children}
    </Link>
  );
}

// =============================================================================
// Historique (endpoints /history des entités Achats — lecture pr.view / bc.view)
// =============================================================================

function historyDetail(e: HistoryEvent): string[] {
  const out: string[] = [];
  const b = e.before as Record<string, unknown> | null;
  const a = e.after as Record<string, unknown> | null;
  if (b && a && !Array.isArray(b) && !Array.isArray(a) && typeof b.status === 'string' && typeof a.status === 'string' && b.status !== a.status) {
    out.push(`Statut : ${PR_STATUS_LABELS[b.status] ?? PO_STATUS_LABELS[b.status] ?? b.status} → ${PR_STATUS_LABELS[a.status] ?? PO_STATUS_LABELS[a.status] ?? a.status}`);
  }
  const m = e.metadata ?? {};
  for (const key of ['comment', 'reason', 'justification', 'note']) {
    const v = m[key];
    if (typeof v === 'string' && v) out.push(`« ${v.slice(0, 300)} »`);
  }
  if (typeof m.trigger === 'string') out.push(`Déclencheur : ${m.trigger}`);
  const decision = m.decision as { reason?: string; threshold?: string | null } | undefined;
  if (decision?.reason) out.push(`Décision d'approbation : ${decision.reason}${decision.threshold ? ` (seuil ${decision.threshold})` : ''}`);
  if (typeof m.recipient === 'string') out.push(`Destinataire : ${m.recipient}`);
  const dispatches = m.dispatches as { recipient?: string; status?: string; error?: string | null }[] | undefined;
  if (Array.isArray(dispatches)) dispatches.forEach((d) => out.push(`${d.recipient ?? '?'} : ${d.status ?? 'échec'}${d.error ? ` — ${d.error}` : ''}`));
  return out;
}

export function HistoryList({ path, queryKey }: { path: string; queryKey: readonly unknown[] }) {
  const q = useQuery({ queryKey: [...queryKey, 'history'], queryFn: () => api.get<HistoryEvent[]>(path) });
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = [...(q.data ?? [])].filter((e) => e.action !== 'file.preview').reverse();
  if (!items.length) return <EmptyState title="Aucun événement" />;
  return (
    <ol className="relative ml-2 border-l border-line">
      {items.map((e) => {
        const lines = historyDetail(e);
        return (
          <li key={e.id} className="mb-4 ml-4">
            <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-teal" aria-hidden />
            <p className="text-sm font-medium text-ink">{HISTORY_ACTION_LABELS[e.action] ?? e.action}</p>
            <p className="text-xs text-ink-muted">
              {fmtDateTime(e.occurredAt)} — {e.actorLabel ?? 'système'}
            </p>
            {lines.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                {lines.map((l, i) => (
                  <li key={i} className="break-words">
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// =============================================================================
// Pièces jointes polymorphes Achats
// =============================================================================

export function AttachmentsPanel({
  path,
  vesselId,
  attachments,
  canManage,
  onChanged,
  hint,
  emptyText = 'Aucune pièce jointe.',
}: {
  /** ex. /purchase-requests/:id/attachments */
  path: string;
  vesselId: string;
  attachments: PurchasingAttachment[] | undefined;
  canManage: boolean;
  onChanged: () => void;
  hint?: string;
  emptyText?: string;
}) {
  const [pending, setPending] = useState<StoredFileDto | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const attach = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await api.post(path, { fileId: pending.id, title: title.trim() || undefined });
      toast.success('Pièce jointe ajoutée');
      setPending(null);
      setTitle('');
      onChanged();
    } catch (e) {
      toast.error(commandError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      {attachments && attachments.length ? (
        <ul className="space-y-1.5">
          {attachments.map((a) =>
            a.file ? (
              <li key={a.id}>
                <FileRow
                  fileId={a.fileId}
                  name={a.title ? `${a.title} — ${a.file.originalName}` : a.file.originalName}
                  kind={a.file.kind}
                  sizeBytes={a.file.sizeBytes}
                  extra={<span className="hidden text-xs text-ink-muted md:inline">{fmtDateTime(a.createdAt)}</span>}
                />
              </li>
            ) : (
              <li key={a.id} className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted">
                <Paperclip className="mr-1 inline h-4 w-4" aria-hidden /> Fichier indisponible
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">{emptyText}</p>
      )}
      {canManage && (
        <div className="rounded-md border border-dashed border-line-strong p-3">
          <FileUploader context="PURCHASING" vesselId={vesselId} onUploaded={setPending} label="Ajouter une pièce jointe" hint={hint} />
          {pending && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Titre (facultatif)" className="min-w-[220px] flex-1">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={pending.originalName} />
              </Field>
              <Button onClick={attach} loading={busy}>
                <Paperclip className="h-4 w-4" aria-hidden /> Rattacher
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PDF générés à la demande (PR, BC, rapport de réception)
// =============================================================================

export function PdfActions({ path, title, label = 'PDF' }: { path: string; title: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Eye className="h-4 w-4" aria-hidden /> {label}
      </Button>
      {open && (
        <FilePreviewDialog
          open={open}
          onOpenChange={setOpen}
          title={title}
          previewPath={path}
          downloadPath={`${path}?download=true`}
          canDownload
          kind="PDF"
        />
      )}
    </>
  );
}

export { DownloadButton };

/** Export Excel (reports.export) : lien signé demandé au clic avec les filtres courants. */
export function ExportButton({ path, query, label = 'Exporter (Excel)' }: { path: string; query: Record<string, string | undefined>; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const link = await api.get<{ url: string; fileName: string; itemCount: number }>(path, { query });
          const a = document.createElement('a');
          a.href = link.url;
          a.rel = 'noopener';
          a.download = link.fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          toast.success(`${link.itemCount} élément(s) exporté(s)`);
        } catch (e) {
          toast.error(commandError(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileSpreadsheet className="h-4 w-4" aria-hidden /> {label}
    </Button>
  );
}

// =============================================================================
// Sélecteurs
// =============================================================================

/** Navires accessibles (Vessel Switcher : restreint à la sélection multiple si elle existe). */
export function VesselSelect({
  value,
  onChange,
  label = 'Navire',
  required,
  allowAll,
  allLabel = 'Tous mes navires',
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  required?: boolean;
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const { me } = useSession();
  const id = useId();
  return (
    <Field label={label} required={required} className={className} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={required}>
        {allowAll ? <option value="">{allLabel}</option> : <option value="">— Choisir —</option>}
        {me.accessibleVessels.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name} ({v.code})
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function useSuppliers(search = '', activeOnly = true, enabled = true) {
  return useQuery({
    queryKey: ['pur', 'suppliers', 'options', search, activeOnly],
    queryFn: () => api.get<Page<Supplier>>('/suppliers', { query: { search: search || undefined, active: activeOnly ? 'true' : undefined, limit: 100 } }),
    enabled,
    staleTime: 30_000,
  });
}

/** Choix d'un fournisseur (recherche serveur, actifs uniquement par défaut). */
export function SupplierSelect({
  value,
  onChange,
  label = 'Fournisseur',
  required,
  className,
  exclude = [],
  disabled,
  hint,
}: {
  value: string;
  onChange: (id: string, supplier: Supplier | undefined) => void;
  label?: string;
  required?: boolean;
  className?: string;
  exclude?: string[];
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term.trim(), 250);
  const q = useSuppliers(debounced);
  const id = useId();
  const options = (q.data?.items ?? []).filter((s) => !exclude.includes(s.id) || s.id === value);
  return (
    <Field label={label} required={required} className={className} htmlFor={id} hint={hint}>
      <div className="flex gap-2">
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Filtrer…" className="w-32 shrink-0" aria-label={`Filtrer ${label}`} disabled={disabled} />
        <Select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, options.find((s) => s.id === e.target.value))}
          required={required}
        >
          <option value="">{q.isLoading ? 'Chargement…' : '— Choisir —'}</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code}){s.currency ? ` — ${s.currency}` : ''}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

/** Saisie multiple de fournisseurs (cases à cocher). */
export function SupplierMultiPicker({ value, onChange, exclude = [] }: { value: string[]; onChange: (ids: string[]) => void; exclude?: string[] }) {
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term.trim(), 250);
  const q = useSuppliers(debounced);
  const items = (q.data?.items ?? []).filter((s) => !exclude.includes(s.id));
  return (
    <div className="rounded-md border border-line">
      <div className="border-b border-line p-2">
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Rechercher un fournisseur (nom, code)…" className="h-8 text-sm" aria-label="Rechercher un fournisseur" />
      </div>
      <ul className="max-h-56 overflow-y-auto p-1">
        {q.isLoading && <li className="px-2 py-2 text-sm text-ink-muted">Chargement…</li>}
        {!q.isLoading && !items.length && <li className="px-2 py-2 text-sm text-ink-muted">Aucun fournisseur actif.</li>}
        {items.map((s) => {
          const checked = value.includes(s.id);
          return (
            <li key={s.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-navy-50">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-line-strong text-action"
                  checked={checked}
                  onChange={() => onChange(checked ? value.filter((x) => x !== s.id) : [...value, s.id])}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{s.name}</span> <span className="text-xs text-ink-muted">{s.code}</span>
                </span>
                <span className="text-xs text-ink-muted">{s.email ?? 'sans e-mail'}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Champ quantité / montant décimal (saisie texte, virgule acceptée). */
export function DecimalInput({
  id,
  value,
  onChange,
  invalid,
  className,
  placeholder,
  ariaLabel,
  disabled,
  onKeyDown,
  inputRef,
  onPaste,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  inputRef?: Ref<HTMLInputElement>;
  onPaste?: ClipboardEventHandler<HTMLInputElement>;
}) {
  return (
    <Input
      id={id}
      ref={inputRef}
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      invalid={invalid}
      className={cn('text-right tabular', className)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}

/** Dialogue de résultat simple (lecture). */
export function InfoDialog({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="lg" footer={<Button onClick={() => onOpenChange(false)}>Fermer</Button>}>
      {children}
    </Dialog>
  );
}

/**
 * Commande avec commentaire / motif (facultatif ou obligatoire, ≥ 3 caractères si obligatoire).
 * Les erreurs API (409 version périmée, refus métier…) sont affichées sans fermer le dialogue.
 */
export function TextActionDialog({
  open,
  onOpenChange,
  title,
  description,
  label = 'Commentaire',
  required,
  confirmLabel,
  tone = 'primary',
  onConfirm,
  children,
  hint,
  maxLength = 2000,
  initial = '',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  label?: string;
  required?: boolean;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onConfirm: (text: string) => Promise<unknown>;
  children?: ReactNode;
  hint?: ReactNode;
  maxLength?: number;
  initial?: string;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const invalid = required && text.trim().length < 3;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setText(initial);
          setError(null);
        }
        onOpenChange(o);
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={invalid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(text.trim());
                setText(initial);
                onOpenChange(false);
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      <Field label={label} required={required} htmlFor={id} hint={hint ?? (required ? 'Obligatoire (3 caractères minimum) — conservé dans le journal d’audit.' : 'Facultatif — conservé dans le journal d’audit.')}>
        <textarea id={id} className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={maxLength} autoFocus />
      </Field>
      {error && (
        <p className="mt-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}


/** Choix d'une devise (liste usuelle + saisie libre ISO 4217). */
export function CurrencyInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value.toUpperCase().slice(0, 3))} list="pur-currencies" placeholder="EUR" />
      <datalist id="pur-currencies">
        {COMMON_CURRENCIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
  );
}

const LINKABLE = new Set<unknown>([Input, Select, Textarea, DecimalInput, CurrencyInput]);

/**
 * Champ de formulaire dont le libellé est TOUJOURS relié au contrôle (accessibilité) : l'identifiant est
 * généré et injecté dans le contrôle enfant (input, select, textarea, DecimalInput, CurrencyInput).
 */
export function FormField(props: ComponentProps<typeof Field>) {
  const auto = useId();
  const { children, htmlFor } = props;
  if (htmlFor || !isValidElement(children)) return <Field {...props} />;
  const t = children.type;
  if (typeof t !== 'string' && !LINKABLE.has(t)) return <Field {...props} />;
  const id = (children.props as { id?: string }).id ?? auto;
  return (
    <Field {...props} htmlFor={id}>
      {cloneElement(children as ReactElement<{ id?: string }>, { id })}
    </Field>
  );
}
