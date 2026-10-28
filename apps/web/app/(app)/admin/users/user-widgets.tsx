'use client';

import { Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { UserListItem } from '../types';

export function UserStatusBadges({ u }: { u: Pick<UserListItem, 'status' | 'locked' | 'mustChangePassword'> }) {
  return (
    <span className="flex flex-wrap gap-1">
      {u.status === 'ACTIVE' ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Désactivé</Badge>}
      {u.locked && <Badge tone="danger">Verrouillé</Badge>}
      {u.mustChangePassword && <Badge tone="warn">Mot de passe temporaire</Badge>}
    </span>
  );
}

/** Affichage unique du mot de passe temporaire (jamais réaffiché ni envoyé par e-mail). */
export function TemporaryPasswordNotice({ password }: { password: string }) {
  return (
    <div className="rounded-md border border-warn-line bg-warn-bg p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-warn">
        <KeyRound className="h-4 w-4" aria-hidden /> Mot de passe temporaire
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 rounded bg-white px-2 py-1.5 font-mono text-md tracking-wide">{password}</code>
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(password);
            toast.success('Copié');
          }}
        >
          <Copy className="h-4 w-4" aria-hidden /> Copier
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Transmettez-le par un canal sûr. Il ne sera plus affiché ; l’utilisateur devra le remplacer à sa première connexion.
      </p>
    </div>
  );
}
