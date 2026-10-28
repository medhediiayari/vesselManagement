import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  DepartmentsController,
  PermissionsController,
  RolesController,
  SettingsController,
  UsersController,
} from './admin.controller';
import { DepartmentsService } from './departments.service';
import { ReferenceController } from './reference.controller';
import { RolesService } from './roles.service';
import { SystemController } from './system.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, RolesController, PermissionsController, DepartmentsController, SettingsController, SystemController, ReferenceController],
  providers: [UsersService, RolesService, DepartmentsService],
  exports: [UsersService],
})
export class AdminModule {}
