import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'AMC — Plateforme maritime', template: '%s · AMC' },
  description: 'Africa Marine Company — flotte, équipages, certificats, sûreté, achats, voyages et Noon Reports.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#102B44',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
