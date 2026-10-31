import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Errors } from '../../common/errors';
import type { Tx } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

/** Paramètres Argon2id conformes aux recommandations OWASP (m=19 MiB, t=2, p=1). */
const ARGON2_OPTIONS: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  /** Hash factice pour égaliser le temps de réponse sur identifiant inconnu (anti-énumération). */
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly settings: SettingsService) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  async burn(password: string): Promise<void> {
    this.dummyHash ??= argon2.hash('amc-dummy-password-for-timing', ARGON2_OPTIONS);
    await this.verify(await this.dummyHash, password);
  }

  /** Règles affichées avant saisie (ADM-21) : mêmes valeurs que `assertPolicy`. */
  async policy() {
    return { minLength: await this.settings.get('auth.passwordMinLength'), maxLength: 256, minClasses: 3 };
  }

  /** Politique de mot de passe (CDC §1.2) : longueur minimale configurable + règles de base. */
  async assertPolicy(password: string, context: { username: string; email?: string | null }): Promise<void> {
    const min = await this.settings.get('auth.passwordMinLength');
    const problems: string[] = [];
    if (password.length < min) problems.push(`au moins ${min} caractères`);
    if (password.length > 256) problems.push('au plus 256 caractères');
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
    if (classes < 3) problems.push('au moins 3 types parmi minuscules, majuscules, chiffres, symboles');
    const lower = password.toLowerCase();
    if (context.username && lower.includes(context.username.toLowerCase())) problems.push("ne pas contenir l'identifiant");
    const local = context.email?.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && lower.includes(local)) problems.push("ne pas contenir l'adresse e-mail");
    if (problems.length) throw Errors.validation('Mot de passe non conforme', { rules: problems });
  }
}

/** Invalide tous les liens de réinitialisation encore utilisables d'un compte (ADM-03). */
export async function invalidateResetTokens(tx: Tx, userId: string): Promise<void> {
  await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
}
