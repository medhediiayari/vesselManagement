# Architecture & conventions — Plateforme AMC

> Référence : `AMC_Cahier_des_Charges_Complet_Developpement_2026.pdf` (édition consolidée 11/10/2026).
> En cas de divergence, l'édition consolidée prévaut sur l'annexe V1.

## 1. Vue d'ensemble

```
Navigateur ──► Next.js (apps/web, :3100) ──/api/*──► NestJS (apps/api, :4000, /api/v1)
                                                      ├── PostgreSQL 16 (:5434)  — source d'autorité
                                                      ├── MinIO (:9100)          — blobs PDF / Excel / images (buckets privés)
                                                      ├── Redis + BullMQ (:6380) — e-mails, scans AV, rappels, imports, exports
                                                      └── SMTP (Mailpit :1025 en dev)
```

- **Monolithe modulaire** (CDC §1.1) : un module Nest par contexte métier sous `apps/api/src/modules/`.
- **La base fait autorité** : invariants en contraintes SQL (CHECK, index partiels, triggers append-only) — voir
  `apps/api/prisma/migrations/0002_db_hardening/migration.sql`.
- **Aucun blob en base** : `files` contient les métadonnées (SHA-256, MIME réel, statut antivirus, propriétaire),
  le contenu est dans MinIO (`amc-files`, `amc-quarantine`, `amc-exports`).

## 2. Workflow de base de données

- Schéma : `apps/api/prisma/schema.prisma` (tables snake_case, PK UUID, `timestamptz`, montants `DECIMAL`).
- Appliquer : `npm run db:migrate` (= `prisma migrate deploy`). **Ne jamais utiliser `prisma migrate dev`** :
  il supprimerait les objets SQL de `0002` (index partiels, trigrammes, colonne FTS générée).
- Nouvelle migration : modifier `schema.prisma`, puis `npm run prisma:diff -w @amc/api` → copier le SQL dans
  `prisma/migrations/00NN_nom/migration.sql`, **retirer** les lignes parasites connues
  (`CREATE EXTENSION`, `ALTER COLUMN "search_tsv" DROP DEFAULT`, `DROP INDEX` des objets de 0002), relire, appliquer.
- Numéros réservés par domaine : members `0010-0019`, certificates `0020-0029`, cso `0030-0039`,
  purchasing `0040-0049`, voyages/noon `0050-0059`, plateforme `0060+`.

## 3. Conventions API (NestJS)

### Structure d'un module
```
modules/<domaine>/
  <domaine>.module.ts       # @Module ; déjà importé dans app.module.ts
  <x>.controller.ts         # contrôleurs minces : décorateurs de permission + délégation au service
  <x>.service.ts            # règles métier, transactions, audit, notifications
  <x>.dto.ts                # schémas Zod + classes createZodDto (validation + OpenAPI)
  <x>.spec.ts               # tests unitaires (jest) des règles pures (états, calculs)
```

### Autorisation (formule CDC §2.1) — à appliquer sur CHAQUE route
1. `@RequirePermissions('x.y')` / `@RequireAnyPermission(...)` sur la route (vérifié par `AuthGuard`, global).
2. Dans le service, **sur chaque enregistrement lu ou modifié** : `this.access.assertVesselAccess(ctx, record.vesselId)`.
3. Listes : filtrer avec `vesselWhere(ctx)` (ou `vesselWhere(ctx, 'vesselId')` sur une relation) — jamais de filtrage côté UI seul.
4. ACL ressource / champ / condition de workflow : vérifiées dans le service (ex. CSO).
5. Récupérer le contexte : paramètre `@Auth() ctx: AuthContext` (`modules/access/auth-context.ts` : `can`, `canAccessVessel`, `vesselWhere`, `principalsOf`).
6. Pour un autre utilisateur (validateur, destinataire) : `access.usersWithPermission(perm, vesselId)` / `access.userCan(...)`.

### Erreurs (`common/errors.ts`)
`Errors.forbidden` 403, `Errors.scopeDenied` 403, `Errors.aclDenied` 403, `Errors.selfApproval` 403,
`Errors.notFound` 404, `Errors.staleVersion` 409, `Errors.alreadyProcessed` 409, `Errors.invalidState` 409,
`Errors.duplicate` 409, `Errors.validation` 422, `Errors.business` 422, `Errors.fileRejected` 422.
Tous les 403 d'un utilisateur authentifié sont audités automatiquement (`AllExceptionsFilter`).

### DTO (Zod)
- `createZodDto(schema)` ; helpers `common/pagination.ts` : `PaginationSchema`, `cursorArgs`, `toPage`,
  `dateOnly` (AAAA-MM-JJ → Date UTC), `decimalString({min, scale})` (jamais de float pour montants/quantités),
  `isoCurrency`, `countryCode`, `queryBool`.
- Les `Prisma.Decimal` sont sérialisés en chaîne JSON automatiquement. Les `BigInt` doivent être convertis.

### Machines à états (CDC §12)
- Transitions par **commandes** (`POST /x/:id/submit`, `/approve`…), jamais par `PATCH status`.
- Table de transitions explicite dans le service (`const TRANSITIONS: Record<From, To[]>`), testée en unitaire.
- **Verrou optimiste** : le client envoie `expectedVersion` ; mise à jour via
  `updateMany({ where: { id, lockVersion: expected }, data: { ..., lockVersion: { increment: 1 } } })` → `count === 0` ⇒ `Errors.staleVersion()`
  (ou `Errors.alreadyProcessed()` si l'état a déjà changé — CERT-04 « déjà traité »).
- **Séparation demandeur / validateur** : `if (request.requestedById === ctx.userId) throw Errors.selfApproval()` — même pour un Super Admin (CERT-03).
- Transactions : `this.prisma.$transaction(async (tx) => { ... })` ; `this.prisma.serializable(fn)` pour les approbations concurrentes.

### Audit (`AuditService`)
- Toute mutation : `await this.audit.record(ctx, { action, module, entityType, entityId, vesselId, before, after, metadata }, tx)`
  **dans** la transaction. Modules : `admin | auth | fleet | members | certificates | cso | purchasing | voyages | noon | platform`.
- `diffFields(before, after)` pour ne journaliser que les champs modifiés.
- Consultations sensibles (preview / download / ZIP / share) : auditées (FilesService le fait pour preview/download).

### Fichiers (PDF, Excel, images) — `modules/files`
1. Le client dépose : `POST /api/v1/files` (multipart `file`, `context`, `vesselId?`) → `{ id, kind, sha256, scanStatus, … }`.
   Contrôles : permission par contexte, scope navire, taille, type réel (magic bytes), liste blanche par contexte,
   PDF sans JavaScript, SHA-256, quarantaine + antivirus si `AV_MODE=clamav`.
2. L'objet métier reçoit `fileId` et le rattache **dans sa transaction** :
   `await this.files.attach(ctx, fileId, { type: OWNER_TYPE, id: entityId, contexts: ['CERTIFICATE'], vesselId }, tx)`.
   Un fichier n'est rattachable qu'une fois (trigger DB) ; pour réutiliser un blob : `files.cloneReference(...)`.
3. Le module enregistre un resolver d'accès dans `onModuleInit()` :
   `this.registry.register(OWNER_TYPE, async (ctx, file, mode) => { /* contrôles permission+scope+ACL selon mode */ return { module, entityType, entityId, vesselId, downloadName? }; })`.
   Modes : `meta | preview | thumbnail | download` — **download exige une permission distincte de view** (CERT-06/07, CSO-008).
4. Liens : `GET /files/:id/preview|download|thumbnail` (générique) ou route métier dédiée qui fait ses contrôles puis
   `this.files.issueLink(ctx, file, 'download', grant)` → URL signée MinIO 60 s (aucune URL publique durable).
5. Fichiers générés (PDF BC, Noon Report…) : `this.pdf.render(meta, (b) => b.section(...).fields(...).table(...))` puis
   `this.files.storeGenerated(buffer, 'BC-….pdf', 'PDF', 'application/pdf', 'GENERATED', vesselId, ctx.userId, { type: OWNER_TYPE, id })`.
6. Lecture serveur (imports Excel / ZIP) : `this.files.readBuffer(file)` ; Excel : `ExcelService.readWorkbook(buffer)`,
   `ExcelService.parseDate(v)` (JJ.MM.AAAA, dates Excel, PERMANENT → UNLIMITED, vide → EMPTY).

### Notifications & e-mails
`await this.notifications.notify({ userIds?, principals?, type, title, body, module, entityType, entityId, vesselId, link, priority, dedupeKey, email: true, requiredPermission }, tx)`
— les destinataires sont **filtrés sur leurs droits réels + scope navire** ; `dedupeKey` évite les doublons ;
les e-mails sont journalisés (`email_deliveries`) et jamais déclarés envoyés si le transport échoue.

### Tâches planifiées / jobs
- `SchedulerRegistry.register(SCHEDULED_JOBS.X, async () => ({ ...stats }))` dans `onModuleInit()` ; exécution tracée dans `job_runs`.
- Files BullMQ : `QUEUES.IMPORTS`, `QUEUES.EXPORTS` (injecter avec `@InjectQueue(QUEUES.IMPORTS)` ; un `@Processor` par module si besoin, enregistré seulement si `env().WORKERS_ENABLED`).

### Numérotation
`await this.numbering.nextFormatted('PR', vessel.code, tx)` → `ISK-PR-2026-0324` (atomique).

## 4. Modèle Certificats (contrat partagé Members ⇄ Certificates)

- `certificates` : certificat logique (sujet VESSEL xor MEMBER + type). Champs dénormalisés de la révision courante
  (`current_number`, `current_expiry_kind`, `current_expiry_on`, `document_missing`).
- `certificate_approval_requests` : demande (CREATE / RENEWAL / CORRECTION / ATTACHMENT), `status`, `version` (= n° de la
  dernière version immuable), `requested_by_id`. Une seule demande « données » ouverte par certificat (index partiel).
- `certificate_request_versions` : snapshot immuable de chaque version (trigger) ; `file_id` facultatif.
- À l'approbation (transaction) : création `certificate_revisions` (CURRENT, immuable), archivage de l'ancienne
  révision (ARCHIVED), mise à jour `certificates.current_*`, pièce jointe éventuelle → `certificate_attachments` OFFICIAL.
- **Import Excel Members** : pour chaque certificat importé, créer `certificates` (si absent pour member+type) +
  `certificate_approval_requests` (kind CREATE, status PENDING_APPROVAL, version 1, submittedAt) +
  `certificate_request_versions` v1. **Jamais d'approbation automatique** ; scans ajoutés plus tard.
- Validité calculée (non stockée) : VALID / EXPIRING_SOON / EXPIRED / UNLIMITED / EXPIRY_UNKNOWN
  (`certificates.expiringSoonDays`, défaut 90 ; seuils de la politique de rappel).

## 5. Sécurité transversale
- Session : cookie HttpOnly `amc_sid` (SHA-256 stocké), CSRF double-submit (`amc_csrf` + en-tête `x-csrf-token`),
  timeout d'inactivité configurable, droits recalculés à chaque requête.
- Argon2id ; verrouillage après 5 échecs, déblocage admin uniquement avec mot de passe temporaire.
- Délégation : `access.assertCanGrant(ctx, permissions)` / `assertCanGrantVessels`.
- Pas d'URL publique : buckets MinIO privés, URL signées 60 s émises après contrôle des droits et audit.

## 6. Interface web — direction « Passerelle »

Objectif : un outil d'exploitation de flotte, pas un template SaaS (skill `.claude/skills/amc-frontend-design`).

- **Jetons** (`apps/web/tailwind.config.ts`) : structure `navy` (#102B44), action `action` = ocean #176A79
  (6,2:1 sur blanc ; le nom historique est conservé, tous les boutons et liens en héritent), fond `canvas`,
  `surface.sunken` pour les en-têtes de panneaux et de tableaux. `ink.soft` reste ≥ 4,5:1 (texte AA).
- **Typographie** : IBM Plex Sans (interface) ; IBM Plex Mono **uniquement** pour les identifiants via la
  classe `.ref` (IMO, MMSI, indicatif, code navire, n° PR/BC/RFQ/BL/facture, voyage, certificat, matricule).
  Les compteurs, dates et heures utilisent `.tabular` (Plex Sans à chiffres tabulaires), pas la chasse fixe.
- **Surfaces** : panneaux plats à filet (`shadow-panel` = filet 1 px, pas d'ombre portée). Pas de mosaïque de
  tuiles : chiffres en registre (`components/amc/register.tsx`, lignes libellé / valeur alignée à droite) ou en
  lecture d'instrument (`.gauge`, filet vertical). Statuts en étiquettes rectangulaires, toujours libellées.
- **Shell** : monogramme AMC (`components/shell/brand.tsx`), rappel du périmètre en pied de navigation,
  sélecteur de navire mis en évidence quand un contexte restreint est actif (IMO affiché pour un navire),
  horloge UTC + heure bord (`watch-clock.tsx`, fuseau de la fiche navire ; affichage seulement).
- **Tableau de bord** : file « Actions requises » priorisée (Critique / À traiter / Suivi) construite à partir des
  seuls chiffres de `/dashboard`, registre chiffré, « État de la flotte » (une ligne par navire via
  `/vessels/:id/workspace`, sections filtrées par permissions côté serveur, 20 navires max), horizon des échéances.
  En tête, une bande « Situation » (fond marine) reprend ces mêmes chiffres. Pour les profils d'administration,
  une console (`components/dashboard/`) affiche, volet par volet selon `users.view` / `audit.view.admin` /
  `settings.manage` : comptes (actifs, verrouillés, désactivés), sécurité sur 24 h (échecs de connexion, accès
  refusés, compteurs bornés à « 200+ » par la pagination) et état du système (`/system/status`). Ses signaux
  critiques alimentent aussi la file d'actions. Les liens arrivent pré-filtrés (`/admin/users?status=LOCKED`,
  `/admin/audit?result=DENIED&from=AAAA-MM-JJ`).
- **Grilles** : `.grid` a une piste par défaut `minmax(0,1fr)` (globals.css) pour empêcher un contenu insécable
  d'élargir la page sur mobile ; les `grid-cols-*` restent prioritaires.
