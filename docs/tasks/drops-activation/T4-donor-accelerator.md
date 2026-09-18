# T4 — Donor accelerator (doorway selection + queue injection)

Priority 3 of the wave — an accelerator, not the primary channel. The indexer network
links to **donor pages** (third-party pages that already link to the asset) so Google
re-crawls them and re-discovers their links to the drop. **The network never links to
the asset itself; the «дорвей → наш домен» footprint must not exist in any direction.**

## Doorway eligibility — verified live numbers (2026-09-18, 30d window)

Google actually crawls 3 of the 13 indexer domains: `deadp47.shop` (47 694 hits),
`carcolor.shop` (31 135), `juliet.autos` (27 698). After them: `best-phone.shop` (801),
`rapbattle.cfd` (635), then five domains at 4–7 hits, and three at zero
(`addons.top`, `hustla.top`, `tvshownow.top` — also listed in `neverCrawled`).

**Consequence:** a literal "google hits > 0" threshold selects 10 of 13 — wrong. The
threshold is `GOOGLE_CRAWL_MIN_HITS = 1000` over `DOORWAY_WINDOW_DAYS = 30`
(`activation.ts`, T0). The list is computed fresh from `IndexerDailyStat` on every run —
**no hardcoded domain list; it would rot within a month.**

## Files (exclusive ownership)

- `src/lib/drops/donors.ts` (+ `donors.test.ts`) — NEW.
- `src/app/api/drops/activation/[domain]/donors/route.ts` — NEW (PUT).
- `src/app/api/drops/activation/[domain]/run-donors/route.ts` — NEW (POST).
- Register the test in `package.json` `test:unit`.

## Behaviour

### `PUT …/donors` `{ urls: string[] }`

- `setDonors` (replace-all; throws on any URL failing `isDonorAllowed` — a donor ON
  the asset host is the exact footprint this wave forbids). No partial writes.
- Response `{ added, removed, total }` + the rejected list when validation fails
  (400 with `{ error: "donor_not_allowed", rejected: [...] }` — render the rule, not
  a generic 400).

### `POST …/run-donors` `{ minGoogleHits?, days? }`

- Doorways: `eligibleDoorways(userId, { minGoogleHits ?? GOOGLE_CRAWL_MIN_HITS,
  days ?? DOORWAY_WINDOW_DAYS })`.
- For each doorway × each stored donor URL: `addPlacements(userId, assetId, doorway,
  donorUrls)` — upserts placements AND enqueues `IndexerQueue` rows (the queue is the
  live injection mechanism the deployed doorway scripts already read).
- Response: `{ doorways: [{ domain, googleHits }], urlsEnqueued, placements, skipped: 0 }`
  — if no doorway qualifies, `{ doorways: [], ... }` with 200 and a hint that the
  threshold can be lowered per run (the operator decides; the constant stays the default).

## Acceptance

- `isDonorAllowed` tests: donor on asset host and its www → false; same registrable
  domain different scheme → false; genuine third-party → true.
- Runner test with a stubbed store: doorways below threshold never receive queue rows;
  a donor equal to the asset domain throws before ANY placement row is written.
- Enqueue is idempotent: running twice creates no duplicate `IndexerQueue` rows
  (`@@unique([domainId, url])`) and no duplicate placements, only `placedAt` refresh.
- `npm run check` + `npm run test:unit` green.
