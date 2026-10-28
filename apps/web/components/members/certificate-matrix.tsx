'use client';

import { AlertTriangle, Clock, HelpCircle, Infinity as InfinityIcon, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { cn } from '@/lib/format';
import { ScrollHint } from '@/components/dashboard/dashboard-card';
import { MemberAvatar } from './member-ui';
import { memberName, type MemberListItem, type MemberMatrixCertificate, type MemberMatrixMeta } from './types';

type Validity = MemberMatrixCertificate['validity'];

const CELL: Record<Validity, { cls: string; label: string; icon?: typeof XCircle }> = {
  EXPIRED: { cls: 'bg-danger-bg text-danger', label: 'expiré', icon: XCircle },
  EXPIRING_SOON: { cls: 'bg-warn-bg text-warn', label: 'expire bientôt', icon: AlertTriangle },
  VALID: { cls: 'bg-ok-bg text-ok', label: 'valide' },
  UNLIMITED: { cls: 'bg-teal-50 text-teal-700', label: 'validité illimitée', icon: InfinityIcon },
  EXPIRY_UNKNOWN: { cls: 'bg-neutral-bg text-neutral', label: 'échéance inconnue', icon: HelpCircle },
  NOT_APPROVED: { cls: 'bg-info-bg text-info', label: 'en attente d’approbation', icon: Clock },
};

const shortDate = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' });

/** Un certificat par type et par marin : en cas de doublon, le plus tardif (illimité d'abord). */
function byType(certs: MemberMatrixCertificate[] | undefined) {
  const out = new Map<string, MemberMatrixCertificate>();
  for (const c of certs ?? []) {
    const prev = out.get(c.typeCode);
    const rank = (x: MemberMatrixCertificate) => (x.expiryKind === 'UNLIMITED' ? '9999' : x.expiryOn ?? '0000');
    if (!prev || rank(c) > rank(prev)) out.set(c.typeCode, c);
  }
  return out;
}

function Cell({ cert, typeName }: { cert: MemberMatrixCertificate | undefined; typeName: string }) {
  if (!cert) return <span className="text-ink-soft" aria-label={`${typeName} : aucun certificat`}>—</span>;
  const s = CELL[cert.validity];
  const value = cert.expiryKind === 'UNLIMITED' ? 'Illimité' : cert.expiryOn ? shortDate.format(new Date(`${cert.expiryOn}T00:00:00Z`)) : '?';
  return (
    <Link
      href={`/certificates/${cert.id}`}
      className={cn('inline-flex min-w-[76px] items-center justify-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium tabular hover:ring-1 hover:ring-current', s.cls)}
      title={`${typeName} — ${s.label}${cert.expiryOn ? ` (échéance ${shortDate.format(new Date(`${cert.expiryOn}T00:00:00Z`))})` : ''}`}
    >
      {s.icon && <s.icon className="h-3 w-3 shrink-0" aria-hidden />}
      {value}
      <span className="sr-only"> : {s.label}</span>
    </Link>
  );
}

/**
 * Matrice des certificats de l'équipage (comme la matrice Excel AMC) : une ligne par marin, une colonne par type
 * de certificat, échéance colorée ET libellée (icône + texte pour les lecteurs d'écran). Chaque case ouvre le certificat.
 * Les types sans aucun certificat dans les fiches chargées sont masqués par défaut.
 */
export function CertificateMatrix({
  rows,
  meta,
  loading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  loadingMore,
  total,
  soonDays,
}: {
  rows: MemberListItem[] | undefined;
  meta: MemberMatrixMeta | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  total: number | undefined;
  soonDays: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  const types = meta?.certificateTypes ?? [];
  const maps = new Map((rows ?? []).map((m) => [m.id, byType(m.certificates)]));
  const used = types.filter((t) => [...maps.values()].some((mp) => mp.has(t.code)));
  const columns = showAll ? types : used;
  const hidden = types.length - used.length;
  const expiredCount = (code: string) => [...maps.values()].filter((mp) => mp.get(code)?.validity === 'EXPIRED').length;
  const soonCount = (code: string) => [...maps.values()].filter((mp) => mp.get(code)?.validity === 'EXPIRING_SOON').length;

  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2.5 text-xs text-ink-muted">
        <span className="font-medium text-ink">Légende :</span>
        {(['EXPIRED', 'EXPIRING_SOON', 'VALID', 'UNLIMITED', 'EXPIRY_UNKNOWN'] as Validity[]).map((v) => {
          const s = CELL[v];
          return (
            <span key={v} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium', s.cls)}>
              {s.icon && <s.icon className="h-3 w-3" aria-hidden />}
              {v === 'EXPIRING_SOON' ? `Expire sous ${soonDays} j` : s.label.charAt(0).toUpperCase() + s.label.slice(1)}
            </span>
          );
        })}
        <span>— : aucun certificat</span>
        {hidden > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto text-action" onClick={() => setShowAll((x) => !x)}>
            {showAll ? 'Masquer les types sans certificat' : `Afficher tous les types (${hidden} sans certificat)`}
          </Button>
        )}
      </div>
      <div className="px-3 pt-2">
        <ScrollHint />
      </div>
      <div className="relative max-h-[70vh] overflow-auto">
        <table className="table-amc min-w-max">
          <caption className="sr-only">Matrice des certificats : échéance de chaque type de certificat par marin</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-[2] min-w-[220px] bg-surface-sunken">
                Marin / fonction
              </th>
              {columns.map((t) => (
                <th key={t.code} scope="col" className="text-center" title={t.name}>
                  <span className="ref block text-ink">{t.code}</span>
                  <span className="block max-w-[90px] truncate font-normal normal-case">{t.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  <td className="sticky left-0 bg-white">
                    <Skeleton className="h-4 w-40" />
                  </td>
                  {Array.from({ length: Math.max(columns.length, 8) }).map((__, k) => (
                    <td key={k}>
                      <Skeleton className="mx-auto h-4 w-14" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading &&
              rows?.map((m) => {
                const mp = maps.get(m.id)!;
                return (
                  <tr key={m.id}>
                    <th scope="row" className="sticky left-0 z-[1] border-b border-line bg-white px-3 py-2 text-left font-normal">
                      <span className="flex min-w-0 items-center gap-2">
                        <MemberAvatar photoFileId={m.photoFileId} name={memberName(m)} />
                        <span className="min-w-0">
                          <Link href={`/members/${m.id}`} className="block max-w-[180px] truncate font-semibold text-navy hover:text-action hover:underline">
                            {memberName(m)}
                          </Link>
                          <span className="block max-w-[180px] truncate text-xs text-ink-muted">{m.rank ?? '—'}</span>
                        </span>
                      </span>
                    </th>
                    {columns.map((t) => (
                      <td key={t.code} className="text-center">
                        <Cell cert={mp.get(t.code)} typeName={t.name} />
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
          {!loading && rows && rows.length > 0 && (
            <tfoot>
              <tr>
                <th scope="row" className="sticky left-0 z-[1] border-t border-line-strong bg-surface-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">
                  Sur les {rows.length} fiches affichées
                </th>
                {columns.map((t) => {
                  const e = expiredCount(t.code);
                  const s = soonCount(t.code);
                  return (
                    <td key={t.code} className="border-t border-line-strong bg-surface-sunken px-2 py-2 text-center text-xs">
                      <span className={cn('block tabular', e ? 'font-semibold text-danger' : 'text-ink-soft')}>{e} expiré{e > 1 ? 's' : ''}</span>
                      <span className={cn('block tabular', s ? 'text-warn' : 'text-ink-soft')}>{s} bientôt</span>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!loading && rows && rows.length === 0 && <EmptyState title="Aucune fiche" description="Modifiez les filtres pour afficher la matrice." />}
      {rows && rows.length > 0 && (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-muted">
          <span className="tabular">
            {rows.length}
            {typeof total === 'number' ? ` sur ${total}` : ''} fiche(s)
          </span>
          {hasMore && (
            <Button variant="secondary" size="sm" onClick={onLoadMore} loading={loadingMore}>
              Charger la suite
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
