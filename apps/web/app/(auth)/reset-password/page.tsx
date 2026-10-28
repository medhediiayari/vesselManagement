'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!token) return <p className="text-sm text-danger">Lien de réinitialisation incomplet.</p>;
  return done ? (
    <p className="rounded-md border border-ok-line bg-ok-bg px-3 py-2 text-sm text-ok">
      Mot de passe mis à jour. <Link href="/login" className="font-medium underline">Se connecter</Link>
    </p>
  ) : (
    <form
      className="mt-6 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pwd !== confirm) return;
        setBusy(true);
        setError(null);
        try {
          await api.post('/auth/reset', { token, newPassword: pwd });
          setDone(true);
        } catch (err) {
          const rules = err instanceof ApiError ? (err.details as { rules?: string[] } | undefined)?.rules : undefined;
          setError(`${err instanceof ApiError ? err.message : 'Échec'}${rules ? ` : ${rules.join(', ')}` : ''}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label="Nouveau mot de passe" type="password" autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required />
      <TextField
        label="Confirmer"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={confirm && pwd !== confirm ? 'Les deux saisies diffèrent' : undefined}
        required
      />
      {error && <p className="field-error">{error}</p>}
      <Button type="submit" className="w-full" loading={busy} disabled={!pwd || pwd !== confirm}>
        Réinitialiser
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="text-xl font-semibold">Nouveau mot de passe</h1>
      <Suspense>
        <ResetForm />
      </Suspense>
    </>
  );
}
