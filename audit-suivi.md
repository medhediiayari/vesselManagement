# Suivi de l'audit — corrections, décisions métier en attente et nouveaux problèmes

**Date** : 30/10/2026 · **Référence** : [audit.md](audit.md) (109 constats) · **Code** : non commité, à relire avant commit.

---

## 1. Bilan

| Statut | Nombre | Constats |
|---|---|---|
| ✅ Corrigé | 95 | tous les autres |
| 🟨 Corrigé en partie (le reste dépend d'une décision ou d'un chantier plus large) | 8 | UI-01, UI-08, ADM-12, FLT-12, FLT-16, CRT-11, CRT-15, ACH-11 |
| ⏸️ Non corrigé : décision métier ou correction de données | 6 | FLT-08, FLT-09, FLT-21, FLT-22, CSO-05, ACH-05 |

**Les 4 critiques sont corrigés** : FLT-01, ACH-01, ACH-02 et CSO-01.

### Ce qui a été vérifié
- **Typecheck** : `npm run typecheck` (types, API, web) passe sans erreur.
- **ESLint** : `next lint` ne remonte aucune erreur.
- **Tests unitaires** : 347/347 tests API (17 suites). Des tests ont été ajoutés ou adaptés : achats, CSO, certificats, administration, exports, flotte, échappement des jokers.
- **Rejeu sur la copie `amc_e2e`** (API d'audit relancée avec le nouveau code), 9 cas sur 9 :
  - un fuseau « Mars/Olympus » est refusé (FLT-01) ;
  - `?from=2026-13-01` donne 422 « Date inexistante » au lieu de 500 (FLT-03) ;
  - l'équipage au 29/10 compte 2 personnes au lieu de 50 (FLT-02) ;
  - le chief ne trouve plus la PR du capitaine dans la recherche (ADM-01) et reçoit 404 sur ses pièces jointes (ACH-01) ;
  - `%` ne renvoie plus tout (ADM-22, ADM-N3) ;
  - « Identifiant invalide » et « Champ obligatoire » s'affichent en français (ADM-19) ;
  - la devise ZZZ est refusée (ACH-11).
- **Navigateur** : en 390 px, le formulaire de nouvelle PR fait 375 px de large au lieu de 828 px (UI-01). Capture : `.playwright-mcp/fix-ui01-mobile.png`.
- **Non vérifiés dans le navigateur**, couverts seulement par le typecheck et les tests : les autres écrans modifiés. Une recette visuelle reste à faire, en priorité sur :
  - `/members` (panneau latéral) ;
  - `/certificates` (tri, export, « Déplacer… ») ;
  - `/admin/users/[id]` et `/admin/settings` ;
  - `/noon-reports` ;
  - les modales CSO.

### Mise en service
- **API (port 4000)** : elle tourne en `--watch` et a rechargé le code.
- **Interface (port 3100)** : reconstruite (`next build`) puis relancée en `next start`.
- **Migration `0052_email_deliveries_orphans`** (DAT-01) : appliquée sur la base réelle `amc` (`prisma migrate deploy`). Elle met à NULL les 6 envois d'e-mails orphelins. **C'est la seule écriture faite en base réelle**, et le contrôle `pg_restore` est désormais possible.
- **Aucun changement de permissions, de rôles ni de schéma Prisma.**

### Corrections transverses, faites à un seul endroit
- **Messages de validation en français** (`apps/api/src/common/zod-fr.ts`, chargé dans `main.ts`) : ADM-19 et FLT-14.
- **Messages du framework traduits** dans `http-exception.filter.ts` : 429 « Trop de tentatives… », UUID, 413, 404 de route (ADM-18 et ADM-19).
- **Dates inexistantes refusées** : `dateOnly` et le nouveau `dateOnlyString` dans `pagination.ts` (FLT-03), réutilisés par l'import des marins.
- **Liste blanche ISO 4217 des devises** dans `isoCurrency` (ACH-11).
- **Jokers LIKE (`%`, `_`, `\`) échappés** dans toutes les recherches de listes (`common/utils/like.ts`) : ADM-22 et ADM-N3.

---

## 2. Décisions métier en attente

Chaque point indique la question, les options et ce qui est déjà prêt. Le code n'a pas tranché à la place du métier.

### 2.1 Données réelles à corriger (rien n'a été modifié)

> **Mise à jour du 30/10/2026 (purge des données de démo)** : la base réelle ne garde plus que les rôles, les comptes, ISKANDER, les 170 marins de la reprise et leurs certificats, et la configuration (script `backups/purge-demo-2026-10-30.sql`, sauvegarde `backups/amc-avant-purge-2026-10-30.dump`). Conséquences sur ce tableau :
> - **FLT-08** : les 4 fiches DÉMO et leurs affectations sont supprimées. Reste à rattacher `captain.iskander` et `chief.iskander` aux fiches des vrais marins, puis à saisir les vrais embarquements.
> - **CSO-N1**, **ADM-N4**, **ACH (données)**, **FLT-07/16 (contrôles)** : sans objet. Il n'y a plus de document CSO, d'export, de donnée Achats, de Noon Report ni de Charter Party.
> - **UI-08** : les 5 certificats de démo du navire sont supprimés. La question des 148 certificats expirés de la reprise reste ouverte.
> - L'historique a été vidé (journal d'audit, notifications, e-mails, sessions) et les numérotations repartent à 0001.

| ID | Question | Options | Prêt |
|---|---|---|---|
| **FLT-08** | Que faire des fiches DÉMO-ALPHA, BRAVO, CHARLIE et DELTA, et de leurs affectations (2 ONBOARD, 1 PLANNED) ? | (a) Archiver les fiches, clore ou annuler les affectations, rattacher `captain.iskander` et `chief.iskander` à de vraies fiches ; (b) les garder pour la formation, avec la mention DÉMO ; (c) ne rien faire | Les commandes existantes (débarquement, annulation, archivage) suffisent. Le navire ne peut plus passer en Vendu ou Inactif tant qu'elles sont ouvertes (FLT-05). |
| **FLT-09** | Qui corrige la reprise ISKANDER (Crewing), et d'après quelle source ? Anomalies : seaman book « TG 2384 » partagé, 48 COMPLETED sans débarquement, 11 sans embarquement, chevauchements BEN OTHMEN, nationalité et sexe vides | Correction fiche par fiche, ou réimport corrigé suivi d'un nouveau contrôle des doublons | Le code ne compte plus ces affectations comme « à bord » (FLT-02) et affiche « débarquement manquant » (UI-03). |
| **FLT-04** (volet données) | Faut-il réécrire les 153 seaman books et les 4 passeports stockés avec espaces ? | (a) Migration `regexp_replace(upper(x),'[^A-Z0-9]','','g')`, à valider sur une copie ; (b) ne rien réécrire | La recherche trouve déjà « TG 2384 », « TG2384 » et « tg-2384 » sans toucher aux données. |
| **FLT-21** | Qui complète la fiche ISKANDER (MMSI, pavillon, classe…) ? Faut-il effacer la note de démonstration « Navire cité dans le cahier des charges… » ? | Saisie par l'interface, ou script validé | Le lien « Compléter la fiche » s'affiche pour qui a `vessels.edit`. |
| **UI-08** (volet données) | Faut-il archiver en lot les 148 certificats expirés depuis plus de 3 ans et les 8 certificats de marins inactifs ? | (1) Action « Archiver la sélection » avec N configurable et motif obligatoire ; (2) script ponctuel en simulation puis `--apply` ; (3) ne rien archiver | Le tri par défaut « À échoir d'abord » est en place. `archive()` clôture désormais le suivi de renouvellement. |
| **CSO-N1** | Révoquer les partages et résoudre les notifications des documents CSO **déjà** archivés avant la correction CSO-08/09 (dont 6 `cso.version_pending` chez `cso.deputy`) ? | Exécuter les deux `UPDATE` proposés ci-dessous, avec une trace d'audit système | Les archivages futurs sont traités automatiquement. |
| **CSO-N4** | Des éléments CSO sont déjà en rupture d'héritage sans règle « Autoriser · Consulter » : toute nouvelle modification de leurs accès sera refusée (422) | Les lister (`inherit_acl = false` sans ALLOW `view`) et faire compléter les règles par la Sûreté | Règle active depuis CSO-02. |
| **ACH** (données) | Que faire des PR mères restées SPLIT avec des sous-PR toutes terminées, et des écarts IN_PROGRESS sur des BC CLOSED ? | Clôture en lot, ou au cas par cas | Le bouton « Clôturer » est proposé sur ces PR mères. |
| **ADM-N4** | Nettoyer les anciennes lignes `export_jobs.error` qui contiennent le message Prisma brut ? | `UPDATE export_jobs SET error = 'Erreur interne…' WHERE status = 'FAILED'`, puis retirer le masquage à la lecture | Ces messages sont masqués à la lecture (heuristique). |
| **FLT-01 / 07 / 16** (contrôles) | Faut-il lister ou corriger (1) les navires dont le fuseau stocké est invalide, (2) les doublons NOON/MIDNIGHT du même jour créés avant la correction, (3) les références de Charter Party qui ne diffèrent que par la casse ? | Requêtes de contrôle, puis correction validée | L'API refuse désormais ces trois cas pour les nouvelles saisies. |

Scripts proposés pour CSO-N1, à valider avant exécution :
```sql
UPDATE cso_shares s SET revoked_at = now() FROM cso_documents d
 WHERE d.id = s.document_id AND d.status = 'ARCHIVED' AND s.revoked_at IS NULL;
UPDATE notifications SET resolved_at = now()
 WHERE entity_type = 'cso_document' AND type LIKE 'cso.%' AND resolved_at IS NULL
   AND entity_id IN (SELECT id FROM cso_documents WHERE status = 'ARCHIVED');
```

### 2.2 Règles métier et matrice RACI

| ID | Question | Options | Prêt / appliqué par défaut |
|---|---|---|---|
| **CSO-05** | Un profil `cso.self_approve` peut-il publier directement dans un dossier dont il n'est pas validateur désigné ? | (1) Statu quo ; (2) réserver la publication directe aux validateurs éligibles (une ligne dans `publishOrNotify`) ; (3) option « publication directe interdite » par dossier (migration) | Règle inchangée. Le panneau « Validateurs » l'explique désormais. |
| **ACH-05** | Que faire d'un devis chiffré dans une autre unité que la RFQ (« 1 box » pour « 12 pcs ») ? | (1) Refuser la ligne ; (2) facteur de conversion (colonne `quotation_lines.conversion_factor`, donc migration) ; (3) avertissement seul | Avertissement seul : badge « Unité X ≠ Y » dans le comparatif et à la création du BC. Le classement « moins cher » ignore toujours l'unité. |
| **FLT-22** | La règle « l'historique donne du contexte » (`member-access.ts:14`) s'applique-t-elle à `GET /crew-assignments` ? Le capitaine y voit le nom et la photo de marins hors de son périmètre | (a) Ajouter `memberAccessible` et masquer photo et nationalité, comme le roster ; (b) garder la règle | Rien de modifié. |
| **FLT-12** + **FLT-N2** | ✅ **COMMERCIAL tranché le 30/10** : `voyages.view` + `voyages.create` accordés (Operations et Commercial créent les voyages, le créateur est affiché partout). ✅ **OPS_MANAGER tranché le 31/10** : `voyages.view` accordé (lecture seule, réversible). Sans ce droit, impossible aussi de choisir un voyage à la création d'un Noon Report | (a) Ajouter la permission (`permissions.ts`, seed, base) ; (b) exposer une liste minimale des voyages ouverts sous `noon.create` ; (c) statu quo | Sans le droit, liens, fil d'Ariane et filtre « Voyage » sont masqués. |
| **ACH-06** | Retirer `invoice.view`, `rfq.view` et `quotation.view` au CHIEF_ENGINEER ? | Option RACI distincte | Le filtrage « ses propres PR » est appliqué côté serveur, sans changer les droits. |
| **ACH-N4** | RFQ qui regroupe plusieurs PR : un demandeur sans `pr.view_all` voit le numéro et les lignes des PR des autres | Masquer, ou considérer les lignes d'une RFQ comme partagées | Rien de modifié. |
| **ACH-11** (reste) | Refuser une date de livraison attendue passée sur un BC ? Un BC peut être saisi a posteriori | Refus 422, avertissement, ou statu quo | BL non futur, échéance ≥ date de facture, montant > 0 et date limite de RFQ non passée sont en place. |
| **ACH-13** | Une facture en écart de rapprochement doit-elle passer automatiquement « En litige » ? | Automatique, ou manuel | Tuile « Factures en écart de rapprochement » et badge dans la liste. Statut inchangé. |
| **CRT-15** | Les dossiers de certificats sont globaux : faut-il masquer à un utilisateur ceux qui sont vides pour lui ? | (1) Documenter qu'ils sont globaux ; (2) masquer pour les non-gestionnaires (filtre dans `listFolders`) ; (3) périmètre par dossier (schéma) | 404 au lieu de 403 sur un certificat hors périmètre : fait. |
| **CRT-02** | Validateur désigné sans droit d'approuver : refuser dès qu'un seul validateur est inefficace, ou seulement quand aucun n'est efficace ? Faut-il tenir compte du périmètre navire ? | Refus strict ; refus si aucun (actuel) ; prise en compte du navire | Refus 422 si aucun validateur effectif ; avertissement dans le sélecteur sinon. |
| **CRT** (renouvellement) | Une demande de renouvellement annulée laisse le suivi « En cours ». Est-ce voulu ? | (1) Voulu (ADM-048) ; (2) revenir à « Non démarré » si la tâche est automatique | Rien de modifié. |
| **FLT-05** + **FLT-N5** | Navire Désarmé ou Inactif : faut-il bloquer aussi la création de voyage en brouillon ? | Bloquer Inactif, garder Désarmé (préparation pendant un arrêt technique) | Refusés : Vendu ou Inactif s'il reste des affectations ou voyages ouverts, activation de voyage si le navire n'est pas Actif, embarquement et Noon Report sur un navire Vendu ou Inactif. Création de voyage : seul Vendu est bloqué. |
| **ADM-09** | Page d'arrivée d'un profil sans tableau de bord (Crewing) ? | (a) Première entrée de menu autorisée (appliqué) ; (b) page fixée par rôle ; (c) rendre `dashboard.view` à CREWING | `homeHref()` dans `components/shell/nav.ts`. |
| **ADM-06** | Un seul navire sélectionné : `/certificates` doit-il montrer le navire seul, ou le navire et son équipage (comme le tableau de bord) ? | (1) Liens du tableau de bord en `vesselIds` (appliqué) ; (2) aligner `/certificates` ; (3) aligner le tableau de bord | Les chiffres du tableau de bord et de la liste ouverte concordent. |
| **UI-04** + **UI-N5** | Quelle heure de référence dans les pages : UTC (horloge), heure bord, ou heure du poste ? | — | L'heure locale est indiquée « (heure locale) » aux deux endroits cités ; ailleurs, sans mention. |
| **UI-06** | Définition d'un « profil en lecture seule » | Règle actuelle : toutes les permissions sont `view`, `preview`, `download` ou `export`. Alternative : un réglage par rôle | « Points de vigilance » au lieu de « Actions requises ». |
| **ADM-12** + **UI-N1 à N3** | Les exports doivent-ils reprendre **tous** les filtres de l'écran ? | Étendre les filtres de `POST /exports` (réutiliser le `where` de la liste), ou garder l'export large | Boutons « Exporter » en place ; une infobulle précise les filtres repris. |
| **UI-01** (reste) | Saisie des lignes de PR en cartes empilées sur téléphone ? | Chantier d'ergonomie | Le débordement est corrigé et l'aide clavier masquée sous 640 px. |

### 2.3 Choix appliqués par défaut, à confirmer (une ligne à changer si besoin)
- **ADM-04** : un compte verrouillé qui demande « mot de passe oublié » ne reçoit pas de lien. Il reçoit à la place un e-mail « Compte verrouillé : contactez un administrateur », et la réponse HTTP reste la même pour tous. Faut-il garder cet e-mail ?
- **ADM-13** : quand un admin change l'e-mail d'un compte, la case « vérifié » se remet à zéro ; il faut deux enregistrements pour attester la nouvelle adresse. L'alternative est un vrai parcours de vérification par lien (évolution).
- **ADM-17** : les admins délégués sans `settings.manage` voient « Après plusieurs échecs » au lieu du seuil exact. Faut-il leur montrer le seuil ?
- **ADM-28** : « Révoquer toutes les sessions » sans session active renvoie 409. Préfère-t-on un 200 `{revoked: 0}` ?
- **ACH-02** : on sort de « En attente » vers le statut d'avancement réel. Variante écartée : interdire la mise en attente dès qu'un BC est émis.
- **ACH-04** : après approbation d'un avenant déjà transmis, le BC reprend directement son statut de réception, sans attendre « Noter l'envoi ».
- **ACH-07** : un message du demandeur est notifié aux acheteurs qui suivent déjà la PR, ou à défaut aux détenteurs de `pr.approve` sur le navire.
- **CSO-03** : un document archivé pendant sa première approbation revient en **brouillon** à la restauration, au lieu d'un refus.
- **CSO-10** : un homonyme dans un même dossier d'un lot d'import est traité comme une **erreur**, et non comme un simple avertissement.
- **FLT-24** : planifier un marin encore à bord ailleurs, avec une date d'embarquement déjà passée, est **refusé** (422). La confirmation explicite n'est pas implémentée.

---

## 3. Nouveaux problèmes rencontrés pendant les corrections

Ceux marqués ✅ ont été corrigés dans la foulée, les autres restent ouverts.

### Transverse
- ✅ **TRV-N1 — La carte d'erreurs française était écrasée au démarrage.**
  - **Emplacement** : `node_modules/nestjs-zod/dist/index.js:265`.
  - **Cas** : `nestjs-zod` installe sa propre carte d'erreurs, en anglais, au chargement. Il était chargé après `zod-fr`, donc « Required » restait en anglais.
  - **Correction** : `zod-fr.ts` importe `nestjs-zod` avant de poser la carte française. Vérifié par rejeu.

### Administration
- ✅ **ADM-N2** — La fiche utilisateur chargeait les sessions dès l'ouverture. Depuis ADM-14, un compte non gérable produisait alors un 403 journalisé « accès refusé » à chaque consultation. Les sessions sont maintenant chargées à l'ouverture de l'onglet, avec un message clair (`admin/users/[id]/page.tsx`).
- ✅ **ADM-N3** — Les jokers `%` et `_` étaient encore actifs dans une quinzaine de recherches (marins, certificats, navires, voyages, Charter Parties, PR, BC, RFQ, factures, réceptions, fournisseurs). Ils sont maintenant échappés partout. Reste : `cso-rules.ts` a son propre `escapeLike`, en double, à regrouper avec `common/utils/like.ts`.
- **ADM-N1** — Un administrateur peut encore se bloquer lui-même en retirant le rôle qui lui donne `permissions.manage`, `users.*` ou `roles.*`, ou en retirant `roles.manage` d'un rôle qu'il détient. Fichiers : `users.service.ts` (`setRoles`) et `roles.service.ts`. **Correction proposée** : calculer les droits effectifs après la modification et refuser (422) si un droit `isSelfLockoutPermission` disparaît.
- **ADM-N5** — Sur `/admin/system`, « Lancer » une tâche avec `WORKERS_ENABLED=false` répond « mise en file » même si aucun worker ne tourne (`system.controller.ts`). **Correction proposée** : vérifier `queue.getWorkers()` ou afficher « exécutée par le worker externe ».
- **UI-N4** — Sur `/account`, un bouton est imbriqué dans un lien, ce qui donne un HTML invalide et une double tabulation (`account/page.tsx:35-37`). **Correction proposée** : un `Link` stylé en bouton.
- **UI-N6** — Le compteur « Demandes de certificats à valider » exclut les propres demandes de l'utilisateur, mais le lien ouvre une liste qui les inclut (`dashboard.service.ts:145-154`). **Correction proposée** : pointer vers `/certificates/approvals`.
- **UI-N7** — Les filtres du journal d'audit ne sont pas conservés dans l'URL : retour arrière et lien copié les perdent. **Correction proposée** : `router.replace`, comme `/certificates`.

### Flotte
- ✅ **FLT-N1** — `(app)/error.tsx` ne couvre pas les erreurs de la mise en page (en-tête, horloge). Un `app/global-error.tsx` a été ajouté, avec Réessayer et « Revenir à toute la flotte ».
- **FLT-N3** — `GET /crew-assignments?from=` traite une affectation COMPLETED sans débarquement autrement que le roster (FLT-02). Fichier : `crew-assignments.service.ts:74-82`. **Correction proposée** : même règle que `onboardAtDateWhere`.
- **FLT-N4** — La recherche par identifiant normalisé parcourt toute la table `members`, faute d'index. **Correction proposée** : index fonctionnel (migration) ou normalisation des données (FLT-04).
- **FLT-N6** — Les événements d'audit `vessel.updated` antérieurs à la correction contiennent encore `updatedAt` dans l'export d'audit. Le journal est en ajout seul : à savoir, sans action.

### Certificats
- **CRT-N1** — Passer de 403 à 404 (CRT-15) a un effet de bord : les tentatives d'accès à un certificat hors périmètre ne sont plus journalisées « accès refusé », car seuls les 403 le sont. **Correction proposée** : enregistrer un événement `DENIED` explicite dans `assertVisible`, puis renvoyer 404. Même remarque pour CSO-13.
- **CRT-N2** — Une publication directe s'affiche « Soumise à approbation » puis « Approuvée », au lieu de « Publiée directement » (`request-card.tsx:137-141`).
- **CRT-N3** — Le compteur « N certificat(s) » de la Configuration compte les certificats vides (`certificate-types.service.ts:104`). **Correction proposée** : réutiliser le filtre `LISTED_CERTIFICATE`.
- **CRT-N4** — À la création d'un certificat, aucun aperçu des validateurs qui recevront la demande (`certificate-form.tsx:206`). **Correction proposée** : `GET /certificate-types/:id/approvers`.
- **CRT-N5** — L'auteur d'une annulation est lu dans le journal d'audit, faute de colonne `cancelled_by_id`. **Correction proposée** : ajouter cette colonne par migration.

### Documents CSO
- **CSO-N2** — Un brouillon issu d'une restauration ne peut être soumis que par la personne qui l'a restauré, ce qui bloque l'auteur d'origine (`cso-documents.service.ts:410,432`). **Correction proposée** : autoriser l'auteur ou un titulaire de `edit`.
- **CSO-N3** — Une bibliothèque hors périmètre répond 403 au lieu de 404 (`cso-access.service.ts:81`).
- **CSO-N5** — Le commentaire d'en-tête de `cso-workflow.service.ts:17` est obsolète : « jamais publiée sans approbation distincte ».
- **CSO-N6** — Le bouton « Annuler une version » exige `cso.create` ou `cso.edit`, alors que l'API n'exige que d'être le déposant (`document-actions.tsx:75`).

### Achats
- ✅ **ACH-N2** — Les PDF générés (PR, BC, RFQ, rapport de réception) échappaient au cloisonnement « ses propres PR ». Corrigé avec ACH-01.
- ✅ **ACH-N3** — Un BL du bord rejoué affichait « Conforme » même en cas d'écart. Corrigé avec ACH-09.
- **ACH-N1** — L'export Excel des PR affiche priorité et statuts en codes bruts (`purchasing-exports.service.ts:117,120,193`). **Correction proposée** : reprendre les libellés français du PDF.
- **ACH-N5** — Une réception peut être datée dans le futur (`receiving.dto.ts:80`). **Correction proposée** : même règle que le BL.
- **ACH-N6** — Une facture peut être datée dans le futur (`invoices.dto.ts:13`). **Correction proposée** : même règle que le BL.
- **ACH-N7** — Le compteur « écarts de rapprochement » recalcule chaque facture à la volée (4 requêtes par BC, plafond 200). C'est acceptable aujourd'hui. **Correction proposée** : stocker la suggestion si le volume augmente.

---

## 4. Détail des fichiers modifiés
Les comptes rendus détaillés par module, avec la liste des fichiers par constat, sont dans le dossier de travail de la session. En résumé :
- **API** :
  - modules `auth`, `admin`, `dashboard`, `exports`, `files`, `jobs` et `settings` ;
  - modules `vessels`, `members`, `voyages`, `noon`, `certificates`, `cso` et `purchasing` ;
  - `common/` : `zod-fr.ts`, `pagination.ts`, filtre d'exceptions et `utils/like.ts` ;
  - migration `0052_email_deliveries_orphans`.
- **Web** :
  - pages `admin/*`, `(auth)/*`, tableau de bord, `vessels/*`, `members/*`, `voyages/*`, `noon-reports/*`, `certificates/*`, `cso/*` et `purchasing/*` ;
  - nouveaux fichiers : `app/(app)/error.tsx`, `app/global-error.tsx`, `components/amc/resource-export.tsx`, `components/amc/password-rules.tsx`, `admin/users/role-grant.ts`.
- **Nouveaux points d'accès API** :
  - `GET /auth/password-policy` (public : longueur minimale du mot de passe) ;
  - `GET /settings/limits` (`settings.manage`) ;
  - `POST /certificate-types/validators/check`.
