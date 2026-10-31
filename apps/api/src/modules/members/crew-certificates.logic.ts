import { flagCertificate, type CertificateFlag } from '../voyages/voyages.logic';

/**
 * Contrôle des certificats d'un marin à la planification / à l'embarquement (règles pures, sans
 * accès base, testées dans crew-certificates.logic.spec.ts). Avertissement NON bloquant : signale
 * les certificats expirés ou qui expirent avant la fin prévue de la période d'embarquement.
 * Le PDF justificatif est facultatif pour les marins : aucun signal « document manquant » ici.
 */

/** Certificat courant d'un marin (non archivé, révision courante présente). */
export interface CrewCertificateInput {
  id: string;
  currentNumber: string | null;
  currentExpiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN' | null;
  currentExpiryOn: Date | null;
  type: { name: string; code: string };
}

export interface CrewCertificateAlert {
  certificateId: string;
  typeName: string;
  typeCode: string;
  number: string | null;
  /** AAAA-MM-JJ */
  expiryOn: string | null;
  flag: CertificateFlag;
}

export interface CrewCertificateCounts {
  expired: number;
  expiringBeforeEnd: number;
  expiryUnknown: number;
}

const FLAG_ORDER: Record<CertificateFlag, number> = { EXPIRED: 0, EXPIRES_BEFORE_VOYAGE_END: 1, EXPIRY_UNKNOWN: 2 };

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Fin de la période contrôlée : débarquement prévu ; avec un voyage, le plus tardif entre ce
 * débarquement et la fin estimée du voyage (ETA, sinon fin de laycan). null si rien n'est connu.
 */
export function crewCheckEnd(plannedSignOffDate: Date | null | undefined, voyage?: { eta: Date | null; laycanTo: Date | null } | null): Date | null {
  const voyageEnd = voyage ? (voyage.eta ?? voyage.laycanTo) : null;
  const candidates = [plannedSignOffDate ?? null, voyageEnd].filter((d): d is Date => !!d);
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/**
 * Alertes triées (expirés d'abord, puis échéance croissante, échéance inconnue en dernier) et
 * compteurs. Sans date de fin, seuls les expirés et les échéances inconnues sont signalés.
 */
export function crewCertificateAlerts(
  certs: CrewCertificateInput[],
  end: Date | null,
  today: Date,
): { items: CrewCertificateAlert[]; counts: CrewCertificateCounts } {
  const items: CrewCertificateAlert[] = [];
  for (const c of certs) {
    const flag = flagCertificate({ expiryKind: c.currentExpiryKind, expiryOn: c.currentExpiryOn }, end, today);
    if (!flag) continue;
    items.push({
      certificateId: c.id,
      typeName: c.type.name,
      typeCode: c.type.code,
      number: c.currentNumber,
      expiryOn: flag === 'EXPIRY_UNKNOWN' ? null : ymd(c.currentExpiryOn),
      flag,
    });
  }
  items.sort(
    (a, b) =>
      FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag] ||
      (a.expiryOn ?? '9999-12-31').localeCompare(b.expiryOn ?? '9999-12-31') ||
      a.typeName.localeCompare(b.typeName, 'fr'),
  );
  return {
    items,
    counts: {
      expired: items.filter((i) => i.flag === 'EXPIRED').length,
      expiringBeforeEnd: items.filter((i) => i.flag === 'EXPIRES_BEFORE_VOYAGE_END').length,
      expiryUnknown: items.filter((i) => i.flag === 'EXPIRY_UNKNOWN').length,
    },
  };
}

/** "AAAA-MM-JJ" -> "JJ/MM/AAAA". */
export function frDate(s: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Messages lisibles (ajoutés aux `warnings` de la planification / de l'embarquement). */
export function crewCertificateWarningMessages(items: CrewCertificateAlert[], end: Date | null): string[] {
  const endStr = frDate(ymd(end));
  const out: string[] = [];
  for (const i of items) {
    if (i.flag === 'EXPIRED') out.push(`Certificat « ${i.typeName} » expiré depuis le ${frDate(i.expiryOn)}`);
    else if (i.flag === 'EXPIRES_BEFORE_VOYAGE_END') {
      out.push(`Certificat « ${i.typeName} » : expire le ${frDate(i.expiryOn)}, avant la fin prévue de l'embarquement (${endStr})`);
    }
  }
  const unknown = items.filter((i) => i.flag === 'EXPIRY_UNKNOWN').length;
  if (unknown) out.push(`${unknown} certificat${unknown > 1 ? 's' : ''} sans date d'échéance`);
  return out;
}

/** Liste courte conservée dans les métadonnées d'audit. */
export function crewCertificateAuditSummary(items: CrewCertificateAlert[]): { typeName: string; expiryOn: string | null; flag: CertificateFlag }[] {
  return items.map((i) => ({ typeName: i.typeName, expiryOn: i.expiryOn, flag: i.flag }));
}
