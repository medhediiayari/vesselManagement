import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_JOB_OPTIONS, QUEUES } from '../jobs/queues';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  notificationId?: string | null;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

/**
 * E-mails transactionnels journalisés (email_deliveries + events) avec reprises.
 * Ne déclare JAMAIS « envoyé » si le transport échoue (CDC §6.5, §18.2).
 * En développement, SMTP pointe vers Mailpit (aucun envoi externe réel).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');
  private transporter: Transporter | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.EMAIL) private readonly queue: Queue,
  ) {}

  private transport(): Transporter {
    if (!this.transporter) {
      const e = env();
      this.transporter = nodemailer.createTransport({
        host: e.SMTP_HOST,
        port: e.SMTP_PORT,
        secure: e.SMTP_SECURE,
        auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
      });
    }
    return this.transporter;
  }

  /** Enregistre et met en file (envoi asynchrone avec retries). */
  async queueEmail(msg: Omit<EmailMessage, 'attachments'>, db: Db = this.prisma): Promise<string> {
    const delivery = await db.emailDelivery.create({
      data: {
        toAddress: msg.to,
        subject: msg.subject,
        bodyText: msg.text,
        bodyHtml: msg.html ?? null,
        notificationId: msg.notificationId ?? null,
        events: { create: { event: 'QUEUED' } },
      },
    });
    // Mise en file après commit éventuel : l'ID est stable, le worker relit la ligne.
    setImmediate(() => {
      this.queue
        .add('send', { deliveryId: delivery.id }, { ...DEFAULT_JOB_OPTIONS, jobId: delivery.id })
        .catch((e) => this.logger.error(`Mise en file e-mail impossible ${delivery.id}: ${String(e)}`));
    });
    return delivery.id;
  }

  /** Envoi immédiat tracé (ex. lien de réinitialisation, BC avec pièce jointe). */
  async sendNow(msg: EmailMessage): Promise<{ deliveryId: string; status: 'SENT' | 'FAILED' | 'SUPPRESSED'; error?: string }> {
    const delivery = await this.prisma.emailDelivery.create({
      data: {
        toAddress: msg.to,
        subject: msg.subject,
        bodyText: msg.text,
        bodyHtml: msg.html ?? null,
        notificationId: msg.notificationId ?? null,
        events: { create: { event: 'QUEUED' } },
      },
    });
    const result = await this.deliver(delivery.id, msg.attachments);
    return { deliveryId: delivery.id, ...result };
  }

  /** Utilisé par le worker et par sendNow. */
  async deliver(
    deliveryId: string,
    attachments?: EmailMessage['attachments'],
  ): Promise<{ status: 'SENT' | 'FAILED' | 'SUPPRESSED'; error?: string }> {
    const d = await this.prisma.emailDelivery.findUnique({ where: { id: deliveryId } });
    if (!d) return { status: 'FAILED', error: 'delivery introuvable' };
    if (d.status === 'SENT') return { status: 'SENT' };

    if (env().EMAIL_MODE === 'disabled') {
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        data: { status: 'SUPPRESSED', events: { create: { event: 'SUPPRESSED', detail: 'EMAIL_MODE=disabled' } } },
      });
      return { status: 'SUPPRESSED' };
    }

    try {
      const info = await this.transport().sendMail({
        from: env().EMAIL_FROM,
        to: d.toAddress,
        subject: d.subject,
        text: d.bodyText,
        html: d.bodyHtml ?? undefined,
        attachments,
      });
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        data: {
          status: 'SENT',
          attempts: { increment: 1 },
          sentAt: new Date(),
          providerMessageId: info.messageId?.slice(0, 300) ?? null,
          lastError: null,
          events: { create: { event: 'SENT', detail: info.response?.slice(0, 900) } },
        },
      });
      return { status: 'SENT' };
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 900);
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: error,
          events: { create: { event: 'FAILED', detail: error } },
        },
      });
      return { status: 'FAILED', error };
    }
  }
}
