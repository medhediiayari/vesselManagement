import { upcomingSegmentOf, upcomingSegments } from './certificates.service';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = d('2026-10-30');

describe('Tri « à échoir d’abord » (UI-08)', () => {
  it('segment : à venir (aujourd’hui compris), puis expirés, puis sans date', () => {
    expect(upcomingSegmentOf(d('2026-10-30'), TODAY)).toBe(0);
    expect(upcomingSegmentOf(d('2027-01-15'), TODAY)).toBe(0);
    expect(upcomingSegmentOf(d('2026-10-29'), TODAY)).toBe(1);
    expect(upcomingSegmentOf(d('2016-03-01'), TODAY)).toBe(1);
    expect(upcomingSegmentOf(null, TODAY)).toBe(2);
  });

  it('à venir par échéance croissante, expirés du plus récent au plus ancien', () => {
    const [upcoming, expired, undated] = upcomingSegments(TODAY);
    expect(upcoming.where).toEqual({ currentExpiryOn: { gte: TODAY } });
    expect(upcoming.orderBy[0]).toEqual({ currentExpiryOn: 'asc' });
    expect(expired.where).toEqual({ currentExpiryOn: { lt: TODAY } });
    expect(expired.orderBy[0]).toEqual({ currentExpiryOn: 'desc' });
    expect(undated.where).toEqual({ currentExpiryOn: null });
  });

  it('curseur : reprise après le certificat dans le sens du segment', () => {
    const [upcoming, expired, undated] = upcomingSegments(TODAY);
    const c = { id: 'c1', currentExpiryOn: d('2026-11-05') };
    expect(upcoming.after(c)).toEqual({
      OR: [{ currentExpiryOn: { gt: c.currentExpiryOn } }, { currentExpiryOn: c.currentExpiryOn, id: { gt: 'c1' } }],
    });
    const old = { id: 'c2', currentExpiryOn: d('2025-01-01') };
    expect(expired.after(old)).toEqual({
      OR: [{ currentExpiryOn: { lt: old.currentExpiryOn } }, { currentExpiryOn: old.currentExpiryOn, id: { gt: 'c2' } }],
    });
    expect(undated.after({ id: 'c3', currentExpiryOn: null })).toEqual({ id: { gt: 'c3' } });
  });
});
