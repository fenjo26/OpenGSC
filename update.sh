#!/bin/bash
# One-command updater — pulls the latest main, installs deps, migrates the DB, rebuilds,
# and restarts the PM2 process. Triggered from the UI (Settings → owner-only "Update" button,
# which spawns this detached and streams the log) or run by hand:  bash update.sh
#
# It cd's to its own directory so it works regardless of where it's invoked from.
set -o pipefail
cd "$(dirname "$0")" || exit 1

# ─── survive being started from the UI ─────────────────────────────────────────────────────
# Two traps, both fatal to an update started from the Settings button, both handled here so they
# hold even when the server that launched this run is an OLDER build with an older route:
#
# 1. pm2 tree-kill. `pm2 stop opengsc` below kills the app's whole process tree, walked by parent
#    PID. Launched by the app, this script IS in that tree and died at "stopping the app for the
#    build window...", leaving the app down. If any ancestor is pm2's daemon, re-launch detached
#    (double fork → reparented to init) into the same log and let this copy exit.
# 2. Self-replacement. bash reads a script lazily, and `git reset --hard` below rewrites this
#    file mid-run, so the rest of the run would continue at a byte offset into the NEW text. All
#    of the work is therefore inside main(), which bash parses completely before running a line.
inside_pm2_tree() {
  local pid=$PPID cmd
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$cmd" in *"PM2 v"*|*"God Daemon"*) return 0 ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
if [ -z "$OPENGSC_UPDATE_DETACHED" ] && inside_pm2_tree; then
  export OPENGSC_UPDATE_DETACHED=1
  log_target="$(readlink "/proc/$$/fd/1" 2>/dev/null)"
  [ -n "$log_target" ] && [ -f "$log_target" ] || log_target="${TMPDIR:-/tmp}/opengsc-update.log"
  if command -v setsid >/dev/null 2>&1; then
    ( setsid nohup bash "$0" "$@" >> "$log_target" 2>&1 < /dev/null & )
  else
    ( nohup bash "$0" "$@" >> "$log_target" 2>&1 < /dev/null & )
  fi
  exit 0
fi

main() {
echo "___OPENGSC_UPDATE_START___"
echo "[update] $(date -u) — starting in $(pwd)"

echo "[update] git fetch..."
git fetch origin || { echo "[update] git fetch FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

# The backup happens BEFORE `git reset --hard`, not after, and the ordering is deliberate.
#
# A production install points DATABASE_URL at an absolute path outside the repository
# (data/prod.db), so the reset cannot touch it. A local install left on the template default
# (file:./dev.db) is a different story: dev.db is tracked, so `git reset --hard` restores the
# repository's copy over it. Backing up first means that case costs a restore, not the data.
backed_up_before_reset=0
if [ -f scripts/backup-sqlite.mjs ]; then
  echo "[update] backing up SQLite before touching the working tree..."
  # Hard ceiling. A backup that hangs is worse than one that fails: the updater sits there with no
  # output, the operator cannot tell it apart from slow, and nothing else can run. Ten minutes is
  # far beyond any real copy — VACUUM INTO does a 20 MB database in under a second.
  if timeout 600 node scripts/backup-sqlite.mjs; then
    backed_up_before_reset=1
  else
    echo "[update] database backup FAILED — nothing was changed"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1
  fi
else
  echo "[update] no backup script in this checkout yet — it arrives with this update"
fi

# The reset below restores every TRACKED file, and `dev.db` is tracked — an empty 23 MB schema
# template committed long ago. An install left on the `.env.template` default
# (DATABASE_URL="file:./dev.db") therefore has its live database replaced by that empty template
# on every update. The backup above is why this is survivable; it is not why it is acceptable.
#
# So before the reset, move such a database to data/, which is gitignored and which a hard reset
# never touches. It runs once per install and skips silently everywhere else: Docker
# (/data/prod.db), install.sh (absolute data/prod.db) and any other absolute path are untouched.
# Nothing is deleted — the copy is verified before .env is repointed, and the old file is left for
# the reset to overwrite.
if [ -f scripts/relocate-sqlite.mjs ]; then
  echo "[update] checking whether the database sits inside the repository..."
  node scripts/relocate-sqlite.mjs || { echo "[update] database relocation FAILED — nothing was changed"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }
fi

# ─── rollback ──────────────────────────────────────────────────────────────────────────────
# Everything before this point either changed nothing (fetch) or is additive and safe to leave
# (backup, relocation). From the reset on, a failure must not leave the instance half-updated:
#
#  - the CODE goes back to the commit the running app was built from — /api/system/version reads
#    `git rev-parse HEAD`, so a tree left on the new commit would tell the UI "up to date" while
#    the old build is still serving, and the update banner would never come back;
#  - dependencies are reinstalled for that commit if the new install already ran;
#  - if the app was already stopped for the build, the PREVIOUS build (.next.prev) is put back
#    and the app is started again. Without this a failed build left the instance down until
#    someone with SSH fixed it — fatal for an update started from the UI, where the owner sees
#    only a spinner and has no shell.
#
# The schema push is NOT rolled back: db push only applies additive changes here, and the old
# code runs against a superset schema. The pre-update backup is the way back if that is ever wrong.
PREV_HEAD="$(git rev-parse HEAD 2>/dev/null)"
DEPS_TOUCHED=0
APP_STOPPED=0

restart_app() {
  pm2 restart opengsc || pm2 restart all || echo "[update] pm2 restart failed — restart manually"
}

fail_and_rollback() {
  echo "[update] $1 FAILED — rolling back"
  if [ -n "$PREV_HEAD" ] && [ "$(git rev-parse HEAD 2>/dev/null)" != "$PREV_HEAD" ]; then
    if git reset --hard "$PREV_HEAD" >/dev/null 2>&1; then
      echo "[update] code rolled back to ${PREV_HEAD:0:7}"
      if [ "$DEPS_TOUCHED" = "1" ]; then
        echo "[update] reinstalling dependencies for ${PREV_HEAD:0:7}..."
        npm i --include=dev >/dev/null 2>&1 || echo "[update] dependency reinstall FAILED — the previous build may still run; check: npm i"
      fi
    else
      echo "[update] code rollback FAILED — tree left at $(git rev-parse --short HEAD 2>/dev/null)"
    fi
  fi
  if [ "$APP_STOPPED" = "1" ]; then
    if [ -d .next.prev ]; then
      rm -rf .next && mv .next.prev .next && echo "[update] previous build restored"
      echo "___OPENGSC_UPDATE_FAIL___"
      echo "[update] starting the previous version again..."
      restart_app
      exit 1
    fi
    echo "[update] no previous build to restore — the app stays STOPPED; fix the cause, then: bash update.sh"
  fi
  echo "___OPENGSC_UPDATE_FAIL___"
  exit 1
}

echo "[update] git reset --hard origin/main..."
git reset --hard origin/main || fail_and_rollback "git reset"

echo "[update] npm install..."
# --include=dev is not optional here, and the reason is easy to miss.
#
# When this script is launched from the UI it is a child of the running Next server, which has
# NODE_ENV=production. npm reads that and quietly installs dependencies only. Tailwind, its
# PostCSS plugin and TypeScript all live in devDependencies, so the install "succeeds" and the
# build then dies on the first stylesheet with "Cannot find module '@tailwindcss/postcss'" —
# a message that points at the CSS and says nothing about the install that caused it.
#
# Running the same script by hand in a shell works, because there NODE_ENV is usually unset.
# That difference is what made this look like a Windows problem rather than an env one.
DEPS_TOUCHED=1
npm i --include=dev || fail_and_rollback "npm i"

# npm can finish successfully and still leave an install the app cannot run: under npm 12 a
# dependency's build script is skipped unless the exact version is listed in allowScripts, and a
# better-sqlite3 that never built is only discovered at boot. Checked here so the message names
# the cause, instead of the build or the first request doing it much less clearly.
node scripts/check-native-deps.mjs || fail_and_rollback "dependency check"

# Only runs when the pre-reset backup could not: an install updating from a version that
# predates scripts/backup-sqlite.mjs. The schema must never change without a verified copy.
if [ "$backed_up_before_reset" != "1" ]; then
  echo "[update] backing up SQLite..."
  timeout 600 node scripts/backup-sqlite.mjs || fail_and_rollback "database backup (schema was not changed)"
fi

echo "[update] prisma db push..."
# Prisma 7 removed --skip-generate from db push (generate is a separate step and already ran
# in npm's postinstall), so a plain push is the whole call. The old ||-fallback kept the run
# alive but printed a usage error on every update.
npx prisma db push || fail_and_rollback "prisma db push"

# The Turbopack build peaks around 2.4 GB of memory (issue #21) — updates hit the same
# OOM wall as installs on small boxes, so swap is ensured here too. The reset above has
# already delivered this file to the working tree.
source scripts/ensure-build-swap.sh
ensure_build_swap

# The build erases .next before writing the new one, so an app left running crash-loops
# through the entire build window — nginx answers 502 and pm2 burns restarts on a server
# that cannot start. Stopped first, started after: the window is exactly as long, but it
# is quiet instead of on fire. (Same fallback chain as the restart below.)
echo "[update] stopping the app for the build window..."
pm2 stop opengsc >/dev/null 2>&1 || pm2 stop all >/dev/null 2>&1 || echo "[update] pm2 stop failed — continuing"
APP_STOPPED=1

# A build that dies mid-write (panic, OOM, kill) can leave a partial .next behind, and the
# next Turbopack run has been observed to panic on top of that state ("generate_source_map
# was canceled") even though the same code builds cleanly from scratch. The build erases
# .next itself on a normal path; this only guarantees the START is clean when it isn't.
#
# The current build is MOVED aside, not deleted: if this build fails, fail_and_rollback puts it
# back and starts the app again, so a failed update costs the build window and nothing more.
rm -rf .next.prev
if [ -d .next ]; then mv .next .next.prev; fi

echo "[update] npm run build..."
npm run build || fail_and_rollback "build"

# Mark success BEFORE the restart — pm2 restart kills this process's parent shell context,
# so the UI must be able to see the done marker in the log even if the restart truncates output.
echo "___OPENGSC_UPDATE_DONE___"
echo "[update] restarting PM2 process..."
restart_app
rm -rf .next.prev
}

main "$@"
exit $?
