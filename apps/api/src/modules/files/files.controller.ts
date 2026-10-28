import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { FileContext } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { Auth, Public } from '../../common/decorators';
import { Errors } from '../../common/errors';
import { queryBool } from '../../common/pagination';
import type { AuthContext } from '../access/auth-context';
import { FilesService, toFileDto } from './files.service';

const UploadBodySchema = z.object({
  context: z.nativeEnum(FileContext),
  vesselId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
});

const LinkQuerySchema = z.object({ redirect: queryBool });

@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * POST /files — dépôt multipart (champ `file`) : PDF, Excel, images, Word, ZIP selon contexte.
   * Retourne l'identifiant logique à transmettre à l'objet métier (certificat, BL, CSO…).
   */
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'context'],
      properties: {
        file: { type: 'string', format: 'binary' },
        context: { type: 'string', enum: Object.values(FileContext) },
        vesselId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: env().UPLOAD_MAX_BYTES, files: 1 } }))
  async upload(@Auth() ctx: AuthContext, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown) {
    if (!file) throw Errors.validation('Champ "file" manquant');
    const parsed = UploadBodySchema.safeParse(body);
    if (!parsed.success) throw parsed.error;
    // Multer décode les noms en latin1 : restaurer l'UTF-8 (accents français)
    const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.files.upload(ctx, { buffer: file.buffer, originalname, size: file.size }, parsed.data.context, parsed.data.vesselId);
  }

  /** Dépôts en attente de rattachement de l'utilisateur courant. */
  @Get('pending')
  pending(@Auth() ctx: AuthContext) {
    return this.files.listPendingUploads(ctx);
  }

  @Get(':id')
  async meta(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const file = await this.files.getOrThrow(id);
    await this.files.authorize(ctx, file, 'meta');
    return toFileDto(file);
  }

  /** GET /files/:id/preview — lien signé éphémère (inline pour PDF/images). ?redirect=true => 302. */
  @Get(':id/preview')
  async preview(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.files.issueLink(ctx, id, 'preview'), q, res);
  }

  /** GET /files/:id/download — droit de téléchargement distinct du droit de consultation. */
  @Get(':id/download')
  async download(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.files.issueLink(ctx, id, 'download'), q, res);
  }

  @Get(':id/thumbnail')
  async thumbnail(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return this.respond(await this.files.issueLink(ctx, id, 'thumbnail'), q, res);
  }

  /** Mode proxy uniquement : flux servi par l'API à partir d'un jeton HMAC de 60 s. */
  @Public()
  @Get('stream/:token')
  async stream(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    if (env().FILE_DELIVERY_MODE !== 'proxy') throw Errors.notFound('Route');
    const s = await this.files.openProxyStream(token);
    res.setHeader('Content-Type', s.contentType);
    res.setHeader('Content-Disposition', s.disposition);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (s.contentLength) res.setHeader('Content-Length', String(s.contentLength));
    return new StreamableFile(s.stream);
  }

  private respond(link: Awaited<ReturnType<FilesService['issueLink']>>, q: unknown, res: Response) {
    const { redirect } = LinkQuerySchema.parse(q ?? {});
    res.setHeader('Cache-Control', 'no-store');
    if (redirect) {
      res.redirect(302, link.url);
      return;
    }
    return link;
  }
}
