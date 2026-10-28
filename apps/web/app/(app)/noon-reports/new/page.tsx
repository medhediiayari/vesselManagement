'use client';

import { useQuery } from '@tanstack/react-query';
import { Anchor, ArrowRight, Ship } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type Page } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import {
  CONSUMPTION_BASIS_LABELS,
  REPORT_TYPE_LABELS,
  UTC_OFFSET_OPTIONS,
  checkUtcOffset,
  formatUtcOffset,
  localFromUtc,
  offsetForTimeZone,
  utcFromLocal,
} from '@/components/noon/lib';
import type { NoonReportDetail } from '@/components/noon/types';
import { FormError, Notice } from '@/components/voyages/common';
import { fmtLaycan } from '@/components/voyages/lib';
import { VoyageStatusBadge } from '@/components/voyages/status';
import type { VoyageListItem, VoyageWorkspace } from '@/components/voyages/types';

/** Heure locale « HH:mm » du bord pour la date locale du jour -> UTC (saisie). */
function defaultUtc(offset: number, hhmm: string): string {
  const localToday = new Date(Date.now() + offset * 60_000).toISOString().slice(0, 10);
  return utcFromLocal(`${localToday}T${hhmm}`, offset);
}

/** Choix du voyage (planifié ou en cours) lorsque la page est ouverte sans ?voyageId=. */
function VoyagePicker() {
  const { currentVessel } = useSession();
  const q = useQuery({
    queryKey: ['voyages', 'reportable', currentVessel?.id],
    queryFn: async () => {
      const [active, planned] = await Promise.all(
        ['ACTIVE', 'PLANNED'].map((status) => api.get<Page<VoyageListItem>>('/voyages', { query: { status, vesselId: currentVessel?.id, limit: 100 } })),
      );
      return [...active.items, ...planned.items];
    },
  });
  return (
    <Panel title="Choisir le voyage">
      <p className="mb-3 text-sm text-ink-muted">Un Noon Report appartient toujours à un navire et à un voyage planifié ou en cours.</p>
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState title="Aucun voyage planifié ou en cours" description="Un voyage doit être planifié avant toute saisie de Noon Report." />}
      <ul className="space-y-2">
        {q.data?.map((v) => (
          <li key={v.id}>
            <Link href={`/noon-reports/new?voyageId=${v.id}`} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white px-3 py-3 hover:border-action hover:bg-action-50">
              <Ship className="h-4 w-4 text-teal-700" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium tabular text-navy">{v.reference}</span>
                <span className="block text-xs text-ink-muted">
                  {v.vessel.name}
                  {v.ports.length ? ` · ${v.ports[0].portName} → ${v.ports[v.ports.length - 1].portName}` : ''} · laycan {fmtLaycan(v.laycanFrom, v.laycanTo, fmtDate)}
                </span>
              </span>
              <VoyageStatusBadge status={v.status} />
              <ArrowRight className="h-4 w-4 text-ink-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CreateForm({ voyageId }: { voyageId: string }) {
  const router = useRouter();
  const { me } = useSession();
  const ws = useQuery({ queryKey: ['voyage', voyageId], queryFn: () => api.get<VoyageWorkspace>(`/voyages/${voyageId}`) });
  const tz = ws.data?.overview.vessel.timezone ?? null;
  const tzOffset = useMemo(() => offsetForTimeZone(tz), [tz]);
  const [reportType, setReportType] = useState('NOON');
  const [offset, setOffset] = useState<string>('');
  const [dateUtc, setDateUtc] = useState('');
  const [dateTouched, setDateTouched] = useState(false);
  const [basis, setBasis] = useState('');
  const [masterName, setMasterName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Décalage par défaut : fuseau du navire (modifiable), puis date = midi local du jour
  useEffect(() => {
    if (ws.data && offset === '') setOffset(String(tzOffset ?? 0));
  }, [ws.data, tzOffset, offset]);
  useEffect(() => {
    if (offset === '' || dateTouched) return;
    const o = Number(offset);
    if (reportType === 'NOON') setDateUtc(defaultUtc(o, '12:00'));
    else if (reportType === 'MIDNIGHT') setDateUtc(defaultUtc(o, '00:00'));
    else setDateUtc(new Date().toISOString().slice(0, 16));
  }, [offset, reportType, dateTouched]);

  if (ws.isLoading) return <LoadingBlock rows={6} />;
  if (ws.error || !ws.data) return <ErrorState error={ws.error} onRetry={() => ws.refetch()} />;
  const v = ws.data.overview;
  const reportable = v.status === 'PLANNED' || v.status === 'ACTIVE';
  const o = Number(offset || 0);
  const offsetErr = offset === '' ? null : checkUtcOffset(o);
  const future = dateUtc && new Date(`${dateUtc}:00Z`).getTime() > Date.now() + 24 * 3_600_000;
  const duplicateId =
    error instanceof ApiError && error.code === 'DUPLICATE' && error.details && typeof error.details === 'object' ? (error.details as { existingId?: string }).existingId : undefined;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<NoonReportDetail>('/noon-reports', {
        voyageId,
        reportType,
        reportDateUtc: `${dateUtc}:00Z`,
        utcOffsetMinutes: o,
        consumptionBasis: basis,
        ...(masterName.trim() ? { masterName: masterName.trim() } : {}),
      });
      router.replace(`/noon-reports/${r.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Panel>
        <div className="flex flex-wrap items-center gap-3">
          <Anchor className="h-5 w-5 text-teal-700" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-navy">
              {v.vessel.name}
              {v.vessel.imoNumber ? <span className="font-normal text-ink-muted"> · IMO {v.vessel.imoNumber}</span> : null}
            </p>
            <p className="text-sm text-ink-muted">
              Voyage{' '}
              <Link href={`/voyages/${v.id}?tab=noon`} className="text-action hover:underline">
                {v.reference}
              </Link>
              {v.route ? ` · ${v.route}` : ''}
              {tz ? ` · fuseau ${tz}` : ''}
            </p>
          </div>
          <VoyageStatusBadge status={v.status} />
        </div>
      </Panel>
      {!reportable ? (
        <Notice tone="warn" title="Voyage non planifié ou clôturé">
          Un Noon Report ne peut être saisi que sur un voyage planifié ou en cours.
        </Notice>
      ) : (
        <Panel title="1. General Information — création du brouillon">
          <FormError error={error} />
          {duplicateId && (
            <p className="mb-3 text-sm">
              <Link href={`/noon-reports/${duplicateId}`} className="font-medium text-action hover:underline">
                Ouvrir le rapport existant
              </Link>
            </p>
          )}
          <div className="space-y-4">
            <fieldset>
              <legend className="field-label">
                Type de rapport<span className="ml-0.5 text-danger" aria-hidden>*</span>
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(REPORT_TYPE_LABELS).map(([value, label]) => (
                  <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${reportType === value ? 'border-action bg-action-50 font-medium' : 'border-line-strong'}`}>
                    <input type="radio" name="reportType" value={value} checked={reportType === value} onChange={() => setReportType(value)} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Décalage horaire du bord" required htmlFor="nr-offset" error={offsetErr ?? undefined} hint={tzOffset !== null ? `Fuseau du navire : ${formatUtcOffset(tzOffset)}` : 'Fuseau du navire non renseigné'}>
                <Select id="nr-offset" value={offset} onChange={(e) => setOffset(e.target.value)}>
                  {UTC_OFFSET_OPTIONS.map((x) => (
                    <option key={x} value={String(x)}>
                      {formatUtcOffset(x)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date / heure du rapport (UTC)" required htmlFor="nr-utc" error={future ? 'Date du rapport dans le futur' : undefined}>
                <Input
                  id="nr-utc"
                  type="datetime-local"
                  className="tabular"
                  value={dateUtc}
                  onChange={(e) => {
                    setDateTouched(true);
                    setDateUtc(e.target.value);
                  }}
                />
              </Field>
              <Field label="Heure locale du bord" htmlFor="nr-local" hint="Modifier l’une met l’autre à jour.">
                <Input
                  id="nr-local"
                  type="datetime-local"
                  className="tabular"
                  value={localFromUtc(dateUtc, o)}
                  onChange={(e) => {
                    const u = utcFromLocal(e.target.value, o);
                    if (u) {
                      setDateTouched(true);
                      setDateUtc(u);
                    }
                  }}
                />
              </Field>
            </div>
            <fieldset>
              <legend className="field-label">
                Base de consommation<span className="ml-0.5 text-danger" aria-hidden>*</span>
              </legend>
              <p className="mb-2 text-xs text-ink-muted">À choisir explicitement : les consommations ne sont jamais cumulées automatiquement.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(CONSUMPTION_BASIS_LABELS).map(([value, label]) => (
                  <label key={value} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${basis === value ? 'border-action bg-action-50' : 'border-line-strong'}`}>
                    <input type="radio" name="basis" className="mt-0.5" value={value} checked={basis === value} onChange={() => setBasis(value)} />
                    <span>
                      <span className="font-medium">{label.split(' — ')[0]}</span>
                      <span className="block text-xs text-ink-muted">{label.split(' — ')[1]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Master" htmlFor="nr-master" hint={<button type="button" className="text-action hover:underline" onClick={() => setMasterName(me.displayName)}>Utiliser mon nom ({me.displayName})</button>}>
              <Input id="nr-master" value={masterName} onChange={(e) => setMasterName(e.target.value)} maxLength={200} />
            </Field>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => router.back()}>
              Annuler
            </Button>
            <Button onClick={create} loading={busy} disabled={!dateUtc || !basis || !!offsetErr || !!future || offset === ''}>
              Créer le brouillon
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-muted">Les 7 sections se complètent ensuite avec enregistrement automatique.</p>
        </Panel>
      )}
    </div>
  );
}

function NewNoonReport() {
  const sp = useSearchParams();
  const { can } = useSession();
  const voyageId = sp.get('voyageId');
  if (!can('noon.create')) return <Forbidden message="La saisie d’un Noon Report requiert la permission noon.create (Master ou délégation explicite)." />;
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Noon Reports', href: '/noon-reports' }, { label: 'Nouveau' }]}
        title="Nouveau Noon Report"
        description="Formulaire AMC en 7 sections. Heure locale du bord et UTC enregistrées."
      />
      {voyageId ? <CreateForm voyageId={voyageId} /> : <VoyagePicker />}
    </>
  );
}

export default function NewNoonReportPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={6} />}>
      <NewNoonReport />
    </Suspense>
  );
}
