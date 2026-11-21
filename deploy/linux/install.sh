#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# WatchLog on a Linux server (ADR-209): the agent and the integrations collector as systemd
# units, running as the user watchlog with only the capabilities they need.
#
#   curl -fsSL <this script> | sudo sh -s -- --token <cluster token> [--url <WatchLog URL>]
#   … | sudo sh -s -- --upgrade          new binaries, the configuration kept
#   … | sudo sh -s -- --uninstall        the units, binaries, user and /etc/watchlog removed
#
# Options: --version <x.y.z> (default: the latest release), --hostname <name>, --no-docker
# (don't add watchlog to the docker group, or give it Podman's socket: containers won't show). The binaries come from
# GitHub Releases and are checked against the release's SHA256SUMS, and its signature when
# cosign is installed. WATCHLOG_INSTALL_FROM=<dir> installs from a directory with the same
# files instead (tests).
set -eu

REPO=watchlog-light/watchlog
URL=${WATCHLOG_URL:-https://ingest.watchlog.io}
TOKEN=${WATCHLOG_TOKEN:-}
VERSION=${WATCHLOG_VERSION:-}
NAME=""
DOCKER=yes
ACTION=install

say() { printf '%s\n' "$*"; }
die() { printf 'watchlog install: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
  --token) TOKEN=${2:-}; shift 2 ;;
  --url) URL=${2:-}; shift 2 ;;
  --version) VERSION=${2:-}; shift 2 ;;
  --hostname) NAME=${2:-}; shift 2 ;;
  --no-docker) DOCKER=no; shift ;;
  --upgrade) ACTION=upgrade; shift ;;
  --uninstall) ACTION=uninstall; shift ;;
  -h | --help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
  *) die "unknown option $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run it as root (sudo sh -s -- …)"
command -v systemctl >/dev/null 2>&1 || die "this script needs systemd; without it run the agent with docker run (docs: Servers)"

ENV=/etc/watchlog/agent.env
UNITS="watchlog-agent watchlog-integrations"

uninstall() {
  for u in $UNITS; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$u.service"
  done
  if [ -f /etc/systemd/system/podman.socket.d/watchlog.conf ]; then
    rm -f /etc/systemd/system/podman.socket.d/watchlog.conf
    rmdir /etc/systemd/system/podman.socket.d 2>/dev/null || true
    systemctl daemon-reload
    if systemctl is-active --quiet podman.socket; then systemctl restart podman.socket; fi
  fi
  systemctl daemon-reload
  rm -f /usr/bin/watchlog-agent /usr/bin/watchlog-integrations
  rm -rf /etc/watchlog /var/lib/watchlog
  if id watchlog >/dev/null 2>&1; then userdel watchlog >/dev/null 2>&1 || true; fi
  if getent group watchlog >/dev/null 2>&1; then groupdel watchlog >/dev/null 2>&1 || true; fi
  say "WatchLog removed: its units, binaries, user, /etc/watchlog and its Podman socket drop-in."
}

if [ "$ACTION" = uninstall ]; then
  uninstall
  exit 0
fi

case "$(uname -m)" in
x86_64 | amd64) ARCH=amd64 ;;
aarch64 | arm64) ARCH=arm64 ;;
*) die "unsupported architecture $(uname -m): amd64 and arm64 only" ;;
esac

if [ "$ACTION" = install ]; then
  [ -n "$TOKEN" ] || die "--token is required (WatchLog shows the command with it: Add servers)"
  case "$URL" in http://* | https://*) ;; *) die "--url must start with http:// or https://" ;; esac
fi
if [ "$ACTION" = upgrade ] && [ ! -f "$ENV" ]; then
  die "WatchLog isn't installed here (no $ENV): install it first"
fi

fetch() { # source, destination
  if [ -n "${WATCHLOG_INSTALL_FROM:-}" ]; then
    cp "$WATCHLOG_INSTALL_FROM/$1" "$2"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$BASE/$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$BASE/$1"
  else
    die "curl or wget is needed"
  fi
}

if [ -z "$VERSION" ] && [ -z "${WATCHLOG_INSTALL_FROM:-}" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
  [ -n "$VERSION" ] || die "couldn't find the latest release; pass --version"
fi
VERSION=${VERSION#v}
BASE="https://github.com/$REPO/releases/download/v$VERSION"
TARBALL="watchlog-agent_${VERSION}_linux_${ARCH}.tar.gz"
[ -n "${WATCHLOG_INSTALL_FROM:-}" ] && TARBALL=$(cd "$WATCHLOG_INSTALL_FROM" && ls watchlog-agent_*_linux_"$ARCH".tar.gz | head -1)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "Downloading $TARBALL"
fetch "$TARBALL" "$TMP/$TARBALL"
fetch SHA256SUMS "$TMP/SHA256SUMS"
(cd "$TMP" && grep " $TARBALL\$" SHA256SUMS | sha256sum -c - >/dev/null) || die "checksum mismatch for $TARBALL"
say "Checksum verified."
if command -v cosign >/dev/null 2>&1 && fetch SHA256SUMS.sigstore.json "$TMP/SHA256SUMS.sigstore.json" 2>/dev/null; then
  cosign verify-blob --bundle "$TMP/SHA256SUMS.sigstore.json" \
    --certificate-identity-regexp "^https://github.com/$REPO/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com "$TMP/SHA256SUMS" >/dev/null 2>&1 ||
    die "the release's signature didn't verify"
  say "Signature verified (cosign)."
else
  say "cosign isn't installed: the signature wasn't checked (the checksum was). See the docs to verify it."
fi
tar -xzf "$TMP/$TARBALL" -C "$TMP"

if ! id watchlog >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/watchlog --shell /usr/sbin/nologin watchlog 2>/dev/null ||
    useradd --system --no-create-home --home-dir /var/lib/watchlog --shell /sbin/nologin watchlog
fi
if [ "$DOCKER" = yes ] && getent group docker >/dev/null 2>&1; then
  usermod -aG docker watchlog
  say "watchlog joined the docker group, so containers show. That gives it root-equivalent access through the Docker API; --no-docker leaves it out."
elif [ "$DOCKER" = yes ] && systemctl cat podman.socket >/dev/null 2>&1; then
  # Podman (RHEL and its kin) has no docker group: its API socket is root's. The group
  # watchlog gets it through a drop-in, which --uninstall removes.
  install -d -m 0755 /etc/systemd/system/podman.socket.d
  printf '[Socket]\nSocketGroup=watchlog\n' >/etc/systemd/system/podman.socket.d/watchlog.conf
  systemctl daemon-reload
  if systemctl is-active --quiet podman.socket; then systemctl restart podman.socket; fi
  say "Podman's API socket now belongs to the group watchlog, so containers show. That gives it root-equivalent access through the Podman API; --no-docker leaves it out."
fi

for u in $UNITS; do systemctl stop "$u" >/dev/null 2>&1 || true; done
install -m 0755 "$TMP/watchlog-agent" /usr/bin/watchlog-agent
install -m 0755 "$TMP/watchlog-integrations" /usr/bin/watchlog-integrations
for u in $UNITS; do install -m 0644 "$TMP/$u.service" "/etc/systemd/system/$u.service"; done
install -d -m 0750 -o root -g watchlog /etc/watchlog
# How this agent was installed, for the panel's update command (ADR-227).
printf 'script\n' >/etc/watchlog/install-method
chmod 0644 /etc/watchlog/install-method
if [ "$ACTION" = install ]; then
  umask 027
  {
    printf 'WATCHLOG_ENDPOINT=%s\n' "$URL"
    printf 'WATCHLOG_TOKEN=%s\n' "$TOKEN"
    printf 'WATCHLOG_HOSTNAME=%s\n' "${NAME:-$(hostname)}"
  } >"$ENV"
  chown root:watchlog "$ENV"
  chmod 0640 "$ENV"
fi
systemctl daemon-reload
for u in $UNITS; do systemctl enable --now "$u" >/dev/null; done
sleep 2
for u in $UNITS; do
  if systemctl is-active --quiet "$u"; then say "$u: running"; else say "$u: not running, see: journalctl -u $u"; fi
done
VERSION_NOW=$(/usr/bin/watchlog-agent --version 2>/dev/null | head -1)
if [ "$ACTION" = upgrade ]; then
  say "WatchLog is upgraded to $VERSION_NOW; its configuration is kept."
else
  say "WatchLog $VERSION_NOW is installed. This server appears in WatchLog within a minute."
fi
