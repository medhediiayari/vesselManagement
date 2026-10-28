'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, FolderPlus, Lock, Pencil, Plus, UserPen } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldDialog, permissionLabel, SectionDialog } from '@/components/members/field-dialogs';
import { CUSTOM_FIELD_TYPE_LABELS, type FieldConfig, type FieldDefinition, type FieldSection } from '@/components/members/types';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';

type Pending =
  | { kind: 'section'; item: FieldSection; archive: boolean }
  | { kind: 'field'; item: FieldDefinition; archive: boolean }
  | null;

function move<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list];
  const j = index + delta;
  if (j < 0 || j >= next.length) return next;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

export default function MemberFieldsPage() {
  const { can } = useSession();
  const enabled = can('members.fields.manage');
  const [showArchived, setShowArchived] = useState(false);
  const [sectionDialog, setSectionDialog] = useState<{ open: boolean; section: FieldSection | null }>({ open: false, section: null });
  const [fieldDialog, setFieldDialog] = useState<{ open: boolean; field: FieldDefinition | null; sectionId: string | null }>({
    open: false,
    field: null,
    sectionId: null,
  });
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ['member-custom-fields', true],
    queryFn: () => api.get<FieldConfig>('/members/custom-fields', { query: { archived: true } }),
    enabled,
  });

  if (!enabled) return <Forbidden message="La configuration des champs personnalisés Members est réservée à la permission dédiée." />;
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const cfg = q.data;
  const sections = cfg.sections.filter((s) => showArchived || !s.archivedAt);
  const visibleFields = (list: FieldDefinition[]) => list.filter((f) => showArchived || !f.archivedAt);
  const refresh = () => q.refetch();

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reorderSections = (index: number, delta: number) => {
    const ids = move(sections, index, delta).map((s) => s.id);
    void run(() => api.put('/members/custom-fields/sections/order', { ids }), 'Ordre des sections enregistré');
  };
  const reorderFields = (sectionId: string | null, list: FieldDefinition[], index: number, delta: number) => {
    const ids = move(list, index, delta).map((f) => f.id);
    void run(() => api.put('/members/custom-fields/fields/order', { sectionId, ids }), 'Ordre des champs enregistré');
  };

  const fieldsTable = (sectionId: string | null, all: FieldDefinition[], sectionArchived: boolean) => {
    const list = visibleFields(all);
    if (!list.length) {
      return <p className="px-4 py-3 text-sm text-ink-muted">Aucun champ{showArchived ? '' : ' actif'} dans cette section.</p>;
    }
    return (
      <div className="overflow-x-auto">
        <table className="table-amc">
          <thead>
            <tr>
              <th scope="col" className="w-20">
                Ordre
              </th>
              <th scope="col">Champ</th>
              <th scope="col">Type</th>
              <th scope="col" className="hidden lg:table-cell">
                Consultation / modification
              </th>
              <th scope="col" className="hidden md:table-cell">
                Options
              </th>
              <th scope="col" className="text-right">
                Valeurs
              </th>
              <th scope="col" className="text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((f, i) => (
              <tr key={f.id} className={cn(f.archivedAt && '[&>td]:text-ink-muted')}>
                <td>
                  <span className="flex gap-0.5">
                    <IconButton label={`Monter ${f.label}`} disabled={busy || i === 0} onClick={() => reorderFields(sectionId, list, i, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={`Descendre ${f.label}`} disabled={busy || i === list.length - 1} onClick={() => reorderFields(sectionId, list, i, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                  </span>
                </td>
                <td>
                  <span className="font-medium text-ink">{f.label}</span>
                  <code className="block text-xs text-ink-muted">{f.key}</code>
                </td>
                <td>
                  {CUSTOM_FIELD_TYPE_LABELS[f.type]}
                  {f.type === 'SELECT' && f.options?.choices && (
                    <span className="block max-w-[200px] truncate text-xs text-ink-muted" title={f.options.choices.join(', ')}>
                      {f.options.multiple ? 'Multiple : ' : ''}
                      {f.options.choices.join(', ')}
                    </span>
                  )}
                </td>
                <td className="hidden text-xs lg:table-cell">
                  <span className="flex items-center gap-1">
                    <Lock className="h-3 w-3 text-ink-soft" aria-hidden /> {permissionLabel(f.viewPermission, 'Voir les fiches (défaut)')}
                  </span>
                  <span className="flex items-center gap-1">
                    <Pencil className="h-3 w-3 text-ink-soft" aria-hidden /> {permissionLabel(f.editPermission, 'Modifier les fiches (défaut)')}
                  </span>
                </td>
                <td className="hidden md:table-cell">
                  <span className="flex flex-wrap gap-1">
                    {f.required && <Badge tone="warn" icon={false}>Obligatoire</Badge>}
                    {f.selfEditable && (
                      <Badge tone="info" icon={<UserPen className="h-3.5 w-3.5" aria-hidden />}>
                        Libre-service
                      </Badge>
                    )}
                    {f.archivedAt && (
                      <Badge tone="neutral" icon={<Archive className="h-3.5 w-3.5" aria-hidden />}>
                        Archivé
                      </Badge>
                    )}
                  </span>
                </td>
                <td className="text-right tabular">{f.valuesCount}</td>
                <td>
                  <span className="flex justify-end gap-1">
                    {!f.archivedAt && (
                      <IconButton label={`Modifier ${f.label}`} onClick={() => setFieldDialog({ open: true, field: f, sectionId: f.sectionId })}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                    )}
                    {f.archivedAt ? (
                      <IconButton
                        label={`Réactiver ${f.label}`}
                        disabled={sectionArchived}
                        onClick={() => setPending({ kind: 'field', item: f, archive: false })}
                      >
                        <ArchiveRestore className="h-4 w-4" />
                      </IconButton>
                    ) : (
                      <IconButton label={`Archiver ${f.label}`} onClick={() => setPending({ kind: 'field', item: f, archive: true })}>
                        <Archive className="h-4 w-4" />
                      </IconButton>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Marins & personnel', href: '/members' }, { label: 'Champs personnalisés' }]}
        title="Champs personnalisés des fiches"
        description="Sections et champs propres au module Members : ordre d'affichage, droits de consultation et de modification par champ, ouverture au libre-service. Archivage et réactivation sans perte de valeurs, jamais de suppression."
        actions={
          <>
            <Button variant="secondary" onClick={() => setSectionDialog({ open: true, section: null })}>
              <FolderPlus className="h-4 w-4" aria-hidden /> Nouvelle section
            </Button>
            <Button onClick={() => setFieldDialog({ open: true, field: null, sectionId: null })}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau champ
            </Button>
          </>
        }
      />
      <div className="mb-3 flex justify-end">
        <Checkbox label="Afficher les éléments archivés" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
      </div>

      <div className="space-y-4">
        {!sections.length && !visibleFields(cfg.unsectioned).length && (
          <Panel>
            <EmptyState title="Aucun champ personnalisé" description="Créez une section puis ses champs : ils apparaîtront sur l'onglet Profil des fiches." />
          </Panel>
        )}
        {sections.map((s, i) => (
          <Panel
            key={s.id}
            bodyClassName="p-0"
            className={cn(s.archivedAt && 'opacity-80')}
            title={
              <span className="flex items-center gap-2">
                {s.name}
                {s.archivedAt && (
                  <Badge tone="neutral" icon={<Archive className="h-3.5 w-3.5" aria-hidden />}>
                    Section archivée
                  </Badge>
                )}
              </span>
            }
            actions={
              <>
                <IconButton label={`Monter la section ${s.name}`} disabled={busy || i === 0} onClick={() => reorderSections(i, -1)}>
                  <ArrowUp className="h-4 w-4" />
                </IconButton>
                <IconButton label={`Descendre la section ${s.name}`} disabled={busy || i === sections.length - 1} onClick={() => reorderSections(i, 1)}>
                  <ArrowDown className="h-4 w-4" />
                </IconButton>
                {!s.archivedAt && (
                  <>
                    <IconButton label={`Renommer ${s.name}`} onClick={() => setSectionDialog({ open: true, section: s })}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <Button size="sm" variant="secondary" onClick={() => setFieldDialog({ open: true, field: null, sectionId: s.id })}>
                      <Plus className="h-4 w-4" aria-hidden /> Champ
                    </Button>
                  </>
                )}
                {s.archivedAt ? (
                  <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'section', item: s, archive: false })}>
                    <ArchiveRestore className="h-4 w-4" aria-hidden /> Réactiver
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'section', item: s, archive: true })}>
                    <Archive className="h-4 w-4" aria-hidden /> Archiver
                  </Button>
                )}
              </>
            }
          >
            {fieldsTable(s.id, s.fields, !!s.archivedAt)}
          </Panel>
        ))}
        {(cfg.unsectioned.length > 0 || sections.length > 0) && (
          <Panel title="Champs hors section (informations complémentaires)" bodyClassName="p-0">
            {fieldsTable(null, cfg.unsectioned, false)}
          </Panel>
        )}
      </div>

      <SectionDialog open={sectionDialog.open} onOpenChange={(o) => setSectionDialog((d) => ({ ...d, open: o }))} section={sectionDialog.section} onSaved={refresh} />
      <FieldDialog
        open={fieldDialog.open}
        onOpenChange={(o) => setFieldDialog((d) => ({ ...d, open: o }))}
        field={fieldDialog.field}
        sections={cfg.sections}
        defaultSectionId={fieldDialog.sectionId}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending
            ? `${pending.archive ? 'Archiver' : 'Réactiver'} ${pending.kind === 'section' ? 'la section' : 'le champ'} « ${pending.kind === 'section' ? pending.item.name : pending.item.label} »`
            : ''
        }
        description={
          pending?.archive
            ? pending.kind === 'section'
              ? 'Les champs de la section sont masqués des fiches ; toutes les valeurs sont conservées et réapparaissent à la réactivation.'
              : `Le champ est masqué des fiches ; ses ${pending.item.valuesCount} valeur(s) sont conservées et réapparaissent à la réactivation.`
            : 'Le champ ou la section redevient visible avec les valeurs existantes.'
        }
        confirmLabel={pending?.archive ? 'Archiver' : 'Réactiver'}
        tone={pending?.archive ? 'danger' : 'primary'}
        onConfirm={async () => {
          if (!pending) return;
          const base = pending.kind === 'section' ? 'sections' : 'fields';
          await api.post(`/members/custom-fields/${base}/${pending.item.id}/${pending.archive ? 'archive' : 'reactivate'}`);
          toast.success(pending.archive ? 'Archivé' : 'Réactivé');
          await refresh();
        }}
      />
    </>
  );
}
