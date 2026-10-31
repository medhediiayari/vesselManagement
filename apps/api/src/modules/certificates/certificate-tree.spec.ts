import type { AuthContext } from '../access/auth-context';
import { canonicalCategory, folderSubtree } from './certificate-tree.service';
import { canSelfApprove } from './certificate-workflow.service';

const ctxWith = (...permissions: string[]) => ({ permissions: new Set(permissions) }) as unknown as AuthContext;

describe('Arborescence Certificats', () => {
  const folders = [
    { id: 'a', parentId: null },
    { id: 'a1', parentId: 'a' },
    { id: 'a11', parentId: 'a1' },
    { id: 'a2', parentId: 'a' },
    { id: 'b', parentId: null },
  ];

  it('sous-arbre : dossier + tous ses descendants, sans les frères', () => {
    expect(folderSubtree(folders, 'a').sort()).toEqual(['a', 'a1', 'a11', 'a2']);
    expect(folderSubtree(folders, 'a1').sort()).toEqual(['a1', 'a11']);
    expect(folderSubtree(folders, 'b')).toEqual(['b']);
  });

  it('sous-arbre : robuste à un cycle accidentel', () => {
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect(folderSubtree(cyclic, 'x').sort()).toEqual(['x', 'y']);
  });
});

describe('Catégories : nom de référence (CRT-07)', () => {
  const existing = ['STATUTORY', 'X-cat', 'Médical'];

  it('reprend la catégorie existante qui ne diffère que par la casse ou les accents', () => {
    expect(canonicalCategory(existing, 'X-CAT')).toBe('X-cat');
    expect(canonicalCategory(existing, 'statutory')).toBe('STATUTORY');
    expect(canonicalCategory(existing, 'MEDICAL')).toBe('Médical');
  });

  it('garde le nom saisi pour une nouvelle catégorie', () => {
    expect(canonicalCategory(existing, 'CLASS')).toBe('CLASS');
    expect(canonicalCategory([], 'STCW')).toBe('STCW');
  });
});

describe('Publication directe (canSelfApprove)', () => {
  it('certificates.self_approve couvre toutes les demandes', () => {
    const ctx = ctxWith('certificates.self_approve');
    for (const kind of ['CREATE', 'RENEWAL', 'CORRECTION', 'ATTACHMENT'] as const) expect(canSelfApprove(ctx, kind)).toBe(true);
  });

  it('certificates.renewal.self_approve ne couvre que le renouvellement', () => {
    const ctx = ctxWith('certificates.renewal.self_approve');
    expect(canSelfApprove(ctx, 'RENEWAL')).toBe(true);
    expect(canSelfApprove(ctx, 'CREATE')).toBe(false);
    expect(canSelfApprove(ctx, 'CORRECTION')).toBe(false);
    expect(canSelfApprove(ctx, 'ATTACHMENT')).toBe(false);
  });

  it('sans permission dédiée : circuit de validation', () => {
    expect(canSelfApprove(ctxWith('certificates.submit', 'certificates.approve'), 'RENEWAL')).toBe(false);
  });
});
