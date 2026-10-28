import {
  CREW_TRANSITIONS,
  OUT_OF_SCOPE_DUPLICATE_MESSAGE,
  canTransitionCrew,
  partitionCandidates,
  redactMemberAuditPayload,
  certificateValidity,
  changedProtectedFields,
  deriveMemberStatus,
  idKey,
  nameKey,
  resolveManualStatus,
  validateCustomFieldValue,
} from './members.logic';

describe('Automate des affectations (CDC §12, V1 §5.2)', () => {
  it('table de transitions explicite', () => {
    expect(CREW_TRANSITIONS).toEqual({
      PLANNED: ['ONBOARD', 'CANCELLED'],
      ONBOARD: ['COMPLETED'],
      COMPLETED: [],
      CANCELLED: [],
    });
    expect(canTransitionCrew('PLANNED', 'ONBOARD')).toBe(true);
    expect(canTransitionCrew('ONBOARD', 'COMPLETED')).toBe(true);
    expect(canTransitionCrew('ONBOARD', 'CANCELLED')).toBe(false);
    expect(canTransitionCrew('COMPLETED', 'ONBOARD')).toBe(false);
    expect(canTransitionCrew('CANCELLED', 'PLANNED')).toBe(false);
  });

  it('statut Member synchronisé avec les affectations', () => {
    expect(deriveMemberStatus('AVAILABLE', { onboard: 0, planned: 1 })).toBe('PLANNED_JOIN');
    expect(deriveMemberStatus('PLANNED_JOIN', { onboard: 1, planned: 0 })).toBe('ON_BOARD');
    expect(deriveMemberStatus('ON_BOARD', { onboard: 0, planned: 0 })).toBe('AVAILABLE');
    expect(deriveMemberStatus('ON_BOARD', { onboard: 0, planned: 1 })).toBe('PLANNED_JOIN');
    expect(deriveMemberStatus('PLANNED_JOIN', { onboard: 0, planned: 0 })).toBe('AVAILABLE');
    expect(deriveMemberStatus('ON_LEAVE', { onboard: 0, planned: 1 })).toBe('ON_LEAVE');
    expect(deriveMemberStatus('INACTIVE', { onboard: 0, planned: 0 })).toBe('INACTIVE');
  });

  it('statut administratif manuel', () => {
    expect(resolveManualStatus('ON_LEAVE', { onboard: 1, planned: 0 })).toMatchObject({ ok: false });
    expect(resolveManualStatus('INACTIVE', { onboard: 0, planned: 1 })).toMatchObject({ ok: false });
    expect(resolveManualStatus('AVAILABLE', { onboard: 0, planned: 1 })).toEqual({ ok: true, status: 'PLANNED_JOIN' });
    expect(resolveManualStatus('INACTIVE', { onboard: 0, planned: 0 })).toEqual({ ok: true, status: 'INACTIVE' });
  });
});

describe('Champs protégés et normalisation', () => {
  it('ne signale que les champs protégés réellement modifiés', () => {
    const before = { passportNumber: 'TN1', birthDate: new Date('1985-04-02T00:00:00.000Z'), phone: '1', amcRef: null };
    expect(changedProtectedFields(before, { passportNumber: 'TN1', birthDate: new Date('1985-04-02T00:00:00.000Z'), phone: '2' })).toEqual([]);
    expect(changedProtectedFields(before, { passportNumber: 'TN2', amcRef: null, seamanBookNumber: 'SB' })).toEqual(['passportNumber', 'seamanBookNumber']);
    expect(changedProtectedFields({}, { firstName: 'A', birthDate: null })).toEqual([]);
  });

  it('clés de comparaison', () => {
    expect(nameKey('Bën-Sàlah Œil')).toBe('BENSALAHOEIL');
    expect(idKey(' tn 12/34 ')).toBe('TN1234');
  });
});

describe('Champs personnalisés (ADM-036..039)', () => {
  const def = (type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN', extra: Partial<{ options: unknown; required: boolean }> = {}) => ({
    key: 'k',
    label: 'Champ',
    type,
    options: extra.options ?? null,
    required: extra.required ?? false,
  });

  it('valide selon le type', () => {
    expect(validateCustomFieldValue(def('TEXT'), '  abc ')).toEqual({ ok: true, value: 'abc' });
    expect(validateCustomFieldValue(def('NUMBER'), '12,5')).toEqual({ ok: true, value: 12.5 });
    expect(validateCustomFieldValue(def('NUMBER'), 'douze')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('DATE'), '2026-02-30')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('DATE'), '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(validateCustomFieldValue(def('BOOLEAN'), 'true')).toEqual({ ok: true, value: true });
    expect(validateCustomFieldValue(def('SELECT', { options: { choices: ['A', 'B'] } }), 'C')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('SELECT', { options: { choices: ['A', 'B'], multiple: true } }), ['A', 'A'])).toEqual({ ok: true, value: ['A'] });
  });

  it('obligatoire : effacement refusé', () => {
    expect(validateCustomFieldValue(def('TEXT', { required: true }), '')).toMatchObject({ ok: false });
    expect(validateCustomFieldValue(def('TEXT'), null)).toEqual({ ok: true, value: null });
  });
});

describe('Confidentialité (ADM-070, champs protégés)', () => {
  it('candidats doublons : invisibles réduits à un indicateur, sans identifiant ni raisons', () => {
    const cands = [
      { memberId: 'visible-1', score: 90, reasons: ['PASSPORT'] },
      { memberId: 'hidden-1', score: 80, reasons: ['NAME_BIRTHDATE'] },
      { memberId: 'hidden-2', score: 45, reasons: ['NAME_NO_BIRTHDATE'] },
    ];
    expect(partitionCandidates(cands, new Set(['visible-1']))).toEqual({ visible: [cands[0]], hiddenMatch: true });
    expect(partitionCandidates(cands.slice(0, 1), new Set(['visible-1']))).toEqual({ visible: [cands[0]], hiddenMatch: false });
    expect(partitionCandidates(cands.slice(1), new Set())).toEqual({ visible: [], hiddenMatch: true });
    expect(OUT_OF_SCOPE_DUPLICATE_MESSAGE).not.toMatch(/naissance|passeport|score/i);
  });

  it('historique : champs protégés et champs personnalisés non consultables masqués', () => {
    const payload = {
      phone: '+216 1',
      passportNumber: 'TN123',
      birthDate: '1985-04-02',
      amcRef: 'AMC-1',
      customFields: { shoe_size: 43, medical_notes: 'confidentiel' },
    };
    const restricted = redactMemberAuditPayload(payload, { canViewProtected: false, canViewCustomField: (k) => k === 'shoe_size' });
    expect(restricted.value).toEqual({ phone: '+216 1', customFields: { shoe_size: 43 } });
    expect(restricted.redacted.sort()).toEqual(['amcRef', 'birthDate', 'customFields.medical_notes', 'passportNumber']);
    const full = redactMemberAuditPayload(payload, { canViewProtected: true, canViewCustomField: () => true });
    expect(full).toEqual({ value: payload, redacted: [] });
    const noCustom = redactMemberAuditPayload({ customFields: { medical_notes: 'x' } }, { canViewProtected: true, canViewCustomField: () => false });
    expect(noCustom.value).toEqual({});
    expect(redactMemberAuditPayload(null, { canViewProtected: false, canViewCustomField: () => false })).toEqual({ value: null, redacted: [] });
  });
});

describe('Validité calculée d’un certificat', () => {
  const today = '2026-10-12';
  it('UNKNOWN ≠ UNLIMITED ≠ DATED ; PERMANENT jamais en alerte', () => {
    expect(certificateValidity('UNLIMITED', null, today, 90)).toBe('UNLIMITED');
    expect(certificateValidity('UNKNOWN', null, today, 90)).toBe('EXPIRY_UNKNOWN');
    expect(certificateValidity('DATED', new Date('2026-10-11T00:00:00Z'), today, 90)).toBe('EXPIRED');
    expect(certificateValidity('DATED', new Date('2026-12-01T00:00:00Z'), today, 90)).toBe('EXPIRING_SOON');
    expect(certificateValidity('DATED', new Date('2027-03-15T00:00:00Z'), today, 90)).toBe('VALID');
    expect(certificateValidity(null, null, today, 90)).toBe('NOT_APPROVED');
  });
});
