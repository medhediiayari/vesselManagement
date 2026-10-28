'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';

/** Lien à usage unique vers un e-mail vérifié (ADM-009). Réponse identique dans tous les cas. */
export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h1 className="text-xl font-semibold">Mot de passe oublié</h1>
      {done ? (
        <p className="mt-3 rounded-md border border-ok-line bg-ok-bg px-3 py-2 text-sm text-ok" role="status">
          Si un compte avec une adresse e-mail vérifiée correspond, un lien valable une heure vient d’être envoyé. Un compte
          verrouillé ne peut être débloqué que par un administrateur.
        </p>
      ) : (
        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/auth/forgot', { identifier });
              setDone(true);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField label="Identifiant ou e-mail" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
          {error && <p className="field-error">{error}</p>}
          <Button type="submit" className="w-full" loading={busy} disabled={!identifier}>
            Envoyer le lien de réinitialisation
          </Button>
        </form>
      )}
      <p className="mt-4 text-sm">
        <Link href="/login" className="text-action hover:underline">
          Retour à la connexion
        </Link>
      </p>
    </>
  );
}
