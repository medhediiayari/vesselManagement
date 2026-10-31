"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { certKeys } from "./lib";
import type {
  CertificateCategoryDto,
  CertificateFolderDto,
  FolderRef,
} from "./types";

// =============================================================================
// Données
// =============================================================================

export function useCertificateFolders(enabled = true) {
  return useQuery({
    queryKey: certKeys.folders,
    queryFn: () => api.get<CertificateFolderDto[]>("/certificate-folders"),
    enabled,
    staleTime: 30_000,
  });
}

export function useCertificateCategories(enabled = true) {
  return useQuery({
    queryKey: certKeys.categories,
    queryFn: () => api.get<CertificateCategoryDto[]>("/certificate-categories"),
    enabled,
    staleTime: 60_000,
  });
}

interface FolderNode extends CertificateFolderDto {
  depth: number;
  children: FolderNode[];
  /** Certificats du dossier et de ses sous-dossiers */
  total: number;
}

function buildTree(folders: CertificateFolderDto[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>(
    folders.map((f) => [f.id, { ...f, depth: 0, children: [], total: 0 }]),
  );
  const roots: FolderNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const order = (a: FolderNode, b: FolderNode) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fr");
  const walk = (list: FolderNode[], depth: number): number => {
    list.sort(order);
    let sum = 0;
    for (const n of list) {
      n.depth = depth;
      n.total = n.certificateCount + walk(n.children, depth + 1);
      sum += n.total;
    }
    return sum;
  };
  walk(roots, 0);
  return roots;
}

/** Liste à plat ordonnée (options de sélection indentées). */
export function flattenFolders(
  folders: CertificateFolderDto[],
): (CertificateFolderDto & { depth: number; path: string })[] {
  const out: (CertificateFolderDto & { depth: number; path: string })[] = [];
  const visit = (list: FolderNode[], prefix: string) => {
    for (const n of list) {
      const path = prefix ? `${prefix} / ${n.name}` : n.name;
      out.push({ ...n, path });
      visit(n.children, path);
    }
  };
  visit(buildTree(folders), "");
  return out;
}

// =============================================================================
// Éléments d'arborescence
// =============================================================================

export function TreeItem({
  active,
  onClick,
  icon,
  children,
  depth = 0,
  count,
  toggle,
  actions,
  nested,
}: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
  depth?: number;
  count?: number;
  /** Bouton déplier / replier (dossiers avec sous-dossiers) */
  toggle?: ReactNode;
  /** Actions de gestion, affichées au survol / focus */
  actions?: ReactNode;
  /** Sous-arbre (liste imbriquée) */
  nested?: ReactNode;
}) {
  return (
    <li>
      <div
        className="group relative flex items-center"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="flex w-4 shrink-0 justify-center">{toggle}</span>
        <button
          type="button"
          onClick={onClick}
          aria-current={active ? "true" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-navy-50",
            active ? "bg-action-50 font-semibold text-navy" : "text-ink",
          )}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{children}</span>
          {count !== undefined && count > 0 && (
            <span
              className={cn(
                "shrink-0 text-xs tabular text-ink-soft",
                actions && "group-focus-within:invisible group-hover:invisible",
              )}
            >
              {count}
            </span>
          )}
        </button>
        {actions && (
          <div className="absolute right-0.5 top-1/2 hidden -translate-y-1/2 items-center rounded-md bg-white/95 shadow-sm group-focus-within:flex group-hover:flex">
            {actions}
          </div>
        )}
      </div>
      {nested}
    </li>
  );
}

function TreeAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-navy-50 hover:text-action focus-visible:outline-2 focus-visible:outline-action"
    >
      {children}
    </button>
  );
}

function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mt-3 flex items-center justify-between px-2 pb-1">
      <p className="text-xs font-semibold text-ink-muted">{children}</p>
      {action}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-navy-50 hover:text-action"
    >
      <Plus className="h-4 w-4" aria-hidden />
    </button>
  );
}

// =============================================================================
// Section « Dossiers »
// =============================================================================

type FolderDialog =
  | { mode: "create"; parent: CertificateFolderDto | null }
  | { mode: "rename"; folder: CertificateFolderDto }
  | null;

/** Identifiants d'un dossier et de ses descendants (destinations interdites d'un déplacement). */
function subtreeIds(folders: CertificateFolderDto[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

const folderOrder = (a: CertificateFolderDto, b: CertificateFolderDto) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fr");

export function FolderSection({
  folders,
  selectedId,
  onSelect,
}: {
  folders: CertificateFolderDto[];
  /** Dossier filtré ("none" = non classés) */
  selectedId: string;
  onSelect: (folderId: string | null) => void;
}) {
  const { can } = useSession();
  const qc = useQueryClient();
  const manage = can("certificates.folders.manage");
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<FolderDialog>(null);
  const [toDelete, setToDelete] = useState<FolderNode | null>(null);
  const [toMove, setToMove] = useState<FolderNode | null>(null);

  if (!folders.length && !manage) return null;

  // Fiches et panneaux ouverts affichent le nom du dossier (CRT-14)
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: certKeys.folders }),
      qc.invalidateQueries({ queryKey: certKeys.list }),
      qc.invalidateQueries({ queryKey: certKeys.details }),
    ]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (n: FolderNode): ReactNode => {
    const open = !collapsed.has(n.id);
    const active = selectedId === n.id;
    return (
      <TreeItem
        key={n.id}
        depth={n.depth}
        active={active}
        onClick={() => onSelect(active ? null : n.id)}
        count={n.total}
        icon={
          active || (open && n.children.length) ? (
            <FolderOpen
              className="h-4 w-4 shrink-0 text-teal-700"
              aria-hidden
            />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-teal-700" aria-hidden />
          )
        }
        toggle={
          n.children.length ? (
            <button
              type="button"
              onClick={() => toggle(n.id)}
              aria-expanded={open}
              aria-label={`${open ? "Replier" : "Déplier"} ${n.name}`}
              className="rounded text-ink-soft hover:text-ink"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          ) : null
        }
        actions={
          manage ? (
            <>
              <TreeAction
                label={`Nouveau sous-dossier dans ${n.name}`}
                onClick={() => setDialog({ mode: "create", parent: n })}
              >
                <FolderPlus className="h-3.5 w-3.5" aria-hidden />
              </TreeAction>
              <TreeAction
                label={`Renommer ${n.name}`}
                onClick={() => setDialog({ mode: "rename", folder: n })}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </TreeAction>
              <TreeAction
                label={`Déplacer ${n.name}…`}
                onClick={() => setToMove(n)}
              >
                <FolderInput className="h-3.5 w-3.5" aria-hidden />
              </TreeAction>
              <TreeAction
                label={`Supprimer ${n.name}`}
                onClick={() => setToDelete(n)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </TreeAction>
            </>
          ) : undefined
        }
        nested={
          open && n.children.length > 0 ? (
            <ul className="mt-0.5 space-y-0.5">{n.children.map(renderNode)}</ul>
          ) : undefined
        }
      >
        {n.name}
      </TreeItem>
    );
  };

  return (
    <>
      <SectionTitle
        action={
          manage ? (
            <AddButton
              label="Nouveau dossier à la racine"
              onClick={() => setDialog({ mode: "create", parent: null })}
            />
          ) : undefined
        }
      >
        Dossiers
      </SectionTitle>
      {folders.length ? (
        <ul className="space-y-0.5">
          {tree.map(renderNode)}
          <TreeItem
            active={selectedId === "none"}
            onClick={() => onSelect(selectedId === "none" ? null : "none")}
            icon={
              <Folder className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
            }
          >
            <span className="text-ink-muted">Non classés</span>
          </TreeItem>
        </ul>
      ) : (
        <button
          type="button"
          onClick={() => setDialog({ mode: "create", parent: null })}
          className="mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 py-1.5 text-left text-xs text-ink-muted hover:border-action hover:text-action"
        >
          <FolderPlus className="h-3.5 w-3.5" aria-hidden /> Créer un premier
          dossier
        </button>
      )}

      {dialog && (
        <NameDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={
            dialog.mode === "rename"
              ? "Renommer le dossier"
              : dialog.parent
                ? `Nouveau sous-dossier dans « ${dialog.parent.name} »`
                : "Nouveau dossier"
          }
          description="Classement de l’arborescence : sans effet sur les droits d’accès aux certificats."
          label="Nom du dossier"
          initial={dialog.mode === "rename" ? dialog.folder.name : ""}
          maxLength={120}
          confirmLabel={
            dialog.mode === "rename" ? "Renommer" : "Créer le dossier"
          }
          onSubmit={async (name) => {
            if (dialog.mode === "rename") {
              await api.patch(`/certificate-folders/${dialog.folder.id}`, {
                name,
              });
              toast.success("Dossier renommé");
            } else {
              const created = await api.post<CertificateFolderDto>(
                "/certificate-folders",
                { name, parentId: dialog.parent?.id ?? null },
              );
              toast.success(`Dossier « ${created.name} » créé`);
              if (dialog.parent)
                setCollapsed(
                  (prev) =>
                    new Set([...prev].filter((id) => id !== dialog.parent!.id)),
                );
            }
            await refresh();
          }}
        />
      )}
      {toDelete && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setToDelete(null)}
          title={`Supprimer le dossier « ${toDelete.name} » ?`}
          description={deleteFolderMessage(toDelete)}
          confirmLabel="Supprimer"
          tone="danger"
          onConfirm={async () => {
            await api.delete(`/certificate-folders/${toDelete.id}`);
            toast.success("Dossier supprimé");
            if (selectedId === toDelete.id) onSelect(null);
            await refresh();
          }}
        />
      )}
      {toMove && (
        <MoveFolderDialog
          folder={toMove}
          folders={folders}
          onClose={() => setToMove(null)}
          onMoved={async (parentId) => {
            if (parentId)
              setCollapsed(
                (prev) => new Set([...prev].filter((id) => id !== parentId)),
              );
            await refresh();
          }}
        />
      )}
    </>
  );
}

/**
 * Message de suppression fondé sur le nombre réel de certificats déplacés (archivés et hors
 * périmètre compris, connu des gestionnaires) — CRT-06.
 */
function deleteFolderMessage(folder: FolderNode): string {
  if (folder.children.length)
    return "Ce dossier contient des sous-dossiers : supprimez-les ou déplacez-les d’abord.";
  const target = folder.parentId ? "le dossier parent" : "les non classés";
  const filed = folder.filedCount ?? folder.certificateCount;
  if (!filed) return "Le dossier est vide. Aucun certificat n’est supprimé.";
  const hidden = filed - folder.certificateCount;
  return `${filed} certificat(s) classé(s) ici rejoignent ${target}${
    hidden > 0
      ? `, dont ${hidden} archivé(s), sans révision ou hors de votre périmètre`
      : ""
  }. Aucun certificat n’est supprimé.`;
}

/**
 * Déplacement et réordonnancement d'un dossier (CRT-13) : nouveau parent (le dossier et ses
 * sous-dossiers sont exclus) et position parmi les dossiers de même niveau.
 */
function MoveFolderDialog({
  folder,
  folders,
  onClose,
  onMoved,
}: {
  folder: CertificateFolderDto;
  folders: CertificateFolderDto[];
  onClose: () => void;
  onMoved: (parentId: string | null) => Promise<unknown>;
}) {
  const ids = { parent: useId(), position: useId() };
  const excluded = useMemo(
    () => subtreeIds(folders, folder.id),
    [folders, folder.id],
  );
  const targets = useMemo(
    () => folders.filter((f) => !excluded.has(f.id)),
    [folders, excluded],
  );
  const siblingsOf = (parentId: string | null) =>
    folders
      .filter((f) => f.parentId === parentId && f.id !== folder.id)
      .sort(folderOrder);
  const [parent, setParent] = useState(folder.parentId ?? "");
  const [position, setPosition] = useState(() => {
    const index = folders
      .filter((f) => f.parentId === folder.parentId)
      .sort(folderOrder)
      .findIndex((f) => f.id === folder.id);
    return index < 0 ? siblingsOf(folder.parentId).length : index;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parentId = parent || null;
  const siblings = siblingsOf(parentId);

  async function save() {
    const order = [...siblings];
    order.splice(Math.min(position, order.length), 0, folder);
    const moved = parentId !== folder.parentId;
    const patches = order
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => f.sortOrder !== i || (f.id === folder.id && moved))
      // Le dossier déplacé d'abord : les contrôles serveur (nom, profondeur) passent avant le reste
      .sort(
        (a, b) => Number(b.f.id === folder.id) - Number(a.f.id === folder.id),
      );
    if (!patches.length) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const { f, i } of patches) {
        await api.patch(`/certificate-folders/${f.id}`, {
          sortOrder: i,
          ...(f.id === folder.id && moved ? { parentId } : {}),
        });
      }
      toast.success(
        moved
          ? `Dossier « ${folder.name} » déplacé`
          : "Ordre des dossiers mis à jour",
      );
      await onMoved(parentId);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      await onMoved(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Déplacer le dossier « ${folder.name} »`}
      description="Le dossier garde ses sous-dossiers et ses certificats. Classement sans effet sur les droits d’accès."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy}>
            Déplacer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}
        <Field
          label="Dossier parent"
          htmlFor={ids.parent}
          hint="Le dossier lui-même et ses sous-dossiers ne sont pas proposés."
        >
          <FolderSelect
            id={ids.parent}
            value={parent}
            onChange={(v) => {
              setParent(v);
              setPosition(siblingsOf(v || null).length);
            }}
            folders={targets}
            emptyLabel="Racine de l’arborescence"
          />
        </Field>
        <Field label="Position" htmlFor={ids.position}>
          <Select
            id={ids.position}
            value={String(Math.min(position, siblings.length))}
            onChange={(e) => setPosition(Number(e.target.value))}
          >
            <option value="0">En premier</option>
            {siblings.map((sib, i) => (
              <option key={sib.id} value={String(i + 1)}>
                Après « {sib.name} »
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

// =============================================================================
// Section « Catégories »
// =============================================================================

export function CategorySection({
  categories,
  selected,
  onSelect,
}: {
  categories: CertificateCategoryDto[];
  selected: string;
  onSelect: (name: string | null) => void;
}) {
  const { can } = useSession();
  const qc = useQueryClient();
  const manage = can("certificates.categories.manage");
  const [dialog, setDialog] = useState<
    | { mode: "create" }
    | { mode: "rename"; category: CertificateCategoryDto }
    | null
  >(null);
  const [toDelete, setToDelete] = useState<CertificateCategoryDto | null>(null);

  if (!categories.length && !manage) return null;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: certKeys.categories }),
      qc.invalidateQueries({ queryKey: certKeys.types }),
      qc.invalidateQueries({ queryKey: certKeys.list }),
      qc.invalidateQueries({ queryKey: certKeys.details }),
    ]);

  return (
    <>
      <SectionTitle
        action={
          manage ? (
            <AddButton
              label="Nouvelle catégorie"
              onClick={() => setDialog({ mode: "create" })}
            />
          ) : undefined
        }
      >
        Catégories
      </SectionTitle>
      <ul className="space-y-0.5">
        {categories.map((c) => (
          <TreeItem
            key={c.name}
            active={selected === c.name}
            onClick={() => onSelect(selected === c.name ? null : c.name)}
            count={c.certificateCount}
            icon={
              <Tag className="h-3.5 w-3.5 shrink-0 text-ink-soft" aria-hidden />
            }
            actions={
              manage && c.id ? (
                <>
                  <TreeAction
                    label={`Renommer la catégorie ${c.name}`}
                    onClick={() => setDialog({ mode: "rename", category: c })}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </TreeAction>
                  <TreeAction
                    label={`Supprimer la catégorie ${c.name}`}
                    onClick={() => setToDelete(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </TreeAction>
                </>
              ) : undefined
            }
          >
            {c.name}
            {c.typeCount === 0 && (
              <span className="ml-1 text-xs font-normal text-ink-soft">
                (vide)
              </span>
            )}
          </TreeItem>
        ))}
      </ul>

      {dialog && (
        <NameDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={
            dialog.mode === "rename"
              ? `Renommer la catégorie « ${dialog.category.name} »`
              : "Nouvelle catégorie"
          }
          description={
            dialog.mode === "rename"
              ? `Le nouveau nom s’applique aux ${dialog.category.typeCount} type(s) de certificat de cette catégorie.`
              : "La catégorie est ensuite proposée lors de la configuration des types de certificat."
          }
          label="Nom de la catégorie"
          hint="Ex. STATUTORY, CLASS, STCW, MEDICAL…"
          initial={dialog.mode === "rename" ? dialog.category.name : ""}
          maxLength={60}
          minLength={2}
          confirmLabel={
            dialog.mode === "rename" ? "Renommer" : "Créer la catégorie"
          }
          onSubmit={async (name) => {
            if (dialog.mode === "rename") {
              await api.patch(`/certificate-categories/${dialog.category.id}`, {
                name,
              });
              toast.success("Catégorie renommée");
              if (selected === dialog.category.name) onSelect(name);
            } else {
              await api.post("/certificate-categories", { name });
              toast.success(`Catégorie « ${name} » créée`);
            }
            await refresh();
          }}
        />
      )}
      {toDelete && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setToDelete(null)}
          title={`Supprimer la catégorie « ${toDelete.name} » ?`}
          description={
            toDelete.typeCount
              ? `${toDelete.typeCount} type(s) de certificat utilisent cette catégorie : réaffectez-les d’abord dans Configuration.`
              : "Aucun type n’utilise cette catégorie."
          }
          confirmLabel="Supprimer"
          tone="danger"
          onConfirm={async () => {
            await api.delete(`/certificate-categories/${toDelete.id}`);
            toast.success("Catégorie supprimée");
            if (selected === toDelete.name) onSelect(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

// =============================================================================
// Dialogues
// =============================================================================

function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  hint,
  initial,
  maxLength,
  minLength = 1,
  confirmLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  label: string;
  hint?: string;
  initial: string;
  maxLength: number;
  minLength?: number;
  confirmLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = name.trim();

  async function save() {
    if (value.length < minLength) {
      setError(
        minLength > 1 ? `${minLength} caractères minimum` : "Nom requis",
      );
      return;
    }
    if (value === initial) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      onOpenChange(false);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.fieldErrors.name ?? e.message)
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Annuler
          </Button>
          <Button onClick={save} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label={label}
          required
          htmlFor={id}
          error={error ?? undefined}
          hint={hint}
        >
          <Input
            id={id}
            value={name}
            autoFocus
            maxLength={maxLength}
            invalid={!!error}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** Sélecteur de dossier (options indentées) — "" = non classé. */
export function FolderSelect({
  id,
  value,
  onChange,
  folders,
  emptyLabel = "Non classé",
  className,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  folders: CertificateFolderDto[];
  emptyLabel?: string;
  className?: string;
}) {
  const flat = useMemo(() => flattenFolders(folders), [folders]);
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      <option value="">{emptyLabel}</option>
      {flat.map((f) => (
        <option key={f.id} value={f.id} title={f.path}>
          {"  ".repeat(f.depth)}
          {f.depth ? "└ " : ""}
          {f.name}
        </option>
      ))}
    </Select>
  );
}

/** Classement d'un certificat dans l'arborescence (certificates.folders.manage). */
export function FileCertificateButton({
  certificateId,
  folder,
  onDone,
  size = "sm",
}: {
  certificateId: string;
  folder: FolderRef | null;
  onDone?: () => void | Promise<void>;
  size?: "sm" | "md";
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(folder?.id ?? "");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const folders = useCertificateFolders(open);

  async function save() {
    setBusy(true);
    try {
      await api.put("/certificate-folders/assignments", {
        certificateIds: [certificateId],
        folderId: value || null,
      });
      toast.success(
        value ? "Certificat classé" : "Certificat retiré du dossier",
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: certKeys.detail(certificateId) }),
        qc.invalidateQueries({ queryKey: certKeys.list }),
        qc.invalidateQueries({ queryKey: certKeys.folders }),
      ]);
      await onDone?.();
      setOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        onClick={() => {
          setValue(folder?.id ?? "");
          setOpen(true);
        }}
      >
        <FolderInput className="h-4 w-4" aria-hidden />{" "}
        {folder ? "Changer de dossier" : "Classer"}
      </Button>
      {open && (
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Classer le certificat"
          description="Le dossier sert au rangement de l’arborescence ; il ne modifie ni la validité ni les droits d’accès."
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Annuler
              </Button>
              <Button
                onClick={save}
                loading={busy}
                disabled={(folder?.id ?? "") === value}
              >
                Enregistrer
              </Button>
            </>
          }
        >
          <Field
            label="Dossier"
            htmlFor={id}
            hint={
              folders.data && !folders.data.length
                ? "Aucun dossier : créez-en un depuis l’arborescence de l’explorateur."
                : undefined
            }
          >
            <FolderSelect
              id={id}
              value={value}
              onChange={setValue}
              folders={folders.data ?? []}
            />
          </Field>
        </Dialog>
      )}
    </>
  );
}
