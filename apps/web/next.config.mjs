import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Image Docker : sortie autonome (NEXT_OUTPUT=standalone), dépendances du monorepo tracées
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone', experimental: { outputFileTracingRoot: repoRoot } }
    : {}),
  // Proxy same-origin : les cookies de session (HttpOnly) et CSRF restent sur l'origine du front
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
