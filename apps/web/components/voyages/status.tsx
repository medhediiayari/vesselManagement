import { NOON_STATUS_LABELS, VOYAGE_STATUS_LABELS } from '@amc/types';
import {
  Archive,
  CalendarClock,
  CheckCheck,
  CheckCircle2,
  CircleDashed,
  Clock,
  FilePen,
  FileSignature,
  History,
  Navigation,
  RotateCcw,
  Send,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/badge';
import {
  CP_STATUS_LABELS,
  CP_VERSION_STATUS_LABELS,
  INSTRUCTION_STATUS_LABELS,
  NOTICE_STATUS_LABELS,
  TASK_STATUS_LABELS,
} from './lib';

interface StatusDef {
  tone: Tone;
  icon: LucideIcon;
}

/** Badge de statut : libellé + icône explicites (jamais la couleur seule). */
function StatusPill({ status, labels, defs, title }: { status: string; labels: Record<string, string>; defs: Record<string, StatusDef>; title?: string }) {
  const def = defs[status] ?? { tone: 'neutral' as Tone, icon: CircleDashed };
  const Icon = def.icon;
  return (
    <Badge tone={def.tone} icon={<Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />} title={title}>
      {labels[status] ?? status}
    </Badge>
  );
}

const VOYAGE: Record<string, StatusDef> = {
  DRAFT: { tone: 'neutral', icon: FilePen },
  PLANNED: { tone: 'info', icon: CalendarClock },
  ACTIVE: { tone: 'teal', icon: Navigation },
  COMPLETED: { tone: 'ok', icon: CheckCircle2 },
  CANCELLED: { tone: 'danger', icon: XCircle },
};
export function VoyageStatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} labels={VOYAGE_STATUS_LABELS} defs={VOYAGE} />;
}

const NOON: Record<string, StatusDef> = {
  DRAFT: { tone: 'neutral', icon: FilePen },
  SUBMITTED: { tone: 'info', icon: Send },
  ACKNOWLEDGED: { tone: 'ok', icon: CheckCheck },
  CORRECTION_REQUESTED: { tone: 'warn', icon: RotateCcw },
  CORRECTED: { tone: 'teal', icon: History },
  ARCHIVED: { tone: 'neutral', icon: Archive },
};
export function NoonStatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} labels={NOON_STATUS_LABELS} defs={NOON} />;
}

const NOTICE: Record<string, StatusDef> = {
  PLANNED: { tone: 'neutral', icon: CalendarClock },
  DRAFTED: { tone: 'info', icon: FilePen },
  VALIDATED: { tone: 'warn', icon: ShieldCheck },
  SENT: { tone: 'ok', icon: Send },
  CANCELLED: { tone: 'danger', icon: XCircle },
};
export function NoticeStatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} labels={NOTICE_STATUS_LABELS} defs={NOTICE} />;
}

const TASK: Record<string, StatusDef> = {
  OPEN: { tone: 'info', icon: Clock },
  DONE: { tone: 'ok', icon: CheckCircle2 },
  CANCELLED: { tone: 'neutral', icon: XCircle },
};
export function TaskStatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} labels={TASK_STATUS_LABELS} defs={TASK} />;
}

const INSTRUCTION: Record<string, StatusDef> = {
  DRAFT: { tone: 'neutral', icon: FilePen },
  ISSUED: { tone: 'ok', icon: CheckCircle2 },
  SUPERSEDED: { tone: 'neutral', icon: History },
};
export function InstructionStatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} labels={INSTRUCTION_STATUS_LABELS} defs={INSTRUCTION} />;
}

const CP: Record<string, StatusDef> = {
  DRAFT: { tone: 'neutral', icon: FilePen },
  PENDING_APPROVAL: { tone: 'warn', icon: Clock },
  APPROVED: { tone: 'ok', icon: FileSignature },
  SUPERSEDED: { tone: 'neutral', icon: History },
  CANCELLED: { tone: 'danger', icon: XCircle },
};
export function CpStatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} labels={CP_STATUS_LABELS} defs={CP} />;
}

const CP_VERSION: Record<string, StatusDef> = {
  PENDING_APPROVAL: { tone: 'warn', icon: Clock },
  APPROVED: { tone: 'ok', icon: CheckCircle2 },
  REJECTED: { tone: 'danger', icon: XCircle },
  RETURNED: { tone: 'warn', icon: RotateCcw },
  CANCELLED: { tone: 'neutral', icon: XCircle },
  DRAFT: { tone: 'neutral', icon: FilePen },
};
export function CpVersionStatusBadge({ status, opposable, superseded }: { status: string; opposable?: boolean; superseded?: boolean }) {
  if (status === 'APPROVED' && superseded) {
    return <StatusPill status="SUPERSEDED" labels={{ SUPERSEDED: 'Approuvée — remplacée' }} defs={{ SUPERSEDED: { tone: 'neutral', icon: History } }} />;
  }
  if (status === 'APPROVED' && opposable) {
    return <StatusPill status="OPPOSABLE" labels={{ OPPOSABLE: 'En vigueur (opposable)' }} defs={{ OPPOSABLE: { tone: 'ok', icon: ShieldCheck } }} />;
  }
  return <StatusPill status={status} labels={CP_VERSION_STATUS_LABELS} defs={CP_VERSION} />;
}
