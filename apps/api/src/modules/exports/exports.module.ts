import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/** Exports CSV/XLSX transverses (certificats, navires, audit). ZIP CSO : module cso. */
@Module({
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
