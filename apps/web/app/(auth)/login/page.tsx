'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';

/** Cible interne uniquement : `/\site.tld` ou `//site.tld` sont résolus puis rejetés (ADM-02). */
function safeNext(next: string | null): string {
  if (!next) return '/';
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ mustChangePassword: boolean }>('/auth/login', { identifier, password });
      qc.clear();
      const next = safeNext(params.get('next'));
      router.replace(res.mustChangePassword ? '/change-password' : next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connexion impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Connexion</h1>
      <p className="mt-1 text-sm text-ink-muted">Utilisez votre identifiant ou votre adresse e-mail professionnelle.</p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <TextField
          label="Identifiant ou e-mail"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          required
          autoFocus
        />
        <TextField
          label="Mot de passe"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!identifier || !password}>
          Se connecter
        </Button>
      </form>
      <p className="mt-4 text-sm">
        <Link href="/forgot-password" className="text-action hover:underline">
          Mot de passe oublié ?
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
