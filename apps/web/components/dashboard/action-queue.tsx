'use client';

import { ArrowRight, CheckCircle2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/format';
import { JOB_LABELS, type AdminOverview } from './admin-overview';
import type { DashboardData } from './types';

export type Priority = 'critical' | 'action' | 'follow';
export const PRIORITY: Record<Priority, { label: string; rule: string; tag: string; rank: number }> = {
  critical: { label: 'Critique', rule: 'bg-danger', tag: 'border-danger-line bg-danger-bg text-danger', rank: 0 },
  action: { label: 'À traiter', rule: 'bg-warn', tag: 'border-warn-line bg-warn-bg text-warn', rank: 1 },
  follow: { label: 'Suivi', rule: 'bg-action', tag: 'border-action-100 bg-action-50 text-action-700', rank: 2 },
};

/** Droits de pure consultation (lecture, aperçu, téléchargement, export). */
const READ_ONLY_PERMISSION = /(^|\.)(view|view_all|preview|export|download\w*)(\.|$)/;

/** Profil sans aucun droit d'écriture (ex. Direction) : la file devient des « points de vigilance » (UI-06). */
export function isReadOnlyProfile(permissions: string[]): boolean {
  return permissions.every((p) => READ_ONLY_PERMISSION.test(p));
}

export interface ActionItem {
  key: string;
  priority: Priority;
  count: number;
  label: string;
  detail: string;
  href: string;
}

/** File d'actions : uniquement des chiffres calculés par l'API dans le périmètre de l'utilisateur. */
export function buildActions(d: DashboardData, vq: string): ActionItem[] {
  const items: ActionItem[] = [];
  const push = (it: ActionItem | false | undefined) => it && items.push(it);
  const c = d.certificates;
  const p = d.purchasing;
  const a = d.approvals;
  if (c) {
    push({ key: 'cert-expired', priority: 'critical', count: c.expired, label: 'Certificats expirés', detail: 'Échéance dépassée : renouvellement ou archivage à décider', href: `/certificates?validity=EXPIRED${vq}` });
    push({ key: 'cert-30', priority: 'action', count: c.expiringWithin30, label: 'Certificats expirant sous 30 jours', detail: 'Lancer ou suivre le renouvellement', href: `/certificates?expiringWithinDays=30${vq}` });
    push({ key: 'cert-doc', priority: 'action', count: c.documentMissing, label: 'Justificatifs manquants', detail: 'Révision courante sans document officiel déposé', href: `/certificates?documentMissing=true${vq}` });
    push({ key: 'cert-unknown', priority: 'follow', count: c.expiryUnknown, label: 'Échéances inconnues', detail: 'Date à compléter — aucune alerte d’expiration possible', href: `/certificates?validity=EXPIRY_UNKNOWN${vq}` });
  }
  if (d.voyages) {
    push({ key: 'noon', priority: 'critical', count: d.voyages.noonReportsMissing, label: 'Noon Reports non reçus', detail: 'Voyage actif sans rapport soumis depuis plus de 30 h', href: '/noon-reports' });
  }
  if (p) {
    push({ key: 'pr-overdue', priority: 'critical', count: p.overduePurchaseRequests, label: 'PR dont la date de besoin est dépassée', detail: 'Besoin bord non couvert à date', href: '/purchasing/requests?overdue=true' });
    push({ key: 'po-late', priority: 'action', count: p.lateOrders, label: 'Bons de commande en retard', detail: 'Livraison attendue dépassée', href: '/purchasing/orders?late=true' });
    push({ key: 'variances', priority: 'action', count: p.openVariances, label: 'Écarts de réception ouverts', detail: 'Manquants, rejets ou surplus à régler', href: '/purchasing/deliveries' });
  }
  push(a.certificates !== undefined && { key: 'ap-cert', priority: 'action', count: a.certificates, label: 'Demandes de certificats à valider', detail: 'Nouvelle révision en attente — l’ancienne reste courante', href: `/certificates?pendingApproval=true${vq}` });
  push(a.csoDocuments !== undefined && { key: 'ap-cso', priority: 'action', count: a.csoDocuments, label: 'Documents CSO à approuver', detail: 'Versions proposées dans vos dossiers', href: '/cso?pending=true' });
  push(a.purchaseRequests !== undefined && { key: 'ap-pr', priority: 'action', count: a.purchaseRequests, label: 'Purchase Requests à revoir', detail: 'Soumises par le bord ou les services', href: '/purchasing/requests?status=SUBMITTED' });
  push(a.purchaseOrders !== undefined && { key: 'ap-po', priority: 'action', count: a.purchaseOrders, label: 'Bons de commande à approuver', detail: 'Selon les seuils d’approbation configurés', href: '/purchasing/orders?status=APPROVAL_PENDING' });
  push(a.charterParties !== undefined && { key: 'ap-cp', priority: 'action', count: a.charterParties, label: 'Versions de Charter Party à valider', detail: 'Révision contractuelle en attente', href: '/charter-parties?pending=true' });
  push({ key: 'my-returned', priority: 'action', count: d.myTasks.returnedCertificateRequests, label: 'Vos demandes retournées pour correction', detail: 'Certificats à corriger puis resoumettre', href: '/certificates?mine=returned' });
  push({ key: 'my-renewals', priority: 'follow', count: d.myTasks.certificateRenewals, label: 'Renouvellements qui vous sont assignés', detail: 'Suivi interne du renouvellement', href: `/certificates?mine=renewal${vq}` });
  push({ key: 'my-voyage', priority: 'follow', count: d.myTasks.voyageTasks, label: 'Tâches de voyage ouvertes', detail: 'Checklists et instructions à accuser', href: '/voyages' });
  return items;
}

/** Signaux d'administration (mêmes sources que la console) : seulement si la permission est détenue. */
export function buildAdminActions(admin: AdminOverview): ActionItem[] {
  const items: ActionItem[] = [];
  if (admin.permissions.canUsers && admin.users.locked !== undefined) {
    items.push({ key: 'adm-locked', priority: 'action', count: admin.users.locked, label: 'Comptes verrouillés', detail: 'Déverrouillage depuis la fiche, avec mot de passe temporaire', href: '/admin/users?status=LOCKED' });
  }
  const s = admin.system;
  if (admin.permissions.canSystem && s.data) {
    items.push({ key: 'adm-deps', priority: 'critical', count: s.depsDown, label: 'Services indisponibles', detail: 'Base de données ou stockage des fichiers', href: '/admin/system' });
    items.push({
      key: 'adm-jobs',
      priority: 'critical',
      count: s.failedJobs.length,
      label: 'Tâches planifiées en échec',
      detail: s.failedJobs.length ? s.failedJobs.map((j) => JOB_LABELS[j.name] ?? j.name).join(', ') : 'Rappels, suivis et diffusions automatiques',
      href: '/admin/system',
    });
    items.push({ key: 'adm-infected', priority: 'critical', count: s.infectedFiles, label: 'Fichiers en quarantaine', detail: 'Menace détectée par l’antivirus au dépôt', href: '/admin/system' });
    items.push({ key: 'adm-mail', priority: 'action', count: s.failedEmails, label: 'E-mails non délivrés', detail: 'Notifications à vérifier côté messagerie', href: '/admin/system' });
  }
  return items;
}

export function sortActions(items: ActionItem[]) {
  return items.sort((x, y) => PRIORITY[x.priority].rank - PRIORITY[y.priority].rank || y.count - x.count);
}

export function ActionQueue({ items, readOnly = false }: { items: ActionItem[]; readOnly?: boolean }) {
  const open = items.filter((i) => i.count > 0);
  const clear = items.filter((i) => i.count === 0);
  return (
    <div>
      {open.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-ok">
          <CheckCircle2 className="h-5 w-5" aria-hidden /> {readOnly ? 'Aucun point de vigilance dans votre périmètre.' : 'Aucune action en attente dans votre périmètre.'}
        </p>
      ) : (
        // Deux colonnes sur grand écran : la file reste lisible sans allonger la page
        <ol className="grid border-t border-line xl:grid-cols-2">
          {open.map((it) => {
            const pr = PRIORITY[it.priority];
            return (
              <li key={it.key} className="border-b border-line xl:odd:border-r">
                <Link href={it.href} className="group relative flex items-center gap-4 py-3 pl-5 pr-4 hover:bg-action-50/70">
                  <span className={cn('absolute inset-y-2 left-0 w-[3px] rounded-r', pr.rule)} aria-hidden />
                  <span className="tabular w-10 shrink-0 text-right text-xl font-semibold text-navy">{it.count}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-navy">{it.label}</span>
                      <span className={cn('rounded border px-1.5 text-2xs font-semibold leading-4', pr.tag)}>{readOnly && it.priority === 'action' ? 'À surveiller' : pr.label}</span>
                    </span>
                    <span className="block text-xs text-ink-muted sm:truncate">{it.detail}</span>
                  </span>
                  <span className="hidden items-center gap-1 text-sm font-medium text-action group-hover:underline sm:inline-flex">
                    Ouvrir <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      {clear.length > 0 && (
        <details className={cn('group bg-surface-sunken px-4 py-2.5 text-xs text-ink-muted', open.length === 0 && 'border-t border-line')}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
            <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
            <span className="font-semibold text-ok">{clear.length} rubrique{clear.length > 1 ? 's' : ''} à jour</span>
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <p className="mt-1.5 pl-5">{clear.map((i) => i.label).join(' · ')}.</p>
        </details>
      )}
    </div>
  );
}
