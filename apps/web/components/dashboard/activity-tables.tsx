'use client';

import { PR_STATUS_LABELS } from '@amc/types';
import { MapPin, Navigation } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, fmtDate, fmtDateTime, fmtRelative } from '@/lib/format';
import type { HorizonItem } from '@/components/amc/expiry-horizon';
import { PR_STATUS_TONES, PRIORITY_LABELS, PRIORITY_TONES } from '@/components/purchasing/lib';
import { Badge, StatusBadge, type Tone } from '@/components/ui/badge';
import { ScrollHint } from './dashboard-card';
import type { ActiveVoyage, RecentCsoDocument, RecentPurchaseRequest } from './types';

const muted = <span className="text-ink-soft">—</span>;

function Table({ caption, minWidth, head, children }: { caption: string; minWidth: string; head: ReactNode; children: ReactNode }) {
  return (
    <>
      <ScrollHint />
      <div className="relative -mx-4 overflow-x-auto">
        <table className={cn('table-amc', minWidth)}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="border-t border-line py-6 text-center text-sm text-ink-muted">{children}</p>;
}

// -----------------------------------------------------------------------------
// Voyages en cours
// -----------------------------------------------------------------------------

export function OngoingVoyages({ voyages, max = 6 }: { voyages: ActiveVoyage[]; max?: number }) {
  if (!voyages.length) return <Empty>Aucun voyage en cours dans votre périmètre.</Empty>;
  return (
    <Table
      caption="Voyages en cours : itinéraire déclaré, ETA et situation"
      minWidth="min-w-[640px]"
      head={
        <>
          <th scope="col">Navire</th>
          <th scope="col">Voyage</th>
          <th scope="col">Départ</th>
          <th scope="col">Arrivée</th>
          <th scope="col">ETA</th>
          <th scope="col">Situation</th>
        </>
      }
    >
      {voyages.slice(0, max).map((v) => (
        <tr key={v.id}>
          <td>
            <Link href={`/vessels/${v.vessel.id}`} className="block truncate font-medium text-navy hover:text-action hover:underline">
              {v.vessel.name}
            </Link>
          </td>
          <td>
            <Link href={`/voyages/${v.id}`} className="ref whitespace-nowrap text-action hover:underline">
              {v.reference}
            </Link>
            {v.charterer && <span className="block max-w-[160px] truncate text-xs text-ink-muted">{v.charterer}</span>}
          </td>
          <td className="text-sm">{v.departurePort ?? muted}</td>
          <td className="text-sm">{v.arrivalPort ?? muted}</td>
          <td className="tabular whitespace-nowrap text-sm">{v.eta ? fmtDateTime(v.eta) : muted}</td>
          <td>
            {v.alongsidePort ? (
              <Badge tone="info" icon={<MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />}>
                À quai · {v.alongsidePort}
              </Badge>
            ) : (
              <Badge tone="teal" icon={<Navigation className="h-3.5 w-3.5 shrink-0" aria-hidden />}>
                {v.nextPort ? `En route · ${v.nextPort.name}` : 'En route'}
              </Badge>
            )}
            {v.noonReportMissing && <span className="mt-0.5 block text-xs font-medium text-warn">Noon Report non reçu &gt; 30 h</span>}
          </td>
        </tr>
      ))}
    </Table>
  );
}

// -----------------------------------------------------------------------------
// Purchase Requests récentes
// -----------------------------------------------------------------------------

export function RecentPurchaseRequests({ items }: { items: RecentPurchaseRequest[] }) {
  if (!items.length) return <Empty>Aucune Purchase Request dans votre périmètre.</Empty>;
  return (
    <Table
      caption="Dernières Purchase Requests créées"
      minWidth="min-w-[470px]"
      head={
        <>
          <th scope="col">N° PR</th>
          <th scope="col">Navire / objet</th>
          <th scope="col">Besoin le</th>
          <th scope="col">Statut</th>
        </>
      }
    >
      {items.map((pr) => (
        <tr key={pr.id}>
          <td>
            <Link href={`/purchasing/requests/${pr.id}`} className="ref whitespace-nowrap font-medium text-action hover:underline">
              {pr.number}
            </Link>
          </td>
          <td className="max-w-[200px]">
            <span className="block truncate text-sm text-ink" title={pr.subject}>
              {pr.subject}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span className="truncate">{pr.vessel.name}</span>
              {(pr.priority === 'HIGH' || pr.priority === 'URGENT') && (
                <Badge tone={PRIORITY_TONES[pr.priority]} icon={false} className="px-1 py-0 text-2xs">
                  {PRIORITY_LABELS[pr.priority]}
                </Badge>
              )}
            </span>
          </td>
          <td className="tabular whitespace-nowrap text-sm">
            {pr.neededBy ? (
              <span className={cn(pr.overdue && 'font-semibold text-danger')}>
                {fmtDate(pr.neededBy)}
                {pr.overdue && <span className="block text-xs font-medium">Date dépassée</span>}
              </span>
            ) : (
              muted
            )}
          </td>
          <td>
            <StatusBadge status={pr.status} labels={PR_STATUS_LABELS} tones={PR_STATUS_TONES} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

// -----------------------------------------------------------------------------
// Échéances de certificats
// -----------------------------------------------------------------------------

function delay(days: number): { tone: Tone; label: string } {
  if (days < 0) return { tone: 'danger', label: `Expiré · ${-days} j` };
  if (days === 0) return { tone: 'danger', label: 'Aujourd’hui' };
  if (days <= 7) return { tone: 'danger', label: `${days} j` };
  if (days <= 15) return { tone: 'warn', label: `${days} j` };
  return { tone: 'info', label: `${days} j` };
}

export function ExpiringCertificates({ items, max = 6 }: { items: HorizonItem[]; max?: number }) {
  const rows = items.filter((c) => c.daysLeft <= 30).slice(0, max);
  if (!rows.length) return <Empty>Aucune échéance d’ici 30 jours dans votre périmètre.</Empty>;
  return (
    <Table
      caption="Certificats expirés depuis moins de 30 jours ou expirant dans les 30 prochains jours"
      minWidth="min-w-[450px]"
      head={
        <>
          <th scope="col">Certificat</th>
          <th scope="col">Titulaire</th>
          <th scope="col">Échéance</th>
          <th scope="col">Délai</th>
        </>
      }
    >
      {rows.map((c) => {
        const d = delay(c.daysLeft);
        return (
          <tr key={c.id}>
            <td className="max-w-[180px]">
              <Link href={`/certificates/${c.id}`} className="block truncate text-sm font-medium text-navy hover:text-action hover:underline" title={c.typeName}>
                {c.typeName}
              </Link>
              <span className="ref block text-xs text-ink-muted">{c.typeCode}</span>
            </td>
            <td className="max-w-[160px]">
              <span className="block truncate text-sm">{c.subject}</span>
              <span className="block text-xs text-ink-muted">
                {c.subjectKind === 'VESSEL' ? 'Navire' : 'Marin'}
                {c.renewalStatus === 'IN_PROGRESS' && ' · renouvellement en cours'}
              </span>
            </td>
            <td className="tabular whitespace-nowrap text-sm">{fmtDate(c.expiryOn)}</td>
            <td>
              <Badge tone={d.tone} className="tabular">
                {d.label}
              </Badge>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

// -----------------------------------------------------------------------------
// Documents CSO récents
// -----------------------------------------------------------------------------

function CsoStatus({ doc }: { doc: RecentCsoDocument }) {
  if (doc.pendingApproval) return <Badge tone="warn">En attente d’approbation</Badge>;
  if (doc.status === 'DRAFT') return <Badge tone="neutral">Brouillon</Badge>;
  return <Badge tone="ok">Publié</Badge>;
}

export function RecentCsoDocuments({ items }: { items: RecentCsoDocument[] }) {
  if (!items.length) return <Empty>Aucun document CSO accessible dans votre périmètre.</Empty>;
  return (
    <Table
      caption="Documents CSO modifiés récemment"
      minWidth="min-w-[470px]"
      head={
        <>
          <th scope="col">Document</th>
          <th scope="col">Catégorie</th>
          <th scope="col">Bibliothèque</th>
          <th scope="col">Statut</th>
        </>
      }
    >
      {items.map((doc) => (
        <tr key={doc.id}>
          <td className="max-w-[220px]">
            <Link href={`/cso/documents/${doc.id}`} className="block truncate text-sm font-medium text-navy hover:text-action hover:underline" title={doc.title}>
              {doc.title}
            </Link>
            <span className="block truncate text-xs text-ink-muted">
              {doc.reference && <span className="ref">{doc.reference} · </span>}
              <span title={fmtDateTime(doc.updatedAt)}>modifié {fmtRelative(doc.updatedAt)}</span>
            </span>
          </td>
          <td className="max-w-[130px] truncate text-sm" title={doc.category?.name}>
            {doc.category?.name ?? muted}
          </td>
          <td className="max-w-[140px] truncate text-sm">{doc.vessel ? doc.vessel.name : <span className="text-ink-muted">Centrale AMC</span>}</td>
          <td>
            <CsoStatus doc={doc} />
          </td>
        </tr>
      ))}
    </Table>
  );
}
