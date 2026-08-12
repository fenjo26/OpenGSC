#!/bin/bash
# One-command updater — pulls the latest main, installs deps, migrates the DB, rebuilds,
# and restarts the PM2 process. Triggered from the UI (Settings → owner-only "Update" button,
# which spawns this detached and streams the log) or run by hand:  bash update.sh
#
# It cd's to its own directory so it works regardless of where it's invoked from.
set -o pipefail
cd "$(dirname "$0")" || exit 1

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

echo "[update] git reset --hard origin/main..."
git reset --hard origin/main || { echo "[update] git reset FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

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
npm i --include=dev || { echo "[update] npm i FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

# npm can finish successfully and still leave an install the app cannot run: under npm 12 a
# dependency's build script is skipped unless the exact version is listed in allowScripts, and a
# better-sqlite3 that never built is only discovered at boot. Checked here so the message names
# the cause, instead of the build or the first request doing it much less clearly.
node scripts/check-native-deps.mjs || { echo "[update] dependency check FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

# Only runs when the pre-reset backup could not: an install updating from a version that
# predates scripts/backup-sqlite.mjs. The schema must never change without a verified copy.
if [ "$backed_up_before_reset" != "1" ]; then
  echo "[update] backing up SQLite..."
  timeout 600 node scripts/backup-sqlite.mjs || { echo "[update] database backup FAILED — schema was not changed"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }
fi

echo "[update] prisma db push..."
npx prisma db push --skip-generate || npx prisma db push || { echo "[update] prisma db push FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

echo "[update] npm run build..."
npm run build || { echo "[update] build FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

# Mark success BEFORE the restart — pm2 restart kills this process's parent shell context,
# so the UI must be able to see the done marker in the log even if the restart truncates output.
echo "___OPENGSC_UPDATE_DONE___"
echo "[update] restarting PM2 process..."
pm2 restart opengsc || pm2 restart all || echo "[update] pm2 restart failed — restart manually"
