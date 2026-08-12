# Architecture

This document explains how OpenGSC is put together: the runtime model, the data model, and the
internal design of its two most complex subsystems — the AI SEO Content Suite's generation
pipeline and the Private Indexer Network's cloaking mechanism. It's aimed at contributors who
want to change or extend the code, not at end users (see the main [README](../README.md) for
that).

## 1. Runtime model

OpenGSC is a single Next.js 16 (App Router) application, run as one Node process under PM2. There
is no separate backend service: every server-side operation is a Next.js **Route Handler** under
`src/app/api/**`, and every page under `src/app/**` is a client component that calls those routes.
Persistence is a single **SQLite** file (via Prisma 7 + `@prisma/adapter-better-sqlite3`), which is
why the installer insists on an **absolute** `DATABASE_URL` — a relative path resolves differently
depending on PM2's working directory and silently "loses" data across restarts.

Authentication is **NextAuth v4** with the Google provider only. The first Google account to sign
in becomes the instance owner; every other connected Google account (added under **Settings → My
Google Accounts**) is a linked `Account` row whose OAuth token is used server-side to call the
Search Console / Analytics / Ads-adjacent Google APIs on the user's behalf. There's no separate
multi-tenant user system — this is designed to be one operator's personal dashboard across
multiple Google identities, not a multi-customer SaaS.

**Workspace and roles.** Every table is scoped by `userId`, and that still means the owner. Team
members do not own rows: `getWorkspace()` in `src/lib/team/workspace.ts` resolves a request to
`{ ownerId, actorId, role }`, and route handlers call `workspaceUserId(capability)` instead of
reading the session, so the hundreds of existing queries are unchanged while gaining an access
rule. The permission table lives in `src/lib/team/roles.ts` — pure, unit-tested, and importable by
client components to hide controls, though the server checks it again because a hidden button is
not a permission system. Two boundaries carry the design: spending the owner's API credits requires
`admin`, and anything that can lock the owner out or expose credentials is owner-only.

**Identity is not Google.** Accounts authenticate through the Credentials provider; the owner is
created from the console (`scripts/create-owner.mjs`) and recovered the same way
(`scripts/set-password.mjs`). Google OAuth exists to attach an `Account` row — the grant behind
Search Console and Analytics reads — and linking one requires an active owner session. Google may
still be used to sign in while the owner has no password, which is the bootstrap state of a fresh
install and of every instance created before this release; `googleLoginStillAllowed()` in
`src/lib/auth.ts` encodes that as a state rather than a setting, so there is no migration flag and
no window in which an instance has no way in.

Membership is read on every request rather than cached in the JWT. Sessions last 30 days and cannot
be revoked, so a cached role would keep a suspended member working for a month; one indexed lookup
buys immediate suspension. Members authenticate through a Credentials provider with bcrypt — never
Google, because an employee's Google account carries their own Search Console properties and those
must not enter someone else's workspace. `Membership` rows exist only for members; the owner is the
user carrying `isOwner`, resolved lazily from the first user on instances that predate the column.

Background work (AI generation jobs, cron-style sync) does **not** use a queue broker. It uses two
lightweight patterns instead:

- **Fire-and-forget route handlers** — `POST /api/seo/jobs` creates a `SeoJob` row, calls
  `genByType(...)` **without awaiting it**, and returns the job id immediately. The promise keeps
  running in the same Node process after the HTTP response is sent; when it resolves, a second
  write updates the job row to `completed`/`error`. The client polls `GET /api/seo/jobs/[id]`.
- **In-process interval schedulers** — `[name]-cron` modules (see `pm2 logs` for `aeo-cron`,
  `clarity-cron`, `rank-cron`) run `setInterval`-based sync loops started once at process boot,
  living entirely inside the same PM2 process.

This keeps the deployment story to "one process, one file database" at the cost of work in flight
not surviving a process restart. A dedicated `heartbeatAt` now distinguishes a slow provider call
from a lost task. Paid SEO work silent for 20 minutes is marked `interrupted/error` and is never
replayed automatically, because an uncertain retry could bill the owner twice. Free Site Audit
crawls follow a different policy: an owner list read claims a stale run and restarts it from a clean
partial-page set with the stored crawl options.

Every updater run now creates a consistent SQLite backup with `better-sqlite3` before `prisma db
push` and verifies the copy with `PRAGMA integrity_check`. Backups are stored beside the active
database under `backups/`; schema changes never start if this backup step fails. Background rows
also carry additive lifecycle fields (`stage`, `progress`, `attempt`, `heartbeatAt`, `checkpoint`)
while keeping the legacy `processing/completed/error` statuses and response fields intact.

## 2. Data model

`prisma/schema.prisma` groups into these areas:

| Area | Models |
|---|---|
| Auth | `Account`, `Session`, `User`, `VerificationToken` |
| GSC core | `Site`, `SitemapUrl`, `IndexingOperation`, `DailyMetric`, `PageInspection`, `PageInspectionHistory` |
| Growth tools | `TrackedKeyword`, `RankCheck` (Rank Tracker), `TrackedQuestion`, `AeoCheck` (AEO Tracker), `Backlink`, `ContentGroup`, `TopicCluster`, `LinkWatchBrand`, `LinkMention` (Link Monitor), `OutreachCampaign`, `OutreachProspect`, `OutreachStageEvent`, `DrCache` (Ahrefs DR cache) |
| Integrations | `ClaritySnapshot`, `SiteHealth` |
| Indexer | `IndexerDomain`, `IndexerLog`, `IndexerQueue`, `IndexerDictionary` |
| SEO Tools | `SeoJob`, `SeoHistory`, `GeoAudit`, `RagSlot`, `RagCasino`, `ContentRepository`, `ContentOperation`, `ContentOperationEvent`, `SourceAuditRun` |
| Site Audit | `SiteAudit`, `SiteAuditPage` (built-in crawler) |
| Search engines | `EnginePortfolioCache` (cached live Bing/Yandex portfolio per `userId`+`engine`+`period`) |
| Notifications | `AlertEvent` (fired alerts, dedupe), `Digest` (digest history) |

Notably, **the SEO Tools module treats the browser as its working store, with the server as a
backup.** Outline/Text/Analysis/Landing/Cluster results live in the browser's `localStorage`
(`src/lib/seo/history.ts`), capped at 40 records with oldest-first eviction on quota errors — and
are mirrored to the `SeoHistory` table via `/api/seo/history`: every save schedules a debounced
push, and on app mount `syncHistoryFromServer()` restores any records missing locally. Pushes are
blocked until that initial pull has finished, so a freshly-wiped browser can never clobber the
server backup with an empty list. The `SeoJob` table only exists to survive a page reload *during*
generation (see §1); once a job's result is imported into local History, the server row is deleted
(`src/lib/seo/jobs.ts:importJob`). API keys, provider/model choices, and Editorial **Policies**
follow the same localStorage-first pattern with a per-user server snapshot (`User.seoSettings`),
synced by the invisible `SeoKeysSync` component through `/api/settings/seo-sync` — restore on
mount, push every 20s and on tab-hide when changed. **GEO Audit** is fully server-persisted
(`GeoAudit`) with no localStorage copy at all, since audits are expensive enough that users expect
them to survive indefinitely across devices/browsers.

Two smaller server-backed features sit outside the generation pipeline. **`/api/dr`** proxies
Ahrefs' free public Domain Rating endpoint behind a 7-day `DrCache` (the dashboard batches up to
100 domains per request, 60 fetched fresh per call with bounded concurrency; the UI must keep the
"Domain Rating by Ahrefs" attribution wherever DR is shown). **Link Monitor**
(`/seo-tools/links` → `/api/linkwatch`, models `LinkWatchBrand`/`LinkMention`) pulls watched
brands' fresh backlinks from the Ahrefs v3 `all-backlinks` endpoint — in-content, live, DR ≥ 50
by default, first seen in the last 3 months, one per referring domain, requested sequentially to
respect Ahrefs' per-minute rate limits — and offers an LLM insights pass over the stored mentions
via `fetchLLM`. Both features (and the history/keys sync above) are written with raw SQL
(`$queryRawUnsafe`) so they degrade gracefully — returning empty results instead of crashing — on
a database that hasn't run `prisma db push` yet.

**Outreach Workspace** extends Link Monitor without changing its fetch or scoring logic. A saved
prospect gets an immutable evidence snapshot, optional campaign/contact/follow-up fields, a stage
history and an optional link to the owner's existing `Backlink` row. The workspace never sends
mail: its localized pitch is a deterministic draft for manual review/copy. All writes are scoped
by `userId`; campaign and backlink ownership are checked server-side. These models intentionally
have no relationship to `GeoAudit`, `AeoCheck` or the Site Audit crawler.

**Cannibalization** keeps its original exact-query algorithm and API response as the default.
`mode=related` is an additive deterministic path in `lib/cannibalization/relatedIntent.ts`: it
builds candidate pairs through inverted indexes over normalized query tokens and observed GSC
ranking URLs, then scores lexical similarity, URL overlap, significant competing-page share,
position distance and day-to-day dominant-URL changes. This avoids a portfolio-wide O(n²) scan.
The result includes inferred query intent and page roles plus review-only actions (`merge_review`,
`differentiate`, `canonical_review`, `internal_linking`). It calls no LLM or live SERP provider and
never performs any of those actions. CJK queries gain deterministic character bigrams rather than
requiring a language-model tokenizer.

**Sitemap Inventory** is an additive layer on the existing `SitemapUrl` indexing table, not a new
audit product. A sync keeps source sitemap, raw/valid `lastmod`, extension counts, first/last seen
and a per-run change state while preserving every Google/XML River/2index/Neural field. Sitemap
indexes are bounded to 50 children, depth 3 and 20,000 unique URLs; raw `.gz` bodies and
image/video/news namespaces are understood. A failed root returns an error, and a failed child
makes the run `partial`. Crucially, only a complete run advances negative evidence: the first miss
becomes `pending_missing`, the second consecutive complete miss becomes `missing`, and neither a
network error nor a partial tree changes unseen rows. Page-metadata verification is a separate,
explicit action capped at 50 URLs; it stores a normalized SHA-256 fingerprint and small response
facts, never page content. This lets a changed `lastmod` with unchanged observed content be marked
as suspicious.

The “Audit from sitemap” button only sets `seedFromSitemap` on a normal `SiteAudit` run. The audit
still uses its own models, rule registry, history and screen; active inventory URLs merely augment
the BFS frontier, and a seeded page with no observed internal inbound link is reported as an orphan
candidate. AI Visibility and SEO Tools → GEO remain completely unrelated to this path.

These columns are applied by the normal updater's backup + `prisma db push` sequence. The change is
additive and preserves old `SitemapUrl` rows; rollback means restoring the updater's pre-change
SQLite backup rather than manually dropping columns from a live database.

**Competitor Crawler** (`src/lib/scanner/`, `/crawler`) scans one page of any domain through the
SSRF-safe fetcher and judges it with the shared audit rule registry, so a finding means the same
thing here as in Site Audit. Beyond the page it reads platform markers, WordPress asset slugs and
the public `wp-json` user list, DNS (A/AAAA/NS/MX) and CDN headers, and the robots/sitemap/llms.txt
trio. Scans live in `SiteScan`, deliberately not in `Site`: the sites table is the operator's own
portfolio and a competitor scanned once must not enter portfolio counts, digests or alerts.

The cross-scan part is the reason the table stores a separate `fingerprints` column. Analytics,
tag-manager, ads and heatmap identifiers are extracted per scan and compared against every earlier
scan by the same owner; `fingerprintStrength()` splits them into signals billed to a person (strong)
and signals shared by every customer of a host (weak), and the UI never presents the weak ones as a
conclusion. Extraction is pure and unit-tested in `fingerprints.test.ts`, so the part that decides
whether two domains belong together has no network or database in it.

**Source Audit** is a repository-code checker inside Content Operations, not another runtime site
audit. It reads a user-selected GitHub branch through fixed tree/blob API paths, with hard limits
of 80 files, 256 KiB per file, 4 MiB total and five concurrent blob reads. Source contents exist
only for the duration of the in-memory analysis. `SourceAuditRun` stores the immutable commit SHA,
framework, progress, bounded findings and severity counters; it stores neither file bodies nor
secret values. Oversized files, GitHub-truncated trees and local scan limits make the report
explicitly `truncated` instead of silently complete.

**Post-deploy outcome** (`src/lib/contentOps/outcome.ts`, arithmetic in `outcomeMath.ts`) answers the
question the workflow otherwise drops: did the published page do anything? `POST
/api/content-ops/{id}/outcome` verifies the target URL with the SSRF-safe fetcher, and only a real
200 moves the operation to `measuring`. It then upserts the URL into `SitemapUrl` so the Indexing
tab sees it, upserts a `TrackedKeyword` when the item has one, and stores a 28-day baseline. Windows
close at 7, 30 and 90 days and are captured on the next list request rather than by a timer — a
couple of local aggregates over `DailyMetric`, plus the closest `RankCheck`, with a three-day settle
for Search Console's reporting lag. Checkpoints are append-only, and the operation reaches
`completed` when day 90 lands. No paid indexer submission and no merge is ever automatic; the
`siteId`/`trackedKeywordId` columns are deliberately plain scalars so deleting a site or keyword
cannot cascade into the editorial audit trail.

Rules live in the independent `src/lib/sourceAudit/rules.ts` registry and currently target Next.js
SEO, performance, correctness, security and architecture patterns. The implementation uses the
installed Next.js 16 documentation as its behavioral source and copies no Svelte-specific rules.
The job is read-only and fire-and-forget; heartbeats let the next list request mark a run stale
after ten minutes as `interrupted`, but it is not retried automatically. Site Audit, AI Visibility
and SEO Tools → GEO keep independent models, state, API and UI and do not consume Source Audit rows.

## 3. The SEO generation pipeline (`src/lib/seo/generate.ts`)

This is the most intricate part of the codebase. `genOutline()` and `genText()` are each a chain of
LLM passes, not a single prompt — because a single giant prompt asking for "a complete, richly
detailed 3000-word article" reliably degrades mid-generation (prose collapses into bullet lists,
tables get invented values, entity depth thins out after the first few sections).

### 3.1 Outline generation (`genOutline`)

```
mapExtractFacts()        MAP stage — extract compact per-source facts (specs, prices, entities,
                          headings covered) from each scraped competitor, in parallel, bounded
                          concurrency. Keeps the REDUCE prompt grounded in clean facts instead of
                          20 pages of raw HTML.
        ↓
findRagFacts()           optional — pulls verified entity attributes from the Casino RAG knowledge
                          base (RagSlot/RagCasino) when the keyword matches a known slot/casino.
        ↓
buildOutlinePrompt()      REDUCE stage — one call builds the full EAV outline: sections, per-section
  → fetchLLM()            word budgets, weighted+roled entities, keywords, FAQ, visual elements.
        ↓
buildFactScrubPrompt()   corrects fabricated-looking specifics baked into the outline (wrong specs/
  → fetchLLM()            prices/dates/names) BEFORE the text step can inherit them.
        ↓
expandOutlineStructure() if the outline came back flat (H2s with <2 child H3s — typical when a
                          user-supplied template constrains the model), asks for extra H3
                          insertions and grafts them in deterministically.
        ↓
localizeOutlineHeadings() translates/styles any headings left in the wrong language or a flat tone
                          into the article's language + narration voice.
        ↓
normalizeWordBudgets()   DETERMINISTIC, no LLM call: sums each section's own word-count
                          contribution and rescales every section proportionally if the sum is
                          more than ~15% off the requested target. (Models sometimes copy the JSON
                          schema's example numbers into every section instead of computing real
                          ones — this silently turns a 2500-word plan into ~1000 words of budget.)
        ↓
enrichOutlineSections()  deepens every section's entities/summary/copywriter-notes/connections in
                          parallel batches of 5 (2 concurrent workers) — a single outline call
                          compresses detail once there are 15-30 sections; this pass restores it.
```

The outline's `meta` also carries a `facts_bank` (consolidated MAP-stage facts, RAG facts first)
and a `sources` array — both consumed later by the text step, so the article is fact-checked
against the *same* sources the outline was built from, instead of re-searching from scratch.

### 3.2 Text generation (`genText`)

For outlines with 10+ sections, the article is written by `writeTextInChunks()`: sections are
grouped into H2-rooted units, packed into chunks of ≤5 sections, and each chunk is a **separate**
LLM call (bounded concurrency) that only sees the full heading map for context, not the other
chunks' content. Each chunk carries its own word budget and gets one scoped trim pass if it
overshoots by >15%. A deterministic assembler then stitches `H1 + TOC + chunks + FAQ` together —
the TOC's heading label ("Contents"/"Sommaire"/"Índice"/…) is picked from a **static per-language
table** (`tocLabelFor()`), never left to the model, because a model shown one literal example in
its own instructions (e.g. a Russian example) will happily copy it verbatim regardless of the
article's actual language.

If chunking isn't used or a chunk fails after retries, `genText` falls back to a single-shot
`buildTextPrompt()` call with the full outline JSON embedded.

After the article exists, three more passes run **in this exact order** — the order matters and
has been a real source of bugs:

1. **Auto fact-clean** (`buildAutoFactCleanPrompt`) — verifies the article against the facts bank
   and fixes contradictions/fabrications in one pass. This pass is instructed to preserve length,
   but nothing enforces that at the code level, and "fixing" a fact often means *adding* a
   clarifying clause, not removing one.
2. **Volume guard** (`enforceVolumeTarget()`) — expands articles under ~85% of target, iteratively
   trims (up to 3 passes) articles over ~115%. **This runs last, after fact-clean**, specifically
   so a fact-correction pass can never silently re-inflate an article that was already within
   budget — an earlier version ran the guard *before* fact-clean and shipped articles up to +38%
   over their target as a result.
3. **Deterministic guarantees** — `ensureMetaBlock()` and `ensureTocLabel()` re-stamp the SEO meta
   block and TOC label from known-good data (the outline's `meta`), regardless of what any LLM
   pass produced or mangled along the way. Nothing about a fixed, already-known string (a meta
   title, a TOC label) is left to chance this late in the pipeline.

### 3.3 Multi-provider LLM client (`src/lib/llm.ts`)

`fetchLLM()` (and `fetchLLMDetailed()`, which also returns the provider's raw error) is the single
call surface used everywhere in `generate.ts`. `temperature` is an optional trailing parameter and
is **omitted from the request body when undefined**, keeping the wire format byte-identical to the
pre-temperature version for every existing caller — this runs in production. `supportsTemperature()`
reports which targets reject an explicit temperature (OpenAI gpt-5.x / o-series and kie's Codex pin
sampling internally and answer 400), so callers can grey the control out and the bench can label a
row "ignored" instead of silently claiming to have tested a value it never sent. `clampTemp()`
absorbs the range difference between providers (Anthropic and Gemini cap at 1.0, the
OpenAI-compatible family at 2.0) so one UI slider stays honest across all of them. It normalizes seven providers (Anthropic, Z.AI,
OpenAI, Gemini, OpenRouter, kie.ai's Responses-API-shaped "Codex" endpoint, and any custom
OpenAI-compatible endpoint) behind one signature, retries `429`/`408`/`5xx` up to 3 times with
backoff + jitter (a `429` is routine when a pipeline stage fires several parallel calls at once —
it must not sink the whole job), and gives up immediately on non-retryable `4xx` (auth errors,
malformed requests, or a provider's own content-policy rejection). `fetchLLMDetailed()` surfaces
that failure reason up through `genText` into the job's `error` field, so a content-policy
rejection (a real, fairly common occurrence for edgier niches like gambling/finance) shows up
readably in History instead of a bare `generation_failed` that sends you spelunking through
`pm2 logs`.

### 3.3a Who picks the model (`src/lib/seo/aiTasks.ts`, `models.ts`, `keys.ts`)

Three separate questions, deliberately answered in three places.

**Which task is running?** `AI_TASKS` in `aiTasks.ts` is the registry — `outline`, `text`,
`landing`, `analysis`, `policy`, `utility` — each with a description, a default *tier* (never a
model id), and `PATH_TASKS` mapping tool routes to the tasks they run. Both surfaces render it:
Settings → SEO Tools builds its per-task table from the list, and the SEO Tools header names the
tasks the current page will run. They used to be written out separately and drifted — the
settings table offered four tasks while `getTaskCreds` read five, so `seoTaskModel_landing` was
readable but not writable and the Landing tool ignored a setting the user believed they had made.
The Links tool ran on `analysis` without saying so anywhere.

**Which provider and model win?** `resolveTaskCreds()` in `keys.ts` walks
`seoTaskProvider_<task>` → `seoProvider` → `aiProvider` for the provider, and
`seoTaskModel_<task>` → `seoModel` → `aiModel_<provider>` for the model, and returns the winning
*level* alongside the value (`providerFrom` / `modelFrom`). That extra field is the point: a
three-deep fallback chain that only reports its result cannot be debugged from the UI, and a user
whose per-task model appeared not to take had no way to tell a failed save from an override.

**Which model id when nothing was chosen?** `lib/providerDefaults.ts` — one table, chat and
vision, for every provider. These ids used to be written inline at each call site and aged
separately: `lib/llm.ts` had moved to `gpt-5.6-luna` / `gemini-3-flash` / `kimi-k3` while
`/api/gsc/branded` and `/api/gsc/setup`, which had grown private forks of the same client, were
still asking for `gpt-4o-mini`, `gemini-1.5-flash` and `claude-3.5-haiku`. Nothing failed — stale
ids keep resolving — so the drift was invisible until all four implementations were read side by
side. Both forks are now deleted in favour of `fetchLLM`, which also gains them retries, the full
nine-provider list and real error detail. `custom` deliberately has **no** default: it is an
arbitrary OpenAI-compatible gateway, and the old fallback sent it an OpenAI model id, producing a
404 that read as the user's own server being broken.

**Which model id, concretely?** `models.ts` never names one. It ranks whatever `/v1/models`
returned for the user's own key — newest generation first, then by size tier, previews last — and
`defaultModel(list, tier)` resolves a *tier* into an id from that ranking. `resolveModel()` keeps
a stored choice if the account still offers it and replaces it if the provider retired it.
Hardcoded ids are the fallback for "no key, nothing to list", and nothing depends on them being
current. The reason for all this: a literal `"gpt-5"` (or `"gpt-4o-mini"`) goes stale *silently* —
the id keeps resolving, the call keeps succeeding, and the tool quietly runs a generation behind
whatever the user is comparing it against.

### 3.4 GEO Audit

Unlike the rest of the suite, GEO Audit doesn't use a SERP+scrape pipeline at all. It sends the
user's question directly to an AI provider **with that provider's own live web-search tool
enabled** (OpenAI's Responses API `web_search` tool, or kie.ai's equivalent) and parses the model's
search trace and citations out of the response — the "ground truth" is literally what the AI
already searched and cited, which is the whole point: it's measuring AI-search visibility, not
simulating it.

The audit runs in two stages on two different models. Stage 1 (search) uses the model picked on
the page — deep browsing is the whole job, so it defaults to the best the account offers. Stage 2
turns the search trace into structured JSON and runs on the `utility` task (§3.3a), because
paying flagship rates to emit JSON is waste. Stage 2 used to be pinned to a literal
`"gpt-4o-mini"` inside `geo.ts`: invisible on the settings screen, unchangeable, and destined to
break when the model is retired.

### 3.4a AEO Tracker / AI Visibility (`src/lib/seo/aeo.ts`)

The site-level counterpart to the GEO Audit: instead of profiling a niche, it asks tracked
real-user questions and records whether *this* site is cited. All four engines are asked to
search the live web — OpenAI Responses API with the hosted `web_search` tool, Perplexity `sonar`,
Anthropic's `web_search` server tool, xAI Live Search — because an answer from weights is not
evidence about search visibility.

Three properties of the check matter more than the engine list:

- **The search is forced, not suggested.** With `tool_choice: "auto"` a small model usually skips
  the search entirely and answers from memory, producing zero citations — which the tracker then
  recorded as "not cited" for sites that ChatGPT visibly cites in the browser. A four-step attempt
  ladder drops `search_context_size`, then `user_location`, then `include`/`instructions` in turn,
  so an account without the newest surface degrades instead of erroring; `401`/`403`/`429` abort
  the ladder rather than burning four calls on a dead key.
- **Location is part of the question.** Browser answers to local-intent queries are geolocated.
  Asking from nowhere in particular and comparing the result to a geolocated browser answer
  compares two different webs. Country falls back to `Site.market`, and clearing it back to "no
  location" stays expressible — that is a different question to ask, not an unset value to guess.
- **The evidence is kept.** `AeoCheck` stores the full answer, every citation, the model, whether
  a search actually ran, and our rank among the cited domains. A bare boolean could not be argued
  with: when it disagreed with the browser there was nothing to inspect, so the only available
  conclusion was that the tool was broken.

Verdicts are three-state — `cited` (a link to us), `mentioned` (named in the prose, no link),
`absent` — and brand terms derived from the domain feed only the weaker verdict, never a claimed
citation. Background checking is opt-in per site (`Site.aeoAuto`, default off): each question
costs four billed calls with live search on the user's own key, so a large portfolio must not
enrol itself.

### 3.5 Content Rewriter (`src/lib/seo/rewrite.ts`)

A lightweight, stateless tool (`/seo-tools/rewrite` → `POST /api/seo/rewrite`) that rewrites pasted
text — or a **URL** (fetched through the existing `scrapeMany` scraper) — into *N* unique variants
via `fetchLLM`, so it inherits the whole multi-provider abstraction (§3.3) and the user's own keys.
Variants are generated with a small concurrency pool and a "make this variant distinct" nudge in the
prompt. Two ideas are borrowed from `affiliate.fm/ai-content-rewriter` but re-implemented on our own
stack (no OpenAI-only dependency): **`maskAIPatterns()`** strips common machine tells (em/en-dashes,
"furthermore"/"moreover", "it is important to note", unicode bullets…) via a regex table, and
**`uniquenessPct()`** scores each variant as `1 − word-trigram Jaccard similarity` against the source.
It writes nothing to the database — results are returned inline and copied/downloaded client-side. The
Content Decay map deep-links each decaying page here with `?url=` prefilled.

### 3.6 AI-Fingerprint Lab (`src/lib/seo/aidetect.ts`)

The only part of the suite that runs **no LLM at all**. Statistical AI detectors score the token
frequency distribution over ~300-word windows and average them — shuffling an AI text into
word-salad barely moves its score, because order carries almost no signal and presence carries all
of it. That makes the discriminator reproducible locally, and both corpora already exist in the
product: competitor pages via `scrapeMany` (human reference) and `SeoHistory` articles (machine
reference). Training is Naive Bayes over log-odds with Laplace smoothing; every 5th document is held
out to calibrate the 0-100 scale, so the score isn't fitted on the windows it grades. Training and
scoring both run **in the browser** — it is arithmetic over a token map — and only the corpus
harvest needs a server round-trip (`/api/seo/aidetect/harvest`), because it needs the SERP key and
cross-origin fetch. Models live in `localStorage` (`aidetectStore.ts`), capped at 6000 tokens.

Three correctness constraints that are easy to get wrong and were each caught by a test:

- **Format leak.** The two corpora arrive in different shapes — scraped competitors are plain text,
  our own articles are Markdown with a fenced meta block. Without `normalizeForCorpus()` the model
  learns "`##` means AI", reports near-perfect separation on a leak, and emits a marker list made of
  punctuation. The regression test feeds identical vocabulary in both formats and asserts the model
  *fails* to separate them.
- **Homoglyphs.** NFKC does not merge Cyrillic "а" into Latin "a" — they stay distinct code points.
  Real detectors fold confusables, so `foldConfusables()` does too, but only for **mixed-script
  tokens** and always toward the token's dominant script; a blanket map would mangle genuine Russian
  or Greek prose into Latin nonsense.
- **Domain vocabulary.** A word can be necessary to the niche *and* overused by the model, earning a
  high log-odds weight and landing in the ban list. Banning it makes the model circumlocute around
  required terminology. `humanDf` (share of competitor documents containing the token) gates this:
  at ≥40% the word is niche terminology and is never suggested, whatever its ratio.

The score is not the deliverable — `suggestBannedCandidates()` is. Its output reaches generation
through `bannedWordsBlock()` in `prompts.ts`, wired into `buildOutlinePrompt`, both branches of
`buildTextPrompt`, and `buildSectionTextPrompt`. That block deliberately contains **no instruction
about how to write**: A/B evidence shows directives like "sound natural" or "vary sentence length"
backfire, because the model follows them as formal rules and narrows its own output distribution.
Naming concrete words carries no such failure mode. The candidate list is reviewable in the UI
before it can affect an article, with exclusions stored per model in `aidetectStore`.

### 3.7 Fact drift (`src/lib/seo/factDrift.ts`)

Any rewrite can silently change a number or drop a brand, and that is the failure that costs money:
an article that reads beautifully and states the wrong price. Asking users to "verify the facts" is
not protection, since the point of a rewrite tool is that nobody rereads 2000 words. So the two
classes of fact that are checkable without a model are diffed deterministically — numeric values
(with currencies canonicalized, so `$50` = `50 USD` = `50 долларов`, and locale digit separators
never fire a false alarm) and identifier-shaped tokens (ALL-CAPS or internal-caps only; ordinary
capitalized words are excluded because sentence-initial capitals cannot be told from proper nouns
cheaply across languages). Values that **appeared** outrank values that were **dropped** — an
invented number ships. Computed server-side in `rewrite.ts` because in URL mode the client never
sees the scraped source. The humanize action also uses it as a tiebreaker: a variant that invented a
fact loses to one that didn't, even with a better score.

## 4. Search engines (Google · Bing · Yandex)

Google is the primary, locally-synced source (`DailyMetric`). Bing and Yandex are **live**: their
credentials live browser-side (`seoKey_bing*` / `seoKey_yandex*`, backed up to `User.seoSettings`),
and are resolved server-side by `src/lib/engineKeysServer.ts` — a mirror of the client
`resolveEngineKey` that honours per-site account selection. That server resolver is what lets a
**guest share link** and the headless **digest**/**portfolio** endpoints reach an engine without the
owner's localStorage.

Two rendering surfaces:

- **Per-site view** (`src/components/EngineView.tsx`) — swaps the GSC chart for a live Bing/Yandex
  view of one site: clicks/impressions/CTR/position with GSC-style toggles + a previous-period dashed
  comparison, sortable+paginated query/page tables with CSV, and engine-specific extras (Bing index &
  crawl stats; Yandex SQI + localized site diagnostics). Fetches through `/api/indexing/{bing,yandex}`,
  which accept either the owner's key or a `shareToken`+`siteId` (guest).
- **Portfolio view** (`/api/gsc/portfolio-engine`) — enumerates the engine's **own** verified sites
  (Bing `GetUserSites`, Yandex hosts list) across every configured account, then builds the *same*
  per-site payload shape as `/api/gsc/portfolio` (daily series + normalized sparkline + summary with
  deltas). This powers both the **main dashboard engine tabs** and the **digest engine tabs**.

Reliability & performance of the portfolio path:

- **Server-side cache** — the computed snapshot is stored in `EnginePortfolioCache`
  (`userId`+`engine`+`period`, raw-SQL upsert so it degrades gracefully pre-migration). Normal loads
  serve the cache instantly; `?refresh=1` (Sync / the tab's Refresh) rebuilds from the live APIs.
- **Throttle handling** — engines return HTTP 200 with an *empty* body under heavy batch load, which
  plain error-retry never catches. `fetchNonEmpty()` retries on an empty-but-OK payload, concurrency is
  kept low (3), and Bing avoids a second call per site by taking avg position from `GetQueryStats` only
  when the traffic series lacks it.
- **Sticky merge** — on rebuild, any site that still comes back empty falls back to its last-known-good
  value from the previous snapshot, so a one-off failure never blanks a card that had data.

## 5. The Indexer's cloaking mechanism

The deployable script (generated in four flavors — dynamic PHP, static PHP wrapper, an Astro SSR
middleware, or an Nginx routing config — from `src/app/indexer/settings/page.tsx`) implements a
two-stage bot check:

1. **User-agent match** — a substring check for `googlebot`, `bingbot`, `yandex`, `mail.ru`, or a
   generic `bot|crawler|spider` pattern.
2. **Double DNS verification** (when strict mode is on) — a **reverse** DNS lookup
   (`gethostbyaddr`) of the visitor's IP must resolve to an accepted hostname suffix
   (`googlebot.com`/`google.com`, `yandex.ru`/`.net`/`.com`, `search.msn.com`, `mail.ru`), and then
   a **forward** lookup of *that* hostname must resolve back to the exact same IP. This defeats a
   spoofed `User-Agent: Googlebot` header, since an attacker cannot control the PTR record inside
   Google's or Yandex's own IP ranges — only the real crawler's IP will pass both directions.

Bots that pass both checks receive a generated doorway page (word-mashed from the domain's
Dictionary entries) with an `ETag`-based `304 Not Modified` short-circuit on repeat crawls — this
is what the Stats dashboard's per-bot `304` columns measure: a high 304 rate means a bot is
efficiently re-checking a page it already has, without the script burning CPU regenerating content
it doesn't need to. Every verified bot hit also fires a logging ping to
`POST /api/indexer/webhook`, which is what populates the Logs and Stats pages. Anyone who fails
either check — real humans and unverified/fake bots alike — is redirected (302) straight to the
configured money-site URL, so the doorway content is never visible to anyone outside the
whitelisted crawlers.

The **Links** planner (ring/mesh/pyramid topologies) and the **Queue** (money-site URLs to weave
in as internal links) are purely data feeding the next content-generation pass on each domain —
they don't call any external service, they just shape what the script's word-mashing logic links
to.

## 6. MCP server (`src/app/api/mcp/route.ts`)

OpenGSC speaks MCP (Model Context Protocol) over the **Streamable HTTP** transport in
stateless mode: every JSON-RPC message arrives as a POST and is answered with a plain JSON
body (the spec allows this in place of an SSE stream), so the endpoint needs no session
state and survives process restarts trivially. Authentication is a per-user bearer token
(`User.mcpToken`, managed in **Settings → API & MCP** via `/api/settings/mcp-token`).

Authentication is the token in an `Authorization: Bearer` header, or — because one important
client cannot send one — in a `?token=` query parameter. Claude Desktop's *Add custom
connector* dialog offers a URL and, behind Advanced settings, OAuth Client ID and Client
Secret; there is no header field, so a token pasted there is interpreted as an OAuth client
id and the connector fails silently. The query parameter is the only way those users can
connect at all. The header always wins when both are present, and the cost — a token in the
access log, where a header would not be — is stated in the setup docs rather than hidden.

Two paths must also stay clear of the login redirect for a client to get that far.
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` are
probed before connecting, to discover whether the server wants OAuth. Nothing serves them
here, so 404 is the correct answer and means "no OAuth". Behind `withAuth` they answered 307
to the HTML login page instead, which a client can read as an OAuth server that exists,
sending it into a flow this server cannot finish — and the connector then fails with nothing
useful in the error.

**The endpoint must be excluded from the NextAuth request gate, and this is not optional.**
`src/proxy.ts` matches everything outside `/login` and `/api/auth`, so without an
explicit exclusion `withAuth` answers an agent's POST with a 307 to `/api/auth/signin` and
the client receives the HTML login page instead of JSON-RPC — the route's own Bearer check
never runs. The check is not skipped, only relocated: `/api/mcp` validates `User.mcpToken`
itself and returns a JSON-RPC 401 when it is absent or wrong.

That relocation used to be forced rather than chosen: the file was `src/middleware.ts`, and
middleware runs on the Edge runtime, where Prisma cannot. Next.js 16 renamed the convention to
`proxy` and fixed its runtime to Node.js — not configurable — so the technical obstacle is gone
and the token check *could* live in the gate now. It still shouldn't. The gate runs on every
request to every path; putting a database lookup there to serve one endpoint would spend a query
on every page load to save one inside `/api/mcp`. The exclusion list stays where it is.

The tool registry is split across seven files for readability and flattened into one
`MCP_TOOLS` array at the bottom of `src/lib/mcp/tools.ts`: the GSC core (`tools.ts`), the
remaining read surfaces (`toolsData.ts` — decay, CTR benchmark, content groups, rank history,
GEO audits, generations, engine portfolios, GA4, Clarity, indexer, digests, alerts), and the
metrics, demand, page-optimization, Outreach and Source Audit contours (`toolsMetrics.ts`,
`toolsDemand.ts`, `toolsOptimize.ts`, `toolsOutreach.ts`, `toolsSourceAudit.ts`). Shared helpers live in `shared.ts` so no file imports
another's registry. A duplicate tool name throws at module load, since `findTool`
would otherwise silently shadow one and the symptom ("that tool ignores half its arguments")
points nowhere near the cause.

Two rules keep it safe and predictable:

1. **Mutations are explicit** — read tools remain read-only, while every local or paid action that
   changes state overrides `readOnly`/`idempotent` protocol annotations. The Outreach mutations
   only update local workspace rows and explicitly state that they do not send mail. Existing
   exceptions remain deliberate: `inspect_url` refreshes the `PageInspection` cache, and paid
   generation tools create their own job rows.
2. **Every tool declares what it costs** — `McpTool.cost` is one of `local` (reads the local
   database), `quota` (calls Google on the user's OAuth: free, quota-limited), `net` (fetches
   a third-party page), or `paid` (spends the user's own AI credits). `tools/list` maps this
   onto the protocol's own `annotations` (`readOnlyHint`, `openWorldHint`, `idempotentHint`)
   plus a `_meta.cost` field, `get_capabilities` returns the tools grouped by tier, and the
   `initialize` instructions explain the tiers so an agent chooses before it calls.

The `paid` tier is a deliberate relaxation of what this section previously promised
("nothing ever calls a paid provider"). Two tools hold it: `start_rewrite_job` and
`start_generation_job`. They exist because the web UI can do things an agent cannot
reproduce — the outline pipeline's MAP/REDUCE fact grounding, Casino RAG, fact-scrub, the
user's editorial policy and banned-word list — and withholding them made the MCP a strictly
worse OpenGSC than the browser tab next to it. Three things keep the relaxation honest:

- **`assertConfirmed()`** (`shared.ts`) refuses to run either tool without an explicit
  `confirm: true`, and the refusal text tells the agent to ask the human rather than retry
  with the flag set. Some MCP clients auto-approve tool calls; an agent exploring the
  registry must not be able to bill the owner for a call it made to see what came back.
- **The free path is named in their own descriptions.** An MCP client is itself a language
  model: paying a second one to write text the first could have written is money for nothing.
  The intended flow is `get_optimization_brief` (everything known about one URL in a single
  call) → the agent writes → `analyze_text` (uniqueness, fact drift and heading-structure
  check, deterministic, no model). `start_rewrite_job` is for when the user wants the app's
  pipeline specifically.
- **Keys come from the server-side mirror** (`User.seoSettings`, resolved by
  `resolveAiCreds()`) — the same snapshot digest-cron and rank-cron already use, since an
  MCP request has no browser and therefore no localStorage.

**Both paid tools are asynchronous, and this is load-bearing rather than a nicety.** They
return a job id and run `genByType` / `runRewriteBatch` fire-and-forget, reusing the `SeoJob`
pattern from §1. A synchronous version does not merely time out — it loses paid work. One
page rewrite is a fetch, then a model call producing up to 8000 tokens, then a scoped repair
pass when the value audit fails; the per-call ceiling in `lib/llm.ts` is 280 seconds and MCP
clients abandon a tool call after 30–60. When the client gives up the server does not: the
call completes, the credits are spent, and the result returns to a caller that is no longer
listening, so it is written nowhere. An early version of `rewrite_content` was synchronous
and did exactly this — roughly thirty minutes of wall time produced four usable pages and
paid for every abandoned attempt in between.

`runRewriteBatch` (`src/lib/seo/rewriteBatch.ts`) therefore persists **per page**, not at the
end: each result is written into the job row the moment that page finishes, so a timeout, a
closed client or a PM2 restart costs at most the page in flight. It also never throws — a
failure on one URL is recorded against that URL and the batch continues, since aborting would
discard the remaining pages over a problem that may be specific to one page. A batch with any
success is `completed` with a `failed` count; only a batch where nothing succeeded is `error`.

Two ordering hazards around the staleness sweep, both fixed here:

- **A long job is not a dead job.** The 20-minute sweep assumes silence means the process
  restarted, but nothing wrote to the row while a pipeline worked, so a large article could
  pass the mark while perfectly healthy and be reported as failed. `withSeoJobHeartbeat()` in
  `src/lib/jobs/lifecycle.ts` touches the dedicated heartbeat every 60 seconds, making silence mean
  what it was always supposed to mean. The rewrite batch also advances heartbeat/progress whenever
  it saves a page, so completed paid work remains retrievable even if the next page is interrupted.
- **A rewrite job is not the browser's to collect.** The History page imports every completed
  `SeoJob` into `localStorage` and then *deletes the server row* (`importJob`,
  `src/lib/seo/jobs.ts`). A rewrite batch is owned by the agent that started it and polled
  from the server, so an open OpenGSC tab would have filed it under a type History cannot
  render and destroyed the agent's results — pages the user had already paid for. `importJob`
  now imports only the types History owns (`IMPORTABLE_TYPES`) and leaves the rest alone.

`get_generation_job` polls either kind, applies the same staleness sweep as the UI, and for a
rewrite batch reports progress plus the pages finished so far — omitting the rewritten text
unless asked, since twenty articles inlined into a tool result is not a readable answer.

Tool-level failures (bad site name, empty data) are returned as MCP tool results with
`isError: true` rather than JSON-RPC protocol errors — agents can read the message and
self-correct (e.g. call `list_sites` after a "site not found"). Tools reading tables that may
predate a migration degrade to an empty result plus a note rather than throwing. Adding a
tool = adding one object to the relevant array (name, description, `cost`, JSON schema,
handler); `tools/list` and `tools/call` pick it up automatically. Two convenience GETs sit
outside the protocol purely for debugging a connection — `GET /api/mcp` reports whether the
token was accepted, `GET /api/mcp/tools` returns the registry as plain JSON — because the
first thing anyone does with a failing endpoint is open it in a browser, and a bare 405 there
cannot distinguish a wrong token from a wrong URL. Ready-made agent skills that orchestrate
these tools ship in `.agents/skills/`.

## 7. Site Audit crawler (`src/lib/audit/crawler.ts`)

A deliberately dependency-free technical audit: plain `fetch` + deterministic HTML/header
extraction, no headless browser. The executable 30-rule registry in `rules.ts` is the single
source for crawler evaluation, UI labels/severity, exports, verification and MCP. Alongside the
original status/title/meta/H1/canonical/link/content checks it covers redirect chains/loops,
conflicting robots directives, missing/invalid canonicals, viewport/language, invalid JSON-LD,
incomplete Organization/Person and social metadata, mixed content and root security headers.
`pageSignals.ts` owns parsing so attribute order and JSON-LD edge cases are unit-tested outside a
live crawl.

The crawler BFS-walks same-host pages from the site root (≤500 pages, 4 workers,
manual-redirect mode so 3xx chains are visible, a politeness delay per request), then a **second
pass** computes issues that need the whole crawl map: broken internal links, duplicate titles and
redirect traces. Results land in `SiteAuditPage` rows plus a JSON summary on `SiteAudit`.
Informational and useful-but-non-universal checks remain visible but do not lower the established
health score; older audit snapshots retain the score already stored with them.

This registry belongs only to runtime **Site Audit**. It imports no `AeoCheck`/AI Visibility or
`GeoAudit` data and does not change those products' settings, APIs or screens. The AI-crawler card
below is a separate robots-access observation made during Site Audit, not a merge with either
visibility product.

One site-wide check rides along on every audit outside the per-page issue model:

- **AI Crawlability** (`src/lib/audit/aiCrawl.ts`) — fetches `/robots.txt` and `/llms.txt` once
  and reports, per AI crawler (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended,
  CCBot, Bytespider), whether the bot is allowed/blocked/unknown under a root `Disallow: /`. A
  root block on GPTBot is a silent reason an answer engine never cites the site; this surfaces it
  as a fixable lever rather than just the GEO/AEO symptom ("not cited"). Stored in the audit
  summary's `aiCrawlability` key (free-form JSON, no migration) and rendered as its own card.
The per-page **`js_rendered` issue** flags a near-empty JS app shell (low text word count + ≤1
internal link + a SPA marker or a large bundled script). On such pages `thin_content` and
`h1_missing` are suppressed because they describe the empty raw shell, not the rendered DOM. The
flag is informational and does not lower health.

Runs as the same fire-and-forget job pattern as `SeoJob` (§1): `POST /api/audit` creates the
row and calls `runAudit()` without awaiting; the client polls `GET /api/audit?siteId=`. A run with
no heartbeat for five minutes is atomically claimed and restarted on the next owner list read;
partial pages are cleared first so duplicate rows cannot leak into the result. One running audit
per site is enforced at start.

## 8. Notifications (alerts + digests)

Delivery is the user's **own Telegram bot** (`src/lib/notify.ts`): BotFather token +
auto-detected chat id stored on `User` (raw-SQL convention), messages sent straight to the
Bot API — no third-party notification service, nothing to pay for. Two in-process
schedulers (started from `instrumentation.ts`, same pattern as rank-cron):

- **alert-cron** (`src/lib/alertScheduler.ts`, hourly) evaluates per-user rules over data
  the app already holds — rank drops (`TrackedKeyword.lastPosition` vs `prevPosition`),
  week-over-week click drops (`DailyMetric`), SSL expiry (`SiteHealth`), low audit scores
  (`SiteAudit`). Every fired alert is an `AlertEvent` row whose **unique `dedupeKey`**
  (e.g. `rank_drop:<kwId>:<date>`) makes re-firing a silent no-op, so a user is never
  spammed twice for the same occurrence.
- **digest-cron** (`src/lib/digestScheduler.ts`, hourly gate on `hourUtc` + weekday)
  renders `buildDigest()` (`src/lib/digest.ts`) — per-site traffic vs previous period,
  cross-site winner/loser queries, rank movements — optionally topped with an LLM summary
  that reuses the server-side key backup (`User.seoSettings`, same trick as
  `getUserSerpCreds`). `lastSentAt` inside `digestSettings` prevents double sends across
  ticks and restarts. Digests are filterable by **site tag**, so one tag = one network's
  own report; history lives in the `Digest` table and the `/digest` tab.

Delivery channels: the Telegram bot and/or a **Slack Incoming Webhook** (`sendSlack` in
`notify.ts`, with Telegram-style Markdown converted to Slack's `mrkdwn`); `notifyUser()`
fans out to every configured channel.

## 9. Shared dashboards

A site can expose a **read-only guest link**: `Site.shareToken` (+ `shareEnabled`) is a
random token generated from the site's Settings tab; the public page
`/share/[siteId]/[token]` reuses the regular site-dashboard component with the token passed
down, and `verifyAuthOrShare()` (`src/lib/authShare.ts`) lets GSC data routes accept
*either* a session *or* a valid `shareToken` scoped to that one site. Revoking/regenerating
the token invalidates old links instantly. Share pages render outside the app shell (no
TopBar) via the `AUTH_PATHS` exclusion in `DashboardShell`.

## 10. Extending the project

- **Add an LLM provider**: extend the `if/else if` chain in `fetchLLMOnce()`
  (`src/lib/llm.ts`) with the new provider's request/response shape, plus a matching branch in
  `fetchLLMVision()` if it should support screenshot-to-structure. No other file needs to change —
  every call site already goes through `fetchLLM`/`fetchLLMDetailed`.
- **Change a generation prompt**: all prompt text lives in `src/lib/seo/prompts.ts` as pure
  string-building functions (`buildOutlinePrompt`, `buildTextPrompt`, `buildSectionTextPrompt`,
  etc.) — `generate.ts` never inlines prompt text, so prompt changes and pipeline/control-flow
  changes stay in separate files.
- **Add a new SEO Tools sub-page**: follow the existing pattern — a `page.tsx` under
  `src/app/seo-tools/`, a route handler under `src/app/api/seo/`, and (if it should be
  resumable/backgroundable) a new branch in `genByType()` plus a `HistoryType` entry in
  `src/lib/seo/history.ts`.
- **Add a new indexer bot/search engine**: extend the user-agent match list and the accepted PTR
  suffix list together, in whichever script template(s) in `src/app/indexer/settings/page.tsx` you
  need to support — keep both lists in sync, since a bot recognized by user-agent but missing from
  the PTR-suffix list will always fail strict verification.
