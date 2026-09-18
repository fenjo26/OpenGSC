# Drops Activation — task wave

Re-activation of **acquired** drop domains. The drops funnel ends at `stage = "acquired"`
(`prisma/schema.prisma`, `DropCandidate`); this wave picks up there: harvest the domain's
legacy URLs, build the deploy bundle (sitemap / robots / IndexNow key), submit the sitemap
to GSC, push IndexNow, and accelerate re-crawl through the indexer network — which links to
**donor pages, never to the asset**.

Priorities, in order (deliberate, from the operator):

1. **Legacy-URL crawl via sitemap + GSC** (T2) — the main channel. Google reads sitemaps
   and GSC; it does **not** read IndexNow.
2. **IndexNow** (T3) — honestly scoped to Bing/Yandex. No UI copy may imply Google.
3. **Donors via the doorway network** (T4) — an accelerator, not the primary channel.

## Order and ownership

| Task | Scope | Owns (exclusive) |
| --- | --- | --- |
| T0 | Foundation: Prisma models, pure helpers, store, acquired→asset hook | `prisma/schema.prisma`, `src/lib/drops/activation.ts`, `src/lib/drops/activationStore.ts`, `src/lib/drops/activation.test.ts`, `package.json` (test registration), one hook call site |
| T1 | Verdict desync fix (8/19 vs 2/25) | `src/lib/drops/store.ts` (`recordAvailabilityResults` only), `src/lib/drops/availability.test.ts` |
| T2 | Legacy URL harvest + sitemap bundle + GSC submit | `src/lib/drops/legacyUrls.ts` (+ test), `src/app/api/drops/activation/[domain]/harvest/route.ts`, `.../bundle/route.ts`, `.../gsc-submit/route.ts` |
| T3 | IndexNow push per asset | `src/lib/drops/indexnowPush.ts` (+ test), `src/app/api/drops/activation/[domain]/indexnow/route.ts` |
| T4 | Donor accelerator (doorway selection + queue injection) | `src/lib/drops/donors.ts` (+ test), `src/app/api/drops/activation/[domain]/donors/route.ts`, `.../run-donors/route.ts` |
| T5 | UI tab «Активация» in /drops | `src/app/drops/page.tsx`, `src/components/drops/ActivationPanel.tsx`, `src/lib/i18n/**` locale files |
| T6 | Crawl-log ingest + docs + release housekeeping | `src/lib/drops/crawlLog.ts` (+ test), `src/app/api/drops/activation/[domain]/crawl-log/route.ts`, `docs/DROPS-ACTIVATION.md`, `README.md`, `README.ru.md`, `CHANGELOG.md` |
| R | Review pass over the merged wave | reads everything, edits only what fail findings name |

## Sequencing

- **T0 first, alone.** Until it merges, T2–T6 collect a predictable set of `TS2339`
  ("Property 'dropAsset' does not exist on type PrismaClient" etc.) and missing-module
  errors — expected, see `R-review.md` for how to tell them from real breakage.
- **T1 second** (independent of T0 in logic, but lands after to keep `store.ts` edits
  disjoint in time).
- **T2–T6 in parallel** after T0+T1 merge. Ownership above is exclusive: a task never
  edits a file it does not own. Shared surface (models, store signatures, helpers) comes
  fully formed out of T0 via `CONTRACT.md` — if a tail task genuinely needs a store
  function that is not there, it stops and flags; it does **not** edit `activationStore.ts`.

## Hard rules (burned into CONTRACT, repeated here)

- **The network never links to the asset.** Doorways enqueue **donor** URLs only.
  `isDonorAllowed()` rejects any URL whose host is the asset domain, and the runner
  re-checks before every write. The footprint «дорвей → наш домен» must not exist.
- **Doorway eligibility = confirmed Google crawl**, read fresh from `IndexerDailyStat`
  per run. Threshold is the constant `GOOGLE_CRAWL_MIN_HITS` (default 1000 hits / 30d —
  today that selects exactly 3 of 13 domains; a literal `> 0` would select 10, including
  domains Google touched 4–7 times in a month). No hardcoded domain lists.
- **Day math via UTC midnight** (`utcMidnightDaysBetween`). The local-calendar version in
  `src/lib/drops/wayback.ts:36-39` already cost a day of drift Athens-vs-UTC — do not
  re-derive it.
- **nginx rules before the catch-all 301** on the asset host: `/robots.txt`,
  `/sitemap.xml`, `/{indexnow-key}.txt` must be served as files *before* the redirect,
  or IndexNow rejects the push silently. The generated bundle carries the snippet;
  the runbook (`docs/DROPS-ACTIVATION.md`, T6) shows the exact order.

## Out of scope (phase 2, do not build)

Scheduled auto-recheck of crawl (manual log upload is the honest measure until we know
what we are measuring), auto-purchase, a numeric toxicity score, MCP tools for
activation, digest/alert integration.
