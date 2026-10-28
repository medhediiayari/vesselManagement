import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  CreateSupplierContactDto,
  CreateSupplierDto,
  ListSuppliersQuery,
  SetSupplierActiveDto,
  UpdateSupplierContactDto,
  UpdateSupplierDto,
} from './suppliers.dto';
import { SuppliersService } from './suppliers.service';

@ApiTags('Purchasing — Suppliers')
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermissions('suppliers.view')
  list(@Query() q: ListSuppliersQuery) {
    return this.suppliers.list(q);
  }

  @Post()
  @RequirePermissions('suppliers.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('suppliers.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.get(id);
  }

  @Patch(':id')
  @RequirePermissions('suppliers.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(ctx, id, dto);
  }

  /** POST /suppliers/:id/active — activer / désactiver (jamais de suppression : historique des commandes). */
  @Post(':id/active')
  @RequirePermissions('suppliers.manage')
  setActive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSupplierActiveDto) {
    return this.suppliers.setActive(ctx, id, dto.isActive, dto.reason);
  }

  @Post(':id/contacts')
  @RequirePermissions('suppliers.manage')
  addContact(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSupplierContactDto) {
    return this.suppliers.addContact(ctx, id, dto);
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermissions('suppliers.manage')
  updateContact(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateSupplierContactDto,
  ) {
    return this.suppliers.updateContact(ctx, id, contactId, dto);
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermissions('suppliers.manage')
  removeContact(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('contactId', ParseUUIDPipe) contactId: string) {
    return this.suppliers.removeContact(ctx, id, contactId);
  }
}
