import { Injectable } from '@nestjs/common';
import { PrincipalType, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { CertificateAccessService } from './certificate-access.service';
import { TYPES_MANAGE_PERMISSION } from './certificate.logic';
import {
  CreateCertificateTypeDto,
  CreateReminderPolicyDto,
  ListCertificateTypesQuery,
  PrincipalInput,
  UpdateCertificateTypeDto,
  UpdateReminderPolicyDto,
} from './certificates.dto';

const TYPE_INCLUDE = {
  validators: { select: { id: true, principalType: true, principalId: true } },
  reminderPolicy: { select: { id: true, name: true, thresholdsDays: true, frequency: true } },
} satisfies Prisma.CertificateTypeInclude;

const POLICY_INCLUDE = {
  recipients: { select: { id: true, principalType: true, principalId: true } },
  types: { select: { id: true, code: true, name: true, subjectKind: true } },
} satisfies Prisma.ReminderPolicyInclude;

type PrincipalRow = { principalType: PrincipalType; principalId: string };

function samePrincipals(a: PrincipalRow[], b: PrincipalRow[]): boolean {
  const key = (p: PrincipalRow) => `${p.principalType}:${p.principalId}`;
  const sa = new Set(a.map(key));
  return sa.size === new Set(b.map(key)).size && b.every((p) => sa.has(key(p)));
}

function dedupePrincipals(list: PrincipalInput[]): PrincipalInput[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.principalType}:${p.principalId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Configuration Super Admin du moteur Certificats (permission `certificates.types.manage`) :
 * types par titulaire, validateurs éligibles (ADM-051), politiques de rappel et destinataires
 * (ADM-044..047, 056, 063, 065). Aucune suppression : désactivation (`isActive`) uniquement.
 * Toute modification de type ou de validateur est auditée (CDC §4.6).
 *
 * Lecture (`certificates.view`) : les compteurs ne portent que sur les certificats visibles par
 * l'appelant (scope navire / ADM-070) et la composition des validateurs / destinataires (noms
 * d'utilisateurs, rôles, départements) est réservée aux administrateurs des types.
 */
@Injectable()
export class CertificateTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly certAccess: CertificateAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  async listTypes(ctx: AuthContext, q: ListCertificateTypesQuery) {
    const rows = await this.prisma.certificateType.findMany({
      where: {
        ...(q.subjectKind ? { subjectKind: q.subjectKind } : {}),
        ...(q.active === undefined ? {} : { isActive: q.active }),
        ...(q.category ? { category: q.category } : {}),
      },
      include: TYPE_INCLUDE,
      orderBy: [{ subjectKind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const manager = can(ctx, TYPES_MANAGE_PERMISSION);
    const [labels, counts] = await Promise.all([
      manager ? this.principalLabels(rows.flatMap((r) => r.validators)) : new Map<string, string>(),
      this.visibleCounts(ctx),
    ]);
    return rows.map((r) => this.presentType(r, labels, counts, manager));
  }

  async getType(ctx: AuthContext, id: string) {
    const row = await this.prisma.certificateType.findUnique({ where: { id }, include: TYPE_INCLUDE });
    if (!row) throw Errors.notFound('Type de certificat');
    const manager = can(ctx, TYPES_MANAGE_PERMISSION);
    const [labels, counts] = await Promise.all([
      manager ? this.principalLabels(row.validators) : new Map<string, string>(),
      this.visibleCounts(ctx, id),
    ]);
    return this.presentType(row, labels, counts, manager);
  }

  /** Certificats actifs par type, limités au périmètre de l'appelant (jamais de compteur flotte entière). */
  private async visibleCounts(ctx: AuthContext, typeId?: string): Promise<Map<string, number>> {
    const rows = await this.prisma.certificate.groupBy({
      by: ['typeId'],
      where: { AND: [this.certAccess.visibleWhere(ctx), { archivedAt: null }, typeId ? { typeId } : {}] },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.typeId, r._count._all]));
  }

  async createType(ctx: AuthContext, dto: CreateCertificateTypeDto) {
    const { validators, ...data } = dto;
    const principals = dedupePrincipals(validators);
    await this.assertCodeFree(data.code);
    const id = await this.prisma.$transaction(async (tx) => {
      if (data.reminderPolicyId) await this.assertPolicyExists(tx, data.reminderPolicyId);
      await this.assertPrincipalsExist(tx, principals);
      const created = await tx.certificateType.create({
        data: { ...data, validators: { create: principals } },
        include: TYPE_INCLUDE,
      });
      await this.audit.record(
        ctx,
        {
          action: 'certificate_type.created',
          module: 'certificates',
          entityType: 'certificate_type',
          entityId: created.id,
          after: { ...data, validators: principals },
        },
        tx,
      );
      return created.id;
    });
    return this.getType(ctx, id);
  }

  async updateType(ctx: AuthContext, id: string, dto: UpdateCertificateTypeDto) {
    const before = await this.prisma.certificateType.findUnique({ where: { id }, include: TYPE_INCLUDE });
    if (!before) throw Errors.notFound('Type de certificat');
    if (dto.code && dto.code !== before.code) await this.assertCodeFree(dto.code, id);
    if (
      dto.subjectKind &&
      dto.subjectKind !== before.subjectKind &&
      (await this.prisma.certificate.count({ where: { typeId: id } })) > 0
    ) {
      throw Errors.business('Le titulaire (navire / Member) ne peut plus changer : des certificats utilisent ce type');
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.reminderPolicyId) await this.assertPolicyExists(tx, dto.reminderPolicyId);
      const after = await tx.certificateType.update({ where: { id }, data: dto as Prisma.CertificateTypeUncheckedUpdateInput });
      const { validators: _v, reminderPolicy: _p, ...plainBefore } = before;
      const diff = diffFields(plainBefore as Record<string, unknown>, after as unknown as Record<string, unknown>);
      delete (diff.before as Record<string, unknown> | undefined)?.updatedAt;
      delete (diff.after as Record<string, unknown> | undefined)?.updatedAt;
      await this.audit.record(
        ctx,
        { action: 'certificate_type.updated', module: 'certificates', entityType: 'certificate_type', entityId: id, ...diff },
        tx,
      );
    });
    return this.getType(ctx, id);
  }

  /** Remplace les validateurs éligibles du type (ADM-051) — changement audité (CDC §4.6). */
  async setValidators(ctx: AuthContext, id: string, list: PrincipalInput[]) {
    const type = await this.prisma.certificateType.findUnique({ where: { id }, include: { validators: true } });
    if (!type) throw Errors.notFound('Type de certificat');
    const principals = dedupePrincipals(list);
    if (samePrincipals(type.validators, principals)) return this.getType(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await this.assertPrincipalsExist(tx, principals);
      await tx.certificateTypeValidator.deleteMany({ where: { typeId: id } });
      if (principals.length) {
        await tx.certificateTypeValidator.createMany({ data: principals.map((p) => ({ ...p, typeId: id })) });
      }
      await this.audit.record(
        ctx,
        {
          action: 'certificate_type.validators_changed',
          module: 'certificates',
          entityType: 'certificate_type',
          entityId: id,
          before: { validators: type.validators.map(({ principalType, principalId }) => ({ principalType, principalId })) },
          after: { validators: principals },
        },
        tx,
      );
    });
    return this.getType(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Politiques de rappel
  // ---------------------------------------------------------------------------

  async listPolicies(ctx: AuthContext) {
    const rows = await this.prisma.reminderPolicy.findMany({ include: POLICY_INCLUDE, orderBy: { name: 'asc' } });
    const manager = can(ctx, TYPES_MANAGE_PERMISSION);
    const labels = manager
      ? await this.principalLabels(rows.flatMap((r) => r.recipients), rows.map((r) => r.escalationRoleId))
      : new Map<string, string>();
    return rows.map((r) => this.presentPolicy(r, labels, manager));
  }

  async getPolicy(ctx: AuthContext, id: string) {
    const row = await this.prisma.reminderPolicy.findUnique({ where: { id }, include: POLICY_INCLUDE });
    if (!row) throw Errors.notFound('Politique de rappel');
    const manager = can(ctx, TYPES_MANAGE_PERMISSION);
    const labels = manager ? await this.principalLabels(row.recipients, [row.escalationRoleId]) : new Map<string, string>();
    return this.presentPolicy(row, labels, manager);
  }

  async createPolicy(ctx: AuthContext, dto: CreateReminderPolicyDto) {
    const { recipients, ...data } = dto;
    const principals = dedupePrincipals(recipients);
    await this.assertPolicyNameFree(data.name);
    const id = await this.prisma.$transaction(async (tx) => {
      if (data.escalationRoleId) await this.assertPrincipalsExist(tx, [{ principalType: 'ROLE', principalId: data.escalationRoleId }]);
      await this.assertPrincipalsExist(tx, principals);
      const created = await tx.reminderPolicy.create({ data: { ...data, recipients: { create: principals } } });
      await this.audit.record(
        ctx,
        {
          action: 'reminder_policy.created',
          module: 'certificates',
          entityType: 'reminder_policy',
          entityId: created.id,
          after: { ...data, recipients: principals },
        },
        tx,
      );
      return created.id;
    });
    return this.getPolicy(ctx, id);
  }

  async updatePolicy(ctx: AuthContext, id: string, dto: UpdateReminderPolicyDto) {
    const before = await this.prisma.reminderPolicy.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Politique de rappel');
    if (dto.name && dto.name !== before.name) await this.assertPolicyNameFree(dto.name, id);
    const frequency = dto.frequency ?? before.frequency;
    const custom = dto.customIntervalDays === undefined ? before.customIntervalDays : dto.customIntervalDays;
    if (frequency === 'CUSTOM' && !custom) {
      throw Errors.validation('Intervalle requis pour la fréquence personnalisée', [{ path: 'customIntervalDays' }]);
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.escalationRoleId) await this.assertPrincipalsExist(tx, [{ principalType: 'ROLE', principalId: dto.escalationRoleId }]);
      const after = await tx.reminderPolicy.update({ where: { id }, data: dto });
      const diff = diffFields(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      delete (diff.before as Record<string, unknown> | undefined)?.updatedAt;
      delete (diff.after as Record<string, unknown> | undefined)?.updatedAt;
      await this.audit.record(
        ctx,
        { action: 'reminder_policy.updated', module: 'certificates', entityType: 'reminder_policy', entityId: id, ...diff },
        tx,
      );
    });
    return this.getPolicy(ctx, id);
  }

  /** Destinataires users / rôles / départements (ADM-045) — filtrés sur droits réels à l'envoi. */
  async setRecipients(ctx: AuthContext, id: string, list: PrincipalInput[]) {
    const policy = await this.prisma.reminderPolicy.findUnique({ where: { id }, include: { recipients: true } });
    if (!policy) throw Errors.notFound('Politique de rappel');
    const principals = dedupePrincipals(list);
    if (samePrincipals(policy.recipients, principals)) return this.getPolicy(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await this.assertPrincipalsExist(tx, principals);
      await tx.reminderPolicyRecipient.deleteMany({ where: { policyId: id } });
      if (principals.length) {
        await tx.reminderPolicyRecipient.createMany({ data: principals.map((p) => ({ ...p, policyId: id })) });
      }
      await this.audit.record(
        ctx,
        {
          action: 'reminder_policy.recipients_changed',
          module: 'certificates',
          entityType: 'reminder_policy',
          entityId: id,
          before: { recipients: policy.recipients.map(({ principalType, principalId }) => ({ principalType, principalId })) },
          after: { recipients: principals },
        },
        tx,
      );
    });
    return this.getPolicy(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Contrôles & présentation
  // ---------------------------------------------------------------------------

  private async assertCodeFree(code: string, excludeId?: string) {
    const dup = await this.prisma.certificateType.findFirst({
      where: { code, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (dup) throw Errors.duplicate('Un type de certificat avec ce code existe déjà', { field: 'code' });
  }

  private async assertPolicyNameFree(name: string, excludeId?: string) {
    const dup = await this.prisma.reminderPolicy.findFirst({
      where: { name, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (dup) throw Errors.duplicate('Une politique de rappel porte déjà ce nom', { field: 'name' });
  }

  private async assertPolicyExists(db: Db, id: string) {
    if (!(await db.reminderPolicy.count({ where: { id } }))) throw Errors.validation('Politique de rappel inconnue', [{ path: 'reminderPolicyId' }]);
  }

  /** Chaque principal doit exister (utilisateur actif, rôle, département actif). */
  private async assertPrincipalsExist(db: Db, principals: PrincipalInput[]) {
    const ids = (t: PrincipalType) => principals.filter((p) => p.principalType === t).map((p) => p.principalId);
    const [users, roles, depts] = [ids('USER'), ids('ROLE'), ids('DEPARTMENT')];
    const [u, r, d] = await Promise.all([
      users.length ? db.user.count({ where: { id: { in: users }, status: 'ACTIVE' } }) : 0,
      roles.length ? db.role.count({ where: { id: { in: roles } } }) : 0,
      depts.length ? db.department.count({ where: { id: { in: depts }, status: 'ACTIVE' } }) : 0,
    ]);
    const missing: string[] = [];
    if (u !== users.length) missing.push('USER');
    if (r !== roles.length) missing.push('ROLE');
    if (d !== depts.length) missing.push('DEPARTMENT');
    if (missing.length) throw Errors.validation('Principal inconnu ou inactif', { principalTypes: missing });
  }

  /** Libellés lisibles des principaux (nom d'utilisateur, de rôle, de département). */
  private async principalLabels(principals: PrincipalRow[], extraRoleIds: (string | null)[] = []) {
    const ids = (t: PrincipalType) => principals.filter((p) => p.principalType === t).map((p) => p.principalId);
    const roleIds = [...ids('ROLE'), ...extraRoleIds.filter((x): x is string => !!x)];
    const [users, roles, depts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids('USER') } }, select: { id: true, displayName: true } }),
      this.prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }),
      this.prisma.department.findMany({ where: { id: { in: ids('DEPARTMENT') } }, select: { id: true, name: true } }),
    ]);
    const map = new Map<string, string>();
    users.forEach((x) => map.set(`USER:${x.id}`, x.displayName));
    roles.forEach((x) => map.set(`ROLE:${x.id}`, x.name));
    depts.forEach((x) => map.set(`DEPARTMENT:${x.id}`, x.name));
    return map;
  }

  /** Composition des validateurs réservée aux administrateurs des types (sinon nombre seulement). */
  private presentType(
    row: Prisma.CertificateTypeGetPayload<{ include: typeof TYPE_INCLUDE }>,
    labels: Map<string, string>,
    counts: Map<string, number>,
    manager: boolean,
  ) {
    const { validators, ...rest } = row;
    return {
      ...rest,
      /** Certificats actifs de ce type visibles par l'appelant */
      certificateCount: counts.get(row.id) ?? 0,
      validatorCount: validators.length,
      validators: manager
        ? validators.map((v) => ({ ...v, label: labels.get(`${v.principalType}:${v.principalId}`) ?? null }))
        : null,
    };
  }

  /** Destinataires et rôle d'escalade réservés aux administrateurs des types (sinon nombre seulement). */
  private presentPolicy(
    row: Prisma.ReminderPolicyGetPayload<{ include: typeof POLICY_INCLUDE }>,
    labels: Map<string, string>,
    manager: boolean,
  ) {
    const { recipients, escalationRoleId, ...rest } = row;
    return {
      ...rest,
      escalationRoleId: manager ? escalationRoleId : null,
      escalationConfigured: !!escalationRoleId,
      escalationRole:
        manager && escalationRoleId ? { id: escalationRoleId, name: labels.get(`ROLE:${escalationRoleId}`) ?? null } : null,
      recipientCount: recipients.length,
      recipients: manager
        ? recipients.map((r) => ({ ...r, label: labels.get(`${r.principalType}:${r.principalId}`) ?? null }))
        : null,
    };
  }
}
