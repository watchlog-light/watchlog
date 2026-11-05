#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Deploys the static site (site/) to the web server (deploy/site/DEPLOY.md).
#
#   WATCHLOG_SITE_HOST=deploy@203.0.113.10 deploy/site/deploy-site.sh            build, upload, switch
#   WATCHLOG_SITE_HOST=deploy@203.0.113.10 deploy/site/deploy-site.sh rollback   back to the previous release
#   WATCHLOG_SITE_HOST=deploy@203.0.113.10 deploy/site/deploy-site.sh list       releases on the server
#
# Each deploy uploads into a new folder <dir>/releases/<UTC time>-<commit>. Only when
# the upload is complete does `current` (nginx's root) switch to it, by renaming a new
# symlink over the old one, so visitors never see a half-uploaded site. The last 3
# releases are kept.
#
# Environment:
#   WATCHLOG_SITE_HOST  required: the SSH destination, user@host (never written here)
#   WATCHLOG_SITE_DIR   the site folder on the server (default /var/www/watchlog.io)
#   WATCHLOG_SITE_SSH   the ssh command, e.g. "ssh -p 2222 -i ~/.ssh/watchlog" (default ssh)
set -euo pipefail

host=${WATCHLOG_SITE_HOST:?set WATCHLOG_SITE_HOST to the SSH destination, e.g. deploy@your-server}
dir=${WATCHLOG_SITE_DIR:-/var/www/watchlog.io}
ssh_cmd=${WATCHLOG_SITE_SSH:-ssh}
keep=3
cd "$(git rev-parse --show-toplevel)"

remote() { $ssh_cmd "$host" "$@"; }

# Points `current` at a release: a new symlink renamed over the old one (atomic).
switch_to() {
  remote "set -e; cd '$dir'; test -f 'releases/$1/index.html' && test -f 'releases/$1/404.html'; \
    ln -sfn 'releases/$1' current.new && mv -T current.new current"
  echo "current → $1"
}

releases() { remote "ls -1 '$dir/releases' 2>/dev/null | sort"; }
current() { remote "readlink '$dir/current' 2>/dev/null | sed 's#.*/##'" || true; }

case "${1:-deploy}" in
  deploy)
    if [ -n "$(git status --porcelain -- site docs/site)" ]; then
      echo "note: site/ or docs/site/ has uncommitted changes; they are deployed too" >&2
    fi
    pnpm --filter @watchlog/site generate
    name="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
    # The new release starts as hard links to the current one, so unchanged files are
    # neither sent nor stored twice; rsync writes changed files as new files (compared
    # by checksum, as every build rewrites them), which leaves the old release intact.
    # This works with any rsync on this side, including macOS's openrsync.
    remote "mkdir -p '$dir/releases/$name' && if [ -d '$dir/current/' ]; then cp -al '$dir/current/.' '$dir/releases/$name/'; fi"
    rsync -az --checksum --delete -e "$ssh_cmd" site/.output/public/ "$host:$dir/releases/$name/"
    switch_to "$name"
    now=$(current)
    remote "cd '$dir/releases' && ls -1 | sort | head -n -$keep | grep -vx '$now' | xargs -r rm -rf"
    echo "deployed $name; kept the last $keep releases. Purge the Cloudflare cache if HTML is cached there."
    ;;
  rollback)
    now=$(current)
    prev=$(releases | awk -v now="$now" '$0 == now { print last; exit } { last = $0 }')
    if [ -z "$prev" ]; then
      echo "no release before ${now:-(none)} to roll back to" >&2
      exit 1
    fi
    switch_to "$prev"
    ;;
  list)
    now=$(current)
    releases | while read -r r; do echo "$([ "$r" = "$now" ] && echo '*' || echo ' ') $r"; done
    ;;
  *)
    echo "usage: $0 [deploy|rollback|list]" >&2
    exit 2
    ;;
esac
