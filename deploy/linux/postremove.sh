#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# After the deb is purged or the rpm erased (not on an upgrade): the configuration, state, user
# and the Podman socket drop-in.
case "${1:-}" in
purge | 0)
  rm -rf /etc/watchlog /var/lib/watchlog
  if [ -f /etc/systemd/system/podman.socket.d/watchlog.conf ]; then
    rm -f /etc/systemd/system/podman.socket.d/watchlog.conf
    rmdir /etc/systemd/system/podman.socket.d 2>/dev/null || true
    systemctl daemon-reload >/dev/null 2>&1 || true
    if systemctl is-active --quiet podman.socket; then systemctl restart podman.socket >/dev/null 2>&1 || true; fi
  fi
  userdel watchlog >/dev/null 2>&1 || true
  ;;
esac
systemctl daemon-reload >/dev/null 2>&1 || true
