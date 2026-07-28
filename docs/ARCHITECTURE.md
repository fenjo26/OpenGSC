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

Background work (AI generation jobs, cron-style sync) does **not** use a queue broker. It uses two
lightweight patterns instead:

- **Fire-and-forget route handlers** — `POST /api/seo/jobs` creates a `SeoJob` row, calls
  `genByType(...)` **without awaiting it**, and returns the job id immediately. The promise keeps
  running in the same Node process after the HTTP response is sent; when it resolves, a second
  write updates the job row to `completed`/`error`. The client polls `GET /api/seo/jobs/[id]`.
- **In-process interval schedulers** — `[name]-cron` modules (see `pm2 logs` for `aeo-cron`,
  `clarity-cron`, `rank-cron`) run `setInterval`-based sync loops started once at process boot,
  living entirely inside the same PM2 process.

This keeps the deployment story to "one process, one file database" at the cost of jobs not
surviving a process restart mid-flight — which is why `GET /api/seo/jobs` auto-fails anything
stuck in `processing` for more than 20 minutes (see `src/app/api/seo/jobs/route.ts`): a restart
mid-job would otherwise leave a phantom row "processing" forever.

## 2. Data model

`prisma/schema.prisma` groups into these areas:

| Area | Models |
|---|---|
| Auth | `Account`, `Session`, `User`, `VerificationToken` |
| GSC core | `Site`, `SitemapUrl`, `IndexingOperation`, `DailyMetric`, `PageInspection`, `PageInspectionHistory` |
| Growth tools | `TrackedKeyword`, `RankCheck` (Rank Tracker), `TrackedQuestion`, `AeoCheck` (AEO Tracker), `Backlink`, `ContentGroup`, `TopicCluster`, `LinkWatchBrand`, `LinkMention` (Link Monitor), `DrCache` (Ahrefs DR cache) |
| Integrations | `ClaritySnapshot`, `SiteHealth` |
| Indexer | `IndexerDomain`, `IndexerLog`, `IndexerQueue`, `IndexerDictionary` |
| SEO Tools | `SeoJob`, `SeoHistory`, `GeoAudit`, `RagSlot`, `RagCasino` |
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

### 3.4 GEO Audit

Unlike the rest of the suite, GEO Audit doesn't use a SERP+scrape pipeline at all. It sends the
user's question directly to an AI provider **with that provider's own live web-search tool
enabled** (OpenAI's Responses API `web_search` tool, or kie.ai's equivalent) and parses the model's
search trace and citations out of the response — the "ground truth" is literally what the AI
already searched and cited, which is the whole point: it's measuring AI-search visibility, not
simulating it.

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

**The endpoint must be excluded from the NextAuth middleware, and this is not optional.**
`src/middleware.ts` matches everything outside `/login` and `/api/auth`, so without an
explicit exclusion `withAuth` answers an agent's POST with a 307 to `/api/auth/signin` and
the client receives the HTML login page instead of JSON-RPC — the route's own Bearer check
never runs. The check is not skipped, only relocated: `/api/mcp` validates `User.mcpToken`
itself and returns a JSON-RPC 401 when it is absent or wrong. It cannot live in the
middleware, because that runs on the Edge runtime and Prisma does not.

The tool registry is split across three files for readability and flattened into one
`MCP_TOOLS` array at the bottom of `src/lib/mcp/tools.ts`: the GSC core (`tools.ts`), the
remaining read surfaces (`toolsData.ts` — decay, CTR benchmark, content groups, rank history,
GEO audits, generations, engine portfolios, GA4, Clarity, indexer, digests, alerts), and the
page-optimization contour (`toolsOptimize.ts`). Shared helpers live in `shared.ts` so no file
imports another's registry. A duplicate tool name throws at module load, since `findTool`
would otherwise silently shadow one and the symptom ("that tool ignores half its arguments")
points nowhere near the cause.

Two rules keep it safe and predictable:

1. **Read-only by default** — no tool mutates user-visible state. Three exceptions, each
   deliberate: `inspect_url` refreshes the `PageInspection` cache with what it just fetched
   (which only makes the Indexing tab fresher), and the two paid tools below create their own
   job rows.
2. **Every tool declares what it costs** — `McpTool.cost` is one of `local` (reads the local
   database), `quota` (calls Google on the user's OAuth: free, quota-limited), `net` (fetches
   a third-party page), or `paid` (spends the user's own AI credits). `tools/list` maps this
   onto the protocol's own `annotations` (`readOnlyHint`, `openWorldHint`, `idempotentHint`)
   plus a `_meta.cost` field, `get_capabilities` returns the tools grouped by tier, and the
   `initialize` instructions explain the tiers so an agent chooses before it calls.

The `paid` tier is a deliberate relaxation of what this section previously promised
("nothing ever calls a paid provider"). Two tools hold it: `rewrite_content` and
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
  check, deterministic, no model). `rewrite_content` is for when the user wants the app's
  pipeline specifically.
- **Keys come from the server-side mirror** (`User.seoSettings`, resolved by
  `resolveAiCreds()`) — the same snapshot digest-cron and rank-cron already use, since an
  MCP request has no browser and therefore no localStorage.

`start_generation_job` returns a job id immediately and runs `genByType` fire-and-forget,
reusing the `SeoJob` pattern from §1 — the pipeline takes minutes, far longer than a tool
call can wait, so a synchronous version would only ever time out. `get_generation_job` polls
it and applies the same 20-minute staleness sweep as the UI, so an agent never polls a row
whose process died.

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

A deliberately dependency-free technical audit: plain `fetch` + regex extraction, no headless
browser — the audited signals (status codes, titles/meta, H1s, canonicals, `noindex`, link
graph, word counts) all live in raw HTML. The crawler BFS-walks same-host pages from the site
root (≤500 pages, 4 workers, manual-redirect mode so 3xx chains are visible, a politeness
delay per request), then a **second pass** computes issues that need the whole crawl map:
broken internal links (a link is "broken" if its target was crawled and returned ≥400) and
duplicate titles. Results land in `SiteAuditPage` rows plus a JSON summary (issue counts +
health score) on `SiteAudit`.

Runs as the same fire-and-forget job pattern as `SeoJob` (§1): `POST /api/audit` creates the
row and calls `runAudit()` without awaiting; the client polls `GET /api/audit?siteId=`, and
rows stuck `running` for >30 min are auto-failed on the next list read. One running audit per
site is enforced at start.

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
