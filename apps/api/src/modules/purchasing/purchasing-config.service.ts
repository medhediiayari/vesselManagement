import { Injectable } from '@nestjs/common';
import { PERMISSION_KEYS } from '@amc/types';
import { PrPriority } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoCurrency } from '../../common/pagination';
import { Db, PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_PR_FORM_REF, PO_THRESHOLD_SCOPE, SETTING_PO_APPROVAL_MODE, SETTING_PR_FORM_REF, SETTING_REVIEW_CIRCUITS } from './purchasing.constants';
import { money } from './purchasing.dto-helpers';
import { DEFAULT_REVIEW_CIRCUITS, PoApprovalMode, ReviewCircuitRule, validateReviewRules } from './purchasing.logic';

const code = z.string().trim().regex(/^[A-Z0-9_]{2,40}$/, 'Identifiant : 2 à 40 caractères A-Z 0-9 _');

export const ReviewCircuitRuleSchema = z.object({
  id: code,
  label: z.string().trim().min(2).max(200),
  match: z
    .object({
      requesterRoles: z.array(z.string().trim().min(2).max(64)).max(20).optional(),
      categories: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
      priorities: z.array(z.nativeEnum(PrPriority)).max(4).optional(),
      departmentIds: z.array(z.string().uuid()).max(50).optional(),
      vesselIds: z.array(z.string().uuid()).max(200).optional(),
    })
    .default({}),
  steps: z
    .array(
      z.object({
        key: code,
        label: z.string().trim().min(2).max(200),
        permission: z.string().trim().min(3).max(80),
        roleKeys: z.array(z.string().trim().min(2).max(64)).max(10).optional(),
      }),
    )
    .min(1)
    .max(5),
});

export class ReviewCircuitsDto extends createZodDto(z.object({ rules: z.array(ReviewCircuitRuleSchema).min(1).max(50) })) {}
export class PoApprovalModeDto extends createZodDto(z.object({ mode: z.enum(['THRESHOLD_ONLY', 'ALWAYS']) })) {}
export class PrFormRefDto extends createZodDto(z.object({ formRef: z.string().trim().min(2, '2 caractères minimum').max(80) })) {}
export class UpsertThresholdDto extends createZodDto(
  z.object({
    currency: isoCurrency,
    amount: money,
    requiresSecondApproval: z.boolean().default(true),
    isActive: z.boolean().default(true),
  }),
) {}

/**
 * Paramétrage Achats (CDC §17 « hypothèses configurables », V1 §9.4 « arbitrages non confirmés ») :
 *  - circuits de revue PR (`purchasing.reviewCircuits`, défaut en code : DEFAULT_REVIEW_CIRCUITS — PUR-01) ;
 *  - mode d'approbation BC (`purchasing.poApprovalMode` : THRESHOLD_ONLY par défaut, ou ALWAYS) ;
 *  - seuils financiers BC par devise (table approval_thresholds, scope 'PO') — JAMAIS pré-remplis ;
 *  - sur-allocation (`purchasing.allowOverAllocation`, SettingsService, défaut false).
 * Les deux premières clés sont lues/écrites ici dans system_settings (validées par Zod) tant qu'elles ne
 * figurent pas dans SETTINGS_SCHEMAS (voir rapport : changement partagé recommandé).
 */
@Injectable()
export class PurchasingConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async reviewCircuits(db: Db = this.prisma): Promise<{ rules: ReviewCircuitRule[]; source: 'DEFAULT' | 'SETTINGS' }> {
    const row = await db.systemSetting.findUnique({ where: { key: SETTING_REVIEW_CIRCUITS } });
    if (row) {
      const parsed = z.array(ReviewCircuitRuleSchema).safeParse(row.value);
      if (parsed.success && parsed.data.length) return { rules: parsed.data as ReviewCircuitRule[], source: 'SETTINGS' };
    }
    return { rules: DEFAULT_REVIEW_CIRCUITS, source: 'DEFAULT' };
  }

  async setReviewCircuits(ctx: AuthContext, rules: ReviewCircuitRule[]) {
    validateReviewRules(rules, PERMISSION_KEYS);
    const before = await this.reviewCircuits();
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: SETTING_REVIEW_CIRCUITS },
        create: { key: SETTING_REVIEW_CIRCUITS, value: rules as never, updatedById: ctx.userId, description: 'Circuits de revue PR (Achats)' },
        update: { value: rules as never, updatedById: ctx.userId },
      });
      await this.audit.record(
        ctx,
        { action: 'purchasing.review_circuits_updated', module: 'purchasing', entityType: 'setting', entityId: SETTING_REVIEW_CIRCUITS, before: before.rules, after: rules },
        tx,
      );
    });
    return this.reviewCircuits();
  }

  async poApprovalMode(db: Db = this.prisma): Promise<PoApprovalMode> {
    const row = await db.systemSetting.findUnique({ where: { key: SETTING_PO_APPROVAL_MODE } });
    const parsed = z.enum(['THRESHOLD_ONLY', 'ALWAYS']).safeParse(row?.value);
    return parsed.success ? parsed.data : 'THRESHOLD_ONLY';
  }

  async setPoApprovalMode(ctx: AuthContext, mode: PoApprovalMode) {
    const before = await this.poApprovalMode();
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: SETTING_PO_APPROVAL_MODE },
        create: { key: SETTING_PO_APPROVAL_MODE, value: mode, updatedById: ctx.userId, description: "Mode d'approbation BC (THRESHOLD_ONLY | ALWAYS)" },
        update: { value: mode, updatedById: ctx.userId },
      });
      await this.audit.record(
        ctx,
        { action: 'purchasing.po_approval_mode_updated', module: 'purchasing', entityType: 'setting', entityId: SETTING_PO_APPROVAL_MODE, before: { mode: before }, after: { mode } },
        tx,
      );
    });
    return { mode };
  }

  /** Référence du modèle de formulaire PR (ex. « FORM 41 - Rev N°00 »), recopiée dans chaque PR à sa création. */
  async prFormRef(db: Db = this.prisma): Promise<string> {
    const row = await db.systemSetting.findUnique({ where: { key: SETTING_PR_FORM_REF } });
    const parsed = z.string().trim().min(2).max(80).safeParse(row?.value);
    return parsed.success ? parsed.data : DEFAULT_PR_FORM_REF;
  }

  async setPrFormRef(ctx: AuthContext, formRef: string) {
    const before = await this.prFormRef();
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: SETTING_PR_FORM_REF },
        create: { key: SETTING_PR_FORM_REF, value: formRef, updatedById: ctx.userId, description: 'Référence du formulaire PR (système qualité)' },
        update: { value: formRef, updatedById: ctx.userId },
      });
      await this.audit.record(
        ctx,
        { action: 'purchasing.pr_form_ref_updated', module: 'purchasing', entityType: 'setting', entityId: SETTING_PR_FORM_REF, before: { formRef: before }, after: { formRef } },
        tx,
      );
    });
    return { formRef };
  }

  thresholds(db: Db = this.prisma) {
    return db.approvalThreshold.findMany({ where: { scope: PO_THRESHOLD_SCOPE }, orderBy: { currency: 'asc' } });
  }

  /** Seuil par devise (aucune conversion FX) ; désactiver plutôt que supprimer (traçabilité). */
  async upsertThreshold(ctx: AuthContext, dto: UpsertThresholdDto) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.approvalThreshold.findUnique({ where: { scope_currency: { scope: PO_THRESHOLD_SCOPE, currency: dto.currency } } });
      const after = await tx.approvalThreshold.upsert({
        where: { scope_currency: { scope: PO_THRESHOLD_SCOPE, currency: dto.currency } },
        create: { scope: PO_THRESHOLD_SCOPE, currency: dto.currency, amount: dto.amount, requiresSecondApproval: dto.requiresSecondApproval, isActive: dto.isActive },
        update: { amount: dto.amount, requiresSecondApproval: dto.requiresSecondApproval, isActive: dto.isActive },
      });
      await this.audit.record(
        ctx,
        { action: 'purchasing.threshold_upserted', module: 'purchasing', entityType: 'approval_threshold', entityId: after.id, before, after },
        tx,
      );
      return after;
    });
  }

  async summary() {
    const [circuits, mode, thresholds, allowOverAllocation, prFormRef] = await Promise.all([
      this.reviewCircuits(),
      this.poApprovalMode(),
      this.thresholds(),
      this.settings.get('purchasing.allowOverAllocation'),
      this.prFormRef(),
    ]);
    return {
      reviewCircuits: circuits,
      poApprovalMode: mode,
      prFormRef,
      poThresholds: thresholds,
      allowOverAllocation,
      notes: [
        'Seuils financiers non pré-remplis : tant qu’AUCUN seuil n’est configuré, aucun second regard n’est exigé en mode THRESHOLD_ONLY ; dès qu’un seuil existe, un BC dans une devise sans seuil exige un second regard (NO_THRESHOLD_FOR_CURRENCY).',
        'Aucun taux de change n’est appliqué : un seuil ne s’applique qu’aux BC de sa devise.',
        'Sur-allocation : interdite sauf purchasing.allowOverAllocation = true ET motif ; le BC exige alors un second regard.',
      ],
    };
  }
}
