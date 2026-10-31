// nestjs-zod installe sa propre carte d'erreurs (anglaise) au chargement : le charger d'abord pour que
// la carte française, posée ensuite, prenne le dessus.
import 'nestjs-zod';
import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

/**
 * Messages de validation Zod en français (audit ADM-19 / FLT-14). Les messages explicites passés aux
 * schémas (`.min(1, '…')`, `.refine(…, '…')`) restent prioritaires : cette carte ne couvre que les défauts.
 */
const plural = (n: number | bigint, word: string) => `${n} ${word}${Number(n) > 1 ? 's' : ''}`;

export const frenchErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') return { message: 'Champ obligatoire' };
      return { message: `Type invalide : ${issue.expected} attendu` };
    case ZodIssueCode.invalid_literal:
      return { message: `Valeur attendue : ${JSON.stringify(issue.expected)}` };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Champ(s) non reconnu(s) : ${issue.keys.join(', ')}` };
    case ZodIssueCode.invalid_union:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: 'Valeur invalide' };
    case ZodIssueCode.invalid_enum_value:
      return { message: `Valeur non autorisée. Valeurs possibles : ${issue.options.join(', ')}` };
    case ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'Adresse e-mail invalide' };
      if (issue.validation === 'uuid') return { message: 'Identifiant invalide' };
      if (issue.validation === 'url') return { message: 'URL invalide' };
      if (issue.validation === 'datetime') return { message: 'Date et heure invalides (format ISO 8601 attendu)' };
      if (issue.validation === 'date') return { message: 'Date invalide' };
      return { message: 'Format invalide' };
    case ZodIssueCode.invalid_date:
      return { message: 'Date invalide' };
    case ZodIssueCode.too_small:
      if (issue.type === 'string')
        return { message: issue.exact ? `Exactement ${plural(issue.minimum, 'caractère')}` : `Au moins ${plural(issue.minimum, 'caractère')}` };
      if (issue.type === 'array')
        return { message: issue.exact ? `Exactement ${plural(issue.minimum, 'élément')}` : `Au moins ${plural(issue.minimum, 'élément')}` };
      if (issue.type === 'number' || issue.type === 'bigint')
        return { message: `Doit être ${issue.inclusive ? '≥' : '>'} ${issue.minimum}` };
      return { message: 'Valeur trop petite' };
    case ZodIssueCode.too_big:
      if (issue.type === 'string')
        return { message: issue.exact ? `Exactement ${plural(issue.maximum, 'caractère')}` : `Au plus ${plural(issue.maximum, 'caractère')}` };
      if (issue.type === 'array')
        return { message: issue.exact ? `Exactement ${plural(issue.maximum, 'élément')}` : `Au plus ${plural(issue.maximum, 'élément')}` };
      if (issue.type === 'number' || issue.type === 'bigint')
        return { message: `Doit être ${issue.inclusive ? '≤' : '<'} ${issue.maximum}` };
      return { message: 'Valeur trop grande' };
    case ZodIssueCode.not_multiple_of:
      return { message: `Doit être un multiple de ${issue.multipleOf}` };
    case ZodIssueCode.not_finite:
      return { message: 'Nombre fini attendu' };
    case ZodIssueCode.custom:
      return { message: 'Valeur invalide' };
    default:
      return { message: ctx.defaultError };
  }
};

z.setErrorMap(frenchErrorMap);
