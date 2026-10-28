'use client';

import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';
import { Button } from './button';
import { Field, Textarea } from './field';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-6xl' }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-navy-900/40" />
        <RD.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border-t-[3px] border-navy bg-white shadow-pop focus:outline-none',
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <RD.Title className="text-md font-semibold text-navy">{title}</RD.Title>
              {description ? (
                <RD.Description className="mt-0.5 text-sm text-ink-muted">{description}</RD.Description>
              ) : (
                <RD.Description className="sr-only">{title}</RD.Description>
              )}
            </div>
            <RD.Close className="rounded-md p-1 text-ink-muted hover:bg-navy-50" aria-label="Fermer">
              <X className="h-4 w-4" />
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/**
 * Confirmation des gestes sensibles (CDC §1.3) ; `requireReason` impose une justification
 * (refus, retour pour correction, annulation…).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  requireReason,
  reasonLabel = 'Motif',
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  requireReason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const disabled = requireReason && reason.trim().length < 3;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setReason('');
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
            disabled={disabled}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
                setReason('');
                onOpenChange(false);
              } catch (e) {
                toast.error(errorMessage(e));
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
      {requireReason ? (
        <Field label={reasonLabel} required hint="Obligatoire — conservé dans le journal d'audit.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
        </Field>
      ) : (
        <p className="text-sm text-ink-muted">Cette action est journalisée.</p>
      )}
    </Dialog>
  );
}
