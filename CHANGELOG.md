# Changelog

All notable changes to OpenGSC. Dates are release dates; the version shown in
**Settings → System** comes from `package.json`.

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
- **CSV import** (`SEO Tools → Import metrics`) — the free path. Upload an Ahrefs/Semrush export
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

- **Metrics settings were not backed up.** The API key matched the sync rules and survived a
  restore, but the access mode and host did not — so a reseller key came back pointed at the
  official API, with the mode silently showing "official" and every request failing 401. The
  whole `seoMetrics*` group is now part of the snapshot, and a test asserts that any future
  setting written by this layer is covered.
- The metrics screen now shows the host a key will be sent to, directly under the field.
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
