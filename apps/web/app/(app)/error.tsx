'use client';

import { AlertOctagon, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Filet de sécurité de la zone authentifiée (audit FLT-01) : une erreur de rendu d'une page
 * n'emporte plus toute l'application. La sélection de navire (conservée dans le navigateur)
 * peut être réinitialisée si elle est en cause.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  function resetVesselSelection() {
    try {
      localStorage.removeItem('amc.selectedVessels');
    } catch {
      /* préférence locale facultative */
    }
    window.location.assign('/');
  }

  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center" role="alert">
      <div className="mb-3 rounded-full bg-navy-50 p-3">
        <AlertOctagon className="h-5 w-5 text-danger" aria-hidden />
      </div>
      <p className="font-semibold text-navy">Cette page n’a pas pu s’afficher</p>
      <p className="mt-1 max-w-md text-sm text-ink-muted">
        Une erreur inattendue s’est produite pendant l’affichage. Vous pouvez réessayer ; si le problème persiste,
        revenez à la vue de toute la flotte ou contactez un administrateur.
      </p>
      {error.digest && <p className="mt-1 text-xs text-ink-soft">Référence : {error.digest}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={reset}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Réessayer
        </Button>
        <Button variant="secondary" size="sm" onClick={resetVesselSelection}>
          Revenir à toute la flotte
        </Button>
        <Link href="/" className="text-sm font-medium text-action hover:underline">
          Accueil
        </Link>
      </div>
    </div>
  );
}
