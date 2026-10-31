'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  minClasses: number;
}

/** Politique de mot de passe en vigueur (paramètre `auth.passwordMinLength`), lisible sans session. */
export function usePasswordPolicy() {
  return useQuery({
    queryKey: ['password-policy'],
    queryFn: () => api.get<PasswordPolicy>('/auth/password-policy'),
    staleTime: 300_000,
    retry: 1,
  });
}

/** Consigne affichée sous le champ « Nouveau mot de passe » (mêmes règles que l'API). */
export function passwordRulesHint(policy: PasswordPolicy | undefined): string {
  const length = policy ? `${policy.minLength} caractères minimum` : 'Longueur minimale fixée par l’administrateur';
  return `${length}, ${policy?.minClasses ?? 3} types parmi minuscules, majuscules, chiffres et symboles ; sans votre identifiant ni votre adresse e-mail.`;
}
