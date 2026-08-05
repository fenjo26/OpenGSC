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

echo "[update] prisma db push..."
npx prisma db push --skip-generate || npx prisma db push || { echo "[update] prisma db push FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

echo "[update] npm run build..."
npm run build || { echo "[update] build FAILED"; echo "___OPENGSC_UPDATE_FAIL___"; exit 1; }

# Mark success BEFORE the restart — pm2 restart kills this process's parent shell context,
# so the UI must be able to see the done marker in the log even if the restart truncates output.
echo "___OPENGSC_UPDATE_DONE___"
echo "[update] restarting PM2 process..."
pm2 restart opengsc || pm2 restart all || echo "[update] pm2 restart failed — restart manually"
