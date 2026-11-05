#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Converts the README screenshots (docs/images/*.png, 3024×1580, taken on the demo
# account) into the site's WebP images at two widths, and the Open Graph image.
# Needs cwebp (libwebp) and macOS sips. The outputs are committed.
set -euo pipefail
cd "$(dirname "$0")/.."
for name in overview service-map workloads; do
  for w in 800 1400; do
    cwebp -quiet -q 78 -resize "$w" 0 "../docs/images/$name.png" -o "app/assets/img/$name-$w.webp"
  done
done
tmp=$(mktemp -d)
sips -s format png --resampleHeight 630 ../docs/images/overview.png --out "$tmp/og.png" >/dev/null
sips -c 630 1200 "$tmp/og.png" --out public/og.png >/dev/null
rm -rf "$tmp"
ls -la app/assets/img public/og.png | awk '{print $5, $NF}'
