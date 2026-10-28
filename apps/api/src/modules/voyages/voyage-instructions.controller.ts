import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CreateInstructionDto, IssueInstructionDto, ListInstructionsQuery, UpdateInstructionDto } from './voyage-instructions.dto';
import { VoyageInstructionsService } from './voyage-instructions.service';
import { FileLinkQuerySchema } from './voyages.dto';

/**
 * Voyage Instructions (CDC §11 « POST /voyage-instructions ») : versions, émission (la
 * précédente devient SUPERSEDED), accusé de lecture du Master. Sans instructions.manage,
 * seules les versions émises des navires du périmètre sont visibles.
 */
@ApiTags('Voyages — Instructions')
@Controller('voyage-instructions')
export class VoyageInstructionsController {
  constructor(private readonly instructions: VoyageInstructionsService) {}

  @Get()
  @RequirePermissions('voyages.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListInstructionsQuery) {
    return this.instructions.list(ctx, q);
  }

  @Post()
  @RequirePermissions('voyages.view', 'instructions.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateInstructionDto) {
    return this.instructions.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('voyages.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.instructions.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('voyages.view', 'instructions.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInstructionDto) {
    return this.instructions.update(ctx, id, dto);
  }

  @Post(':id/issue')
  @RequirePermissions('voyages.view', 'instructions.manage')
  issue(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueInstructionDto) {
    return this.instructions.issue(ctx, id, dto);
  }

  /** Accusé de lecture (Master) de la version émise en vigueur. */
  @Post(':id/acknowledge')
  @RequirePermissions('voyages.view')
  acknowledge(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.instructions.acknowledge(ctx, id);
  }

  @Get(':id/acknowledgements')
  @RequirePermissions('voyages.view')
  acknowledgements(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.instructions.listAcknowledgements(ctx, id);
  }

  @Get(':id/file')
  @RequirePermissions('voyages.view')
  file(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { mode } = FileLinkQuerySchema.parse(q ?? {});
    return this.instructions.fileLink(ctx, id, mode);
  }
}
