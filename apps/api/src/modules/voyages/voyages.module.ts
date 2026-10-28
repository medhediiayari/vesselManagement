import { Module } from '@nestjs/common';
import { CharterPartiesController } from './charter-parties.controller';
import { CharterPartiesService } from './charter-parties.service';
import { VoyageInstructionsController } from './voyage-instructions.controller';
import { VoyageInstructionsService } from './voyage-instructions.service';
import { VoyageItineraryService } from './voyage-itinerary.service';
import { VoyageOpsController } from './voyage-ops.controller';
import { VoyageOpsService } from './voyage-ops.service';
import { VoyagesController } from './voyages.controller';
import { VoyagesService } from './voyages.service';

/**
 * Voyages, Charter Party, escales, instructions, notices & NOR (CDC §7, V1 §10).
 * Services transverses (accès, audit, fichiers, PDF, notifications, planificateur) : modules globaux.
 */
@Module({
  controllers: [VoyagesController, VoyageOpsController, VoyageInstructionsController, CharterPartiesController],
  providers: [VoyagesService, VoyageItineraryService, VoyageOpsService, VoyageInstructionsService, CharterPartiesService],
  exports: [VoyagesService],
})
export class VoyagesModule {}
