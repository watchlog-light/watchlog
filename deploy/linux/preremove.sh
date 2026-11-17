#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Before the deb or rpm is removed or upgraded: stop the units (an upgrade starts them again).
systemctl stop watchlog-agent watchlog-integrations >/dev/null 2>&1 || true
if [ "${1:-}" = remove ] || [ "${1:-}" = 0 ]; then
  systemctl disable watchlog-agent watchlog-integrations >/dev/null 2>&1 || true
fi
