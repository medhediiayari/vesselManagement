'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Layers } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import { EXTRA_TARGET_LABELS, MEMBER_IMPORT_FIELDS, normalizeHeader, targetLabel, useMemberCertificateTypes } from './import-shared';
import { CREW_DEPARTMENT_LABELS, MEMBER_FIELD_LABELS, type CrewDepartment, type DiscoveredSheet, type ImportJob } from './types';

interface SheetState {
  include: boolean;
  headerRow: number;
  headerRowCount: 1 | 2;
  targets: Record<string, string>;
  rank: string;
  crewDepartment: CrewDepartment | '';
  vesselId: string;
}

function initialSheetState(sheet: DiscoveredSheet, job: ImportJob): SheetState {
  const applied = job.mapping?.find((m) => m.name === sheet.name);
  if (applied) {
    const targets: Record<string, string> = Object.fromEntries(sheet.columns.map((c) => [c.letter, 'ignore']));
    applied.columns.forEach((c) => (targets[c.letter] = c.target));
    return {
      include: applied.include,
      headerRow: applied.headerRow,
      headerRowCount: applied.headerRowCount,
      targets,
      rank: applied.defaults?.rank ?? '',
      crewDepartment: applied.defaults?.crewDepartment ?? '',
      vesselId: applied.defaults?.vesselId ?? '',
    };
  }
  return {
    include: sheet.suggestedInclude,
    headerRow: sheet.headerRow,
    headerRowCount: sheet.headerRowCount,
    targets: Object.fromEntries(sheet.columns.map((c) => [c.letter, c.suggested ?? 'ignore'])),
    rank: '',
    crewDepartment: sheet.suggestedDefaults.crewDepartment ?? '',
    vesselId: '',
  };
}

/**
 * Clé de colonne envoyée à l'API : l'en-tête (résolu en priorité par l'API) lorsqu'il est unique et que
 * la ligne d'en-tête détectée est conservée ; sinon la lettre de colonne.
 */
function columnKey(sheet: DiscoveredSheet, state: SheetState, letter: string): string {
  const col = sheet.columns.find((c) => c.letter === letter);
  const sameHeaders = state.headerRow === sheet.headerRow && state.headerRowCount === sheet.headerRowCount;
  if (col && sameHeaders && col.header.trim() && col.header.length <= 200) {
    const nk = normalizeHeader(col.header);
    if (nk && sheet.columns.filter((c) => normalizeHeader(c.header) === nk).length === 1) return col.header;
  }
  return letter;
}

function sheetIssues(state: SheetState): string[] {
  if (!state.include) return [];
  const issues: string[] = [];
  const used = Object.values(state.targets).filter((t) => t && t !== 'ignore');
  if (!used.includes('fullName') && !(used.includes('lastName') && used.includes('firstName'))) {
    issues.push('Mapper « Nom » et « Prénom », ou une colonne « Nom et prénom ».');
  }
  const dups = [...new Set(used.filter((t, i) => used.indexOf(t) !== i))];
  dups.forEach((t) => issues.push(`« ${targetLabel(t)} » est mappé sur plusieurs colonnes.`));
  return issues;
}

/**
 * Étape 2 — mapping par feuille : inclusion, ligne d'en-tête, colonne -> champ Member,
 * certificat (combiné / numéro / expiration / délivrance), embarquement ; pré-rempli avec
 * les suggestions de l'API (ou le dernier mapping appliqué).
 */
export function ImportMappingStep({ job, onApplied }: { job: ImportJob; onApplied: () => void }) {
  const qc = useQueryClient();
  const { me, can } = useSession();
  const { codes, names } = useMemberCertificateTypes(job);
  const [sheets, setSheets] = useState<Record<string, SheetState>>(() => Object.fromEntries(job.sheets.map((s) => [s.name, initialSheetState(s, job)])));
  const [createAssignments, setCreateAssignments] = useState(job.createAssignments);
  const [defaultVesselId, setDefaultVesselId] = useState(job.defaultVesselId ?? job.vesselId ?? '');
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmRemap, setConfirmRemap] = useState(false);
  const decided = Object.entries(job.counts.byDecision).reduce((n, [k, v]) => (k === 'PENDING' ? n : n + (v ?? 0)), 0);

  const update = (name: string, patch: Partial<SheetState>) => setSheets((s) => ({ ...s, [name]: { ...s[name], ...patch } }));
  const issues = useMemo(() => Object.fromEntries(Object.entries(sheets).map(([n, s]) => [n, sheetIssues(s)])), [sheets]);
  const included = Object.values(sheets).filter((s) => s.include).length;
  const blocking = Object.values(issues).some((l) => l.length) || included === 0;
  const usesCertificates = Object.values(sheets).some((s) => s.include && Object.values(s.targets).some((t) => t.startsWith('certificate:')));
  const editable = job.status !== 'CANCELLED' && (job.phase === 'MAPPING' || job.phase === 'PREVIEW_READY') && !job.counts.byStatus.APPLIED;

  const submit = async () => {
    setBusy(true);
    setServerIssues([]);
    try {
      await api.put(`/members/import-jobs/${job.id}/mapping`, {
        sheets: job.sheets.map((sheet) => {
          const st = sheets[sheet.name];
          const mapping = Object.fromEntries(
            Object.entries(st.targets)
              .filter(([, t]) => t && t !== 'ignore')
              .map(([letter, t]) => [columnKey(sheet, st, letter), t]),
          );
          const defaults = {
            ...(st.rank.trim() ? { rank: st.rank.trim() } : {}),
            ...(st.crewDepartment ? { crewDepartment: st.crewDepartment } : {}),
            ...(st.vesselId ? { vesselId: st.vesselId } : {}),
          };
          return {
            name: sheet.name,
            include: st.include,
            headerRow: st.headerRow,
            headerRowCount: st.headerRowCount,
            mapping,
            ...(Object.keys(defaults).length ? { defaults } : {}),
          };
        }),
        createAssignments,
        ...(defaultVesselId ? { defaultVesselId } : {}),
      });
      toast.success('Prévisualisation calculée : vérifiez les lignes et les doublons');
      await qc.invalidateQueries({ queryKey: ['import-job', job.id] });
      await qc.invalidateQueries({ queryKey: ['import-rows', job.id] });
      onApplied();
    } catch (e) {
      const d = e instanceof ApiError ? ((e.details ?? {}) as { issues?: string[] }) : {};
      if (Array.isArray(d.issues) && d.issues.length) setServerIssues(d.issues);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const fieldOptions = (
    <>
      <option value="ignore">Ignorer la colonne</option>
      <optgroup label="Fiche Member">
        {MEMBER_IMPORT_FIELDS.map((f) => (
          <option key={f} value={f}>
            {MEMBER_FIELD_LABELS[f]}
          </option>
        ))}
        <option value="fullName">{EXTRA_TARGET_LABELS.fullName}</option>
      </optgroup>
      <optgroup label="Embarquement">
        {['joinDate', 'signOffDate', 'vessel'].map((t) => (
          <option key={t} value={t}>
            {EXTRA_TARGET_LABELS[t]}
          </option>
        ))}
      </optgroup>
      {codes.map((code) => (
        <optgroup key={code} label={`Certificat ${code}${names.get(code) ? ` — ${names.get(code)}` : ''}`}>
          <option value={`certificate:${code}`}>{code} — cellule combinée</option>
          <option value={`certificate:${code}:number`}>{code} — numéro</option>
          <option value={`certificate:${code}:expiry`}>{code} — date d’expiration</option>
          <option value={`certificate:${code}:issued`}>{code} — date de délivrance</option>
        </optgroup>
      ))}
    </>
  );

  return (
    <div className="space-y-4">
      {!editable && (
        <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn" role="status">
          Mapping figé : des lignes ont déjà été appliquées ou l’import est clôturé. Consultation seule.
        </p>
      )}
      <Panel title="Options générales">
        <div className="grid gap-4 md:grid-cols-2">
          <Checkbox
            label="Créer l'historique d'affectations depuis les dates d'embarquement / débarquement"
            description={can('vessel_crew.assign') ? 'Navire de la colonne « Navire », sinon navire par défaut de la feuille ou de l’import.' : 'Requiert la permission de gérer les affectations d’équipage.'}
            checked={createAssignments}
            disabled={!editable || !can('vessel_crew.assign')}
            onChange={(e) => setCreateAssignments(e.target.checked)}
          />
          <Field label="Navire par défaut de l'import" htmlFor="imp-default-vessel" hint="Utilisé pour les affectations quand la ligne ne précise pas le navire.">
            <Select id="imp-default-vessel" value={defaultVesselId} disabled={!editable} onChange={(e) => setDefaultVesselId(e.target.value)}>
              <option value="">Aucun</option>
              {me.accessibleVessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.code})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {usesCertificates && !can('certificates.create') && (
          <p className="mt-3 flex items-start gap-2 text-sm text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Des colonnes sont mappées sur des certificats : leur import exige la permission de créer des certificats. Passez-les en « Ignorer » ou
            demandez ce droit.
          </p>
        )}
      </Panel>

      {job.sheets.map((sheet) => {
        const st = sheets[sheet.name];
        const sheetIssueList = issues[sheet.name] ?? [];
        const counts = new Map<string, number>();
        Object.values(st.targets).forEach((t) => t !== 'ignore' && counts.set(t, (counts.get(t) ?? 0) + 1));
        const headersChanged = st.headerRow !== sheet.headerRow || st.headerRowCount !== sheet.headerRowCount;
        return (
          <section key={sheet.name} className={cn('panel', !st.include && 'opacity-80')} aria-label={`Feuille ${sheet.name}`}>
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              <Layers className="h-4 w-4 text-teal-700" aria-hidden />
              <h2 className="text-md font-semibold">{sheet.name}</h2>
              <Badge tone="neutral" icon={false}>
                {sheet.rowCount} ligne(s) de données
              </Badge>
              <Checkbox
                className="ml-auto"
                label="Inclure cette feuille"
                checked={st.include}
                disabled={!editable}
                onChange={(e) => update(sheet.name, { include: e.target.checked })}
              />
            </div>
            {st.include && (
              <div className="space-y-3 p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <Field label="Ligne d'en-tête" htmlFor={`hr-${sheet.name}`} hint={`Détectée : ${sheet.headerRow}`}>
                    <Input
                      id={`hr-${sheet.name}`}
                      type="number"
                      min={1}
                      max={1000}
                      value={st.headerRow}
                      disabled={!editable}
                      onChange={(e) => update(sheet.name, { headerRow: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </Field>
                  <Field label="En-têtes sur" htmlFor={`hrc-${sheet.name}`} hint="2 lignes : titre fusionné au-dessus (ex. GMDSS / N° / EXP)">
                    <Select
                      id={`hrc-${sheet.name}`}
                      value={st.headerRowCount}
                      disabled={!editable}
                      onChange={(e) => update(sheet.name, { headerRowCount: Number(e.target.value) === 2 ? 2 : 1 })}
                    >
                      <option value={1}>1 ligne</option>
                      <option value={2}>2 lignes</option>
                    </Select>
                  </Field>
                  <Field label="Fonction par défaut" htmlFor={`rk-${sheet.name}`} hint="Si la colonne est vide">
                    <Input id={`rk-${sheet.name}`} value={st.rank} disabled={!editable} maxLength={120} onChange={(e) => update(sheet.name, { rank: e.target.value })} />
                  </Field>
                  <Field label="Service par défaut" htmlFor={`dp-${sheet.name}`}>
                    <Select
                      id={`dp-${sheet.name}`}
                      value={st.crewDepartment}
                      disabled={!editable}
                      onChange={(e) => update(sheet.name, { crewDepartment: e.target.value as CrewDepartment | '' })}
                    >
                      <option value="">Aucun</option>
                      {Object.entries(CREW_DEPARTMENT_LABELS).map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Navire par défaut" htmlFor={`vs-${sheet.name}`}>
                    <Select id={`vs-${sheet.name}`} value={st.vesselId} disabled={!editable} onChange={(e) => update(sheet.name, { vesselId: e.target.value })}>
                      <option value="">Celui de l’import</option>
                      {me.accessibleVessels.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {headersChanged && (
                  <p className="text-xs text-ink-muted">
                    Ligne d’en-tête modifiée : les en-têtes et exemples ci-dessous proviennent de la ligne détectée ; les colonnes sont transmises par
                    leur lettre.
                  </p>
                )}
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="table-amc">
                    <caption className="sr-only">Colonnes de la feuille {sheet.name}</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="w-12">
                          Col.
                        </th>
                        <th scope="col">En-tête</th>
                        <th scope="col" className="hidden md:table-cell">
                          Exemples
                        </th>
                        <th scope="col" className="w-[340px]">
                          Champ cible
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.columns.map((c) => {
                        const t = st.targets[c.letter] ?? 'ignore';
                        const dup = t !== 'ignore' && (counts.get(t) ?? 0) > 1;
                        const selectId = `map-${sheet.name}-${c.letter}`;
                        return (
                          <tr key={c.letter}>
                            <td className="font-mono text-xs text-ink-muted">{c.letter}</td>
                            <td>
                              <label htmlFor={selectId} className="font-medium">
                                {c.header || <span className="italic text-ink-soft">Sans en-tête</span>}
                              </label>
                              {c.suggested && c.suggested !== 'ignore' && t === c.suggested && (
                                <span className="ml-2 text-xs text-teal-700">suggéré</span>
                              )}
                            </td>
                            <td className="hidden max-w-[260px] md:table-cell">
                              <span className="block truncate text-xs text-ink-muted" title={c.samples.join(' | ')}>
                                {c.samples.length ? c.samples.join(' · ') : '—'}
                              </span>
                            </td>
                            <td>
                              <Select
                                id={selectId}
                                value={t}
                                disabled={!editable}
                                invalid={dup}
                                onChange={(e) => update(sheet.name, { targets: { ...st.targets, [c.letter]: e.target.value } })}
                                className={cn(t === 'ignore' && 'text-ink-muted')}
                              >
                                {fieldOptions}
                                {!(
                                  t === 'ignore' ||
                                  (MEMBER_IMPORT_FIELDS as readonly string[]).includes(t) ||
                                  EXTRA_TARGET_LABELS[t] ||
                                  codes.some((code) => t.toUpperCase().startsWith(`CERTIFICATE:${code}`))
                                ) && <option value={t}>{targetLabel(t, names)}</option>}
                              </Select>
                              {dup && <p className="field-error">Cible utilisée par plusieurs colonnes</p>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {sheetIssueList.length > 0 && (
                  <ul className="space-y-1 text-sm text-danger" role="alert">
                    {sheetIssueList.map((i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {i}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        );
      })}

      {serverIssues.length > 0 && (
        <Panel title="Mapping refusé par le serveur" className="border border-danger-line">
          <ul className="list-disc space-y-1 pl-5 text-sm text-danger" role="alert">
            {serverIssues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Panel>
      )}

      {editable && (
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 rounded-lg border border-line bg-white/95 px-4 py-3 shadow-panel backdrop-blur">
          <span className="mr-auto text-sm text-ink-muted">
            {included} feuille(s) incluse(s){job.phase === 'PREVIEW_READY' ? ' — réappliquer le mapping recalcule la prévisualisation et efface les décisions.' : ''}
          </span>
          <Button onClick={() => (decided > 0 ? setConfirmRemap(true) : submit())} loading={busy} disabled={blocking}>
            Calculer la prévisualisation <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemap}
        onOpenChange={setConfirmRemap}
        title="Recalculer la prévisualisation"
        description={`${decided} décision(s) déjà prise(s) sur les lignes seront effacées : la prévisualisation est entièrement recalculée avec le nouveau mapping.`}
        confirmLabel="Recalculer"
        tone="danger"
        onConfirm={submit}
      />
    </div>
  );
}
