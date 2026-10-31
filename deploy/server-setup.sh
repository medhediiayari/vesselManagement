#!/usr/bin/env bash
# Préparation unique du serveur (Ubuntu/Debian) : Docker, pare-feu, secrets, sauvegarde nocturne.
# Prérequis : le dépôt est cloné dans /opt/amc.
# Usage : sudo bash /opt/amc/deploy/server-setup.sh <domaine-ou-IP> [e-mail-letsencrypt]
#   - adresse IP     → HTTPS auto-signé (test) ;
#   - nom de domaine → HTTPS Let's Encrypt (e-mail obligatoire).
# Idempotent : ne régénère jamais un .env.prod existant (ses secrets protègent des données déjà créées).
set -euo pipefail

DOMAIN="${1:?usage : server-setup.sh <domaine-ou-IP> [e-mail]}"
APP_DIR=/opt/amc
APP_USER="${SUDO_USER:-ubuntu}"
if [[ "$DOMAIN" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  TLS=internal
else
  TLS="${2:?e-mail requis pour le certificat Let's Encrypt d'un nom de domaine}"
fi
[ -f "$APP_DIR/deploy/env.prod.example" ] || { echo "Cloner d'abord le dépôt dans $APP_DIR" >&2; exit 1; }

# Ports 80/443 : refuser si un autre service (hors Docker) les occupe déjà
if ss -ltnp | grep -E ':(80|443) ' | grep -vq docker; then
  echo "Les ports 80/443 sont déjà utilisés par un autre service :" >&2
  ss -ltnp | grep -E ':(80|443) ' >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$APP_USER"
systemctl enable --now docker

# Pare-feu : SSH, HTTP, HTTPS uniquement (seul Caddy publie des ports)
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
fi

mkdir -p "$APP_DIR/deploy/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

ENV_FILE="$APP_DIR/deploy/.env.prod"
if [ ! -f "$ENV_FILE" ]; then
  sed -e "s|__DOMAIN__|$DOMAIN|" -e "s|__TLS__|$TLS|" "$APP_DIR/deploy/env.prod.example" > "$ENV_FILE"
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
