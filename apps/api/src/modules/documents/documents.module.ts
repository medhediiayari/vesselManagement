import { Global, Module } from '@nestjs/common';
import { ExcelService } from './excel.service';
import { NumberingService } from './numbering.service';
import { PdfService } from './pdf.service';

/** Services transverses de production documentaire (PDF, Excel/CSV, numérotation). */
@Global()
@Module({
  providers: [PdfService, ExcelService, NumberingService],
  exports: [PdfService, ExcelService, NumberingService],
})
export class DocumentsModule {}
