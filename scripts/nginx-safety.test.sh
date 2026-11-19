#!/usr/bin/env bash
# Tests for scripts/nginx-safety.sh that need no root, no network and no real nginx:
#   bash scripts/nginx-safety.test.sh
set -u
cd "$(dirname "$0")/.." || exit 1
source scripts/nginx-safety.sh
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$3', got '$2'"; fail=1; fi; }
patched() { nginx_version_patched "$1" && echo yes || echo no; }

check "1.24.0 distro base"   "$(patched 1.24.0)" no
check "1.30.6 stable"        "$(patched 1.30.6)" no
check "1.30.7 stable"        "$(patched 1.30.7)" yes
check "1.30.10 stable"       "$(patched 1.30.10)" yes
check "1.31.8 mainline"      "$(patched 1.31.8)" no
check "1.31.9 mainline"      "$(patched 1.31.9)" yes
check "1.31.10 mainline"     "$(patched 1.31.10)" yes
check "1.32.0 next stable"   "$(patched 1.32.0)" yes
check "empty"                "$(patched '')" no
check "garbage"              "$(patched 'abc')" no

h2() { printf '%s\n' "$1" | _ngx_cfg_has_http2 && echo yes || echo no; }
h3() { printf '%s\n' "$1" | _ngx_cfg_has_http3 && echo yes || echo no; }
check "listen ssl http2"          "$(h2 '    listen 443 ssl http2; # managed by Certbot')" yes
check "listen [::] http2"         "$(h2 '    listen [::]:443 ssl http2;')" yes
check "http2 on"                  "$(h2 '    http2 on;')" yes
check "http2 off"                 "$(h2 '    http2 off;')" no
check "plain ssl"                 "$(h2 '    listen 443 ssl; # managed by Certbot')" no
check "commented http2"           "$(h2 '    # listen 443 ssl http2;')" no
check "http2 in a comment tail"   "$(h2 '    listen 443 ssl; # was http2')" no
check "http2_max_concurrent only" "$(h2 '    http2_max_concurrent_streams 64;')" no
check "quic listener"             "$(h3 '    listen 443 quic reuseport;')" yes
check "no quic"                   "$(h3 '    listen 443 ssl;')" no

# Version parsing through a stub binary.
stub="$(mktemp)"; printf '#!/bin/sh\necho "nginx version: nginx/1.24.0 (Ubuntu)" >&2\n' > "$stub"; chmod +x "$stub"
check "parse nginx -v"  "$(OPENGSC_NGINX_BIN="$stub" nginx_upstream_version)" 1.24.0
printf '#!/bin/sh\necho "nginx version: nginx/1.30.7" >&2\n' > "$stub"
check "report on patched build" "$(OPENGSC_NGINX_BIN="$stub" nginx_security_report | grep -c 'includes the 2026-11-18')" 1
check "report never fails" "$(OPENGSC_NGINX_BIN=/nonexistent nginx_security_report; echo rc=$?)" rc=0
rm -f "$stub"

# Distribution backport detection from the package changelog.
doc="$(mktemp -d)"; mkdir -p "$doc/nginx"
printf 'nginx (1.24.0-2ubuntu7.6) noble-security\n  * SECURITY UPDATE: CVE-2026-118899\n' | gzip > "$doc/nginx/changelog.Debian.gz"
check "changelog without the CVE" "$(OPENGSC_NGINX_DOC="$doc" nginx_distro_backported && echo yes || echo no)" no
printf 'nginx (1.24.0-2ubuntu7.7) noble-security\n  * SECURITY UPDATE: CVE-2026-123007\n' | gzip > "$doc/nginx/changelog.Debian.gz"
check "changelog with the CVE"    "$(OPENGSC_NGINX_DOC="$doc" nginx_distro_backported && echo yes || echo no)" yes
check "no changelog at all"       "$(OPENGSC_NGINX_DOC=/nonexistent nginx_distro_backported && echo yes || echo no)" no
rm -rf "$doc"

exit $fail
