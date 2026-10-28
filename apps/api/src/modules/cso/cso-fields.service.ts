import { Injectable } from '@nestjs/common';
import type { CsoFieldAcl, CsoFieldDefinition, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AuthContext, principalsOf } from '../access/auth-context';
import { ActionMap, FieldAclLike, PrincipalRef, fieldAccess } from './cso-acl.logic';

export type FieldWithAcl = CsoFieldDefinition & { acl: CsoFieldAcl[] };

export interface FieldChange {
  fieldId: string;
  key: string;
  label: string;
  confidential: boolean;
  before: unknown;
  after: unknown;
}

/** Valeur masquée dans l'audit pour un champ confidentiel (le journal ne réexpose pas la donnée). */
const MASK = '[confidentiel]';

/**
 * Champs personnalisés CSO (CSO-029..032, CDC §5.6) : validation typée, ACL de champ
 * (visibilité / édition séparées), valeurs confidentielles jamais renvoyées à un acteur
 * qui voit le document mais pas le champ. Les champs archivés gardent leurs valeurs (CSO-030).
 */
@Injectable()
export class CsoFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  async fieldsOfCategory(categoryId: string | null, db: Db = this.prisma): Promise<FieldWithAcl[]> {
    if (!categoryId) return [];
    return db.csoFieldDefinition.findMany({
      where: { categoryId },
      include: { acl: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  access(ctx: AuthContext, field: FieldWithAcl, docEff: ActionMap, documentVisible = true) {
    return fieldAccess({
      isConfidential: field.isConfidential,
      archived: !!field.archivedAt,
      acl: field.acl as FieldAclLike[],
      principals: principalsOf(ctx) as PrincipalRef[],
      permissions: ctx.permissions,
      documentView: documentVisible && docEff.view,
      documentEdit: docEff.edit,
    });
  }

  /** Peut-on voir la DÉFINITION / les valeurs d'un champ indépendamment d'un document (recherche) ? */
  canViewFieldGlobally(ctx: AuthContext, field: FieldWithAcl): boolean {
    return fieldAccess({
      isConfidential: field.isConfidential,
      archived: !!field.archivedAt,
      acl: field.acl as FieldAclLike[],
      principals: principalsOf(ctx) as PrincipalRef[],
      permissions: ctx.permissions,
      documentView: ctx.permissions.has('cso.view'),
      documentEdit: false,
    }).view;
  }

  /**
   * Valeurs visibles d'un document : uniquement les champs que l'utilisateur peut voir
   * (les champs masqués n'apparaissent pas du tout dans la réponse).
   */
  async visibleValues(ctx: AuthContext, doc: { id: string; categoryId: string | null }, docEff: ActionMap, db: Db = this.prisma) {
    const values = await db.csoFieldValue.findMany({ where: { documentId: doc.id }, include: { field: { include: { acl: true } } } });
    const categoryFields = await this.fieldsOfCategory(doc.categoryId, db);
    const byId = new Map<string, FieldWithAcl>();
    categoryFields.forEach((f) => byId.set(f.id, f));
    values.forEach((v) => byId.set(v.field.id, v.field));
    const out = [];
    for (const field of byId.values()) {
      const acc = this.access(ctx, field, docEff);
      if (!acc.view) continue;
      const value = values.find((v) => v.fieldId === field.id);
      // Champ d'une autre catégorie (après changement) : affiché en lecture seule, valeur préservée
      const foreign = field.categoryId !== doc.categoryId;
      if (!value && (field.archivedAt || foreign)) continue;
      out.push({
        fieldId: field.id,
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        required: field.required,
        isConfidential: field.isConfidential,
        archived: !!field.archivedAt || foreign,
        value: value?.value ?? null,
        updatedAt: value?.updatedAt ?? null,
        canEdit: acc.edit && !foreign,
      });
    }
    return out;
  }

  /**
   * Prédicat de visibilité des entrées « customFields » de l'audit d'un document, pour le lecteur courant
   * (audit #7b) : entrée identifiée par fieldId (événements récents) ou par clé (événements anciens —
   * visible seulement si TOUS les champs portant cette clé sont visibles). Refus par défaut.
   */
  async auditFieldFilter(
    ctx: AuthContext,
    doc: { id: string; categoryId: string | null },
    docEff: ActionMap,
    extraFieldIds: string[],
    db: Db = this.prisma,
  ): Promise<(entry: unknown) => boolean> {
    const valueFieldIds = (await db.csoFieldValue.findMany({ where: { documentId: doc.id }, select: { fieldId: true } })).map((v) => v.fieldId);
    const ids = [...new Set([...valueFieldIds, ...extraFieldIds])];
    const defs: FieldWithAcl[] = [
      ...(await this.fieldsOfCategory(doc.categoryId, db)),
      ...(ids.length ? await db.csoFieldDefinition.findMany({ where: { id: { in: ids } }, include: { acl: true } }) : []),
    ];
    const visible = new Map(defs.map((f) => [f.id, this.access(ctx, f, docEff).view]));
    const byKey = new Map<string, boolean[]>();
    for (const f of defs) byKey.set(f.key, [...(byKey.get(f.key) ?? []), visible.get(f.id) === true]);
    return (entry: unknown) => {
      const e = (entry ?? {}) as { fieldId?: unknown; key?: unknown };
      if (typeof e.fieldId === 'string') return visible.get(e.fieldId) === true;
      const flags = typeof e.key === 'string' ? byKey.get(e.key) : undefined;
      return !!flags?.length && flags.every(Boolean);
    };
  }

  /**
   * Applique des valeurs (clé -> valeur | null). Chaque champ exige cso.fields.edit + ACL champ
   * canEdit + droit d'édition du document + scope (CSO-032). Retourne les changements (audit masqué).
   */
  async applyValues(
    ctx: AuthContext,
    doc: { id: string; categoryId: string | null },
    docEff: ActionMap,
    input: Record<string, string | number | boolean | null> | undefined,
    opts: { enforceRequired: boolean },
    db: Db,
  ): Promise<FieldChange[]> {
    const fields = await this.fieldsOfCategory(doc.categoryId, db);
    const values = input ?? {};
    const changes: FieldChange[] = [];
    const existing = await db.csoFieldValue.findMany({ where: { documentId: doc.id } });

    for (const [key, raw] of Object.entries(values)) {
      const field = fields.find((f) => f.key === key);
      if (!field || field.archivedAt) throw Errors.validation(`Champ « ${key} » inconnu ou archivé pour cette catégorie`, { field: key });
      const acc = this.access(ctx, field, docEff);
      if (!acc.edit) {
        if (!ctx.permissions.has('cso.fields.edit')) throw Errors.forbidden('Permission requise : cso.fields.edit', { permission: 'cso.fields.edit' });
        throw Errors.aclDenied(`Modification du champ « ${field.label} » non autorisée`);
      }
      const before = existing.find((v) => v.fieldId === field.id)?.value ?? null;
      if (raw === null || raw === '') {
        if (field.required) throw Errors.validation(`Le champ « ${field.label} » est obligatoire`, { field: key });
        if (before !== null) {
          await db.csoFieldValue.delete({ where: { documentId_fieldId: { documentId: doc.id, fieldId: field.id } } });
          changes.push(this.change(field, before, null));
        }
        continue;
      }
      const value = normalizeFieldValue(field, raw);
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      await db.csoFieldValue.upsert({
        where: { documentId_fieldId: { documentId: doc.id, fieldId: field.id } },
        create: { documentId: doc.id, fieldId: field.id, value: value as Prisma.InputJsonValue, updatedById: ctx.userId },
        update: { value: value as Prisma.InputJsonValue, updatedById: ctx.userId },
      });
      changes.push(this.change(field, before, value));
    }

    if (opts.enforceRequired) {
      const filled = new Set([
        ...existing.map((v) => v.fieldId),
        ...fields.filter((f) => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== '').map((f) => f.id),
      ]);
      // Seuls les champs que l'utilisateur peut renseigner lui sont imposés
      const missing = fields.filter((f) => f.required && !f.archivedAt && !filled.has(f.id) && this.access(ctx, f, docEff).edit);
      if (missing.length) {
        throw Errors.validation('Champs personnalisés obligatoires manquants', { fields: missing.map((f) => f.key) });
      }
    }
    return changes;
  }

  private change(field: CsoFieldDefinition, before: unknown, after: unknown): FieldChange {
    return {
      fieldId: field.id,
      key: field.key,
      label: field.label,
      confidential: field.isConfidential,
      before: field.isConfidential && before !== null ? MASK : before,
      after: field.isConfidential && after !== null ? MASK : after,
    };
  }
}

/** Validation / normalisation d'une valeur selon le type du champ. */
export function normalizeFieldValue(field: Pick<CsoFieldDefinition, 'type' | 'options' | 'label' | 'key'>, raw: string | number | boolean): unknown {
  const fail = (msg: string) => Errors.validation(`Champ « ${field.label} » : ${msg}`, { field: field.key });
  switch (field.type) {
    case 'TEXT': {
      const s = String(raw).trim();
      if (s.length > 5000) throw fail('5000 caractères maximum');
      return s;
    }
    case 'NUMBER': {
      const s = String(raw).trim().replace(',', '.');
      if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(s)) throw fail('nombre attendu');
      return Number(s);
    }
    case 'DATE': {
      const s = String(raw).trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
      if (!m || !d || d.getUTCDate() !== Number(m[3]) || d.getUTCMonth() !== Number(m[2]) - 1) throw fail('date AAAA-MM-JJ attendue');
      return s;
    }
    case 'SELECT': {
      const options = Array.isArray(field.options) ? (field.options as unknown[]).map(String) : [];
      const s = String(raw).trim();
      if (!options.includes(s)) throw fail(`valeur hors liste (${options.join(', ')})`);
      return s;
    }
    case 'BOOLEAN': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === 'false' || raw === '0' || raw === 0) return false;
      throw fail('booléen attendu');
    }
    default:
      throw fail('type inconnu');
  }
}
