import { AccessService } from './access.service';
import { AuthContext, canAccessVessel, vesselWhere } from './auth-context';

/** Tests unitaires du policy engine (CDC §13.1 : rôles cumulés, override DENY, ALL_FLEET). */
function prismaMock(data: {
  roles: { id: string; key: string; permissions: string[] }[];
  overrides?: { permissionKey: string; effect: 'ALLOW' | 'DENY' }[];
  vesselAccess?: string[];
}) {
  return {
    userRole: {
      findMany: jest.fn().mockResolvedValue(
        data.roles.map((r) => ({ role: { id: r.id, key: r.key, permissions: r.permissions.map((p) => ({ permissionKey: p })) } })),
      ),
    },
    permissionOverride: { findMany: jest.fn().mockResolvedValue(data.overrides ?? []) },
    userVesselAccess: { findMany: jest.fn().mockResolvedValue((data.vesselAccess ?? []).map((vesselId) => ({ vesselId }))) },
  };
}

function ctxWith(partial: Partial<AuthContext>): AuthContext {
  return {
    userId: 'u1',
    sessionId: 's1',
    username: 'test',
    displayName: 'Test',
    email: null,
    memberId: null,
    mustChangePassword: false,
    isSuperAdmin: false,
    roleIds: [],
    roleKeys: [],
    departmentIds: [],
    permissions: new Set(),
    deniedPermissions: new Set(),
    vesselScope: { mode: 'SELECTED', vesselIds: [] },
    ip: null,
    userAgent: null,
    requestId: null,
    ...partial,
  };
}

describe('AccessService.computeEffectivePermissions', () => {
  it('cumule les permissions de plusieurs rôles (ADM-022)', async () => {
    const prisma = prismaMock({
      roles: [
        { id: 'r1', key: 'CAPTAIN', permissions: ['pr.create', 'noon.create'] },
        { id: 'r2', key: 'CREWING', permissions: ['members.view'] },
      ],
    });
    const eff = await new AccessService(prisma as never).computeEffectivePermissions('u1');
    expect([...eff.permissions].sort()).toEqual(['members.view', 'noon.create', 'pr.create']);
    expect(eff.isSuperAdmin).toBe(false);
  });

  it('un override DENY l’emporte sur la permission d’un rôle (CDC §2.5)', async () => {
    const prisma = prismaMock({
      roles: [{ id: 'r1', key: 'TECHNICAL', permissions: ['certificates.approve', 'certificates.view'] }],
      overrides: [
        { permissionKey: 'certificates.approve', effect: 'DENY' },
        { permissionKey: 'certificates.approve', effect: 'ALLOW' },
      ],
    });
    const eff = await new AccessService(prisma as never).computeEffectivePermissions('u1');
    expect(eff.permissions.has('certificates.approve')).toBe(false);
    expect(eff.denied.has('certificates.approve')).toBe(true);
    expect(eff.permissions.has('certificates.view')).toBe(true);
  });

  it('un override ALLOW ajoute une permission absente des rôles', async () => {
    const prisma = prismaMock({ roles: [], overrides: [{ permissionKey: 'cso.view', effect: 'ALLOW' }] });
    const eff = await new AccessService(prisma as never).computeEffectivePermissions('u1');
    expect(eff.permissions.has('cso.view')).toBe(true);
  });

  it('le Super Admin a toutes les permissions mais un DENY individuel reste prioritaire', async () => {
    const prisma = prismaMock({
      roles: [{ id: 'r0', key: 'SUPER_ADMIN', permissions: [] }],
      overrides: [{ permissionKey: 'cso.download', effect: 'DENY' }],
    });
    const eff = await new AccessService(prisma as never).computeEffectivePermissions('u1');
    expect(eff.isSuperAdmin).toBe(true);
    expect(eff.permissions.has('users.create')).toBe(true);
    expect(eff.permissions.has('cso.download')).toBe(false);
  });

  it('absence de rôle = aucun droit (deny by default)', async () => {
    const eff = await new AccessService(prismaMock({ roles: [] }) as never).computeEffectivePermissions('u1');
    expect(eff.permissions.size).toBe(0);
  });
});

describe('Scope navire', () => {
  it('ALL_FLEET inclut les navires créés plus tard ; SELECTED non (CDC §2.5)', async () => {
    const svc = new AccessService(prismaMock({ roles: [], vesselAccess: ['v1'] }) as never);
    const all = await svc.computeVesselScope('u1', 'ALL_FLEET');
    const sel = await svc.computeVesselScope('u1', 'SELECTED');
    const newVessel = 'v-cree-apres';
    expect(canAccessVessel(ctxWith({ vesselScope: all }), newVessel)).toBe(true);
    expect(canAccessVessel(ctxWith({ vesselScope: sel }), newVessel)).toBe(false);
    expect(canAccessVessel(ctxWith({ vesselScope: sel }), 'v1')).toBe(true);
  });

  it('vesselWhere produit un filtre serveur pour SELECTED et aucun pour ALL_FLEET', () => {
    expect(vesselWhere(ctxWith({ vesselScope: { mode: 'ALL_FLEET' } }))).toEqual({});
    expect(vesselWhere(ctxWith({ vesselScope: { mode: 'SELECTED', vesselIds: ['a', 'b'] } }))).toEqual({ vesselId: { in: ['a', 'b'] } });
  });

  it('un navire null ou absent n’est jamais accessible', () => {
    expect(canAccessVessel(ctxWith({ vesselScope: { mode: 'ALL_FLEET' } }), null)).toBe(false);
  });
});

describe('Délégation administrative (ADM-005/006)', () => {
  const svc = new AccessService({} as never);

  it('refuse d’accorder une permission que le délégué ne possède pas', () => {
    const ctx = ctxWith({ permissions: new Set(['users.create', 'pr.view']) });
    expect(() => svc.assertCanGrant(ctx, ['pr.view'])).not.toThrow();
    expect(() => svc.assertCanGrant(ctx, ['pr.view', 'bc.approve'])).toThrow(/Délégation refusée/);
  });

  it('refuse ALL_FLEET à un délégué limité à certains navires', () => {
    const ctx = ctxWith({ vesselScope: { mode: 'SELECTED', vesselIds: ['v1'] } });
    expect(() => svc.assertCanGrantVessels(ctx, 'ALL_FLEET', [])).toThrow();
    expect(() => svc.assertCanGrantVessels(ctx, 'SELECTED', ['v1'])).not.toThrow();
    expect(() => svc.assertCanGrantVessels(ctx, 'SELECTED', ['v1', 'v2'])).toThrow();
  });
});
