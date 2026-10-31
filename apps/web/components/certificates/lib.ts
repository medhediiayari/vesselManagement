'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { CertificateData, ExpiryKind, RequestKind, WorkflowResult } from './types';

/** Clés de cache partagées par les écrans Certificats. */
export const certKeys = {
  list: ['certificates'] as const,
  /** Préfixe de toutes les fiches (renommage d'un dossier / d'une catégorie affichés dessus) */
  details: ['certificate'] as const,
  detail: (id: string) => ['certificate', id] as const,
  requests: ['certificate-requests'] as const,
  types: ['certificate-types'] as const,
  policies: ['reminder-policies'] as const,
  folders: ['certificate-folders'] as const,
  categories: ['certificate-categories'] as const,
};

/** Rafraîchit fiche + listes + compteurs (dashboard) après une commande de workflow. */
export function useRefreshCertificates() {
  const qc = useQueryClient();
  return useCallback(
    async (certificateId?: string | null) => {
      await Promise.all([
        certificateId ? qc.invalidateQueries({ queryKey: certKeys.detail(certificateId) }) : Promise.resolve(),
        qc.invalidateQueries({ queryKey: certKeys.list }),
        qc.invalidateQueries({ queryKey: certKeys.requests }),
        qc.invalidateQueries({ queryKey: certKeys.folders }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
        qc.invalidateQueries({ queryKey: ['audit'] }),
      ]);
    },
    [qc],
  );
}

/**
 * Publication directe (miroir de canSelfApprove côté API) : self_approve pour toute demande,
 * renewal.self_approve pour les seuls renouvellements. Elle vaut soumission.
 */
export function selfApproves(can: (permission: string) => boolean, kind: RequestKind): boolean {
  return can('certificates.self_approve') || (kind === 'RENEWAL' && can('certificates.renewal.self_approve'));
}

/** Date civile ISO (API) -> valeur d'<input type="date"> (AAAA-MM-JJ). */
export function toDateInput(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : '';
}

/** Affichage d'une échéance selon son type (UNKNOWN ≠ UNLIMITED). */
export function fmtExpiry(kind: ExpiryKind | null | undefined, on: string | null | undefined): string {
  if (kind === 'UNLIMITED') return 'Illimité';
  if (kind === 'UNKNOWN') return 'Date inconnue';
  return fmtDate(on);
}

/** Valeur lisible d'un champ de données (dates, pays, échéance). */
export function fmtDataValue(key: keyof CertificateData, data: Partial<CertificateData>): string {
  const v = data[key];
  if (key === 'expiryKind') return v === 'DATED' ? 'Datée' : v === 'UNLIMITED' ? 'Illimitée' : v === 'UNKNOWN' ? 'Inconnue' : '—';
  if (key === 'issuedOn' || key === 'validFrom' || key === 'expiryOn') return fmtDate(v as string | null);
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

/** Libellé « dans N j / depuis N j » d'un nombre de jours avant échéance. */
export function fmtDays(days: number | null | undefined): string | null {
  if (days === null || days === undefined) return null;
  if (days === 0) return "Expire aujourd'hui";
  return days < 0 ? `Expiré depuis ${Math.abs(days)} j` : `Expire dans ${days} j`;
}

/** Toasts de succès + avertissements métier renvoyés par le workflow (validateurs, pièce manquante). */
export function announceWorkflow(res: WorkflowResult | undefined, success: string) {
  const notified = res?.notifiedValidators;
  toast.success(success, {
    description: res?.autoApproved
      ? 'Publié directement : votre profil ne nécessite pas d’approbation.'
      : notified
        ? `${notified} validateur(s) notifié(s) sur la plateforme et par e-mail.`
        : undefined,
  });
  for (const w of res?.warnings ?? []) toast.warning(w, { duration: 10_000 });
}

/**
 * Conflits de concurrence (ADM-058, CERT-04) : message clair + rafraîchissement.
 * Renvoie true si l'erreur a été traitée comme un conflit.
 */
export function conflictMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'STALE_VERSION') {
    const d = e.details as { currentVersion?: number } | undefined;
    return `La demande a été modifiée depuis votre lecture${d?.currentVersion ? ` (version actuelle : v${d.currentVersion})` : ''}. La nouvelle version est affichée : vérifiez-la avant de poursuivre.`;
  }
  if (e.code === 'ALREADY_PROCESSED') {
    return `${e.message}. Un autre utilisateur a déjà traité cette demande : l'état a été actualisé.`;
  }
  if (e.code === 'INVALID_STATE') return `${e.message}. L'état a été actualisé.`;
  return null;
}

export function showError(e: unknown) {
  toast.error(errorMessage(e));
}

/** Point de rupture JS (panneau latéral seulement si la largeur le permet). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Valeur différée (recherche instantanée sans requête par frappe). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
