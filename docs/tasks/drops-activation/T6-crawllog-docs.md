# T6 — Crawl-log ingest + docs + release housekeeping

## Files (exclusive ownership)

- `src/lib/drops/crawlLog.ts` (+ `crawlLog.test.ts`) — NEW.
- `src/app/api/drops/activation/[domain]/crawl-log/route.ts` — NEW.
- `docs/DROPS-ACTIVATION.md` — NEW runbook.
- `README.md`, `README.ru.md` — module section (edit together — house rule).
- `CHANGELOG.md` — entries under `[Unreleased]`.
- Register the test in `package.json` `test:unit`.

## Crawl log (`POST …/crawl-log` `{ log: string }`)

Manual upload is the honest crawl measure for now (no scheduler, no auto-recheck —
deliberate phase-2 cut). Parse a pasted access log (nginx combined / common format is
enough; be liberal):

- Googlebot lines = user agent contains `Googlebot` (case-insensitive) AND, when the
  log has a forward-DNS-ish bot name pattern, keep it simple: UA match only, but
  count only requests with HTTP status < 400 on URLs of the asset host.
- Output: `{ hitsTotal, hits7d, lastHitAt }` — 7d window computed via UTC midnights
  (`utcMidnightDaysBetween` from T0), then `recordCrawlLog`.
- Unknown/garbage lines are skipped and counted in `{ skipped }`; never a 500.

## Runbook (`docs/DROPS-ACTIVATION.md`)

Operator-facing, EN (docs stay English). Sections:

1. Pipeline overview: harvest → bundle → host → GSC submit → IndexNow → donors →
   measure via log upload.
2. **nginx order** with the literal snippet: `/robots.txt`, `/sitemap.xml`,
   `/{key}.txt` served as files BEFORE the catch-all 301 — after it they redirect
   away and IndexNow rejects the push silently (the #1 "done but no effect" cause).
3. GSC: add-property is manual (verification cannot be automated through the API);
   then `gsc-submit` from the UI.
4. Doorway eligibility: threshold semantics, today's live numbers (3/13), and that
   the list recomputes per run.
5. Footprint rule: donors only, never the asset — why, in one paragraph.

## Release housekeeping

- README.md + README.ru.md: short module section each (same content, both languages).
- CHANGELOG.md under `[Unreleased]`: activation module, verdict-counter fix (T1),
  new models. Note the deploy needs `db push` + `npx prisma generate`.
- Do NOT bump package.json version (release is a separate wave per house procedure).

## Acceptance

- Log parser tests: combined-format fixtures incl. a non-Googlebot line, a 404, a
  foreign-host URL, a line at 23:30 UTC vs 00:30 next day (7d boundary via UTC).
- READMEs differ only in language; CHANGELOG scoped to this wave.
- `npm run check` + `npm run test:unit` green.
