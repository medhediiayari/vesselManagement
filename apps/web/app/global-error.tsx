'use client';

import { useEffect } from 'react';
import './globals.css';

/**
 * Dernier filet (audit FLT-N1) : une erreur dans la mise en page elle-même (en-tête, horloge, sélecteur
 * de navire) n'est pas rattrapée par `(app)/error.tsx`. Remplace la page racine ; sans dépendance au shell.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
    <html lang="fr">
      <body>
        <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center" role="alert">
          <p className="font-semibold text-navy">L’application n’a pas pu s’afficher</p>
          <p className="mt-1 max-w-md text-sm text-ink-muted">
            Une erreur inattendue s’est produite. Réessayez ; si le problème persiste, revenez à la vue de toute la
            flotte ou contactez un administrateur.
          </p>
          {error.digest && <p className="mt-1 text-xs text-ink-soft">Référence : {error.digest}</p>}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={reset} className="h-9 rounded-md bg-action px-4 text-sm font-medium text-white">
              Réessayer
            </button>
            <button
              type="button"
              onClick={resetVesselSelection}
              className="h-9 rounded-md border border-line-strong bg-white px-4 text-sm font-medium text-ink"
            >
              Revenir à toute la flotte
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
