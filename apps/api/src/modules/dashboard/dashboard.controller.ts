import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { DashboardService } from './dashboard.service';
import { SearchService } from './search.service';

const VesselIdsQuery = z.object({
  vesselIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)))
    .pipe(z.array(z.string().uuid()).max(200)),
});

const SearchQuery = z.object({ q: z.string().trim().min(2).max(100) });

@ApiTags('Dashboard & recherche')
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly search: SearchService,
  ) {}

  /** GET /dashboard?vesselIds=a,b — KPIs filtrés par permissions et scope navire. */
  @Get('dashboard')
  @RequirePermissions('dashboard.view')
  overview(@Auth() ctx: AuthContext, @Query() q: Record<string, unknown>) {
    const { vesselIds } = VesselIdsQuery.parse(q);
    return this.dashboard.overview(ctx, vesselIds);
  }

  /** GET /search?q= — recherche globale ; chaque catégorie filtrée par droits AVANT réponse. */
  @Get('search')
  globalSearch(@Auth() ctx: AuthContext, @Query() q: Record<string, unknown>) {
    return this.search.search(ctx, SearchQuery.parse(q).q);
  }
}
