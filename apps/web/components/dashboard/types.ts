import type { HorizonItem } from '@/components/amc/expiry-horizon';

/** Réponse de GET /dashboard : chaque bloc n'est présent qu'avec la permission du module (scope navire appliqué). */
export interface DashboardData {
  generatedAt: string;
  certificates?: {
    expired: number;
    expiringWithin30: number;
    expiring31to60: number;
    expiring61to90: number;
    /** Partition selon les statuts de validité de l'explorateur (seuil `expiringSoonDays`) */
    validity: { valid: number; expiringSoon: number; expired: number; unlimited: number; expiryUnknown: number };
    expiringSoonDays: number;
    documentMissing: number;
    expiryUnknown: number;
    renewalInProgress: number;
    pendingApprovals: number;
    horizon: HorizonItem[];
  };
  approvals: Partial<Record<'certificates' | 'csoDocuments' | 'purchaseRequests' | 'purchaseOrders' | 'charterParties', number>>;
  purchasing?: {
    purchaseRequestsByStatus: Record<string, number>;
    overduePurchaseRequests: number;
    lateOrders: number;
    partiallyReceivedOrders: number;
    openVariances: number;
    recentPurchaseRequests: RecentPurchaseRequest[];
  };
  voyages?: {
    active: ActiveVoyage[];
    planned: number;
    completedLast90Days: number;
    noonReportsMissing: number;
  };
  cso?: {
    published: number;
    pendingApproval: number;
    draft: number;
    reviewDue: number;
    expired: number;
    truncated: boolean;
    recent: RecentCsoDocument[];
  };
  myTasks: { certificateRenewals: number; voyageTasks: number; returnedCertificateRequests: number };
}

export interface RecentPurchaseRequest {
  id: string;
  number: string;
  subject: string;
  status: string;
  priority: string;
  neededBy: string | null;
  createdAt: string;
  vessel: { id: string; code: string; name: string };
  lineCount: number;
  overdue: boolean;
}

export interface ActiveVoyage {
  id: string;
  reference: string;
  charterer: string | null;
  eta: string | null;
  vessel: { id: string; code: string; name: string };
  departurePort: string | null;
  arrivalPort: string | null;
  /** Escale en cours : ATA constatée sans ATD */
  alongsidePort: string | null;
  nextPort: { name: string; eta: string | null } | null;
  lastNoonReportAt: string | null;
  noonReportMissing: boolean | null;
}

export interface RecentCsoDocument {
  id: string;
  reference: string | null;
  title: string;
  status: 'DRAFT' | 'PUBLISHED';
  pendingApproval: boolean;
  category: { id: string; code: string; name: string } | null;
  /** null = bibliothèque centrale AMC */
  vessel: { id: string; code: string; name: string } | null;
  updatedAt: string;
}

/** Synthèse par navire : `/vessels/:id/workspace` (sections filtrées par permissions côté serveur). */
export interface VesselWorkspace {
  vessel: { id: string; vesselType: string | null; photoFileId: string | null };
  sections: {
    crew?: { onboard: number; planned: number };
    certificates?: { total: number; expired: number; expiringWithin90Days: number; documentMissing: number; expiryUnknown: number; pendingApprovals: number };
    purchasing?: { openPurchaseRequests: number; openOrders: number };
    voyages?: {
      active: { id: string; reference: string; charterer: string | null; eta: string | null } | null;
      lastNoonReport: {
        id: string;
        reportDateUtc: string;
        status: string;
        latitude: string | null;
        longitude: string | null;
        nextPort: string | null;
        etaNextPort: string | null;
      } | null;
    };
  };
}
