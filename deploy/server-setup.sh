#!/usr/bin/env bash
# Préparation unique du serveur (Ubuntu/Debian) : Docker, secrets, sauvegarde nocturne.
# Prérequis : le dépôt est cloné dans /opt/amc.
# Usage : sudo bash /opt/amc/deploy/server-setup.sh <domaine-ou-IP> [e-mail-letsencrypt]
#   - adresse IP     → HTTPS auto-signé (test) ;
#   - nom de domaine → HTTPS Let's Encrypt (e-mail obligatoire, ports 80/443 libres).
# Serveur partagé : si 80/443 sont déjà pris (ex. nginx), l'application est publiée sur un port HTTPS libre
# (8443, 9443 ou 10443) sans toucher au service existant. Le pare-feu n'est jamais activé par ce script.
# Idempotent : ne régénère jamais un .env.prod existant (ses secrets protègent des données déjà créées).
set -euo pipefail

DOMAIN="${1:?usage : server-setup.sh <domaine-ou-IP> [e-mail]}"
APP_DIR=/opt/amc
APP_USER="${SUDO_USER:-ubuntu}"
IS_IP=false
[[ "$DOMAIN" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && IS_IP=true
if $IS_IP; then TLS=internal; else TLS="${2:?e-mail requis pour le certificat Let's Encrypt d'un nom de domaine}"; fi
[ -f "$APP_DIR/deploy/env.prod.example" ] || { echo "Cloner d'abord le dépôt dans $APP_DIR" >&2; exit 1; }

# Port occupé par un processus hors Docker (docker-proxy = notre propre pile lors d'une relance)
port_taken() { ss -ltnpH "sport = :$1" | grep -vq docker-proxy && ss -ltnH "sport = :$1" | grep -q .; }

HTTPS_PORT=443; HTTP_PORT=80; HTTP_BIND=0.0.0.0
if port_taken 80 || port_taken 443; then
  if ! $IS_IP; then
    echo "Les ports 80/443 sont utilisés par un autre service (ex. nginx) : Let's Encrypt ne peut pas valider $DOMAIN." >&2
    echo "Relancer avec l'adresse IP du serveur (port HTTPS dédié), ou faire relayer $DOMAIN par le service existant." >&2
    exit 1
  fi
  HTTPS_PORT=""
  for p in 8443 9443 10443; do port_taken "$p" || { HTTPS_PORT=$p; break; }; done
  [ -n "$HTTPS_PORT" ] || { echo "Aucun port HTTPS libre parmi 8443, 9443, 10443" >&2; exit 1; }
  # Le port HTTP de Caddy ne sert pas en certificat interne : publié en local seulement
  HTTP_BIND=127.0.0.1
  HTTP_PORT=""
  for p in 8081 8082 8083 8084; do port_taken "$p" || { HTTP_PORT=$p; break; }; done
  [ -n "$HTTP_PORT" ] || { echo "Aucun port local libre parmi 8081-8084" >&2; exit 1; }
  echo "Ports 80/443 déjà utilisés (service existant conservé) : application publiée sur le port $HTTPS_PORT"
fi

if ! command -v docker >/dev/null 2>&1; then
  apt-get update || true
  apt-get install -y ca-certificates curl
  # Installateur officiel ; repli sur les paquets Ubuntu si la version du système n'est pas prise en charge
  curl -fsSL https://get.docker.com | sh || apt-get install -y docker.io docker-compose-v2
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin
usermod -aG docker "$APP_USER"
systemctl enable --now docker

# Pare-feu : seulement si ufw est DÉJÀ actif (ne jamais l'activer sur un serveur partagé)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$HTTPS_PORT/tcp"
  ufw allow "$HTTPS_PORT/udp"
  [ "$HTTP_BIND" = "0.0.0.0" ] && ufw allow "$HTTP_PORT/tcp"
fi

mkdir -p "$APP_DIR/deploy/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

ENV_FILE="$APP_DIR/deploy/.env.prod"
if [ ! -f "$ENV_FILE" ]; then
  sed -e "s|__DOMAIN__|$DOMAIN|" -e "s|__TLS__|$TLS|" -e "s|__HTTPS_PORT__|$HTTPS_PORT|" \
      -e "s|__HTTP_PORT__|$HTTP_PORT|" -e "s|__HTTP_BIND__|$HTTP_BIND|" "$APP_DIR/deploy/env.prod.example" > "$ENV_FILE"
  while grep -q "__GENERATE__" "$ENV_FILE"; do
    sed -i "0,/__GENERATE__/s//$(openssl rand -hex 24)/" "$ENV_FILE"
  done
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Secrets générés dans $ENV_FILE"
else
  echo "$ENV_FILE existe déjà : conservé"
fi

# Sauvegarde quotidienne de la base à 02:30 (14 jours conservés)
cat > /etc/cron.d/amc-backup <<EOF
30 2 * * * $APP_USER cd $APP_DIR && bash deploy/backup.sh >> deploy/backups/backup.log 2>&1
EOF
echo "Serveur prêt. Déconnecte-toi puis reconnecte-toi (groupe docker), puis : cd $APP_DIR && bash deploy/first-deploy.sh"
