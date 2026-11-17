#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Installs the Servers test stacks on a throwaway VM, as root (servers.sh runs it there):
#   nginx with PHP-FPM; a Go service under systemd (orders, :8091, MemoryMax=200M); two Node
#   apps under pm2 (api :8092, mailer); a Python worker under supervisord; gunicorn under a
#   unit (shop, :8094); a Java jar started by hand with nohup (billing, :8093); PostgreSQL and
#   MariaDB installed natively; Redis in a container (Docker, or Podman's Docker API on RHEL).
# Ubuntu 22.04+/Debian 12 (apt) and Rocky/Alma 8–9 (dnf). The apps come from ./apps, built
# on the Mac by servers.sh (the Go binary and the jar). Idempotent.
set -euo pipefail
# sudo on RHEL drops /usr/local/bin, where npm -g puts pm2.
export PATH="/usr/local/bin:$PATH"
[ "$(id -u)" = 0 ] || { echo "run as root (inside the test VM only)" >&2; exit 2; }
APPS=${APPS:-/opt/wl-apps}
REDIS_IMAGE=${REDIS_IMAGE:-public.ecr.aws/docker/library/redis:7-alpine}
log() { printf '== %s\n' "$*"; }

. /etc/os-release
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  log "apt packages ($PRETTY_NAME)"
  apt-get update -qq
  apt-get install -y -qq nginx php-fpm postgresql mariadb-server supervisor python3 python3-pip \
    gunicorn nodejs npm default-jre-headless docker.io curl >/dev/null
  PHPFPM=$(systemctl list-unit-files 'php*-fpm.service' --no-legend | awk '{print $1; exit}')
  SUP=supervisor
  SUPCONF=/etc/supervisor/conf.d
  JAVA=java
else
  log "dnf packages ($PRETTY_NAME)"
  dnf install -y -q epel-release >/dev/null
  dnf install -y -q nginx php-fpm postgresql-server mariadb-server supervisor python3 python3-pip \
    nodejs npm java-17-openjdk-headless podman podman-docker curl >/dev/null || \
  dnf install -y -q nginx php-fpm postgresql-server mariadb-server supervisor python3 python3-pip \
    nodejs npm java-11-openjdk-headless podman podman-docker curl >/dev/null
  pip3 install -q gunicorn >/dev/null 2>&1 || true
  [ -d /var/lib/pgsql/data/base ] || postgresql-setup --initdb >/dev/null
  PHPFPM=php-fpm.service
  SUP=supervisord
  SUPCONF=/etc/supervisord.d
  JAVA=java
  systemctl enable --now podman.socket >/dev/null
  touch /etc/containers/nodocker
fi
command -v pm2 >/dev/null || npm install -g -s pm2 >/dev/null 2>&1

log "apps in $APPS"
install -d -m 755 "$APPS"
id app >/dev/null 2>&1 || useradd -m -s /bin/bash app

log "orders (Go, systemd, MemoryMax=200M, restarts on failure)"
cat >/etc/systemd/system/orders.service <<EOF
[Unit]
Description=orders (Go)
[Service]
ExecStart=$APPS/orders
Restart=on-failure
RestartSec=2
MemoryMax=200M
User=app
[Install]
WantedBy=multi-user.target
EOF

log "shop (gunicorn, systemd)"
GUNICORN=$(command -v gunicorn || echo /usr/local/bin/gunicorn)
cat >/etc/systemd/system/shop.service <<EOF
[Unit]
Description=shop (gunicorn)
[Service]
WorkingDirectory=$APPS
ExecStart=$GUNICORN --workers 2 --bind 0.0.0.0:8094 app:app
User=app
CPUQuota=50%
[Install]
WantedBy=multi-user.target
EOF

log "worker (Python, supervisord)"
cat >"$SUPCONF/worker.conf" <<EOF
[program:worker]
command=python3 $APPS/worker.py
user=app
autorestart=true
EOF
[ "$SUPCONF" = /etc/supervisord.d ] && sed -i 's/^files = .*/files = supervisord.d\/*.conf/' /etc/supervisord.conf 2>/dev/null || true
if [ "$SUPCONF" = /etc/supervisord.d ] && [ -f "$SUPCONF/worker.conf" ]; then cp "$SUPCONF/worker.conf" "$SUPCONF/worker.ini"; fi

systemctl daemon-reload
# PHP-FPM's status page for the integration (ADR-212), on the status listener the docs use:
# the pool itself listens on a socket.
www=$(ls /etc/php/*/fpm/pool.d/www.conf /etc/php-fpm.d/www.conf 2>/dev/null | head -1)
if [ -n "$www" ] && ! grep -q '^pm.status_path' "$www"; then
  printf 'pm.status_path = /status\npm.status_listen = 127.0.0.1:9001\nrequest_slowlog_timeout = 2s\nslowlog = /var/log/php-fpm-www-slow.log\n' >>"$www"
fi
for u in nginx "$PHPFPM" postgresql mariadb "$SUP" orders shop; do systemctl enable --now "$u" >/dev/null 2>&1 || echo "   note: $u didn't start"; done
# supervisord may have started with the package, before worker.conf existed.
supervisorctl reread >/dev/null 2>&1 || true
supervisorctl update >/dev/null 2>&1 || true

log "pm2 (api :8092, mailer) as user app, under its systemd unit as after a reboot"
if ! systemctl is-active --quiet pm2-app; then
  su - app -c "pm2 start $APPS/api.js --name api -- 8092 >/dev/null; pm2 start $APPS/api.js --name mailer >/dev/null; pm2 save >/dev/null; pm2 kill >/dev/null"
  pm2 startup systemd -u app --hp /home/app >/dev/null 2>&1 || true
  systemctl enable --now pm2-app >/dev/null 2>&1 || echo "   note: pm2-app didn't start"
fi

log "billing (Java jar, nohup, by hand)"
pgrep -f billing.jar >/dev/null || su - app -c "nohup $JAVA -jar $APPS/billing.jar >/tmp/billing.log 2>&1 &"

log "redis (container)"
if command -v docker >/dev/null; then
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker inspect redis >/dev/null 2>&1 || docker run -d --name redis --restart unless-stopped "$REDIS_IMAGE" >/dev/null
fi
log "done"
