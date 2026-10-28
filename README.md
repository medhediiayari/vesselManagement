# Plateforme maritime AMC — Africa Marine Company

Plateforme web B2B unique pour les services AMC à terre et le personnel embarqué :
utilisateurs / rôles / scopes navires, flotte et équipages, **certificats navires et marins**,
**bibliothèque documentaire de sûreté CSO**, **achats PR → RFQ → BC → BL → réception → factures**,
**voyages / Charter Parties / Noon Reports**, notifications, audit et exports.

Spécification de référence : `AMC_Cahier_des_Charges_Complet_Developpement_2026.pdf`
(édition consolidée du 11/10/2026 — elle prévaut sur l'annexe V1).

---

## 1. Architecture

```
Navigateur ──► Next.js 14 (apps/web, :3100) ──/api/v1──► NestJS 10 (apps/api, :4000)
                                                         ├── PostgreSQL 16 (:5434)   source d'autorité (contraintes, triggers)
                                                         ├── MinIO (:9100 / console :9101)  PDF, Excel, images — buckets privés
                                                         ├── Redis 7 + BullMQ (:6380) e-mails, antivirus, rappels, ZIP
                                                         ├── SMTP (Mailpit :1025, UI :8025 en dev)
                                                         └── ClamAV (optionnel, :3310)
```

| Dossier | Contenu |
|---|---|
| `apps/api` | API REST `/api/v1` (monolithe modulaire NestJS, Prisma, OpenAPI `/api/docs`) |
| `apps/api/prisma` | `schema.prisma` (≈ 90 tables), migrations SQL versionnées, `seed.ts` |
| `apps/web` | Front Next.js (App Router, Tailwind, TanStack Query) — UI en français |
| `packages/types` | Registre des permissions, rôles prédéfinis, libellés de statuts partagés |
| `infra` | `docker-compose.yml` (PostgreSQL, MinIO + init des buckets, Redis, Mailpit, ClamAV, profil `app`) |
| `docs/ARCHITECTURE.md` | Conventions de développement (autorisation, fichiers, audit, états, migrations) |

Modules API : `auth`, `admin` (users, roles, permissions, departments, settings, system), `access` (policy engine),
`audit`, `files` (MinIO), `notifications` (+ e-mails), `jobs` (BullMQ + planificateur), `documents` (PDF, Excel, numérotation),
`vessels`, `members`, `certificates`, `cso`, `purchasing`, `voyages`, `noon`, `dashboard` (+ recherche globale), `exports`.

## 2. Démarrage rapide (développement)

Prérequis : Node.js ≥ 20.10, Docker Desktop.

```bash
cp .env.example .env               # ports dédiés : PG 5434, MinIO 9100/9101, Redis 6380, Mailpit 8025
npm install
npm run infra:up                   # PostgreSQL, MinIO (+ buckets privés), Redis, Mailpit
npm run build:types
npm run db:generate                # client Prisma
npm run db:migrate                 # migrations SQL (0001 schéma, 0002 durcissement…)
npm run db:seed                    # données de démonstration synthétiques
npm run dev:api                    # http://localhost:4000/api/v1  — docs http://localhost:4000/api/docs
npm run dev:web                    # http://localhost:3100
```

### Comptes de démonstration (seed)

| Identifiant | Mot de passe | Profil |
|---|---|---|
| `admin` | `ChangeMe!2026` (`SEED_ADMIN_PASSWORD`) | Super Admin, toute la flotte |
| `technical`, `qhse` | `Demo!2026pass` | Technical / QHSE — validateurs des certificats |
| `crewing` | `Demo!2026pass` | Crewing / RH — import Excel, fiches marins (accès transversal) |
| `purchasing`, `purchasing.manager` | `Demo!2026pass` | Acheteur / Responsable Achats (tout le circuit + second regard BC) |
| `cso`, `cso.deputy` | `Demo!2026pass` | Company Security Officer — validateurs CSO |
| `operations` | `Demo!2026pass` | Marine Operations — voyages, Charter Parties, Noon Reports |
| `captain.iskander`, `chief.iskander` | `Demo!2026pass` | Bord, limités à M/V ISKANDER (le Chief Engineer ne voit que ses propres PR) |
| `captain.demo2` | `Demo!2026pass` | Bord, limité au navire fictif DM2 (tests de cloisonnement) |
| `direction` | `Demo!2026pass` | Lecture seule (Viewer) |
| `dpa` | `Demo!2026pass` | DPA (matrice RACI) — certificats navires, embarquements, contrats MLC |
| `ops.manager` | `Demo!2026pass` | Ops Manager (matrice RACI) — circuit Achats complet, PR à facture |
| `commercial` | `Demo!2026pass` | Commercial (matrice RACI) — Noon Reports (accusé de réception), lecture |
| `nouveau` | `Demo!2026pass` | Mot de passe temporaire à changer à la 1re connexion |

Données métier reprises du CDC : **M/V ISKANDER (IMO 9375587)**, **PR n°323 « Consommable machine »**,
**voyage Gabès → Varna** (laycan 22–25/04/2026, SEMBODJA CO. LTD, DAP Fertiliser 3 000–3 300 MT).
Aucune donnée personnelle réelle.

## 3. Base de données PostgreSQL

- Schéma Prisma (`apps/api/prisma/schema.prisma`) : PK UUID, `timestamptz` UTC, montants `DECIMAL(18,2)`,
  prix `DECIMAL(18,4)`, quantités `DECIMAL(18,3)` + unité textuelle, devises ISO 4217. Aucun blob en base.
- **La base fait autorité** (CDC §0.1) — migration `0002_db_hardening` :
  - journal d'audit **append-only** (trigger anti UPDATE/DELETE/TRUNCATE) ;
  - versions immuables : versions de demandes de certificat, révisions officielles, versions CSO, révisions Noon, décisions ;
  - **index partiels** : une seule révision de certificat courante, une seule pièce officielle, une seule demande ouverte,
    une seule version CSO publiée / en cours, un seul département principal, un marin embarqué sur un seul navire,
    une seule version de Charter Party opposable, une seule instruction émise ;
  - **CHECK** : UNKNOWN ≠ UNLIMITED ≠ DATED, cohérence sujet certificat, lat/long/cap/Beaufort Noon Report,
    quantités positives, reçu = accepté + rejeté, devises ISO, IMO/MMSI ;
  - colonne FTS générée (`cso_documents.search_tsv`, GIN), index trigrammes (recherche approchée) ;
  - vue `v_po_line_balance` : rapprochement **BC / BL / reçu physique / accepté / reliquat** par ligne.
- Workflow migrations : **ne jamais utiliser `prisma migrate dev`** (il supprimerait les objets de 0002).
  Modifier le schéma, `npm run prisma:diff -w @amc/api`, copier le SQL relu dans `prisma/migrations/00NN_nom/`,
  puis `npm run db:migrate`. La CI échoue si le schéma diverge des migrations.

## 4. Gestion des fichiers (PDF, Excel, images) — MinIO

| Bucket | Usage |
|---|---|
| `amc-files` | blobs officiels (versioning MinIO activé : aucun écrasement silencieux) + miniatures |
| `amc-quarantine` | dépôts en attente d'analyse antivirus / fichiers infectés |
| `amc-exports` | ZIP, CSV, XLSX, PDF générés — **expiration automatique 2 jours** |

Tous les buckets sont **privés** (aucune policy anonyme).

1. **Dépôt** : `POST /api/v1/files` (multipart `file`, `context`, `vesselId?`) — permission du contexte, scope navire,
   taille maximale configurable, **type réel par signature binaire** (pas l'extension), liste blanche par contexte
   (ex. photo navire = images seulement), HTML / SVG / exécutables / macros refusés, **PDF avec JavaScript refusés**,
   **SHA-256**, clé objet générée (pas de path traversal). Images : dimensions + **miniature WebP sans EXIF** (sharp).
   PDF : nombre de pages. Excel : lecture `.xlsx` / `.xls` / `.csv` (dates JJ.MM.AAAA, numéros de série Excel, PERMANENT).
2. **Antivirus** : `AV_MODE=clamav` → quarantaine puis analyse clamd (worker) ; promotion vers `amc-files` si sain.
   `AV_MODE=disabled` → statut **SKIPPED explicite** (jamais présenté comme « sain »).
3. **Rattachement** : l'objet métier (certificat, version CSO, BL, devis, Charter Party…) rattache le fichier une seule fois
   (trigger). Un fichier non rattaché est purgé après 24 h (tracé).
4. **Accès** : `GET /files/:id/preview|download|thumbnail` ou routes métier dédiées → contrôle des droits du propriétaire
   (resolver par module : permission **view ≠ download ≠ download archived**, scope navire, ACL CSO), **audit**, puis
   **URL signée MinIO de 60 s** (`FILE_DELIVERY_MODE=presigned`) ou flux via l'API (`proxy`, MinIO non exposé).
5. **Fichiers générés** : PDF BC/PR/RFQ/réception, Noon Report en 7 sections, instructions de voyage, exports XLSX/CSV, ZIP CSO.

## 5. Sécurité (CDC §1.2, §12.3)

- Connexion email **ou** identifiant ; Argon2id ; **verrouillage après 5 échecs**, déblocage admin **uniquement avec mot de
  passe temporaire** ; changement obligatoire du mot de passe temporaire ; pas de MFA (décision ADM-013) compensé par
  throttling IP.
- Sessions multi-appareils révocables (cookie HttpOnly `amc_sid`, SHA-256 en base), timeout d'inactivité configurable,
  **CSRF double-submit** (`amc_csrf` + en-tête `x-csrf-token`).
- **Policy engine** : `allowed = compte actif ∧ session ∧ (union des rôles + ALLOW − DENY) ∧ scope navire ∧ ACL ressource
  ∧ ACL champ ∧ condition de workflow`, **recalculé à chaque requête** (un changement de droits s'applique à la requête
  suivante). ALL_FLEET inclut les navires futurs. Délégation : on n'accorde jamais un droit qu'on ne possède pas.
- Séparation demandeur / validateur (même Super Admin), verrous optimistes (409), transactions sérialisables,
  clés d'idempotence (réceptions).
- Tous les refus 403 et toutes les consultations / téléchargements sensibles sont audités.
- En-têtes de sécurité (helmet, CSP API), aucune donnée sensible dans les logs (masquage).

## 6. Tests et qualité

```bash
npm run typecheck                  # types, API, web
npm test                           # tests unitaires API (jest)
npm run openapi -w @amc/api        # génère apps/api/openapi.json
```

**Tests unitaires : 290** (12 suites) — policy engine (rôles cumulés, DENY prioritaire, ALL_FLEET, délégation),
contrôle des dépôts, dates Excel, IMO, états et règles de chaque module (certificats CERT-01..08, ACL CSO, achats
PUR-01..07, Noon, voyages, import Excel Members).

**Intégration bout-en-bout** (API compilée + PostgreSQL + MinIO + Mailpit, ~424 contrôles, tous verts lors de la
recette finale) : socle (authentification, verrouillage, CSRF, fichiers MinIO, URL signées, bucket privé, rejets de
fichiers, cloisonnement navire, droits modifiés en session, audit), certificats (78), achats (97 + 39 cas limites),
voyages / Charter Parties / Noon Reports (157), partages CSO (13). Un audit de sécurité indépendant (409 routes,
376 tentatives d'accès inter-navires refusées) a été mené ; ses constats élevés et moyens sont corrigés.

CI : `.github/workflows/ci.yml` — migrations sur PostgreSQL de service, contrôle de dérive, typecheck, jest, seed, OpenAPI,
build, audit des dépendances.

## 7. Déploiement conteneurisé

```bash
npm run app:up      # build des images amc-api / amc-web + migrations + ClamAV (profil « app »)
# Web : http://localhost:3110 — API : http://localhost:4010
```

Production : TLS (reverse proxy), `COOKIE_SECURE=true`, `S3_PUBLIC_ENDPOINT` = URL publique HTTPS de MinIO (ou
`FILE_DELIVERY_MODE=proxy`), secrets via gestionnaire de secrets, sauvegardes PostgreSQL chiffrées avec test de
restauration, réplication / versioning MinIO, domaine e-mail vérifié avant tout envoi externe.

## 8. Limites connues et pistes d'évolution

- Antivirus désactivé par défaut en développement (`AV_MODE=disabled`, statut « non analysé » explicite) : activer
  ClamAV (`npm run infra:av`, `AV_MODE=clamav`) pour tout environnement partagé.
- Recherche plein texte limitée aux métadonnées (titre, référence, description) ; extraction du contenu PDF non
  activée (évolution optionnelle, CDC §10.3).
- Pas de mode hors-ligne à bord (hors V1) ; signature cryptographique non implémentée (attribution horodatée).
- Petites évolutions identifiées : filtre « validateur » de l'explorateur de certificats, activation d'un voyage
  avec rattachement CP en un seul appel, liste des personnes assignables aux tâches de voyage, historique dédié des
  RFQ, comparaison de doublons CSO enrichie (empreinte, métadonnées), libellés de chronologie voyage en français.

### Flux PR simplifié (22/10/2026)

PR soumise → **en discussion** → décision des Achats qui vaut validation : **continuer**, **Counter-PR appliquée
directement** (motif facultatif, demandeur notifié, avant / après conservé) ou **division en sous-PR** (lignes entières, `…-A`,
`…-B`) ; RFQ facultative ; **aucun e-mail envoyé aux fournisseurs** (RFQ comme BC : l'acheteur les contacte lui-même
et peut noter le contact) ; BC **émis en un clic** et transmis au
demandeur (PDF) ; **BL saisi à bord** (quantités ou fichier + confirmation, articles hors BC) ; alerte haute aux Achats
sur tout écart, puis « attendre le reliquat » ou « correction fournisseur » (révision du BC ou BC complémentaire) ;
clôture automatique des BC et PR quand tout est reçu. Migration `0040_pr_flow_simplification` (statut `SPLIT`,
`parent_id`, articles hors BC, droit `pr.view_all` accordé à tous les rôles qui voyaient les PR sauf Chief Engineer).
Les guides PDF `docs/AMC_Guide_flux_Purchase_Request.pdf` et `docs/AMC_Guide_parcours_Achats_exemples.pdf` décrivent
encore l'ancien circuit.

## 9. Décisions laissées configurables (CDC §17)

Seuils financiers d'approbation BC (non pré-remplis), sur-allocation des quantités, délais de rappel par type de
certificat, champs Members modifiables par l'utilisateur, timeout de session, taille maximale des fichiers, circuits de revue
des PR. Les clauses de Charter Party et les règles NOR / laytime sont stockées en texte, **jamais interprétées**.
Les statuts de la plateforme sont des indicateurs de suivi interne, **sans valeur d'attestation réglementaire**.
