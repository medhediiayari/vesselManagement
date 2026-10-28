import {
  CpCandidate,
  CpVersionState,
  VOYAGE_COMMANDS,
  VOYAGE_TRANSITIONS,
  buildCpClauses,
  buildNoticeEmailDraft,
  canCompleteTask,
  canTransitionNotice,
  canTransitionVoyage,
  charterPartyCandidates,
  checkCharterPartyRequirement,
  clausesToCpData,
  diffClauses,
  flagCertificate,
  isVoyageClosed,
  normalizeParty,
  opposableVersion,
  pickScheduleDetails,
  planCpApproval,
  sortTimeline,
  stripCharterPartyReferences,
  validateCargoQuantities,
  validateNewCpVersion,
  validatePortOrder,
  validatePortTimes,
  voyageEndDate,
} from './voyages.logic';

const d = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);

describe('Automate Voyage (CDC §12)', () => {
  it('suit DRAFT → PLANNED → ACTIVE → COMPLETED', () => {
    expect(canTransitionVoyage('DRAFT', 'PLANNED')).toBe(true);
    expect(canTransitionVoyage('PLANNED', 'ACTIVE')).toBe(true);
    expect(canTransitionVoyage('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('autorise l’annulation seulement depuis DRAFT / PLANNED', () => {
    expect(canTransitionVoyage('DRAFT', 'CANCELLED')).toBe(true);
    expect(canTransitionVoyage('PLANNED', 'CANCELLED')).toBe(true);
    expect(canTransitionVoyage('ACTIVE', 'CANCELLED')).toBe(false);
    expect(canTransitionVoyage('COMPLETED', 'CANCELLED')).toBe(false);
  });

  it('interdit les sauts et retours arrière', () => {
    expect(canTransitionVoyage('DRAFT', 'ACTIVE')).toBe(false);
    expect(canTransitionVoyage('DRAFT', 'COMPLETED')).toBe(false);
    expect(canTransitionVoyage('ACTIVE', 'PLANNED')).toBe(false);
    expect(canTransitionVoyage('COMPLETED', 'ACTIVE')).toBe(false);
    expect(VOYAGE_TRANSITIONS.COMPLETED).toEqual([]);
    expect(VOYAGE_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('associe chaque commande à sa permission', () => {
    expect(VOYAGE_COMMANDS.plan).toMatchObject({ to: 'PLANNED', permission: 'voyages.activate' });
    expect(VOYAGE_COMMANDS.activate).toMatchObject({ to: 'ACTIVE', permission: 'voyages.activate' });
    expect(VOYAGE_COMMANDS.complete).toMatchObject({ to: 'COMPLETED', permission: 'voyages.close' });
    expect(VOYAGE_COMMANDS.cancel).toMatchObject({ to: 'CANCELLED', permission: 'voyages.close' });
  });

  it('considère COMPLETED / CANCELLED comme clôturés', () => {
    expect(isVoyageClosed('COMPLETED')).toBe(true);
    expect(isVoyageClosed('CANCELLED')).toBe(true);
    expect(isVoyageClosed('ACTIVE')).toBe(false);
  });
});

describe('Rattachement Charter Party (CDC §7.2)', () => {
  const voyage = { id: 'v1', vesselId: 'isk', charterer: 'SEMBODJA CO. LTD', laycanFrom: d('2026-04-22'), laycanTo: d('2026-04-25') };
  const cp = (over: Partial<CpCandidate>): CpCandidate => ({
    id: 'cp1',
    reference: 'CP-1',
    vesselId: 'isk',
    charterer: null,
    laycanFrom: null,
    laycanTo: null,
    status: 'APPROVED',
    linkedVoyageIds: [],
    ...over,
  });

  it('normalise les noms de parties (casse, ponctuation, accents)', () => {
    expect(normalizeParty('Sembodja Co. Ltd')).toBe(normalizeParty('SEMBODJA CO LTD'));
    expect(normalizeParty('Gabès')).toBe('GABES');
  });

  it('détecte une CP du même navire et même affréteur', () => {
    expect(charterPartyCandidates(voyage, [cp({ charterer: 'Sembodja Co Ltd' })]).map((c) => c.id)).toEqual(['cp1']);
  });

  it('détecte une CP dont le laycan recoupe celui du voyage', () => {
    expect(charterPartyCandidates(voyage, [cp({ laycanFrom: d('2026-04-24'), laycanTo: d('2026-04-28') })])).toHaveLength(1);
    expect(charterPartyCandidates(voyage, [cp({ laycanFrom: d('2026-05-01'), laycanTo: d('2026-05-03') })])).toHaveLength(0);
  });

  it('ignore autre navire, CP annulée, CP déjà rattachée ailleurs, ou absence de donnée explicite', () => {
    expect(charterPartyCandidates(voyage, [cp({ vesselId: 'other', charterer: 'SEMBODJA CO. LTD' })])).toHaveLength(0);
    expect(charterPartyCandidates(voyage, [cp({ status: 'CANCELLED', charterer: 'SEMBODJA CO. LTD' })])).toHaveLength(0);
    expect(charterPartyCandidates(voyage, [cp({ linkedVoyageIds: ['v2'], charterer: 'SEMBODJA CO. LTD' })])).toHaveLength(0);
    expect(charterPartyCandidates(voyage, [cp({})])).toHaveLength(0);
  });

  it('exige le rattachement hors DRAFT lorsqu’une CP existe', () => {
    expect(checkCharterPartyRequirement(null, [])).toEqual({ ok: true });
    expect(checkCharterPartyRequirement(null, [cp({})])).toEqual({ ok: false, code: 'CP_NOT_LINKED', candidateIds: ['cp1'] });
    expect(checkCharterPartyRequirement({ status: 'PENDING_APPROVAL' }, [])).toEqual({ ok: true });
    expect(checkCharterPartyRequirement({ status: 'CANCELLED' }, [])).toEqual({ ok: false, code: 'CP_CANCELLED' });
  });
});

describe('Versions de Charter Party : bascule à l’approbation', () => {
  const v = (over: Partial<CpVersionState>): CpVersionState => ({
    id: 'v1',
    versionNo: 1,
    kind: 'ORIGINAL',
    status: 'APPROVED',
    supersededAt: null,
    submittedById: 'ops',
    ...over,
  });

  it('l’ancienne version reste opposable tant que la nouvelle est en attente', () => {
    const versions = [v({}), v({ id: 'v2', versionNo: 2, kind: 'ADDENDUM', status: 'PENDING_APPROVAL' })];
    expect(opposableVersion(versions)?.id).toBe('v1');
  });

  it('supersède l’ancienne puis bascule sur la nouvelle', () => {
    const versions = [v({}), v({ id: 'v2', versionNo: 2, kind: 'REVISION', status: 'PENDING_APPROVAL', submittedById: 'ops' })];
    expect(planCpApproval(versions, 'v2', 'admin')).toEqual({ ok: true, supersedeIds: ['v1'], newCurrentId: 'v2' });
  });

  it('première approbation : rien à supersèder', () => {
    expect(planCpApproval([v({ status: 'PENDING_APPROVAL' })], 'v1', 'admin')).toEqual({ ok: true, supersedeIds: [], newCurrentId: 'v1' });
  });

  it('interdit l’auto-approbation', () => {
    expect(planCpApproval([v({ status: 'PENDING_APPROVAL', submittedById: 'ops' })], 'v1', 'ops')).toEqual({ ok: false, reason: 'SELF_APPROVAL' });
  });

  it('refuse une version déjà traitée ou inconnue', () => {
    expect(planCpApproval([v({})], 'v1', 'admin')).toEqual({ ok: false, reason: 'NOT_PENDING' });
    expect(planCpApproval([v({})], 'nope', 'admin')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('contrôle la nature des nouvelles versions', () => {
    expect(validateNewCpVersion([], 'ORIGINAL')).toBeNull();
    expect(validateNewCpVersion([], 'ADDENDUM')).toMatch(/ORIGINAL/);
    expect(validateNewCpVersion([v({})], 'ORIGINAL')).toMatch(/ADDENDUM/);
    expect(validateNewCpVersion([v({})], 'ADDENDUM')).toBeNull();
    expect(validateNewCpVersion([v({}), v({ id: 'v2', status: 'PENDING_APPROVAL' })], 'REVISION')).toMatch(/attente/);
  });

  it('ne modifie que les clauses explicitement fournies (jamais inventées)', () => {
    const base = { cpType: 'VOYAGE', charterer: 'SEMBODJA CO. LTD', laycanFrom: d('2026-04-22'), laycanTo: d('2026-04-25'), freightTerms: null };
    const clauses = buildCpClauses(base, { norClause: 'WWWW, office hours 08:00–17:00 Mon–Fri' });
    expect(clauses.charterer).toBe('SEMBODJA CO. LTD');
    expect(clauses.laycanFrom).toBe('2026-04-22');
    expect(clauses.norClause).toBe('WWWW, office hours 08:00–17:00 Mon–Fri');
    expect(clauses.freightTerms).toBeNull();
    expect(clauses.demurrageTerms).toBeNull();
    expect(diffClauses(buildCpClauses(base, undefined), clauses)).toEqual(['norClause']);
  });

  it('reconvertit les clauses en valeurs de colonnes (dates, type obligatoire conservé)', () => {
    const data = clausesToCpData({ cpType: null, laycanFrom: '2026-04-22', charterer: 'X' });
    expect(data).not.toHaveProperty('cpType');
    expect(data.laycanFrom).toEqual(d('2026-04-22'));
    expect(data.charterer).toBe('X');
  });
});

describe('Notices (CDC §7.4) : validation humaine, envoi manuel', () => {
  it('impose PLANNED/DRAFTED → VALIDATED → SENT', () => {
    expect(canTransitionNotice('PLANNED', 'VALIDATED')).toBe(false);
    expect(canTransitionNotice('PLANNED', 'SENT')).toBe(false);
    expect(canTransitionNotice('DRAFTED', 'SENT')).toBe(false);
    expect(canTransitionNotice('DRAFTED', 'VALIDATED')).toBe(true);
    expect(canTransitionNotice('VALIDATED', 'SENT')).toBe(true);
    expect(canTransitionNotice('VALIDATED', 'DRAFTED')).toBe(true);
    expect(canTransitionNotice('SENT', 'DRAFTED')).toBe(false);
    expect(canTransitionNotice('CANCELLED', 'DRAFTED')).toBe(false);
  });

  it('génère un brouillon sans inventer les données manquantes', () => {
    const draft = buildNoticeEmailDraft({
      vesselName: 'M/V ISKANDER',
      vesselImo: '9375587',
      voyageReference: 'ISK-VOY-2026-0001',
      charterer: 'SEMBODJA CO. LTD',
      notice: { kind: 'ETA_NOTICE', scheduleLabel: 'Arrival notice 5 jours avant arrivée Gabès', recipients: 'Charterer, agent CHIMAG' },
      port: { portName: 'Gabès', country: 'TN', type: 'LOAD', eta: null, etd: null, agentName: 'CHIMAG' },
      voyageEta: null,
      cargo: [{ commodity: 'DAP Fertiliser in Bulk', qtyMinMt: '3000', qtyMaxMt: '3300', qtyActualMt: null, unit: 'MT' }],
    });
    expect(draft.subject).toContain('M/V ISKANDER');
    expect(draft.subject).toContain('Gabès (TN)');
    expect(draft.body).toContain('ETA              : [TO BE CONFIRMED]');
    expect(draft.body).toContain('DAP Fertiliser in Bulk: 3000 – 3300 MT');
    expect(draft.body).toContain('CHIMAG');
    expect(draft.body).not.toMatch(/freight|demurrage/i);
  });
});

describe('Escales, cargaisons, tâches', () => {
  it('valide une permutation complète des escales', () => {
    expect(validatePortOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toBeNull();
    expect(validatePortOrder(['a', 'b'], ['a'])).toMatch(/toutes/);
    expect(validatePortOrder(['a', 'b'], ['a', 'a'])).toMatch(/dupliquée/);
    expect(validatePortOrder(['a', 'b'], ['a', 'x'])).toMatch(/inconnue/);
  });

  it('contrôle la cohérence arrivée / départ', () => {
    expect(validatePortTimes({ eta: d('2026-04-22T08:00:00Z'), etd: d('2026-04-25T08:00:00Z') })).toBeNull();
    expect(validatePortTimes({ eta: d('2026-04-25T08:00:00Z'), etd: d('2026-04-22T08:00:00Z') })).toMatch(/ETD/);
    expect(validatePortTimes({ ata: d('2026-04-25T08:00:00Z'), atd: d('2026-04-22T08:00:00Z') })).toMatch(/ATD/);
  });

  it('contrôle les quantités cargaison en décimal exact', () => {
    expect(validateCargoQuantities({ qtyMinMt: '3000', qtyMaxMt: '3300' })).toBeNull();
    expect(validateCargoQuantities({ qtyMinMt: '3300.001', qtyMaxMt: '3300' })).toMatch(/minimale/);
    expect(validateCargoQuantities({ qtyActualMt: '-1' })).toMatch(/positives/);
    expect(validateCargoQuantities({ qtyMinMt: '0.1', qtyMaxMt: '0.10' })).toBeNull();
  });

  it('autorise le Master, les services terre ou le responsable à cocher une tâche', () => {
    expect(canCompleteTask({ voyagesEdit: true, noonSubmit: false }, null, 'u')).toBe(true);
    expect(canCompleteTask({ voyagesEdit: false, noonSubmit: true }, null, 'u')).toBe(true);
    expect(canCompleteTask({ voyagesEdit: false, noonSubmit: false }, 'u', 'u')).toBe(true);
    expect(canCompleteTask({ voyagesEdit: false, noonSubmit: false }, 'x', 'u')).toBe(false);
    expect(canCompleteTask({ voyagesEdit: false, noonSubmit: false }, null, 'u')).toBe(false);
  });
});

describe('Contrôle informatif des certificats (CDC §7.4)', () => {
  const today = d('2026-04-10T10:00:00Z');

  it('détermine la fin estimée du voyage', () => {
    expect(voyageEndDate({ ata: null, eta: d('2026-05-02'), laycanTo: d('2026-04-25') }, [])).toEqual(d('2026-05-02'));
    expect(voyageEndDate({ ata: null, eta: null, laycanTo: d('2026-04-25') }, [{ eta: d('2026-05-05'), etd: null, ata: null, atd: null }])).toEqual(d('2026-05-05'));
    expect(voyageEndDate({ ata: null, eta: null, laycanTo: d('2026-04-25') }, [])).toEqual(d('2026-04-25'));
    expect(voyageEndDate({ ata: null, eta: null, laycanTo: null }, [])).toBeNull();
  });

  it('signale expiré, expirant avant la fin, échéance inconnue', () => {
    const end = d('2026-05-02');
    expect(flagCertificate({ expiryKind: 'DATED', expiryOn: d('2026-04-01') }, end, today)).toBe('EXPIRED');
    expect(flagCertificate({ expiryKind: 'DATED', expiryOn: d('2026-04-30') }, end, today)).toBe('EXPIRES_BEFORE_VOYAGE_END');
    expect(flagCertificate({ expiryKind: 'DATED', expiryOn: d('2026-06-30') }, end, today)).toBeNull();
    expect(flagCertificate({ expiryKind: 'UNLIMITED', expiryOn: null }, end, today)).toBeNull();
    expect(flagCertificate({ expiryKind: 'UNKNOWN', expiryOn: null }, end, today)).toBe('EXPIRY_UNKNOWN');
    expect(flagCertificate({ expiryKind: 'DATED', expiryOn: d('2026-04-10') }, end, today)).toBe('EXPIRES_BEFORE_VOYAGE_END');
  });
});

describe('Timeline : confidentialité Charter Party', () => {
  it('ne reprend que les champs de planning dans le détail', () => {
    expect(pickScheduleDetails({ eta: '2026-05-01T00:00:00Z', charterPartyId: 'cp-secret', notes: 'x' })).toEqual({ eta: '2026-05-01T00:00:00Z' });
    expect(pickScheduleDetails({ charterPartyId: 'cp-secret' })).toBeUndefined();
    expect(pickScheduleDetails(null)).toBeUndefined();
  });

  it('retire événements et références CP pour un utilisateur sans charter_party.view', () => {
    const at = d('2026-04-22T08:00:00Z');
    const out = stripCharterPartyReferences([
      { at, kind: 'charter_party.approved', label: 'CP approuvée', entityType: 'cp_version', entityId: 'cpv' },
      { at, kind: 'voyage.charter_party_linked', label: 'CP rattachée', entityType: 'voyage', entityId: 'v:1', details: { charterPartyId: 'cp-secret' } },
      { at, kind: 'voyage.planned', label: 'Planifié', entityType: 'voyage', entityId: 'v:2', details: { comment: 'ok', charterPartyLinked: 'cp-secret' } },
      { at, kind: 'port.arrival', label: 'Arrivée', entityType: 'voyage_port', entityId: 'p1' },
    ]);
    expect(out.map((e) => e.kind)).toEqual(['voyage.planned', 'port.arrival']);
    expect(JSON.stringify(out)).not.toContain('cp-secret');
    expect(out[0].details).toEqual({ comment: 'ok' });
  });
});

describe('Timeline', () => {
  it('trie chronologiquement et déduplique', () => {
    const t = sortTimeline([
      { at: d('2026-04-22T08:00:00Z'), kind: 'port.arrival', label: 'Arrivée', entityId: 'p1' },
      { at: d('2026-04-01T08:00:00Z'), kind: 'voyage.created', label: 'Créé', entityId: 'v' },
      null,
      { at: d('2026-04-22T08:00:00Z'), kind: 'port.arrival', label: 'Arrivée (doublon)', entityId: 'p1' },
      { at: new Date('invalid'), kind: 'x', label: 'x' },
    ]);
    expect(t.map((e) => e.kind)).toEqual(['voyage.created', 'port.arrival']);
  });
});
