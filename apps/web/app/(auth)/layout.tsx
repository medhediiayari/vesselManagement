import type { ReactNode } from 'react';
import { AmcMark } from '@/components/shell/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-navy-950 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        {/* Graticule de carte marine : seul motif décoratif de l'application, volontairement très discret */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.07]" aria-hidden>
          <defs>
            <pattern id="amc-graticule" width="72" height="72" patternUnits="userSpaceOnUse">
              <path d="M72 0H0V72" fill="none" stroke="#FFFFFF" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#amc-graticule)" />
        </svg>
        <div className="relative flex items-center gap-3">
          <AmcMark className="h-11 w-11" />
          <div className="leading-tight">
            <p className="text-md font-semibold">Africa Marine Company</p>
            <p className="text-xs text-white/60">Exploitation de flotte</p>
          </div>
        </div>
        <div className="relative">
          <p className="max-w-md text-2xl font-semibold leading-snug">Flotte, équipages, certificats et opérations, à bord comme à terre.</p>
          <p className="mt-3 max-w-md text-sm text-white/70">
            Accès réservé au personnel AMC. Chaque action est contrôlée selon vos droits et votre périmètre navire, et journalisée.
          </p>
        </div>
        <p className="relative flex items-center gap-3 text-xs text-white/50">
          <span className="h-px w-8 bg-teal" aria-hidden />
          Plateforme maritime AMC — version 1.0
        </p>
      </aside>
      <main className="flex items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <AmcMark />
            <p className="text-sm font-semibold text-navy">Africa Marine Company</p>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
