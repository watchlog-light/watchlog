#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# After the deb or rpm is installed (ADR-209): the user watchlog, and the configuration when
# WATCHLOG_TOKEN and WATCHLOG_URL are given (sudo WATCHLOG_TOKEN=… WATCHLOG_URL=… apt install …).
set -e
if ! id watchlog >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/watchlog --shell /usr/sbin/nologin watchlog 2>/dev/null ||
    useradd --system --no-create-home --home-dir /var/lib/watchlog --shell /sbin/nologin watchlog
fi
if [ "${WATCHLOG_DOCKER:-yes}" = yes ] && getent group docker >/dev/null 2>&1; then
  usermod -aG docker watchlog
elif [ "${WATCHLOG_DOCKER:-yes}" = yes ] && systemctl cat podman.socket >/dev/null 2>&1; then
  # Podman has no docker group: the group watchlog gets its API socket (removed on purge).
  install -d -m 0755 /etc/systemd/system/podman.socket.d
  printf '[Socket]\nSocketGroup=watchlog\n' >/etc/systemd/system/podman.socket.d/watchlog.conf
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl is-active --quiet podman.socket; then systemctl restart podman.socket >/dev/null 2>&1 || true; fi
fi
install -d -m 0750 -o root -g watchlog /etc/watchlog
# How this agent was installed, for the panel's update command (ADR-227): an rpm's scriptlet
# gets a count ("1", "2"), a deb's postinst "configure".
case "${1:-}" in
  [0-9]*) printf 'rpm\n' >/etc/watchlog/install-method ;;
  *) printf 'deb\n' >/etc/watchlog/install-method ;;
esac
chmod 0644 /etc/watchlog/install-method
systemctl daemon-reload >/dev/null 2>&1 || true
if [ ! -f /etc/watchlog/agent.env ] && [ -n "${WATCHLOG_TOKEN:-}" ]; then
  umask 027
  {
    printf 'WATCHLOG_ENDPOINT=%s\n' "${WATCHLOG_URL:-https://ingest.watchlog.io}"
    printf 'WATCHLOG_TOKEN=%s\n' "$WATCHLOG_TOKEN"
    printf 'WATCHLOG_HOSTNAME=%s\n' "${WATCHLOG_HOSTNAME:-$(hostname)}"
  } >/etc/watchlog/agent.env
  chown root:watchlog /etc/watchlog/agent.env
fi
if [ -f /etc/watchlog/agent.env ]; then
  systemctl enable watchlog-agent watchlog-integrations >/dev/null 2>&1 || true
  systemctl restart watchlog-agent watchlog-integrations >/dev/null 2>&1 || true
else
  echo "WatchLog is installed. Write /etc/watchlog/agent.env (an example is in /usr/share/doc/watchlog-agent),"
  echo "then: systemctl enable --now watchlog-agent watchlog-integrations"
fi
