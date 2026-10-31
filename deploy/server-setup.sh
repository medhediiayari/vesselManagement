#!/usr/bin/env bash
# Préparation du serveur (Ubuntu/Debian) : Docker, exposition HTTPS, secrets, sauvegarde nocturne.
# Prérequis : le dépôt est cloné dans /opt/amc.
# Usage : sudo bash /opt/amc/deploy/server-setup.sh <domaine-ou-IP> [e-mail-letsencrypt]
#
# Trois modes, choisis automatiquement :
#   1. nginx occupe déjà 80/443 + nom de domaine → site nginx dédié + certificat Let's Encrypt (certbot),
#      l'application écoute sur 127.0.0.1:WEB_PORT. Les autres sites nginx ne sont pas modifiés.
#   2. 80/443 occupés + adresse IP → Caddy sur un port HTTPS libre (8443…), certificat auto-signé.
#   3. 80/443 libres → Caddy sur 80/443 (Let's Encrypt pour un domaine, auto-signé pour une IP).
# Le pare-feu n'est jamais activé par ce script. Relançable : les secrets d'un .env.prod existant sont conservés,
# seuls l'adresse et le mode d'exposition sont mis à jour.
set -euo pipefail

DOMAIN="${1:?usage : server-setup.sh <domaine-ou-IP> [e-mail]}"
EMAIL="${2:-}"
APP_DIR=/opt/amc
APP_USER="${SUDO_USER:-ubuntu}"
IS_IP=false
[[ "$DOMAIN" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && IS_IP=true
$IS_IP || [ -n "$EMAIL" ] || { echo "E-mail requis pour le certificat Let's Encrypt de $DOMAIN" >&2; exit 1; }
[ -f "$APP_DIR/deploy/env.prod.example" ] || { echo "Cloner d'abord le dépôt dans $APP_DIR" >&2; exit 1; }

# Port occupé : écouté par un processus, ou publié par un conteneur d'un AUTRE projet Docker (serveur partagé :
# d'autres applications publient déjà 8080, 8081, 8090…). Les ports publiés par le projet « amc » lui-même
# (relance du script) restent disponibles pour nous.
port_taken() {
  local p=$1
  if docker ps --filter label=com.docker.compose.project=amc --format '{{.Ports}}' 2>/dev/null | grep -Eq ":$p->"; then
    return 1
  fi
  ss -ltnH "sport = :$p" | grep -q . && return 0
  docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq ":$p->"
}
first_free() { for p in "$@"; do port_taken "$p" || { echo "$p"; return; }; done; return 1; }
nginx_on_web_ports() { ss -ltnpH "( sport = :80 or sport = :443 )" | grep -q '"nginx"'; }

WEB_PORT=$(first_free 8095 8096 8097 8098 8099) || { echo "Aucun port local libre parmi 8095-8099" >&2; exit 1; }
PROFILES=caddy; HTTPS_PORT=443; HTTP_PORT=80; HTTP_BIND=0.0.0.0; TLS=internal; MODE=caddy
if port_taken 80 || port_taken 443; then
  if ! $IS_IP && nginx_on_web_ports; then
    MODE=nginx; PROFILES=""
  elif $IS_IP; then
    HTTPS_PORT=$(first_free 8443 9443 10443) || { echo "Aucun port HTTPS libre parmi 8443, 9443, 10443" >&2; exit 1; }
    HTTP_BIND=127.0.0.1
    HTTP_PORT=$(first_free 8085 8086 8087 8088) || { echo "Aucun port local libre parmi 8085-8088" >&2; exit 1; }
  else
    echo "Les ports 80/443 sont pris par un service autre que nginx : impossible d'obtenir un certificat pour $DOMAIN." >&2
    exit 1
  fi
else
  $IS_IP || TLS="$EMAIL"
fi
echo "Mode d'exposition : $MODE"

# --- Docker ------------------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  apt-get update || true
  apt-get install -y ca-certificates curl
  # Installateur officiel ; repli sur les paquets Ubuntu si la version du système n'est pas prise en charge
  curl -fsSL https://get.docker.com | sh || apt-get install -y docker.io docker-compose-v2
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin
usermod -aG docker "$APP_USER"
systemctl enable --now docker

# --- Configuration (.env.prod) -----------------------------------------------------------------------
mkdir -p "$APP_DIR/deploy/backups"
ENV_FILE="$APP_DIR/deploy/.env.prod"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/deploy/env.prod.example" "$ENV_FILE"
  while grep -q "__GENERATE__" "$ENV_FILE"; do
    sed -i "0,/__GENERATE__/s//$(openssl rand -hex 24)/" "$ENV_FILE"
  done
  echo "Secrets générés dans $ENV_FILE"
else
  echo "$ENV_FILE existe déjà : secrets conservés, adresse et exposition mises à jour"
fi
set_env() { # remplace ou ajoute KEY=VALUE
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
set_env DOMAIN "$DOMAIN"
set_env TLS "$TLS"
set_env COMPOSE_PROFILES "$PROFILES"
set_env WEB_PORT "$WEB_PORT"
set_env HTTPS_PORT "$HTTPS_PORT"
set_env HTTP_PORT "$HTTP_PORT"
set_env HTTP_BIND "$HTTP_BIND"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$ENV_FILE"

# --- Exposition --------------------------------------------------------------------------------------
if [ "$MODE" = nginx ]; then
  SITE=/etc/nginx/sites-available/amc
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__WEB_PORT__|$WEB_PORT|g" "$APP_DIR/deploy/nginx-amc.conf" > "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/amc
  nginx -t
  systemctl reload nginx
  if ! command -v certbot >/dev/null 2>&1; then
    apt-get install -y certbot python3-certbot-nginx || snap install --classic certbot
  fi
  # Ajoute le bloc HTTPS et la redirection HTTP → HTTPS dans le site « amc » uniquement
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  systemctl reload nginx
fi

# Pare-feu : seulement si ufw est DÉJÀ actif (ne jamais l'activer sur un serveur partagé)
if [ "$MODE" = caddy ] && command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$HTTPS_PORT/tcp"
  ufw allow "$HTTPS_PORT/udp"
  [ "$HTTP_BIND" = "0.0.0.0" ] && ufw allow "$HTTP_PORT/tcp"
fi

# Sauvegarde quotidienne de la base à 02:30 (14 jours conservés)
cat > /etc/cron.d/amc-backup <<EOF
30 2 * * * $APP_USER cd $APP_DIR && bash deploy/backup.sh >> deploy/backups/backup.log 2>&1
EOF
echo "Serveur prêt. Si c'est la première fois, déconnecte-toi puis reconnecte-toi (groupe docker), puis :"
echo "  cd $APP_DIR && bash deploy/first-deploy.sh"
