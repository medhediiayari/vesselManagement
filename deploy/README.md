# Déploiement — serveur unique, via Git

Pile : PostgreSQL 16, MinIO, Redis, API NestJS, web Next.js, et Caddy pour le HTTPS. Tout tourne dans Docker sur le serveur, dans `/opt/amc`, qui est un clone du dépôt GitHub.

Seul Caddy est exposé sur Internet, sur les ports 80 et 443. La base, MinIO, Redis et l'API restent sur le réseau Docker interne. Les fichiers passent par l'API (`FILE_DELIVERY_MODE=proxy`).

- **Données initiales** : `db-dump/amc.dump` contient la base, `db-dump/files.tgz` les fichiers. Ils sont produits sur le poste de développement par `deploy/export-data.sh` et ne sont restaurés **que si la base du serveur est vide**.
- **Secrets du serveur** : `deploy/.env.prod` est généré sur le serveur et n'est jamais commité.

## 1. Poste de développement : publier le code et les données
```bash
bash deploy/export-data.sh          # met à jour db-dump/ avec la base locale actuelle
git add -A && git commit -m "Déploiement : pile de production et données de test" && git push
```

## 2. Serveur : première installation
```bash
ssh ubuntu@135.125.207.107
sudo apt-get update && sudo apt-get install -y git
sudo mkdir -p /opt/amc && sudo chown ubuntu:ubuntu /opt/amc
git clone https://github.com/medhediiayari/vesselManagement.git /opt/amc
sudo bash /opt/amc/deploy/server-setup.sh amc.vessels.castpro-tn.com ton@email.com
exit                                 # reconnexion nécessaire pour le groupe docker
ssh ubuntu@135.125.207.107
cd /opt/amc && bash deploy/first-deploy.sh
```

`server-setup.sh` choisit le mode d'exposition :
- **nginx occupe déjà 80/443 et on donne un domaine** : c'est le cas de `135.125.207.107`. Le script ajoute un site nginx dédié (`/etc/nginx/sites-available/amc`, modèle `deploy/nginx-amc.conf`) et obtient le certificat Let's Encrypt avec certbot. L'application écoute alors sur `127.0.0.1:8095`, et les autres sites nginx ne sont pas modifiés.
- **80/443 occupés et on donne une adresse IP** : Caddy publie un port HTTPS libre (8443…), avec un certificat auto-signé.
- **80/443 libres** : Caddy écoute sur 80/443.

Le script n'active jamais le pare-feu. Il est relançable : il garde les secrets et met seulement à jour l'adresse et le mode d'exposition.

## 3. Mises à jour
Sur le poste : `git push`. Puis, sur le serveur : `cd /opt/amc && bash deploy/update.sh`.

`update.sh` reconstruit les images et applique les migrations. Il ne touche jamais aux données.

## Exploitation
- **Commandes Docker** : sur le serveur, dans `/opt/amc`, préfixer par `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod`. Commandes utiles : `ps`, `logs -f api`, `restart web`.
- **Sauvegardes** : chaque nuit à 02:30 UTC dans `deploy/backups/`, gardées 14 jours. Pour une sauvegarde immédiate : `bash deploy/backup.sh`.
- **E-mails** : désactivés. Pour les activer, renseigner les `SMTP_*` dans `deploy/.env.prod`, puis relancer l'API.
- **Avant une vraie mise en production** : tous les comptes ont les mots de passe d'exemple publics de `.env.example`. Le script `bash deploy/reset-passwords.sh` les remplace par des mots de passe temporaires aléatoires, avec changement imposé à la première connexion.
