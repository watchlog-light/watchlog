#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# After the deb is purged or the rpm erased (not on an upgrade): the configuration, state and user.
case "${1:-}" in
purge | 0)
  rm -rf /etc/watchlog /var/lib/watchlog
  userdel watchlog >/dev/null 2>&1 || true
  ;;
esac
systemctl daemon-reload >/dev/null 2>&1 || true
