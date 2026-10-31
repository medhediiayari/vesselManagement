import {
  ACTION_PERMISSION,
  AccessInput,
  AclEntryLike,
  AclNode,
  CSO_ACTIONS,
  aclDecision,
  ancestorsReadable,
  breaksWithoutViewRule,
  canAccessVersion,
  canSeeDocument,
  chainFromPath,
  collectEntries,
  emptyActions,
  evaluateAccess,
  fieldAccess,
  grantedActions,
  isConfiguredValidator,
  nearestValidators,
  subtreeAllows,
} from './cso-acl.logic';

const USER = 'u-1';
const ROLE = 'r-cso';
const DEPT = 'd-cso';
const OTHER_DEPT = 'd-tech';
const principals = [
  { type: 'USER' as const, id: USER },
  { type: 'ROLE' as const, id: ROLE },
  { type: 'DEPARTMENT' as const, id: DEPT },
];
const ALL_PERMS = new Set(Object.values(ACTION_PERMISSION));
const VIEWER_PERMS = new Set(['cso.view', 'cso.preview']);

const allow = (type: AclEntryLike['principalType'], id: string, actions: string[]): AclEntryLike => ({
  principalType: type,
  principalId: id,
  actions,
  effect: 'ALLOW',
});
const deny = (type: AclEntryLike['principalType'], id: string, actions: string[]): AclEntryLike => ({
  principalType: type,
  principalId: id,
  actions,
  effect: 'DENY',
});
const node = (entries: AclEntryLike[] = [], inheritAcl = true): AclNode => ({ inheritAcl, entries });

function run(partial: Partial<AccessInput>) {
  return evaluateAccess({
    permissions: ALL_PERMS,
    principals,
    inScope: true,
    chain: [node()],
    target: 'document',
    ...partial,
  });
}

describe('CSO ACL — permission module et scope navire', () => {
  it('sans aucune ACL, la permission module + le scope suffisent', () => {
    const eff = run({ permissions: VIEWER_PERMS });
    expect(eff.view).toBe(true);
    expect(eff.preview).toBe(true);
    expect(eff.download).toBe(false); // pas de cso.download
    expect(eff.edit).toBe(false);
  });

  it('hors scope navire : tout est refusé, même avec un ALLOW explicite', () => {
    const eff = run({ inScope: false, chain: [node([allow('USER', USER, [...CSO_ACTIONS])])] });
    expect(Object.values(eff).every((v) => v === false)).toBe(true);
  });

  it("l'ACL n'accorde jamais au-delà de la permission module (exceptions compatibles)", () => {
    const eff = run({ permissions: VIEWER_PERMS, chain: [node([allow('USER', USER, ['download', 'edit', 'approve'])])] });
    expect(eff.download).toBe(false);
    expect(eff.edit).toBe(false);
    expect(eff.approve).toBe(false);
    expect(eff.view).toBe(true);
  });

  it('toute action exige « view » ; download_archived exige view_archived', () => {
    const eff = run({ chain: [node([deny('USER', USER, ['view'])])] });
    expect(eff.view).toBe(false);
    expect(eff.download).toBe(false);
    expect(eff.edit).toBe(false);
    const eff2 = run({ permissions: new Set(['cso.view', 'cso.archive.download']) });
    expect(eff2.download_archived).toBe(false);
  });
});

describe('CSO ACL — héritage et rupture', () => {
  it("hérite des ACL du dossier parent et des ancêtres", () => {
    const chain = [node(), node(), node([allow('DEPARTMENT', OTHER_DEPT, ['view'])])];
    expect(run({ chain }).view).toBe(false); // ALLOW restrictif hérité de la racine
  });

  it('inheritAcl=false : le nœud garde ses entrées mais coupe les ancêtres', () => {
    const chain = [node([allow('USER', USER, ['view'])], false), node([allow('DEPARTMENT', OTHER_DEPT, ['download'])])];
    expect(collectEntries(chain).map((e) => e.principalId)).toEqual([USER]);
    const eff = run({ chain });
    expect(eff.view).toBe(true);
    expect(eff.download).toBe(true); // l'ALLOW restrictif ancestral n'est plus hérité
  });

  it('CSO-02 : une rupture d’héritage ne rend jamais visible un élément sous un dossier caché', () => {
    // Sous-dossier « ouvert » (aucune règle view) sous un parent réservé à un autre département
    const hiddenParent = [node([allow('ROLE', ROLE, ['edit', 'acl_manage'])], false), node([allow('DEPARTMENT', OTHER_DEPT, ['view'])])];
    expect(run({ chain: hiddenParent, target: 'folder' }).view).toBe(false);
    expect(grantedActions(run({ chain: hiddenParent, target: 'folder' }))).toEqual([]);
    // Parent en DENY explicite : même un ALLOW sur l'enfant ne suffit pas
    const deniedParent = [node([allow('USER', USER, ['view'])], false), node([deny('USER', USER, ['view'])])];
    expect(run({ chain: deniedParent, target: 'folder' }).view).toBe(false);
    // Document dans un sous-dossier dont un ancêtre lointain est caché
    const deepDoc = [node(), node([], false), node(), node([allow('DEPARTMENT', OTHER_DEPT, ['view'])])];
    expect(run({ chain: deepDoc }).view).toBe(false);
    // Parents lisibles : la rupture s'applique normalement
    const readable = [node([allow('USER', USER, ['view'])], false), node([allow('ROLE', ROLE, ['view'])])];
    expect(ancestorsReadable({ chain: readable, principals, target: 'folder' })).toBe(true);
    expect(run({ chain: readable, target: 'folder' }).view).toBe(true);
  });

  it('CSO-02 : seule une exception nommant l’utilisateur sur le document lui-même ouvre un document sous un dossier restreint', () => {
    const restrictedFolder = node([allow('DEPARTMENT', OTHER_DEPT, ['view'])]);
    expect(run({ chain: [node([allow('USER', USER, ['view'])], false), restrictedFolder] }).view).toBe(true);
    // Le même ALLOW posé sur un sous-dossier en rupture ne suffit pas (accès direct au dossier comme recherche)
    expect(run({ chain: [node(), node([allow('USER', USER, ['view'])], false), restrictedFolder] }).view).toBe(false);
    // Jamais contre un refus explicite d'un dossier parent
    expect(run({ chain: [node([allow('USER', USER, ['view'])], false), node([deny('USER', USER, ['view'])])] }).view).toBe(false);
  });

  it('CSO-02 : le partage d’un document reste possible sous un dossier caché', () => {
    const chain = [node(), node([allow('DEPARTMENT', OTHER_DEPT, ['view'])], false), node()];
    expect(run({ chain }).view).toBe(false);
    expect(grantedActions(run({ chain, shares: [{ allowDownload: false }] }))).toEqual(['view', 'preview']);
  });

  it('CSO-02 : rupture d’héritage sans règle Autoriser « view » détectée', () => {
    expect(breaksWithoutViewRule(false, [allow('ROLE', ROLE, ['edit', 'acl_manage'])])).toBe(true);
    expect(breaksWithoutViewRule(false, [deny('ROLE', ROLE, ['view'])])).toBe(true);
    expect(breaksWithoutViewRule(false, [])).toBe(true);
    expect(breaksWithoutViewRule(false, [allow('ROLE', ROLE, ['view', 'edit'])])).toBe(false);
    expect(breaksWithoutViewRule(true, [])).toBe(false);
  });

  it('la rupture sur un dossier intermédiaire arrête la collecte au-dessus de lui', () => {
    const chain = [node([allow('USER', 'x', ['edit'])]), node([allow('USER', 'y', ['share'])], false), node([deny('USER', USER, ['view'])])];
    const entries = collectEntries(chain);
    expect(entries.map((e) => e.principalId)).toEqual(['x', 'y']);
  });

  it('chainFromPath construit la chaîne du plus spécifique à la racine', () => {
    const nodes = new Map<string, AclNode>([
      ['a', node([allow('USER', 'root', ['view'])])],
      ['b', node()],
      ['c', node([], false)],
    ]);
    const doc = node([allow('USER', 'doc', ['view'])]);
    const chain = chainFromPath('/a/b/c/', nodes, doc);
    expect(chain).toHaveLength(4);
    expect(chain[0]).toBe(doc);
    expect(chain[1]).toBe(nodes.get('c'));
    expect(chain[3]).toBe(nodes.get('a'));
  });
});

describe('CSO ACL — priorité DENY et mode restrictif', () => {
  it('un DENY visant un principal de l’utilisateur prévaut sur tout ALLOW', () => {
    const chain = [node([allow('USER', USER, ['view', 'preview'])]), node([deny('DEPARTMENT', DEPT, ['preview'])])];
    const eff = run({ chain });
    expect(eff.view).toBe(true);
    expect(eff.preview).toBe(false);
  });

  it('un DENY visant un autre principal est sans effet', () => {
    const eff = run({ chain: [node([deny('DEPARTMENT', OTHER_DEPT, ['view'])])] });
    expect(eff.view).toBe(true);
  });

  it('ALLOW restrictif : seuls les principaux listés obtiennent l’action', () => {
    const chain = [node([allow('DEPARTMENT', OTHER_DEPT, ['download'])])];
    expect(aclDecision(collectEntries(chain), 'download', principals)).toBe('NOT_LISTED');
    const eff = run({ chain });
    expect(eff.download).toBe(false);
    expect(eff.view).toBe(true); // action non mentionnée => permission module suffit
  });

  it('ALLOW restrictif satisfait via un rôle ou un département', () => {
    expect(run({ chain: [node([allow('ROLE', ROLE, ['download'])])] }).download).toBe(true);
    expect(run({ chain: [node([allow('DEPARTMENT', DEPT, ['download'])])] }).download).toBe(true);
  });

  it('exception compatible au niveau document : ajoute un principal à un ALLOW hérité', () => {
    const chain = [node([allow('USER', USER, ['view'])]), node([allow('DEPARTMENT', OTHER_DEPT, ['view'])])];
    expect(run({ chain }).view).toBe(true);
  });
});

describe('CSO ACL — partages internes (CSO-014)', () => {
  const restricted = [node([allow('DEPARTMENT', OTHER_DEPT, ['view', 'preview', 'download'])])];

  it('un partage actif accorde view + preview malgré un ALLOW restrictif', () => {
    const eff = run({ chain: restricted, shares: [{ allowDownload: false }] });
    expect(eff.view).toBe(true);
    expect(eff.preview).toBe(true);
    expect(eff.download).toBe(false);
  });

  it('download seulement si allowDownload ET permission cso.download', () => {
    expect(run({ chain: restricted, shares: [{ allowDownload: true }] }).download).toBe(true);
    const noPerm = run({ chain: restricted, shares: [{ allowDownload: true }], permissions: VIEWER_PERMS });
    expect(noPerm.download).toBe(false);
  });

  it('le partage ne contourne jamais le scope navire, la permission module ni un DENY', () => {
    expect(run({ chain: restricted, shares: [{ allowDownload: true }], inScope: false }).view).toBe(false);
    expect(run({ chain: restricted, shares: [{ allowDownload: true }], permissions: new Set() }).view).toBe(false);
    const denied = [node([deny('USER', USER, ['view'])])];
    expect(run({ chain: denied, shares: [{ allowDownload: true }] }).view).toBe(false);
  });

  it("le partage n'accorde ni edit, ni share, ni archives", () => {
    const chain = [node([allow('DEPARTMENT', OTHER_DEPT, [...CSO_ACTIONS])])];
    const eff = run({ chain, shares: [{ allowDownload: true }] });
    expect(eff.edit).toBe(false);
    expect(eff.share).toBe(false);
    expect(eff.view_archived).toBe(false);
  });

  it('audit HIGH-2 : sur un dossier restreint, un partage n’accorde QUE view + preview (+ download)', () => {
    // Officier CSO (toutes permissions module) ; dossier restreint à un autre département
    const fixture = [node(), node([allow('DEPARTMENT', OTHER_DEPT, ['view', 'preview', 'download'])])];
    const without = run({ chain: fixture });
    expect(grantedActions(without)).toEqual([]);

    const shared = run({ chain: fixture, shares: [{ allowDownload: false }] });
    expect(grantedActions(shared)).toEqual(['view', 'preview']);

    const sharedDl = run({ chain: fixture, shares: [{ allowDownload: true }] });
    expect(grantedActions(sharedDl)).toEqual(['view', 'preview', 'download']);
  });

  it('un partage sans allowDownload n’accorde pas download même si l’ACL ne mentionne pas download', () => {
    const viewOnlyRestricted = [node([allow('DEPARTMENT', OTHER_DEPT, ['view'])])];
    const eff = run({ chain: viewOnlyRestricted, shares: [{ allowDownload: false }] });
    expect(grantedActions(eff)).toEqual(['view', 'preview']);
  });

  it('un partage ne retire rien aux droits indépendants du destinataire', () => {
    const eff = run({ chain: [node()], shares: [{ allowDownload: false }] });
    expect(eff.edit).toBe(true);
    expect(eff.download).toBe(true);
  });

  it('le partage ne vaut que pour un document', () => {
    expect(run({ chain: restricted, shares: [{ allowDownload: false }], target: 'folder' }).view).toBe(false);
  });
});

describe('CSO ACL — Super Admin (porte de secours dossier)', () => {
  it('conserve la vue du dossier et la gestion d’ACL malgré un DENY, rien de plus', () => {
    const chain = [node([deny('USER', USER, [...CSO_ACTIONS])])];
    const eff = run({ chain, target: 'folder', superAdmin: true });
    expect(eff.view).toBe(true);
    expect(eff.acl_manage).toBe(true);
    expect(eff.folder_create).toBe(false);
    expect(eff.download).toBe(false);
  });

  it('jamais sur un document, jamais hors scope', () => {
    const chain = [node([deny('USER', USER, ['view'])])];
    expect(run({ chain, target: 'document', superAdmin: true }).view).toBe(false);
    expect(run({ chain, target: 'folder', superAdmin: true, inScope: false }).view).toBe(false);
  });
});

describe('CSO — visibilité documents et versions (CSO-005/007/008)', () => {
  const full = run({});
  const viewer = run({ permissions: VIEWER_PERMS });
  const published = { status: 'PUBLISHED' as const, authorId: 'author' };

  it('un document jamais publié est réservé aux participants du workflow', () => {
    const draft = { status: 'DRAFT' as const, authorId: 'author' };
    expect(canSeeDocument(viewer, draft, USER)).toBe(false);
    expect(canSeeDocument(viewer, draft, 'author')).toBe(true);
    expect(canSeeDocument(full, draft, USER)).toBe(true); // edit / approve
  });

  it('un document archivé exige view_archived', () => {
    const archived = { status: 'ARCHIVED' as const, authorId: 'author' };
    expect(canSeeDocument(viewer, archived, USER)).toBe(false);
    expect(canSeeDocument(full, archived, USER)).toBe(true);
  });

  it('version officielle : preview et download distincts', () => {
    const v = { status: 'PUBLISHED' as const, submittedById: 'author' };
    expect(canAccessVersion(viewer, published, v, USER, 'preview')).toBe(true);
    expect(canAccessVersion(viewer, published, v, USER, 'download')).toBe(false);
    expect(canAccessVersion(full, published, v, USER, 'download')).toBe(true);
  });

  it('version archivée (SUPERSEDED) : droits archives distincts', () => {
    const v = { status: 'SUPERSEDED' as const, submittedById: 'author' };
    expect(canAccessVersion(viewer, published, v, USER, 'preview')).toBe(false);
    const archViewer = run({ permissions: new Set(['cso.view', 'cso.preview', 'cso.archive.view']) });
    expect(canAccessVersion(archViewer, published, v, USER, 'preview')).toBe(true);
    expect(canAccessVersion(archViewer, published, v, USER, 'download')).toBe(false);
    expect(canAccessVersion(full, published, v, USER, 'download')).toBe(true);
  });

  it('version en attente : invisible aux simples lecteurs, visible au soumetteur', () => {
    const v = { status: 'PENDING_APPROVAL' as const, submittedById: 'submitter' };
    expect(canAccessVersion(viewer, published, v, USER, 'preview')).toBe(false);
    expect(canAccessVersion(viewer, published, v, 'submitter', 'preview')).toBe(true);
    expect(canAccessVersion(full, published, v, USER, 'preview')).toBe(true);
  });

  it('emptyActions : aucune action', () => {
    expect(Object.values(emptyActions()).some(Boolean)).toBe(false);
  });
});

describe('CSO — validateurs par dossier (CSO-006)', () => {
  it('retient le dossier le plus proche ayant des validateurs', () => {
    const cfg = nearestValidators([
      { folderId: 'child', validators: [] },
      { folderId: 'parent', validators: [{ type: 'DEPARTMENT', id: DEPT }] },
      { folderId: 'root', validators: [{ type: 'USER', id: 'someone' }] },
    ]);
    expect(cfg?.folderId).toBe('parent');
    expect(isConfiguredValidator(principals, cfg)).toBe(true);
    expect(isConfiguredValidator([{ type: 'USER', id: 'x' }], cfg)).toBe(false);
  });

  it('aucun validateur configuré : tout titulaire de cso.approve est éligible', () => {
    const cfg = nearestValidators([{ folderId: 'a', validators: [] }]);
    expect(cfg).toBeNull();
    expect(isConfiguredValidator(principals, cfg)).toBe(true);
  });
});

describe('CSO — ACL de champs (CSO-031/032)', () => {
  const base = {
    isConfidential: false,
    archived: false,
    acl: [],
    principals,
    permissions: new Set(['cso.view', 'cso.edit', 'cso.fields.edit']),
    documentView: true,
    documentEdit: true,
  };

  it('champ standard sans ACL : visible avec le document, éditable avec cso.fields.edit', () => {
    expect(fieldAccess(base)).toEqual({ view: true, edit: true });
    expect(fieldAccess({ ...base, documentView: false })).toEqual({ view: false, edit: false });
    expect(fieldAccess({ ...base, documentEdit: false }).edit).toBe(false);
  });

  it('champ confidentiel : masqué sans cso.fields.view', () => {
    expect(fieldAccess({ ...base, isConfidential: true }).view).toBe(false);
    expect(fieldAccess({ ...base, isConfidential: true, permissions: new Set(['cso.fields.view', 'cso.fields.edit']) }).view).toBe(true);
  });

  it('liste restrictive de visibilité et refus explicite canView=false', () => {
    const other = { principalType: 'DEPARTMENT' as const, principalId: OTHER_DEPT, canView: true, canEdit: true };
    expect(fieldAccess({ ...base, acl: [other] })).toEqual({ view: false, edit: false });
    const mine = { principalType: 'ROLE' as const, principalId: ROLE, canView: true, canEdit: false };
    expect(fieldAccess({ ...base, acl: [other, mine] })).toEqual({ view: true, edit: false });
    const hidden = { principalType: 'USER' as const, principalId: USER, canView: false, canEdit: false };
    expect(fieldAccess({ ...base, acl: [mine, hidden] }).view).toBe(false);
  });

  it('champ archivé : lisible, jamais modifiable', () => {
    expect(fieldAccess({ ...base, archived: true })).toEqual({ view: true, edit: false });
  });
});

describe('CSO — opérations de sous-arbre (audit #9)', () => {
  it('archivage refusé si un élément du sous-arbre est invisible ou non archivable', () => {
    const ok = run({});
    const hidden = run({ chain: [node([deny('USER', USER, ['view'])])] });
    const notArchivable = run({ chain: [node([allow('DEPARTMENT', OTHER_DEPT, ['folder_archive'])])] });
    expect(subtreeAllows([ok, ok], ['folder_archive'])).toBe(true);
    expect(subtreeAllows([ok, hidden], ['folder_archive'])).toBe(false);
    expect(subtreeAllows([ok, notArchivable], ['folder_archive'])).toBe(false);
    expect(subtreeAllows([ok, notArchivable])).toBe(true); // déplacement : visibilité seule
    expect(subtreeAllows([])).toBe(true);
  });
});
