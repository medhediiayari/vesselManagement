import { isSelfLockoutPermission, selfLockoutDenies } from './admin.logic';

describe('ADM-05 — DENY sur son propre compte', () => {
  it('protège permissions.manage, users.* et roles.*', () => {
    expect(isSelfLockoutPermission('permissions.manage')).toBe(true);
    expect(isSelfLockoutPermission('users.edit')).toBe(true);
    expect(isSelfLockoutPermission('roles.manage')).toBe(true);
    expect(isSelfLockoutPermission('pr.view')).toBe(false);
    expect(isSelfLockoutPermission('sessions.revoke')).toBe(false);
  });

  it('refuse un nouveau DENY d’administration, tolère un DENY existant et les autres droits', () => {
    const existing = [{ permissionKey: 'users.unlock', effect: 'DENY' as const }];
    expect(
      selfLockoutDenies(
        [
          { permissionKey: 'users.unlock', effect: 'DENY' },
          { permissionKey: 'pr.view', effect: 'DENY' },
          { permissionKey: 'permissions.manage', effect: 'DENY' },
          { permissionKey: 'permissions.manage', effect: 'DENY' },
        ],
        existing,
      ),
    ).toEqual(['permissions.manage']);
    expect(selfLockoutDenies([{ permissionKey: 'pr.view', effect: 'DENY' }], [])).toEqual([]);
  });
});
