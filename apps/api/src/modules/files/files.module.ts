import { Global, Module } from '@nestjs/common';
import { env } from '../../config/env';
import { AntivirusService } from './antivirus.service';
import { FileAccessRegistry } from './file-access.registry';
import { FilesController } from './files.controller';
import { FilesProcessor } from './files.processor';
import { FilesService } from './files.service';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    StorageService,
    AntivirusService,
    MediaService,
    FileAccessRegistry,
    FilesService,
    ...(env().WORKERS_ENABLED ? [FilesProcessor] : []),
  ],
  exports: [StorageService, FilesService, FileAccessRegistry, MediaService],
})
export class FilesModule {}
