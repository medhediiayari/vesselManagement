import { Module } from '@nestjs/common';
import { NoonController } from './noon.controller';
import { NoonService } from './noon.service';

/**
 * Noon Reports — formulaire AMC en 7 sections (CDC §8, V1 §11).
 * Accès, audit, fichiers, PDF et notifications : modules globaux.
 */
@Module({
  controllers: [NoonController],
  providers: [NoonService],
  exports: [NoonService],
})
export class NoonModule {}
