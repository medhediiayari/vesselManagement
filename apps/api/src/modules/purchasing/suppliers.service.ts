import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { diffFields } from '../audit/audit.service';
import { PurchasingCore } from './purchasing-core.service';
import {
  CreateSupplierContactDto,
  CreateSupplierDto,
  ListSuppliersQuery,
  UpdateSupplierContactDto,
  UpdateSupplierDto,
} from './suppliers.dto';

/**
 * Référentiel fournisseurs (CDC §6.5) : raison sociale, contacts, devise, conditions, statut actif.
 * Non rattaché à un navire (pas de scope) ; un fournisseur inactif ne peut plus être consulté (RFQ) ni commandé.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
  ) {}

  async list(q: ListSuppliersQuery) {
    const where: Prisma.SupplierWhereInput = {
      AND: [
        q.active === undefined ? {} : { isActive: q.active },
        q.country ? { country: q.country } : {},
        q.currency ? { currency: q.currency } : {},
        q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { legalName: { contains: q.search, mode: 'insensitive' } },
                { code: { contains: q.search.toUpperCase() } },
                { email: { contains: q.search.toLowerCase() } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        include: { contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] } },
        ...cursorArgs(q),
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return toPage(rows, q, total);
  }

  async get(id: string) {
    const s = await this.prisma.supplier.findUnique({
      where: { id },
      include: { contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] } },
    });
    if (!s) throw Errors.notFound('Fournisseur');
    return s;
  }

  async create(ctx: AuthContext, dto: CreateSupplierDto) {
    if (await this.prisma.supplier.findUnique({ where: { code: dto.code }, select: { id: true } })) {
      throw Errors.duplicate('Un fournisseur avec ce code existe déjà', { field: 'code' });
    }
    const company = await this.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.supplier.create({ data: { ...dto, companyId: company.id } as Prisma.SupplierUncheckedCreateInput });
      await this.core.audit(ctx, { action: 'supplier.created', entityType: 'supplier', entityId: s.id, after: s }, tx);
      return s;
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateSupplierDto) {
    const before = await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.supplier.update({ where: { id }, data: dto as Prisma.SupplierUncheckedUpdateInput });
      const { contacts: _c, ...b } = before;
      await this.core.audit(ctx, { action: 'supplier.updated', entityType: 'supplier', entityId: id, ...diffFields(b as never, after as never) }, tx);
      return after;
    });
  }

  async setActive(ctx: AuthContext, id: string, isActive: boolean, reason?: string) {
    const before = await this.get(id);
    if (before.isActive === isActive) throw Errors.alreadyProcessed(`Fournisseur déjà ${isActive ? 'actif' : 'inactif'}`);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.supplier.update({ where: { id }, data: { isActive } });
      await this.core.audit(
        ctx,
        { action: isActive ? 'supplier.activated' : 'supplier.deactivated', entityType: 'supplier', entityId: id, before: { isActive: before.isActive }, after: { isActive }, metadata: { reason } },
        tx,
      );
      return after;
    });
  }

  async addContact(ctx: AuthContext, supplierId: string, dto: CreateSupplierContactDto) {
    await this.get(supplierId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) await tx.supplierContact.updateMany({ where: { supplierId }, data: { isPrimary: false } });
      const c = await tx.supplierContact.create({ data: { ...dto, supplierId } as Prisma.SupplierContactUncheckedCreateInput });
      await this.core.audit(ctx, { action: 'supplier.contact_added', entityType: 'supplier', entityId: supplierId, after: c }, tx);
      return c;
    });
  }

  async updateContact(ctx: AuthContext, supplierId: string, contactId: string, dto: UpdateSupplierContactDto) {
    const before = await this.prisma.supplierContact.findFirst({ where: { id: contactId, supplierId } });
    if (!before) throw Errors.notFound('Contact fournisseur');
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) await tx.supplierContact.updateMany({ where: { supplierId, id: { not: contactId } }, data: { isPrimary: false } });
      const after = await tx.supplierContact.update({ where: { id: contactId }, data: dto as Prisma.SupplierContactUncheckedUpdateInput });
      await this.core.audit(ctx, { action: 'supplier.contact_updated', entityType: 'supplier', entityId: supplierId, ...diffFields(before as never, after as never) }, tx);
      return after;
    });
  }

  async removeContact(ctx: AuthContext, supplierId: string, contactId: string) {
    const before = await this.prisma.supplierContact.findFirst({ where: { id: contactId, supplierId } });
    if (!before) throw Errors.notFound('Contact fournisseur');
    return this.prisma.$transaction(async (tx) => {
      await tx.supplierContact.delete({ where: { id: contactId } });
      await this.core.audit(ctx, { action: 'supplier.contact_removed', entityType: 'supplier', entityId: supplierId, before }, tx);
      return { id: contactId, removed: true };
    });
  }
}
