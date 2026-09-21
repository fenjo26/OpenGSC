#!/bin/sh
set -e

# Create/migrate the SQLite schema on every start — `prisma db push` is idempotent
# and is how OpenGSC applies schema changes on updates (same as the VPS install).
# No --skip-generate: Prisma 7 removed the flag and rejects it with "unknown or
# unexpected option", which under `set -e` killed the container on every startup
# (restart loop, reverse proxy "no available server"). Nothing is lost by plain
# `db push` — the client is generated at image build time via `npm ci` postinstall.
echo "[opengsc] applying database schema to $DATABASE_URL ..."
npx prisma db push

echo "[opengsc] starting Next.js ..."
exec npm start
