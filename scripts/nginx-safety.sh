#!/usr/bin/env bash
# nginx-safety.sh — sourced by install.sh (install + check) and update.sh (check only).
#
# Why this exists. On 2026-11-18 nginx 1.30.7 (stable) and 1.31.9 (mainline) fixed ten CVEs,
# among them CVE-2026-123007 — unauthenticated code execution through HTTP/2 flow control,
# present in every release since 2015. install.sh used to run a bare `apt-get install nginx`,
# which gives the distribution's package (1.22 on Debian 12, 1.24 on Ubuntu 24.04). Those
# packages get fixes only when Debian/Ubuntu backport them, and on the release day neither had.
#
# The rules this file keeps, because ~1000 self-hosted instances run the installer:
#
#  1. A FRESH box (no nginx yet) gets nginx from nginx.org's own repository, stable branch.
#     The signing key is checked against the published fingerprints before apt trusts it;
#     any failure (unsupported release, network, key mismatch, apt error) removes what was
#     added and returns 1 — the caller falls back to the distribution package. Never half a repo.
#  2. An EXISTING nginx is never swapped for another package. Replacing a distribution nginx
#     with nginx.org's changes the config layout (no sites-enabled, no modules-enabled) and
#     drops the dynamic modules the distro nginx.conf loads, so a box hosting other sites
#     would go dark. It is only upgraded within its own source (security updates), keeping
#     the operator's config files (--force-confold).
#  3. Nothing here edits nginx configs or fails the caller. Exposure (HTTP/2, HTTP/3 on a
#     vulnerable build) is reported with the exact fix; the operator decides.
#
# OPENGSC_NGINX_BIN overrides the binary so the checks can be tested with a stub.

NGINX_MIN_STABLE="1.30.7"
NGINX_MIN_MAINLINE="1.31.9"
# nginx.org packaging keys, as listed by the official nginx Docker image (NGINX_GPGKEYS).
NGINX_ORG_KEY_FPRS="573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 8540A6F18833A80E9C1653A42FD21310B49F6B46 9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3"
NGINX_ORG_LIST="/etc/apt/sources.list.d/nginx.list"
NGINX_ORG_PIN="/etc/apt/preferences.d/99nginx"
NGINX_ORG_KEYRING="/usr/share/keyrings/nginx-archive-keyring.gpg"

_ngx_bin() { echo "${OPENGSC_NGINX_BIN:-nginx}"; }
_ngx_have() { command -v "$(_ngx_bin)" >/dev/null 2>&1; }

# a >= b, dotted numeric versions. sort -V rather than dpkg so update.sh also runs off-Debian.
_ngx_ver_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

# Upstream version from `nginx -v` ("nginx version: nginx/1.24.0 (Ubuntu)" -> 1.24.0).
nginx_upstream_version() {
  _ngx_have || return 0
  "$(_ngx_bin)" -v 2>&1 | sed -n 's|.*nginx/\([0-9][0-9.]*\).*|\1|p' | head -1
}

# 0 when the upstream version already contains the November 2026 fixes.
# 1.31.x is mainline and needs 1.31.9; everything else is compared with the stable minimum
# (1.30.7+, and any later branch such as 1.32).
nginx_version_patched() {
  local v="$1"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  case "$v" in
    1.31.*) _ngx_ver_ge "$v" "$NGINX_MIN_MAINLINE" ;;
    *)      _ngx_ver_ge "$v" "$NGINX_MIN_STABLE" ;;
  esac
}

# nginx.org | distro | other (built from source, a container, no dpkg).
nginx_package_source() {
  command -v dpkg-query >/dev/null 2>&1 || { echo other; return 0; }
  local status maint
  status="$(dpkg-query -W -f='${Status}' nginx 2>/dev/null || true)"
  case "$status" in *"install ok installed"*) ;; *) echo other; return 0 ;; esac
  maint="$(dpkg-query -W -f='${Maintainer}' nginx 2>/dev/null || true)"
  case "$maint" in *nginx-packaging*|*@nginx.com*|*@f5.com*) echo nginx.org ;; *) echo distro ;; esac
}

# Debian/Ubuntu keep the upstream version when they backport, but list each fixed CVE in the
# package changelog — that, not `nginx -v`, says whether a distribution build carries the fix.
# OPENGSC_NGINX_DOC overrides /usr/share/doc for tests.
nginx_distro_backported() {
  local doc="${OPENGSC_NGINX_DOC:-/usr/share/doc}" f
  for f in "$doc"/nginx/changelog.Debian.gz "$doc"/nginx-common/changelog.Debian.gz "$doc"/nginx-core/changelog.Debian.gz; do
    [ -r "$f" ] && gzip -dc "$f" 2>/dev/null | grep -q 'CVE-2026-123007' && return 0
  done
  return 1
}

# "installed candidate" from apt's cached lists (no network). Empty when apt is absent.
_ngx_apt_versions() {
  command -v apt-cache >/dev/null 2>&1 || return 0
  apt-cache policy nginx 2>/dev/null | awk '/Installed:/{i=$2} /Candidate:/{c=$2} END{if(i!="")print i, c}'
}

# Reads the effective config (all includes) from `nginx -T`. Needs root; empty otherwise.
_ngx_dump_config() {
  [ "$(id -u)" = "0" ] || return 0
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 "$(_ngx_bin)" -T 2>/dev/null || true
  else
    "$(_ngx_bin)" -T 2>/dev/null || true
  fi
}

# stdin: config dump. Comment lines never match because the pattern is anchored at the directive.
_ngx_cfg_has_http2() { grep -Eq '^[[:space:]]*(http2[[:space:]]+on[[:space:]]*;|listen[^;#]*[[:space:]]http2([[:space:];]|$))'; }
_ngx_cfg_has_http3() { grep -Eq '^[[:space:]]*(http3[[:space:]]+on[[:space:]]*;|listen[^;#]*[[:space:]]quic([[:space:];]|$))'; }

# Read-only report. Always returns 0.
nginx_security_report() {
  _ngx_have || return 0
  local v src cfg h2=0 h3=0 known=1
  v="$(nginx_upstream_version)"
  src="$(nginx_package_source)"
  cfg="$(_ngx_dump_config)"
  if [ -n "$cfg" ]; then
    printf '%s\n' "$cfg" | _ngx_cfg_has_http2 && h2=1
    printf '%s\n' "$cfg" | _ngx_cfg_has_http3 && h3=1
  else
    known=0
  fi

  if nginx_version_patched "$v"; then
    echo "[nginx] nginx ${v} (${src}) — includes the 2026-11-18 security fixes"
    return 0
  fi
  if [ "$src" = "distro" ] && nginx_distro_backported; then
    echo "[nginx] nginx ${v} (distribution package) — the 2026-11-18 fixes are backported"
    return 0
  fi

  echo "[nginx] ──────────────────────────────────────────────────────────────"
  case "$src" in
    distro)
      local vers inst cand
      vers="$(_ngx_apt_versions)"; inst="${vers%% *}"; cand="${vers#* }"
      echo "[nginx] nginx ${v:-?} from the distribution package (${inst:-?}) does not have the"
      echo "[nginx] 2026-11-18 fixes yet (CVE-2026-123007 and nine more are not in its changelog)."
      if [ -n "$cand" ] && [ "$cand" != "$inst" ] && [ "$cand" != "(none)" ]; then
        echo "[nginx] An update (${cand}) is waiting. As root:"
      else
        echo "[nginx] Debian/Ubuntu publish the fix as a regular security update. As root:"
      fi
      echo "[nginx]   apt-get update && apt-get install --only-upgrade nginx nginx-common"
      ;;
    nginx.org)
      echo "[nginx] nginx ${v:-?} from nginx.org is VULNERABLE (CVE-2026-123007 and nine more)."
      echo "[nginx] Fixed in ${NGINX_MIN_STABLE} (stable) / ${NGINX_MIN_MAINLINE} (mainline). As root:"
      echo "[nginx]   apt-get update && apt-get install --only-upgrade nginx"
      ;;
    *)
      echo "[nginx] nginx ${v:-?} is older than ${NGINX_MIN_STABLE} / ${NGINX_MIN_MAINLINE} and VULNERABLE"
      echo "[nginx] (CVE-2026-123007 and nine more). Upgrade it the way it was installed."
      ;;
  esac
  if [ "$h2" = "1" ]; then
    echo "[nginx] HTTP/2 IS ENABLED — this is the remote code execution path (CVE-2026-123007)."
    echo "[nginx] Until nginx is upgraded, remove 'http2' from the 'listen' lines (or set 'http2 off;'),"
    echo "[nginx] then: nginx -t && systemctl reload nginx. Find them with: grep -rn http2 /etc/nginx/"
  elif [ "$known" = "0" ]; then
    echo "[nginx] Could not read the config (not root). Check for HTTP/2: grep -rn http2 /etc/nginx/"
  fi
  if [ "$h3" = "1" ]; then
    echo "[nginx] HTTP/3 (quic) is enabled — also affected (CVE-2026-121810) until upgraded."
  fi
  echo "[nginx] ──────────────────────────────────────────────────────────────"
  return 0
}

_ngx_org_cleanup() {
  rm -f "$NGINX_ORG_LIST" "$NGINX_ORG_PIN" "$NGINX_ORG_KEYRING" 2>/dev/null || true
  apt-get update -qq >/dev/null 2>&1 || true
}

# Fresh install from nginx.org (stable). 0 on success; 1 with nothing left behind otherwise.
nginx_org_install() {
  [ "$(id -u)" = "0" ] || return 1
  [ -r /etc/os-release ] || return 1
  local distro codename
  distro="$(. /etc/os-release && echo "${ID:-}")"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  case "$distro" in ubuntu|debian) ;; *) echo "[nginx] ${distro:-this OS} is not covered by nginx.org packages"; return 1 ;; esac
  [ -n "$codename" ] || return 1

  if ! curl -fsI --max-time 20 "https://nginx.org/packages/${distro}/dists/${codename}/Release" >/dev/null 2>&1; then
    echo "[nginx] nginx.org has no packages for ${distro} ${codename} (or is unreachable)"
    return 1
  fi

  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gnupg ca-certificates >/dev/null 2>&1 || return 1

  local tmp fprs f ok=0
  tmp="$(mktemp)" || return 1
  if ! curl -fsSL --max-time 30 https://nginx.org/keys/nginx_signing.key -o "$tmp"; then
    rm -f "$tmp"; echo "[nginx] could not download the nginx.org signing key"; return 1
  fi
  # Every key in the file must be one of the published ones, and there must be at least one.
  fprs="$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}')"
  if [ -n "$fprs" ]; then
    ok=1
    for f in $fprs; do
      case " $NGINX_ORG_KEY_FPRS " in *" $f "*) ;; *) ok=0 ;; esac
    done
  fi
  if [ "$ok" != "1" ]; then
    rm -f "$tmp"; echo "[nginx] nginx.org signing key fingerprint does not match — not trusting it"; return 1
  fi
  gpg --dearmor < "$tmp" > "$NGINX_ORG_KEYRING" 2>/dev/null || { rm -f "$tmp"; _ngx_org_cleanup; return 1; }
  rm -f "$tmp"
  chmod 644 "$NGINX_ORG_KEYRING"

  echo "deb [signed-by=${NGINX_ORG_KEYRING}] https://nginx.org/packages/${distro} ${codename} nginx" > "$NGINX_ORG_LIST"
  # Prefer nginx.org's nginx over the distribution's, as nginx.org's own instructions do —
  # otherwise a later distro version bump could silently switch the package back.
  printf 'Package: *\nPin: origin nginx.org\nPin: release o=nginx\nPin-Priority: 900\n' > "$NGINX_ORG_PIN"

  if ! apt-get update -qq >/dev/null 2>&1; then
    echo "[nginx] apt could not read the nginx.org repository"; _ngx_org_cleanup; return 1
  fi
  if ! DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -qq nginx; then
    echo "[nginx] installing nginx from nginx.org failed"; _ngx_org_cleanup; return 1
  fi
  return 0
}

# Existing nginx: security updates from its own source only, operator's configs kept.
nginx_upgrade_in_place() {
  [ "$(id -u)" = "0" ] || return 0
  [ "$(nginx_package_source)" = "other" ] && return 0
  local pkgs="nginx"
  dpkg-query -W -f='${Status}' nginx-common 2>/dev/null | grep -q "install ok installed" && pkgs="nginx nginx-common"
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y -qq --only-upgrade \
    -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef $pkgs \
    || echo "[nginx] security upgrade did not complete — run: apt-get install --only-upgrade ${pkgs}"
  return 0
}

# Where the OpenGSC site file goes. Debian-style layout when nginx.conf includes sites-enabled
# (distribution package), conf.d otherwise (nginx.org package, which has no sites-enabled).
nginx_site_conf_path() {
  if [ -d /etc/nginx/sites-enabled ] && grep -Eqs '^[[:space:]]*include[[:space:]]+/etc/nginx/sites-enabled/' /etc/nginx/nginx.conf; then
    echo /etc/nginx/sites-available/opengsc
  else
    echo /etc/nginx/conf.d/opengsc.conf
  fi
}
