# Changelog

All notable changes to OpenGSC. Dates are release dates; the version shown in
**Settings → System** comes from `package.json`.

## [Unreleased]

### Added

**Demand — a new tool** (`/seo-tools/demand`)

Keyword discovery, which is the one thing Search Console structurally cannot do: every other
screen starts from queries the site already appears for, and this one starts from the market.

- **By keyword** — a seed goes to DataForSEO Labs and returns volume, difficulty, CPC, intent
  and a 12-month trend, then every row is verdicted against the site's own GSC history: *within
  reach* (top 30 — improve that page), *wrong page* (impressions but nothing winning), *no
  content* (write it). The join reuses the logic already proven in the Competitors screen.
- **By domain** — estimated organic traffic, keyword count, position-band distribution, ranking
  keywords ordered by the traffic they bring, and the pages carrying them. Works on any domain,
  not only a connected one; comparing against one of your sites is optional.
- **Three discovery modes** (`related` / `suggestions` / `ideas`) plus `auto`, which walks them
  in order and stops at the first source with enough terms rather than merging all three —
  each source is a separate charge and the overlap is mostly duplicates.
- **Google Ads fallback** for the ~120 countries DataForSEO Labs does not cover. Those rows
  carry no difficulty and no intent, and the UI says so rather than rendering empty columns.
- Runs on the **existing** `seoKey_dataforseo` credential — no new provider to configure.
  Without it the tab still shows whatever is already stored.
- Searches cached 14 days, domain overviews 7. Prices shown before the click, monthly cap
  enforced server-side, clickstream refinement opt-in and labelled with its 2× cost.
- Discovered keywords are written to the shared `KeywordMetricCache`, so weights appear in
  Striking Distance and Rank Tracker without paying twice for the same number.

**Brand visibility in AI answers** — a second source inside the AEO Tracker

- A panel under the live citation table, reading DataForSEO's LLM Mentions index: how often the
  brand comes up in AI answers, in which questions, and which of its pages get cited.
- **Share of voice** against up to 9 competitors in one call — the number the live tracker
  structurally cannot produce, because it only ever asks on your own behalf and has no way to
  know how often a competitor was named instead.
- Matching by **domain** (answers that linked to you) or by **brand name** (answers that named
  you without linking) is an explicit choice, since the two return different numbers.
- Kept as a separate panel rather than merged into the table above. The table is a live check on
  your own keys, today, for questions you chose; this is an index refreshed roughly monthly,
  covering questions you never thought to track. It also covers ChatGPT and Google AI Overview
  only — Claude and Grok exist in the live tracker alone, and a zero here is not evidence of
  invisibility there.
- Cached 7 days, priced before the click, same monthly cap as the rest of the DataForSEO surface.

**MCP** — two tools, bringing the registry to 40

- `get_keyword_demand` (local, free) — stored research joined against GSC positions; with no
  seed, an index of what has already been researched.
- `research_keywords` (**paid**) — discovery from a seed, gated behind `confirm: true`. The
  third paid tool and the only synchronous one: its result is written to the cache before the
  tool returns, so an abandoned call still leaves a search that replays for free.
- New agent skill `keyword-research` in `.agents/skills/`.

### Changed

- **Competitors moved into SEO Tools** (`/seo-tools/competitors`), next to Demand. Both buy
  data from outside the instance, which is the line SEO Tools draws — everything left in the
  main nav reads what OpenGSC already holds. Old URLs redirect.
- **Missing tables are now reported instead of looking like missing data.** Every route in the
  metrics layer catches an absent table and returns an empty result so the dashboard survives an
  un-migrated database — but that made "you have not loaded anything yet" and "the table does not
  exist" identical on screen. A banner now names the tables and the command
  (`GET /api/system/schema`, `SchemaBanner`).
- **The competitor keyword pull verifies its own write.** If keywords come back from the provider
  and the table still reads empty, the reply says so rather than succeeding silently — the
  signature of a relative `DATABASE_URL`, where the CLI and the running app resolve to different
  database files.

### Database

- New model `DemandSearch` (search cache). Run `npx prisma db push` after updating.

## [1.1.0] — 2026-07-30

The headline is a new **metrics layer**: search volume, keyword difficulty, backlink profiles
and competitor keyword gaps, brought in from Ahrefs/Semrush and — more usefully — crossed with
your own Search Console data.

Nothing in this release is required. With no key and no imports, OpenGSC behaves exactly as it
did in 1.0: the free Domain Rating on dashboard cards is untouched, and every new column simply
shows an em dash.

### Added

**Metrics layer** ([docs/METRICS-SETUP.md](docs/METRICS-SETUP.md))

- **Keyword weights in Striking Distance and Rank Tracker** — volume, KD, CPC and a *Potential*
  column (what a keyword could bring near the top of page one, minus what it brings now), with
  sorting by opportunity instead of by current exposure. Impressions measure demand filtered
  through your visibility; volume measures the market.
- **Competitors** — a new section. Find competitors, pull one's keywords, and the join with your
  GSC data splits every row into three verdicts: *within reach* (you rank, improve the page),
  *wrong page* (impressions but nothing wins — intent mismatch), *no content* (write it).
- **Backlink profile** on the site Backlinks tab — referring domains live and lost, with stored
  history. Sits above the manual list rather than replacing it: one answers "what points at me",
  the other "did the link I built survive".
- **Demand column in Content Decay** — checks the page's top query's search-volume trend on
  request. Clicks falling with demand flat is a ranking problem; clicks falling *with* demand is
  the market, and no rewrite fixes that.
- **Domain health chip in the Indexer** — DR and referring domains per network domain, so a
  burnt drop is caught before you build on it.
- **Lost-backlink alert** — fires when a referring domain above a DR threshold disappears. Reads
  stored rows only, never calls a provider. Off by default.
- **CSV import** (`Settings → SEO Metrics`, and on each site's Settings tab) — the free path. Upload an Ahrefs/Semrush export
  and it fills the same cache the API does, so every feature above works with no key at all. The
  report type is detected from the column headers.
- **Four MCP tools** — `get_keyword_metrics`, `get_domain_metrics`, `get_backlink_profile`,
  `get_competitor_gap`, all in the `local` tier. They read and never fetch: an agent cannot
  spend your credits, and an empty result means "not loaded", never "zero".
- **Backlink profile on share links** — clients see the link graph read-only; the endpoint
  refuses to fetch for a share-token caller regardless of what is sent.

**Cost controls**, because this layer is the first one that spends money per row:

- Every button prices itself *before* it is pressed (units and ≈ USD).
- Keyword Difficulty is an opt-in checkbox — it roughly doubles the price per keyword.
- A monthly unit cap in settings; requests are priced server-side and refused above it.
- Nothing fetches on render. Loading is always an explicit action.

### Changed

- **Link Monitor** now honours the custom base URL from the metrics settings, so a single Ahrefs
  key works across the whole app instead of needing a second, official one.
- **Settings** — Ahrefs/Semrush keys moved out of *API Keys* and the *Indexing API* screen into
  their own **SEO Metrics** section, together with the access mode (official / reseller /
  custom gateway), host and spending cap. One integration was previously configured in three
  places; it is now configured in one.
- **Site Audit** fixes.
- **Content Rewriter** and the **AI-Fingerprint Lab / humanizer** in SEO Tools are now formally
  part of the release. They have been available for a while; 1.1 is where they are documented
  and supported rather than shipped quietly.
- Dashboard site cards can show referring domains and organic traffic beside Domain Rating when
  that data has been loaded.

### Fixed

- **One key cell was shared by every access mode.** A key typed under "Reseller" also appeared
  under "Official API", because both wrote to the same storage slot — so switching modes kept a
  key the new host would reject while the screen still read "Connected". Keys are now stored per
  mode, with the official one keeping its historical name so existing installs are untouched and
  a pre-existing gateway key still resolves.
- **Metrics settings were not backed up.** The key matched the sync rules and survived a restore,
  but the access mode and host did not, so they silently reverted to "official". The whole
  `seoMetrics*` group is now part of the snapshot.
- The metrics screen now shows the host a key will be sent to, directly under the field.
- **"No data in file" was misleading.** A header-only export — what Ahrefs produces when a filter
  or date range matches nothing — reported the same error as an unreadable file, so it read as
  "wrong format". It now says the report *was* recognised and that it simply has no rows.
- **SEO Tools tile grid was out of order** and missing an entry: the tab bar and the tile grid
  each held their own copy of the tool list. Both now render one shared array.
- The site picker in the import panel is searchable — a plain dropdown is unusable at a few
  hundred sites, let alone a thousand.
- Assorted bug fixes across the app.

### Upgrading

```bash
git pull
npm install
npx prisma db push   # seven new tables
npm run build
pm2 restart opengsc
```

`prisma db push` is required — the metrics layer adds `KeywordMetricCache`,
`DomainMetricCache`, `RefDomainRow`, `BacklinkSnapshot`, `CompetitorKeyword`,
`KeywordVolumeHistory` and `ApiUsage`. Every one of them is read through code that degrades to
an empty result if the table is missing, so a missed migration will not take a page down — it
will just look like nothing has been loaded yet.

## [1.0.0]

Initial public release.
