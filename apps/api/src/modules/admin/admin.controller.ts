import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { Errors } from '../../common/errors';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { SETTINGS_SCHEMAS, SettingKey, SettingsService } from '../settings/settings.service';
import {
  CreateDepartmentDto,
  CreateRoleDto,
  CreateUserDto,
  LinkMemberDto,
  ListUsersQuery,
  ReasonDto,
  SetDepartmentsDto,
  SetOverridesDto,
  SetRolesDto,
  SetVesselScopeDto,
  UpdateDepartmentDto,
  UpdateRoleDto,
  UpdateSettingDto,
  UpdateUserDto,
} from './admin.dto';
import { DepartmentsService } from './departments.service';
import { RolesService } from './roles.service';
import { UsersService } from './users.service';

@ApiTags('Admin — Users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.view')
  list(@Query() q: ListUsersQuery) {
    return this.users.list(q);
  }

  @Get(':id')
  @RequirePermissions('users.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('users.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateUserDto) {
    return this.users.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('users.edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(ctx, id, dto);
  }

  @Put(':id/roles')
  @RequirePermissions('users.edit')
  setRoles(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolesDto) {
    return this.users.setRoles(ctx, id, dto.roleIds);
  }

  /** PATCH /permissions/overrides (CDC §11) exposé par utilisateur */
  @Put(':id/overrides')
  @RequirePermissions('permissions.manage')
  setOverrides(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetOverridesDto) {
    return this.users.setOverrides(ctx, id, dto.overrides);
  }

  @Put(':id/vessel-scope')
  @RequirePermissions('users.edit')
  setScope(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetVesselScopeDto) {
    return this.users.setVesselScope(ctx, id, dto);
  }

  @Put(':id/departments')
  @RequirePermissions('users.edit')
  setDepartments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetDepartmentsDto) {
    return this.users.setDepartments(ctx, id, dto);
  }

  @Put(':id/member')
  @RequirePermissions('members.link_user')
  linkMember(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkMemberDto) {
    return this.users.linkMember(ctx, id, dto.memberId);
  }

  @Post(':id/deactivate')
  @RequirePermissions('users.deactivate')
  deactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.users.setActive(ctx, id, false, dto.reason);
  }

  @Post(':id/reactivate')
  @RequirePermissions('users.deactivate')
  reactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.users.setActive(ctx, id, true, dto.reason);
  }

  @Post(':id/unlock')
  @RequirePermissions('users.unlock')
  unlock(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.unlock(ctx, id);
  }

  @Post(':id/reset-password')
  @RequirePermissions('users.reset_password')
  resetPassword(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resetPassword(ctx, id);
  }

  @Get(':id/sessions')
  @RequirePermissions('sessions.view')
  sessions(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.listSessions(id);
  }

  @Delete(':id/sessions/:sessionId')
  @RequirePermissions('sessions.revoke')
  revokeSession(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sessionId') sessionId: string) {
    if (sessionId !== 'all' && !/^[0-9a-f-]{36}$/.test(sessionId)) throw Errors.validation('sessionId invalide');
    return this.users.revokeSession(ctx, id, sessionId);
  }
}

@ApiTags('Admin — Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.view')
  list() {
    return this.roles.list();
  }

  @Post()
  @RequirePermissions('roles.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateRoleDto) {
    return this.roles.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('roles.manage')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.roles.remove(ctx, id);
  }
}

@ApiTags('Admin — Permissions')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  /** Registre des permissions (matrice RBAC). */
  @Get()
  @RequireAnyPermission('roles.view', 'permissions.manage', 'users.view')
  catalog() {
    return this.roles.permissionsCatalog();
  }
}

@ApiTags('Admin — Departments')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequireAnyPermission('departments.view', 'departments.manage', 'users.view')
  list() {
    return this.departments.list();
  }

  @Get(':id/members')
  @RequireAnyPermission('departments.view', 'departments.manage', 'users.view')
  members(@Param('id', ParseUUIDPipe) id: string) {
    return this.departments.members(id);
  }

  @Post()
  @RequirePermissions('departments.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('departments.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepartmentDto) {
    return this.departments.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermissions('departments.manage')
  deactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.departments.setStatus(ctx, id, false);
  }

  @Post(':id/reactivate')
  @RequirePermissions('departments.manage')
  reactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.departments.setStatus(ctx, id, true);
  }
}

@ApiTags('Admin — Settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings.manage')
  all() {
    return this.settings.all();
  }

  @Patch(':key')
  @RequirePermissions('settings.manage')
  async update(@Auth() ctx: AuthContext, @Param('key') key: string, @Body() dto: UpdateSettingDto) {
    if (!(key in SETTINGS_SCHEMAS)) throw Errors.notFound('Paramètre');
    const before = await this.settings.get(key as SettingKey);
    const value = await this.settings.set(key as SettingKey, dto.value, ctx.userId);
    await this.audit.record(ctx, { action: 'settings.updated', module: 'admin', entityType: 'setting', entityId: key, before: { value: before }, after: { value } });
    return { key, value };
  }
}
