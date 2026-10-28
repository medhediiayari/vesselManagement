import { Module } from '@nestjs/common';
import { CsoModule } from '../cso/cso.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SearchService } from './search.service';

@Module({
  imports: [CsoModule],
  controllers: [DashboardController],
  providers: [DashboardService, SearchService],
})
export class DashboardModule {}
