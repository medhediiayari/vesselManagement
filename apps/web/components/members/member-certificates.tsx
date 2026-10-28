'use client';

import { useQuery } from '@tanstack/react-query';
import { Clock, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { CertificateBadge, MissingDocumentBadge } from '@/components/amc/certificate-badge';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { api, type Page } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { MemberDetail } from './types';

interface CertificateListItem {
  id: string;
  type: { id?: string; code: string; name: string; category: string | null };
  currentNumber: string | null;
  currentExpiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN' | null;
  currentExpiryOn: string | null;
  validity: string | null;
  documentMissing: boolean;
  /** Le type exige une pièce officielle (sinon aucun signal « document manquant ») */
  documentRequired: boolean;
  openRequest: { id: string; status: string; statusLabel?: string } | null;
  pendingAttachmentRequest: { id: string; status: string; statusLabel?: string } | null;
  renewal: { status: string } | null;
}

interface Row {
  id: string;
  code: string;
  name: string;
  category: string | null;
  number: string | null;
  expiryKind: string | null;
  expiryOn: string | null;
  validity: string | null;
  documentMissing: boolean;
  pending: string | null;
}

function ValidityCell({ validity, expiryOn }: { validity: string | null; expiryOn: string | null }) {
  if (!validity || validity === 'NOT_APPROVED') {
    return (
      <Badge tone="info" icon={<Clock className="h-3.5 w-3.5" aria-hidden />}>
        En attente d’approbation
      </Badge>
    );
  }
  return <CertificateBadge status={validity} expiryOn={expiryOn} />;
}

function expiryText(kind: string | null, on: string | null) {
  if (kind === 'UNLIMITED') return 'Permanent';
  if (kind === 'UNKNOWN') return 'Inconnue';
  return on ? fmtDate(on) : '—';
}

/**
 * Onglet Certificats : explorateur certificats filtré sur la fiche (certificates.view), sinon la
 * synthèse incluse dans la fiche (members.certificates.view). Statuts libellés, permanents distincts.
 */
export function MemberCertificates({ member, summaryOnly }: { member: MemberDetail; summaryOnly?: boolean }) {
  const { can } = useSession();
  // Libre-service : la synthèse de la fiche fait foi (l'explorateur applique ses propres périmètres)
  const full = !summaryOnly && can('certificates.view');
  const q = useQuery({
    queryKey: ['member-certificates', member.id],
    queryFn: () => api.get<Page<CertificateListItem>>('/certificates', { query: { memberId: member.id, subjectKind: 'MEMBER', limit: 200 } }),
    enabled: full,
  });

  let rows: Row[] | undefined;
  if (full) {
    rows = q.data?.items.map((c) => ({
      id: c.id,
      code: c.type.code,
      name: c.type.name,
      category: c.type.category,
      number: c.currentNumber,
      expiryKind: c.currentExpiryKind,
      expiryOn: c.currentExpiryOn ? String(c.currentExpiryOn).slice(0, 10) : null,
      validity: c.validity,
      documentMissing: c.documentMissing && c.documentRequired,
      pending: c.openRequest?.statusLabel ?? c.pendingAttachmentRequest?.statusLabel ?? null,
    }));
  } else {
    rows = (member.certificates ?? []).map((c) => ({
      id: c.id,
      code: c.type.code,
      name: c.type.name,
      category: c.type.category,
      number: c.number,
      expiryKind: c.expiryKind,
      expiryOn: c.expiryOn,
      validity: c.validity,
      documentMissing: c.documentMissing,
      pending: c.openRequests.length ? 'Demande en cours' : null,
    }));
  }

  return (
    <Panel
      title="Certificats"
      bodyClassName="p-0"
      actions={
        full ? (
          <Link
            href={`/certificates?memberId=${member.id}&subjectKind=MEMBER`}
            className="inline-flex items-center gap-1 text-sm font-medium text-action hover:underline"
          >
            Explorateur de certificats <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : undefined
      }
    >
      {full && q.isLoading && <LoadingBlock rows={4} />}
      {full && q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {rows && rows.length === 0 && (
        <EmptyState title="Aucun certificat" description="Les certificats importés ou saisis apparaissent ici, même sans scan (document manquant)." />
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table-amc">
            <caption className="sr-only">Certificats de la fiche</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Numéro</th>
                <th scope="col">Échéance</th>
                <th scope="col">Validité</th>
                <th scope="col" className="hidden md:table-cell">
                  Pièce et demandes
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {full ? (
                      <Link href={`/certificates/${r.id}`} className="font-medium text-action hover:underline">
                        {r.code}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.code}</span>
                    )}
                    <span className="block text-xs text-ink-muted">
                      {r.name}
                      {r.category ? ` — ${r.category}` : ''}
                    </span>
                  </td>
                  <td className="tabular">{r.number ?? '—'}</td>
                  <td className="tabular">{expiryText(r.expiryKind, r.expiryOn)}</td>
                  <td>
                    <ValidityCell validity={r.validity} expiryOn={r.expiryOn} />
                  </td>
                  <td className="hidden md:table-cell">
                    <span className="flex flex-wrap gap-1">
                      {r.documentMissing && <MissingDocumentBadge />}
                      {r.pending && (
                        <Badge tone="warn" icon={<Clock className="h-3.5 w-3.5" aria-hidden />}>
                          {r.pending}
                        </Badge>
                      )}
                      {!r.documentMissing && !r.pending && <span className="text-ink-soft">—</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
