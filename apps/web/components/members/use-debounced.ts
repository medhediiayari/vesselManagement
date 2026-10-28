'use client';

import { useEffect, useState } from 'react';

/** Valeur stabilisée après `delay` ms sans changement (recherche, contrôle de doublons). */
export function useDebounced<T>(value: T, delay = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
