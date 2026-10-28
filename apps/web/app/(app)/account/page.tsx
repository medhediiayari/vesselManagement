'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { LoadingBlock } from '@/components/ui/states';

interface OwnSession {
  id: string;
  deviceLabel: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

/** Mon compte : rôles, périmètre, sessions multi-appareils révocables (ADM-017/018). */
export default function AccountPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['own-sessions'], queryFn: () => api.get<OwnSession[]>('/auth/sessions') });
  return (
    <>
      <PageHeader
        title="Mon compte"
        description="Vos coordonnées officielles sont tenues dans votre fiche Member ; ici figurent vos informations de connexion."
        actions={
          <Link href="/change-password">
            <Button variant="secondary">Changer mon mot de passe</Button>
          </Link>
        }
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Profil">
          <DefinitionGrid
            items={[
              ['Nom', me.displayName],
              ['Identifiant', me.username],
              ['E-mail', me.email],
              ['Fonction', me.jobTitle],
              ['Rôles', me.roles.map((r) => r.name).join(', ') || '—'],
              ['Départements', me.departments.map((d) => `${d.name}${d.isPrimary ? ' (principal)' : ''}`).join(', ') || '—'],
              ['Périmètre', me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : me.accessibleVessels.map((v) => v.name).join(', ') || 'Aucun navire'],
              ['Fiche Member', me.memberId ? <Link key="m" className="text-action hover:underline" href={`/members/${me.memberId}`}>Ouvrir ma fiche</Link> : 'Non liée'],
            ]}
          />
        </Panel>
        <Panel title="Sessions ouvertes" bodyClassName="p-0">
          {sessions.isLoading && <LoadingBlock rows={3} />}
          <ul className="divide-y divide-line">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {s.deviceLabel ?? 'Appareil'} {s.current && <Badge tone="teal" icon={false}>Cette session</Badge>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {s.ip ?? '—'} — ouverte le {fmtDateTime(s.createdAt)} — active {fmtDateTime(s.lastSeenAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await api.delete(`/auth/sessions/${s.id}`);
                        toast.success('Session fermée');
                        qc.invalidateQueries({ queryKey: ['own-sessions'] });
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Fermer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
