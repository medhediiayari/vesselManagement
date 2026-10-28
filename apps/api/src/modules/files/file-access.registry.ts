import { Injectable } from '@nestjs/common';
import type { StoredFile } from '@prisma/client';
import type { AuthContext } from '../access/auth-context';
import type { AuditModule } from '../audit/audit.service';

export type FileAccessMode = 'meta' | 'preview' | 'thumbnail' | 'download';

export interface FileAccessGrant {
  module: AuditModule;
  entityType: string;
  entityId: string;
  vesselId?: string | null;
  /** Forcer le téléchargement même en preview (ex. Excel non affichable) */
  forceAttachment?: boolean;
  /** Nom de fichier proposé au navigateur (ex. "BC-ISK-2026-0001.pdf") */
  downloadName?: string;
}

/**
 * Résout l'autorisation d'accès à un fichier à partir de son propriétaire logique
 * (pièce de certificat, version CSO, BL…). Chaque module métier enregistre son resolver ;
 * le resolver DOIT lever une erreur (403/404) si l'accès est refusé.
 * L'API de téléchargement n'accepte jamais de bucket ni de clé objet (CDC §11.1).
 */
export type FileAccessResolver = (ctx: AuthContext, file: StoredFile, mode: FileAccessMode) => Promise<FileAccessGrant>;

@Injectable()
export class FileAccessRegistry {
  private readonly resolvers = new Map<string, FileAccessResolver>();

  register(ownerType: string, resolver: FileAccessResolver): void {
    if (this.resolvers.has(ownerType)) throw new Error(`Resolver déjà enregistré pour ${ownerType}`);
    this.resolvers.set(ownerType, resolver);
  }

  get(ownerType: string): FileAccessResolver | undefined {
    return this.resolvers.get(ownerType);
  }

  registeredTypes(): string[] {
    return [...this.resolvers.keys()];
  }
}
