#!/usr/bin/env bash
# ensure-build-swap.sh — sourced by install.sh and update.sh right before `npm run build`.
#
# The Turbopack production build peaks around 2.4 GB of memory. Measured on a 2 GB VPS
# (issue #21): all of physical RAM plus ~450 MB of swap before the OOM killer ends the
# process with a bare "Killed". NODE_OPTIONS heap caps don't help — that memory is
# Rust-side, outside the V8 heap — but swap does: the same build completes with a
# swapfile present. So on machines with less than ~3 GB of RAM + swap combined, the
# swapfile is created here, before the build starts, instead of diagnosing the kill
# afterwards.
#
# Every failure degrades to a warning and returns 0 — the build always gets to run.
# OPENGSC_MEMINFO overrides /proc/meminfo so the parsing can be tested off-Linux.

ensure_build_swap() {
  local meminfo="${OPENGSC_MEMINFO:-/proc/meminfo}"
  [ -r "$meminfo" ] || return 0  # not Linux (local dev machine) — nothing to check

  local mem_mb swap_mb
  mem_mb=$(awk '/^MemTotal:/  {print int($2/1024)}' "$meminfo")
  swap_mb=$(awk '/^SwapTotal:/ {print int($2/1024)}' "$meminfo")
  [[ "$mem_mb" =~ ^[0-9]+$ ]] || return 0
  [[ "$swap_mb" =~ ^[0-9]+$ ]] || return 0

  if [ $((mem_mb + swap_mb)) -ge 3000 ]; then return 0; fi

  echo "[swap] low memory: ${mem_mb} MB RAM + ${swap_mb} MB swap — the build peaks around 2.4 GB"

  # Containers generally cannot swapon (no swap accounting, or the runtime masks it) —
  # say so instead of printing a kernel error mid-install.
  if [ -f /.dockerenv ] || { command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt -cq; }; then
    echo "[swap] running inside a container — swap cannot be enabled from here."
    echo "[swap] give the container ≥ 3 GB, or build outside and copy .next over."
    return 0
  fi

  if [ "$EUID" -ne 0 ]; then
    echo "[swap] not run as root — add swap manually and retry:"
    echo "[swap]   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
    return 0
  fi

  # /swapfile already active but the box is still short → a second file; the live one is
  # never touched. /swapfile present but inactive (fstab entry that never got swapon'd)
  # → just enabled, not recreated.
  local target=/swapfile
  if grep -q "^/swapfile " /proc/swaps 2>/dev/null; then
    target=/swapfile2
  elif [ -e /swapfile ]; then
    if swapon /swapfile 2>/dev/null; then
      echo "[swap] enabled existing /swapfile"
    else
      echo "[swap] /swapfile exists but cannot be enabled — not touching it; add swap manually"
    fi
    return 0
  fi
  if [ -e "$target" ]; then
    echo "[swap] $target already exists — add swap manually"
    return 0
  fi

  # 4 GB by default (measured peak ~2.4 GB plus headroom for npm/prisma running alongside),
  # shrunk to 2 GB when disk is tight, skipped when even that does not fit.
  local want_mb=4096 free_mb
  free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
  if [ -n "$free_mb" ] && [ "$free_mb" -lt $((want_mb + 1536)) ]; then
    want_mb=2048
    if [ "$free_mb" -lt $((want_mb + 1536)) ]; then
      echo "[swap] only ${free_mb} MB free on / — not enough for a swapfile; add RAM or swap manually"
      return 0
    fi
  fi

  echo "[swap] creating a ${want_mb} MB swapfile at ${target}..."
  if ! fallocate -l "${want_mb}M" "$target" 2>/dev/null; then
    # Filesystems without fallocate support (ZFS datasets, some overlays) — dd is slower but universal.
    if ! dd if=/dev/zero of="$target" bs=1M count="$want_mb" status=none; then
      echo "[swap] could not allocate ${target} — add swap manually"
      rm -f "$target"
      return 0
    fi
  fi
  chmod 600 "$target"
  if ! mkswap "$target" >/dev/null 2>&1; then
    echo "[swap] mkswap failed on ${target} — add swap manually"
    rm -f "$target"
    return 0
  fi
  if ! swapon "$target" 2>/dev/null; then
    echo "[swap] swapon refused (host kernel restriction) — removing ${target}"
    echo "[swap] add swap on the host machine, or build somewhere with ≥ 3 GB"
    rm -f "$target"
    return 0
  fi
  # Persist across reboots; idempotent.
  if ! grep -qE "^${target}[[:space:]]" /etc/fstab 2>/dev/null; then
    echo "$target none swap sw 0 0" >> /etc/fstab
  fi
  echo "[swap] ${want_mb} MB swap active at ${target} (kept in /etc/fstab)"
  return 0
}
