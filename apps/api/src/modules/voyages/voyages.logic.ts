/**
 * Règles pures du domaine Voyages / Charter Party (CDC §7, V1 §10) — sans accès base,
 * testées unitairement (voyages.logic.spec.ts).
 */
import { Prisma } from '@prisma/client';
import type { CpStatus, CpVersionKind, NoticeStatus, VoyageStatus, ApprovalStatus } from '@prisma/client';

// -----------------------------------------------------------------------------
// Automate Voyage (CDC §12) : DRAFT → PLANNED → ACTIVE → COMPLETED ; DRAFT/PLANNED → CANCELLED
// -----------------------------------------------------------------------------

export const VOYAGE_TRANSITIONS: Record<VoyageStatus, VoyageStatus[]> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export type VoyageCommand = 'plan' | 'activate' | 'complete' | 'cancel';

/** Commande métier -> état cible, permission requise et action d'audit. */
export const VOYAGE_COMMANDS: Record<VoyageCommand, { to: VoyageStatus; permission: string; action: string; label: string }> = {
  plan: { to: 'PLANNED', permission: 'voyages.activate', action: 'voyage.planned', label: 'Voyage planifié' },
  activate: { to: 'ACTIVE', permission: 'voyages.activate', action: 'voyage.activated', label: 'Voyage activé' },
  complete: { to: 'COMPLETED', permission: 'voyages.close', action: 'voyage.completed', label: 'Voyage clôturé' },
  cancel: { to: 'CANCELLED', permission: 'voyages.close', action: 'voyage.cancelled', label: 'Voyage annulé' },
};

export function canTransitionVoyage(from: VoyageStatus, to: VoyageStatus): boolean {
  return VOYAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Voyage clôturé (COMPLETED / CANCELLED) : plus aucune modification opérationnelle. */
export function isVoyageClosed(status: VoyageStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

// -----------------------------------------------------------------------------
// Rattachement Charter Party (CDC §7.2) : obligatoire pour quitter DRAFT lorsqu'une CP
// existe pour le voyage, jamais exigé en DRAFT.
// -----------------------------------------------------------------------------

export interface CpCandidate {
  id: string;
  reference: string;
  vesselId: string | null;
  charterer: string | null;
  laycanFrom: Date | null;
  laycanTo: Date | null;
  status: CpStatus;
  /** Voyages déjà rattachés à cette CP */
  linkedVoyageIds: string[];
}

export interface VoyageForCp {
  id: string;
  vesselId: string;
  charterer: string | null;
  laycanFrom: Date | null;
  laycanTo: Date | null;
}

const ACTIVE_CP_STATUSES: CpStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

export function normalizeParty(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toUpperCase();
}

function rangesOverlap(aFrom: Date | null, aTo: Date | null, bFrom: Date | null, bTo: Date | null): boolean {
  if (!(aFrom || aTo) || !(bFrom || bTo)) return false;
  const a0 = (aFrom ?? aTo)!.getTime();
  const a1 = (aTo ?? aFrom)!.getTime();
  const b0 = (bFrom ?? bTo)!.getTime();
  const b1 = (bTo ?? bFrom)!.getTime();
  return a0 <= b1 && b0 <= a1;
}

/**
 * CP « existant pour le voyage » : même navire, CP active (non annulée / remplacée), non encore
 * rattachée à un autre voyage, et même affréteur ou laycan qui se recoupe. Sans donnée
 * explicite (ni affréteur ni laycan des deux côtés) on ne présume aucun lien (CDC §8.1 :
 * ne pas lier sans donnée explicite).
 */
export function charterPartyCandidates(voyage: VoyageForCp, cps: CpCandidate[]): CpCandidate[] {
  return cps.filter((cp) => {
    if (cp.vesselId !== voyage.vesselId) return false;
    if (!ACTIVE_CP_STATUSES.includes(cp.status)) return false;
    if (cp.linkedVoyageIds.some((v) => v !== voyage.id)) return false;
    const sameCharterer = !!voyage.charterer && !!cp.charterer && normalizeParty(voyage.charterer) === normalizeParty(cp.charterer);
    const laycanOverlap = rangesOverlap(voyage.laycanFrom, voyage.laycanTo, cp.laycanFrom, cp.laycanTo);
    return sameCharterer || laycanOverlap;
  });
}

export type CpRequirementResult =
  | { ok: true }
  | { ok: false; code: 'CP_NOT_LINKED'; candidateIds: string[] }
  | { ok: false; code: 'CP_CANCELLED' };

/** Contrôle exécuté à la sortie de DRAFT (commande plan) et à l'activation. */
export function checkCharterPartyRequirement(
  linkedCp: { status: CpStatus } | null,
  candidates: CpCandidate[],
): CpRequirementResult {
  if (linkedCp) {
    return linkedCp.status === 'CANCELLED' || linkedCp.status === 'SUPERSEDED' ? { ok: false, code: 'CP_CANCELLED' } : { ok: true };
  }
  if (candidates.length) return { ok: false, code: 'CP_NOT_LINKED', candidateIds: candidates.map((c) => c.id) };
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Versions de Charter Party : approbation par un autre utilisateur ; l'ancienne version
// approuvée reste opposable jusqu'à l'approbation de la nouvelle (CDC §7.2, §12).
// -----------------------------------------------------------------------------

export interface CpVersionState {
  id: string;
  versionNo: number;
  kind: CpVersionKind;
  status: ApprovalStatus;
  supersededAt: Date | null;
  submittedById: string;
}

/** Version opposable = APPROVED non remplacée (index partiel cp_versions_one_current). */
export function opposableVersion<T extends CpVersionState>(versions: T[]): T | null {
  return versions.find((v) => v.status === 'APPROVED' && !v.supersededAt) ?? null;
}

export function pendingVersion<T extends CpVersionState>(versions: T[]): T | null {
  return versions.find((v) => v.status === 'PENDING_APPROVAL') ?? null;
}

/**
 * Nature autorisée d'une nouvelle version : ORIGINAL tant qu'aucune version n'a été approuvée,
 * ADDENDUM / REVISION ensuite. Une seule version en attente à la fois.
 * Retourne un message d'erreur (FR) ou null.
 */
export function validateNewCpVersion(versions: CpVersionState[], kind: CpVersionKind): string | null {
  if (pendingVersion(versions)) return 'Une version est déjà en attente d’approbation';
  const hasApproved = versions.some((v) => v.status === 'APPROVED');
  if (!hasApproved && kind !== 'ORIGINAL') return 'La première version officielle doit être de nature ORIGINAL';
  if (hasApproved && kind === 'ORIGINAL') return 'Une version ORIGINAL existe déjà : soumettre un ADDENDUM ou une REVISION';
  return null;
}

export type CpApprovalPlan =
  | { ok: true; supersedeIds: string[]; newCurrentId: string }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'SELF_APPROVAL' };

/**
 * Plan de bascule d'une approbation, à appliquer DANS CET ORDRE dans une seule transaction :
 * 1) superseded_at sur l'ancienne version opposable, 2) statut APPROVED de la nouvelle,
 * 3) charter_parties.current_version_id -> nouvelle version.
 */
export function planCpApproval(versions: CpVersionState[], versionId: string, approverId: string): CpApprovalPlan {
  const target = versions.find((v) => v.id === versionId);
  if (!target) return { ok: false, reason: 'NOT_FOUND' };
  if (target.status !== 'PENDING_APPROVAL') return { ok: false, reason: 'NOT_PENDING' };
  if (target.submittedById === approverId) return { ok: false, reason: 'SELF_APPROVAL' };
  const supersedeIds = versions.filter((v) => v.id !== versionId && v.status === 'APPROVED' && !v.supersededAt).map((v) => v.id);
  return { ok: true, supersedeIds, newCurrentId: versionId };
}

/** Champs contractuels d'une CP figés dans chaque version (texte contrôlé, jamais interprété). */
export const CP_CONTRACT_FIELDS = [
  'cpType',
  'cpDate',
  'charterer',
  'owner',
  'broker',
  'signatories',
  'laycanFrom',
  'laycanTo',
  'loadPorts',
  'dischargePorts',
  'cargoDescription',
  'norClause',
  'laytimeClause',
  'freightTerms',
  'demurrageTerms',
  'otherClauses',
] as const;
export type CpContractField = (typeof CP_CONTRACT_FIELDS)[number];

const CP_DATE_FIELDS: CpContractField[] = ['cpDate', 'laycanFrom', 'laycanTo'];

/** Sérialise une valeur de clause en JSON (dates en AAAA-MM-JJ). */
function clauseJson(field: CpContractField, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return CP_DATE_FIELDS.includes(field) ? v.toISOString().slice(0, 10) : v.toISOString();
  return String(v);
}

/**
 * Snapshot des clauses d'une version : base (valeurs opposables ou brouillon) + modifications
 * EXPLICITEMENT fournies. Un champ absent de `changes` n'est jamais inventé ni effacé.
 */
export function buildCpClauses(
  base: Partial<Record<CpContractField, unknown>>,
  changes: Partial<Record<CpContractField, unknown>> | undefined,
): Record<CpContractField, string | null> {
  const out = {} as Record<CpContractField, string | null>;
  for (const f of CP_CONTRACT_FIELDS) {
    const v = changes && Object.prototype.hasOwnProperty.call(changes, f) && changes[f] !== undefined ? changes[f] : base[f];
    out[f] = clauseJson(f, v);
  }
  return out;
}

/** Valeurs Prisma à appliquer sur la CP lors de l'approbation d'une version. */
export function clausesToCpData(clauses: Record<string, string | null>): Partial<Record<CpContractField, unknown>> {
  const out: Partial<Record<CpContractField, unknown>> = {};
  for (const f of CP_CONTRACT_FIELDS) {
    const v = clauses[f] ?? null;
    if (f === 'cpType' && v === null) continue; // colonne obligatoire : jamais effacée
    out[f] = v !== null && CP_DATE_FIELDS.includes(f) ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : v;
  }
  return out;
}

/** Champs modifiés entre deux snapshots de clauses. */
export function diffClauses(a: Record<string, string | null> | null, b: Record<string, string | null>): CpContractField[] {
  return CP_CONTRACT_FIELDS.filter((f) => (a?.[f] ?? null) !== (b[f] ?? null));
}

// -----------------------------------------------------------------------------
// Notices d'arrivée (CDC §7.4) : brouillon → validation humaine → marquage SENT manuel
// -----------------------------------------------------------------------------

export const NOTICE_TRANSITIONS: Record<NoticeStatus, NoticeStatus[]> = {
  PLANNED: ['DRAFTED', 'CANCELLED'],
  // DRAFTED -> DRAFTED : régénération / édition du brouillon ; -> PLANNED si le texte est effacé
  DRAFTED: ['PLANNED', 'DRAFTED', 'VALIDATED', 'CANCELLED'],
  // Une modification après validation invalide la validation (retour DRAFTED)
  VALIDATED: ['DRAFTED', 'SENT', 'CANCELLED'],
  SENT: [],
  CANCELLED: [],
};

export function canTransitionNotice(from: NoticeStatus, to: NoticeStatus): boolean {
  return NOTICE_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface NoticeDraftInput {
  vesselName: string;
  vesselImo: string | null;
  voyageReference: string;
  charterer: string | null;
  notice: { kind: string; scheduleLabel: string | null; recipients: string | null };
  port: { portName: string; country: string | null; type: string; eta: Date | null; etd: Date | null; agentName: string | null } | null;
  voyageEta: Date | null;
  cargo: { commodity: string; qtyMinMt: string | null; qtyMaxMt: string | null; qtyActualMt: string | null; unit: string }[];
}

const TBC = '[TO BE CONFIRMED]';

function fmtUtc(d: Date | null): string {
  return d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : TBC;
}

/**
 * Brouillon d'e-mail de notice (texte à relire et valider par un humain ; aucun envoi
 * automatique en V1 — CDC §7.4). Les données absentes sont signalées « TO BE CONFIRMED »,
 * jamais inventées.
 */
export function buildNoticeEmailDraft(i: NoticeDraftInput): { subject: string; body: string } {
  const portLabel = i.port ? `${i.port.portName}${i.port.country ? ` (${i.port.country})` : ''}` : TBC;
  const eta = i.port?.eta ?? i.voyageEta;
  const kindLabel = i.notice.scheduleLabel || i.notice.kind.replace(/_/g, ' ');
  const subject = `${i.vesselName} — ${kindLabel} — ${portLabel} — ${i.voyageReference}`;
  const cargoLines = i.cargo.length
    ? i.cargo.map((c) => {
        const qty = c.qtyActualMt
          ? `${c.qtyActualMt} ${c.unit}`
          : c.qtyMinMt || c.qtyMaxMt
            ? `${c.qtyMinMt ?? TBC} – ${c.qtyMaxMt ?? TBC} ${c.unit}`
            : TBC;
        return `  - ${c.commodity}: ${qty}`;
      })
    : [`  - ${TBC}`];
  const lines = [
    'Dear Sirs,',
    '',
    `Please find below the ${kindLabel} for ${i.vesselName}${i.vesselImo ? ` (IMO ${i.vesselImo})` : ''}.`,
    '',
    `Voyage reference : ${i.voyageReference}`,
    `Charterer        : ${i.charterer ?? TBC}`,
    `Port             : ${portLabel}${i.port ? ` — ${i.port.type}` : ''}`,
    `Agent            : ${i.port?.agentName ?? TBC}`,
    `ETA              : ${fmtUtc(eta)}`,
    ...(i.port?.etd ? [`ETD              : ${fmtUtc(i.port.etd)}`] : []),
    'Cargo            :',
    ...cargoLines,
    '',
    'All other terms, conditions and timings as per Charter Party / voyage instructions.',
    '',
    'Best regards,',
    `Master ${i.vesselName}`,
  ];
  return { subject, body: lines.join('\n') };
}

// -----------------------------------------------------------------------------
// Escales, cargaisons
// -----------------------------------------------------------------------------

/** La nouvelle séquence doit être une permutation exacte des escales du voyage. */
export function validatePortOrder(existingIds: string[], requestedIds: string[]): string | null {
  if (new Set(requestedIds).size !== requestedIds.length) return 'Escale dupliquée dans l’ordre demandé';
  if (requestedIds.length !== existingIds.length) return 'L’ordre doit contenir toutes les escales du voyage';
  const existing = new Set(existingIds);
  if (requestedIds.some((id) => !existing.has(id))) return 'Escale inconnue pour ce voyage';
  return null;
}

/** Cohérence arrivée / départ d'une escale (prévu et réel). */
export function validatePortTimes(t: { eta?: Date | null; etd?: Date | null; ata?: Date | null; atd?: Date | null }): string | null {
  if (t.eta && t.etd && t.eta > t.etd) return 'ETD antérieure à l’ETA';
  if (t.ata && t.atd && t.ata > t.atd) return 'ATD antérieure à l’ATA';
  return null;
}

/** Tolérance sur les dates réelles (fuseaux, saisie à bord en avance d'une veille). */
export const ACTUAL_TIME_TOLERANCE_MS = 24 * 3_600_000;

/** Une date réelle (ATA / ATD) n'est jamais dans le futur, à 24 h près (audit FLT-06). */
export function validateActualTimesNotFuture(t: { ata?: Date | null; atd?: Date | null }, now = new Date()): string | null {
  const limit = now.getTime() + ACTUAL_TIME_TOLERANCE_MS;
  if (t.atd && t.atd.getTime() > limit) return 'ATD dans le futur : une date réelle se saisit une fois le départ effectif';
  if (t.ata && t.ata.getTime() > limit) return 'ATA dans le futur : une date réelle se saisit une fois l’arrivée effective';
  return null;
}

/**
 * Cohérence des dates du voyage (audit FLT-06), sur les valeurs fusionnées en PATCH :
 * départ avant arrivée (prévu et réel). Le contrôle des certificats s'appuie sur ces dates.
 */
export function validateVoyageTimes(t: { etd?: Date | null; eta?: Date | null; atd?: Date | null; ata?: Date | null }): string | null {
  if (t.etd && t.eta && t.etd > t.eta) return 'ETA antérieure à l’ETD : le départ prévu doit précéder l’arrivée prévue';
  if (t.atd && t.ata && t.atd > t.ata) return 'ATA antérieure à l’ATD : le départ réel doit précéder l’arrivée réelle';
  return null;
}

type Dec = string | number | Prisma.Decimal | null | undefined;
const dec = (v: Dec) => (v === null || v === undefined || v === '' ? null : new Prisma.Decimal(v as Prisma.Decimal.Value));

/** Quantités cargaison : min ≤ max, toutes ≥ 0 (calcul décimal exact, jamais float). */
export function validateCargoQuantities(q: { qtyMinMt?: Dec; qtyMaxMt?: Dec; qtyActualMt?: Dec }): string | null {
  const [min, max, actual] = [dec(q.qtyMinMt), dec(q.qtyMaxMt), dec(q.qtyActualMt)];
  for (const v of [min, max, actual]) if (v && v.isNegative()) return 'Les quantités doivent être positives';
  if (min && max && min.greaterThan(max)) return 'Quantité minimale supérieure à la quantité maximale';
  return null;
}

/**
 * Avertissements non bloquants (audit FLT-19) : quantité réelle hors de l'intervalle prévu.
 * L'option (« 10 % MOLOO »…) reste du texte libre : elle est rappelée, jamais interprétée.
 */
export function cargoQuantityWarnings(q: { qtyMinMt?: Dec; qtyMaxMt?: Dec; qtyActualMt?: Dec; quantityOption?: string | null }): string[] {
  const [min, max, actual] = [dec(q.qtyMinMt), dec(q.qtyMaxMt), dec(q.qtyActualMt)];
  if (!actual) return [];
  const option = q.quantityOption ? ` (option : ${q.quantityOption})` : '';
  if (max && actual.greaterThan(max)) return [`Quantité réelle ${actual.toString()} t supérieure au maximum prévu ${max.toString()} t${option} : vérifier la saisie`];
  if (min && actual.lessThan(min)) return [`Quantité réelle ${actual.toString()} t inférieure au minimum prévu ${min.toString()} t${option} : vérifier la saisie`];
  return [];
}

/**
 * Droit de cocher une tâche de checklist (CDC §7.4 « Captain peut cocher l'exécution ») :
 * services terre (voyages.edit), Master (noon.submit = autorité de reporting à bord sur le
 * navire) ou utilisateur désigné responsable de la tâche. Le scope navire est vérifié à part.
 */
export function canCompleteTask(p: { voyagesEdit: boolean; noonSubmit: boolean }, assigneeId: string | null, userId: string): boolean {
  return p.voyagesEdit || p.noonSubmit || (!!assigneeId && assigneeId === userId);
}

// -----------------------------------------------------------------------------
// Contrôle informatif des certificats (CDC §7.4) — jamais un avis de conformité
// -----------------------------------------------------------------------------

export const CERTIFICATE_CHECK_DISCLAIMER =
  'Contrôle informatif : liste les certificats du navire et des marins prévus à bord dont l’échéance courante tombe avant la ' +
  'fin estimée du voyage. Ce n’est pas un avis de conformité réglementaire (CDC §7.4).';

/** Début estimé du voyage : départ réel / estimé, première date d'escale, sinon début de laycan. */
export function voyageStartDate(
  v: { atd: Date | null; etd: Date | null; laycanFrom: Date | null },
  ports: { eta: Date | null; etd: Date | null; ata: Date | null; atd: Date | null }[],
): Date | null {
  if (v.atd) return v.atd;
  if (v.etd) return v.etd;
  const portDates = ports.flatMap((p) => [p.ata, p.eta, p.atd, p.etd]).filter((d): d is Date => !!d);
  if (portDates.length) return new Date(Math.min(...portDates.map((d) => d.getTime())));
  return v.laycanFrom;
}

/**
 * Le marin est-il à bord pendant (une partie) du voyage ? Embarquement réel sinon prévu ; débarquement réel, sinon prévu
 * tant que l'affectation est ouverte. Une affectation terminée sans date de débarquement ne compte pas (même règle que
 * l'équipage à une date, audit FLT-02). Bornes inconnues = période ouverte.
 */
export function assignmentCoversVoyage(
  a: {
    status: 'PLANNED' | 'ONBOARD' | 'COMPLETED' | 'CANCELLED';
    plannedJoinDate: Date | null;
    actualJoinDate: Date | null;
    plannedSignOffDate: Date | null;
    actualSignOffDate: Date | null;
  },
  start: Date | null,
  end: Date | null,
): boolean {
  if (a.status === 'CANCELLED') return false;
  if (a.status === 'COMPLETED' && !a.actualSignOffDate) return false;
  const join = a.actualJoinDate ?? a.plannedJoinDate;
  const leave = a.status === 'COMPLETED' ? a.actualSignOffDate : a.actualSignOffDate ?? a.plannedSignOffDate;
  if (end && join && join > end) return false;
  if (start && leave && leave < startOfUtcDay(start)) return false;
  return true;
}

/** Fin estimée du voyage : arrivée réelle / estimée, dernière date d'escale, sinon fin de laycan. */
export function voyageEndDate(
  v: { ata: Date | null; eta: Date | null; laycanTo: Date | null },
  ports: { eta: Date | null; etd: Date | null; ata: Date | null; atd: Date | null }[],
): Date | null {
  if (v.ata) return v.ata;
  if (v.eta) return v.eta;
  const portDates = ports.flatMap((p) => [p.atd, p.etd, p.ata, p.eta]).filter((d): d is Date => !!d);
  if (portDates.length) return new Date(Math.max(...portDates.map((d) => d.getTime())));
  return v.laycanTo;
}

export type CertificateFlag = 'EXPIRED' | 'EXPIRES_BEFORE_VOYAGE_END' | 'EXPIRY_UNKNOWN';

export function flagCertificate(
  cert: { expiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN' | null; expiryOn: Date | null },
  end: Date | null,
  today: Date,
): CertificateFlag | null {
  if (cert.expiryKind === 'UNLIMITED') return null;
  if (cert.expiryKind !== 'DATED' || !cert.expiryOn) return 'EXPIRY_UNKNOWN';
  if (cert.expiryOn < startOfUtcDay(today)) return 'EXPIRED';
  if (end && cert.expiryOn <= end) return 'EXPIRES_BEFORE_VOYAGE_END';
  return null;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// -----------------------------------------------------------------------------
// Timeline maritime (CDC §7.1)
// -----------------------------------------------------------------------------

export interface TimelineEvent {
  at: Date;
  kind: string;
  label: string;
  actor?: string | null;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

/** Tri chronologique stable + déduplication (même type, même entité, même instant). */
export function sortTimeline(events: (TimelineEvent | null | undefined)[]): TimelineEvent[] {
  const seen = new Set<string>();
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (!e || !(e.at instanceof Date) || Number.isNaN(e.at.getTime())) continue;
    const key = `${e.kind}|${e.entityId ?? ''}|${e.at.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at.getTime() - b.e.at.getTime() || a.i - b.i)
    .map(({ e }) => e);
}

/** Champs de planning repris dans le détail d'un événement « planning mis à jour ». */
export const TIMELINE_SCHEDULE_FIELDS = ['etd', 'eta', 'atd', 'ata', 'laycanFrom', 'laycanTo'] as const;

/** Libellés de la chronologie (audit FLT-15 : « LAYCANFROM » était affiché). */
export const SCHEDULE_FIELD_LABELS: Record<string, string> = {
  etd: 'ETD',
  eta: 'ETA',
  atd: 'ATD',
  ata: 'ATA',
  laycanFrom: 'début de laycan',
  laycanTo: 'fin de laycan',
};

export function scheduleChangeLabel(fields: string[]): string {
  return `Planning mis à jour (${fields.map((f) => SCHEDULE_FIELD_LABELS[f] ?? f).join(', ')})`;
}

export function pickScheduleDetails(after: unknown): Record<string, unknown> | undefined {
  if (!after || typeof after !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const f of TIMELINE_SCHEDULE_FIELDS) if (f in after) out[f] = (after as Record<string, unknown>)[f];
  return Object.keys(out).length ? out : undefined;
}

const CP_DETAIL_KEYS = ['charterPartyId', 'charterPartyLinked', 'charterParty', 'cpVersionId', 'currentVersionId'];

/**
 * Confidentialité CP (CDC §7.2) : pour un utilisateur sans charter_party.view, retire de la
 * timeline tout événement Charter Party et toute référence CP dans les détails.
 */
export function stripCharterPartyReferences(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .filter((e) => !e.kind.includes('charter_party') && e.entityType !== 'cp_version' && e.entityType !== 'charter_party')
    .map((e) => {
      if (!e.details) return e;
      const details = Object.fromEntries(Object.entries(e.details).filter(([k]) => !CP_DETAIL_KEYS.includes(k)));
      return { ...e, details: Object.keys(details).length ? details : undefined };
    });
}

/**
 * Référence de Charter Party (audit FLT-16) : stockée en majuscules, espaces normalisés ;
 * l'unicité se juge sans casse ni espaces (« audit-cp-001 » = « AUDIT-CP-001 »).
 */
export function normalizeCpReference(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function cpReferenceKey(s: string): string {
  return s.toUpperCase().replace(/\s+/g, '');
}

/** Libellés FR des actions d'audit de l'entité voyage reprises dans la timeline. */
export const VOYAGE_AUDIT_LABELS: Record<string, string> = {
  'voyage.created': 'Voyage créé',
  'voyage.updated': 'Voyage modifié',
  'voyage.planned': 'Voyage planifié',
  'voyage.activated': 'Voyage activé',
  'voyage.completed': 'Voyage clôturé',
  'voyage.cancelled': 'Voyage annulé',
  'voyage.charter_party_linked': 'Charter Party rattachée',
};

/** Jour UTC (AAAA-MM-JJ) — clé de déduplication des rappels. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
