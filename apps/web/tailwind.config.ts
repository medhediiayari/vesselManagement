import type { Config } from 'tailwindcss';

/**
 * Design system AMC — direction « Passerelle » (outil d'exploitation de flotte, pas un SaaS générique) :
 * structure marine, action « ocean » (bleu-vert profond, contraste 6,2:1 sur blanc), surfaces plates à filets,
 * références en IBM Plex Mono. Les statuts restent toujours libellés (jamais la couleur seule).
 * `action` garde son nom historique : tous les boutons/liens existants basculent sur la teinte ocean.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#102B44', 950: '#0B1F33', 900: '#102B44', 800: '#173753', 700: '#214B65', 600: '#2F5F7B', 100: '#DCE5EC', 50: '#EDF2F6' },
        action: { DEFAULT: '#176A79', 700: '#105562', 600: '#176A79', 100: '#D3E9EC', 50: '#ECF5F6' },
        teal: { DEFAULT: '#1B9AAA', 700: '#0F6E7A', 100: '#D3EEF1', 50: '#EBF7F8' },
        canvas: '#F3F6F8',
        surface: { DEFAULT: '#FFFFFF', sunken: '#F7F9FA' },
        // muted 5,9:1 et soft 4,5:1 sur blanc (WCAG AA texte)
        ink: { DEFAULT: '#1F2D3A', muted: '#556677', soft: '#687786' },
        line: { DEFAULT: '#DCE3E9', strong: '#C3CED8' },
        ok: { DEFAULT: '#08703F', bg: '#E6F4EC', line: '#A9D9BE' },
        warn: { DEFAULT: '#A64B06', bg: '#FDF1E4', line: '#F0C590' },
        danger: { DEFAULT: '#B42318', bg: '#FCEBE9', line: '#F1B3AC' },
        info: { DEFAULT: '#1D5FB8', bg: '#EAF1FB', line: '#B5CCEE' },
        neutral: { DEFAULT: '#4A5868', bg: '#EFF2F5', line: '#CFD6DE' },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans Variable"', '"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '14px'],
        xs: ['12px', '16px'],
        sm: ['13px', '20px'],
        base: ['14px', '22px'],
        md: ['16px', '24px'],
        lg: ['20px', '28px'],
        xl: ['24px', '32px'],
        '2xl': ['30px', '38px'],
      },
      borderRadius: { sm: '3px', DEFAULT: '4px', md: '6px', lg: '8px', xl: '10px' },
      boxShadow: {
        // Surfaces plates : un filet net plutôt qu'une ombre portée sous chaque bloc
        panel: '0 0 0 1px #DCE3E9',
        raised: '0 1px 2px rgba(16,43,68,0.06), 0 0 0 1px #DCE3E9',
        pop: '0 12px 32px rgba(11,31,51,0.20), 0 0 0 1px rgba(11,31,51,0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
