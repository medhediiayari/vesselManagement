import { Module } from '@nestjs/common';
import { CrewAssignmentsController, VesselCrewController } from './crew-assignments.controller';
import { CrewAssignmentsService } from './crew-assignments.service';
import { MemberDuplicatesService } from './member-duplicates.service';
import { MemberFieldsController } from './member-fields.controller';
import { MemberFieldsService } from './member-fields.service';
import { MembersImportController } from './members-import.controller';
import { MembersImportService } from './members-import.service';
import { MemberSelfController, MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * Members & Crew (CDC §3.2, V1 §5) : fiches, libre-service, champs personnalisés, photo /
 * documents, affectations d'équipage et import Excel. Les contrôleurs à préfixe statique
 * (members/me, members/custom-fields, members/import-jobs) sont déclarés avant `members/:id`.
 */
@Module({
  controllers: [
    MemberSelfController,
    MemberFieldsController,
    MembersImportController,
    MembersController,
    CrewAssignmentsController,
    VesselCrewController,
  ],
  providers: [MembersService, MemberFieldsService, MemberDuplicatesService, CrewAssignmentsService, MembersImportService],
  exports: [MembersService, CrewAssignmentsService, MemberDuplicatesService],
})
export class MembersModule {}
