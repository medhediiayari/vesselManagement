import { cn } from '@/lib/format';

/**
 * Monogramme AMC : sigle typographique sur fond marine, souligné d'une ligne de flottaison ocean.
 * Remplace l'ancre générique (le skill AMC proscrit les icônes d'ancre répétées).
 */
export function AmcMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={cn('h-9 w-9 shrink-0', className)} role="img" aria-label="AMC">
      <rect x="0.5" y="0.5" width="39" height="39" rx="6" fill="#102B44" stroke="rgba(255,255,255,0.18)" />
      <text
        x="20"
        y="23"
        textAnchor="middle"
        fontFamily="'IBM Plex Sans Variable','IBM Plex Sans',system-ui,sans-serif"
        fontWeight="650"
        fontSize="13"
        letterSpacing="0.6"
        fill="#FFFFFF"
      >
        AMC
      </text>
      <rect x="8" y="29" width="24" height="2.5" rx="1.25" fill="#1B9AAA" />
    </svg>
  );
}
