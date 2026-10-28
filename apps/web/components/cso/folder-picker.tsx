'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { LoadingBlock } from '@/components/ui/states';
import { FolderTree } from './folder-tree';
import { csoErrorMessage, libraryLabel, useLibraries } from './lib';
import type { CsoAction, CsoLibrary, CsoTreeNode } from './types';
import { Notice } from './ui';

export interface FolderTarget {
  library: CsoLibrary;
  folderId: string | null;
  folderName: string;
}

/**
 * Sélecteur de dossier cible (déplacement, copie, import) : seuls les dossiers actifs sur
 * lesquels l'utilisateur dispose des droits requis sont sélectionnables ; l'API revérifie
 * les droits source ET destination (déplacements inter-navires — CDC §5.6).
 */
export function FolderPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  requiredActions,
  initialLibraryId,
  allowRoot = false,
  confirmLabel = 'Valider',
  onConfirm,
  extra,
  disabledIds,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  requiredActions: CsoAction[];
  initialLibraryId?: string | null;
  /** Autorise la racine de la bibliothèque (dossier déplacé au premier niveau). */
  allowRoot?: boolean;
  confirmLabel?: string;
  onConfirm: (target: FolderTarget) => Promise<unknown> | void;
  extra?: ReactNode;
  /** Dossiers interdits (ex. le dossier déplacé lui-même). */
  disabledIds?: string[];
}) {
  const libs = useLibraries(open);
  const libId = useId();
  const [libraryId, setLibraryId] = useState<string | null>(initialLibraryId ?? null);
  const [target, setTarget] = useState<{ id: string | null; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTarget(null);
      setError(null);
      setLibraryId(initialLibraryId ?? null);
    }
  }, [open, initialLibraryId]);

  const library = libs.data?.find((l) => l.id === libraryId) ?? libs.data?.[0] ?? null;
  const selectable = (n: CsoTreeNode) => n.status === 'ACTIVE' && requiredActions.every((a) => n.actions.includes(a)) && !disabledIds?.includes(n.id);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            disabled={!target || !library}
            loading={busy}
            onClick={async () => {
              if (!target || !library) return;
              setBusy(true);
              setError(null);
              try {
                await onConfirm({ library, folderId: target.id, folderName: target.name });
                onOpenChange(false);
              } catch (e) {
                setError(csoErrorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {libs.isLoading && <LoadingBlock rows={4} />}
      {library && (
        <div className="space-y-3">
          <Field label="Bibliothèque" htmlFor={libId}>
            <Select
              id={libId}
              value={library.id}
              onChange={(e) => {
                setLibraryId(e.target.value);
                setTarget(null);
              }}
            >
              {libs.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {libraryLabel(l)}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <p className="field-label">Dossier de destination</p>
            <div className="max-h-[45vh] overflow-y-auto rounded-md border border-line p-1">
              <FolderTree
                libraryId={library.id}
                libraryName={libraryLabel(library)}
                selectedId={target?.id ?? null}
                rootSelected={allowRoot && target?.id === null}
                onSelectRoot={allowRoot && library.canCreateRootFolder ? () => setTarget({ id: null, name: 'Racine de la bibliothèque' }) : undefined}
                onSelect={(n) => setTarget({ id: n.id, name: n.name })}
                isSelectable={selectable}
                label="Choisir le dossier de destination"
              />
            </div>
            <p className="field-hint">Seuls les dossiers où vous pouvez effectuer cette action sont sélectionnables.</p>
          </div>
          {target && (
            <p className="text-sm">
              Destination : <span className="font-medium text-navy">{libraryLabel(library)} / {target.name}</span>
            </p>
          )}
          {extra}
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      )}
    </Dialog>
  );
}
