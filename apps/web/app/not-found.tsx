import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-2xl font-semibold text-navy">Page introuvable</p>
      <p className="max-w-md text-sm text-ink-muted">L’adresse demandée n’existe pas ou a été déplacée.</p>
      <Link href="/" className="text-sm font-medium text-action hover:underline">
        Revenir au tableau de bord
      </Link>
    </div>
  );
}
