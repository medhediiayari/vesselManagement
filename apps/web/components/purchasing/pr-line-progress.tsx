'use client';

import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { cn, fmtDecimal } from '@/lib/format';
import { dec } from './lib';
import type { PrLineProgressData } from './types';
import { LineBadge } from './ui';

/**
 * PRLineProgress — avancement d'une ligne PR « compréhensible en un regard » (CDC V1 §9.2, priorité UI 4) :
 * barre segmentée + libellés texte. Les manquants ne sont jamais cachés : « À commander » et « Reste à
 * recevoir » sont toujours affichés, même à zéro. Un BL n'est pas une preuve de réception : « Sur BL » et
 * « Reçu / accepté » sont deux segments distincts.
 */

interface Segment {
  key: string;
  label: string;
  value: string;
  /** classes de la barre (couleur + motif) */
  bar: string;
  /** pastille de légende */
  dot: string;
}

const STRIPES = 'bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,255,255,0.55)_4px_7px)]';

function fullSegments(p: PrLineProgressData): Segment[] {
  const onNoteNotReceived = dec.max0(dec.sub(p.onDeliveryNotes, p.received));
  const physicalOrNote = dec.cmp(p.onDeliveryNotes, p.received) >= 0 ? p.onDeliveryNotes : p.received;
  const orderedNotShipped = dec.max0(dec.sub(p.ordered, physicalOrNote));
  const inPreparation = dec.max0(dec.sub(p.allocated, p.ordered));
  return [
    { key: 'accepted', label: 'Reçu / accepté', value: p.accepted, bar: 'bg-ok', dot: 'bg-ok' },
    { key: 'rejected', label: 'Reçu rejeté', value: p.rejected, bar: 'bg-danger', dot: 'bg-danger' },
    { key: 'onNote', label: 'Sur BL, non reçu', value: onNoteNotReceived, bar: 'bg-teal', dot: 'bg-teal' },
    { key: 'ordered', label: 'Commandé, non livré', value: orderedNotShipped, bar: 'bg-action', dot: 'bg-action' },
    { key: 'prep', label: 'BC en préparation', value: inPreparation, bar: cn('bg-action/40', STRIPES), dot: 'bg-action/40' },
    { key: 'toOrder', label: 'À commander', value: p.toOrder, bar: cn('bg-warn/70', STRIPES), dot: 'bg-warn/70' },
    { key: 'cancelled', label: 'Annulé', value: p.cancelled, bar: cn('bg-neutral-line', STRIPES), dot: 'bg-neutral-line' },
  ];
}

function Bar({ segments, total, label, className }: { segments: Segment[]; total: string; label: string; className?: string }) {
  const sum = dec.add(...segments.map((s) => s.value));
  const base = dec.cmp(sum, total) > 0 ? sum : total;
  return (
    <div className={cn('flex h-2.5 w-full overflow-hidden rounded-full bg-navy-50 ring-1 ring-inset ring-line', className)} role="img" aria-label={label}>
      {segments
        .filter((s) => dec.gt0(s.value))
        .map((s) => (
          <span key={s.key} className={cn('h-full', s.bar)} style={{ width: `${dec.percentOf(s.value, base)}%` }} title={`${s.label} : ${fmtDecimal(s.value)}`} />
        ))}
    </div>
  );
}

function Figure({ label, value, unit, tone, dot }: { label: string; value: string | null; unit: string; tone?: 'warn' | 'danger' | 'ok' | 'muted'; dot?: string }) {
  const color = tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : tone === 'muted' ? 'text-ink-muted' : 'text-ink';
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 whitespace-nowrap text-[11px] leading-4 text-ink-muted">
        {dot && <span className={cn('inline-block h-2 w-2 shrink-0 rounded-sm', dot)} aria-hidden />}
        {label}
      </dt>
      <dd className={cn('text-sm font-medium tabular', color)}>
        {value === null ? '—' : fmtDecimal(value)}
        {value !== null && <span className="ml-0.5 text-[11px] font-normal text-ink-muted">{unit}</span>}
      </dd>
    </div>
  );
}

export function PRLineProgress({
  progress,
  unit,
  variant = 'full',
  showOrders = false,
  className,
}: {
  progress: PrLineProgressData;
  unit: string;
  variant?: 'full' | 'compact';
  showOrders?: boolean;
  className?: string;
}) {
  const segments = fullSegments(progress);
  const working = dec.add(progress.effective, progress.cancelled);
  const remaining = dec.max0(dec.sub(progress.effective, progress.accepted));
  const summary =
    `Demandé ${fmtDecimal(progress.requested)} ${unit}, ` +
    (progress.approved !== null ? `validé ${fmtDecimal(progress.approved)}, ` : '') +
    `commandé ${fmtDecimal(progress.ordered)}, sur BL ${fmtDecimal(progress.onDeliveryNotes)}, reçu accepté ${fmtDecimal(progress.accepted)}, ` +
    `reste à recevoir ${fmtDecimal(remaining)}, à commander ${fmtDecimal(progress.toOrder)}, annulé ${fmtDecimal(progress.cancelled)}`;

  if (variant === 'compact') {
    return (
      <div className={cn('min-w-[160px]', className)}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <LineBadge badge={progress.badge} />
          <span className="text-xs tabular text-ink-muted">
            {fmtDecimal(progress.accepted)}/{fmtDecimal(progress.effective)} {unit} reçus
          </span>
        </div>
        <Bar segments={segments} total={working} label={summary} />
        {dec.gt0(remaining) && (
          <p className="mt-0.5 text-[11px] text-warn">
            Reste {fmtDecimal(remaining)} {unit}
            {dec.gt0(progress.toOrder) ? ` dont ${fmtDecimal(progress.toOrder)} à commander` : ''}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center gap-2">
        <LineBadge badge={progress.badge} />
        <Bar segments={segments} total={working} label={summary} className="flex-1" />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4 2xl:grid-cols-8">
        <Figure label="Demandé" value={progress.requested} unit={unit} />
        <Figure label="Validé" value={progress.approved} unit={unit} tone={progress.approved === null ? 'muted' : undefined} />
        <Figure label="Commandé" value={progress.ordered} unit={unit} dot="bg-action" />
        <Figure label="Sur BL" value={progress.onDeliveryNotes} unit={unit} dot="bg-teal" />
        <Figure label="Reçu / accepté" value={progress.accepted} unit={unit} dot="bg-ok" tone={dec.gt0(progress.accepted) ? 'ok' : undefined} />
        <Figure label="Rejeté" value={progress.rejected} unit={unit} dot="bg-danger" tone={dec.gt0(progress.rejected) ? 'danger' : 'muted'} />
        <Figure label="Reste à recevoir" value={remaining} unit={unit} tone={dec.gt0(remaining) ? 'warn' : 'muted'} />
        <Figure label="Annulé" value={progress.cancelled} unit={unit} dot="bg-neutral-line" tone="muted" />
      </dl>
      {(dec.gt0(progress.toOrder) || dec.gt0(dec.sub(progress.allocated, progress.ordered))) && (
        <div className="flex flex-wrap items-center gap-2">
          {dec.gt0(progress.toOrder) && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-warn-line bg-warn-bg px-2.5 py-1 text-sm font-semibold text-warn">
              <ShoppingCart className="h-4 w-4" aria-hidden />
              À commander : <span className="tabular">{fmtDecimal(progress.toOrder)}</span> {unit}
            </span>
          )}
          {dec.gt0(dec.sub(progress.allocated, progress.ordered)) && (
            <span className="text-xs text-ink-muted">
              BC en préparation / second regard : {fmtDecimal(dec.sub(progress.allocated, progress.ordered))} {unit}
            </span>
          )}
        </div>
      )}
      {showOrders && progress.orders.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <span>BC :</span>
          {progress.orders.map((o) => (
            <Link key={`${o.poId}-${o.quantity}`} href={`/purchasing/orders/${o.poId}`} className="rounded border border-line px-1.5 py-0.5 font-medium text-action hover:underline">
              {o.poNumber} · {fmtDecimal(o.quantity)} {unit}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

/** Légende de la barre (une fois par tableau). */
export function PRLineProgressLegend({ className }: { className?: string }) {
  const items = fullSegments({
    prLineId: '',
    lineNo: 0,
    requested: '0',
    approved: null,
    cancelled: '0',
    effective: '0',
    allocated: '0',
    ordered: '0',
    onDeliveryNotes: '0',
    received: '0',
    accepted: '0',
    rejected: '0',
    toOrder: '0',
    orderedNotShipped: '0',
    onNoteNotReceived: '0',
    orderedNotAccepted: '0',
    badge: 'NOT_ORDERED',
    orders: [],
  });
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted', className)} aria-label="Légende de l'avancement">
      {items.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1">
          <span className={cn('inline-block h-2.5 w-4 rounded-sm', s.bar)} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Variante liste (données réduites de GET /purchase-requests : demandé / effectif / commandé / accepté). */
export function PRLineMiniProgress({
  line,
}: {
  line: { requested: string; effective: string; ordered: string; accepted: string; badge: string; unit: string };
}) {
  const orderedNotAccepted = dec.max0(dec.sub(line.ordered, line.accepted));
  const notOrdered = dec.max0(dec.sub(line.effective, line.ordered));
  const segments: Segment[] = [
    { key: 'accepted', label: 'Reçu / accepté', value: line.accepted, bar: 'bg-ok', dot: 'bg-ok' },
    { key: 'ordered', label: 'Commandé, non reçu', value: orderedNotAccepted, bar: 'bg-action', dot: 'bg-action' },
    { key: 'toOrder', label: 'Non commandé', value: notOrdered, bar: cn('bg-warn/70', STRIPES), dot: 'bg-warn/70' },
  ];
  return (
    <Bar
      segments={segments}
      total={line.effective}
      className="h-1.5"
      label={`Commandé ${fmtDecimal(line.ordered)} / ${fmtDecimal(line.effective)} ${line.unit}, reçu ${fmtDecimal(line.accepted)}`}
    />
  );
}
