import type { ApprovalStatus } from '@prisma/client';
import {
  Actor,
  EMPTY_CERTIFICATE_DATA,
  REQUEST_TRANSITIONS,
  ReminderPolicyRules,
  ReminderSubject,
  addDays,
  assertTransition,
  attachmentRights,
  canTransition,
  computeValidity,
  daysToExpiry,
  decideApprovalOverdue,
  decideCertificateReminders,
  decisionBlockedBy,
  decisionRequiresComment,
  diffDays,
  isEligibleValidator,
  isRequestSupervisor,
  matchesValidatorPrincipals,
  mergeCertificateData,
  safeDownloadName,
  validateCertificateData,
} from './certificate.logic';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = d('2026-10-11');

describe('computeValidity (CDC §4.3)', () => {
  it('UNLIMITED et UNKNOWN restent distincts (ADM-062)', () => {
    expect(computeValidity('UNLIMITED', null, TODAY, 90)).toBe('UNLIMITED');
    expect(computeValidity('UNKNOWN', null, TODAY, 90)).toBe('EXPIRY_UNKNOWN');
  });

  it('DATED : valide, expire bientôt, expiré', () => {
    expect(computeValidity('DATED', d('2027-03-15'), TODAY, 90)).toBe('VALID');
    expect(computeValidity('DATED', d('2026-11-02'), TODAY, 90)).toBe('EXPIRING_SOON');
    expect(computeValidity('DATED', d('2026-09-30'), TODAY, 90)).toBe('EXPIRED');
  });

  it("le jour d'expiration est encore valide ; expiré dès le lendemain", () => {
    expect(computeValidity('DATED', TODAY, TODAY, 90)).toBe('EXPIRING_SOON');
    expect(computeValidity('DATED', addDays(TODAY, -1), TODAY, 90)).toBe('EXPIRED');
  });

  it('limite exacte de la fenêtre « expire bientôt »', () => {
    expect(computeValidity('DATED', addDays(TODAY, 90), TODAY, 90)).toBe('EXPIRING_SOON');
    expect(computeValidity('DATED', addDays(TODAY, 91), TODAY, 90)).toBe('VALID');
    expect(computeValidity('DATED', addDays(TODAY, 30), TODAY, 30)).toBe('EXPIRING_SOON');
  });

  it("l'heure du jour n'influe pas (dates calendaires UTC)", () => {
    const lateToday = new Date('2026-10-11T23:59:00.000Z');
    expect(computeValidity('DATED', TODAY, lateToday, 90)).toBe('EXPIRING_SOON');
    expect(daysToExpiry('DATED', d('2026-10-21'), lateToday)).toBe(10);
  });

  it('DATED sans date (donnée incohérente) est traitée comme inconnue', () => {
    expect(computeValidity('DATED', null, TODAY, 90)).toBe('EXPIRY_UNKNOWN');
    expect(daysToExpiry('UNKNOWN', null, TODAY)).toBeNull();
  });
});

describe('données de version (ADM-061)', () => {
  it('passer à UNKNOWN efface la date', () => {
    const dated = { ...EMPTY_CERTIFICATE_DATA, expiryKind: 'DATED' as const, expiryOn: d('2027-01-01'), issuer: 'X' };
    const merged = mergeCertificateData(dated, { expiryKind: 'UNKNOWN' });
    expect(merged.expiryOn).toBeNull();
    expect(merged.issuer).toBe('X');
  });

  it('null efface, undefined conserve', () => {
    const base = { ...EMPTY_CERTIFICATE_DATA, issuer: 'A', authority: 'B' };
    const merged = mergeCertificateData(base, { issuer: null, authority: undefined });
    expect(merged.issuer).toBeNull();
    expect(merged.authority).toBe('B');
  });

  it('valide la cohérence des dates', () => {
    expect(validateCertificateData({ ...EMPTY_CERTIFICATE_DATA, expiryKind: 'DATED' })).toHaveLength(1);
    expect(validateCertificateData({ ...EMPTY_CERTIFICATE_DATA, expiryKind: 'UNLIMITED', expiryOn: TODAY })).toHaveLength(1);
    expect(
      validateCertificateData({
        ...EMPTY_CERTIFICATE_DATA,
        expiryKind: 'DATED',
        expiryOn: d('2026-01-01'),
        issuedOn: d('2026-02-01'),
      }).map((i) => i.path),
    ).toEqual(['issuedOn']);
    expect(validateCertificateData({ ...EMPTY_CERTIFICATE_DATA, expiryKind: 'UNKNOWN' })).toEqual([]);
  });
});

describe('automate des demandes (CDC §12)', () => {
  it('DRAFT → PENDING → APPROVED | RETURNED | REJECTED | CANCELLED', () => {
    expect(canTransition('DRAFT', 'PENDING_APPROVAL')).toBe(true);
    for (const to of ['APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED'] as ApprovalStatus[]) {
      expect(canTransition('PENDING_APPROVAL', to)).toBe(true);
    }
  });

  it('RETURNED peut être resoumise ou annulée', () => {
    expect(canTransition('RETURNED', 'PENDING_APPROVAL')).toBe(true);
    expect(canTransition('RETURNED', 'CANCELLED')).toBe(true);
    expect(canTransition('RETURNED', 'APPROVED')).toBe(false);
  });

  it('un brouillon ne peut pas être approuvé directement', () => {
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(() => assertTransition('DRAFT', 'APPROVED')).toThrow(/Transition interdite/);
  });

  it('les états finaux sont terminaux', () => {
    for (const s of ['APPROVED', 'REJECTED', 'CANCELLED'] as ApprovalStatus[]) {
      expect(REQUEST_TRANSITIONS[s]).toEqual([]);
    }
  });

  it('commentaire obligatoire pour REJECT / RETURN (ADM-052)', () => {
    expect(decisionRequiresComment('APPROVE')).toBe(false);
    expect(decisionRequiresComment('REJECT')).toBe(true);
    expect(decisionRequiresComment('RETURN')).toBe(true);
  });

  it('CERT-04 : une demande déjà décidée renvoie « déjà traité »', () => {
    expect(decisionBlockedBy('PENDING_APPROVAL')).toBeNull();
    expect(decisionBlockedBy('APPROVED')).toBe('ALREADY_PROCESSED');
    expect(decisionBlockedBy('RETURNED')).toBe('ALREADY_PROCESSED');
    expect(decisionBlockedBy('CANCELLED')).toBe('ALREADY_PROCESSED');
    expect(decisionBlockedBy('DRAFT')).toBe('NOT_SUBMITTED');
  });
});

describe('éligibilité des validateurs (ADM-051, CERT-03)', () => {
  const ROLE_TECH = 'role-tech';
  const actor = (userId: string, perms: string[], roleIds: string[] = []): Actor => ({
    userId,
    permissions: new Set(perms),
    principals: [{ type: 'USER', id: userId }, ...roleIds.map((id) => ({ type: 'ROLE' as const, id }))],
  });
  const validators = [{ principalType: 'ROLE' as const, principalId: ROLE_TECH }];

  it('le demandeur ne peut jamais approuver, même avec toutes les permissions (CERT-03)', () => {
    const superAdmin = actor('u1', ['certificates.approve', 'certificates.attachments.approve'], [ROLE_TECH]);
    expect(isEligibleValidator(superAdmin, { kind: 'CREATE', requestedById: 'u1' }, validators)).toBe(false);
  });

  it('permission + principal configuré requis pour les données', () => {
    expect(isEligibleValidator(actor('u2', ['certificates.approve'], [ROLE_TECH]), { kind: 'RENEWAL', requestedById: 'u1' }, validators)).toBe(true);
    expect(isEligibleValidator(actor('u2', ['certificates.approve'], ['other']), { kind: 'RENEWAL', requestedById: 'u1' }, validators)).toBe(false);
    expect(isEligibleValidator(actor('u2', [], [ROLE_TECH]), { kind: 'RENEWAL', requestedById: 'u1' }, validators)).toBe(false);
  });

  it('sans validateur configuré : toute personne habilitée', () => {
    expect(matchesValidatorPrincipals([{ type: 'USER', id: 'x' }], [])).toBe(true);
    expect(isEligibleValidator(actor('u2', ['certificates.approve']), { kind: 'CREATE', requestedById: 'u1' }, [])).toBe(true);
  });

  it('pièce jointe : permission dédiée et validation par une autre personne (ADM-066)', () => {
    const req = { kind: 'ATTACHMENT' as const, requestedById: 'u1', uploadedById: 'u1' };
    expect(isEligibleValidator(actor('u2', ['certificates.approve'], [ROLE_TECH]), req, validators)).toBe(false);
    expect(isEligibleValidator(actor('u2', ['certificates.attachments.approve']), req, validators)).toBe(true);
    expect(isEligibleValidator(actor('u1', ['certificates.attachments.approve']), req, validators)).toBe(false);
  });
});

describe('droits fichiers (CERT-05/06/07)', () => {
  const viewer = (perms: string[], userId = 'viewer'): Actor => ({ userId, permissions: new Set(perms), principals: [{ type: 'USER', id: userId }] });
  const official = {
    status: 'OFFICIAL' as const,
    isCurrentOfficial: true,
    uploadedById: 'up',
    request: null,
    validators: [],
    previewable: true,
  };

  it('CERT-06 : View sans Download = aperçu seulement', () => {
    expect(attachmentRights(viewer(['certificates.view']), official)).toEqual({ scope: 'CURRENT', preview: true, download: false });
  });

  it('CERT-07 : download_current ne donne pas accès aux archives', () => {
    const archived = { ...official, status: 'ARCHIVED' as const, isCurrentOfficial: false };
    const r = attachmentRights(viewer(['certificates.view', 'certificates.download_current']), archived);
    expect(r).toEqual({ scope: 'ARCHIVED', preview: true, download: false });
    expect(attachmentRights(viewer(['certificates.download_archived']), archived).download).toBe(true);
    // Pièce OFFICIAL d'une révision archivée = archive
    expect(attachmentRights(viewer(['certificates.download_current']), { ...official, isCurrentOfficial: false }).download).toBe(false);
  });

  it('CERT-05 : pièce en attente réservée au demandeur et aux validateurs éligibles', () => {
    const pending = {
      ...official,
      status: 'PENDING_APPROVAL' as const,
      isCurrentOfficial: false,
      uploadedById: 'req',
      request: { kind: 'ATTACHMENT' as const, requestedById: 'req' },
    };
    expect(attachmentRights(viewer(['certificates.view', 'certificates.download_current']), pending).preview).toBe(false);
    expect(attachmentRights(viewer(['certificates.attachments.approve']), pending)).toEqual({ scope: 'WORKFLOW', preview: true, download: false });
    expect(attachmentRights(viewer([], 'req'), pending)).toEqual({ scope: 'WORKFLOW', preview: true, download: true });
  });

  it('format non affichable : aperçu seulement si téléchargement autorisé', () => {
    expect(attachmentRights(viewer(['certificates.view']), { ...official, previewable: false }).preview).toBe(false);
  });

  it("pièce d'un brouillon : privée au demandeur, même pour un validateur éligible", () => {
    const draftFile = {
      ...official,
      status: 'PENDING_APPROVAL' as const,
      isCurrentOfficial: false,
      uploadedById: 'req',
      request: { kind: 'RENEWAL' as const, requestedById: 'req', status: 'DRAFT' as const },
    };
    expect(attachmentRights(viewer(['certificates.approve']), draftFile).preview).toBe(false);
    expect(attachmentRights(viewer(['certificates.approve']), { ...draftFile, request: { ...draftFile.request, status: 'PENDING_APPROVAL' } }).preview).toBe(true);
    expect(attachmentRights(viewer([], 'req'), draftFile).preview).toBe(true);
  });
});

describe('annulation de supervision (demande bloquante)', () => {
  const ROLE_TECH = 'role-tech';
  const actor = (userId: string, perms: string[], roleIds: string[] = []): Actor => ({
    userId,
    permissions: new Set(perms),
    principals: [{ type: 'USER', id: userId }, ...roleIds.map((id) => ({ type: 'ROLE' as const, id }))],
  });
  const validators = [{ principalType: 'ROLE' as const, principalId: ROLE_TECH }];
  const draft = { kind: 'CORRECTION' as const, requestedById: 'req' };

  it('validateur désigné pour le type ou administrateur des types', () => {
    expect(isRequestSupervisor(actor('v', ['certificates.approve'], [ROLE_TECH]), draft, validators)).toBe(true);
    expect(isRequestSupervisor(actor('adm', ['certificates.types.manage']), draft, validators)).toBe(true);
  });

  it('refusé à un simple créateur ou à un approbateur non désigné', () => {
    expect(isRequestSupervisor(actor('c', ['certificates.create', 'certificates.edit']), draft, validators)).toBe(false);
    expect(isRequestSupervisor(actor('v', ['certificates.approve'], ['other']), draft, validators)).toBe(false);
  });

  it("le demandeur n'est pas superviseur de sa propre demande (il annule via ADM-059)", () => {
    expect(isRequestSupervisor(actor('req', ['certificates.types.manage']), draft, validators)).toBe(false);
  });

  it('pièce jointe : permission dédiée', () => {
    const att = { kind: 'ATTACHMENT' as const, requestedById: 'req', uploadedById: 'req' };
    expect(isRequestSupervisor(actor('v', ['certificates.attachments.approve']), att, validators)).toBe(true);
    expect(isRequestSupervisor(actor('v', ['certificates.approve'], [ROLE_TECH]), att, validators)).toBe(false);
  });
});

describe('rappels (ADM-044..047, CERT-01, CERT-02)', () => {
  const policy: ReminderPolicyRules = {
    thresholdsDays: [90, 60, 30, 7],
    frequency: 'AT_THRESHOLDS',
    customIntervalDays: null,
    postExpiryIntervalDays: 7,
    postExpiryMaxReminders: 3,
    unknownExpiryIntervalDays: 30,
    missingDocumentIntervalDays: 14,
  };
  const subject = (over: Partial<ReminderSubject> = {}): ReminderSubject => ({
    certificateId: 'c1',
    revisionNo: 2,
    expiryKind: 'DATED',
    expiryOn: addDays(TODAY, 45),
    documentMissing: false,
    requiresDocument: true,
    renewalStatus: 'NOT_STARTED',
    anchorDate: d('2026-01-01'),
    ...over,
  });
  const kinds = (alerts: { kind: string }[]) => alerts.map((a) => a.kind);

  it('CERT-01 : UNKNOWN ne produit aucune alerte d’échéance, seulement un rappel de complétion', () => {
    const alerts = decideCertificateReminders(policy, subject({ expiryKind: 'UNKNOWN', expiryOn: null }), TODAY);
    expect(kinds(alerts)).toEqual(['UNKNOWN_EXPIRY']);
    expect(alerts[0].dedupeKey).toMatch(/^cert:c1:r2:unknown:\d+$/);
    // Rappel de complétion désactivé => aucune alerte du tout
    expect(decideCertificateReminders({ ...policy, unknownExpiryIntervalDays: null }, subject({ expiryKind: 'UNKNOWN', expiryOn: null }), TODAY)).toEqual([]);
  });

  it('UNLIMITED : jamais d’alerte d’échéance (ADM-062)', () => {
    expect(decideCertificateReminders(policy, subject({ expiryKind: 'UNLIMITED', expiryOn: null }), TODAY)).toEqual([]);
  });

  it('CERT-02 : un renouvellement IN_PROGRESS ne supprime jamais les alertes', () => {
    const base = decideCertificateReminders(policy, subject(), TODAY);
    const inProgress = decideCertificateReminders(policy, subject({ renewalStatus: 'IN_PROGRESS' }), TODAY);
    expect(inProgress).toEqual(base);
    expect(kinds(inProgress)).toEqual(['EXPIRY']);
    const expired = decideCertificateReminders(policy, subject({ renewalStatus: 'IN_PROGRESS', expiryOn: addDays(TODAY, -3) }), TODAY);
    expect(kinds(expired)).toEqual(['EXPIRED']);
  });

  it('seuils : une alerte par seuil franchi, clé stable dans la tranche', () => {
    expect(decideCertificateReminders(policy, subject({ expiryOn: addDays(TODAY, 120) }), TODAY)).toEqual([]);
    const at90 = decideCertificateReminders(policy, subject({ expiryOn: addDays(TODAY, 90) }), TODAY);
    expect(at90[0]).toMatchObject({ kind: 'EXPIRY', threshold: 90, dedupeKey: 'cert:c1:r2:expiry:t90', priority: 'NORMAL' });
    // 45 jours restants : seuil 60 franchi (pas 30)
    const at45 = decideCertificateReminders(policy, subject(), TODAY);
    expect(at45[0]).toMatchObject({ threshold: 60, dedupeKey: 'cert:c1:r2:expiry:t60', daysToExpiry: 45 });
    // Le lendemain : même clé => pas de doublon
    const next = decideCertificateReminders(policy, subject(), addDays(TODAY, 1));
    expect(next[0].dedupeKey).toBe(at45[0].dedupeKey);
    // Job manqué plusieurs semaines : seul le seuil le plus urgent est émis
    const late = decideCertificateReminders(policy, subject({ expiryOn: addDays(TODAY, 5) }), TODAY);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ threshold: 7, priority: 'HIGH' });
    // Jour même de l'expiration
    expect(decideCertificateReminders(policy, subject({ expiryOn: TODAY }), TODAY)[0]).toMatchObject({ threshold: 7, daysToExpiry: 0 });
  });

  it('seuils non triés / dupliqués sont normalisés', () => {
    const alerts = decideCertificateReminders({ ...policy, thresholdsDays: [7, 30, 30, 90, 60] }, subject(), TODAY);
    expect(alerts[0].threshold).toBe(60);
  });

  it('fréquence quotidienne / hebdomadaire / personnalisée dans la fenêtre du plus grand seuil', () => {
    const daily = { ...policy, frequency: 'DAILY' as const };
    const k1 = decideCertificateReminders(daily, subject(), TODAY)[0].dedupeKey;
    const k2 = decideCertificateReminders(daily, subject(), addDays(TODAY, 1))[0].dedupeKey;
    expect(k1).not.toBe(k2);
    const weekly = { ...policy, frequency: 'WEEKLY' as const };
    const w = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => decideCertificateReminders(weekly, subject(), addDays(TODAY, i))[0].dedupeKey);
    expect(new Set(w).size).toBe(2);
    const custom = { ...policy, frequency: 'CUSTOM' as const, customIntervalDays: 10 };
    expect(decideCertificateReminders(custom, subject(), TODAY)[0].dedupeKey).toMatch(/:expiry:p10:\d+$/);
    // Hors fenêtre
    expect(decideCertificateReminders(daily, subject({ expiryOn: addDays(TODAY, 91) }), TODAY)).toEqual([]);
  });

  it('après expiration : alerte initiale puis répétition tous les N jours, au plus M rappels', () => {
    const keysAt = (overdue: number) =>
      decideCertificateReminders(policy, subject({ expiryOn: addDays(TODAY, -overdue) }), TODAY).map((a) => a.dedupeKey);
    expect(keysAt(1)).toEqual(['cert:c1:r2:expired:0']);
    expect(keysAt(7)).toEqual(['cert:c1:r2:expired:0']);
    expect(keysAt(8)).toEqual(['cert:c1:r2:expired:1']);
    expect(keysAt(15)).toEqual(['cert:c1:r2:expired:2']);
    expect(keysAt(22)).toEqual(['cert:c1:r2:expired:3']);
    // Maximum (3) atteint : plus de nouvelle clé, seule l'alerte initiale (déjà dédupliquée)
    expect(keysAt(29)).toEqual(['cert:c1:r2:expired:0']);
    expect(keysAt(400)).toEqual(['cert:c1:r2:expired:0']);
    const alert = decideCertificateReminders(policy, subject({ expiryOn: addDays(TODAY, -8) }), TODAY)[0];
    expect(alert).toMatchObject({ kind: 'EXPIRED', priority: 'CRITICAL', daysOverdue: 8, occurrence: 1 });
  });

  it('sans répétition post-expiration : une seule alerte « expiré »', () => {
    const p = { ...policy, postExpiryIntervalDays: null };
    const k = [1, 10, 100].map((o) => decideCertificateReminders(p, subject({ expiryOn: addDays(TODAY, -o) }), TODAY)[0].dedupeKey);
    expect(new Set(k)).toEqual(new Set(['cert:c1:r2:expired:0']));
  });

  it('pièce officielle manquante : rappel si le type exige un document (ADM-064/065)', () => {
    const alerts = decideCertificateReminders(policy, subject({ documentMissing: true }), TODAY);
    expect(kinds(alerts)).toEqual(['EXPIRY', 'MISSING_DOCUMENT']);
    expect(kinds(decideCertificateReminders(policy, subject({ documentMissing: true, requiresDocument: false }), TODAY))).toEqual(['EXPIRY']);
    // UNLIMITED sans document : seul le rappel de pièce manquante
    expect(kinds(decideCertificateReminders(policy, subject({ expiryKind: 'UNLIMITED', expiryOn: null, documentMissing: true }), TODAY))).toEqual([
      'MISSING_DOCUMENT',
    ]);
  });

  it('nouvelle révision approuvée : les clés repartent (renouvellement)', () => {
    const r2 = decideCertificateReminders(policy, subject(), TODAY)[0].dedupeKey;
    const r3 = decideCertificateReminders(policy, subject({ revisionNo: 3 }), TODAY)[0].dedupeKey;
    expect(r2).not.toBe(r3);
  });
});

describe('approbations en retard (ADM-056)', () => {
  const base = {
    requestId: 'r1',
    version: 2,
    submittedAt: new Date('2026-10-09T08:00:00Z'),
    overdueHours: 48,
    alreadyEscalated: false,
    escalationConfigured: true,
  };

  it('pas de rappel avant le délai', () => {
    expect(decideApprovalOverdue({ ...base, now: new Date('2026-10-11T07:00:00Z') })).toEqual({ remind: null, escalate: false });
  });

  it('rappel + escalade unique après le délai', () => {
    const r = decideApprovalOverdue({ ...base, now: new Date('2026-10-11T09:00:00Z') });
    expect(r.remind).toMatchObject({ dedupeKey: 'certreq:r1:v2:overdue:1', hoursPending: 49 });
    expect(r.escalate).toBe(true);
    expect(decideApprovalOverdue({ ...base, alreadyEscalated: true, now: new Date('2026-10-13T09:00:00Z') })).toMatchObject({
      remind: { dedupeKey: 'certreq:r1:v2:overdue:2' },
      escalate: false,
    });
  });

  it('désactivé sans délai configuré', () => {
    expect(decideApprovalOverdue({ ...base, overdueHours: null, now: new Date('2027-01-01T00:00:00Z') }).remind).toBeNull();
  });
});

describe('utilitaires', () => {
  it('diffDays calendaire', () => {
    expect(diffDays(d('2026-10-11'), d('2026-11-02'))).toBe(22);
    expect(diffDays(d('2026-10-11'), d('2026-10-01'))).toBe(-10);
  });

  it('nom de téléchargement sans caractère dangereux', () => {
    expect(safeDownloadName(['ISSC', 'N° 12/34 é'], 'PDF')).toBe('ISSC_N_12_34_e.pdf');
    const traversal = safeDownloadName(['../..\\x', null], 'p/df');
    expect(traversal).not.toMatch(/[\\/]/);
    expect(traversal.endsWith('.pdf')).toBe(true);
    expect(safeDownloadName([], 'pdf')).toBe('certificat.pdf');
  });
});
