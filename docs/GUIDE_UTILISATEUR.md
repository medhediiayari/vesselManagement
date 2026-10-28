# Guide utilisateur — Plateforme maritime AMC

Ce guide présente les tâches courantes par profil. L'interface n'affiche que les menus et actions
autorisés par vos droits ; le serveur revérifie chaque action (droits, navires de votre périmètre,
règles de validation) et toute opération sensible est journalisée.

---

## 1. Premiers pas

### Connexion
- Saisissez votre **identifiant ou votre e-mail** et votre mot de passe.
- À la première connexion (ou après une réinitialisation par un administrateur), choisissez un nouveau
  mot de passe : 12 caractères minimum, au moins 3 types parmi minuscules, majuscules, chiffres, symboles.
- Après **5 échecs**, le compte est verrouillé : seul un administrateur peut le débloquer, en vous remettant un
  mot de passe temporaire.
- Mot de passe oublié : le lien envoyé (si votre e-mail est vérifié) est valable 1 heure, une seule fois.

### Repères de l'écran
- **Barre latérale** : modules regroupés par métier (Pilotage, Flotte & équipages, Conformité, Achats,
  Opérations, Administration).
- **Sélecteur de navire** (en haut à gauche) : un navire, plusieurs, ou toute votre flotte. Les listes et
  le tableau de bord se filtrent en conséquence. Seuls les navires de votre périmètre sont proposés.
- **Recherche globale** : navires, marins, certificats, PR, bons de commande, voyages, fournisseurs —
  uniquement ce que vous avez le droit de voir.
- **Cloche** : notifications (échéances, demandes de validation, partages). Une alerte obligatoire reste
  visible tant que sa cause n'est pas résolue.
- **Mon compte** : vos rôles, votre périmètre et vos **sessions ouvertes** (vous pouvez fermer une session
  sur un autre appareil).

### Statuts
Chaque statut est affiché avec un libellé et une icône. Pour les certificats, la **validité réelle**
(Valide, Expire bientôt, Expiré, Illimité, Échéance inconnue) est toujours distincte du **suivi de
renouvellement** : un renouvellement « en cours » ne masque jamais une expiration.

---

## 2. Tableau de bord

- **Horizon des échéances** : chaque point est un certificat placé selon sa date d'échéance (de J-30 à J+90).
  Survolez ou tabulez pour voir le détail ; cliquez pour ouvrir le certificat.
- Indicateurs cliquables : certificats expirés / à échéance, documents manquants, approbations en attente,
  PR en retard, commandes en retard, écarts de réception, voyages en cours et Noon Reports non reçus.
- **À valider** : les circuits qui vous concernent. Vos propres demandes en sont exclues (un demandeur ne
  valide jamais sa propre soumission).

---

## 3. Flotte et équipages

### Navires (Technical, Super Admin)
- Créer un navire : nom, code, IMO (contrôle de la clé), MMSI, pavillon… Un IMO ou un code déjà utilisé est refusé.
- Le **workspace** du navire regroupe : vue d'ensemble, équipage, certificats, CSO, achats, voyages,
  pièces jointes et historique des informations officielles.
- Photo et pièces jointes : glisser-déposer ; le stockage est privé, l'accès est contrôlé et journalisé.

### Marins & personnel (Crewing / RH)
- **Créer une fiche** : un contrôle de doublons s'exécute pendant la saisie (matricule AMC, passeport,
  livret maritime, nom + date de naissance). Une création malgré un doublon exige un motif.
- Les champs personnels protégés (passeport, livret, naissance, matricule) ne sont modifiables qu'avec le
  droit dédié.
- **Embarquements** : planifier, confirmer l'embarquement, débarquer, relever un marin. Un marin ne peut être
  à bord que d'un seul navire à la fois ; son statut se met à jour automatiquement.
- **Équipage par navire et par date** : Marins & personnel → Équipage.
- **Ma fiche** : un utilisateur lié à une fiche peut mettre à jour ses coordonnées autorisées.

### Import Excel des marins
1. Déposez le classeur (.xlsx, .xls ou .csv).
2. Vérifiez le **mapping** proposé par feuille (colonnes → champs ou types de certificats). Les dates
   JJ.MM.AAAA, les dates Excel et « PERMANENT » sont reconnues.
3. **Prévisualisez** : chaque ligne est Valide, Invalide (erreurs listées) ou Doublon suspecté (comparaison
   côte à côte). Décidez explicitement pour chaque doublon : créer, mettre à jour, ignorer ou corriger.
4. **Validez l'import** : il peut être relancé sans créer de doublons. Les certificats importés partent en
   approbation (jamais approuvés automatiquement). Téléchargez le rapport d'import.

---

## 4. Certificats (priorité critique)

- **Explorateur** : filtres par navire, marin, type, validité, échéance, renouvellement, document manquant,
  approbation en attente ; panneau de droite avec aperçu du PDF officiel.
- **Créer** : choisissez le titulaire (navire ou marin) et le type, saisissez numéro, émetteur, dates et le type
  d'échéance (**datée**, **illimitée** ou **inconnue** — une échéance inconnue ne déclenche aucune alerte
  d'expiration mais un rappel de complétion). Le PDF est facultatif : sans lui, le badge « Document manquant »
  reste affiché.
- **Soumettre** : tous les validateurs éligibles sont notifiés. Tant que la demande est en attente, vous pouvez
  la modifier (nouvelle version) ou l'annuler avec un motif.
- **Valider** (validateurs) : approuver, refuser ou retourner pour correction (commentaire obligatoire pour
  refuser / retourner). Si quelqu'un a décidé entre-temps, un message « déjà traité » s'affiche.
- **Renouveler** : l'ancien certificat reste la référence officielle (et ses alertes continuent) jusqu'à
  l'approbation du nouveau ; l'ancien est alors archivé.
- **Ajouter un PDF plus tard** : il passe en approbation par une autre personne ; l'ancien fichier officiel
  reste actif d'ici là.
- **Téléchargements** : consulter, télécharger le document courant et télécharger les archives sont trois
  droits distincts.
- **Suivi du renouvellement** : statut, responsable, échéance interne et commentaires — sans effet sur la
  validité ni sur les rappels.

---

## 5. Documents CSO (sûreté)

- **Explorateur** : bibliothèque centrale et bibliothèque de chaque navire, arborescence, fil d'Ariane, vos
  droits sur le dossier / document affichés en clair. Les zones auxquelles vous n'avez pas accès n'apparaissent
  nulle part (arborescence, recherche, ZIP, exports).
- **Déposer** : glissez des fichiers dans le dossier, complétez la fiche (catégorie, référence, champs
  obligatoires) et soumettez. **Un document n'est publié qu'après approbation par une autre personne**
  (validateurs du dossier).
- **Nouvelle version** : l'ancienne reste officielle tant que la nouvelle est en attente.
- **Archiver / restaurer** : rien n'est supprimé ; une restauration repasse par l'approbation.
- **Partager** (interne uniquement) : choisissez des utilisateurs ou départements ; le partage donne la
  consultation (et le téléchargement seulement si vous l'autorisez et si le destinataire en a le droit). Il ne
  contourne jamais le périmètre navire. Révocation individuelle ou globale immédiate. Retrouvez ce qu'on vous a
  partagé dans **Partagés avec moi**.
- **Télécharger en ZIP** : cochez documents et dossiers ; les éléments non autorisés sont exclus (seul leur
  nombre est indiqué).
- **Import en masse** : ZIP (arborescence conservée) + Excel de métadonnées facultatif, revue des doublons
  (ignorer, document indépendant, nouvelle version), tout part en approbation.

---

## 6. Achats

Vocabulaire : **PR** demande d'achat, **RFQ** demande de devis, **BC** = OC = Purchase Order, **BL** bon de livraison.
Flux simplifié depuis le 22/10/2026 : la page **Achats** affiche « À faire maintenant » (PR à mettre en discussion ou
à décider, BC à émettre, BL attendus du bord, écarts de réception à décider) selon vos droits.

1. **PR** (Captain, Chief Engineer…) : lignes type tableur (désignation, référence, quantité, unité libre, ROB,
   remarques), pièces jointes, puis soumission. Le **Captain voit toutes les PR de son navire** ; le **Chief Engineer
   ne voit que les siennes** (et leurs BC / BL) — droit « Voir toutes les PR du navire » (`pr.view_all`).
2. **En discussion** (responsable Achats) : sur une PR soumise, « Mettre en discussion » prévient le demandeur ; les
   échanges se font dans l'onglet Discussion. Le responsable choisit ensuite — **le choix vaut validation** :
   - **Continuer avec cette PR** : la PR est validée telle quelle ;
   - **Counter-PR** : il modifie directement quantités, articles (retrait, remplacement, ajout) et en-tête (date de
     besoin, priorité, objet, catégorie) (motif facultatif) ; c'est appliqué immédiatement, le demandeur est notifié du
     détail et l'avant / après reste consultable ;
   - **Diviser en sous-PR** : les lignes **entières** sont réparties par fournisseur visé ; chaque sous-PR
     (`…-A`, `…-B`) est validée et suit son propre BC puis son propre BL ; la PR d'origine passe « Divisée » en
     lecture seule. Une PR modifiée par Counter-PR peut ensuite être divisée.
   Après une Counter-PR, la PR reste « En discussion » : le panneau en haut de page propose alors **Valider et
   continuer** (PR modifiée validée, puis « Créer le BC ») ou **Diviser**.
   « Rejeter » et « Mettre en attente » restent possibles. Le demandeur ne peut jamais décider de sa propre PR.
3. **Consultation des fournisseurs** (facultative) : le responsable contacte les fournisseurs lui-même — **la
   plateforme n'envoie aucun e-mail aux fournisseurs**. La **RFQ** reste disponible pour tracer la consultation :
   fournisseurs consultés, contact noté (« Noter le contact »), saisie des devis reçus, comparaison par ligne (aucune
   conversion de devise) puis sélection justifiée (droit « Comparer et sélectionner les devis »).
4. **BC** : « **Créer et émettre** » — le BC est émis en un clic et transmis au **créateur de la PR** (notification et
   e-mail avec le PDF : fournisseur, articles, date et port de livraison). Un second regard n'intervient que si un
   seuil configuré l'exige ; le BC est alors émis automatiquement à son approbation. L'acheteur transmet lui-même le
   PDF du BC au fournisseur et peut le noter (« Noter l'envoi au fournisseur »).
5. **BL à bord** (tout utilisateur du navire habilité qui voit le BC) : « **Répondre par un BL** » sur le BC.
   - **Saisir les quantités** : les articles cochés sont préremplis avec le reste à recevoir (« Tout reçu ») ; corriger
     seulement les écarts, ajouter une remarque par article et les **articles reçus hors BC** ;
   - **Joindre le BL** (PDF, Excel ou photo) : une question demande ensuite si le BL correspond exactement au BC —
     « Oui » déclare tout reçu, « Non » ouvre la saisie préremplie des différences.
   Un renvoi du même BL n'est jamais compté deux fois.
6. **Écart de réception** : tout manque ou surplus déclenche une **alerte haute** aux Achats (notification et e-mail,
   bandeau rouge sur le BC). Un article hors BC est simplement noté, sans alerte. Décisions :
   - **Attendre le reliquat** : le BC reste ouvert, le bord enverra un nouveau BL ;
   - **Correction fournisseur** : **réviser le BC** (quantité ajustée, reliquat annulé — version précédente conservée)
     ou **BC complémentaire** (reliquats de plusieurs lignes, même fournisseur ou un autre, émis directement).
   La comparaison BC ↔ BL est refaite à chaque événement.
7. **Clôture automatique** : un BC se clôture quand tout ce qu'il porte a été reçu sans écart ouvert ; une PR quand
   toutes ses lignes sont reçues (une quantité restant à commander se traite par BC complémentaire ou Counter-PR) ; la
   PR d'origine d'une division quand toutes ses sous-PR sont terminées.
8. **Factures** : rattachées aux BC ; le rapprochement commandé / reçu / facturé signale les litiges. Une facture
   ne clôture jamais une commande partiellement reçue.

---

## 7. Voyages, Charter Parties et Noon Reports

### Voyages (Marine Operations)
- Créer le voyage, puis **planifier** et **activer** (la Charter Party doit être rattachée lorsqu'elle existe).
- Onglets : escales & agents (ordre, ETA/ATA/ETD/ATD), cargaison, notices & NOR, Charter Party, instructions,
  checklist, Noon Reports, fichiers, chronologie.
- **Notices** : brouillon → validation humaine → « Marquer comme envoyé ». Aucun envoi externe automatique.
- Contrôle indicatif des certificats du navire expirant pendant le voyage (sans valeur d'avis de conformité).

### Charter Parties
- Contenu confidentiel. Chaque version (originale, avenant, révision) est approuvée par une autre personne ;
  l'ancienne reste opposable d'ici là. Les Masters accusent lecture.
- Les clauses (NOR, laytime, fret, surestaries) sont conservées en texte, jamais interprétées automatiquement.

### Noon Report (Captain)
1. Depuis le voyage : **Nouveau Noon Report**.
2. Remplissez les **7 sections** repliables (informations générales, position & météo, navigation, machine &
   combustibles, ballast & cargaison, incidents, maintenance). La saisie est **enregistrée automatiquement**.
3. Indiquez explicitement la base de consommation (depuis le dernier rapport ou 24 h).
4. **Vérifier et soumettre** : les champs manquants sont listés avec un lien vers chacun. Après soumission, le
   rapport est figé (révision + PDF) et les opérations à terre sont notifiées.
5. Correction : nouvelle révision tracée, l'originale reste intacte. Un brouillon jamais soumis peut être supprimé.

---

## 8. Administration (Super Admin, administrateurs délégués)

- **Utilisateurs** : création avec mot de passe temporaire (affiché une seule fois), rôles cumulables,
  exceptions individuelles (un **refus l'emporte toujours**), périmètre navires (« Toute la flotte » inclut les
  futurs navires), départements, lien avec une fiche Member, sessions, déverrouillage (toujours avec un nouveau
  mot de passe temporaire), désactivation (sessions fermées, historique conservé).
- **Délégation** : un administrateur délégué ne peut ni accorder ni gérer des droits ou navires qu'il ne possède pas.
- **Rôles & permissions** : matrice par module ; un rôle encore attribué ne peut pas être supprimé ; une
  modification s'applique immédiatement à tous ses titulaires.
- **Départements** : responsable principal, adjoints, désactivation sans perte des affectations.
- **Journal d'audit** : consultation par module et périmètre ; export CSV/XLSX.
- **Paramètres** : expiration de session, verrouillage, longueur du mot de passe, champs modifiables par
  l'utilisateur, taille des fichiers, seuil « expire bientôt », sur-allocation achats.
- **État du système** : dépendances, tâches planifiées (relance manuelle), e-mails, antivirus, volumétrie.
