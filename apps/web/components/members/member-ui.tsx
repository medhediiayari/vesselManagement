'use client';

import { MEMBER_STATUS_LABELS } from '@amc/types';
import {
  Anchor,
  Ban,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Coffee,
  ExternalLink,
  Lock,
  LogOut,
  Ship,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SecureImage } from '@/components/amc/secure-image';
import { Badge, type Tone } from '@/components/ui/badge';
import { cn, fmtDate, initials } from '@/lib/format';
import {
  ASSIGNMENT_STATUS_LABELS,
  CREW_DEPARTMENT_LABELS,
  GENDER_LABELS,
  type AssignmentStatus,
  type CrewDepartment,
  type CustomFieldValue,
  type DuplicateCandidate,
  type MemberStatus,
} from './types';

const AVATAR_SIZES = { sm: 'h-8 w-8 text-xs', md: 'h-12 w-12 text-sm', lg: 'h-16 w-16 text-md' };

/** Photo de la fiche (miniature signée) ou initiales. */
export function MemberAvatar({
  photoFileId,
  name,
  size = 'sm',
  className,
}: {
  photoFileId: string | null | undefined;
  name: string;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
}) {
  const cls = cn('shrink-0 rounded-full', AVATAR_SIZES[size], className);
  if (photoFileId) return <SecureImage fileId={photoFileId} alt={`Photo de ${name}`} className={cls} />;
  return (
    <span className={cn(cls, 'flex items-center justify-center bg-navy-50 font-semibold text-navy-600')} aria-hidden>
      {initials(name)}
    </span>
  );
}

const STATUS_TONES: Record<MemberStatus, Tone> = {
  ON_BOARD: 'teal',
  AVAILABLE: 'ok',
  ON_LEAVE: 'info',
  PLANNED_JOIN: 'warn',
  INACTIVE: 'neutral',
};

const STATUS_ICONS: Record<MemberStatus, typeof Ship> = {
  ON_BOARD: Ship,
  AVAILABLE: CheckCircle2,
  ON_LEAVE: Coffee,
  PLANNED_JOIN: CalendarClock,
  INACTIVE: CircleSlash,
};

/** Statut Member : libellé + icône (jamais la couleur seule). */
export function MemberStatusBadge({ status }: { status: MemberStatus }) {
  const Icon = STATUS_ICONS[status] ?? CircleSlash;
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} icon={<Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}>
      {MEMBER_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const ASSIGNMENT_TONES: Record<AssignmentStatus, Tone> = { PLANNED: 'warn', ONBOARD: 'teal', COMPLETED: 'neutral', CANCELLED: 'danger' };
const ASSIGNMENT_ICONS: Record<AssignmentStatus, typeof Ship> = { PLANNED: CalendarClock, ONBOARD: Anchor, COMPLETED: LogOut, CANCELLED: Ban };

export function AssignmentStatusBadge({ status }: { status: AssignmentStatus }) {
  const Icon = ASSIGNMENT_ICONS[status];
  return (
    <Badge tone={ASSIGNMENT_TONES[status]} icon={<Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}>
      {ASSIGNMENT_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function DepartmentLabel({ value }: { value: CrewDepartment | null | undefined }) {
  return <>{value ? CREW_DEPARTMENT_LABELS[value] ?? value : '—'}</>;
}

/** Score de ressemblance d'un doublon potentiel (seuil fort : 70, comme l'API). */
export function ScoreBadge({ score }: { score: number }) {
  const strong = score >= 70;
  return (
    <Badge tone={strong ? 'danger' : 'warn'} title={`Score de ressemblance ${score}/100`}>
      {strong ? 'Forte présomption' : 'Ressemblance'} · {score}/100
    </Badge>
  );
}

/** Champ protégé non modifiable avec les droits courants. */
export function ProtectedMark({ label = 'Donnée protégée' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-muted" title="Modification réservée à la permission « données personnelles protégées »">
      <Lock className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

/** Candidats doublons renvoyés par l'API (identité détaillée uniquement si la fiche est visible, ADM-070). */
export function DuplicateCandidateList({
  candidates,
  emptyText,
  action,
}: {
  candidates: DuplicateCandidate[];
  emptyText?: string;
  action?: (c: DuplicateCandidate) => ReactNode;
}) {
  if (!candidates.length) return emptyText ? <p className="text-sm text-ink-muted">{emptyText}</p> : null;
  return (
    <ul className="space-y-2">
      {candidates.map((c) => (
        <li key={c.memberId} className="rounded-md border border-line bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ScoreBadge score={c.score} />
            {c.archived && (
              <Badge tone="neutral" icon={false}>
                Fiche archivée
              </Badge>
            )}
          </div>
          {c.member ? (
            <div className="mt-2 text-sm">
              <Link
                href={`/members/${c.memberId}`}
                target="_blank"
                className="inline-flex items-center gap-1 font-medium text-action hover:underline"
              >
                {c.member.lastName.toUpperCase()} {c.member.firstName}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">(ouvre un nouvel onglet)</span>
              </Link>
              <p className="text-xs text-ink-muted">
                {[
                  c.member.amcRef && `Matricule ${c.member.amcRef}`,
                  c.member.birthDate && `né(e) le ${fmtDate(c.member.birthDate)}`,
                  c.member.passportNumber && `passeport ${c.member.passportNumber}`,
                  c.member.seamanBookNumber && `seaman book ${c.member.seamanBookNumber}`,
                  c.member.rank,
                ]
                  .filter(Boolean)
                  .join(' — ') || 'Aucun identifiant renseigné'}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              <Lock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
              Fiche existante hors de votre périmètre : identité masquée. Rapprochez-vous de l’équipe Crewing.
            </p>
          )}
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-ink">
            {c.reasonLabels.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {action && <div className="mt-2">{action(c)}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Affichage lisible d'une valeur de champ personnalisé. */
export function formatCustomValue(f: Pick<CustomFieldValue, 'type' | 'value'>): string {
  const v = f.value;
  if (v === null || v === undefined || v === '') return '—';
  switch (f.type) {
    case 'BOOLEAN':
      return v === true ? 'Oui' : v === false ? 'Non' : String(v);
    case 'DATE':
      return fmtDate(String(v));
    case 'NUMBER':
      return new Intl.NumberFormat('fr-FR').format(Number(v));
    case 'SELECT':
      return Array.isArray(v) ? v.join(', ') : String(v);
    default:
      return String(v);
  }
}

/** Valeur brute (historique, diff) : dates civiles, booléens, listes, vide. */
export function formatPlainValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'crewDepartment') return CREW_DEPARTMENT_LABELS[v as CrewDepartment] ?? String(v);
  if (field === 'gender') return GENDER_LABELS[v as 'M'] ?? String(v);
  if (field === 'status') return MEMBER_STATUS_LABELS[String(v)] ?? String(v);
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Lien présenté comme un bouton (navigation, pas d'action) — mêmes styles que Button. */
export function ActionLink({
  href,
  children,
  variant = 'secondary',
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  className?: string;
}) {
  const styles = {
    primary: 'bg-action text-white hover:bg-action-700',
    secondary: 'bg-white text-ink border border-line-strong hover:bg-canvas',
    ghost: 'bg-transparent text-ink hover:bg-navy-50',
  }[variant];
  return (
    <Link href={href} className={cn('inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-base font-medium transition-colors', styles, className)}>
      {children}
    </Link>
  );
}

/** Nombre de jours entre deux dates civiles (inclusif côté début). */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = to ? Date.parse(`${to}T00:00:00Z`) : Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
