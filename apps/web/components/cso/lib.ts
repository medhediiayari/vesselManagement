'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from '@/lib/api';
import type {
  ApprovalsInbox,
  CsoAction,
  CsoCategory,
  CsoDocumentDetail,
  CsoDocumentSummary,
  CsoFieldDefinition,
  CsoLibrary,
  CsoVersion,
  EffectiveAccess,
} from './types';
import { STANDARD_FIELD_LABELS } from './types';

/** Préfixe commun des clés de requête CSO : une mutation invalide tout le module. */
export const CSO_KEY = ['cso'] as const;

export function useCsoInvalidate() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: CSO_KEY }), [qc]);
}

export function useLibraries(enabled = true) {
  return useQuery({
    queryKey: ['cso', 'libraries'],
    queryFn: () => api.get<CsoLibrary[]>('/cso/libraries'),
    staleTime: 60_000,
    enabled,
  });
}

export function useFolderAccess(folderId: string | null | undefined) {
  return useQuery({
    queryKey: ['cso', 'folder-access', folderId],
    queryFn: () => api.get<EffectiveAccess>(`/cso/folders/${folderId}/effective-access`),
    enabled: !!folderId,
  });
}

export function useDocument(id: string | null | undefined) {
  return useQuery({
    queryKey: ['cso', 'document', id],
    queryFn: () => api.get<CsoDocumentDetail>(`/cso/documents/${id}`),
    enabled: !!id,
  });
}

export function useDocumentAccess(id: string | null | undefined) {
  return useQuery({
    queryKey: ['cso', 'doc-access', id],
    queryFn: () => api.get<EffectiveAccess>(`/cso/documents/${id}/effective-access`),
    enabled: !!id,
  });
}

/** Boîte de validation : sert aussi à savoir si l'utilisateur est validateur ÉLIGIBLE d'une version. */
export function useApprovals(enabled: boolean) {
  return useQuery({
    queryKey: ['cso', 'approvals'],
    queryFn: () => api.get<ApprovalsInbox>('/cso/approvals'),
    enabled,
    staleTime: 15_000,
  });
}

/** Catégories applicables à une bibliothèque (flotte + navire de la bibliothèque). */
export function useCategoriesFor(library: CsoLibrary | null | undefined) {
  return useQuery({
    queryKey: ['cso', 'categories', 'for', library?.id],
    queryFn: () => api.get<CsoCategory[]>('/cso/categories', { query: { vesselId: library?.vessel?.id } }),
    enabled: !!library,
    staleTime: 60_000,
    select: (rows) => rows.filter((c) => c.scope === 'FLEET' || (library?.vessel && c.vesselId === library.vessel.id)),
  });
}

export function useCategoryFields(categoryId: string | null | undefined) {
  return useQuery({
    queryKey: ['cso', 'category-fields', categoryId],
    queryFn: () => api.get<CsoFieldDefinition[]>(`/cso/categories/${categoryId}/fields`),
    enabled: !!categoryId,
    staleTime: 60_000,
  });
}

export function has(actions: CsoAction[] | undefined | null, a: CsoAction): boolean {
  return !!actions?.includes(a);
}

/** Version « archivée » au sens des droits : remplacée, ou officielle d'un document archivé. */
export function isArchivedVersion(doc: Pick<CsoDocumentSummary, 'status'>, v: Pick<CsoVersion, 'status'>): boolean {
  return v.status === 'SUPERSEDED' || (doc.status === 'ARCHIVED' && v.status === 'PUBLISHED');
}

/** Droits de fichier d'une version (miroir de canAccessVersion côté API — indication UI). */
export function versionRights(doc: Pick<CsoDocumentSummary, 'status'>, v: Pick<CsoVersion, 'status' | 'file'>, actions: CsoAction[] | undefined) {
  if (!v.file) return { preview: false, download: false };
  if (isArchivedVersion(doc, v)) return { preview: has(actions, 'view_archived'), download: has(actions, 'download_archived') };
  return { preview: has(actions, 'preview'), download: has(actions, 'download') };
}

export function isPreviewable(kind: string | undefined | null) {
  return kind === 'PDF' || kind === 'IMAGE';
}

/**
 * Issue réelle d'un dépôt d'après le statut renvoyé par l'API (CSO-04) : une publication directe
 * (`cso.self_approve`) peut retomber dans le circuit normal si le dossier refuse l'approbation.
 */
export function versionOutcome(status: string | null | undefined): string {
  if (status === 'PUBLISHED') return 'publiée directement';
  if (status === 'PENDING_APPROVAL') return 'soumise pour approbation';
  return 'enregistrée en brouillon';
}

/**
 * Message d'erreur lisible pour les gestes CSO, y compris les conflits de concurrence
 * (409 STALE_VERSION / ALREADY_PROCESSED) et les champs obligatoires manquants.
 */
export function csoErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'STALE_VERSION') return 'Cet élément a été modifié entre-temps par un autre utilisateur. Les données ont été rechargées : vérifiez puis recommencez.';
    if (e.code === 'ALREADY_PROCESSED') return 'Déjà traité : un autre utilisateur a décidé entre-temps. Les données ont été rechargées.';
    if (e.code === 'SELF_APPROVAL_FORBIDDEN') return 'Vous ne pouvez pas décider sur une version que vous avez déposée (séparation des tâches).';
    if (e.code === 'ACL_DENIED' || e.code === 'SCOPE_DENIED') return `${e.message}.`;
    const d = e.details as { fields?: string[] } | undefined;
    if (d && !Array.isArray(d) && Array.isArray(d.fields) && d.fields.length) {
      return `${e.message} : ${d.fields.map((f) => STANDARD_FIELD_LABELS[f] ?? f).join(', ')}`;
    }
    const fe = e.fieldErrors;
    const keys = Object.keys(fe);
    if (keys.length) return `${e.message} — ${keys.map((k) => `${k} : ${fe[k]}`).join(' ; ')}`;
    return e.message;
  }
  return errorMessage(e);
}

export function isConflict(e: unknown) {
  return e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'ALREADY_PROCESSED' || e.status === 409);
}

/** Erreur déjà traduite en message lisible (affichée telle quelle par ConfirmDialog / formulaires). */
export class CsoActionError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
  }
}

/**
 * Exécute un geste CSO : toast de succès, rechargement du module. En cas d'échec, l'erreur est
 * relancée avec un message lisible (409 STALE_VERSION / ALREADY_PROCESSED expliqués) et les
 * données sont rechargées après un conflit pour que l'utilisateur voie l'état réel.
 * L'appelant affiche l'erreur (ConfirmDialog la toaste ; les formulaires l'affichent en ligne).
 */
export function useCsoRun() {
  const invalidate = useCsoInvalidate();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string | ((res: T) => string)): Promise<T> => {
      try {
        const res = await fn();
        if (success) toast.success(typeof success === 'function' ? success(res) : success);
        await invalidate();
        return res;
      } catch (e) {
        if (isConflict(e)) await invalidate();
        throw new CsoActionError(csoErrorMessage(e), e);
      }
    },
    [invalidate],
  );
}

/** Variante « bouton direct » : l'erreur est toastée ; retourne true en cas de succès. */
export function useCsoRunToast() {
  const run = useCsoRun();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string | ((res: T) => string)): Promise<boolean> => {
      try {
        await run(fn, success);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : csoErrorMessage(e));
        return false;
      }
    },
    [run],
  );
}

export function libraryLabel(l: CsoLibrary | null | undefined): string {
  if (!l) return '—';
  if (l.kind === 'CENTRAL') return 'Bibliothèque centrale';
  return l.vessel ? `${l.vessel.name} (${l.vessel.code})` : l.name;
}

/** Titre sans extension pour préremplir le formulaire de création à partir d'un fichier déposé. */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/[_]+/g, ' ').trim().slice(0, 300);
}

/** Ouvre un lien signé (téléchargement) obtenu à la demande. */
export function openSignedLink(url: string, fileName?: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
