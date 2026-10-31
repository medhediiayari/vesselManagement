import {
  crewCertificateAlerts,
  crewCertificateAuditSummary,
  crewCertificateWarningMessages,
  crewCheckEnd,
  frDate,
  type CrewCertificateInput,
} from './crew-certificates.logic';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = new Date('2026-10-30T09:15:00.000Z');

let seq = 0;
const cert = (name: string, kind: CrewCertificateInput['currentExpiryKind'], expiry: string | null, number: string | null = null): CrewCertificateInput => ({
  id: `c${++seq}`,
  currentNumber: number,
  currentExpiryKind: kind,
  currentExpiryOn: expiry ? d(expiry) : null,
  type: { name, code: name.slice(0, 3).toUpperCase() },
});

describe('crewCheckEnd', () => {
  it('prend le débarquement prévu sans voyage', () => {
    expect(crewCheckEnd(d('2027-01-30'), null)).toEqual(d('2027-01-30'));
  });
  it('null sans date ni voyage', () => {
    expect(crewCheckEnd(null)).toBeNull();
    expect(crewCheckEnd(undefined, { eta: null, laycanTo: null })).toBeNull();
  });
  it('max entre le débarquement prévu et l’ETA du voyage', () => {
    expect(crewCheckEnd(d('2027-01-30'), { eta: new Date('2027-02-10T14:00:00Z'), laycanTo: d('2026-12-01') })).toEqual(new Date('2027-02-10T14:00:00Z'));
    expect(crewCheckEnd(d('2027-03-01'), { eta: new Date('2027-02-10T14:00:00Z'), laycanTo: null })).toEqual(d('2027-03-01'));
  });
  it('fin de laycan si le voyage n’a pas d’ETA', () => {
    expect(crewCheckEnd(d('2026-11-15'), { eta: null, laycanTo: d('2026-12-01') })).toEqual(d('2026-12-01'));
    expect(crewCheckEnd(null, { eta: null, laycanTo: d('2026-12-01') })).toEqual(d('2026-12-01'));
  });
});

describe('crewCertificateAlerts', () => {
  const certs = [
    cert('STCW Basic Safety', 'DATED', '2028-05-01'), // valide sur toute la période
    cert('Certificat médical', 'DATED', '2026-11-12', 'MED-1'), // expire pendant l'embarquement
    cert('Passeport', 'DATED', '2026-05-03'), // expiré
    cert('GMDSS', 'DATED', '2026-10-01'), // expiré
    cert('Livret maritime', 'UNLIMITED', null), // illimité : jamais signalé
    cert('Vaccination', 'UNKNOWN', null), // échéance inconnue
    cert('Visa', 'DATED', null), // daté sans date : inconnu
    cert('Fièvre jaune', 'DATED', '2027-01-30'), // expire le jour du débarquement : signalé
  ];

  it('trie expirés d’abord, puis par date, inconnus en dernier, et compte', () => {
    const r = crewCertificateAlerts(certs, d('2027-01-30'), TODAY);
    expect(r.items.map((i) => [i.typeName, i.flag, i.expiryOn])).toEqual([
      ['Passeport', 'EXPIRED', '2026-05-03'],
      ['GMDSS', 'EXPIRED', '2026-10-01'],
      ['Certificat médical', 'EXPIRES_BEFORE_VOYAGE_END', '2026-11-12'],
      ['Fièvre jaune', 'EXPIRES_BEFORE_VOYAGE_END', '2027-01-30'],
      ['Vaccination', 'EXPIRY_UNKNOWN', null],
      ['Visa', 'EXPIRY_UNKNOWN', null],
    ]);
    expect(r.counts).toEqual({ expired: 2, expiringBeforeEnd: 2, expiryUnknown: 2 });
    expect(r.items[2]).toMatchObject({ certificateId: expect.any(String), typeCode: 'CER', number: 'MED-1' });
  });

  it('sans date de fin : seuls les expirés et les échéances inconnues', () => {
    const r = crewCertificateAlerts(certs, null, TODAY);
    expect(r.items.map((i) => i.flag)).toEqual(['EXPIRED', 'EXPIRED', 'EXPIRY_UNKNOWN', 'EXPIRY_UNKNOWN']);
    expect(r.counts).toEqual({ expired: 2, expiringBeforeEnd: 0, expiryUnknown: 2 });
  });

  it('un certificat expirant aujourd’hui n’est pas encore expiré', () => {
    const r = crewCertificateAlerts([cert('Médical', 'DATED', '2026-10-30')], null, TODAY);
    expect(r.items).toEqual([]);
    const r2 = crewCertificateAlerts([cert('Médical', 'DATED', '2026-10-30')], d('2026-12-01'), TODAY);
    expect(r2.items[0].flag).toBe('EXPIRES_BEFORE_VOYAGE_END');
  });

  it('aucune alerte : liste vide et compteurs à zéro', () => {
    const r = crewCertificateAlerts([cert('STCW', 'DATED', '2030-01-01'), cert('Livret', 'UNLIMITED', null)], d('2027-01-30'), TODAY);
    expect(r).toEqual({ items: [], counts: { expired: 0, expiringBeforeEnd: 0, expiryUnknown: 0 } });
  });
});

describe('messages et audit', () => {
  const r = crewCertificateAlerts(
    [cert('Certificat médical', 'DATED', '2026-11-12'), cert('Passeport', 'DATED', '2026-05-03'), cert('Visa', 'UNKNOWN', null), cert('Vaccin', 'UNKNOWN', null)],
    d('2027-01-30'),
    TODAY,
  );

  it('formate les dates en JJ/MM/AAAA', () => {
    expect(frDate('2026-11-12')).toBe('12/11/2026');
    expect(frDate(null)).toBe('—');
  });

  it('un message par certificat daté, un seul pour les échéances inconnues', () => {
    expect(crewCertificateWarningMessages(r.items, d('2027-01-30'))).toEqual([
      'Certificat « Passeport » expiré depuis le 03/05/2026',
      "Certificat « Certificat médical » : expire le 12/11/2026, avant la fin prévue de l'embarquement (30/01/2027)",
      "2 certificats sans date d'échéance",
    ]);
  });

  it('ne parle jamais de justificatif ou document manquant', () => {
    expect(crewCertificateWarningMessages(r.items, d('2027-01-30')).join(' ')).not.toMatch(/manquant|justificatif/i);
  });

  it('résumé d’audit court', () => {
    expect(crewCertificateAuditSummary(r.items)).toEqual([
      { typeName: 'Passeport', expiryOn: '2026-05-03', flag: 'EXPIRED' },
      { typeName: 'Certificat médical', expiryOn: '2026-11-12', flag: 'EXPIRES_BEFORE_VOYAGE_END' },
      { typeName: 'Vaccin', expiryOn: null, flag: 'EXPIRY_UNKNOWN' },
      { typeName: 'Visa', expiryOn: null, flag: 'EXPIRY_UNKNOWN' },
    ]);
  });
});
