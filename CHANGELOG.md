# Changelog

All notable changes to OpenGSC. Dates are release dates; the version shown in
**Settings → System** comes from `package.json`.

## [1.2.2] — 2026-08-05

### Added

**Four new interface languages: French, Spanish, German, and Simplified Chinese**

The app now ships in seven languages instead of three. Pick any of them from the language switcher on the login screen or in **Settings → Preferences**; the choice also drives the language Telegram/Slack alerts and digests are written in.

- 🇫🇷 Français, 🇪🇸 Español, 🇩🇪 Deutsch, and 🇨🇳 简体中文 join 🇬🇧 English, 🇷🇺 Русский, and 🇺🇦 Українська.
- All 2,659 UI strings are translated for each new locale, with the same key coverage as the existing translations.
- Server-side notification templates (alerts and the daily/weekly digest) were translated too, so a French/Spanish/German/Chinese user gets their alerts in their language rather than silently falling back to English.
- The browser language is auto-detected on first visit for the new locales as well.

Terms that practitioners use in English stay in English across every language — **CTR**, **SEO**, **GSC**, **sitemap**, **canonical**, **Core Web Vitals**, and the like are not translated, because no working SEO specialist says them differently. Brand and product names (Google, Search Console, OpenGSC, Ahrefs, Telegram…) are left untouched.

## [1.2.1] — 2026-08-04

### Added

**Automatic sync on a schedule (Settings → Preferences)**

Pick an hour and the instance syncs Search Console once a day by itself, so the dashboard is
current before the working day starts instead of after a manual click and a twenty-minute wait.

The hour is stored in the operator's own time zone, not in UTC as the digest does it. The
setting is chosen against a working day — "ready before I sit down at ten" — and a UTC hour
drifts an hour away from that at every DST change, silently, at the one moment nobody is
watching. The browser fills the zone in on first save.

Due once per local day, from the configured hour onwards rather than only exactly at it: a
server that was restarting or mid-deploy at nine would otherwise skip the day entirely and leave
the dashboard a day stale with nothing to explain it. `lastRunAt` is written after the run, so a
run that dies halfway is retried on the next tick instead of counting as done. New
`src/lib/syncSchedule.ts` (settings and the due rule), `src/lib/syncScheduler.ts` (a fifteen
minute tick, same in-process pattern as the digest and rank schedulers) and
`User.syncSettings` — **run `npx prisma db push` after updating**, or the schedule saves nothing
and the feature stays off.

The schedule is stored per user, but `runGscSync()` is instance-wide: it walks every connected
Google account of every user. On a single-operator instance the distinction never surfaces; with
two operators the earlier hour wins and the second finds the day's run already done.

The stale "API keys have moved" card in Preferences is gone — the move it announced was two
releases ago.

### Changed

**Sync walks five sites at a time instead of one**

A sync of 200 properties took tens of minutes because sites were fetched strictly in sequence:
three Google calls each, at a second or two per call, one after another. Google is nowhere near
that conservative — Search Analytics allows 1,200 queries per minute per user and per site, and
a whole run of 200 sites is about 600 calls.

Sites now go through a pool of five. The three calls within one site stay sequential, and the
pool is deliberately small rather than unlimited: the binding constraint is not QPS but the load
quota, which is measured in ten-minute chunks and grows with the date range and with grouping by
page and query. A `quotaExceeded` reply now waits and retries — starting at twenty seconds,
since a one-second retry against a ten-minute bucket just fails again — instead of losing that
site's data for the run.

Progress is logged as one line per site rather than five as it goes, because interleaved lines
from five sites in flight are a log you have to reassemble by hand. The final line now carries
the elapsed time: `Done in 4m12s. sites=201 …`. That number is what settles the question the old
logs couldn't answer — "it's stuck" and "it takes twenty minutes" looked identical from the
browser.

**The Sync button no longer gives up before the sync does**

The page polled for fifteen minutes and then stopped, whatever the server was doing. A run
longer than that left the spinner switched off, the timestamp unwritten and the data arriving
minutes later with nothing to say so — indistinguishable from a sync that had failed and taken
the fresh data with it. The watcher now stops when the server says the run is over, and gives up
only on five solid minutes of no reply, which means "lost track", not "finished". Opening or
reloading a page mid-run picks the spinner back up rather than showing an idle button.

### Fixed

**Installs and updates now check that the install is usable, not just that npm exited 0**

npm 12 blocks a dependency's lifecycle scripts unless the root package lists that exact version
in `allowScripts`. better-sqlite3 builds its native binding in one of those scripts, so a
blocked install leaves the package on disk and unloadable: npm reports success, and the failure
turns up later at boot as a module that will not load. The pins are exact by design, which also
means a dependency bump silently stops matching them.

`scripts/check-native-deps.mjs` compares the pins against the lockfile and then loads
better-sqlite3 for real, because the comparison suggests a cause while the load is the thing
that actually matters. Run by `update.sh` and `install.sh` right after npm, so the message names
the problem instead of the build reporting something unrelated three minutes later.

**Bing sitemap submission no longer falls back to an endpoint that has been dead since 2022**

Submitting a sitemap to Bing without an API key tried `https://www.bing.com/ping?sitemap=`,
which Bing retired in 2022 after spammers abused anonymous submission. It answers 410 Gone, so
that path never did anything. It also hid the real failure: because the API call fell through to
the ping on any error, a wrong API key was reported as "Bing ping failed with status 410"
instead of InvalidApiKey.

The ping is gone. A key is now required, and its absence says so, along with the alternative
(list the sitemap in robots.txt). Errors from `SubmitSitemap` go through the same reader the
stats calls use, so InvalidApiKey and InvalidSiteUrl come back as themselves.

Unrelated but worth recording, since it prompted the check: Bing is retiring its SOAP and POX
endpoints on 31 August 2026. OpenGSC is unaffected — all five Bing calls already use
`api.svc/json/`.

**MySQL: the provider no longer has to be edited by hand after every update**

Reported in [#2](https://github.com/fenjo26/opengsc/issues/2). Prisma rejects `env()` in the
datasource provider, so running on MySQL meant editing `provider = "sqlite"` in
`prisma/schema.prisma` — a tracked file, which every `git pull` and every `update.sh` run (it
does `git reset --hard`) quietly reverted. The failure that follows is unhelpful: `prisma
generate` rebuilds the client for SQLite without complaint and the app dies later with "the
Driver Adapter `@prisma/adapter-mariadb` is not compatible with the provider `sqlite`", which
reads like a broken adapter rather than a file that changed underneath you.

`prisma.config.ts` is TypeScript and runs before the CLI reads anything, so it now picks the
schema itself: for a `mysql://` or `mariadb://` connection string it derives a copy with the
provider swapped and points the CLI at that. The copy sits beside the original — `output` in the
generator block resolves relative to the schema file, so a copy one directory deeper would
generate the client into the wrong place — is gitignored, and is rewritten on every CLI run, so
it cannot drift from the real schema. SQLite installs are untouched: same file, same path, no
copy made.

MySQL support is still unproven end to end; this only removes the trap that made it impossible
to keep testing across updates.

**"Last synced" could roll backwards after a page reload**

The timestamp under the Sync button lived only in `localStorage`, written one line after the
React state update and inside a promise chain that ended in an empty `.catch()`. When
`localStorage.setItem` threw — a full store is the usual reason — the label showed the correct
time until the page was reloaded, then reverted to whatever was written last time it worked.
Nothing was logged, so it looked exactly like a sync that had silently failed and taken the
fresh data with it, which is a bad thing for a dashboard to imply when the data is in fact
there.

The label now comes from the server, which already recorded it: `runGscSync` stores
`completedAt` and GET `/api/gsc/sync` returns it. `localStorage` stays as a fallback for the
one case the server can't answer — the result is held in memory, so a restart forgets it — and
a failed write now says so in the console instead of vanishing. The completion time also comes
from the server rather than from `new Date()` at the moment the browser noticed, which was up
to one 15-second poll late. New `src/lib/syncedAt.ts`, used by both the dashboard and the site
page, which had their own copies of the same logic.

**`npm run build` failed with "adapter-mariadb is not installed" on machines that had it**

Reported in [#2](https://github.com/fenjo26/opengsc/issues/2), where the build claimed the
package was missing seconds after `prisma db push` had used it to create the schema.

The adapter's package name is assembled at runtime so a SQLite install — every install today —
isn't asked to carry a MySQL driver. That keeps the name away from the bundler's static
analysis, but the `require` doing the loading was still *the bundler's*: inside a Turbopack
chunk a non-literal specifier throws `Cannot find module as expression is too dynamic` whether
the package is installed or not, and the `catch` around it reported that as "not installed".
The build was telling people to install something it had no way of loading.

The load now goes through `createRequire` from `node:module`, which is Node's own resolver and
looks at `node_modules` on disk rather than at the chunk graph. The failure message no longer
claims "not installed" either — it prints the underlying resolver errors, since that claim was
wrong in the first case that actually occurred. SQLite installs are unaffected: the MySQL branch
is still only reached when `DATABASE_URL` names MySQL or MariaDB.

This fixes the *build*. Running OpenGSC on MySQL is still unproven — the schema's provider is
fixed to `sqlite`, and no one has yet run the app against a MySQL server.

**MCP `get_capabilities` reported a stale version**

It returned a hard-coded `1.1.0`, a release behind what Settings → System showed. It now reads
`package.json`, so there is one version string to bump instead of two.

## [1.2.0] — 2026-08-03

### Added

**AI Crawlability check (Site Audit)**

A site-wide companion to the page-level audit that answers the one question GEO Audit and the
AEO Tracker can observe but never explain: *why* is an AI engine not crawling/citing the site.
Runs automatically with every audit (no separate button) and reports, per AI crawler
(GPTBot, OAI-SearchBot, PerplexityBot, ClaudeBot, Google-Extended, CCBot, Bytespider), whether
the bot is allowed/blocked/unknown under a root `Disallow: /` in `robots.txt`, plus whether
`/llms.txt` exists. A root block on GPTBot is a silent reason ChatGPT never cites the site;
this surfaces it as a fixable lever. Stored in the audit summary's `aiCrawlability` key
(free-form JSON, no migration). `src/lib/audit/aiCrawl.ts`.

**JS-rendered page detection (Site Audit)**

New `js_rendered` issue: flags pages whose raw HTML is a near-empty JS app shell (low text +
≤1 internal link + a SPA marker / large bundled script). On such pages `thin_content` and
`h1_missing` are suppressed — they describe the empty shell, not the rendered DOM, and would
send a user to fix content that exists. The flag is informational (blue), not a fault. Keeps
the audit dependency-free (detection via HTML signals, no headless browser).

**Demand — growth sort & rising filter**

The 12-month trend sparkline is now a selection criterion, not just decoration. A sort toggle
(Volume / Growth) and a "Rising only" checkbox surface growing markets that volume-sort would
bury — a niche growing +300% no longer ranks below a stagnant high-volume one. Growth is
last-3-months vs previous-3-months (smooths one-off spikes).

**Global Privacy Blur**

The Privacy Blur toggle now reaches the components it used to silently skip
(KeywordCannibalization, StrikingDistanceKeywords, ContentDecayMap, DemandDomain,
BacklinkProfile, demand/links pages). Driven by a CSS class (`.privacy-sensitive` /
`.privacy-blur-all`) gated on a `data-privacy` attribute on `<html>`, so new tools opt in by
adding a class to their table — one toggle, no per-component React subscription.

**Global Layout toggle (Wide/Default)**

The Wide/Default layout toggle now actually works on the dashboards it used to ignore
(main dashboard, SEO Tools, Indexer, Site Audit). Previously each set its own hardcoded
`maxWidth` (1600px / 1280px / 1400px) that overrode the toggle. Now all read
`--page-max-width` / `--page-padding` CSS variables that the toggle sets on `:root`.

### Changed

**Backlinks liveness — retry & "blocked" status**

`check-alive` was a single fetch: a 5xx blip or a Cloudflare WAF 403 marked a live link dead.
Now retries transient failures (429/408/5xx/network) up to 3× with backoff, and a 401/403/429
hiding the page is recorded as a separate `blocked` status (not dead). `isAlive` maps
blocked → null (unknown) for back-compat. New `aliveStatus` column on `Backlink`
(`prisma db push` to apply).

**Core Web Vitals — INP replaces FID**

FID (First Input Delay) was retired as a Core Web Vital in March 2024. The health check now
pulls `interaction-to-next-paint` (INP) instead of the deprecated `max-potential-fid` audit,
with the INP "good" threshold (≤200ms). Existing snapshots still render; a fresh check
populates INP.

**Site dashboard i18n — ~60 hardcoded strings localized**

The site detail page (`/site/[id]`) had ~60 user-facing strings hardcoded in English (plus two
Russian strings leaking into all locales): period labels, dimension/filter names, operation
types, status messages, country names. All now run through `t()`; country names use
`Intl.DisplayNames` so ~80 names translate without per-country keys. Also fixed a real bug: a
loop variable `t` in `ClusterTable` shadowed the translation function, so its tab labels never
translated.

**Removed: dead `Sidebar.tsx`**

The `Sidebar` component was an orphan — imported nowhere, rendered nowhere, its toggles
(Privacy/Dark/Layout) were non-functional local-state copies of the real ones in
`DashboardShell`. Deleted to remove the confusion (it looked broken but was simply never
mounted).

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

- **`src/middleware.ts` is now `src/proxy.ts`**, following the Next.js 16 rename. Same logic, but
  the runtime changes from Edge to Node.js (proxy's runtime is fixed and not configurable). The
  MCP token check stays in the route rather than moving into the gate: the obstacle that forced it
  out was Prisma's incompatibility with Edge, but the gate runs on every request to every path,
  and a database lookup there to serve one endpoint is not worth it.
- **All upserts go through one builder** (`src/lib/db/upsert.ts`) instead of 15 hand-written
  statements. Behaviour is unchanged — the `COALESCE` guards, the freshness check and the
  accumulating counters are declared rather than repeated — and adding a second SQL dialect is now
  one function. `scripts/check-upsert-sql.ts` prints and checks the generated statements.
- Quieter output: the Prisma client no longer logs its database path on every boot and build
  (set `DEBUG_PRISMA=1` to bring it back — it is the fastest way to diagnose an app and a CLI
  pointing at different files). The MCP SQL tool's dynamic imports are marked `turbopackIgnore`,
  which removes the "Encountered unexpected file in NFT list" build warning.

### Fixed

- **Google algorithm update markers on the site chart.** Two independent reasons they never
  appeared. The list of updates was hardcoded and stopped at March 2026, so recent windows had
  nothing to draw; updates now come from Google's own feed
  (`status.search.google.com/incidents.json`) via `/api/gsc/algo-updates`, merged with the built-in
  list and cached for an hour, falling back to the built-in list when the feed is unreachable. And
  markers were positioned by a computed label string, which Recharts silently drops when no data
  point carries that exact label — a daily gap in Search Console was enough to erase a marker.
  They now snap to the first real point on or after the update date.
- **The Updates view in the Annotations tab did nothing.** `viewMode` was read only to colour the
  two buttons, so switching to Updates left the same list of notes on screen. It now scores
  Google's update dates through the same before/after pipeline as a hand-written note, so you can
  see where a site went after each one.
- **Annotations no longer opens on invented data.** The tab blurred itself and displayed four
  fabricated notes from 2024 before the real ones had loaded. The fake rows are gone, and the
  onboarding panel waits until the request comes back genuinely empty.
- **Indexing tab: "auto" is now the default doorway target.** The queue endpoint always understood
  `all` (round-robin across every doorway), but the site page offered no such option, and its
  select started with empty state while the browser displayed the first domain — so Submit
  answered "choose a domain first" about a domain that was visibly selected.
- **Indexer queue: you can tell which site a row belongs to.** The two columns were "Domain" and
  "URL Path" and both concern domains: the first is the doorway hosting the link, the second had
  its host stripped. Now "Doorway" and "Target URL", with the target's host shown.

- **Node.js 24 (Active LTS) instead of Node 20.** `install.sh` and the Dockerfile both pinned
  Node 20, which reached end of life on 30 April 2026 and no longer receives security patches —
  so every fresh install was landing on an unmaintained runtime. `package.json` now declares
  `engines.node >= 22.12`, which it never did, so npm can say something about it.

  **Existing installs:** upgrading the runtime is not automatic. Install Node 22 or 24, then
  `npm rebuild better-sqlite3` — it is a native module compiled against the running major, and
  skipping the rebuild makes the app fail on start.

- **Install scripts are now allow-listed** (`allowScripts` in `package.json`). npm 11 warns about
  unreviewed install scripts and npm 12 blocks them by default; without the list, `better-sqlite3`
  would silently skip its native build and the app would fail on first database access. The six
  entries are the packages whose install script *is* their installation — native binaries and
  Prisma engines. The list is version-pinned by npm's own design, so bumping any of them brings
  the warning back for a fresh review, which is the point.

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
