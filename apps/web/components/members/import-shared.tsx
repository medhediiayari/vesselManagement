'use client';

import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  IMPORT_DECISION_LABELS,
  IMPORT_JOB_STATUS_LABELS,
  IMPORT_ROW_STATUS_LABELS,
  MEMBER_FIELD_LABELS,
  type ImportDecision,
  type ImportJob,
  type ImportJobStatus,
  type ImportRowStatus,
} from './types';

/** Champs Member importables (miroir de MEMBER_IMPORT_FIELDS côté API). */
export const MEMBER_IMPORT_FIELDS = [
  'amcRef',
  'lastName',
  'firstName',
  'birthDate',
  'birthPlace',
  'nationality',
  'gender',
  'email',
  'phone',
  'address',
  'emergencyContactName',
  'emergencyContactPhone',
  'passportNumber',
  'passportCountry',
  'passportExpiry',
  'seamanBookNumber',
  'seamanBookExpiry',
  'rank',
  'crewDepartment',
  'notes',
] as const;

export const EXTRA_TARGET_LABELS: Record<string, string> = {
  fullName: 'Nom et prénom (colonne unique, découpée)',
  joinDate: "Date d'embarquement",
  signOffDate: 'Date de débarquement',
  vessel: 'Navire (code, nom ou IMO)',
};

const CERT_PART_LABELS: Record<string, string> = {
  combined: 'cellule combinée (n°, échéance, PERMANENT)',
  number: 'numéro',
  expiry: "date d'expiration",
  issued: 'date de délivrance',
};

/** Libellé lisible d'une cible de mapping. */
export function targetLabel(target: string, certNames?: Map<string, string>): string {
  if (!target || target === 'ignore') return 'Ignorer la colonne';
  if (MEMBER_FIELD_LABELS[target]) return MEMBER_FIELD_LABELS[target];
  if (EXTRA_TARGET_LABELS[target]) return EXTRA_TARGET_LABELS[target];
  const m = /^certificate:([A-Z0-9_-]+)(?::(number|expiry|issued))?$/i.exec(target);
  if (m) {
    const code = m[1].toUpperCase();
    const name = certNames?.get(code);
    return `Certificat ${code}${name ? ` (${name})` : ''} — ${CERT_PART_LABELS[m[2] ?? 'combined']}`;
  }
  return target;
}

/** Types de certificats MEMBER (codes) : référentiel si consultable, sinon codes vus dans le classeur. */
export function useMemberCertificateTypes(job: ImportJob | undefined) {
  const { can } = useSession();
  const q = useQuery({
    queryKey: ['certificate-types', 'MEMBER'],
    queryFn: () => api.get<{ code: string; name: string; isActive: boolean }[]>('/certificate-types', { query: { subjectKind: 'MEMBER' } }),
    enabled: can('certificates.view'),
    staleTime: 300_000,
  });
  const names = new Map<string, string>();
  (Array.isArray(q.data) ? q.data : []).filter((t) => t.isActive !== false).forEach((t) => names.set(t.code.toUpperCase(), t.name));
  const fromJob = new Set<string>();
  job?.sheets.forEach((s) => s.columns.forEach((c) => c.suggested?.startsWith('certificate:') && fromJob.add(c.suggested.split(':')[1].toUpperCase())));
  job?.mapping?.forEach((s) => s.columns.forEach((c) => c.target.startsWith('certificate:') && fromJob.add(c.target.split(':')[1].toUpperCase())));
  const codes = [...new Set([...names.keys(), ...fromJob])].sort();
  return { codes, names };
}

const ROW_TONES: Record<ImportRowStatus, Tone> = {
  PENDING: 'neutral',
  VALID: 'ok',
  INVALID: 'danger',
  DUPLICATE_SUSPECTED: 'warn',
  APPLIED: 'teal',
  SKIPPED: 'neutral',
  FAILED: 'danger',
};

export function RowStatusBadge({ status }: { status: ImportRowStatus }) {
  return <Badge tone={ROW_TONES[status] ?? 'neutral'}>{IMPORT_ROW_STATUS_LABELS[status] ?? status}</Badge>;
}

const DECISION_TONES: Record<ImportDecision, Tone> = { PENDING: 'neutral', CREATE: 'info', UPDATE: 'navy', IGNORE: 'neutral', CORRECT: 'teal' };

export function DecisionBadge({ decision }: { decision: ImportDecision }) {
  return (
    <Badge tone={DECISION_TONES[decision] ?? 'neutral'} icon={false}>
      {IMPORT_DECISION_LABELS[decision] ?? decision}
    </Badge>
  );
}

const JOB_TONES: Record<ImportJobStatus, Tone> = {
  QUEUED: 'info',
  RUNNING: 'warn',
  COMPLETED: 'ok',
  PARTIALLY_FAILED: 'warn',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

export function JobStatusBadge({ status }: { status: ImportJobStatus }) {
  return <Badge tone={JOB_TONES[status] ?? 'neutral'}>{IMPORT_JOB_STATUS_LABELS[status] ?? status}</Badge>;
}

export type ImportStep = 'upload' | 'mapping' | 'preview' | 'result';

const STEPS: { id: ImportStep; label: string }[] = [
  { id: 'upload', label: 'Fichier' },
  { id: 'mapping', label: 'Mapping des colonnes' },
  { id: 'preview', label: 'Prévisualisation et décisions' },
  { id: 'result', label: 'Résultat' },
];

/** Indicateur d'étapes ; une étape atteignable est cliquable. */
export function ImportStepper({
  current,
  reachable,
  onSelect,
}: {
  current: ImportStep;
  reachable: Partial<Record<ImportStep, boolean>>;
  onSelect?: (s: ImportStep) => void;
}) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Étapes de l'import" className="mb-4">
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((s, i) => {
          const done = i < idx;
          const active = s.id === current;
          const clickable = !active && !!reachable[s.id] && !!onSelect;
          const content = (
            <>
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  active ? 'border-action bg-action text-white' : done ? 'border-teal bg-teal-50 text-teal-700' : 'border-line-strong bg-white text-ink-muted',
                )}
                aria-hidden
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn('text-sm', active ? 'font-semibold text-navy' : 'text-ink-muted')}>{s.label}</span>
            </>
          );
          return (
            <li key={s.id} className="flex items-center gap-2">
              {i > 0 && <span className="h-px w-6 bg-line-strong" aria-hidden />}
              {clickable ? (
                <button type="button" className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-navy-50" onClick={() => onSelect!(s.id)}>
                  {content}
                </button>
              ) : (
                <span className="flex items-center gap-2 px-1 py-0.5" aria-current={active ? 'step' : undefined}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Normalisation d'en-tête alignée sur l'API (accents, parenthèses, ponctuation). */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
