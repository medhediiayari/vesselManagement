'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive, ChevronDown, ChevronRight, Folder, FolderOpen, Library, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { ErrorState, Skeleton } from '@/components/ui/states';
import type { CsoTreeNode } from './types';

interface Flat {
  id: string | null; // null = racine de la bibliothèque
  name: string;
  level: number;
  parentId: string | null | undefined;
  node: CsoTreeNode | null;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Arborescence d'une bibliothèque CSO (CDC §6.4 « tree folders ») — chargement paresseux par
 * profondeur : seuls les niveaux nécessaires aux nœuds dépliés sont demandés à l'API, qui ne
 * renvoie que les dossiers visibles (zones non autorisées absentes, jamais signalées).
 * Accessibilité : motif WAI-ARIA « tree » (flèches, Entrée/Espace, Début/Fin), focus visible.
 */
export function FolderTree({
  libraryId,
  libraryName,
  includeArchived = false,
  selectedId,
  onSelect,
  onSelectRoot,
  rootSelected,
  isSelectable,
  reveal,
  label = 'Arborescence des dossiers',
  className,
}: {
  libraryId: string;
  libraryName: string;
  includeArchived?: boolean;
  selectedId: string | null;
  onSelect: (node: CsoTreeNode) => void;
  /** Rend la racine sélectionnable (ex. explorateur, déplacement d'un dossier à la racine). */
  onSelectRoot?: () => void;
  rootSelected?: boolean;
  isSelectable?: (node: CsoTreeNode) => boolean;
  /** Ancêtres à déplier pour révéler un dossier (et profondeur de ce dossier). */
  reveal?: { ids: string[]; depth: number } | null;
  label?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null | undefined>(undefined);
  const depthById = useRef(new Map<string, number>());
  const itemRefs = useRef(new Map<string, HTMLDivElement | null>());

  useEffect(() => {
    setExpanded(new Set());
    depthById.current.clear();
  }, [libraryId]);

  useEffect(() => {
    if (!reveal?.ids.length) return;
    setExpanded((prev) => {
      const missing = reveal.ids.filter((id) => !prev.has(id));
      if (!missing.length) return prev;
      const n = new Set(prev);
      missing.forEach((id) => n.add(id));
      return n;
    });
  }, [reveal]);

  const maxExpandedDepth = Math.max(-1, ...[...expanded].map((id) => depthById.current.get(id) ?? -1));
  const maxDepth = Math.min(50, Math.max(1, maxExpandedDepth + 2, (reveal?.depth ?? -1) + 1));

  const tree = useQuery({
    queryKey: ['cso', 'tree', libraryId, includeArchived, maxDepth],
    queryFn: () => api.get<CsoTreeNode[]>(`/cso/libraries/${libraryId}/tree`, { query: { maxDepth, includeArchived } }),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === libraryId && prevQuery?.queryKey[3] === includeArchived ? prev : undefined),
  });

  useEffect(() => {
    const walk = (nodes: CsoTreeNode[]) =>
      nodes.forEach((n) => {
        depthById.current.set(n.id, n.depth);
        walk(n.children);
      });
    if (tree.data) walk(tree.data);
  }, [tree.data]);

  const flat = useMemo(() => {
    const out: Flat[] = [];
    const rootLevel = onSelectRoot ? 2 : 1;
    if (onSelectRoot) out.push({ id: null, name: libraryName, level: 1, parentId: undefined, node: null, hasChildren: !!tree.data?.length, expanded: true });
    const walk = (nodes: CsoTreeNode[], level: number, parentId: string | null) => {
      for (const n of nodes) {
        const open = expanded.has(n.id);
        // Profondeur maximale atteinte : enfants inconnus => chevron proposé
        const unknown = n.depth >= maxDepth;
        out.push({ id: n.id, name: n.name, level, parentId, node: n, hasChildren: unknown || n.children.length > 0, expanded: open });
        if (open) walk(n.children, level + 1, n.id);
      }
    };
    walk(tree.data ?? [], rootLevel, null);
    return out;
  }, [tree.data, expanded, maxDepth, onSelectRoot, libraryName]);

  const keyOf = (id: string | null) => id ?? '__root__';
  const currentFocus = focusId !== undefined && flat.some((f) => f.id === focusId) ? focusId : (flat.find((f) => (f.id === null ? rootSelected : f.id === selectedId))?.id ?? flat[0]?.id ?? null);

  function focus(id: string | null) {
    setFocusId(id);
    requestAnimationFrame(() => itemRefs.current.get(keyOf(id))?.focus());
  }

  function toggle(id: string, open?: boolean) {
    setExpanded((prev) => {
      const n = new Set(prev);
      const willOpen = open ?? !n.has(id);
      if (willOpen) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  function activate(f: Flat) {
    if (f.id === null) onSelectRoot?.();
    else if (f.node && (!isSelectable || isSelectable(f.node))) onSelect(f.node);
  }

  function onKey(e: KeyboardEvent, f: Flat, index: number) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (index < flat.length - 1) focus(flat[index + 1].id);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (index > 0) focus(flat[index - 1].id);
        break;
      case 'Home':
        e.preventDefault();
        focus(flat[0].id);
        break;
      case 'End':
        e.preventDefault();
        focus(flat[flat.length - 1].id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (f.id && f.hasChildren && !f.expanded) toggle(f.id, true);
        else if (f.hasChildren && index < flat.length - 1) focus(flat[index + 1].id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (f.id && f.expanded) toggle(f.id, false);
        else if (f.parentId !== undefined) focus(f.parentId);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(f);
        break;
    }
  }

  if (tree.error) return <ErrorState error={tree.error} onRetry={() => tree.refetch()} />;

  return (
    <div className={className}>
      {tree.isLoading ? (
        <div className="space-y-1.5 p-2" role="status" aria-label="Chargement de l'arborescence">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : (
        <div role="tree" aria-label={label} aria-busy={tree.isFetching || undefined}>
          {flat.length === 0 || (flat.length === 1 && flat[0].id === null && !tree.data?.length) ? (
            <>
              {onSelectRoot && flat[0] && renderRow(flat[0], 0)}
              <p className="px-3 py-2 text-sm text-ink-muted">Aucun dossier accessible dans cette bibliothèque.</p>
            </>
          ) : (
            flat.map((f, i) => renderRow(f, i))
          )}
        </div>
      )}
    </div>
  );

  function renderRow(f: Flat, index: number) {
    const selected = f.id === null ? !!rootSelected : f.id === selectedId;
    const archived = f.node?.status === 'ARCHIVED';
    const selectable = f.id === null ? !!onSelectRoot : !isSelectable || (f.node ? isSelectable(f.node) : false);
    const loadingChildren = f.expanded && tree.isFetching && f.node && f.node.depth >= maxDepth - 1;
    return (
      <div
        key={keyOf(f.id)}
        ref={(el) => {
          itemRefs.current.set(keyOf(f.id), el);
        }}
        role="treeitem"
        aria-level={f.level}
        aria-selected={selected}
        aria-expanded={f.id !== null && f.hasChildren ? f.expanded : undefined}
        aria-disabled={!selectable || undefined}
        tabIndex={currentFocus === f.id ? 0 : -1}
        onKeyDown={(e) => onKey(e, f, index)}
        onFocus={() => setFocusId(f.id)}
        onClick={() => {
          setFocusId(f.id);
          activate(f);
        }}
        className={cn(
          'group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-sm outline-none hover:bg-navy-50 focus-visible:ring-2 focus-visible:ring-action',
          selected && 'bg-action-50 font-medium text-navy',
          !selectable && 'cursor-default text-ink-soft',
          archived && 'italic text-ink-muted',
        )}
        style={{ paddingLeft: 4 + (f.level - 1) * 14 }}
        title={!selectable && f.node ? 'Destination non autorisée pour cette action' : undefined}
      >
        {f.id !== null && f.hasChildren ? (
          <span
            aria-hidden
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-navy-50"
            onClick={(e) => {
              e.stopPropagation();
              toggle(f.id!);
            }}
          >
            {loadingChildren ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : f.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        ) : (
          <span className="inline-block h-5 w-5 shrink-0" aria-hidden />
        )}
        {f.id === null ? (
          <Library className="h-4 w-4 shrink-0 text-navy-600" aria-hidden />
        ) : archived ? (
          <Archive className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
        ) : f.expanded || selected ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-action" aria-hidden />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-action" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{f.name}</span>
        {archived && <span className="text-xs not-italic text-ink-soft">archivé</span>}
      </div>
    );
  }
}
