# Keyword data: how the metrics layer works

Internal reference. `METRICS-SETUP.md` covers how to **configure** the providers and what a user
gets from them; this covers where the numbers come from, who calls whom, what it costs, and where
it is wired into the app.

---

## 1. Three layers, and why there are three

| Layer | File | Owns |
|---|---|---|
| Transport | `src/lib/seo/metrics.ts` | Ahrefs and Semrush: HTTP, retries, concurrency, the price model |
| Transport | `src/lib/seo/demand.ts` | DataForSEO: Labs and Google Ads, routed by country coverage |
| Router | `src/lib/seo/keywordSource.ts` | "Give me keywords" — picks a provider, reads cache, normalizes shape |
| Storage | `src/lib/seo/metricsStore.ts` | Caches, spend accounting, caps, learned gateway limits |

The router exists because there used to be three layers that **did not know about each other**:
analytics called Ahrefs, the Demand tab called DataForSEO, and the content tools carried a fourth
private client of their own. An Ahrefs subscriber writing an outline therefore got no keyword data
at all — and was never told. Now every tool asks the router, and the router decides who to ask.

### One row shape

`DemandRow` (`demand.ts`) is the common type across providers:

```ts
{ keyword, volume, difficulty, cpc, competition, competitionLevel, intent, trend }
```

Chosen as the richest of the shapes already in the codebase. Fields a provider does not supply
stay `null` and are never filled with zero. That distinction is load-bearing: `0` means "nobody
searches this", `null` means "we have no data" — opposite conclusions on screen.

---

## 2. The two questions the router answers

```
expandKeywords(seed)    →  "what else do people search here"  → produces a list
enrichKeywords(list)    →  "what are these worth"             → prices a list you have
```

Both take an explicit `fetch` flag. Without it they are pure cache reads — safe on render, safe in
an MCP tool, safe in a background job. Nothing is bought until something asks.

### What each provider can do

| Task | Ahrefs | Semrush | DataForSEO |
|---|---|---|---|
| Expand a seed | `keywords-explorer/matching-terms`, `related-terms` | `phrase_fullsearch` | `discoverKeywords()` |
| Price a list | `keywords-explorer/overview` | `phrase_these` | `keywordOverview()` |
| Volume history | `keywords-explorer/volume-history` | — | trend inside `DemandRow` |
| Competitors | `site-explorer/organic-competitors` | `domain_organic_organic` | — |
| A competitor's keywords | `site-explorer/organic-keywords` | `domain_organic` | — |
| Backlink profile | `site-explorer/refdomains` | — | — |

An empty cell is not "broken", it is "not implemented, and the UI says so". Link data is
Ahrefs-only and three of the four screens that could want it say that in plain words.

### Choosing a provider

`getKeywordSource()` in `src/lib/seo/keys.ts`, driven by the `seoKwSource` setting:

```
auto → Ahrefs → Semrush → DataForSEO → off      (by which key exists)
```

`auto` is not magic: the settings panel shows what it resolved to. "Automatic" is only reassuring
when you can see what it decided; otherwise it is the same silence in a friendlier font.

Key and host are read from the metrics module's own storage rather than duplicated, so switching
between an official subscription and a reseller in `Settings → SEO Metrics` moves this too, and
there is no second place for a stale host to hide.

---

## 3. Money

### The price model differs by provider

**Ahrefs** charges `max(50, per_row_cost × rows)`, where the per-row cost is the sum of the fields
requested. Most fields cost 1 unit; premium ones cost 10 — `volume`, `difficulty`,
`global_volume`, `intents`, `traffic_potential`. **The field selection is the price.** Columns used
in `where`/`order_by` are billed exactly like displayed ones.

Two consequences are baked into the code:

- The 50-unit floor makes small requests wasteful: one keyword costs the same as four. Loading is
  therefore always batched and never per row.
- A seed expansion is bounded by `limit`, and that is the ceiling on its price. Ahrefs bills the
  rows it **returns**.

**Semrush** charges a flat rate per line of a report, regardless of columns: `phrase_these` is 10
units/line, `phrase_fullsearch` 20, `phrase_related` 40. Adding a column does not change the rate.

**DataForSEO** bills in dollars per call rather than in units.

### Reserve, then reconcile

Every paid path follows the same four steps:

```
1. estimate the ceiling  →  withinCap()        — checked BEFORE anything is sent
2. recordUsage(ceiling)  →  reservation booked
3. call the provider
4. releaseUnusedUnits(ceiling, actual)  →  the difference is given back
```

Charging before the call is not optional: a cap that only notices an overspend afterwards is not a
cap. But a reservation is not a bill. A thin seed returns three rows against a limit of two
hundred, and without step 4 the monthly budget burns tens of times faster than the money does —
eventually refusing work that was never paid for.

The refund is computed **with the same formula the reservation used**, or an Ahrefs-rate refund
would be applied to a Semrush charge. It is clamped at the month's own total so a correction can
never become free budget.

`ApiUsage` holds `(userId, provider, month) → units, requests`. A refund never touches `requests`:
one call happened, and that stays true.

### Learned gateway limits

A reseller gateway speaks the official protocol but is not obliged to forward every column of
every endpoint. The measured case: `keyword_difficulty` arrives on `keywords-explorer` and never on
`site-explorer/organic-keywords` — 200 rows out of 200 came back null on a pull priced **with** the
KD surcharge.

A hard-coded exception list would be wrong within a month, so the app learns instead.

`GatewayFieldSupport` maps `(host, endpoint, field) → supported`. A requested column that came back
empty on every informative row is recorded as unsupported for that host; from then on the checkbox
is disabled and the surcharge is dropped from the quote.

"Informative" is the important word. The verdict is drawn only from rows whose `volume` is
populated — rows where the provider demonstrably had data. Otherwise a brand-heavy pull, where
Ahrefs legitimately returns no KD, no CPC and no intent because every volume is zero, would
permanently disable a column the user is paying for and entitled to. A minimum of 20 such rows is
required; below that the response says nothing about the gateway and nothing is written.

---

## 4. Caches

Two tables. Both degrade to an empty result when the table is missing, never to a 500 — a paid
add-on must not be able to take a free feature down with it.

**`KeywordMetricCache`** — per-keyword metrics, keyed `(keyword, country, provider)`, 30-day TTL
(`KEYWORD_TTL_DAYS` in `metricsStore.ts`, not in the schema).

- `readKeywordCache(kw, country, provider)` — for a paid refresh, which has to know whose rows are
  stale.
- `readKeywordCacheAny(kw, country)` — for display. A volume bought from Ahrefs is still a volume
  after switching to Semrush, and hiding it means drawing an em dash beside a row that is already
  on the invoice. On conflict a row **with KD wins** over one without, and only then does recency
  decide: a newer row is not the better one when it knows strictly less.

**`DemandSearch`** — a whole search result per seed, stored as JSON. The `cacheKey` carries a
prefix: `ahrefs:`, `dataforseo:`, `llm:` (the last one is brand mentions from `aeo/mentions`).
A prefix rather than a column, because the table was designed to be shared by key from the start —
the convention already existed, and it needs no migration.

The cache is what makes a second outline on the same topic free.

---

## 5. Markets

Every figure is bought and cached per country, which makes the market a correctness property
rather than a preference. Researching a Bosnian site as `us` does not merely produce a less useful
answer — it files that answer where the Bosnian view will never look for it.

`marketFor(site)` in `src/lib/seo/market.ts`:

```
Site.market (set by hand)  →  ccTLD  →  null
```

`null` means "unknown", never "United States". `scripts/backfill-site-market.ts` fills in only what
a domain implies; `.com`, `.org` and `.vip` are sold worldwide and say nothing, so those sites stay
empty and are flagged in the UI.

Country tables are `DEMAND_LOC` in `demand.ts` and `DFS_LOC` in `serp.ts`, both following
ISO 3166-1 numeric + 2000 so a wrong entry is visible without a lookup. An unrecognised country
raises `unsupported_country:<gl>` instead of falling through to 2840, which used to return American
volumes in silence.

---

## 6. Where it is wired

### Content tools

| Screen | What it does | Through |
|---|---|---|
| Outline | keywords with volumes into the prompt | `/api/seo/keyword-ideas` → `expandKeywords` |
| Landing | same | same |
| Cluster | volumes order the clusters | `enrichKeywords` inside `genCluster` |
| Rewrite | target keywords + coverage check | GSC via `/api/gsc/page-queries`, then `enrichKeywords` |

Auto-fetch is off by default (`seoKwAuto`): scraping a SERP must not spend keyword credits as a
side effect of pressing a different button. The button quotes its price before it is pressed.

### Analytics

Striking Distance and Rank Tracker use the `useKeywordWeights` hook; Backlinks uses
`BacklinkProfile`; Competitors goes through `/api/metrics/gap`; the DR chip in the indexer uses the
free `/api/dr` and needs no key at all.

### Bulk

`/api/metrics/warmup` plus its settings panel warms the cache across a whole portfolio or one tag.
It counts and prices the work before spending, groups by market, and names the sites it skipped
rather than folding them into `us`. `warmupScheduler.ts` does the same on a schedule: off by
default, with its **own** cap, and no more often than roughly every 25 days. It is the only
scheduler in the app that can spend money, which is why it is also the only one that does nothing
until someone switches it on and gives it a budget.

### MCP

`get_keyword_metrics`, `get_domain_metrics`, `get_backlink_profile`, `get_competitor_gap` and
`get_keyword_demand` are all local reads and **cannot fetch**. An agent has no way to know whether
a human considers a question worth paying for, so it is not given the option. An empty result
therefore means "not loaded yet", never "zero", and the tool descriptions say so explicitly.

`research_keywords` is the exception: paid, refuses to run without `confirm: true`, and goes
through the same router — so it can use Ahrefs, not only DataForSEO.

---

## 7. The rule the whole module answers to

**Every "empty" must be explained.** The user should always be able to tell three states apart:
nobody asked, we asked and the market is empty, the provider did not return it.

This is not a style preference. It is a response to a specific class of bug this module had:

- An outline built with no volume data still ran the rule "highest volume → H1, mid → H2". The
  structure looked methodical and stood on numbers that were never fetched.
- A competitor pull that returned nothing left the screen in its neutral "nothing loaded yet"
  state, so the user paid, learned nothing, and pressed again.
- The Demand column in Content Decay showed an em dash where Semrush is simply unsupported —
  indistinguishable from "we checked and demand is flat".

Hence `hasKwData` and `hasIntent` removing the corresponding instructions from the prompt,
`no_competitor_keywords` returned as an explicit answer rather than as silence, and an unknown
country raising an error. A rule that operates on data nobody supplied is the worst kind of bug:
it does not fail.

---

## 8. Verifying it works

Through MCP `execute_sql_query`, or directly:

```sql
-- cache coverage
SELECT COUNT(*) FROM KeywordMetricCache;

-- markets filled in
SELECT COUNT(*) FROM Site WHERE market IS NOT NULL AND market <> '';

-- KD arrives where it was paid for
SELECT COUNT(*) FROM CompetitorKeyword WHERE difficulty IS NOT NULL;

-- intent arrives (empty is only honest at volume = 0)
SELECT COUNT(*) FROM KeywordMetricCache WHERE intents IS NOT NULL AND volume > 0;

-- search cache, and the provider prefix on its key
SELECT substr(cacheKey, 1, 20) FROM DemandSearch LIMIT 5;

-- share of striking-distance queries with a known volume
WITH q AS (
  SELECT query, AVG(position) AS pos, SUM(impressions) AS imp
  FROM DailyMetric WHERE date >= date('now','-90 day') GROUP BY query
)
SELECT COUNT(*) AS total,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM KeywordMetricCache k WHERE k.keyword = q.query)
           THEN 1 ELSE 0 END) AS covered
FROM q WHERE pos BETWEEN 4 AND 20 AND imp >= 10;
```

Spend reconciliation is the one check a single query cannot make: take `SUM(units)`, run an
expansion on a deliberately thin seed, take it again. The charge should reflect the rows that came
back, not the limit that was requested.

---

## 9. Deliberately absent

- **Semrush for backlinks, volume history and part of the competitor reports.** Ahrefs is roughly
  four times cheaper for everything this module does, and it works. The stubs return
  `provider_unsupported` and the UI says "Ahrefs only".
- **Fetching on render.** No screen can spend money by being opened.
- **Paid MCP calls without confirmation.** See §6.
- **Guessing a market from a generic TLD.** See §5.
