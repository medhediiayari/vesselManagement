'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';

/** Remplacement obligatoire du mot de passe temporaire à la première connexion (ADM-007). */
export default function ChangePasswordPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    setRules([]);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/login');
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Échec du changement de mot de passe');
      const d = err instanceof ApiError ? (err.details as { rules?: string[] } | undefined) : undefined;
      if (d?.rules) setRules(d.rules);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Choisissez votre mot de passe</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Votre mot de passe actuel est temporaire ou doit être renouvelé. Les autres sessions ouvertes seront fermées.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <TextField label="Mot de passe actuel (temporaire)" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
        <TextField
          label="Nouveau mot de passe"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint="12 caractères minimum, 3 types parmi minuscules, majuscules, chiffres et symboles ; sans votre identifiant."
          required
        />
        <TextField
          label="Confirmer le nouveau mot de passe"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? 'Les deux saisies diffèrent' : undefined}
          required
        />
        {error && (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
            {rules.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!current || !next || mismatch}>
          Enregistrer le mot de passe
        </Button>
      </form>
    </>
  );
}
