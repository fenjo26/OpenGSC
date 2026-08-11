#!/bin/sh
set -e

if ! node -e 'const v=process.env.OPENGSC_EXPECTED_OWNER_EMAIL; if (typeof v!=="string" || v.length>254 || v.trim()!==v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) process.exit(1)'; then
  echo "[opengsc] OPENGSC_EXPECTED_OWNER_EMAIL must be a valid email address" >&2
  exit 1
fi

# Create/migrate the SQLite schema on every start — `prisma db push` is idempotent
# and is how OpenGSC applies schema changes on updates (same as the VPS install).
echo "[opengsc] applying database schema to $DATABASE_URL ..."
npx prisma db push --skip-generate

echo "[opengsc] starting Next.js ..."
exec npm start
