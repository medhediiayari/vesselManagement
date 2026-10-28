import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../../common/decorators';
import { PaginationSchema, queryBool } from '../../common/pagination';
import type { AuthContext } from '../access/auth-context';
import { NotificationsService } from './notifications.service';

class ListNotificationsQuery extends createZodDto(PaginationSchema.extend({ unread: queryBool })) {}
class MarkReadDto extends createZodDto(z.object({ read: z.boolean().default(true) })) {}

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Auth() ctx: AuthContext, @Query() q: ListNotificationsQuery) {
    return this.notifications.list(ctx, { unreadOnly: q.unread, limit: q.limit, cursor: q.cursor });
  }

  @Get('unread-count')
  unread(@Auth() ctx: AuthContext) {
    return this.notifications.unreadCount(ctx);
  }

  @Patch(':id')
  mark(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(ctx, id, dto.read);
  }

  @Post('read-all')
  readAll(@Auth() ctx: AuthContext) {
    return this.notifications.markAllRead(ctx);
  }
}
