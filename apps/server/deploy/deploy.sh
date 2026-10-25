#!/usr/bin/env bash
# Runs on the EC2 host from ~/ai-email-agent, after .github/workflows/cd.yml copied the new image
# and these files there. Starts the new version (rolling back if it doesn't come up healthy), then
# makes sure nginx serves $APP_DOMAIN over HTTPS. Other apps on the host are left alone: only the
# ai_email_agent container, port 4317 and the ai-email-agent nginx site are touched.
set -euo pipefail
cd "$(dirname "$0")"
: "${IMAGE_TAG:?}" "${APP_DOMAIN:?}" "${CERTBOT_EMAIL:?}"

IMAGE=ai-email-agent
SITE=/etc/nginx/sites-available/ai-email-agent.conf
chmod 600 app.env
mkdir -p data

echo "==> Loading ${IMAGE}:${IMAGE_TAG}"
sudo docker load -i image.tar.gz
rm -f image.tar.gz

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:4317/api/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

previous=$(cat current-tag 2>/dev/null || true)
echo "==> Starting ${IMAGE_TAG} (was: ${previous:-none})"
sudo IMAGE_TAG="$IMAGE_TAG" docker compose up -d
if ! healthy; then
  echo "!! The new version did not become healthy. Its last log lines:"
  sudo docker logs --tail 50 ai_email_agent || true
  if [ -n "$previous" ]; then
    sudo IMAGE_TAG="$previous" docker compose up -d
    echo "!! Rolled back to ${previous}"
  fi
  exit 1
fi
echo "$IMAGE_TAG" > current-tag
# Keep this version and the one before it (to roll back to).
sudo docker image ls "$IMAGE" --format '{{.Tag}}' |
  grep -vxF -e "$IMAGE_TAG" -e "${previous:-none}" |
  xargs -r -I{} sudo docker rmi "${IMAGE}:{}"

# Put a site file in place; if nginx rejects it, restore what was there and stop.
apply_site() {
  sudo cp "$SITE" "$SITE.bak" 2>/dev/null || true
  sed "s/__DOMAIN__/${APP_DOMAIN}/g" "$1" | sudo tee "$SITE" >/dev/null
  sudo ln -sf "$SITE" /etc/nginx/sites-enabled/ai-email-agent.conf
  if ! sudo nginx -t; then
    if [ -f "$SITE.bak" ]; then
      sudo mv "$SITE.bak" "$SITE"
    else
      sudo rm -f "$SITE" /etc/nginx/sites-enabled/ai-email-agent.conf
    fi
    echo "!! nginx rejected the new config; the previous one is back"
    exit 1
  fi
  sudo rm -f "$SITE.bak"
  sudo systemctl reload nginx
}

if ! sudo test -d "/etc/letsencrypt/live/${APP_DOMAIN}"; then
  echo "==> First deploy: getting a certificate for ${APP_DOMAIN}"
  sudo mkdir -p /var/www/certbot
  apply_site nginx-acme.conf
  sudo certbot certonly --webroot -w /var/www/certbot -d "$APP_DOMAIN" \
    --non-interactive --agree-tos -m "$CERTBOT_EMAIL"
fi
# Renewed certificates only take effect once nginx reloads.
hook=/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
if ! sudo test -f "$hook"; then
  printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee "$hook" >/dev/null
  sudo chmod 755 "$hook"
fi
apply_site nginx.conf

echo "==> Checking https://${APP_DOMAIN}"
curl -fsS "https://${APP_DOMAIN}/api/health"
echo
echo "==> Deployed ${IMAGE_TAG}"
