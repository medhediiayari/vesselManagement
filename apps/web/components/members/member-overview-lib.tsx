'use client';

import { Badge, type Tone } from '@/components/ui/badge';
import { cn, daysUntil } from '@/lib/format';
import type { MemberCertificateCounts } from './types';

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** Code pays ISO 3166-1 alpha-2 -> nom français (« TN » -> « Tunisie »), le code restant visible à côté. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export type DocState = 'MISSING' | 'EXPIRED' | 'EXPIRING_SOON' | 'VALID' | 'NO_DATE';

/** Validité d'une pièce d'identité maritime (passeport, seaman book) selon le seuil paramétré des certificats. */
export function documentState(number: string | null | undefined, expiry: string | null | undefined, soonDays: number): DocState {
  if (!number && !expiry) return 'MISSING';
  if (!expiry) return 'NO_DATE';
  const d = daysUntil(expiry)!;
  if (d < 0) return 'EXPIRED';
  return d <= soonDays ? 'EXPIRING_SOON' : 'VALID';
}

const DOC_STATE: Record<DocState, { tone: Tone; label: string }> = {
  VALID: { tone: 'ok', label: 'Valide' },
  EXPIRING_SOON: { tone: 'warn', label: 'Expire bientôt' },
  EXPIRED: { tone: 'danger', label: 'Expiré' },
  NO_DATE: { tone: 'neutral', label: 'Date non renseignée' },
  MISSING: { tone: 'neutral', label: 'Non renseigné' },
};

export function DocStateBadge({ state }: { state: DocState }) {
  const s = DOC_STATE[state];
  return (
    <Badge tone={s.tone} icon={state === 'MISSING' || state === 'NO_DATE' ? false : undefined}>
      {s.label}
    </Badge>
  );
}

/** Délai avant une échéance, toujours en texte (jamais la couleur seule). */
export function DelayBadge({ days }: { days: number }) {
  // Mêmes paliers que les échéances du tableau de bord
  const tone: Tone = days <= 7 ? 'danger' : days <= 15 ? 'warn' : 'info';
  const label = days < 0 ? `Expiré · ${-days} j` : days === 0 ? 'Aujourd’hui' : `${days} j`;
  return (
    <Badge tone={tone} className="tabular">
      {label}
    </Badge>
  );
}

/** Certificats en validité / total. « Échéance inconnue » et « non approuvé » ne comptent jamais comme valides. */
export function inForce(c: MemberCertificateCounts) {
  return c.valid + c.unlimited + c.expiringSoon;
}

export function CertificateRatio({ c, className }: { c: MemberCertificateCounts; className?: string }) {
  if (!c.total) return <span className={cn('text-sm text-ink-muted', className)}>Aucun</span>;
  const ok = inForce(c);
  const tone: Tone = c.expired ? 'danger' : c.expiringSoon || c.expiryUnknown || c.notApproved ? 'warn' : 'ok';
  const detail = [
    c.expired && `${c.expired} expiré${c.expired > 1 ? 's' : ''}`,
    c.expiringSoon && `${c.expiringSoon} expire${c.expiringSoon > 1 ? 'nt' : ''} bientôt`,
    c.expiryUnknown && `${c.expiryUnknown} échéance inconnue`,
    c.notApproved && `${c.notApproved} non approuvé${c.notApproved > 1 ? 's' : ''}`,
  ].filter(Boolean) as string[];
  return (
    <span className={cn('inline-flex flex-col items-start', className)} title={detail.join(' · ') || 'Tous les certificats sont en validité'}>
      <Badge tone={tone} className="tabular">
        <span className="sr-only">Certificats en validité : </span>
        {ok} / {c.total}
      </Badge>
      {detail[0] && <span className={cn('mt-0.5 text-xs', tone === 'danger' ? 'text-danger' : 'text-warn')}>{detail[0]}</span>}
    </span>
  );
}
