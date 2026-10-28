'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Mail, MailX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn, fmtRelative } from '@/lib/format';
import { useAction, useCursorList } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';

interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  module: string;
  link: string | null;
  isMandatory: boolean;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  deliveries: { status: string; sentAt: string | null; lastError: string | null }[];
}

/** Centre de notifications : lu / non lu, lien protégé, statut d'envoi e-mail réel. */
export default function NotificationsPage() {
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useCursorList<NotificationDto>(['notifications-list'], '/notifications', { unread: unreadOnly || undefined });
  const invalidate = [['notifications-list'], ['notifications', 'unread-count']];
  const markAll = useAction(() => api.post('/notifications/read-all'), { success: 'Tout est marqué comme lu', invalidate });
  const mark = async (n: NotificationDto, read: boolean) => {
    await api.patch(`/notifications/${n.id}`, { read });
    invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }));
  };
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Alertes d'échéance, demandes de validation et partages. Les liens ouvrent l'élément si vos droits le permettent toujours."
        actions={
          <>
            <Button variant="secondary" onClick={() => setUnreadOnly((v) => !v)}>{unreadOnly ? 'Tout afficher' : 'Non lues uniquement'}</Button>
            <Button onClick={() => markAll.mutate(undefined)} loading={markAll.isPending}>Tout marquer comme lu</Button>
          </>
        }
      />
      {list.loading && <LoadingBlock rows={6} />}
      {!!list.error && <ErrorState error={list.error} onRetry={() => list.refetch()} />}
      {list.rows && list.rows.length === 0 && <EmptyState title="Aucune notification" description="Vous êtes à jour." />}
      <ul className="space-y-2">
        {list.rows?.map((n) => {
          const email = n.deliveries[0];
          return (
            <li key={n.id} className={cn('rounded-lg border bg-white px-4 py-3', n.readAt ? 'border-line' : 'border-action/40 shadow-panel')}>
              <div className="flex flex-wrap items-start gap-2">
                {!n.readAt && <span className="mt-1.5 h-2 w-2 rounded-full bg-action" aria-label="Non lue" />}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-navy">
                    {n.link ? (
                      <Link href={n.link} className="hover:underline" onClick={() => !n.readAt && mark(n, true)}>{n.title}</Link>
                    ) : (
                      n.title
                    )}
                  </p>
                  {n.body && <p className="mt-0.5 whitespace-pre-line text-sm text-ink-muted">{n.body}</p>}
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    {fmtRelative(n.createdAt)}
                    {(n.priority === 'HIGH' || n.priority === 'CRITICAL') && <Badge tone="danger">{n.priority === 'CRITICAL' ? 'Critique' : 'Prioritaire'}</Badge>}
                    {n.isMandatory && !n.resolvedAt && <Badge tone="warn">Alerte active</Badge>}
                    {email && (
                      <span className="inline-flex items-center gap-1">
                        {email.status === 'SENT' ? <Mail className="h-3 w-3" aria-hidden /> : <MailX className="h-3 w-3" aria-hidden />}
                        E-mail : {email.status === 'SENT' ? 'envoyé' : email.status === 'FAILED' ? 'échec' : email.status === 'SUPPRESSED' ? 'non envoyé (désactivé)' : 'en file'}
                      </span>
                    )}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => mark(n, !n.readAt)}>{n.readAt ? 'Marquer non lue' : 'Marquer lue'}</Button>
              </div>
            </li>
          );
        })}
      </ul>
      {list.hasMore && (
        <div className="mt-3 text-center">
          <Button variant="secondary" onClick={list.loadMore} loading={list.loadingMore}>Charger la suite</Button>
        </div>
      )}
    </>
  );
}
