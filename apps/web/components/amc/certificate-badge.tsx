import { VALIDITY_LABELS, type ValidityStatus } from '@amc/types';
import { FileWarning, HelpCircle, Infinity as InfinityIcon } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/badge';
import { daysUntil, fmtDate } from '@/lib/format';

const TONE: Record<ValidityStatus, Tone> = {
  VALID: 'ok',
  EXPIRING_SOON: 'warn',
  EXPIRED: 'danger',
  UNLIMITED: 'info',
  EXPIRY_UNKNOWN: 'neutral',
};

/**
 * Statut de validité d'un certificat : libellé + icône + échéance (jamais la couleur seule).
 * La validité réelle reste distincte du suivi de renouvellement (CDC §4.3).
 */
export function CertificateBadge({
  status,
  expiryOn,
  compact,
}: {
  status: ValidityStatus | string;
  expiryOn?: string | null;
  compact?: boolean;
}) {
  const s = status as ValidityStatus;
  const days = daysUntil(expiryOn ?? null);
  let detail = '';
  if (!compact && expiryOn && days !== null) {
    detail = days < 0 ? ` depuis ${Math.abs(days)} j` : days === 0 ? " aujourd'hui" : ` dans ${days} j`;
  }
  const icon =
    s === 'UNLIMITED' ? <InfinityIcon className="h-3.5 w-3.5" aria-hidden /> : s === 'EXPIRY_UNKNOWN' ? <HelpCircle className="h-3.5 w-3.5" aria-hidden /> : undefined;
  return (
    <Badge tone={TONE[s] ?? 'neutral'} icon={icon} title={expiryOn ? `Échéance : ${fmtDate(expiryOn)}` : undefined}>
      {VALIDITY_LABELS[s] ?? status}
      {detail}
    </Badge>
  );
}

/** Badge « Document manquant » : reste affiché tant qu'aucune pièce n'est OFFICIELLE (CERT-05). */
export function MissingDocumentBadge() {
  return (
    <Badge tone="warn" icon={<FileWarning className="h-3.5 w-3.5" aria-hidden />}>
      Document manquant
    </Badge>
  );
}
