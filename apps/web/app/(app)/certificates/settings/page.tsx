'use client';

import { useQuery } from '@tanstack/react-query';
import { BellRing, Lock, Pencil, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { DefinitionGrid, FilterBar, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { certKeys } from '@/components/certificates/lib';
import { PrincipalChip } from '@/components/certificates/pickers';
import { PolicyFormDialog, TypeFormDialog } from '@/components/certificates/settings-forms';
import {
  FREQUENCY_LABELS,
  SUBJECT_KIND_LABELS,
  type CertificateCategoryDto,
  type CertificateTypeDto,
  type ReminderPolicyDto,
  type ReminderRunResult,
} from '@/components/certificates/types';

const ALERT_LABELS: Record<string, string> = {
  EXPIRY: 'Échéance',
  EXPIRED: 'Après expiration',
  UNKNOWN_EXPIRY: 'Date inconnue',
  MISSING_DOCUMENT: 'Document manquant',
};

const days = (n: number | null) => (n ? `tous les ${n} j` : 'Désactivé');

export default function CertificateSettingsPage() {
  const { can } = useSession();
  const manage = can('certificates.types.manage');
  const [tab, setTab] = useState('types');
  const [typeDialog, setTypeDialog] = useState<{ type: CertificateTypeDto | null } | null>(null);
  const [policyDialog, setPolicyDialog] = useState<{ policy: ReminderPolicyDto | null } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runResult, setRunResult] = useState<ReminderRunResult | null>(null);
  const [kind, setKind] = useState('');
  const [active, setActive] = useState('');
  const [term, setTerm] = useState('');

  const types = useQuery({
    queryKey: [...certKeys.types, 'all'],
    queryFn: () => api.get<CertificateTypeDto[]>('/certificate-types'),
    enabled: can('certificates.view'),
  });
  const policies = useQuery({
    queryKey: certKeys.policies,
    queryFn: () => api.get<ReminderPolicyDto[]>('/certificate-reminder-policies'),
    enabled: can('certificates.view'),
  });
  // Référentiel de l'arborescence (catégories créées depuis l'explorateur) + catégories portées par les types
  const categoryRefs = useQuery({
    queryKey: certKeys.categories,
    queryFn: () => api.get<CertificateCategoryDto[]>('/certificate-categories'),
    staleTime: 60_000,
  });
  const categories = useMemo(
    () => [...new Set([...(categoryRefs.data ?? []).map((c) => c.name), ...(types.data ?? []).map((t) => t.category)])].sort(),
    [types.data, categoryRefs.data],
  );
  const shownTypes = useMemo(() => {
    const t = term.trim().toLowerCase();
    return (types.data ?? []).filter(
      (x) =>
        (!kind || x.subjectKind === kind) &&
        (!active || String(x.isActive) === active) &&
        (!t || `${x.code} ${x.name} ${x.category}`.toLowerCase().includes(t)),
    );
  }, [types.data, kind, active, term]);

  if (!can('certificates.view')) return <Forbidden />;

  const reload = async () => {
    await Promise.all([types.refetch(), policies.refetch()]);
  };

  const columns: Column<CertificateTypeDto>[] = [
    { key: 'code', header: 'Code', cell: (t) => <span className="tabular font-medium">{t.code}</span> },
    {
      key: 'name',
      header: 'Nom',
      className: 'min-w-[180px]',
      cell: (t) => (
        <div>
          <p className="font-medium text-ink">{t.name}</p>
          <p className="text-xs text-ink-muted">
            {SUBJECT_KIND_LABELS[t.subjectKind]} — {t.category}
          </p>
        </div>
      ),
    },
    {
      key: 'rules',
      header: 'Règles',
      hideBelow: 'md',
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={t.requiresDocument ? 'navy' : 'neutral'} icon={false}>
            {t.requiresDocument ? 'Document requis' : 'Document facultatif'}
          </Badge>
          {t.defaultValidityMonths && (
            <Badge tone="navy" icon={false}>
              {t.defaultValidityMonths} mois
            </Badge>
          )}
          {t.allowMultiple && (
            <Badge tone="navy" icon={false}>
              Multiples
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'policy', header: 'Politique de rappel', hideBelow: 'lg', cell: (t) => t.reminderPolicy?.name ?? <span className="text-ink-muted">Aucune</span> },
    {
      key: 'validators',
      header: 'Validateurs',
      hideBelow: 'lg',
      cell: (t) =>
        t.validators === null ? (
          <span className="text-xs text-ink-muted">
            {t.validatorCount ? `${t.validatorCount} principal(aux) désigné(s)` : 'Tout validateur habilité'}
          </span>
        ) : t.validators.length ? (
          <div className="flex max-w-[280px] flex-wrap gap-1">
            {t.validators.slice(0, 3).map((v) => (
              <PrincipalChip key={`${v.principalType}:${v.principalId}`} p={v} />
            ))}
            {t.validators.length > 3 && <span className="text-xs text-ink-muted">+{t.validators.length - 3}</span>}
          </div>
        ) : (
          <span className="text-xs text-ink-muted">Tout validateur habilité</span>
        ),
    },
    { key: 'count', header: 'Certificats', align: 'right', hideBelow: 'sm', cell: (t) => t.certificateCount },
    {
      key: 'active',
      header: 'Statut',
      cell: (t) => <Badge tone={t.isActive ? 'ok' : 'neutral'}>{t.isActive ? 'Actif' : 'Inactif'}</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Certificats', href: '/certificates' }, { label: 'Configuration' }]}
        title="Configuration des certificats"
        description="Types par titulaire, validateurs éligibles et politiques de rappel. Toute modification est journalisée ; aucun type n’est supprimé."
        actions={
          manage && (
            <Button variant="secondary" onClick={() => setRunOpen(true)}>
              <BellRing className="h-4 w-4" aria-hidden /> Lancer les rappels maintenant
            </Button>
          )
        }
      />
      {!manage && (
        <p role="note" className="mb-4 flex items-center gap-2 rounded-md border border-neutral-line bg-neutral-bg px-3 py-2 text-sm text-neutral">
          <Lock className="h-4 w-4" aria-hidden /> Lecture seule : la modification de la configuration requiert le droit « Gérer les types de certificats ».
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="types" count={types.data?.length ?? null}>
            Types de certificats
          </TabsTrigger>
          <TabsTrigger value="policies" count={policies.data?.length ?? null}>
            Politiques de rappel
          </TabsTrigger>
        </TabsList>

        <TabsContent value="types">
          <FilterBar>
            <div className="w-full sm:w-64">
              <label htmlFor="type-search" className="mb-1 block text-xs font-medium text-ink-muted">
                Recherche
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
                <Input id="type-search" type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Code, nom, catégorie…" className="h-8 pl-8 text-sm" />
              </div>
            </div>
            <div className="w-36">
              <label htmlFor="type-kind" className="mb-1 block text-xs font-medium text-ink-muted">
                Titulaire
              </label>
              <Select id="type-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 text-sm">
                <option value="">Tous</option>
                <option value="VESSEL">Navire</option>
                <option value="MEMBER">Marin</option>
              </Select>
            </div>
            <div className="w-36">
              <label htmlFor="type-active" className="mb-1 block text-xs font-medium text-ink-muted">
                Statut
              </label>
              <Select id="type-active" value={active} onChange={(e) => setActive(e.target.value)} className="h-8 text-sm">
                <option value="">Tous</option>
                <option value="true">Actifs</option>
                <option value="false">Inactifs</option>
              </Select>
            </div>
            {manage && (
              <Button className="ml-auto" size="sm" onClick={() => setTypeDialog({ type: null })}>
                <Plus className="h-4 w-4" aria-hidden /> Nouveau type
              </Button>
            )}
          </FilterBar>
          <DataTable
            caption="Types de certificats"
            columns={columns}
            rows={shownTypes}
            loading={types.isLoading}
            error={types.error}
            onRetry={() => types.refetch()}
            onRowClick={(t) => setTypeDialog({ type: t })}
            total={types.data ? shownTypes.length : undefined}
            empty={<EmptyState title="Aucun type" description="Modifiez les filtres ou créez un type." />}
          />
          <p className="mt-2 text-xs text-ink-soft">{manage ? 'Cliquez sur une ligne pour modifier le type et ses validateurs.' : 'Cliquez sur une ligne pour consulter le type.'}</p>
        </TabsContent>

        <TabsContent value="policies" className="space-y-4">
          {manage && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setPolicyDialog({ policy: null })}>
                <Plus className="h-4 w-4" aria-hidden /> Nouvelle politique
              </Button>
            </div>
          )}
          {policies.isLoading && <LoadingBlock rows={4} />}
          {policies.error && <ErrorState error={policies.error} onRetry={() => policies.refetch()} />}
          {policies.data?.length === 0 && <EmptyState title="Aucune politique de rappel" description="Sans politique, un type de certificat n’émet aucun rappel." />}
          <div className="grid gap-4 xl:grid-cols-2">
            {policies.data?.map((p) => (
              <Panel
                key={p.id}
                title={p.name}
                actions={
                  <Button size="sm" variant="secondary" onClick={() => setPolicyDialog({ policy: p })}>
                    {manage ? (
                      <>
                        <Pencil className="h-4 w-4" aria-hidden /> Modifier
                      </>
                    ) : (
                      'Consulter'
                    )}
                  </Button>
                }
              >
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {p.thresholdsDays.map((d) => (
                    <Badge key={d} tone="navy" icon={false} className="tabular">
                      J-{d}
                    </Badge>
                  ))}
                  {p.thresholdsDays.length === 0 && <span className="text-sm text-ink-muted">Aucun seuil</span>}
                </div>
                <DefinitionGrid
                  columns={2}
                  items={[
                    ['Fréquence', `${FREQUENCY_LABELS[p.frequency]}${p.frequency === 'CUSTOM' && p.customIntervalDays ? ` (${p.customIntervalDays} j)` : ''}`],
                    [
                      'Après expiration',
                      p.postExpiryIntervalDays ? `${days(p.postExpiryIntervalDays)}${p.postExpiryMaxReminders !== null ? `, ${p.postExpiryMaxReminders} max.` : ''}` : 'Désactivé',
                    ],
                    ['Date inconnue', days(p.unknownExpiryIntervalDays)],
                    ['Document manquant', days(p.missingDocumentIntervalDays)],
                    ['Escalade approbation', p.approvalOverdueHours ? `après ${p.approvalOverdueHours} h${p.escalationRole?.name ? ` vers ${p.escalationRole.name}` : ''}` : 'Désactivée'],
                    ['Mise à jour', fmtDateTime(p.updatedAt)],
                  ]}
                />
                <div className="mt-3">
                  <p className="mb-1 text-xs text-ink-muted">Destinataires</p>
                  <div className="flex flex-wrap gap-1.5">
                    {p.recipients === null ? (
                      <span className="text-sm text-ink-muted">{p.recipientCount ?? 0} destinataire(s) configuré(s)</span>
                    ) : p.recipients.length ? (
                      p.recipients.map((r) => <PrincipalChip key={`${r.principalType}:${r.principalId}`} p={r} />)
                    ) : (
                      <span className="text-sm text-ink-muted">Aucun</span>
                    )}
                  </div>
                </div>
                <div className="mt-3">
                  <p className="mb-1 text-xs text-ink-muted">Types concernés ({p.types.length})</p>
                  <p className="text-sm">{p.types.length ? p.types.map((t) => t.code).join(', ') : '—'}</p>
                </div>
              </Panel>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {typeDialog && (
        <TypeFormDialog
          open={!!typeDialog}
          onOpenChange={(o) => !o && setTypeDialog(null)}
          type={typeDialog.type}
          policies={policies.data ?? []}
          categories={categories}
          readOnly={!manage}
          onSaved={reload}
        />
      )}
      {policyDialog && (
        <PolicyFormDialog open={!!policyDialog} onOpenChange={(o) => !o && setPolicyDialog(null)} policy={policyDialog.policy} readOnly={!manage} onSaved={reload} />
      )}

      <ConfirmDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        title="Lancer les rappels maintenant"
        description="Exécute immédiatement le job de rappels (échéances, date inconnue, documents manquants, approbations en retard). Les envois sont dédupliqués : un rappel déjà émis n’est pas renvoyé."
        confirmLabel="Lancer"
        onConfirm={async () => {
          const res = await api.post<ReminderRunResult>('/certificates/reminders/run');
          toast.success('Rappels exécutés');
          setRunResult(res);
        }}
      />
      <Dialog
        open={!!runResult}
        onOpenChange={(o) => !o && setRunResult(null)}
        title="Résultat de l’exécution des rappels"
        description={runResult ? `Date de référence : ${runResult.asOf}` : undefined}
        size="sm"
        footer={
          <Button variant="secondary" onClick={() => setRunResult(null)}>
            Fermer
          </Button>
        }
      >
        {runResult && (
          <DefinitionGrid
            items={[
              ['Certificats analysés', runResult.certificatesScanned],
              ['Sans politique', runResult.certificatesWithoutPolicy],
              ...Object.entries(runResult.alerts ?? {}).map(([k, v]) => [`Alertes — ${ALERT_LABELS[k] ?? k}`, v] as [string, number]),
              ['Notifications créées', runResult.notificationsCreated],
              ['Relances d’approbation', runResult.approvalReminders],
              ['Escalades', runResult.escalations],
              ['Erreurs', <span key="e" className={runResult.errors ? 'font-semibold text-danger' : undefined}>{runResult.errors}</span>],
            ]}
          />
        )}
      </Dialog>
    </>
  );
}
