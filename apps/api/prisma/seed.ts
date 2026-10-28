/* eslint-disable no-console */
/**
 * Seed de démonstration AMC — idempotent (ré-exécutable).
 * Données synthétiques uniquement (aucune donnée personnelle réelle, CDC §13.2).
 * Exemples métier repris du cahier des charges : M/V ISKANDER (IMO 9375587), PR n°323,
 * voyage Gabès -> Varna (laycan 22–25/04/2026, SEMBODJA CO. LTD).
 */
import { PrismaClient, Prisma, CertificateSubjectKind, ExpiryKind } from '@prisma/client';
import * as argon2 from 'argon2';
import { PERMISSIONS, PREDEFINED_ROLES } from '@amc/types';

const prisma = new PrismaClient();
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'Demo!2026pass';

  // ---------------------------------------------------------------- Société
  const company = await prisma.company.upsert({
    where: { code: 'AMC' },
    create: { code: 'AMC', name: 'Africa Marine Company' },
    update: {},
  });

  // ---------------------------------------------------------------- Permissions & rôles
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      create: { key: p.key, module: p.module, label: p.label, isSensitive: !!p.sensitive },
      update: { module: p.module, label: p.label, isSensitive: !!p.sensitive },
    });
  }
  const roles: Record<string, string> = {};
  for (const r of PREDEFINED_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: r.key } });
    const role =
      existing ??
      (await prisma.role.create({
        data: {
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.permissions === '*',
          permissions:
            r.permissions === '*' ? undefined : { create: [...new Set(r.permissions)].map((permissionKey) => ({ permissionKey })) },
        },
      }));
    roles[r.key] = role.id;
  }

  // ---------------------------------------------------------------- Départements
  const deptDefs = [
    ['DIR', 'Direction'],
    ['TECH', 'Technical / QHSE'],
    ['CREW', 'Crewing / RH'],
    ['PURCH', 'Achats / Purchasing'],
    ['OPS', 'Marine Operations'],
    ['CSO', 'Sûreté — Company Security Officer'],
    ['FIN', 'Finance'],
  ] as const;
  const depts: Record<string, string> = {};
  for (const [code, name] of deptDefs) {
    const dep = await prisma.department.upsert({ where: { code }, create: { code, name }, update: {} });
    depts[code] = dep.id;
  }

  // ---------------------------------------------------------------- Navires
  const iskander = await prisma.vessel.upsert({
    where: { code: 'ISK' },
    create: {
      companyId: company.id,
      code: 'ISK',
      name: 'M/V ISKANDER',
      imoNumber: '9375587',
      vesselType: 'General cargo / Bulk',
      status: 'ACTIVE',
      timezone: 'Africa/Tunis',
      notes: 'Navire cité dans le cahier des charges (PR n°323, Noon Report du 10/02/2026, voyage Gabès → Varna).',
    },
    update: {},
  });

  // Bibliothèques CSO : centrale + une par navire
  let central = await prisma.csoLibrary.findFirst({ where: { kind: 'CENTRAL' } });
  central ??= await prisma.csoLibrary.create({ data: { kind: 'CENTRAL', name: 'Bibliothèque centrale CSO AMC' } });
  for (const v of [iskander]) {
    await prisma.csoLibrary.upsert({
      where: { vesselId: v.id },
      create: { kind: 'VESSEL', vesselId: v.id, name: `CSO — ${v.name}` },
      update: {},
    });
  }

  // ---------------------------------------------------------------- Utilisateurs
  const adminHash = await argon2.hash(adminPassword, ARGON);
  const demoHash = await argon2.hash(demoPassword, ARGON);
  type UserDef = {
    username: string;
    displayName: string;
    role: string;
    scope: 'ALL_FLEET' | 'SELECTED';
    vessels?: string[];
    dept?: string;
    secondaryDepts?: string[];
    jobTitle: string;
    mustChange?: boolean;
  };
  const users: UserDef[] = [
    { username: 'captain.iskander', displayName: 'Capitaine ISKANDER (démo)', role: 'CAPTAIN', scope: 'SELECTED', vessels: [iskander.id], jobTitle: 'Master' },
    { username: 'chief.iskander', displayName: 'Chef mécanicien ISKANDER (démo)', role: 'CHIEF_ENGINEER', scope: 'SELECTED', vessels: [iskander.id], jobTitle: 'Chief Engineer' },
    { username: 'crewing', displayName: 'Crewing Officer (démo)', role: 'CREWING', scope: 'ALL_FLEET', dept: 'CREW', jobTitle: 'Crewing Officer' },
    { username: 'technical', displayName: 'Technical Manager (démo)', role: 'TECHNICAL', scope: 'ALL_FLEET', dept: 'TECH', jobTitle: 'Technical Manager' },
    { username: 'qhse', displayName: 'QHSE Superintendent (démo)', role: 'TECHNICAL', scope: 'ALL_FLEET', dept: 'TECH', jobTitle: 'QHSE Superintendent' },
    { username: 'purchasing', displayName: 'Acheteur (démo)', role: 'PURCHASING', scope: 'ALL_FLEET', dept: 'PURCH', jobTitle: 'Purchaser' },
    { username: 'purchasing.manager', displayName: 'Responsable Achats (démo)', role: 'PURCHASING_MANAGER', scope: 'ALL_FLEET', dept: 'PURCH', jobTitle: 'Purchasing Manager' },
    { username: 'cso', displayName: 'Company Security Officer (démo)', role: 'CSO_OFFICER', scope: 'ALL_FLEET', dept: 'CSO', jobTitle: 'CSO' },
    { username: 'cso.deputy', displayName: 'CSO adjoint (démo)', role: 'CSO_OFFICER', scope: 'ALL_FLEET', dept: 'CSO', jobTitle: 'Deputy CSO' },
    { username: 'operations', displayName: 'Marine Operations (démo)', role: 'OPERATIONS', scope: 'ALL_FLEET', dept: 'OPS', jobTitle: 'Operations Manager' },
    { username: 'direction', displayName: 'Direction (démo)', role: 'VIEWER', scope: 'ALL_FLEET', dept: 'DIR', jobTitle: 'Directeur' },
    // Rôles de la matrice RACI (17/10/2026)
    { username: 'dpa', displayName: 'DPA — Designated Person Ashore (démo)', role: 'DPA', scope: 'ALL_FLEET', dept: 'TECH', jobTitle: 'Designated Person Ashore' },
    { username: 'ops.manager', displayName: 'Ops Manager (démo)', role: 'OPS_MANAGER', scope: 'ALL_FLEET', dept: 'OPS', secondaryDepts: ['PURCH'], jobTitle: 'Operations Manager' },
    { username: 'commercial', displayName: 'Commercial (démo)', role: 'COMMERCIAL', scope: 'ALL_FLEET', jobTitle: 'Commercial Manager' },
    { username: 'nouveau', displayName: 'Nouvel utilisateur (mot de passe temporaire)', role: 'VIEWER', scope: 'SELECTED', vessels: [iskander.id], jobTitle: 'Stagiaire', mustChange: true },
  ];

  const admin = await prisma.user.upsert({
    where: { username: (process.env.SEED_ADMIN_USERNAME ?? 'admin').toLowerCase() },
    create: {
      companyId: company.id,
      username: (process.env.SEED_ADMIN_USERNAME ?? 'admin').toLowerCase(),
      email: (process.env.SEED_ADMIN_EMAIL ?? 'admin@amc.local').toLowerCase(),
      emailVerifiedAt: new Date(),
      displayName: 'Super Admin AMC',
      jobTitle: 'Administrateur plateforme',
      passwordHash: adminHash,
      mustChangePassword: false,
      vesselScope: 'ALL_FLEET',
      roles: { create: { roleId: roles.SUPER_ADMIN } },
      departments: { create: { departmentId: depts.DIR, isPrimary: true } },
    },
    update: {},
  });

  const userIds: Record<string, string> = { admin: admin.id };
  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { username: u.username } });
    const user =
      existing ??
      (await prisma.user.create({
        data: {
          companyId: company.id,
          username: u.username,
          email: `${u.username}@amc.local`,
          emailVerifiedAt: new Date(),
          displayName: u.displayName,
          jobTitle: u.jobTitle,
          passwordHash: demoHash,
          mustChangePassword: !!u.mustChange,
          vesselScope: u.scope,
          createdById: admin.id,
          roles: { create: { roleId: roles[u.role], assignedById: admin.id } },
          vesselAccess: u.vessels ? { create: u.vessels.map((vesselId) => ({ vesselId, grantedById: admin.id })) } : undefined,
          departments: u.dept
            ? {
                create: [
                  { departmentId: depts[u.dept], isPrimary: true },
                  ...(u.secondaryDepts ?? []).map((code) => ({ departmentId: depts[code], isPrimary: false })),
                ],
              }
            : undefined,
        },
      }));
    userIds[u.username] = user.id;
  }
  await prisma.department.update({ where: { id: depts.CSO }, data: { primaryManagerId: userIds.cso } });
  await prisma.departmentDeputy.upsert({
    where: { departmentId_userId: { departmentId: depts.CSO, userId: userIds['cso.deputy'] } },
    create: { departmentId: depts.CSO, userId: userIds['cso.deputy'] },
    update: {},
  });

  // ---------------------------------------------------------------- Rangs
  const ranks: [string, string, 'DECK' | 'ENGINE' | 'CATERING'][] = [
    ['MASTER', 'Master / Capitaine', 'DECK'],
    ['C_OFF', 'Chief Officer / Second capitaine', 'DECK'],
    ['2_OFF', '2nd Officer / Lieutenant', 'DECK'],
    ['3_OFF', '3rd Officer', 'DECK'],
    ['BOSUN', 'Bosun / Maître d’équipage', 'DECK'],
    ['AB', 'Able Seaman / Matelot', 'DECK'],
    ['OS', 'Ordinary Seaman', 'DECK'],
    ['C_ENG', 'Chief Engineer / Chef mécanicien', 'ENGINE'],
    ['2_ENG', '2nd Engineer', 'ENGINE'],
    ['3_ENG', '3rd Engineer', 'ENGINE'],
    ['ELEC', 'Electrician / Électricien', 'ENGINE'],
    ['OILER', 'Oiler / Graisseur', 'ENGINE'],
    ['WIPER', 'Wiper', 'ENGINE'],
    ['COOK', 'Cook / Cuisinier', 'CATERING'],
    ['STEWARD', 'Steward', 'CATERING'],
  ];
  for (const [i, [code, name, crewDepartment]] of ranks.entries()) {
    await prisma.rank.upsert({ where: { code }, create: { code, name, crewDepartment, sortOrder: i }, update: {} });
  }

  // ---------------------------------------------------------------- Politiques de rappel
  const vesselPolicy = await prisma.reminderPolicy.upsert({
    where: { name: 'Certificats navires — standard' },
    create: {
      name: 'Certificats navires — standard',
      thresholdsDays: [90, 60, 30, 7],
      frequency: 'AT_THRESHOLDS',
      postExpiryIntervalDays: 7,
      postExpiryMaxReminders: 8,
      unknownExpiryIntervalDays: 30,
      missingDocumentIntervalDays: 14,
      approvalOverdueHours: 48,
      escalationRoleId: roles.SUPER_ADMIN,
      recipients: { create: [{ principalType: 'ROLE', principalId: roles.TECHNICAL }, { principalType: 'DEPARTMENT', principalId: depts.TECH }] },
    },
    update: {},
  });
  const memberPolicy = await prisma.reminderPolicy.upsert({
    where: { name: 'Certificats marins — standard' },
    create: {
      name: 'Certificats marins — standard',
      thresholdsDays: [90, 60, 30, 7],
      frequency: 'AT_THRESHOLDS',
      postExpiryIntervalDays: 7,
      postExpiryMaxReminders: 8,
      unknownExpiryIntervalDays: 30,
      missingDocumentIntervalDays: 14,
      approvalOverdueHours: 48,
      recipients: { create: [{ principalType: 'ROLE', principalId: roles.CREWING }, { principalType: 'DEPARTMENT', principalId: depts.CREW }] },
    },
    update: {},
  });

  // ---------------------------------------------------------------- Types de certificats
  // Navires : statutaires / classe / ISM-ISPS / assurances ; Members : colonnes du fichier Excel AMC
  const certTypes: [string, string, CertificateSubjectKind, string, number | null][] = [
    ['REG', 'Certificate of Registry / Acte de nationalité', 'VESSEL', 'STATUTORY', null],
    ['CLASS', 'Classification Certificate', 'VESSEL', 'CLASS', 60],
    ['SAFCON', 'Cargo Ship Safety Construction', 'VESSEL', 'STATUTORY', 60],
    ['SEQ', 'Cargo Ship Safety Equipment', 'VESSEL', 'STATUTORY', 60],
    ['SRC', 'Cargo Ship Safety Radio', 'VESSEL', 'STATUTORY', 60],
    ['LL', 'International Load Line Certificate', 'VESSEL', 'STATUTORY', 60],
    ['IOPP', 'International Oil Pollution Prevention', 'VESSEL', 'STATUTORY', 60],
    ['IAPP', 'International Air Pollution Prevention', 'VESSEL', 'STATUTORY', 60],
    ['ISPP', 'International Sewage Pollution Prevention', 'VESSEL', 'STATUTORY', 60],
    ['ISSC', 'International Ship Security Certificate (ISPS)', 'VESSEL', 'ISM-ISPS', 60],
    ['SMC', 'Safety Management Certificate (ISM)', 'VESSEL', 'ISM-ISPS', 60],
    ['DOC', 'Document of Compliance (copie)', 'VESSEL', 'ISM-ISPS', 60],
    ['MLC', 'Maritime Labour Certificate', 'VESSEL', 'STATUTORY', 60],
    ['PNI', 'P&I Certificate of Entry', 'VESSEL', 'INSURANCE', 12],
    ['HM', 'Hull & Machinery Insurance', 'VESSEL', 'INSURANCE', 12],
    ['COC', 'Certificate of Competency (STCW)', 'MEMBER', 'STCW', 60],
    ['ENDORS', 'Flag Endorsement', 'MEMBER', 'STCW', 60],
    ['GMDSS', 'GMDSS GOC / ROC', 'MEMBER', 'STCW', 60],
    ['ARPA', 'Radar / ARPA', 'MEMBER', 'STCW', null],
    ['BST', 'Basic Safety Training', 'MEMBER', 'STCW', 60],
    ['AFF', 'Advanced Fire Fighting', 'MEMBER', 'STCW', 60],
    ['PSCRB', 'Proficiency in Survival Craft & Rescue Boats', 'MEMBER', 'STCW', 60],
    ['MFA', 'Medical First Aid / Medical Care', 'MEMBER', 'STCW', 60],
    ['SSO', 'Ship Security Officer', 'MEMBER', 'ISPS', null],
    ['SDSD', 'Security Awareness with Designated Security Duties', 'MEMBER', 'ISPS', null],
    ['SAT', 'Security Awareness Training', 'MEMBER', 'ISPS', null],
    ['MEDICAL', 'Medical Fitness Certificate', 'MEMBER', 'MEDICAL', 24],
    ['SRB', "Seaman's Record Book", 'MEMBER', 'IDENTITY', 60],
  ];
  const typeIds: Record<string, string> = {};
  for (const [i, [code, name, subjectKind, category, months]] of certTypes.entries()) {
    const t = await prisma.certificateType.upsert({
      where: { code },
      create: {
        code,
        name,
        subjectKind,
        category,
        defaultValidityMonths: months,
        sortOrder: i,
        reminderPolicyId: subjectKind === 'VESSEL' ? vesselPolicy.id : memberPolicy.id,
        validators: { create: [{ principalType: 'ROLE', principalId: roles.TECHNICAL }] },
      },
      update: {},
    });
    typeIds[code] = t.id;
  }

  // ---------------------------------------------------------------- Members (synthétiques)
  const memberDefs = [
    { amcRef: 'AMC-DEMO-0001', firstName: 'Capitaine', lastName: 'DÉMO-ALPHA', rank: 'Master / Capitaine', crewDepartment: 'DECK', status: 'ON_BOARD', birthDate: '1975-05-10', user: 'captain.iskander' },
    { amcRef: 'AMC-DEMO-0002', firstName: 'Mécanicien', lastName: 'DÉMO-BRAVO', rank: 'Chief Engineer / Chef mécanicien', crewDepartment: 'ENGINE', status: 'ON_BOARD', birthDate: '1979-11-02', user: 'chief.iskander' },
    { amcRef: 'AMC-DEMO-0003', firstName: 'Officier', lastName: 'DÉMO-CHARLIE', rank: 'Chief Officer / Second capitaine', crewDepartment: 'DECK', status: 'AVAILABLE', birthDate: '1986-03-21' },
    { amcRef: 'AMC-DEMO-0004', firstName: 'Graisseur', lastName: 'DÉMO-DELTA', rank: 'Oiler / Graisseur', crewDepartment: 'ENGINE', status: 'PLANNED_JOIN', birthDate: '1992-07-14' },
  ] as const;
  const memberIds: Record<string, string> = {};
  for (const m of memberDefs) {
    const member = await prisma.member.upsert({
      where: { amcRef: m.amcRef },
      create: {
        companyId: company.id,
        amcRef: m.amcRef,
        firstName: m.firstName,
        lastName: m.lastName,
        birthDate: d(m.birthDate),
        rank: m.rank,
        crewDepartment: m.crewDepartment,
        status: m.status,
        notes: 'Fiche fictive de démonstration.',
      },
      update: {},
    });
    memberIds[m.amcRef] = member.id;
    if ('user' in m && m.user) {
      const linked = await prisma.user.findFirst({ where: { memberId: member.id } });
      if (!linked) await prisma.user.update({ where: { id: userIds[m.user] }, data: { memberId: member.id } });
    }
  }
  for (const [ref, rank, status, join] of [
    ['AMC-DEMO-0001', 'Master', 'ONBOARD', '2026-08-01'],
    ['AMC-DEMO-0002', 'Chief Engineer', 'ONBOARD', '2026-07-15'],
    ['AMC-DEMO-0004', 'Oiler', 'PLANNED', '2026-11-05'],
  ] as const) {
    const exists = await prisma.crewAssignment.findFirst({ where: { memberId: memberIds[ref], vesselId: iskander.id } });
    if (!exists) {
      await prisma.crewAssignment.create({
        data: {
          memberId: memberIds[ref],
          vesselId: iskander.id,
          rank,
          status,
          plannedJoinDate: d(join),
          actualJoinDate: status === 'ONBOARD' ? d(join) : null,
          createdById: admin.id,
        },
      });
    }
  }

  // ---------------------------------------------------------------- Certificats (révisions approuvées)
  async function seedCertificate(opts: {
    typeCode: string;
    vesselId?: string;
    memberId?: string;
    number: string;
    issuer: string;
    issuedOn?: string;
    expiryKind: ExpiryKind;
    expiryOn?: string;
  }) {
    const subjectKind: CertificateSubjectKind = opts.vesselId ? 'VESSEL' : 'MEMBER';
    const exists = await prisma.certificate.findFirst({
      where: { typeId: typeIds[opts.typeCode], vesselId: opts.vesselId ?? null, memberId: opts.memberId ?? null },
    });
    if (exists) return;
    await prisma.$transaction(async (tx) => {
      const cert = await tx.certificate.create({
        data: { subjectKind, vesselId: opts.vesselId, memberId: opts.memberId, typeId: typeIds[opts.typeCode], createdById: userIds.technical },
      });
      const data = {
        certificateNumber: opts.number,
        issuer: opts.issuer,
        issuedOn: opts.issuedOn ? d(opts.issuedOn) : null,
        validFrom: opts.issuedOn ? d(opts.issuedOn) : null,
        expiryKind: opts.expiryKind,
        expiryOn: opts.expiryOn ? d(opts.expiryOn) : null,
      };
      const request = await tx.certificateApprovalRequest.create({
        data: {
          certificateId: cert.id,
          kind: 'CREATE',
          status: 'APPROVED',
          version: 1,
          requestedById: userIds.technical,
          submittedAt: new Date(),
          decidedById: userIds.qhse,
          decidedAt: new Date(),
          decisionComment: 'Reprise initiale (seed de démonstration)',
          versions: { create: { versionNo: 1, ...data, createdById: userIds.technical, changeNote: 'Reprise initiale' } },
          decisions: { create: { versionNo: 1, deciderId: userIds.qhse, decision: 'APPROVE', comment: 'Reprise initiale' } },
        },
      });
      const rev = await tx.certificateRevision.create({
        data: {
          certificateId: cert.id,
          revisionNo: 1,
          ...data,
          lifecycle: 'CURRENT',
          approvedRequestId: request.id,
          approvedById: userIds.qhse,
          approvedAt: new Date(),
        },
      });
      await tx.certificate.update({
        where: { id: cert.id },
        data: {
          currentRevisionId: rev.id,
          currentNumber: opts.number,
          currentExpiryKind: opts.expiryKind,
          currentExpiryOn: data.expiryOn,
          documentMissing: true,
        },
      });
    });
  }
  // Statuts variés pour la démonstration des alertes (date de référence : octobre 2026)
  await seedCertificate({ typeCode: 'CLASS', vesselId: iskander.id, number: 'CLS-DEMO-001', issuer: 'Société de classification (démo)', issuedOn: '2022-03-15', expiryKind: 'DATED', expiryOn: '2027-03-15' });
  await seedCertificate({ typeCode: 'ISSC', vesselId: iskander.id, number: 'ISSC-DEMO-002', issuer: 'Administration du pavillon (démo)', issuedOn: '2021-11-02', expiryKind: 'DATED', expiryOn: '2026-11-02' });
  await seedCertificate({ typeCode: 'SMC', vesselId: iskander.id, number: 'SMC-DEMO-003', issuer: 'Administration du pavillon (démo)', issuedOn: '2021-09-30', expiryKind: 'DATED', expiryOn: '2026-09-30' });
  await seedCertificate({ typeCode: 'LL', vesselId: iskander.id, number: 'LL-DEMO-004', issuer: 'Société de classification (démo)', expiryKind: 'UNKNOWN' });
  await seedCertificate({ typeCode: 'REG', vesselId: iskander.id, number: 'REG-DEMO-005', issuer: 'Registre maritime (démo)', issuedOn: '2015-06-01', expiryKind: 'UNLIMITED' });
  await seedCertificate({ typeCode: 'MEDICAL', memberId: memberIds['AMC-DEMO-0001'], number: 'MED-DEMO-01', issuer: 'Médecin agréé (démo)', issuedOn: '2024-12-01', expiryKind: 'DATED', expiryOn: '2026-12-01' });
  await seedCertificate({ typeCode: 'BST', memberId: memberIds['AMC-DEMO-0001'], number: 'BST-DEMO-01', issuer: 'Centre de formation (démo)', issuedOn: '2020-02-01', expiryKind: 'DATED', expiryOn: '2025-02-01' });
  await seedCertificate({ typeCode: 'SSO', memberId: memberIds['AMC-DEMO-0001'], number: 'SSO-DEMO-01', issuer: 'Centre de formation (démo)', issuedOn: '2019-05-12', expiryKind: 'UNLIMITED' });
  await seedCertificate({ typeCode: 'COC', memberId: memberIds['AMC-DEMO-0002'], number: 'COC-DEMO-02', issuer: 'Administration maritime (démo)', issuedOn: '2022-04-20', expiryKind: 'DATED', expiryOn: '2027-04-20' });

  // ---------------------------------------------------------------- CSO : catégories & dossiers
  const csoCats: [string, string, string | null][] = [
    ['SSP', 'Ship Security Plan', 'CSO-SSP-{VESSEL}-{YYYY}-{SEQ:3}'],
    ['SSA', 'Ship Security Assessment', 'CSO-SSA-{VESSEL}-{YYYY}-{SEQ:3}'],
    ['DRILL', 'Exercices & entraînements sûreté', 'CSO-DRL-{YYYY}-{SEQ:4}'],
    ['DOS', 'Declarations of Security', 'CSO-DOS-{YYYY}-{SEQ:4}'],
    ['PROC', 'Procédures sûreté (flotte)', 'CSO-PRC-{YYYY}-{SEQ:3}'],
  ];
  for (const [i, [code, name, format]] of csoCats.entries()) {
    await prisma.csoCategory.upsert({
      where: { code },
      create: { code, name, referenceMode: 'AUTO', referenceFormat: format, requiredFields: ['description'], sortOrder: i },
      update: {},
    });
  }
  async function folder(libraryId: string, name: string, parentId: string | null, parentPath = '/', depth = 0) {
    const existing = await prisma.csoFolder.findFirst({ where: { libraryId, parentId, name, status: 'ACTIVE' } });
    if (existing) return existing;
    const f = await prisma.csoFolder.create({ data: { libraryId, parentId, name, path: '/', depth, createdById: userIds.cso } });
    return prisma.csoFolder.update({ where: { id: f.id }, data: { path: `${parentPath}${f.id}/` } });
  }
  const proc = await folder(central.id, 'Procédures sûreté', null);
  await folder(central.id, 'Formations & exercices', null);
  await folder(central.id, 'Circulaires & réglementation', null);
  const iskLib = await prisma.csoLibrary.findUniqueOrThrow({ where: { vesselId: iskander.id } });
  const sspFolder = await folder(iskLib.id, 'Ship Security Plan', null);
  await folder(iskLib.id, 'Declarations of Security', null);
  await folder(iskLib.id, 'Exercices sûreté', null);
  const confidential = await folder(iskLib.id, 'Annexes confidentielles', sspFolder.id, sspFolder.path, 1);
  // ACL exemple : annexes confidentielles limitées au département CSO
  const aclExists = await prisma.csoAclEntry.findFirst({ where: { folderId: confidential.id } });
  if (!aclExists) {
    await prisma.csoAclEntry.create({
      data: {
        folderId: confidential.id,
        principalType: 'DEPARTMENT',
        principalId: depts.CSO,
        actions: ['view', 'preview', 'download', 'view_archived', 'download_archived', 'edit', 'approve'],
        effect: 'ALLOW',
        createdById: userIds.cso,
      },
    });
    await prisma.csoFolder.update({ where: { id: confidential.id }, data: { inheritAcl: true } });
  }
  for (const f of [proc, sspFolder]) {
    const v = await prisma.csoFolderValidator.findFirst({ where: { folderId: f.id } });
    if (!v) await prisma.csoFolderValidator.create({ data: { folderId: f.id, principalType: 'DEPARTMENT', principalId: depts.CSO } });
  }

  // ---------------------------------------------------------------- Fournisseurs (fictifs)
  const suppliers = [
    { code: 'SUP-DEMO-01', name: 'Marine Supplies Démo SARL', currency: 'TND', country: 'TN', email: 'devis@marine-supplies-demo.local' },
    { code: 'SUP-DEMO-02', name: 'Ship Chandler Démo Ltd', currency: 'EUR', country: 'MT', email: 'sales@chandler-demo.local' },
    { code: 'SUP-DEMO-03', name: 'Engine Parts Démo SA', currency: 'EUR', country: 'FR', email: 'orders@engineparts-demo.local' },
  ];
  for (const s of suppliers) {
    await prisma.supplier.upsert({ where: { code: s.code }, create: { ...s, companyId: company.id, paymentTerms: '30 jours fin de mois' }, update: {} });
  }

  // ---------------------------------------------------------------- PR n°323 (CDC §6.3)
  const prNumber = 'ISK-PR-2026-0323';
  if (!(await prisma.purchaseRequest.findUnique({ where: { number: prNumber } }))) {
    await prisma.purchaseRequest.create({
      data: {
        number: prNumber,
        vesselId: iskander.id,
        requesterId: userIds['chief.iskander'],
        requestDate: d('2026-02-03'),
        category: 'Consommable machine',
        priority: 'NORMAL',
        subject: 'Consommable machine',
        formRef: 'FORM 41 - Rev N°00',
        status: 'SUBMITTED',
        submittedAt: new Date('2026-02-03T08:00:00Z'),
        // Même format que le circuit appliqué par le module Achats à la soumission (AppliedReviewCircuit)
        reviewCircuit: {
          ruleId: 'CHIEF_ENGINEER',
          label: 'PR Chief Engineer — revue Purchasing, sans visa Captain systématique (PUR-01)',
          captainApprovalRequired: false,
          evaluatedAt: '2026-02-03T08:00:00.000Z',
          facts: { requesterRoles: ['CHIEF_ENGINEER'], category: 'Consommable machine', priority: 'NORMAL', departmentId: null },
          steps: [
            {
              key: 'PURCHASING_APPROVAL',
              label: 'Revue et approbation Purchasing',
              permission: 'pr.approve',
              status: 'PENDING',
              actorId: null,
              actorName: null,
              at: null,
              comment: null,
            },
          ],
        },
        comment: 'Exemple repris du fichier 323consommable.xlsx (quantités du 4e article à confirmer).',
        lines: {
          create: [
            { lineNo: 1, designation: 'Lampe torche rechargeable', quantityRequested: new Prisma.Decimal(3), unit: 'pcs' },
            { lineNo: 2, designation: 'Baladeuse', quantityRequested: new Prisma.Decimal(2), unit: 'pcs' },
            { lineNo: 3, designation: 'Courroie', reference: '22 x 1650 Li', quantityRequested: new Prisma.Decimal(10), unit: 'pcs' },
            { lineNo: 4, designation: 'Antigel — liquide de refroidissement', quantityRequested: new Prisma.Decimal(1), unit: 'bidon', remarks: 'Quantité exprimée en litres/bidons dans la source : à confirmer' },
          ],
        },
      },
    });
    await prisma.numberSequence.upsert({ where: { key: 'PR:ISK:2026' }, create: { key: 'PR:ISK:2026', nextValue: 324 }, update: {} });
  }

  // ---------------------------------------------------------------- Voyage Gabès -> Varna (CDC §7.3)
  const voyageRef = 'ISK-VOY-2026-0001';
  if (!(await prisma.voyage.findUnique({ where: { reference: voyageRef } }))) {
    await prisma.$transaction(async (tx) => {
      const voyage = await tx.voyage.create({
        data: {
          reference: voyageRef,
          vesselId: iskander.id,
          status: 'PLANNED',
          charterer: 'SEMBODJA CO. LTD',
          description: 'Gabès, Tunisie (Load Port) → Varna, Bulgarie (Discharge Port)',
          laycanFrom: d('2026-04-22'),
          laycanTo: d('2026-04-25'),
          notes: 'Références financières et broker volontairement exclues de la source : ne pas les inventer.',
          createdById: userIds.operations,
        },
      });
      const loadAgent = await tx.voyageAgent.create({ data: { voyageId: voyage.id, role: 'LOAD_AGENT', name: 'CHIMAG', city: 'Gabès' } });
      const dischAgent = await tx.voyageAgent.create({ data: { voyageId: voyage.id, role: 'DISCHARGE_AGENT', name: 'ATRIS SHIPPING AGENCY', city: 'Varna' } });
      const load = await tx.voyagePort.create({ data: { voyageId: voyage.id, sequence: 1, type: 'LOAD', portName: 'Gabès', country: 'TN', agentId: loadAgent.id, notes: 'NOR : WWWW, office hours load 08:00–17:00 Mon–Fri (texte contractuel, non interprété)' } });
      await tx.voyagePort.create({ data: { voyageId: voyage.id, sequence: 2, type: 'DISCHARGE', portName: 'Varna', country: 'BG', agentId: dischAgent.id } });
      await tx.cargo.create({
        data: {
          voyageId: voyage.id,
          commodity: 'DAP Fertiliser in Bulk',
          description: 'One grade, harmless/non-dangerous selon document',
          qtyMinMt: new Prisma.Decimal(3000),
          qtyMaxMt: new Prisma.Decimal(3300),
          quantityOption: 'owners option',
          stowageFactor: new Prisma.Decimal(40),
          stowageFactorUnit: 'cbft/MT WOG (approx.)',
        },
      });
      await tx.voyageInstruction.create({
        data: {
          voyageId: voyage.id,
          versionNo: 1,
          title: 'Voyage Instructions — Gabès → Varna',
          status: 'ISSUED',
          issuedById: userIds.operations,
          issuedAt: new Date(),
          createdById: userIds.operations,
          notices: 'Fixing, daily, 12 hours definite ; 5/4/3/2/1 jours au load port ; daily après départ du load port pour Varna',
          fields: {
            complianceChecks: ['Class', 'P&I', 'ISM', 'ISPS/ISSC', 'Seaworthiness'],
            masterChecklist: ['Notices', 'Surveys', 'Holds', 'Bills of Lading', 'NOR', 'Cargo readiness'],
            norLaytime: 'Clauses contractuelles à stocker ; ne pas inventer de règles universelles.',
          },
        },
      });
      const tasks = ['Notices', 'Surveys', 'Holds cleanliness', 'Bills of Lading', 'NOR', 'Cargo readiness'];
      await tx.voyageTask.createMany({
        data: tasks.map((title, i) => ({ voyageId: voyage.id, portId: load.id, title, category: 'MASTER_CHECKLIST', sortOrder: i })),
      });
      const notices = ['5 jours', '4 jours', '3 jours', '2 jours', '1 jour'];
      await tx.voyageNotice.createMany({
        data: notices.map((label, i) => ({
          voyageId: voyage.id,
          portId: load.id,
          kind: 'ETA_NOTICE',
          scheduleLabel: `Arrival notice ${label} avant arrivée Gabès`,
          dueAt: new Date(Date.UTC(2026, 3, 17 + i, 8)),
          recipients: 'Charterer, agent CHIMAG',
        })),
      });
    });
    await prisma.numberSequence.upsert({ where: { key: 'VOY:ISK:2026' }, create: { key: 'VOY:ISK:2026', nextValue: 2 }, update: {} });
  }

  console.log('Seed AMC terminé.');
  console.log(`  Super Admin : ${process.env.SEED_ADMIN_USERNAME ?? 'admin'} / (SEED_ADMIN_PASSWORD)`);
  console.log(`  Comptes démo : captain.iskander, chief.iskander, crewing, technical, qhse, purchasing, purchasing.manager, cso, cso.deputy, operations, direction, dpa, ops.manager, commercial / (SEED_DEMO_PASSWORD)`);
  console.log('  Compte "nouveau" : mot de passe temporaire à changer à la première connexion.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
