import { containsText, escapeLike } from './like';

describe('escapeLike (ADM-22)', () => {
  it('échappe %, _ et la barre oblique inverse', () => {
    expect(escapeLike('%%')).toBe('\\%\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('c:\\x')).toBe('c:\\\\x');
  });

  it('laisse le texte ordinaire intact', () => {
    expect(escapeLike('ISK-PR-2026-0336')).toBe('ISK-PR-2026-0336');
    expect(containsText('Démo')).toEqual({ contains: 'Démo', mode: 'insensitive' });
  });
});
