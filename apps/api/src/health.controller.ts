import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { env } from './config/env';
import { Public } from './common/decorators';
import { PrismaService } from './prisma/prisma.service';
import { StorageService } from './modules/files/storage.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Liveness + dépendances (PostgreSQL, MinIO). Ne divulgue aucun secret. */
  @Public()
  @Get()
  async health() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }
    try {
      await this.storage.ping();
      checks.objectStorage = 'up';
    } catch {
      checks.objectStorage = 'down';
    }
    checks.antivirus = env().AV_MODE;
    checks.email = env().EMAIL_MODE;
    checks.fileDelivery = env().FILE_DELIVERY_MODE;
    const ok = checks.database === 'up' && checks.objectStorage === 'up';
    return { status: ok ? 'ok' : 'degraded', checks, time: new Date().toISOString() };
  }
}
