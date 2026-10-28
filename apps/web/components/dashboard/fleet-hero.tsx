import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Skeleton } from '@/components/ui/states';

export interface HeroKpi {
  key: string;
  icon: LucideIcon;
  value: ReactNode;
  label: string;
  sub?: ReactNode;
  /** Renfort visuel du sous-libellé ; le texte porte toujours le sens */
  tone?: 'warn' | 'danger' | 'ok';
  href?: string;
}

/** Mêmes dégradés que la scène (horizon à 214/320 = 66,9 %) pour un raccord invisible à gauche du SVG. */
export const SKY_SEA = 'linear-gradient(180deg,#0B1F33 0%,#1C3A56 36.8%,#5E5363 66.9%,#1A3B57 66.9%,#081828 100%)';

// Teintes éclaircies pour le fond marine (contraste AA sur #0B1F33)
const TONE: Record<NonNullable<HeroKpi['tone']>, string> = {
  warn: 'text-[#F8C77E]',
  danger: 'text-[#FFA197]',
  ok: 'text-[#86DDB8]',
};

/**
 * Scène de passerelle au crépuscule : vraquier AMC sur l'horizon, en SVG léger (aucune image distante).
 * Purement décorative (aria-hidden). Hauteur = hauteur du bandeau, ancrée à droite : le navire garde la même
 * échelle quelle que soit la largeur ; le fond CSS du bandeau prolonge le ciel et la mer à gauche (SKY_SEA).
 */
export function SeaScene({ className }: { className?: string }) {
  const hatches = Array.from({ length: 7 }, (_, i) => 785 + i * 32);
  const cranes = [813, 877, 941, 1005];
  const windowsX = Array.from({ length: 7 }, (_, i) => 1046 + i * 8.5);
  return (
    <svg className={className} viewBox="0 0 1440 320" preserveAspectRatio="xMaxYMid meet" aria-hidden focusable="false">
      <defs>
        <linearGradient id="amc-hero-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0B1F33" />
          <stop offset="0.55" stopColor="#1C3A56" />
          <stop offset="1" stopColor="#5E5363" />
        </linearGradient>
        <radialGradient id="amc-hero-glow" cx="1235" cy="214" r="460" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F9C37F" stopOpacity="0.95" />
          <stop offset="0.25" stopColor="#E48A55" stopOpacity="0.6" />
          <stop offset="0.6" stopColor="#8A5A62" stopOpacity="0.25" />
          <stop offset="1" stopColor="#1C3A56" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="amc-hero-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1A3B57" />
          <stop offset="1" stopColor="#081828" />
        </linearGradient>
      </defs>

      <rect width="1440" height="214" fill="url(#amc-hero-sky)" />
      <rect width="1440" height="214" fill="url(#amc-hero-glow)" />
      <circle cx="1235" cy="208" r="20" fill="#FCDDA6" />

      <rect y="214" width="1440" height="106" fill="url(#amc-hero-sea)" />
      {/* Reflet du soleil : traits horizontaux qui s'élargissent vers l'avant-plan */}
      {[
        [218, 26, 0.75],
        [224, 40, 0.55],
        [232, 58, 0.42],
        [242, 80, 0.3],
        [254, 104, 0.22],
        [268, 130, 0.14],
        [284, 160, 0.09],
      ].map(([y, w, o]) => (
        <rect key={y} x={1235 - w / 2} y={y} width={w} height={2} rx={1} fill="#F9C37F" opacity={o} />
      ))}
      {[236, 252, 272, 296].map((y, i) => (
        <rect key={y} x={i % 2 ? 120 : 40} y={y} width={i % 2 ? 520 : 760} height={1} fill="#FFFFFF" opacity={0.05} />
      ))}

      {/* Vraquier, cap à gauche : coque, panneaux de cale, grues, château arrière */}
      <ellipse cx="925" cy="229" rx="236" ry="5" fill="#04101C" opacity="0.55" />
      <g fill="#071523">
        <path d="M700 198 L762 198 L766 206 L1128 206 L1132 200 L1152 200 L1146 226 L722 226 Z" />
        {hatches.map((x) => (
          <rect key={x} x={x} y={200} width={26} height={6} rx={1} />
        ))}
        {cranes.map((x) => (
          <g key={x}>
            <rect x={x - 2} y={184} width={4} height={22} />
            <rect x={x - 4.5} y={182} width={9} height={6} rx={1} />
          </g>
        ))}
        <rect x="1040" y="168" width="72" height="38" />
        <rect x="1048" y="157" width="56" height="12" />
        <rect x="1034" y="151" width="84" height="7" rx="1" />
        <path d="M1093 151 L1112 151 L1110 129 L1096 127 Z" />
        <rect x="1061" y="118" width="2" height="34" />
        <rect x="1055" y="126" width="14" height="1.6" />
      </g>
      <g stroke="#071523" strokeWidth="2.4" strokeLinecap="round">
        {cranes.map((x) => (
          <line key={x} x1={x} y1={185} x2={x - 24} y2={164} />
        ))}
      </g>
      <g fill="#FCD9A0">
        {windowsX.map((x) => (
          <rect key={`a${x}`} x={x} y={175} width={4.5} height={3} opacity={0.6} />
        ))}
        {windowsX.slice(1, 6).map((x) => (
          <rect key={`b${x}`} x={x} y={186} width={4.5} height={3} opacity={0.4} />
        ))}
        {Array.from({ length: 9 }, (_, i) => 1039 + i * 8.6).map((x) => (
          <rect key={`c${x}`} x={x} y={153} width={5} height={2.4} opacity={0.75} />
        ))}
        <circle cx="1062" cy="118" r="1.8" fill="#FFE7B8" />
      </g>
    </svg>
  );
}

/**
 * Bandeau d'accueil du tableau de bord : contexte (utilisateur, périmètre, fraîcheur des données) et
 * indicateurs-clés réels, chacun menant à sa liste. Aucun chiffre n'est affiché tant qu'il n'est pas chargé.
 */
export function FleetHero({
  greeting,
  context,
  meta,
  kpis,
  loading,
}: {
  greeting: string;
  context: ReactNode;
  /** Date, fraîcheur des données, vue (rôles) */
  meta?: ReactNode;
  kpis: HeroKpi[];
  loading?: boolean;
}) {
  return (
    <section aria-labelledby="dashboard-title" className="relative isolate overflow-hidden rounded-xl bg-[#081828] text-white">
      {/* Scène limitée à la zone au-dessus des indicateurs (3, 2 ou 1 rangée selon la largeur), qui reposent sur la bande « mer » */}
      <div
        className="absolute inset-x-0 top-0 -z-10 h-[calc(100%-14rem)] sm:h-[calc(100%-9.5rem)] min-[1440px]:h-[calc(100%-4.5rem)]"
        style={{ background: SKY_SEA }}
        aria-hidden
      >
        <SeaScene className="absolute right-0 top-0 aspect-[9/2] h-full w-auto max-w-none" />
      </div>
      {/* Voiles de lisibilité : texte à gauche, indicateurs en pied de bandeau */}
      <div className="absolute inset-0 -z-10 bg-navy-950/75 md:bg-transparent md:bg-[linear-gradient(90deg,rgba(11,31,51,0.85)_0%,rgba(11,31,51,0.6)_40%,rgba(11,31,51,0)_70%)]" aria-hidden />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-gradient-to-t from-navy-950/95 via-navy-950/60 to-transparent" aria-hidden />

      <div className="px-5 pb-5 pt-6 lg:px-8 lg:pt-7 min-[1440px]:pt-8">
        {/* Texte à gauche uniquement : la droite du bandeau reste à l'illustration */}
        <div className="min-w-0 max-w-2xl">
          <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-teal-100/80">Tableau de bord</p>
          <h1 id="dashboard-title" className="mt-1 text-2xl font-semibold text-white">
            {greeting}
          </h1>
          <div className="mt-1 text-sm text-white/80">{context}</div>
          {meta && <div className="mt-1 text-xs text-white/60">{meta}</div>}
        </div>

        <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 min-[1440px]:mt-8 min-[1440px]:flex min-[1440px]:gap-0" aria-label="Indicateurs clés">
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="flex-1 min-[1440px]:border-l min-[1440px]:border-white/15 min-[1440px]:px-4 min-[1440px]:first:border-l-0 min-[1440px]:first:pl-0">
                  <Skeleton className="h-12 w-32 bg-white/10" />
                </li>
              ))
            : kpis.map((k) => {
                const Icon = k.icon;
                const body = (
                  <>
                    <Icon className="mt-1 h-6 w-6 shrink-0 text-white/85" strokeWidth={1.6} aria-hidden />
                    <span className="min-w-0">
                      <span className="tabular block text-[26px] font-semibold leading-8">{k.value}</span>
                      <span className="block text-sm font-medium leading-snug text-white">{k.label}</span>
                      {k.sub && <span className={cn('mt-0.5 block text-xs leading-snug', k.tone ? TONE[k.tone] : 'text-white/70')}>{k.sub}</span>}
                    </span>
                  </>
                );
                return (
                  <li key={k.key} className="min-w-0 flex-1 min-[1440px]:border-l min-[1440px]:border-white/15 min-[1440px]:px-4 min-[1440px]:first:border-l-0 min-[1440px]:first:pl-0">
                    {k.href ? (
                      <Link href={k.href} className="group -m-1.5 flex gap-2.5 rounded-md p-1.5 hover:bg-white/[0.06] focus-visible:outline-white">
                        {body}
                      </Link>
                    ) : (
                      <div className="flex gap-2.5">{body}</div>
                    )}
                  </li>
                );
              })}
        </ul>
      </div>
    </section>
  );
}
