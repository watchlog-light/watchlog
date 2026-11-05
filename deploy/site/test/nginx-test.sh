#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Tests deploy/site/nginx/watchlog.io.conf against the generated site, in a container:
# `nginx -t`, the v1 redirect map, HTTP → HTTPS and www → apex, every page, the custom
# 404, caching and security headers, and gzip. Uses nginx 1.24 (Ubuntu 24.04's) and a
# throwaway self-signed certificate. Run `pnpm --filter @watchlog/site generate` first.
#   KEEP=1  leave the container running (https://watchlog.io:18443 with --resolve)
set -euo pipefail
cd "$(dirname "$0")/../../.."
site=site/.output/public
[ -f "$site/index.html" ] || { echo "no generated site: run pnpm --filter @watchlog/site generate" >&2; exit 1; }

name=watchlog-site-nginx-test
https=${HTTPS_PORT:-18443}
http=${HTTP_PORT:-18080}
tmp=$(mktemp -d)
cleanup() {
  [ "${KEEP:-}" = 1 ] || docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=watchlog.io \
  -addext 'subjectAltName=DNS:watchlog.io,DNS:www.watchlog.io' \
  -keyout "$tmp/privkey.pem" -out "$tmp/fullchain.pem" 2>/dev/null
chmod 644 "$tmp"/*.pem
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:$https:443" -p "127.0.0.1:$http:80" \
  -v "$PWD/deploy/site/nginx/watchlog.io.conf:/etc/nginx/conf.d/watchlog.io.conf:ro" \
  -v "$tmp:/etc/ssl/watchlog.io:ro" \
  -v "$PWD/$site:/var/www/watchlog.io/current:ro" \
  nginx:1.24-alpine >/dev/null
docker exec "$name" rm -f /etc/nginx/conf.d/default.conf
docker exec "$name" nginx -t 2>&1 | sed 's/^/nginx -t: /'
docker exec "$name" nginx -s reload
sleep 1

# From here on a failed check is counted and reported, not fatal.
set +e
fails=0
check() { # name, condition result (0 = pass), detail
  if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1 — $3"; fails=$((fails + 1)); fi
}
req() { curl -sk -o /dev/null --resolve "watchlog.io:$https:127.0.0.1" --resolve "www.watchlog.io:$https:127.0.0.1" "$@"; }
head_() { curl -sk -D - -o /dev/null --resolve "watchlog.io:$https:127.0.0.1" "$@"; }

# The v1 redirect map.
while read -r path want; do
  got=$(req -w '%{http_code} %{redirect_url}' "https://watchlog.io:$https$path")
  [ "$got" = "301 $want" ]
  check "redirect $path → $want" $? "$got"
done <<'EOF'
/pricing https://watchlog.io/#cloud
/pricing/ https://watchlog.io/#cloud
/enterprise https://watchlog.io/#cloud
/enterprise/ https://watchlog.io/#cloud
/enterprise/on-premise https://watchlog.io/#cloud
/request-demo https://watchlog.io/#cloud
/privacy-policy https://watchlog.io/legal/privacy/
/terms-of-service https://watchlog.io/legal/terms/
/products https://watchlog.io/
/products/kubernetes-monitoring https://watchlog.io/
/integrations https://watchlog.io/
/integrations/slack https://watchlog.io/
EOF

got=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "watchlog.io:$http:127.0.0.1" "http://watchlog.io:$http/docs?x=1")
[ "$got" = "301 https://watchlog.io/docs?x=1" ]
check "HTTP → HTTPS on the apex, path and query kept" $? "$got"
got=$(req -w '%{http_code} %{redirect_url}' "https://www.watchlog.io:$https/security/")
[ "$got" = "301 https://watchlog.io/security/" ]
check "www → apex" $? "$got"

# Every page as plain files; a page's bare path redirects once to its canonical URL.
for path in / /docs/ /docs/install/ /docs/configuration/ /docs/faq/ /security/ /legal/privacy/ /legal/terms/ /sitemap.xml /robots.txt /og.png; do
  got=$(req -w '%{http_code}' "https://watchlog.io:$https$path")
  [ "$got" = 200 ]
  check "page $path" $? "$got"
done
for path in /docs /security /legal/terms; do
  got=$(req -w '%{http_code} %{redirect_url}' "https://watchlog.io:$https$path")
  [ "$got" = "301 https://watchlog.io$path/" ]
  check "bare $path → $path/" $? "$got"
done
got=$(curl -sk --resolve "watchlog.io:$https:127.0.0.1" -w '\n%{http_code}' "https://watchlog.io:$https/no-such-page")
[ "$(tail -n1 <<<"$got")" = 404 ] && grep -q 'This page doesn' <<<"$got"
check "custom 404 page" $? "$(tail -n1 <<<"$got")"

# Headers.
h=$(head_ "https://watchlog.io:$https/")
grep -qi '^content-security-policy: default-src .self.' <<<"$h"
check "CSP on HTML" $? "missing"
for hdr in strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy; do
  grep -qi "^$hdr:" <<<"$h"
  check "header $hdr" $? "missing"
done
grep -qi '^cache-control: public, max-age=300, must-revalidate' <<<"$h"
check "short cache for HTML" $? "$(grep -i '^cache-control' <<<"$h")"
asset=$(grep -o '/_nuxt/[^"]*\.css' "$site/index.html" | head -1)
h=$(head_ "https://watchlog.io:$https$asset")
grep -qi '^cache-control: public, max-age=31536000, immutable' <<<"$h"
check "long cache for hashed assets ($asset)" $? "$(grep -i '^cache-control' <<<"$h")"
h=$(head_ "https://watchlog.io:$https/no-such-page")
grep -qi '^content-security-policy:' <<<"$h"
check "security headers on the 404 too" $? "missing"
h=$(head_ -H 'Accept-Encoding: gzip' "https://watchlog.io:$https/")
grep -qi '^content-encoding: gzip' <<<"$h"
check "gzip" $? "no content-encoding"

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "nginx: all checks passed"
