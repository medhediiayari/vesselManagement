# Audit fonctionnel — Plateforme AMC

**Date** : 30/10/2026 · **Version auditée** : branche `main` (commit `1a502c4`) et modifications non commitées du module Certificats (dossiers, catégories, approbateurs).
**Nature** : audit uniquement. **Aucune correction n'a été apportée au code.**
**Suivi (30/10/2026)** : les corrections, les décisions métier en attente et les nouveaux problèmes sont dans [audit-suivi.md](audit-suivi.md).

---

## 1. Synthèse

| Sévérité | Nombre |
|---|---|
| 🔴 Critique | 4 |
| 🟠 Majeure | 31 |
| 🟡 Mineure | 74 |
| **Total** | **109** |

| Module | Préfixe | Constats |
|---|---|---|
| Interface (parcours navigateur) et données transverses | `UI`, `DAT` | 10 |
| Authentification, administration, tableau de bord, recherche, exports, fichiers | `ADM` | 30 |
| Flotte, marins, affectations, voyages, Charter Parties, Noon Reports | `FLT` | 25 |
| Certificats | `CRT` | 15 |
| Documents CSO | `CSO` | 14 |
| Achats (PR → RFQ → BC → BL → réception → facture) | `ACH` | 15 |

Chaque constat a été **vérifié**, par un appel API dont la réponse a été observée, par une action dans le navigateur ou par la lecture du code (fichier et ligne cités). Les constats issus uniquement de la lecture du code sont signalés comme tels.

### À traiter en priorité

| ID | Constat | Pourquoi c'est urgent |
|---|---|---|
| **FLT-01** 🔴 | Un fuseau horaire invalide sur un navire fait planter toute l'application | Une simple faute de frappe dans un formulaire, et l'interface ne s'affiche plus, même après rechargement |
| **ACH-01** 🔴 | Le Chief Engineer peut lire et ajouter des pièces jointes sur les PR, BL et réceptions des autres | Contournement du cloisonnement « ses propres PR » |
| **ACH-02** 🔴 | Une PR mise en attente puis livrée se retrouve bloquée sans aucune issue | Aucune action ne permet de la reprendre, de l'annuler ou de la clôturer |
| **CSO-01** 🔴 | L'aperçu d'un Word ou d'un Excel livre le fichier complet à un compte sans droit de téléchargement | Fuite de documents de sûreté |
| ADM-01 🟠 | La recherche globale affiche les PR d'autres demandeurs | Fuite de données |
| ADM-02 🟠 | Redirection vers un site externe après connexion (`/login?next=/\site.tld`) | Hameçonnage |
| ADM-03 🟠 | Les anciens liens de réinitialisation restent valides, même après un mot de passe temporaire émis par l'admin | Prise de contrôle de compte |
| CSO-02 🟠 | Un sous-dossier dont l'héritage est rompu devient lisible par tous, alors qu'il reste caché dans l'arbre | Fuite de documents de sûreté |
| FLT-02 🟠 | « Équipage à une date » : 50 personnes à bord au lieu de 2 | Effectif faux (sécurité, conformité) |
| DAT-01 🟠 | La base réelle contient des lignes qui violent une clé étrangère : la restauration d'une sauvegarde échoue | Plan de reprise après sinistre |

### Points d'attention transverses
- **Messages d'erreur en anglais** (`Invalid email`, `String must contain…`, `ThrottlerException`, `File too large`). Cela touche tous les modules (ADM-18, ADM-19, FLT-14). Une seule carte d'erreurs Zod en français réglerait l'essentiel.
- **Dates invalides** : une date inexistante (30 février) est décalée sans prévenir, un mois 13 provoque une erreur 500, et les dates futures ou incohérentes sont acceptées (FLT-03, FLT-06, ACH-11). La correction se fait à un seul endroit, `dateOnly` dans `apps/api/src/common/pagination.ts`.
- **Codes techniques affichés aux utilisateurs** (`EXCEEDS_ORDERED`, `IDLE_TIMEOUT`, `COMPLETED`, `LAYCANFROM`, `PRIORITÉ NORMAL`) : UI-02, ADM-24, ADM-26, FLT-10, FLT-15, ACH-15.
- **403 au lieu de 404**, ce qui permet de tester l'existence d'une ressource cachée (CRT-15, CSO-13).

---

## 2. Méthode et environnement

- **Parcours navigateur** (Playwright MCP) : 39 pages ouvertes avec le compte Super Admin, avec relevé des erreurs console et des requêtes API en échec. Navigation et actions vérifiées pour `captain.iskander`, `chief.iskander`, `direction` et `commercial`. Rendu mobile testé en 390 px. Validation des formulaires testée (PR vide, quantité négative).
- **Tests API** : quatre campagnes en parallèle, une par groupe de modules. Elles ont déroulé de vrais scénarios de bout en bout ainsi que des cas limites : droits, cloisonnement navire, transitions d'état, concurrence, idempotence, saisies invalides.
- **Isolation** : toutes les écritures ont été faites sur une **copie de la base** (`amc_e2e`) servie par une seconde API (port 4001) et un proxy (http://127.0.0.1:3101). **La base réelle `amc` n'a reçu aucune écriture** ; elle n'a été lue que pour les contrôles de qualité des données (section 9).
- **Décisions métier connues, volontairement non signalées** : justificatif PDF facultatif pour les certificats des marins, absence d'e-mail aux fournisseurs, données Achats purgées le 21/10, publication directe `self_approve`, arborescence des certificats affichée seulement à partir de 1536 px.

Format de chaque constat : **Type · Sévérité**, puis **Emplacement** (page et fichier:ligne), **Cas** (reproduction : observé → attendu) et **Correction proposée**.

---

## 3. Interface et données transverses (parcours navigateur)

### [UI-01] Nouvelle PR sur mobile : toute la page déborde horizontalement
**Bug · 🟠 Majeure**
- **Emplacement** : `/purchasing/requests/new` (tablette et téléphone à bord) · `apps/web/components/purchasing/pr-draft-form.tsx:407-408`
- **Cas** : `captain.iskander`, écran de 390 px. La largeur de la page passe à 828 px, le navigateur dézoome et une bande blanche apparaît à droite de l'en-tête. Les colonnes Qté et Unité sont hors écran. Cause : le libellé masqué `sr-only` « Actions » de l'en-tête du tableau est positionné en absolu. Son bloc conteneur est situé hors de la zone `overflow-x-auto`, donc il n'est pas rogné et il élargit la page.
- **Correction proposée** : ajouter `relative` sur le conteneur `div.overflow-x-auto`, ou sur le `th` des actions. Sur mobile, passer les lignes en cartes empilées (désignation, quantité, unité) et masquer l'aide clavier (« Entrée : ligne suivante · ↑/↓ »).

### [UI-02] Notification de facture : motifs affichés en codes bruts
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/notifications` · `apps/api/src/modules/purchasing/invoices.service.ts:184`
- **Cas** : une facture en écart affiche « Motifs : EXCEEDS_ORDERED, EXCEEDS_RECEIVED ».
- **Correction proposée** : traduire les motifs, par exemple « dépasse le montant commandé » et « dépasse les quantités reçues ».

### [UI-03] Affectation terminée sans date de débarquement : durée calculée jusqu'à aujourd'hui
**Bug · 🟡 Mineure**
- **Emplacement** : `/members` (aperçu) et `/members/[id]` · `apps/web/components/members/member-summary.tsx:424` et `:445`
- **Cas** : ABDALLAH Houssine a une affectation COMPLETED, embarquée le 13/04/2026, sans débarquement. Le tableau affiche « Débarquement — » et « Durée 7 mois ». En effet, `end = null`, et `daysBetween` compte alors jusqu'à aujourd'hui. Le cas concerne 48 affectations dans la base réelle.
- **Correction proposée** : pour un statut différent de `ONBOARD` sans `actualSignOffDate`, afficher « — » ou « date de débarquement manquante » au lieu d'une durée. Voir aussi FLT-02 et FLT-09.

### [UI-04] L'en-tête affiche l'heure UTC, mais les dates de la page sont en heure locale du navigateur
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/` · `apps/web/app/(app)/page.tsx:34-35,202` ; `/purchasing/requests/new` · `apps/web/app/(app)/purchasing/requests/new/page.tsx:191`
- **Cas** : l'horloge de l'en-tête indique « UTC 23:47 » alors que le tableau de bord affiche « Vendredi 30 octobre 2026 · données de 00:47 », et que la PR affiche « Saisie conservée localement à 30/10/2026 00:49 ». Sur un même écran, la date et l'heure diffèrent d'un jour et d'une heure.
- **Correction proposée** : choisir une référence unique (UTC, ou heure du navire sélectionné) et l'indiquer, par exemple « 00:47 (heure locale) », ou utiliser `timeZone: 'UTC'` comme l'horloge.

### [UI-05] Marins & personnel : l'aperçu de la fiche sélectionnée est placé sous une liste de 50 lignes
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/members` · `apps/web/app/(app)/members/page.tsx:455-458`
- **Cas** : sur grand écran, la première fiche est sélectionnée automatiquement, mais son aperçu (profil, conformité, échéances) s'affiche sous les 50 lignes de la liste. L'utilisateur ne le voit qu'en faisant défiler toute la page.
- **Correction proposée** : utiliser un panneau latéral fixe à droite, comme dans `/certificates`, ou un aperçu en tiroir.

### [UI-06] Profil en lecture seule (Direction) : le bloc « Actions requises » l'invite à agir
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/` · `apps/web/components/dashboard/action-queue.tsx:35`
- **Cas** : avec `direction` (rôle Viewer), le tableau de bord affiche « Actions requises 5 » avec les mentions « Critique » et « À traiter » (certificats expirés, écarts de réception…). Ce profil ne peut rien traiter.
- **Correction proposée** : pour un profil sans droit d'écriture, renommer le bloc en « Points de vigilance » et retirer les mentions « À traiter ».

### [UI-07] Fiche navire : deux notations différentes pour un champ vide
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/vessels/[id]` · `apps/web/app/(app)/vessels/[id]/page.tsx`
- **Cas** : l'en-tête affiche « Non renseigné » (pavillon, MMSI, classe…) et le bloc « Caractéristiques » affiche « — » (gestionnaire, jauge…), sur le même écran.
- **Correction proposée** : utiliser une seule notation (« Non renseigné ») et proposer le lien « Compléter » à qui a `vessels.edit`.

### [UI-08] Certificats : le tri par défaut fait remonter des certificats expirés depuis 2016
**Amélioration UI / Données · 🟡 Mineure**
- **Emplacement** : `/certificates` (tri « Échéance la plus proche »)
- **Cas** : la liste commence par RABEH Soussie, « expiré depuis 3648 j », suivi de 7 certificats de 2016. Dans la base réelle, 148 certificats actifs ont expiré depuis plus de 3 ans, et 8 appartiennent à des marins inactifs. Les échéances utiles (expirations dans les 30 jours) se retrouvent noyées.
- **Correction proposée** : trier par défaut sur « à échoir d'abord » (non expirés les plus proches, puis expirés récents). Proposer un archivage en lot des certificats expirés depuis plus de N ans ou rattachés à des marins inactifs.

### [UI-09] PR : une quantité négative est signalée comme « ligne incomplète »
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/purchasing/requests/new` · `apps/web/components/purchasing/pr-draft-form.tsx`
- **Cas** : une ligne avec désignation, unité et quantité −5 produit le toast « Ligne(s) 1 incomplète(s) ». Le champ accepte −5 sans le marquer en erreur.
- **Correction proposée** : afficher l'erreur sur le champ (« Quantité > 0 ») avec `aria-invalid`, et utiliser `min="0"` ou un filtrage à la saisie.

### [DAT-01] Base réelle : 6 envois d'e-mails pointent vers des notifications supprimées, ce qui casse la restauration des sauvegardes
**Données · 🟠 Majeure**
- **Emplacement** : table `email_deliveries`, contrainte `email_deliveries_notification_id_fkey` (`ON DELETE SET NULL`, validée)
- **Cas** : `pg_dump` de la base `amc` suivi de `pg_restore` dans une base vide donne « violates foreign key constraint email_deliveries_notification_id_fkey » et une contrainte non recréée. 6 lignes (SENT, datées des 13, 18 et 26/10) référencent des notifications absentes. Ce n'est possible que si des suppressions ont été faites avec les déclencheurs désactivés (`session_replication_role = replica`), probablement lors de la purge Achats du 21/10. **Une restauration de sauvegarde produit donc une base sans cette contrainte.**
- **Correction proposée** : `UPDATE email_deliveries SET notification_id = NULL WHERE notification_id NOT IN (SELECT id FROM notifications)`, par une migration de données relue. Ne plus purger avec les déclencheurs désactivés. Ajouter un test de restauration au runbook (`docs/EXPLOITATION.md`).

---

## 4. Authentification, administration et fonctions transverses

### [ADM-01] La recherche globale révèle les Purchase Requests d'autres demandeurs
**Sécurité · 🟠 Majeure**
- **Emplacement** : `/search` et la barre de recherche · `apps/api/src/modules/dashboard/search.service.ts:68-71`
- **Cas** : `chief.iskander` (a `pr.view` mais pas `pr.view_all`) lance `GET /search?q=ISK-PR-2026-0336`, une PR du capitaine. Il obtient le numéro, l'objet et le statut de la PR, alors que `GET /purchase-requests/{id}` lui répond 404.
- **Correction proposée** : ajouter `...prOwnFilter(ctx)` et `...poOwnFilter(ctx)` (`purchasing-core.service.ts:101-107`) aux requêtes de recherche.

### [ADM-02] Redirection ouverte après connexion
**Sécurité · 🟠 Majeure**
- **Emplacement** : `/login` · `apps/web/app/(auth)/login/page.tsx:30`
- **Cas** : `/login?next=/%5Cevil.example` donne `"/\evil.example"`, qui passe le contrôle `startsWith('/') && !startsWith('//')`. Or `new URL('/\\evil.example', origin)` vaut `http://evil.example/`, et le routeur Next fait un `location.replace` vers ce site après la connexion. Vérifié par la résolution d'URL et la lecture du code de Next 14.2.35.
- **Correction proposée** : `const u = new URL(next, location.origin); if (u.origin !== location.origin) next = '/'`.

### [ADM-03] Les liens de réinitialisation du mot de passe ne sont jamais invalidés
**Sécurité · 🟠 Majeure**
- **Emplacement** : `/reset-password` · `apps/api/src/modules/auth/auth.service.ts:202` ; `apps/api/src/modules/admin/users.service.ts` (`issueTemporaryPassword`)
- **Cas** : on fait deux demandes « mot de passe oublié », puis l'admin émet un mot de passe temporaire (par exemple après une compromission). Les deux anciens liens restent valides (204 et 204) et remettent `must_change_password` à `false`.
- **Correction proposée** : renseigner `usedAt` sur tous les jetons en cours à chaque nouvelle demande et à chaque `changePassword`, `resetPassword` ou `issueTemporaryPassword`.

### [ADM-04] Mot de passe oublié sur un compte verrouillé : l'écran confirme le changement, mais la connexion reste impossible
**Bug · 🟠 Majeure**
- **Emplacement** : `/forgot-password`, `/reset-password`, `/login` · `apps/api/src/modules/auth/auth.service.ts:185-229` ; `apps/web/app/(auth)/login/page.tsx:32`
- **Cas** : sur un compte verrouillé, l'e-mail de réinitialisation part. La réinitialisation répond 204 avec le message « Mot de passe mis à jour », puis la connexion répond 401 (le compte est toujours verrouillé). Le déverrouillage par l'admin écrase ensuite le mot de passe choisi. Le message « seul un administrateur peut débloquer » de la page de connexion ne s'affiche jamais, car l'API ne renvoie pas `ACCOUNT_LOCKED`.
- **Correction proposée** : ne pas envoyer de lien aux comptes `lockedAt`, ou refuser la réinitialisation avec « Compte verrouillé : contactez un administrateur ». Supprimer le code mort.

### [ADM-05] Un Super Admin peut se retirer ses propres droits et ne plus pouvoir les rétablir
**Bug · 🟠 Majeure**
- **Emplacement** : `/admin/users/[id]`, onglet Exceptions · `apps/api/src/modules/admin/users.service.ts:235,434-436` ; `apps/api/src/modules/access/access.service.ts:85`
- **Cas** : un compte SUPER_ADMIN pose une exception DENY `permissions.manage` sur lui-même (200). Il ne peut plus la retirer (403). Avec un DENY quelconque, il reçoit en plus « Seul un Super Admin peut gérer un compte Super Admin ». Sur le dernier Super Admin, seule une intervention en base permet de réparer.
- **Correction proposée** : interdire tout DENY sur soi-même pour `permissions.manage`, `users.*` et `roles.*`. Traiter le cas « soi-même » avant le contrôle Super Admin dans `loadManageable`.

### [ADM-06] Tableau de bord filtré sur un navire : les chiffres des certificats diffèrent de la liste ouverte par le lien
**Incohérence · 🟠 Majeure**
- **Emplacement** : `/` · `apps/web/app/(app)/page.tsx:74` ; `apps/api/src/modules/dashboard/dashboard.service.ts` (`certificateWhere`) ; `certificates.service.ts:171-183`
- **Cas** : avec ISKANDER sélectionné, le tableau de bord affiche valides 2, expirés 2, illimités 2. Le lien ouvre `/certificates?vesselId=…`, qui affiche 1 / 1 / 1. Le tableau de bord compte les certificats du navire et de son équipage ; le filtre `vesselId` ne prend que ceux du navire.
- **Correction proposée** : faire pointer les liens vers `vesselIds=<id>` (navire et équipage), ou aligner le calcul du tableau de bord.

### [ADM-07] Journal d'audit vide sans explication quand un navire est sélectionné
**Incohérence · 🟠 Majeure**
- **Emplacement** : `/admin/audit` · `apps/web/app/(app)/admin/audit/page.tsx:50,60`
- **Cas** : avec un navire dans le sélecteur global, la page envoie `vesselId`. Les événements admin et auth n'ont pas de navire, donc 0 résultat s'affiche. Les liens « refus d'accès » et « échecs de connexion » de la console admin mènent alors à une liste vide.
- **Correction proposée** : ignorer le sélecteur pour les modules admin, auth et platform, ou afficher un filtre « Navire » visible et effaçable avec l'option « inclure les événements sans navire ».

### [ADM-08] Paramètres : les champs numériques perdent le focus à chaque frappe
**Bug · 🟠 Majeure** (constaté à la lecture du code)
- **Emplacement** : `/admin/settings` · `apps/web/app/(app)/admin/settings/page.tsx:54,71-77`
- **Cas** : `NumberSetting` est déclaré à l'intérieur du rendu, son type de composant change donc à chaque `setS`. L'`<Input>` est démonté puis remonté, et le focus est perdu après le premier chiffre. Cela touche les 5 paramètres numériques.
- **Correction proposée** : sortir `NumberSetting` du composant `SettingsPage` (props `value` et `onChange`).

### [ADM-09] Le profil Crewing arrive sur « Accès non autorisé » après la connexion
**Amélioration UI · 🟠 Majeure**
- **Emplacement** : `/` · `apps/web/app/(app)/page.tsx:70` ; `login/page.tsx:30` ; `change-password/page.tsx:31`
- **Cas** : `dashboard.view` a été retiré au rôle CREWING le 21/10. La connexion redirige pourtant toujours vers `/`, qui affiche « Accès non autorisé… Contactez un administrateur ».
- **Correction proposée** : sans `dashboard.view`, rediriger vers la première entrée de navigation autorisée (`/members`).

### [ADM-10] `GET /exports` renvoie les erreurs Prisma brutes (chemin serveur et extraits de code)
**Sécurité · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/exports/exports.service.ts:83`
- **Cas** : un export d'audit avec `from:'abc'` produit, dans le champ `error`, « Invalid `this.prisma.auditEvent.findMany()` invocation in C:\vesselmgr\apps\api\dist\… ».
- **Correction proposée** : stocker un message générique, ou le message d'une `AppError`, et journaliser le détail côté serveur.

### [ADM-11] Exports : un filtre invalide provoque une erreur 500
**Bug · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/exports/exports.controller.ts` (`filters: z.record(z.string())`)
- **Cas** : `{resource:'certificates', filters:{vesselId:'abc'}}` et `{resource:'audit', filters:{from:'abc'}}` donnent 500 au lieu de 422.
- **Correction proposée** : définir un schéma Zod par ressource (`vesselId` uuid, `from`/`to` dates, `subjectKind` enum).

### [ADM-12] Les exports Certificats, Navires et Audit existent dans l'API mais pas dans l'interface
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/certificates`, `/vessels`, `/admin/audit`
- **Cas** : `POST /exports` fonctionne (XLSX/CSV, contrôle des droits), et 8 rôles ont `reports.export`, mais ces pages n'ont aucun bouton « Exporter ».
- **Correction proposée** : réutiliser `ExportButton` (`apps/web/components/purchasing/ui.tsx:352`) en lui passant les filtres courants.

### [ADM-13] Changer l'e-mail d'un compte le laisse marqué « vérifié »
**Sécurité · 🟡 Mineure**
- **Emplacement** : `/admin/users/[id]`, onglet Profil · `apps/web/app/(app)/admin/users/[id]/page.tsx:77`
- **Cas** : l'interface renvoie toujours `emailVerified: true`. Un nouvel e-mail est donc considéré comme vérifié, et les liens de réinitialisation partent vers une adresse jamais confirmée.
- **Correction proposée** : décocher la case automatiquement quand l'e-mail change, ou faire ignorer `emailVerified` par l'API dans ce cas.

### [ADM-14] Un administrateur délégué voit les sessions du Super Admin (IP, navigateur)
**Sécurité · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/admin/users.service.ts:379` (`listSessions`)
- **Cas** : un ADMIN délégué limité à un navire appelle `GET /users/{admin}/sessions` et obtient 200 avec les IP. La révocation, elle, est bien refusée.
- **Correction proposée** : appeler `loadManageable(ctx, id)` dans `listSessions`.

### [ADM-15] « Mot de passe temporaire » et « Révoquer toutes les sessions » sur son propre compte déconnectent sans prévenir
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/admin/users/[id]` · `apps/web/app/(app)/admin/users/[id]/page.tsx:124` et onglet Sessions
- **Cas** : `POST /users/{soi}/reset-password` répond 201, puis la requête suivante répond 401 « Session révoquée ». Seul le bouton « Désactiver » est masqué pour soi-même.
- **Correction proposée** : masquer ces actions si `isSelf` et renvoyer vers `/account` et `/change-password`.

### [ADM-16] Les rôles Super Admin et ceux qu'il ne possède pas sont proposés à l'administrateur délégué
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/admin/users` · `apps/web/app/(app)/admin/users/page.tsx:111` ; `/admin/users/[id]` · `:168`
- **Cas** : tous les rôles sont cochables, et l'enregistrement répond 403 (« Seul un Super Admin… », « 15 droits manquants »).
- **Correction proposée** : désactiver ces rôles et expliquer pourquoi dans une infobulle.

### [ADM-17] Le filtre et le compteur « Actifs » incluent les comptes verrouillés
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/admin/users` · `apps/api/src/modules/admin/users.service.ts:78` ; `apps/web/components/dashboard/admin-console.tsx:109-110`
- **Cas** : un compte verrouillé est compté à la fois dans les actifs et dans les verrouillés. Le texte « Après 5 échecs » est écrit en dur, alors que le seuil est un paramètre.
- **Correction proposée** : `ACTIVE` = `{ status:'ACTIVE', lockedAt:null }`, et afficher la valeur de `auth.maxFailedLogins`.

### [ADM-18] Limitation des connexions : message en anglais sur la page de connexion
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/login`, `/forgot-password` · `apps/api/src/common/filters/http-exception.filter.ts`
- **Cas** : au-delà de 10 tentatives par minute, la page affiche « ThrottlerException: Too Many Requests ».
- **Correction proposée** : renvoyer « Trop de tentatives. Réessayez dans une minute. » pour le statut 429.

### [ADM-19] Messages d'erreur techniques en anglais dans l'interface
**Incohérence · 🟡 Mineure** (même cause que FLT-14)
- **Emplacement** : filtre d'exceptions (Zod), `ParseUUIDPipe`, Multer → `apps/web/lib/api.ts` (`fieldErrors`)
- **Cas** : on voit « String must contain at least 2 character(s) », « Invalid enum value… », « Validation failed (uuid is expected) » ou « File too large ».
- **Correction proposée** : brancher `z.setErrorMap` en français au démarrage de l'API, et ajouter des messages français pour les erreurs d'UUID et 413.

### [ADM-20] « Taille maximale d'un dépôt » accepte des valeurs qui n'ont aucun effet
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/admin/settings` · `apps/api/src/modules/settings/settings.service.ts:17` ; `apps/api/src/modules/files/files.controller.ts:55`
- **Cas** : on peut enregistrer 100 Mo, mais Multer bloque à 50 Mo (`UPLOAD_MAX_BYTES`), et un fichier de 53 Mo reçoit 413. La valeur se saisit en octets.
- **Correction proposée** : plafonner la valeur à `UPLOAD_MAX_BYTES` et la saisir en Mo.

### [ADM-21] Changement de mot de passe : consigne figée et libellés inadaptés
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `apps/web/app/(auth)/change-password/page.tsx:52,59` ; `reset-password/page.tsx` ; `/account`
- **Cas** :
  - « 12 caractères minimum » est écrit en dur, alors que le paramètre est réglable de 10 à 128.
  - Le champ s'appelle « Mot de passe actuel (temporaire) » même lors d'un changement volontaire.
  - Il n'y a pas de bouton « Annuler ».
  - `/reset-password` n'affiche aucune règle.
- **Correction proposée** : lire la politique depuis l'API, adapter le libellé à `mustChangePassword`, et ajouter un retour vers `/account`.

### [ADM-22] `%` et `_` ne sont pas échappés dans les recherches
**Bug · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/dashboard/search.service.ts:20` ; `users.service.ts` (`list`) ; `apps/api/src/modules/audit/audit.controller.ts:84`
- **Cas** : `/search?q=%25%25` renvoie tout, `/users?search=%25` renvoie 21 comptes sur 21, `/audit?action=%25` renvoie 200 événements.
- **Correction proposée** : échapper `\`, `%` et `_` avant `contains` et `startsWith`.

### [ADM-23] Recherche de marins : les mots sont combinés en « OU »
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/dashboard/search.service.ts` (bloc members)
- **Cas** : « Mécanicien DÉMO-BRAVO zzzz » trouve le marin, et « Prénom Nom » renvoie tous les homonymes du prénom.
- **Correction proposée** : un `AND` entre les mots, un `OR` entre les champs.

### [ADM-24] État du système : tâches affichées à tort et statuts non traduits
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/admin/system` · `apps/api/src/modules/admin/system.controller.ts` ; `apps/api/src/modules/files/files.processor.ts:108` ; `apps/api/src/modules/jobs/queues.ts:16` ; `apps/web/app/(app)/admin/system/page.tsx:71,98,113,119`
- **Cas** :
  - « Purge des dépôts non rattachés » affiche toujours « Jamais », car la tâche n'écrit pas de `job_runs`.
  - « Diffusion des événements » (`outbox-dispatch`) apparaît alors qu'aucun traitement n'existe, et pourtant `run` répond `queued:true`.
  - Les statuts COMPLETED, SENT, QUEUED et SKIPPED s'affichent en brut.
- **Correction proposée** : écrire un `jobRun` dans `cleanupOrphans`, retirer `OUTBOX_DISPATCH` et ajouter des libellés français.

### [ADM-25] L'historique d'un utilisateur masque le verrouillage et les échecs de connexion
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/admin/users/[id]` (`<AuditTimeline module="admin" />`)
- **Cas** : seul `user.created` apparaît. `auth.account_locked`, `auth.login_failed` et `auth.password_reset_by_link` sont filtrés, si bien que l'admin qui déverrouille ne voit pas pourquoi le compte est bloqué.
- **Correction proposée** : ne pas passer `module` ; l'API filtre déjà selon les droits.

### [ADM-26] Raisons de fermeture des sessions affichées en codes
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/admin/users/[id]`, onglet Sessions · `apps/web/app/(app)/admin/users/[id]/page.tsx:410`
- **Cas** : on lit « Fermée (PASSWORD_RESET_BY_ADMIN) », « (IDLE_TIMEOUT) », « (ACCOUNT_LOCKED) ».
- **Correction proposée** : une table de libellés français (« Inactivité », « Réinitialisé par un admin »…).

### [ADM-27] Création de compte : une référence inconnue renvoie un message vague
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/admin/users.service.ts` (`create`, `writeDepartments`) ; `departments.service.ts` (`create`)
- **Cas** : un navire, un département ou un responsable inconnu donne 409 « Référence invalide ou utilisée », alors que `PUT …/vessel-scope` renvoie un 422 explicite.
- **Correction proposée** : vérifier les références avant l'écriture et renvoyer un 422 explicite.

### [ADM-28] Des opérations sans effet sont journalisées
**Données · 🟡 Mineure**
- **Emplacement** : `users.service.ts` (`setActive`, `revokeSession`) ; `departments.service.ts` (`setStatus`)
- **Cas** : réactiver un compte déjà actif produit un audit `user.reactivated` ACTIVE→ACTIVE ; une double désactivation produit deux audits ; révoquer une session inconnue répond 200 `{revoked:0}` et est journalisé.
- **Correction proposée** : renvoyer 409 quand l'état est inchangé et 404 pour une session inconnue.

### [ADM-29] Départements et paramètres : contrôles de données manquants
**Données · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/admin/departments.service.ts` ; `settings.service.ts` (`members.selfEditableFields`)
- **Cas** : un compte désactivé est accepté comme responsable ; `GET /departments/{inconnu}/members` répond 200 `[]` ; `['phone','phone']` est accepté.
- **Correction proposée** : n'accepter que des comptes `ACTIVE`, renvoyer 404 et dédupliquer avec un `refine`.

### [ADM-30] Départements : lien vers la fiche utilisateur affiché sans le droit
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/admin/departments` · `apps/web/app/(app)/admin/departments/page.tsx`
- **Cas** : `direction` voit les membres d'un département, mais leur lien mène à « Accès non autorisé ».
- **Correction proposée** : n'afficher le lien que si `can('users.view')`.

---

## 5. Flotte, marins, voyages, Charter Parties et Noon Reports

### [FLT-01] Un fuseau horaire invalide sur un navire fait planter toute l'application
**Bug · 🔴 Critique**
- **Emplacement** : `/vessels/[id]` (formulaire), puis toutes les pages · `apps/api/src/modules/vessels/vessels.dto.ts:41` ; `apps/web/components/shell/watch-clock.tsx:8-17,66-67` ; `apps/web/app/(app)/vessels/vessel-form.tsx:60`
- **Cas** : `PATCH /vessels/{id}` avec `timezone:"Mars/Olympus"` (ou `""`) répond 200. Dès qu'un utilisateur sélectionne ce navire, l'horloge de l'en-tête lève `RangeError: Invalid time zone specified`. Il n'y a ni `error.tsx` ni `global-error.tsx`, et la sélection du navire est conservée dans le navigateur : l'application reste cassée après chaque rechargement. Une faute de frappe comme « Africa/Tunisia » suffit.
- **Correction proposée** :
  - API : `z.string().refine(tz => { try { new Intl.DateTimeFormat('en',{timeZone:tz}); return true } catch { return false } })`.
  - Interface : un try/catch dans `watch-clock`, une liste déroulante IANA dans le formulaire, et un `app/(app)/error.tsx`.

### [FLT-02] « Équipage à une date » compte comme à bord les affectations terminées sans date de débarquement
**Bug · 🟠 Majeure**
- **Emplacement** : `/members/crew?vesselId=…&date=…` · `apps/api/src/modules/members/crew-assignments.service.ts:313-315`
- **Cas** : `GET /vessels/{ISK}/crew?date=2026-10-29` donne `onboard = 50` au lieu de 2. 48 affectations COMPLETED sans `actualSignOffDate` sont comptées comme toujours à bord (ABESSALLEM, HADDAD, YACINE depuis 2017…).
- **Correction proposée** : pour COMPLETED, exiger `actualSignOffDate >= date` (le `null` n'est valable que pour ONBOARD). Corriger les données (FLT-09).

### [FLT-03] Dates impossibles : décalage silencieux ou erreur 500
**Bug · 🟠 Majeure**
- **Emplacement** : `apps/api/src/common/pagination.ts:45-48` (`dateOnly`) ; `apps/api/src/modules/members/members-import.dto.ts` (`dateOrNull`)
- **Cas** :
  - `birthDate:"1990-02-30"` est enregistrée comme **1990-03-02** (201), à la création comme à l'import.
  - `"1990-13-01"` répond « Date dans le futur ».
  - Un laycan au 2027-02-31 répond « la date de début doit précéder la date de fin ».
  - `?from=2026-13-01` sur `/crew-assignments`, `/noon-reports`, `/voyages` et `/vessels/{id}/crew`, ainsi qu'un `passportExpiry` invalide, provoquent une **erreur 500**.
- **Correction proposée** : `dateOnly.refine(s => new Date(s+'T00:00:00Z').toISOString().slice(0,10) === s, 'Date inexistante')`, et réutiliser ce contrôle dans l'import.

### [FLT-04] La recherche par seaman book ou passeport ne trouve pas les fiches reprises
**Bug · 🟠 Majeure**
- **Emplacement** : `/members` · `apps/api/src/modules/members/members.service.ts:147-157`
- **Cas** : `search=TG 2384` et `search=TG2384` donnent 0 résultat, alors que deux fiches portent « TG 2384 ». La saisie est compactée (espaces retirés), mais la reprise du 15/10 a stocké les numéros avec espaces : 153 seaman books sur 161 et 4 passeports.
- **Correction proposée** : comparer avec `regexp_replace(upper(x),'[^A-Z0-9]','','g')`, déjà utilisé dans `member-duplicates.service.ts:60-62`, et normaliser les numéros existants par une migration de données.

### [FLT-05] Un navire passe en « Vendu » avec des marins à bord et un voyage actif, et l'activité continue
**Bug · 🟠 Majeure**
- **Emplacement** : `/vessels/[id]` (bouton Statut) · `vessels.service.ts:126-137` ; `crew-assignments.service.ts:181-185` ; `voyages.service.ts:279` ; `noon.service.ts:222-230`
- **Cas** :
  - Passage en SOLD avec 3 marins ONBOARD et un voyage ACTIVE : 201.
  - Sur un navire SOLD, un embarquement (`join`) et un Noon Report sont encore acceptés (201).
  - Sur un navire désarmé (LAID_UP), un voyage peut encore être activé.
- **Correction proposée** :
  - Refuser SOLD ou INACTIVE tant qu'il reste des affectations ONBOARD/PLANNED ou un voyage PLANNED/ACTIVE (409 avec la liste).
  - Contrôler le statut du navire dans `join`, `activate` et dans `create`/`submit` des Noon Reports.

### [FLT-06] Les dates d'un voyage peuvent être incohérentes, ce qui fausse le contrôle des certificats
**Bug · 🟠 Majeure**
- **Emplacement** : `/voyages/[id]` · `apps/api/src/modules/voyages/voyages.dto.ts:41-56` ; `voyages.service.ts:301-311` ; `voyages.logic.ts:360-365` ; `apps/web/components/voyages/voyage-form.tsx:155-162`
- **Cas** : des dates incohérentes sont acceptées (201) :
  - ETD après ETA ;
  - ATD dans le futur ;
  - ATA avant ATD ;
  - escale avec une ATA future.

  Le contrôle des certificats du voyage se base ensuite sur une fin de voyage passée (`voyageEndBasis: "ATA"`).
- **Correction proposée** : réutiliser `validatePortTimes` au niveau du voyage (ETD ≤ ETA, ATD ≤ ATA) sur les valeurs fusionnées en PATCH, avec une tolérance de 24 h pour les dates futures. Faire le même contrôle dans le formulaire.

### [FLT-07] Plusieurs Noon Reports le même jour pour le même voyage
**Bug · 🟠 Majeure**
- **Emplacement** : `/noon-reports/new` · `apps/api/src/modules/noon/noon.service.ts:630-636`
- **Cas** : deux rapports NOON le 28/10, à 11:00Z et à 11:05Z, sont acceptés tous les deux (201). Seul le même horodatage exact est refusé, alors que le message parle de « même date ». Les consommations de la journée sont comptées deux fois.
- **Correction proposée** : unicité par voyage, type et jour local (`reportDateUtc + utcOffsetMinutes`) pour NOON et MIDNIGHT.

### [FLT-08] Les marins « à bord » d'ISKANDER sont des fiches de démonstration
**Données · 🟠 Majeure**
- **Emplacement** : `/vessels/{ISK}` (Équipage), `/members`, `/members/crew`, tableau de bord (« 2 marins à bord »)
- **Cas** : les 2 affectations ONBOARD de la base réelle concernent DÉMO-ALPHA (lié à `captain.iskander`) et DÉMO-BRAVO (lié à `chief.iskander`). DÉMO-DELTA est PLANNED et DÉMO-CHARLIE existe aussi. Toutes viennent du seed du 12/10 ; aucun marin réel n'est embarqué.
- **Correction proposée** : à décider avec le métier. Archiver ces fiches, clore leurs affectations, et rattacher les comptes de bord à de vraies fiches.

### [FLT-09] Anomalies de la reprise ISKANDER
**Données · 🟠 Majeure**
- **Emplacement** : `/members`, `/members/[id]` (Embarquements)
- **Cas** :
  - **Seaman book « TG 2384 » partagé par BEJAOUI Rabie et DALHOUM Malek.**
  - 48 affectations COMPLETED sans date de débarquement, et 11 sans date d'embarquement.
  - Affectations qui se chevauchent pour BEN OTHMEN.
  - Nationalité et sexe vides sur 174 fiches sur 174 ; matricule AMC présent sur 4 fiches seulement.
  - 39 fiches sans affectation ; 11 affectations dont le rang diffère de celui de la fiche.
- **Correction proposée** : faire corriger ces lignes par Crewing, puis rejouer le contrôle des doublons sur les fiches reprises.

### [FLT-10] Onglet « Historique » d'un navire en erreur pour la plupart des rôles
**Bug · 🟡 Mineure**
- **Emplacement** : `/vessels/[id]`, onglet Historique · `apps/web/app/(app)/vessels/[id]/page.tsx:179,337-340` ; `apps/web/components/amc/audit-timeline.tsx:44`
- **Cas** : l'onglet appelle `GET /audit?entityType=vessel…`, qui répond 403 pour `captain.iskander` et `crewing`. Pourtant `GET /vessels/{id}/history` (droit `vessels.view`) répond 200 pour eux. L'onglet affiche aussi des codes bruts (`vessel.updated`, `updatedAt : …`).
- **Correction proposée** : utiliser `/vessels/{id}/history`, retirer `updatedAt` des différences et traduire les libellés.

### [FLT-11] Le contenu des Noon Reports n'est contrôlé ni par rapport au voyage ni d'un rapport à l'autre
**Amélioration · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/noon/noon.logic.ts:252-265` ; `noon.service.ts:222-245`
- **Cas** : les rapports suivants sont acceptés :
  - un rapport daté de 2019 sur un voyage de 2026 ;
  - 5 000 nm parcourues en 24 h à 12 nœuds ;
  - un FO ROB qui passe de 500 à 900 t sans soute.
- **Correction proposée** : borner la date du rapport (au plus tôt la création du voyage ou l'ATD). Ajouter des avertissements non bloquants dans `submissionCheck` : distance supérieure à vitesse × heures × 1,2, et ROB incohérent avec la consommation sans soute.

### [FLT-12] Commercial et Ops Manager voient les Noon Reports mais pas les voyages
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/noon-reports`, `/noon-reports/[id]` · `apps/web/components/noon/noon-report-view.tsx:177,190` ; `apps/web/app/(app)/noon-reports/page.tsx:35-38`
- **Cas** : `GET /voyages` répond 403 pour ces rôles. Le fil d'Ariane et le lien « Voyage » mènent donc à « Accès refusé » (ce qui a aussi été constaté dans le navigateur pour `commercial`), et le filtre « Voyage » reste vide.
- **Correction proposée** : donner `voyages.view` à ces rôles, ou conditionner liens et filtre à `can('voyages.view')`. À arbitrer selon la matrice RACI.

### [FLT-13] La saisie manuelle d'une fiche marin est moins contrôlée que l'import
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/members/members.dto.ts:32-49`, comparé à `member-import.logic.ts:894-905`
- **Cas** : une naissance en 1850, une nationalité `XX` et une expiration de passeport antérieure à la naissance sont acceptées (201). L'import les refuse.
- **Correction proposée** : mettre ces règles en commun entre `MemberDataSchema` et l'import.

### [FLT-14] Messages de validation en anglais
**Incohérence · 🟡 Mineure** (voir ADM-19)
- **Cas** : on voit « Invalid email », « String must contain at least 1 character(s) » ou « Invalid enum value. Expected 'LOAD' | … ».
- **Correction proposée** : `z.setErrorMap` en français.

### [FLT-15] Chronologie du voyage : « Planning mis à jour (ETA, LAYCANFROM, LAYCANTO) »
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/voyages/[id]`, onglet Chronologie · `apps/api/src/modules/voyages/voyages.service.ts:554`
- **Correction proposée** : utiliser une table de libellés (`laycanFrom` → « début de laycan ») au lieu de `toUpperCase()`.

### [FLT-16] Référence de Charter Party unique seulement à la casse près, et date future acceptée
**Bug · 🟡 Mineure**
- **Emplacement** : `/charter-parties` · `apps/api/src/modules/voyages/charter-parties.service.ts:264-267` ; `charter-parties.dto.ts:15`
- **Cas** : `AUDIT-CP-001` et `audit-cp-001` sont créées toutes les deux ; une `cpDate` en 2030 est acceptée.
- **Correction proposée** : normaliser la référence (majuscules, sans espaces) ou poser un index unique sur `upper(reference)`, et borner la date.

### [FLT-17] Le compteur « Marins à bord » ne correspond pas à la liste qu'il ouvre
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/vessels/[id]` · `apps/web/app/(app)/vessels/[id]/page.tsx:232-233`
- **Cas** : le compteur affiche 2, mais le lien `/members?vesselId=…` liste 3 fiches (planifiées comprises). « Embarquements prévus » mène à la même liste.
- **Correction proposée** : pointer vers `/members/crew?vesselId=…`, ou ajouter `&status=ON_BOARD` / `&status=PLANNED_JOIN`.

### [FLT-18] Voyage clôturé : ses brouillons de Noon Report restent modifiables mais ne peuvent plus être soumis
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/noon/noon.service.ts:248-257,286`
- **Cas** : un `PATCH` sur le brouillon répond 200, puis la soumission répond 422 « soumission impossible ».
- **Correction proposée** : bloquer aussi la modification et proposer « Supprimer le brouillon », ou bloquer la clôture tant qu'il reste des brouillons.

### [FLT-19] Quantité réelle de cargaison très supérieure au maximum, sans avertissement
**Amélioration · 🟡 Mineure**
- **Emplacement** : `/voyages/[id]`, onglet Cargaison · `apps/api/src/modules/voyages/voyages.logic.ts:335-340`
- **Cas** : min 1 000 t, max 2 000 t, réel 90 000 t → accepté sans signal.
- **Correction proposée** : avertir quand la quantité réelle sort de l'intervalle prévu (option comprise).

### [FLT-20] Aucun contrôle de vraisemblance sur les caractéristiques d'un navire
**Bug · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/vessels/vessels.dto.ts:34-40`
- **Cas** : une année de construction 2099 et une jauge nette (5 000) supérieure à la jauge brute (1 000) sont acceptées.
- **Correction proposée** : `yearBuilt ≤ année en cours + 3`, et jauge nette ≤ jauge brute.

### [FLT-21] Fiche ISKANDER presque vide, et texte de démonstration resté dans les notes
**Données · 🟡 Mineure**
- **Emplacement** : `/vessels/{ISK}`
- **Cas** :
  - MMSI, indicatif, pavillon, port d'immatriculation, gestionnaire, armateur, classe, année, jauge et port en lourd sont vides ; les PDF de Noon Reports et les notices n'ont que l'IMO.
  - Les notes contiennent encore « Navire cité dans le cahier des charges (PR n°323, Noon Report du 10/02/2026…) », visible dans le navigateur.
- **Correction proposée** : faire compléter la fiche par Technical ou QHSE, et effacer la note de démonstration.

### [FLT-22] La liste des affectations révèle des marins hors du périmètre du capitaine
**Sécurité · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/members/crew-assignments.service.ts:65-91`
- **Cas** : `captain.iskander` appelle `GET /crew-assignments?vesselId=ISK` et reçoit 147 lignes avec nom, rang et photo, y compris des marins dont la fiche lui répond 403 (ADM-070). La liste d'équipage, elle, renseigne `memberAccessible` pour signaler ces cas.
- **Correction proposée** : ajouter `memberAccessible` et masquer la photo et la nationalité hors périmètre. À valider au regard de la règle « l'historique donne du contexte » (`access/member-access.ts:14`).

### [FLT-23] Pièces jointes de navire : impossible d'archiver depuis l'interface, et risque d'erreur 500
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/vessels/[id]`, onglet Pièces jointes · `apps/web/app/(app)/vessels/[id]/page.tsx:306-335` ; `apps/api/src/modules/vessels/vessels.service.ts:179`
- **Cas** : la route `POST …/attachments/{id}/archive` existe, mais l'interface n'a ni bouton ni filtre « archivées ». `toFileDto(files.find(...)!)` provoque une erreur 500 si le fichier est manquant.
- **Correction proposée** : ajouter « Archiver » avec confirmation et le filtre `?archived=true`, et gérer `file: null` comme `members.service.ts:701`.

### [FLT-24] Un marin encore à bord d'un autre navire peut être planifié avec une date déjà passée
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/members/crew-assignments.service.ts:117-124,443-461`
- **Cas** : marin ONBOARD sur un navire, planifié sur ISK avec un embarquement prévu le 25/10 (date passée) : accepté (201) avec un simple avertissement. L'embarquement est ensuite refusé, et l'affectation reste incohérente.
- **Correction proposée** : refuser ce cas, ou exiger une confirmation explicite dans l'interface.

### [FLT-25] Brouillons de Noon Reports incomplets oubliés
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/noon-reports` · `apps/api/src/modules/noon/noon.service.ts:222-245`
- **Cas** : un rapport DEPARTURE sans Master, position ni prochain port est créé sans signal. La soumission liste bien 6 champs manquants, mais rien ne relance l'auteur.
- **Correction proposée** : afficher dans la liste l'ancienneté du brouillon et le nombre de champs manquants (`submissionCheck.length`), et ajouter un filtre « brouillons anciens ».

---

## 6. Certificats

### [CRT-01] Renouvellement publié directement : le renouvellement reste « En cours » avec une tâche active
**Bug · 🟠 Majeure**
- **Emplacement** : `/certificates/[id]` (badge Renouvellement, panneau latéral, filtre) · `apps/api/src/modules/certificates/certificate-workflow.service.ts:218-219,1403-1411`
- **Cas** : admin (avec `self_approve`) fait un renouvellement avec `submit:true`. La révision N3 devient bien courante, mais `renewal.status` vaut `IN_PROGRESS` et une nouvelle tâche active est créée : le certificat apparaît dans « Renouvellement en cours ». Cause : `ensureRenewalInProgress` est appelé après `openRequest`, qui a déjà clôturé le suivi.
- **Correction proposée** : appeler `ensureRenewalInProgress` avant `openRequest`, ou le sauter quand `autoApproved` est vrai.

### [CRT-02] On peut désigner comme validateur une personne qui n'a pas le droit d'approuver, ce qui bloque les demandes
**Incohérence · 🟠 Majeure**
- **Emplacement** : `/certificates/settings` · `apps/api/src/modules/certificates/certificate-types.service.ts:166-191` ; `apps/web/components/certificates/pickers.tsx:304-404` ; `settings-forms.tsx:249-257`
- **Cas** : `captain.iskander`, qui n'a pas `certificates.approve`, est désigné validateur unique (200). Les demandes suivantes partent avec `notifiedValidators: 0`, et qhse reçoit 403 s'il tente de décider. La demande reste bloquée.
- **Correction proposée** : à l'enregistrement, compter les validateurs effectifs et refuser (422) ou avertir. Dans le sélecteur, signaler les personnes sans droit d'approbation.

### [CRT-03] Changer les validateurs d'un type ne prévient pas les nouveaux validateurs des demandes déjà en attente
**Bug · 🟠 Majeure**
- **Emplacement** : `apps/api/src/modules/certificates/certificate-types.service.ts:166-191`
- **Cas** : une demande est en attente, puis les validateurs passent à `[qhse]`. La demande apparaît dans la boîte de qhse, mais il n'a reçu aucune notification ni aucun e-mail.
- **Correction proposée** : après `setValidators`, pour chaque demande PENDING_APPROVAL du type, résoudre les notifications des personnes qui ne sont plus éligibles et notifier les nouvelles (`notifyValidators(..., 'submitted')`).

### [CRT-04] Certificat archivé : le suivi de renouvellement reste « En cours » avec sa tâche active
**Données · 🟡 Mineure**
- **Emplacement** : `/certificates/[id]` · `apps/api/src/modules/certificates/certificate-workflow.service.ts:1035-1069`
- **Correction proposée** : dans `archive()`, clôturer la tâche, remettre le suivi à `NOT_STARTED` et l'inscrire dans l'audit.

### [CRT-05] Les compteurs de l'arborescence ne correspondent pas à la liste
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/certificates` · `apps/api/src/modules/certificates/certificate-tree.service.ts:76-80,251-255`, comparé à `certificates.service.ts:161-169`
- **Cas** : une demande de création refusée laisse un certificat vide, qu'on classe ensuite dans un dossier. Le dossier affiche 1 et la liste 0. Même écart sur une catégorie : 2 contre 1.
- **Correction proposée** : appliquer le même filtre que la liste (révision courante ou demande ouverte).

### [CRT-06] La suppression d'un dossier annonce un dossier vide alors qu'elle déplace des certificats
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/certificates` · `apps/web/components/certificates/tree.tsx:418-423` ; `certificate-tree.service.ts:146-170`
- **Cas** : le dossier affiche 1, mais la suppression renvoie `movedCertificates: 2`. Les certificats archivés et hors périmètre ne sont pas comptés dans le message de confirmation.
- **Correction proposée** : exposer un compteur total aux gestionnaires et rédiger le message à partir de ce total.

### [CRT-07] La modification d'un type peut créer des catégories en double qui ne diffèrent que par la casse
**Données · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/certificates/certificate-tree.service.ts` (`ensureCategory`)
- **Cas** : on renomme `X-CAT` en `X-cat`, puis on modifie un type avec `X-CAT`. L'arborescence affiche alors les deux catégories.
- **Correction proposée** : chercher sans tenir compte de la casse et réutiliser le nom existant.

### [CRT-08] Une correction sans nouveau fichier affiche à tort « Document manquant »
**Bug · 🟡 Mineure**
- **Emplacement** : formulaire « Corriger » · `apps/api/src/modules/certificates/certificate-workflow.service.ts:238,1255-1257`
- **Cas** : une correction de l'émetteur, sans fichier, renvoie l'avertissement « Aucun document joint… Document manquant ». Après approbation, `documentMissing` vaut pourtant false (le document est repris).
- **Correction proposée** : ne pas émettre l'avertissement si la révision courante a déjà un document officiel.

### [CRT-09] Avec `self_approve` mais sans `submit`, l'interface propose de publier et l'API refuse
**Incohérence · 🟡 Mineure** (constaté à la lecture du code)
- **Emplacement** : `apps/api/src/modules/certificates/certificate-workflow.service.ts:138,226,842`, comparé à `:201,340` ; `apps/web/components/certificates/certificate-form.tsx:149`
- **Cas** : la création, la correction et l'ajout de pièce exigent `certificates.submit`, alors que le renouvellement et la soumission acceptent aussi `self_approve`.
- **Correction proposée** : utiliser `canSelfApprove(ctx, kind)` partout.

### [CRT-10] Publication directe : la réponse et les libellés annoncent une approbation en attente
**Incohérence · 🟡 Mineure**
- **Emplacement** : `certificate-workflow.service.ts:1226-1227` ; `apps/web/components/certificates/request-card.tsx:262` ; `certificate-form.tsx:235`
- **Cas** :
  - La réponse contient `request.status: "PENDING_APPROVAL"` avec `autoApproved: true`.
  - Le toast affiche « Demande soumise à approbation » alors que la demande est publiée.
  - Le formulaire de correction parle de « demande à valider ».
- **Correction proposée** : renvoyer le statut après approbation, et choisir les libellés selon `autoApproved` et `selfApprove`.

### [CRT-11] Une annulation par un superviseur s'affiche « Annulée par le demandeur »
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/certificates/[id]?tab=requests` · `apps/web/components/certificates/request-card.tsx:139`
- **Correction proposée** : exposer `cancelledById` et afficher l'auteur réel, ou « automatiquement ».

### [CRT-12] Un retour pour correction notifie les autres validateurs « Demande clôturée »
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/certificates/certificate-workflow.service.ts:608,1340-1347`
- **Correction proposée** : sur un retour, utiliser « Retournée au demandeur » ou ne rien envoyer ; garder « clôturée » pour une approbation ou un rejet.

### [CRT-13] Impossible de déplacer ou de réordonner un dossier depuis l'interface
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `/certificates` · `apps/web/components/certificates/tree.tsx:303-320`
- **Cas** : l'API accepte `parentId` et `sortOrder` en PATCH, mais l'interface ne propose que « sous-dossier », « renommer » et « supprimer ».
- **Correction proposée** : ajouter une action « Déplacer… » (sélecteur de dossier qui exclut le sous-arbre courant) et un réordonnancement.

### [CRT-14] Après renommage d'un dossier ou d'une catégorie, la fiche et le panneau gardent l'ancien nom
**Bug · 🟡 Mineure** (constaté à la lecture du code)
- **Emplacement** : `apps/web/components/certificates/tree.tsx:250-254,464-469` ; `apps/web/components/certificates/lib.ts:12-13`
- **Correction proposée** : invalider aussi le préfixe `['certificate']`.

### [CRT-15] Noms de dossiers visibles hors périmètre, et 403 qui révèle l'existence d'un certificat
**Sécurité · 🟡 Mineure**
- **Emplacement** : `certificate-tree.service.ts:69-82` ; `certificates.service.ts:414-416`
- **Cas** : `captain.iskander` voit un dossier qui ne contient que des certificats d'un autre navire (compteur 0), et reçoit 403 au lieu de 404 sur un certificat hors périmètre. Aucune donnée de certificat ne fuit (20 points d'accès testés).
- **Correction proposée** : masquer les dossiers vides pour l'appelant, ou documenter que les dossiers sont globaux, et renvoyer 404.

---

## 7. Documents CSO

### [CSO-01] L'aperçu d'un Word ou d'un Excel livre le fichier complet sans droit de téléchargement
**Sécurité · 🔴 Critique**
- **Emplacement** : `/cso/documents/[id]`, `/cso/shared-with-me` · `apps/api/src/modules/files/files.service.ts:371-372` ; `apps/api/src/modules/cso/cso-documents.service.ts:842-847` ; `apps/web/app/(app)/cso/shared-with-me/page.tsx:91-109`
- **Cas** : `captain.iskander` (droits `cso.view` et `cso.preview`) demande l'aperçu d'un `.docx`. `/preview` répond 200 avec `disposition: attachment`, et le lien signé renvoie le fichier entier. `/download` répond 403. Cause : `versionLink` transmet un droit calculé en mode preview, donc la bascule vers le mode téléchargement ne s'applique pas.
- **Correction proposée** : pour un fichier qui n'est ni PDF ni image, calculer le droit en mode `'download'` ou refuser l'aperçu. Dans l'interface, n'afficher « Aperçu » que si `isPreviewable(kind)`.

### [CSO-02] Un sous-dossier dont l'héritage est rompu devient lisible par tous les lecteurs
**Sécurité · 🟠 Majeure**
- **Emplacement** : `apps/api/src/modules/cso/cso-acl.logic.ts:108-115,135-153` ; `cso-folders.service.ts:155-157` ; `cso-search.service.ts:103` ; `apps/web/components/cso/acl-editor.tsx:112-115`
- **Cas** : sous « Annexes confidentielles », on rompt l'héritage et on ne garde qu'une règle Autoriser `edit` + `acl_manage` pour la Sûreté. Le dossier est caché dans l'arbre pour le capitaine. Pourtant `GET /cso/folders/{sub}` lui répond 200, la recherche affiche le document et son aperçu fonctionne. Sans règle `view`, le droit retombe sur la permission du module, alors que l'écran annonce « seules les règles ci-dessous s'appliqueront ».
- **Correction proposée** : refuser une rupture d'héritage sans règle `view`, ou exiger une confirmation. Corriger le libellé. Exiger que tous les dossiers parents soient lisibles pour accéder à un dossier (accès direct comme recherche).

### [CSO-03] L'archivage rend irrécupérables les documents encore en première approbation
**Données · 🟠 Majeure**
- **Emplacement** : `/cso` · `apps/api/src/modules/cso/cso-workflow.service.ts:232-235,271-277` ; `apps/web/components/cso/document-actions.tsx:217,357-379` ; `restore-folder-dialog.tsx:66`
- **Cas** : on importe 5 documents, encore en attente, puis on archive le dossier. La restauration complète renvoie `documentsRestored: 0, documentsLeftArchived: 5`, et la restauration unitaire répond 422 « jamais approuvé ». La confirmation promettait pourtant « une restauration reste possible ».
- **Correction proposée** : restaurer ces documents en brouillon avec le dernier fichier, ou avertir et refuser avant l'archivage. Exposer un indicateur `restorable`.

### [CSO-04] Les messages contredisent la publication directe
**Incohérence · 🟠 Majeure**
- **Emplacement** : modales création, nouvelle version et copie · `apps/web/components/cso/document-forms.tsx:41,148,306` ; `document-actions.tsx:93,336` ; `apps/api/src/modules/cso/cso-documents.service.ts:456-471`
- **Cas** :
  - `cso` choisit « Soumettre pour approbation ». L'écran indique « un validateur devra approuver » et le toast « soumise », mais l'API publie immédiatement.
  - À l'inverse, dans un dossier où `cso` n'a pas l'action `approve`, la version reste en attente alors que le toast annonce « publiée ».
- **Correction proposée** : baser libellés et toasts sur le statut renvoyé par l'API (`PUBLISHED`), et nommer l'option « Publier directement » pour les profils `self_approve`.

### [CSO-05] La publication directe ignore les validateurs désignés du dossier
**Incohérence / Sécurité · 🟠 Majeure**
- **Emplacement** : `apps/api/src/modules/cso/cso-documents.service.ts:483` ; `apps/web/components/cso/validators-editor.tsx:67`
- **Cas** : le seul validateur désigné est `cso.deputy`, mais la v2 déposée par `cso` est publiée immédiatement à son nom.
- **Correction proposée** : réserver la publication directe aux validateurs éligibles (`isEligibleValidator`), ou l'indiquer clairement dans le panneau. À arbitrer.

### [CSO-06] Le ZIP révèle le nombre de documents invisibles
**Sécurité · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/cso/cso-zip.service.ts:207,243,264` ; `apps/web/components/cso/zip.tsx:102`
- **Cas** : la réponse contient `excludedCount: 1` pour un document invisible de l'appelant, et un uuid inexistant est compté comme exclu, ce qui permet de tester l'existence d'un document.
- **Correction proposée** : ne compter que les documents visibles mais non téléchargeables.

### [CSO-07] Le badge « À valider » compte des demandes que l'utilisateur ne peut pas décider
**Bug · 🟡 Mineure**
- **Emplacement** : `/cso/approvals` · `apps/api/src/modules/cso/cso-documents.service.ts:562-573` ; `apps/web/components/cso/cso-nav.tsx:50`
- **Cas** : le badge indique 2, mais « Décider » répond 403 « pas validateur désigné ».
- **Correction proposée** : appliquer `isEligibleValidator` au filtre `referenceChanges`.

### [CSO-08] Un partage se réactive tout seul après archivage puis restauration
**Sécurité · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/cso/cso-workflow.service.ts:218-257` ; `cso-shares.service.ts:166-171`
- **Correction proposée** : révoquer ou suspendre les partages à l'archivage, avec une trace dans l'audit.

### [CSO-09] Des notifications « Version à approuver » restent actives après l'archivage d'un dossier
**Bug · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/cso/cso-folders.service.ts:433` (à comparer avec `cso-documents.service.ts:802`)
- **Cas** : 6 notifications `cso.version_pending` de `cso.deputy` restent non résolues sur des versions annulées.
- **Correction proposée** : appeler `resolveForEntity('cso_document', id, 'cso.')` pour chaque document archivé en cascade.

### [CSO-10] Les doublons de nom dans un même ZIP ne sont pas détectés
**Données · 🟡 Mineure**
- **Emplacement** : `/cso/import/[id]` · `apps/api/src/modules/cso/cso-import.service.ts:285-289,387-475`
- **Cas** : `Procedure.pdf`, `Procedure.docx` et `procedure.PDF` donnent 3 documents homonymes.
- **Correction proposée** : détecter les titres identiques, sans tenir compte de la casse, par dossier, à l'intérieur du lot.

### [CSO-11] La recherche ne porte pas sur le contenu des fichiers, contrairement à ce qu'annonce le code
**Incohérence · 🟡 Mineure**
- **Emplacement** : `/cso/search` · `apps/api/src/modules/cso/cso-search.service.ts:17-19,79` ; `apps/web/components/cso/search-panel.tsx:49`
- **Cas** : un mot présent dans le PDF donne 0 résultat, alors qu'un commentaire du code annonce un « contenu indexé ».
- **Correction proposée** : indexer le texte des PDF, ou corriger la documentation et le libellé.

### [CSO-12] L'auteur reçoit une notification (et un e-mail) pour sa propre publication directe
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/cso/cso-documents.service.ts:539` ; `cso-workflow.service.ts:341-364`
- **Correction proposée** : ne pas appeler `notifyDecision` quand l'auteur publie lui-même.

### [CSO-13] Un 403 permet de vérifier qu'un dossier caché existe
**Sécurité · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/cso/cso-access.service.ts:208-217` ; `cso-search.service.ts:46-49`
- **Correction proposée** : renvoyer 404 pour une ressource invisible.

### [CSO-14] Certains boutons « Aperçu » ignorent les droits du document
**Amélioration UI · 🟡 Mineure** (constaté à la lecture du code)
- **Emplacement** : `apps/web/components/cso/approvals-list.tsx:132` ; `apps/web/app/(app)/cso/shared-with-me/page.tsx:91`
- **Cas** : le bouton s'affiche dès que l'utilisateur a `cso.preview`, même si une règle du dossier refuse l'aperçu, et le clic échoue alors.
- **Correction proposée** : exposer `actions` et `file.kind` dans ces deux listes, et utiliser `versionRights` et `isPreviewable`.

---

## 8. Achats

### [ACH-01] Pièces jointes : le cloisonnement « ses propres PR » est contourné, en lecture et en écriture
**Sécurité · 🔴 Critique**
- **Emplacement** : `/purchasing/requests/[id]` (Pièces jointes), BL et réceptions · `apps/api/src/modules/purchasing/purchasing-core.service.ts:292-323` (`entityVessel`), `:348-360`, `:159-165`
- **Cas** : `chief.iskander` reçoit 404 sur la PR du capitaine. Pourtant :
  - `GET /purchase-requests/:id/attachments` répond 200, et `GET /files/:id/download` répond 200 avec une URL signée.
  - L'ajout de pièces sur la PR, le BC et le BL du capitaine répond 201.
- **Correction proposée** : dans `entityVessel` et `list/addAttachment`, appliquer le filtre « propres PR » (`findPr` pour une PR, `assertPoVisible` pour un BC, un BL, une réception ou un écart). Faire le même contrôle dans le droit d'accès aux fichiers `OWNER_PURCHASING_ATTACHMENT`.

### [ACH-02] PR mise en attente puis livrée : blocage définitif
**Bug · 🔴 Critique**
- **Emplacement** : `/purchasing/requests/[id]` · `apps/api/src/modules/purchasing/purchasing.logic.ts:104` ; `purchase-requests.service.ts:656-663` ; `purchasing-core.service.ts:573`
- **Cas** : une PR de 2 lignes a un BC émis sur la ligne 1 ; on la met en attente, puis le bord saisit un BL « tout reçu » et le BC est clôturé. Ensuite :
  - « Reprendre » répond 409 ;
  - « Annuler » répond 422 (BC actifs) ;
  - « Clôturer » et Counter-PR répondent 409.

  La PR ne peut plus avancer et reste dans les relances.
- **Correction proposée** : autoriser depuis ON_HOLD les statuts ORDERED, PARTIALLY_RECEIVED, RECEIVED et CLOSED, et appeler `recomputePrStatuses` dans `resume`. Ou interdire la mise en attente dès qu'un BC est émis.

### [ACH-03] La PR mère divisée ne se clôture jamais si ses sous-PR sont annulées, rejetées ou clôturées à la main
**Bug · 🟠 Majeure**
- **Emplacement** : `purchase-requests.service.ts:665-692` ; `purchasing-core.service.ts:612-638` ; `purchasing.logic.ts:221`
- **Cas** : on annule les sous-PR -A et -B. La mère reste SPLIT, et la clôturer ou l'annuler répond 409.
- **Correction proposée** : appeler `closeParentIfDone(pr.parentId)` à chaque passage d'une sous-PR à un statut terminal.

### [ACH-04] BC après approbation d'un avenant : bloqué en « Approuvé », sans clôture automatique
**Bug / Incohérence · 🟠 Majeure**
- **Emplacement** : `/purchasing/orders/[id]` · `apps/api/src/modules/purchasing/orders.service.ts:861-864,901-941` ; `purchasing.logic.ts:547` ; `apps/web/app/(app)/purchasing/orders/[id]/page.tsx:42,113,123`
- **Cas** : un avenant à la hausse dépasse le seuil, et le second regard l'approuve : le BC passe APPROVED alors qu'il avait déjà été transmis. Le BL « tout reçu » est accepté, mais le BC reste APPROVED. L'interface ne propose ni « Noter l'envoi » ni « Clôturer », et la notification annonce « approuvé et émis ».
- **Correction proposée** :
  - Après approbation d'un avenant déjà transmis, recalculer le statut de réception, puis appeler `settleClosures` (y compris dans `markSent`).
  - Corriger le titre de la notification.
  - Afficher « Noter l'envoi » pour APPROVED avec `sentAt`.

### [ACH-05] L'unité du devis est ignorée : un BC « pcs » est créé au prix d'une « box »
**Données · 🟠 Majeure**
- **Emplacement** : `apps/api/src/modules/purchasing/orders.service.ts:383` ; `quotations.service.ts:74` ; `purchasing.logic.ts:881-889` ; `apps/web/components/purchasing/comparison-view.tsx:35,342`
- **Cas** : la RFQ demande 12 pcs, et le devis propose « 1 box à 24 € ». Le BC créé contient « 1 pcs à 24 € », et 11 pcs restent à commander. Le comparatif classe aussi l'offre « moins chère » sans tenir compte de l'unité.
- **Correction proposée** : refuser une unité différente, ou exiger un facteur de conversion, et ne comparer les prix qu'à unité égale.

### [ACH-06] Chief Engineer (sans `pr.view_all`) : factures, RFQ, devis et compteurs non filtrés sur ses PR
**Sécurité / Incohérence · 🟠 Majeure**
- **Emplacement** : `apps/api/src/modules/purchasing/invoices.service.ts:38-48,61-67` ; `rfqs.service.ts:36-38` ; `purchasing-board.service.ts:69`
- **Cas** : `chief.iskander` voit la facture du BC du capitaine (montants, rapprochement) et la RFQ issue de sa PR. « Réceptions à valider » affiche 7, soit le total du navire.
- **Correction proposée** : filtrer les factures via les BC propres et les RFQ et devis via `prLine.pr.requesterId`, ou retirer `invoice.view`, `rfq.view` et `quotation.view` au rôle CHIEF_ENGINEER.

### [ACH-07] Discussion de PR : les messages du demandeur ne sont notifiés à personne
**Bug · 🟠 Majeure**
- **Emplacement** : `/purchasing/requests/[id]`, onglet Discussion · `apps/api/src/modules/purchasing/purchase-requests.service.ts:768-779`
- **Cas** : la notification part au seul demandeur, qui en est aussi exclu en tant qu'auteur. Ni `purchasing` ni `purchasing.manager` ne la reçoivent.
- **Correction proposée** : si l'auteur est le demandeur, notifier les détenteurs de `pr.approve` sur le navire, ou au moins l'acheteur qui a mis la PR en discussion.

### [ACH-08] Un écart peut être rouvert sur un BC déjà clôturé
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/purchasing/variances.service.ts:278-280` ; `apps/web/app/(app)/purchasing/deliveries/variances/[id]/page.tsx:78-83`
- **Cas** : on obtient un BC CLOSED avec un écart IN_PROGRESS.
- **Correction proposée** : refuser la réouverture si le BC est CLOSED ou CANCELLED, et masquer le bouton.

### [ACH-09] BL du bord envoyé deux fois en même temps : 409 au lieu du rejeu
**Bug · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/purchasing/receiving.service.ts:409-410` ; `apps/web/components/purchasing/onboard-bl-form.tsx:126`
- **Cas** : 3 envois simultanés avec la même clé donnent une réponse 201 et deux 409. L'écran affiche une erreur alors que le BL est enregistré, ce qui pousse à le ressaisir avec une nouvelle clé.
- **Correction proposée** : renvoyer le résultat d'origine (`findOnboardReplay`) avec le code 200.

### [ACH-10] Remise et fret du devis perdus à la création du BC
**Données · 🟡 Mineure**
- **Emplacement** : `apps/web/components/purchasing/comparison-view.tsx:301` ; `orders.dto.ts`
- **Cas** : un devis de 46,72 € (fret 1 €, remise 0,50 €) donne un BC de 46,22 €.
- **Correction proposée** : pré-remplir fret et taxes depuis le devis et ajouter un champ remise au BC, ou au moins avertir.

### [ACH-11] Dates et devises peu contrôlées
**Données · 🟡 Mineure**
- **Emplacement** : `apps/api/src/common/pagination.ts:62` (`isoCurrency`) ; `receiving.dto.ts:36` ; `orders.dto.ts:30` ; `invoices.dto.ts:13` ; `rfqs.dto.ts`
- **Cas** : sont acceptés une devise « ZZZ », une livraison attendue en 2020, un BL daté de 2027, une échéance de facture antérieure à sa date, une facture de 0 € et une date limite de RFQ passée. Un BL futur est aussi visible dans les notifications (« BL du 01/05/2027 »).
- **Correction proposée** : liste blanche ISO 4217, BL non futur, échéance ≥ date de facture, montant > 0, avertissement sur les dates passées.

### [ACH-12] Facture annulée ou mise en litige sans motif
**Incohérence API ↔ interface · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/purchasing/invoices.service.ts:204-233` ; l'interface (`invoices/[id]/page.tsx:40`) exige un motif, l'API non
- **Correction proposée** : rendre `notes` obligatoire côté serveur pour CANCELLED et DISPUTED.

### [ACH-13] « Factures en litige » affiche toujours 0
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/purchasing/purchasing-board.service.ts:74` ; `/purchasing/invoices`
- **Cas** : les factures en écart de rapprochement gardent le statut RECEIVED : la tuile reste à 0 et la liste n'affiche pas l'écart.
- **Correction proposée** : compter et afficher les écarts de rapprochement, ou passer automatiquement la facture en DISPUTED.

### [ACH-14] Le message après un avenant cite une route supprimée
**Incohérence · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/purchasing/orders.service.ts:1263` (affiché par `po-dialogs.tsx:230`)
- **Cas** : le toast indique « renvoyez le BC au fournisseur (POST /orders/:id/send) ».
- **Correction proposée** : « Notez l'envoi au fournisseur ».

### [ACH-15] PDF de la PR : priorité affichée en code brut
**Amélioration UI · 🟡 Mineure**
- **Emplacement** : `apps/api/src/modules/purchasing/purchasing-documents.service.ts:76`
- **Cas** : le PDF affiche « PRIORITÉ NORMAL » au lieu de « Normale ».
- **Correction proposée** : utiliser les libellés français des priorités.

---

## 9. Qualité des données de la base réelle (lecture seule)

| Contrôle | Résultat | Constat |
|---|---|---|
| Affectations COMPLETED sans date de débarquement | 48 | FLT-02, FLT-09, UI-03 |
| Seaman books stockés avec espaces (introuvables par la recherche) | 153 sur 161 | FLT-04 |
| Seaman book partagé par deux marins | 1 (« TG 2384 ») | FLT-09 |
| Fiches sans nationalité | 174 sur 174 | FLT-09 |
| Marins « à bord » réels | 0 (2 fiches DÉMO) | FLT-08 |
| Certificats actifs expirés depuis plus de 3 ans | 148 | UI-08 |
| Certificats actifs de marins inactifs | 8 | UI-08 |
| Doublons de certificats (même marin et même type) | 0 | ✅ |
| `email_deliveries` vers des notifications supprimées | 6 | DAT-01 |
| Particularités du navire ISKANDER renseignées | IMO, type et fuseau seulement | FLT-21 |

---

## 10. Couverture

### Testé sans anomalie
- **Authentification** :
  - Message unique d'échec de connexion.
  - Verrouillage au 5ᵉ échec avec révocation des sessions.
  - Changement obligatoire du mot de passe (compte `nouveau`).
  - CSRF.
  - Expiration après inactivité.
  - Politique de mot de passe.
  - Jeton déjà utilisé refusé.
- **Délégation d'administration** : pas d'attribution de droits non possédés, pas de « Toute la flotte », rôles système protégés.
- **Fichiers** :
  - Type réel contrôlé (exécutable ou HTML déguisé en PDF, fichier vide).
  - Chemins nettoyés.
  - Liens signés de 60 s.
  - ZIP CSO : `../`, `.exe` et bombe ZIP rejetés.
- **Cloisonnement navire (ADM-070)** sur les certificats : aucune fuite sur 20 points d'accès (fiche, aperçu, liste, filtres, compteurs, rappels).
- **Certificats** :
  - Cycle complet : création, retour, nouvelle version, approbation ; renouvellement refusé puis approuvé ; correction ; archivage.
  - Validateurs désignés.
  - Rappels d'échéance.
  - 48/48 tests unitaires.
- **CSO** : partages (révocation immédiate), 54/54 tests unitaires.
- **Achats** :
  - Saisies invalides (négatif, zéro, décimales, `1e21`) et arrondis.
  - Pas d'auto-approbation.
  - Transitions interdites.
  - Sur-allocation en parallèle.
  - Double émission.
  - Seuils de second regard.
  - Clôture automatique nominale.
  - E-mails Mailpit.
  - PDF et numérotation.
  - 55/55 tests unitaires.
- **Flotte** :
  - IMO avec clé de contrôle.
  - Unicité des embarquements.
  - Automate d'états des voyages.
  - Verrou optimiste.
  - Charter Parties (auto-approbation interdite).
  - Bornes des Noon Reports.
  - Import Excel (doublons, motif obligatoire pour forcer, rapport).
- **Interface** :
  - 39 pages sans erreur JavaScript ni requête API en échec en Super Admin.
  - Navigation et boutons adaptés aux droits pour le capitaine, le chief, la Direction et le Commercial.
  - Pages « Accès non autorisé » propres.
  - Validation du formulaire PR.
  - Rendu mobile correct du tableau de bord, des certificats, des marins, du nouveau Noon Report et du BL bord.
  - Confirmations présentes sur les actions destructives.

### Non testé ou partiellement testé
- **Second navire** : `captain.demo2` est désactivé et il n'existe qu'un seul navire réel. Le cloisonnement entre deux navires a été vérifié avec un navire d'audit, pas avec un second capitaine.
- **Fonctions absentes de la base réelle** : la base réelle n'a aucun voyage, Charter Party ni Noon Report. Ces modules n'ont été testés que sur des données d'audit.
- **Fonctions non couvertes** : tâches, notices et NOR des voyages ; BC complémentaire ; visa Captain ; contenu des exports XLSX ; escalade des approbations en retard ; expiration des exports MinIO ; antivirus (désactivé) ; comportement derrière un vrai reverse proxy.
- **Constats sans test navigateur** : ADM-02, ADM-08, CRT-14 et CSO-14 ont été constatés à la lecture du code. Ils doivent être reproduits dans un navigateur avant correction.

---

## 11. Environnement d'audit à nettoyer

Ces éléments ont été créés pour l'audit et n'affectent pas la base réelle :
- Base PostgreSQL **`amc_e2e`** (copie de `amc`, avec des données `AUDIT-*`, dont un compte **Super Admin `audit-sa-*`**). À supprimer : `docker exec amc_postgres dropdb -U amc amc_e2e`.
- **API d'audit sur le port 4001** (fenêtre `cmd` réduite, `node dist/main.js`, Redis db 5) et **proxy sur 127.0.0.1:3101** : fermer les deux fenêtres.
- Objets MinIO déposés pendant les tests (bucket `amc-files`, contextes PR, BL, CSO et certificats d'audit) et messages Mailpit : à purger si besoin.
- Scripts de test et captures d'écran : dossier `scratchpad/audit/` de la session et `.playwright-mcp/audit-*.png`.
