'use client';

import { useQuery } from '@tanstack/react-query';
import { FileWarning, HelpCircle, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { DefinitionGrid, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { Notice, Stat, StoredText } from './common';
import { PORT_CALL_SHORT, fmtLaycan, fmtUtc, voyageKeys } from './lib';
import type { CertificateCheck, VoyageWorkspace } from './types';

const END_BASIS: Record<string, string> = {
  ATA: 'ATA du voyage',
  ETA: 'ETA du voyage',
  PORT_SCHEDULE: 'dernière date d’escale',
  LAYCAN_TO: 'fin de laycan',
};

const FLAG: Record<string, { label: string; tone: 'danger' | 'warn' | 'neutral'; icon: typeof ShieldAlert }> = {
  EXPIRED: { label: 'Expiré', tone: 'danger', icon: ShieldAlert },
  EXPIRES_BEFORE_VOYAGE_END: { label: 'Expire avant la fin du voyage', tone: 'warn', icon: FileWarning },
  EXPIRY_UNKNOWN: { label: 'Échéance inconnue', tone: 'neutral', icon: HelpCircle },
};

/** Contrôle INFORMATIF des certificats navire (CDC §7.4) — jamais un avis de conformité. */
function CertificateCheckPanel({ voyageId, vesselId }: { voyageId: string; vesselId: string }) {
  const q = useQuery({
    queryKey: voyageKeys.sub(voyageId, 'certificate-check'),
    queryFn: () => api.get<CertificateCheck>(`/voyages/${voyageId}/certificate-check`),
  });
  return (
    <Panel title="Contrôle informatif des certificats">
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-3">
          <Notice tone="info">{q.data.disclaimer}</Notice>
          {!q.data.available ? (
            <p className="text-sm text-ink-muted">{q.data.reason}</p>
          ) : (
            <>
              <p className="text-sm text-ink-muted">
                Fin estimée du voyage : <span className="font-medium text-ink tabular">{fmtDate(q.data.voyageEnd)}</span>
                {q.data.voyageEndBasis ? ` (base : ${END_BASIS[q.data.voyageEndBasis] ?? q.data.voyageEndBasis})` : ' (aucune date de fin connue)'} —{' '}
                {q.data.checkedCertificates} certificat(s) navire examiné(s).
              </p>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Expirés" value={q.data.counts?.expired ?? 0} tone={q.data.counts?.expired ? 'danger' : undefined} />
                <Stat label="Expirent avant la fin" value={q.data.counts?.expiringBeforeVoyageEnd ?? 0} tone={q.data.counts?.expiringBeforeVoyageEnd ? 'warn' : undefined} />
                <Stat label="Échéance inconnue" value={q.data.counts?.expiryUnknown ?? 0} />
              </div>
              {q.data.items && q.data.items.length > 0 ? (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {q.data.items.map((c) => {
                    const f = FLAG[c.flag];
                    const Icon = f.icon;
                    return (
                      <li key={c.id} className="space-y-1 px-3 py-2 text-sm">
                        <Link
                          href={`/certificates?vesselId=${vesselId}&subjectKind=VESSEL&search=${encodeURIComponent(c.currentNumber ?? c.type.code)}`}
                          className="block font-medium text-action hover:underline"
                        >
                          {c.type.name}
                        </Link>
                        <p className="text-xs tabular text-ink-muted">
                          {c.type.code}
                          {c.currentNumber ? ` · n° ${c.currentNumber}` : ''}
                          {c.currentExpiryOn ? ` · échéance ${fmtDate(c.currentExpiryOn)}` : ''}
                        </p>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={f.tone} icon={<Icon className="h-3.5 w-3.5" aria-hidden />}>
                            {f.label}
                          </Badge>
                          {c.documentMissing && <Badge tone="warn">Document manquant</Badge>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">Aucun certificat signalé pour la période du voyage.</p>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

export function OverviewTab({ ws }: { ws: VoyageWorkspace }) {
  const v = ws.overview;
  const openTasks = ws.tasks.filter((t) => t.status === 'OPEN').length;
  const pendingNotices = ws.notices.filter((n) => ['PLANNED', 'DRAFTED', 'VALIDATED'].includes(n.status)).length;
  const issued = ws.instructions.find((i) => i.status === 'ISSUED');
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-5">
        <Panel title="Informations du voyage">
          <DefinitionGrid
            columns={3}
            items={[
              ['Référence', <span key="r" className="ref">{v.reference}</span>],
              ['Navire', <Link key="n" className="text-action hover:underline" href={`/vessels/${v.vessel.id}`}>{v.vessel.name}</Link>],
              ['IMO', v.vessel.imoNumber ?? '—'],
              ['Charterer', v.charterer ?? '—'],
              ['Broker', v.broker ?? '—'],
              ['Laycan', <span key="l" className="tabular">{fmtLaycan(v.laycanFrom, v.laycanTo, fmtDate)}</span>],
              ['Route', v.route ?? '—'],
              ['ETD', <span key="etd" className="tabular">{fmtUtc(v.etd)}</span>],
              ['ETA', <span key="eta" className="tabular">{fmtUtc(v.eta)}</span>],
              ['ATD', <span key="atd" className="tabular">{fmtUtc(v.atd)}</span>],
              ['ATA', <span key="ata" className="tabular">{fmtUtc(v.ata)}</span>],
              ['Fuseau du navire', v.vessel.timezone ?? '—'],
              ['Créé le', fmtDateTime(v.createdAt)],
              ['Mis à jour', fmtDateTime(v.updatedAt)],
              ['Clôturé le', v.closedAt ? fmtDateTime(v.closedAt) : '—'],
            ]}
          />
          {v.description && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-1 text-xs text-ink-muted">Description</p>
              <StoredText>{v.description}</StoredText>
            </div>
          )}
          {v.notes && (
            <div className="mt-3">
              <p className="mb-1 text-xs text-ink-muted">Notes</p>
              <StoredText>{v.notes}</StoredText>
            </div>
          )}
        </Panel>
        <Panel title="Escales">
          {ws.ports.length === 0 ? (
            <p className="text-sm text-ink-muted">Aucune escale saisie.</p>
          ) : (
            <ol className="space-y-2">
              {ws.ports.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-navy-50 text-xs font-semibold tabular text-navy">{p.sequence}</span>
                  <span className="font-medium text-navy">
                    {p.portName}
                    {p.country ? ` (${p.country})` : ''}
                  </span>
                  <Badge tone="navy" icon={false}>
                    {PORT_CALL_SHORT[p.type] ?? p.type}
                  </Badge>
                  <span className="text-xs tabular text-ink-muted">
                    {p.ata ? `ATA ${fmtUtc(p.ata)}` : `ETA ${fmtUtc(p.eta)}`}
                    {p.agent ? ` · Agent ${p.agent.name}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
      <div className="space-y-5">
        <Panel title="Suivi">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Tâches ouvertes" value={openTasks} tone={openTasks ? 'warn' : undefined} />
            <Stat label="Notices à traiter" value={pendingNotices} tone={ws.notices.some((n) => n.overdue) ? 'danger' : undefined} />
            <Stat label="Cargaisons" value={ws.cargo.length} />
            <Stat label="NOR enregistrées" value={ws.nor.length} />
            {ws.noonReports && <Stat label="Noon Reports" value={ws.noonReports.total} hint={ws.noonReports.byStatus.DRAFT ? `${ws.noonReports.byStatus.DRAFT} brouillon(s)` : undefined} />}
            <Stat label="Instructions" value={issued ? `v${issued.versionNo}` : '—'} hint={issued ? `${issued.acknowledgements} accusé(s) de lecture` : 'Aucune version émise'} />
          </div>
        </Panel>
        <CertificateCheckPanel voyageId={v.id} vesselId={v.vesselId} />
      </div>
    </div>
  );
}
