# Changelog

All notable changes to OpenGSC. Dates are release dates; the version shown in
**Settings → System** comes from `package.json`.

## [1.4.1] — 2026-08-12

### Added

- **Competitor crawler** (`/crawler`, next to Digest). An X-ray of any site on the internet, run
  from inside your own console: technical state judged by the same rule registry as Site Audit,
  what the site is built with (CMS, framework, WordPress theme and plugin slugs, exposed usernames,
  reachable `xmlrpc.php`), where it is hosted (A/AAAA, nameservers, MX, CDN), how big it is
  (sitemap URL count, hreflang languages) and whether it lets AI crawlers in.

  The part a single-site checker cannot do: every scan stores the identity signals a site leaks —
  GA4, Universal Analytics, Tag Manager, AdSense, Yandex Metrica, Meta Pixel, Hotjar, Clarity,
  nameservers, IPs — and each new scan is matched against the ones before it. An analytics property
  or ads publisher id is billed to one person, so a match there is reported as strong evidence of
  shared ownership; a shared nameserver or IP only means a shared host and is marked weak. Redirect
  targets are recorded too, which is how a dropped domain merged into another shows itself.

  It also runs the Googlebot View comparison on every scan: the page is fetched a second time as
  Googlebot Smartphone arriving from a Google search and diffed against the browser view. A doorway
  that cloaks by User-Agent looks perfectly ordinary to a scanner that only identifies as itself,
  and this is what sees through it — different status, different final URL, different title or word
  count, or a site that refuses Googlebot outright.

  Ahrefs/Semrush figures for the scanned domain are read from the local cache for free on every
  scan. Fetching fresh ones is a separate click that states the cost first and spends the owner's
  own units, per the rule that nothing bills anyone by opening a page.

  One page plus the paths a site publishes anyway (robots.txt, sitemap, llms.txt). Nothing is
  brute-forced, no credential is tried, and the WordPress paths are only requested when the page
  already looks like WordPress. Reports download as Markdown.

### Fixed

- **The pre-update SQLite backup could hang forever on a busy instance.** `better-sqlite3`'s
  `.backup()` copies page by page and restarts whenever the source is written to, so on a
  production database with schedulers running it never finished — an update sat on that line for
  fifteen minutes with no output and no error, which is worse than a failure because it cannot be
  told apart from slow. The backup now uses `VACUUM INTO`: one statement, one read snapshot, no
  restart on concurrent writes — measured at 0.4 s for a 21 MB database while 617 writes landed in
  it. A copy of the database and its WAL sidecars is the fallback, the result is opened and
  integrity-checked before the update proceeds, and the updater caps the step at ten minutes so it
  can never block again.


### Changed

- **Site Audit no longer asks how many pages to crawl.** It crawls the site. The number survives as
  an optional safety ceiling for deliberately sampling something enormous, and the report says
  plainly whether it was reached — "the whole site as far as the crawler could reach it" or
  "stopped at the limit, so the site may have more". Asking for a page count up front was asking a
  question nobody can answer before the crawl, and guessing low truncated the audit silently.
- **Long tables are paginated** — the audit page list and the scan history both stopped being a
  scroll bar pretending to be a table. Scanner cards are two per row rather than four, where the
  values wrapped mid-word.
- **The audit export is now a work order rather than a page list.** Every finding carries the value
  that triggered it (`og:image, og:description` instead of an empty column) — captured during the
  crawl and stored, which it previously was not. A finding on 80% or more of the pages is labelled
  site-wide and shown once with an example, because that is one template to fix and not two hundred
  pages. Each of the 31 rules carries a one-line fix, long lists move to an appendix, and the report
  explains why a health score can stay high while an informational finding affects every page.
- **The public Free SEO Checker is gone**, replaced by the competitor crawler above. It was a
  lead-generation page on an application whose whole premise is that nothing is public; the engine
  survives inside a tool that does more, for people who are signed in. `/free-seo-checker`,
  `/api/public/seo-check`, the anonymous rate bucket and the Turnstile options no longer exist.

## [1.4.0] — 2026-08-12

Everything below closes the same loop: find a problem, act on it, and prove afterwards that the
action worked. Existing tools keep their own data, screens and logic — **Site Audit**, **AI
Visibility** and **SEO Tools → GEO** were not merged into anything.

**Before you update.** The schema change is additive and the updater takes a verified SQLite backup
before touching anything, so the upgrade path is the usual one. Two features in this release reach
outside the instance for the first time and are worth trying on something disposable before you
rely on them: **Content Operations** creates branches and pull requests in a GitHub repository you
connect yourself, and **Source Audit** reads that repository. Both require you to add a
fine-grained token explicitly, neither touches your base branch, and nothing is merged
automatically — but they are new, and a first run against a scratch repository will tell you more
than this paragraph can. Everything else in the list reads data this instance already has.

### Added

- **Team collaboration.** A workspace is the owner's account, and members act on the owner's data
  with a role: viewer reads, editor runs free actions and edits content, admin may also spend the
  owner's API credits and manage people, and the owner keeps keys, Google connections, updates and
  deletions. The owner cannot be removed or demoted, and ownership transfer is a separate explicit
  action so the workspace survives someone leaving.

  **Sign-in no longer goes through Google at all.** Identity and data are separate concerns:
  `npm run create-owner -- --email you@example.com` creates the owner from the server console, and
  `npm run set-password` is the recovery path when nobody can get in. Google OAuth keeps doing the
  only job it should ever have had — pulling Search Console and Analytics data into the workspace.
  Nothing is taken away: the owner can keep signing in with Google, and after setting a password
  both doors work. What closed is the other case — a Google account that is not the owner's no
  longer attaches itself to the instance, and connecting one is an owner action from inside a
  session. Owners still on Google see a single dismissible prompt suggesting a password, with the
  SSH command included; it never returns once one exists.

  **Members sign in with an email and a password, never with Google.** An employee's Google account
  carries their own Search Console properties, and signing them in that way would pull personal
  sites into an agency workspace — in both directions the wrong thing. An admin either sets a
  starting password (the member must change it at first sign-in, so the admin's copy stops being a
  credential) or sends a single-use invite link valid for 72 hours. Suspension takes effect on the
  next request, and the members screen explains on-screen what each role can do, including which
  ones can spend money. MCP tokens inherit the holder's role, so a viewer's agent cannot start a
  paid job.

- **Audit Verification** re-crawls the same scope and separates resolved findings, persistent
  findings, regressions and inconclusive pages in the UI, API and MCP. A page that could not be
  re-fetched is reported as inconclusive rather than fixed.
- **Site Audit rule registry**, now executable and 30 rules wide: redirect chains and loops,
  canonical and robots conflicts, viewport and language, JSON-LD validity, social metadata,
  mixed content and security headers.
- **Outreach Workspace** inside Link Monitor: campaigns, evidence snapshots, stage history,
  follow-ups, localized pitch drafts, Backlink liveness linkage and four local MCP actions.
  It prepares outreach; it never sends it.
- **Related Intent** as a second mode of the existing Cannibalization report — clusters different
  query formulations, explains page roles, position gaps and daily winner changes, and recommends
  review only. No LLM, live SERP or paid call. Exact-query stays the default.
- **Content Operations**: an editorial queue above the existing generators with approval, review,
  deterministic preflight, an encrypted fine-grained GitHub token, a diff you must confirm, and a
  pull request that is never auto-merged.
- **Post-deploy outcome**. A merged pull request is not a deployment: OpenGSC fetches the target
  URL and starts measuring only on a real HTTP 200, then links the page into Indexing and, when a
  keyword is set, into the Rank Tracker. Windows close at 7, 30 and 90 days against a 28-day
  baseline, captured once each from your own Search Console rows, with the reporting lag accounted
  for — an empty row means *not measured yet*, never zero traffic.
- **Source Audit**, a read-only tab in Content Operations that checks a bounded snapshot of a
  connected GitHub branch before deployment (80 files, 256 KiB per file, 4 MiB total, in memory).
  It stores findings, never source bodies or secret values, and marks a truncated scan as
  incomplete. Exposed read-only over MCP as `get_source_audit`.
- **Public Free SEO Checker** at `/free-seo-checker`: one homepage, the shared audit registry and
  SSRF-safe fetch, consequence-and-action wording, seven locales, an anonymous rate bucket, a
  15-minute cache and optional Turnstile. No session, no stored report.
- **Sitemap Inventory** in the Indexing tab: recursive sitemap index, gzip and image/video/news
  extensions, source sitemap, `lastmod` reliability, first/last seen, and a disappearance rule that
  needs two fully successful syncs — a failed child sitemap never marks a URL missing.
- **`seo-production` agent skill**: task card, demand evidence, outline first, a claim ledger,
  deterministic verification, and a package handed to Content Operations. It forbids inventing
  first-hand experience and does not optimize for AI detectors.
- **45 MCP tools** (37 local), including the Outreach and Source Audit contours.

### Security

- **A Google sign-in that is not the owner's is now refused.** Previously any Google account that
  reached the login page was attached to the instance as an additional Search Console connection —
  no session was granted, but a stranger's properties and OAuth tokens landed in someone else's
  database. Linking a new Google account now requires an active owner session, which is what the
  "add account" button in Settings already provides.
- Every API route resolves identity through one workspace resolver instead of reading the session
  directly, and membership is re-read on each request, so revoking access is immediate despite
  30-day JWT sessions.
- User-controlled HTTP fetches resolve and pin public addresses, re-check every redirect, reject
  private and reserved IPv4/IPv6 targets, and cap time, redirects and response bytes.
- `OPENGSC_ALLOW_PRIVATE_TARGETS=1` is the one deliberate exception, for operators auditing a
  staging site on their own machine or LAN. It is off by default and the public Free SEO Checker
  ignores it regardless.
- The updater now takes a verified SQLite backup **before** `git reset --hard`, not after. A local
  install left on the template default (`file:./dev.db`) previously had that file restored from the
  repository during an update; production installs point `DATABASE_URL` at `data/prod.db` and were
  never affected.
- `.gitignore` covers local databases, WAL sidecars and the updater's backup directory, so a real
  database cannot be committed by accident.

### Changed

- Job lifecycle and heartbeat fields are shared by audit and paid SEO jobs; an interrupted free
  audit recovers, and a paid call is never retried automatically.
- Settings → Members is a real feature now and no longer behind a flag. The remaining Teams and
  Super Sites screens are still mockups and stay behind `NEXT_PUBLIC_EXPERIMENTAL_TEAM_UI=1`.
- SQLite is documented as the supported database; MySQL/MariaDB remains experimental.
- `.env.template` ships with the repository again — `.gitignore` had been swallowing the file both
  install guides tell you to copy.
- New screens use the shared `globals.css` layer instead of component-scoped styles, so light and
  dark themes follow the same tokens as the rest of the app.
- `npm run check` also verifies release metadata and seven-locale key parity.

## [1.3.0] — 2026-08-09

### Fixed

**AI Visibility reported "not cited" for questions ChatGPT visibly cites you on**

The check asked `gpt-4o-mini` with `tool_choice: "auto"`, which on a mini model usually means
the search tool is never called: the answer comes from weights, carries no citations, and the
tracker records an absence. It also asked from nowhere in particular, while the browser answer
a user compares it against is geolocated — for a local-intent question the two were not looking
at the same web at all. And because only a boolean was stored, a disagreement could not be
investigated; the only available conclusion was that the tool was broken.

The search is now forced rather than suggested, runs at `search_context_size: high`, carries a
`user_location`, and uses a model you pick (default `gpt-5`, live list from your own key) with a
fallback ladder so an older account degrades instead of erroring. Perplexity gained the same
context/location options. Claude and Grok were not searching the live web at all and now do, via
Anthropic's `web_search` tool and xAI Live Search respectively — so all four columns finally
measure the same thing.

### Added

**AI Visibility shows its work**

Every check now stores the full answer, each citation, which model produced it and whether a
live search actually ran. Expanding a question shows the answer text, the cited domains with
yours highlighted and your rank among them, so "not cited" is something you can read rather than
a claim you have to take on faith. A row where the model never searched is flagged as such
instead of being counted as an absence.

A third verdict, **mentioned**, separates "the brand is named in the prose" from "the answer
links to you" — previously both collapsed into the same grey dash, or, when brand terms happened
to match, into a false green tick.

**"Cited instead of you"** counts the domains the engines returned across all your tracked
questions — the pages your answer has to displace.

**Per-site check settings** (model, country, city, answer language) live on the tab. Country
falls back to the site's search market and can be cleared back to "no location", which is a
different question to ask an answer engine than "United States".

### Changed

**Model ids are resolved from your account, not hardcoded**

`gpt-5` was written literally into the GEO audit page, its stored default and the server-side
audit fallback; `gpt-4o-mini` into the audit's second pass. That kind of staleness is silent: the
id keeps resolving, the call keeps succeeding, and the tool quietly runs a generation behind
whatever you are comparing it against. A new `lib/seo/models.ts` ranks whatever `/v1/models`
returns for your own key — newest generation first, then by size tier, previews last — and
resolves an *intention* (`quality` / `balanced` / `cheap`) into an id from that ranking. A saved
model the provider has since retired is replaced rather than 404-ing. Hardcoded ids survive only
as the fallback for "no key, nothing to list".

**You can see which model each tool runs, and where it is set**

The SEO Tools header had an unlabelled "Settings" button. It now names the model that will
actually run — e.g. `OpenAI · gpt-5.6-terra` — and expands into a panel listing every AI task the
current page performs, what each one does, and **which settings level the value came from**
("set for this task" / "from the SEO Tools model" / "no model sent — provider decides"). The
fallback chain is three deep, and until now a user whose per-task model appeared not to take had
no way to tell a failed save from an override.

Some pages were running tasks nobody had been told about: **Links** runs the `analysis` task, and
the **GEO audit's** second pass runs the new `utility` task. Both are now visible in the header
and configurable like everything else.

**Two routes had their own private copy of the LLM client — deleted**

`/api/gsc/branded` (brand-term detection) and `/api/gsc/setup` (One-Click Setup clustering) each
carried a hand-rolled multi-provider client, forked from `lib/llm.ts` and then left behind. They
were still asking for `gpt-4o-mini`, `gemini-1.5-flash`, `claude-3.5-haiku` and `glm-4.5-air`,
and nothing ever failed, because a stale model id keeps resolving. They also knew four providers
where the shared client knows nine, and had no retry at all — so a routine `429` came back as
"no brand terms found" or a silent fall back to algorithmic clustering, on your paid key.

Both now call `fetchLLM`, which brings retries, the full provider list, and real error detail.
The model comes from the new **Utility passes** task, so it is visible and configurable like
everything else.

**Default model ids live in one table**

`lib/providerDefaults.ts` holds the per-provider default for chat and vision. They were
previously written inline at every call site and aged separately — the drift above is what that
looks like in practice. Anything you choose still wins outright; this table only answers
"nothing was chosen and we still have to put a string in the request".

One default was actively wrong: a **custom OpenAI-compatible endpoint** with no model configured
was sent `gpt-4o-mini` — an OpenAI id to a gateway that may never have heard of OpenAI. The 404
that came back looked like your server's fault. It now fails with "no model configured", which
is the actual problem.

**Per-task model is a picker, not a text box**

Settings → SEO Tools let you type a model id by hand for each task, which is how you end up
pinned to something the provider retired. It now lists the chosen provider's live models, keeps a
free-text escape hatch for endpoints with no `/models` listing, and never discards a saved id it
cannot find in the list. Each row explains what the task does, which tools use it, and what it
resolves to. Two tasks were missing from that table entirely: **Landing page** (so
`seoTaskModel_landing` could be read but never written) and the new **Utility passes**.

The task list, the tool-to-task mapping and the settings table now come from one registry
(`lib/seo/aiTasks.ts`), so they cannot drift apart again.

**Background AEO checks are now opt-in per site**

A check spends your own AI credits — four billed calls per question, each with live web search.
On an instance with a large portfolio the scheduler was quietly doing that for every site with
tracked questions. It now only visits sites where **Check automatically once a day** is switched
on; everything else waits for the button. Adding questions no longer triggers a check either:
pasting thirty questions and paying for a hundred and twenty API calls are separate decisions.

## [1.2.3] — 2026-08-06

### Added

**Content tools now use whichever keyword source you actually pay for**

Writing an outline with a Serper SERP key and an Ahrefs key used to produce no keyword data at
all, because every content tool was hard-wired to DataForSEO and said nothing when that key was
absent. Worse, the outline prompt kept its "split keywords by frequency: ВЧ → H1, СЧ → H2, НЧ →
H3" instruction regardless, so the model applied it to an imaginary frequency breakdown — an
outline that looked methodically correct built on numbers that did not exist.

A new `keywordSource` layer routes a seed through Ahrefs → Semrush → DataForSEO by which key is
configured, reading the shared cache first and for free. Outline, landing and cluster were
moved onto it; the standalone `keywords.ts` (DataForSEO-only, uncached) and a fourth private
DataForSEO client in `generate.ts` were deleted. When no source is configured, the outline and
landing pages now show an explicit "keywords not loaded: source not configured" banner instead
of staying silent, and the prompt drops the frequency rule rather than running it on nothing.

A new selector in **Settings → SEO Metrics** lets you lock the source (`auto` / `ahrefs` /
`semrush` / `dataforseo` / `off`) and shows which one `auto` resolved to. Every paid call quotes
its own price in units and USD on the button before it is pressed.

**Rewrite now keeps the ranking phrases it was asked to keep**

`RewriteBody` gained an optional `targetKeywords` field, and a new deterministic
`keywordCoverage` check (next to `uniquenessPct` and `factDrift`) reports, per target phrase,
how many times it appeared in the source vs the rewrite. A phrase that quietly disappeared from a
two-thousand-word text — the same class of invisible risk `factDrift` catches for numbers — is
now surfaced explicitly. The UI has a target-keywords input and a coverage panel under each
variant.

**Portfolio cache warm-up**

With 210 sites and 0.8% keyword-metric coverage, loading volumes page by page is not realistic.
A new **warm-up** panel prices the whole striking-distance gap for a site, tag or market up front
and fills it in one button — the 1 714 uncovered striking-distance terms on the live server cost
≈ $0.56 in one click. Grouped by market, with the sites it skipped (unknown market) listed
separately.

**Per-site market selector**

Keyword data is bought and cached per country, so the market a site targets is a correctness
property, not a preference. A new amber chip on each site card shows the resolved market (from an
override, then the ccTLD, then `unknown`), and an inline editor sets it. `Site.market` is a
nullable column; a backfill script (`scripts/backfill-site-market.ts`) fills the ~170 inferable
ones from the ccTLD and leaves the rest for a human. **Run `npx prisma db push` after updating,
then `npx tsx scripts/backfill-site-market.ts --apply`.**

**Semrush now works on the Competitors screen**

`fetchOrganicCompetitors` and `fetchOrganicKeywords` no longer return `provider_unsupported` for
Semrush — they call `domain_organic_organic` (40 units/line) and `domain_organic` (10 units/line,
`Kd` included at no surcharge). The gap route's cap check now uses the provider's own rate, so a
Semrush call is quoted honestly before it runs. Backlinks stay Ahrefs-only (Semrush 40 units/line
against Ahrefs' 5) and the UI still says so.

### Changed

**Unknown country is now an error, not a silent default to the US**

Three independent code paths (`demand.ts`, the deleted `keywords.ts`, `generate.ts`) turned an
unknown country code into US location 2840 with no warning, so keyword research for the 18-site
Bosnian cluster silently returned American volumes. The Balkans (`ba`, `me`, `mk`, `al`, `si`)
are now in the location table, and every other unknown code returns `unsupported_country` rather
than a wrong answer. `country` is a required argument in all five `metrics.ts` entry points
(including the Semrush one, where the parameter is named `database`).

**`readKeywordCacheAny` reads across all providers**

A row bought from Ahrefs was invisible to a query configured for Semrush, and vice versa. The new
cache reader spans providers and prefers a row with `difficulty` over a fresher one without it,
so a cheap volume refresh cannot bury a KD that cost ten times as much.

**MCP `research_keywords` can use Ahrefs**

It was DataForSEO-only. It now routes through the same `keywordSource` layer, and the provider is
folded into the `DemandSearch` cache key as a prefix (`ahrefs:seed|…`), reusing the namespace
pattern `aeo/mentions` already established with `llm:` — no schema migration needed.

## [Unreleased]

### Added

**Properties removed from Search Console now leave the dashboard**

Delete a property in Search Console and it used to stay on the dashboard forever. Replacing
nine banned domains left nine dead cards sitting among the live ones, dragging the portfolio
totals down and showing a flat line nobody could act on.

The cause was that site discovery only ever inserted. `GET /api/gsc/sites` upserted everything
Google returned and did nothing at all about rows Google had stopped returning, and there was no
way to remove a site by hand either — no endpoint, no button. Once a row was in the `Site` table
it was there for good.

Sites Google no longer lists are now moved to an **Archive** group, collapsed at the bottom of
the dashboard. Archiving is soft on purpose: everything already collected for that domain —
metrics, audits, tracked keywords, backlinks, Clarity snapshots — stays in the database and stays
queryable, which matters when the domain was replaced rather than abandoned and you still want to
compare the new one against it. Each row has **Restore**, and **Delete** for permanent removal
once the history is genuinely not needed. New `Site.archivedAt` — **run `npx prisma db push`
after updating**.

Reconciliation runs in two places, so it does not depend on anyone opening a browser: in the
dashboard's own site fetch, and in `runGscSync()`, which means a scheduled sync on a headless
instance keeps the list honest by itself. It works in both directions — a property that comes
back (re-verified, or the same domain added again) leaves the archive on the next pass.

It will not archive on a partial read. Every linked account has to have answered without error
and the list has to be non-empty, and in `runGscSync()` a failed `sites.list` disqualifies that
user entirely rather than just the one account. The alternative is a dashboard that empties
itself because a token expired overnight, which looks exactly like losing your data.

### Changed

**Archived sites are excluded from the background schedulers**

A dead domain was still being checked on schedule. The rank scheduler spent paid SERP calls on
it, the AEO scheduler spent AI calls, Clarity collection logged a daily failure against a project
receiving no traffic, and the alert scheduler fired a traffic-drop alert on every run — because
traffic going to zero is precisely what a removed property does.

All four now skip archived sites, as does the per-site metric work in `/api/gsc/portfolio`, which
returns a zeroed payload for them instead of running two queries and a sparkline calculation that
can only ever draw a flat line. Archived rows are still sent to the client, because that is what
the Archive group lists.

`runGscSync()` itself never touched them — it walks Google's list, and they are not on it.

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

**"Last synced" survives a restart**

The dashboard read the timestamp from a module-level variable, so any deploy or `pm2 restart`
forgot a sync that had really happened. The effect was two screens disagreeing about the same
event: Settings showed the scheduled run from that morning, read from the database, while the
button on the dashboard still showed a manual sync from two days earlier.

`runGscSync` now writes its completion time into `User.syncSettings` for every account it
covered, and the sync endpoint falls back to that when its own memory is empty. A restored
timestamp comes back with zero counts, because those genuinely are not known any more, and the
label only ever asked "when".

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
