import { UserRound } from 'lucide-react';
import { cn, fmtDate, fmtDateTime } from '@/lib/format';

/** Auteur renvoyé par l'API (`createdBy`) : nom et rôles, pour savoir qui a créé un élément avant d'y toucher. */
export interface CreatorLabel {
  id: string;
  name: string;
  roles: string[];
}

const rolesText = (by: CreatorLabel) => (by.roles.length ? ` (${by.roles.join(', ')})` : '');

/** Phrase complète, réutilisable dans les boîtes de confirmation : « créé par X (Commercial) le 30/10/2026 ». */
export function createdBySentence(by: CreatorLabel | null | undefined, at: string | null | undefined, verb = 'créé'): string {
  const who = by ? `${by.name}${rolesText(by)}` : 'un utilisateur inconnu';
  return `${verb} par ${who}${at ? ` le ${fmtDate(at)}` : ''}`;
}

/**
 * « Créé par X (rôle) · date ». `compact` : version deux lignes pour une cellule de tableau.
 */
export function CreatedBy({
  by,
  at,
  verb = 'Créé',
  compact = false,
  className,
}: {
  by: CreatorLabel | null | undefined;
  at?: string | null;
  verb?: string;
  compact?: boolean;
  className?: string;
}) {
  const name = by?.name ?? 'Utilisateur inconnu';
  if (compact) {
    return (
      <span className={cn('block leading-tight', className)} title={`${verb} par ${name}${by ? rolesText(by) : ''}${at ? ` le ${fmtDateTime(at)}` : ''}`}>
        <span className="block text-sm">{name}</span>
        <span className="block text-xs text-ink-muted">
          {by?.roles.length ? by.roles.join(', ') : '—'}
          {at ? ` · ${fmtDate(at)}` : ''}
        </span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm text-ink-muted', className)}>
      <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {verb} par <span className="font-medium text-ink">{name}</span>
        {by?.roles.length ? ` (${by.roles.join(', ')})` : ''}
        {at ? ` · ${fmtDateTime(at)}` : ''}
      </span>
    </span>
  );
}
