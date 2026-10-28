import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, StoredFile } from '@prisma/client';
import { AppError, Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { FileAccessGrant, FileAccessMode, FileAccessRegistry } from '../files/file-access.registry';
import { FilesService } from '../files/files.service';
import { CertificateAccessService, actorOf } from './certificate-access.service';
import { AttachmentRights, attachmentRights, safeDownloadName } from './certificate.logic';

/** Type propriétaire des fichiers rattachés à une pièce de certificat (files.owner_type). */
export const OWNER_CERTIFICATE_ATTACHMENT = 'certificate_attachment';

const ATTACHMENT_INCLUDE = {
  certificate: {
    select: {
      id: true,
      subjectKind: true,
      vesselId: true,
      memberId: true,
      currentRevisionId: true,
      type: { select: { code: true, validators: { select: { principalType: true, principalId: true } } } },
    },
  },
  revision: { select: { revisionNo: true, certificateNumber: true } },
} satisfies Prisma.CertificateAttachmentInclude;

type AttachmentRow = Prisma.CertificateAttachmentGetPayload<{ include: typeof ATTACHMENT_INCLUDE }>;

/**
 * Accès aux documents de certificats (ADM-068/069, CERT-05/06/07/08) :
 *  - View : aperçu inline (jamais d'URL « attachment » pour un utilisateur sans droit de téléchargement) ;
 *  - Download current : `certificates.download_current` ;
 *  - Download archived : `certificates.download_archived`, jamais impliqué par le précédent ;
 *  - pièce en attente : déposant, demandeur et validateurs éligibles uniquement.
 * Les droits (permission + scope navire / ADM-070) sont revérifiés à CHAQUE demande de lien,
 * y compris via les routes génériques /files/:id/* (resolver enregistré au démarrage).
 */
@Injectable()
export class CertificateFilesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly certAccess: CertificateAccessService,
  ) {}

  onModuleInit(): void {
    this.registry.register(OWNER_CERTIFICATE_ATTACHMENT, async (ctx, file, mode) => {
      if (!file.ownerId) throw Errors.notFound('Fichier');
      const att = await this.loadAttachment(file.ownerId);
      if (!att || att.fileId !== file.id) throw Errors.notFound('Pièce jointe');
      return this.authorize(ctx, att, file, mode);
    });
  }

  /** GET /certificates/:id/preview|download — document officiel de la révision courante. */
  async currentLink(ctx: AuthContext, certificateId: string, mode: 'preview' | 'download') {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      select: { id: true, subjectKind: true, vesselId: true, memberId: true, currentRevisionId: true },
    });
    if (!cert) throw Errors.notFound('Certificat');
    await this.certAccess.assertVisible(ctx, cert);
    const official = cert.currentRevisionId
      ? await this.prisma.certificateAttachment.findFirst({
          where: { certificateId, revisionId: cert.currentRevisionId, status: 'OFFICIAL' },
          select: { id: true },
        })
      : null;
    // Une pièce en attente n'est jamais servie comme document officiel (CERT-05)
    if (!official) throw Errors.notFound('Document officiel (Document Missing)');
    return this.attachmentLink(ctx, certificateId, official.id, mode);
  }

  /** GET /certificates/:id/attachments/:attachmentId/preview|download */
  async attachmentLink(ctx: AuthContext, certificateId: string, attachmentId: string, mode: 'preview' | 'download') {
    const att = await this.loadAttachment(attachmentId);
    if (!att || att.certificateId !== certificateId) throw Errors.notFound('Pièce jointe');
    const file = await this.files.getOrThrow(att.fileId);
    const grant = await this.authorize(ctx, att, file, mode);
    return this.files.issueLink(ctx, file, mode, grant);
  }

  private loadAttachment(id: string) {
    return this.prisma.certificateAttachment.findUnique({ where: { id }, include: ATTACHMENT_INCLUDE });
  }

  /** Demande à laquelle une pièce proposée appartient (version de données ou demande ATTACHMENT). */
  private async requestOfFile(fileId: string) {
    const v = await this.prisma.certificateRequestVersion.findFirst({
      where: { fileId },
      orderBy: { createdAt: 'desc' },
      select: { request: { select: { kind: true, requestedById: true, status: true } } },
    });
    return v?.request ?? null;
  }

  private async authorize(ctx: AuthContext, att: AttachmentRow, file: StoredFile, mode: FileAccessMode): Promise<FileAccessGrant> {
    const cert = att.certificate;
    await this.certAccess.assertVisible(ctx, cert);
    const workflow = att.status === 'PENDING_APPROVAL' || att.status === 'REJECTED';
    const rights = attachmentRights(actorOf(ctx), {
      status: att.status,
      isCurrentOfficial: att.status === 'OFFICIAL' && !!att.revisionId && att.revisionId === cert.currentRevisionId,
      uploadedById: att.uploadedById,
      request: workflow ? await this.requestOfFile(att.fileId) : null,
      validators: cert.type.validators,
      previewable: file.kind === 'PDF' || file.kind === 'IMAGE',
    });
    const download = mode === 'download';
    if (!(download ? rights.download : rights.preview)) throw this.denied(rights, download);
    return {
      module: 'certificates',
      entityType: 'certificate_attachment',
      entityId: att.id,
      vesselId: cert.vesselId,
      downloadName: safeDownloadName(
        [cert.type.code, att.revision?.certificateNumber ?? (att.revision ? `rev${att.revision.revisionNo}` : 'piece-en-attente')],
        file.extension,
      ),
    };
  }

  private denied(rights: AttachmentRights, download: boolean): AppError {
    if (rights.scope === 'WORKFLOW' && !rights.preview) {
      return Errors.forbidden('Pièce en attente de validation : réservée au demandeur et aux validateurs éligibles (CERT-05)');
    }
    if (!download) return Errors.forbidden('Aperçu impossible pour ce format : un droit de téléchargement est requis');
    if (rights.scope === 'CURRENT') {
      return Errors.forbidden('Permission requise : certificates.download_current (CERT-06)', { permission: 'certificates.download_current' });
    }
    if (rights.scope === 'ARCHIVED') {
      return Errors.forbidden(
        'Permission requise : certificates.download_archived — distincte du téléchargement du document courant (CERT-07)',
        { permission: 'certificates.download_archived' },
      );
    }
    return Errors.forbidden('Téléchargement d’une pièce en attente réservé à son déposant et aux validateurs habilités au téléchargement');
  }
}
