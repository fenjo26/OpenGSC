# Verifying an OpenGSC install on MySQL / MariaDB

> **Experimental and unsupported.** SQLite is the only fully supported production database for
> OpenGSC. This document helps contributors investigate a future MySQL/MariaDB port; passing these
> checks does not imply feature parity. Raw MCP SQL, timestamp coercion, composite-key limits and
> several hand-written SQL paths still need dialect-specific work. Do not migrate a production
> instance away from SQLite without a tested backup and rollback plan.

Everything else in the app is a plain read or a plain overwrite: if a statement runs at all on your
server, it is right. Three writes are not, and those three are the whole reason a MySQL port needs
a human. They are the ones that fail *quietly* — no error, no red banner, just a number that is
wrong later:

1. **keep** — a partial refresh must not erase a value that is already stored
   (`COALESCE(incoming, stored)`).
2. **onlyIfNewer** — an export generated three weeks ago must not overwrite fresher data
   (`WHERE incoming.checkedAt >= stored.checkedAt`). MySQL has no conditional
   `ON DUPLICATE KEY UPDATE`, so this one is translated rather than ported, and it is the one with
   a trap: MySQL applies assignments left to right, so if `checkedAt` were written before the other
   columns, every guard after it would compare against the value just written, pass, and stop
   existing.
3. **add** — counters accumulate rather than replace (`units = units + incoming`).

There are two ways to check them. Route A takes a minute and needs nothing but a connection
string. Route B is slower but exercises the real HTTP path through the app, so it is worth doing
once as well.

---

## Route A — the self-test script (start here)

Run it from the project directory, the one holding your `.env`:

```bash
npx tsx scripts/verify-upsert-live.ts
```

On Windows, same command in PowerShell. Inside Docker it has to run in the container, which
already has the connection string in its environment:

```bash
docker compose exec opengsc npx tsx scripts/verify-upsert-live.ts
```

If `tsx` is missing, the install skipped dev dependencies: `npm install --include=dev`.

The first two lines of output are the database it actually connected to (password masked) and the
dialect it derived from it. Read them before reading the results — a run against the wrong database
is the one way this script can mislead you, so check that line says what you expect. If
`DATABASE_URL` is not set at all it refuses to run rather than falling back to a local SQLite file
and reporting success; to point it somewhere explicitly:

```bash
DATABASE_URL='mysql://user:pass@host:3306/db' npx tsx scripts/verify-upsert-live.ts
```

```powershell
$env:DATABASE_URL='mysql://user:pass@host:3306/db'; npx tsx scripts/verify-upsert-live.ts
```

It then runs all three behaviours against your server and prints PASS/FAIL per assertion. It writes rows under reserved keys
(`keyword = __opengsc_selftest__`, `provider = __selftest__`) and deletes them again on the way
out, on success and on failure. Your data is not touched.

Exit code 0 means all three behaviours work on your database. A stack trace instead of PASS/FAIL
means MySQL refused a statement outright — paste it as is, the server's own message is more useful
than anything downstream of it.

This does not need a Search Console site, keywords in positions 11-20, or a paid Ahrefs/Semrush
key. That is the point: none of those have anything to do with a database port.

---

## Route B — through the app

### B1 and B2: keep, and onlyIfNewer

The CSV importer writes into exactly the same cache the paid API path fills, so both behaviours can
be triggered for free with two small files.

**Where:** Settings → **SEO Metrics** (`/settings?tab=metrics`), bottom section, **Import metrics
from a file**. The same panel also appears on a site page under its Settings tab.

**Important:** the freshness guard uses the *file's own modification date*, not the moment you
upload it — an export describes the day it was generated. So the two files must have deliberately
different timestamps, and creating them by hand in a text editor will give them both today's date.

Create them like this.

PowerShell:

```powershell
"Keyword,Volume,KD`nopengsc mysql test,1000,42" | Set-Content -Encoding utf8 full.csv
"Keyword,Volume`nopengsc mysql test,1200"       | Set-Content -Encoding utf8 partial.csv
"Keyword,Volume,KD`nopengsc mysql test,7,7"     | Set-Content -Encoding utf8 stale.csv

(Get-Item full.csv).LastWriteTime    = (Get-Date).AddDays(-2)
(Get-Item partial.csv).LastWriteTime = (Get-Date).AddDays(-1)
(Get-Item stale.csv).LastWriteTime   = (Get-Date).AddDays(-30)
```

bash:

```bash
printf 'Keyword,Volume,KD\nopengsc mysql test,1000,42\n' > full.csv
printf 'Keyword,Volume\nopengsc mysql test,1200\n'       > partial.csv
printf 'Keyword,Volume,KD\nopengsc mysql test,7,7\n'     > stale.csv

touch -d '2 days ago'  full.csv
touch -d '1 day ago'   partial.csv
touch -d '30 days ago' stale.csv
```

Then, three times over: pick **Source = Ahrefs**, choose the file, leave **Keyword market** alone
as long as you keep it the same for all three, press **Import**.

Each import should answer `keyword report · 1 rows · 1 saved`.

> `0 saved` is itself a finding, and the most likely one on a first MySQL run: it means the row was
> rejected by the database and the error was swallowed per row on purpose (a cache miss is
> recoverable in production, a crash is not). Route A turns the same failure into a real message.

After each import, read the row back — the app has no screen that shows a single cache entry, and
`execute_sql_query` in the MCP server is SQLite-only, so use your MySQL client:

```sql
SELECT volume, difficulty, source, checkedAt
  FROM KeywordMetricCache
 WHERE keyword = 'opengsc mysql test';
```

| after            | volume   | difficulty       | why                                        |
|------------------|----------|------------------|--------------------------------------------|
| `full.csv`       | 1000     | 42               | first write                                |
| `partial.csv`    | **1200** | **still 42**     | newer, but has no KD column — keep         |
| `stale.csv`      | **1200** | **still 42**     | 30 days old — the whole row loses          |

If difficulty becomes `NULL` after the second import, `keep` is wrong. If volume becomes `7` after
the third, the freshness guard is wrong — most likely the assignment-order trap above.

Clean up with `DELETE FROM KeywordMetricCache WHERE keyword = 'opengsc mysql test';`

### B3: counters accumulate

This one needs a site connected to Search Console and any non-empty string in the API key field.
The key does not have to be real and no money can be spent: units are recorded *before* the
request is sent — a cap that notices an overspend afterwards is not a cap — so a bogus key
increments the counter and then fails at the provider.

1. Settings → SEO Metrics → `3 · API key`, put anything in the key field.
2. Open **Striking Distance** (`/striking`) and press **Load weights** in the toolbar. It will
   report a failure; that is expected.
3. Press it again.
4. Go back to Settings → SEO Metrics, section `4 · Spending`, and **reload the page** — the
   "Spent this month" figure is only fetched when that screen mounts.

It has to be the sum of the two attempts, not the last one. Remove the fake key afterwards.

If you have no site connected, skip this and rely on Route A, which covers the same write.

---

## Two things that are expected to bite, and are not your bug

**Composite keys are all strings.** All eight of them. Prisma maps `String` to `VARCHAR(191)` on
MySQL specifically to stay under the index limit, so `prisma db push` will pass — but a key value
longer than 191 characters will error at write time, and `DemandSearch.cacheKey` can grow.

**`execute_sql_query` (MCP) will not work.** It opens the SQLite file directly through
better-sqlite3 and takes its read-only guarantee from the engine. On MySQL that has to become a
user with `SELECT`-only grants instead, which is not written yet.

**Timestamps written through raw SQL are ISO strings** (`2026-08-05T12:00:00.000Z`). SQLite stores
them verbatim; MySQL has to coerce them into `DATETIME(3)` and, in strict mode, may refuse the
trailing `Z`. If Route A fails on all three checks at once with a datetime complaint, this is why —
and it is a one-line fix in the app, not something to work around on your side.
