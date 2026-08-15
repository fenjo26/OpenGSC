# MCP Setup — Connect AI Agents to OpenGSC

OpenGSC exposes an MCP (Model Context Protocol) server at `/api/mcp`, so AI agents can query
your SEO data directly: Claude Code, Claude Desktop, Cursor, Codex CLI, or any MCP-capable
client.

Tools are grouped by what calling one actually costs you, and `get_capabilities` reports the
grouping so an agent can see it before choosing:

| Tier | What it does | Cost |
|---|---|---|
| **local** | Reads your instance's SQLite database | Free, instant — most tools |
| **quota** | Calls a Google API on your own OAuth | Free, but spends Google's daily quota |
| **net** | Fetches a third-party page over HTTP | Free |
| **paid** | Spends **your own** AI or DataForSEO credits | Refuses to run without `confirm: true` |

The paid tier is three tools. `start_rewrite_job` and `start_generation_job` spend AI credits;
`research_keywords` spends DataForSEO credits. All three refuse to run unless the agent passes
`confirm: true`, and all three name the free alternative in their own descriptions — because an
agent connected to OpenGSC is itself a language model, and paying a second one to write text the
first could have written is money for nothing. See [Optimizing a page](#5-optimizing-a-page) for
the free workflow.

The two AI tools are asynchronous and `research_keywords` is not, which is a difference worth
understanding rather than an inconsistency. Asynchrony exists to stop a client timeout from
destroying paid work; a rewrite that finishes after the caller has gone is written nowhere.
Keyword discovery does not have that failure mode, because the result is stored before the tool
returns — an abandoned call still leaves the search in the cache, where the next call and the
web UI both read it for free.

## 1. Generate a token

**Settings → API & MCP → Generate token.** The token (`ogsc_…`) grants read access to all
your OpenGSC data — treat it like a password; you can rotate or revoke it on the same page.

## 2. Connect your client

The endpoint is `https://your-domain.com/api/mcp` (Streamable HTTP transport).

**Claude Code**

```bash
claude mcp add --transport http opengsc https://your-domain.com/api/mcp \
  --header "Authorization: Bearer ogsc_YOUR_TOKEN"
```

**Claude Desktop** — Settings → Connectors → *Add custom connector*, and paste the token into
the **URL**:

```text
https://your-domain.com/api/mcp?token=ogsc_YOUR_TOKEN
```

Leave **Advanced settings** empty. Those two fields are *OAuth Client ID* and *OAuth Client
Secret* — Claude Desktop's connector dialog has no field for an `Authorization` header, so a
token pasted there is read as an OAuth client id, does nothing, and the connector fails
without explaining why. That is the single most common reason this does not connect. Claude
Code, Cursor and Codex all send headers properly; only the Desktop dialog is limited.

The trade-off of a token in a URL is that it appears in your nginx access log and in whatever
stores the connector config, where a header would not. Over HTTPS it is encrypted in transit
like any other part of the request, and you can rotate it from Settings at any time. If you
would rather keep it out of the URL, use the `mcp-remote` bridge instead — Settings →
Developer → *Edit Config*, then restart Claude Desktop (needs Node.js installed):

```json
{
  "mcpServers": {
    "opengsc": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-domain.com/api/mcp",
               "--header", "Authorization: Bearer ogsc_YOUR_TOKEN"]
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "opengsc": {
      "url": "https://your-domain.com/api/mcp",
      "headers": { "Authorization": "Bearer ogsc_YOUR_TOKEN" }
    }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.opengsc]
url = "https://your-domain.com/api/mcp"
http_headers = { "Authorization" = "Bearer ogsc_YOUR_TOKEN" }
```

Then try: *“Look at mysite.com in OpenGSC — which keywords are in striking distance and what
should I do first?”*

### Tokens and team roles

A token belongs to a person, and that person has a workspace role. An agent therefore reads the
owner's data — there is no other data on the instance — but inherits the same ceiling as its holder:
a viewer's token cannot call a tool that writes, and only `admin` or the owner can call the three
paid tools. A suspended member's token stops working on the next call.

## 3. Available tools

### Search performance (local)

| Tool | Returns |
|---|---|
| `get_capabilities` | Instance overview: tool list by cost tier, data freshness, which modules have data — call first |
| `list_sites` | Every connected site across all Google accounts |
| `get_search_performance` | GSC totals + top queries/pages for a date window; `page` param scopes to one page |
| `compare_periods` | Period-over-period deltas: winners, losers, new & lost queries/pages |
| `get_striking_distance` | Queries at positions 4–20 with impressions — fastest wins |
| `get_cannibalization` | Exact-query conflicts by default; `mode=related` adds deterministic related-intent clusters, page roles, flip-flops and review-only actions |
| `get_content_decay` | Pages trending down, with per-bucket history; Warning past −5%, Critical past −25% |
| `get_ctr_benchmark` | Top-10 queries whose real CTR trails the benchmark for their position — a snippet problem, not a content one |
| `get_content_groups` | Your Content Groups and Topic Clusters with aggregate performance |
| `get_engine_performance` | Bing / Yandex portfolio from the server-side snapshot |

### Rankings, visibility and links (local)

| Tool | Returns |
|---|---|
| `get_rank_tracker` | Tracked keyword positions with direction |
| `get_rank_history` | Every RankCheck point per keyword — the trend, not just the latest standing |
| `get_aeo_visibility` | AI answer-engine citation state per tracked question |
| `get_geo_audits` | Stored GEO audit reports: who AI search cites for a query |
| `get_backlinks` | The site's own backlink inventory with liveness/index status |
| `get_link_mentions` | Competitor backlinks (Link Monitor) + multi-linker domains |

### Outreach Workspace (local)

These tools extend Link Monitor's saved evidence into a manual pipeline. They are separate from
Site Audit, GEO Audit and AI Visibility. None sends email, fetches a publisher or spends API
credits.

| Tool | Mode | Returns / changes |
|---|---|---|
| `list_outreach_prospects` | read-only | Campaigns, prospects, evidence, stages, follow-ups and won-link state |
| `save_outreach_prospect` | local write, idempotent | Saves one domain/source as a prospect; duplicate domains return the existing row |
| `update_outreach_prospect` | local write, idempotent | Updates stage/contact/follow-up and records stage history |
| `create_outreach_campaign` | local write | Creates a grouping/measurement campaign; it does not launch anything |

### Source Audit (local, read-only)

Static findings from Content Operations → Source Audit, which scans a bounded snapshot of a
connected GitHub branch **before** deployment. It is not the runtime Site Audit crawler, and it
shares no data with AI Visibility or SEO Tools → GEO.

| Tool | Mode | Returns / changes |
|---|---|---|
| `get_source_audit` | read-only | Stored runs: score, severity counters, rule id, file path and line, evidence, confidence, and whether the snapshot was truncated. Starting a run stays a deliberate action in the UI |

### Market data — demand, difficulty, competitors

Everything Search Console cannot see: how much demand exists, how hard a keyword is, and who is
winning it. The cached tools read data a human already paid for; only `research_keywords` can
create new data, and it is the one that costs money.

| Tool | Tier | Returns |
|---|---|---|
| `get_keyword_demand` | local | **Start here.** Keyword research already stored, joined against the site's own GSC positions — each row verdicted as reach / wrong_page / none. With no seed, lists what has been researched |
| `get_keyword_metrics` | local | Volume, difficulty and CPC for specific keywords from the metric cache. Missing ≠ zero volume |
| `get_competitor_gap` | local | Competitors' keywords joined against your GSC data, bucketed close / weak / missing |
| `get_domain_metrics` | local | Referring domains, backlinks, estimated traffic for any domain in the cache |
| `get_backlink_profile` | local | A site's referring domains, live and lost, with stored history |
| `research_keywords` | **paid** | Discovers a market from one seed via DataForSEO and verdicts every row against your GSC. ~$0.03 per call at 150 rows. Check `get_keyword_demand` first — a seed researched in the last 14 days is free |

### Health, indexing and infrastructure (local)

| Tool | Returns |
|---|---|
| `get_site_health` | SSL / Safe Browsing / VirusTotal / Core Web Vitals snapshot |
| `get_indexing_status` | Sitemap index-status counts + recent URL inspections (cached) |
| `get_site_audit` | Latest built-in-crawler audit: health score, issues, affected URLs |
| `get_clarity` | Microsoft Clarity behaviour data: dead clicks, rage clicks, scroll depth |
| `get_indexer_stats` | Private indexer network: per-domain verified bot hits, 304 rate, never-crawled domains |
| `get_alerts` | Alerts that actually fired: rank drops, traffic drops, SSL expiry, low audit scores |
| `get_digests` | Previously generated portfolio digests |
| `execute_sql_query` | An arbitrary read-only SELECT against the local SQLite tables (advanced analysis) |

### Content optimization

| Tool | Tier | Returns |
|---|---|---|
| `get_optimization_brief` | net | **Start here.** Everything known about one URL in one call: its queries, striking-distance keywords, CTR gaps, decay trend, cannibalization conflicts, audit issues and live content |
| `fetch_page_content` | net | Any URL as clean article Markdown, boilerplate stripped |
| `analyze_text` | local | Deterministic check of a draft: uniqueness, invented/dropped numbers and identifiers, heading-structure match, machine tells. No model called |
| `get_generations` | local | The SEO Tools history — what has already been written, so you extend instead of duplicating |
| `get_generation_job` | local | Poll a background generation job |
| `start_rewrite_job` | **paid** | The app's own Content Rewriter over up to 20 pages, in the background; each page saved as it finishes |
| `start_generation_job` | **paid** | The full outline/article pipeline as a background job. Finished results land in SEO Tools → History, so agent-generated outlines show up in the UI's structure picker and in `get_generations` |

### Live Google calls (quota)

| Tool | Returns |
|---|---|
| `query_gsc_live` | LIVE Search Analytics with country/device/date dimensions |
| `inspect_url` | LIVE URL Inspection for up to 10 URLs (also updates the Indexing tab) |
| `get_analytics` | LIVE GA4: sessions, engagement, key events, revenue vs the previous period |

### Custom SQL Queries
Using the `execute_sql_query` tool, your AI agent can perform advanced custom analyses by executing SQLite queries. Key read-only tables include:
- `Site` (id, url, siteId, tags, brandedKeywords, clarityProjectId, ga4PropertyId)
- `DailyMetric` (siteId, date, url, query, clicks, impressions, ctr, position)
- `TrackedKeyword` (keyword, country, device, lastPosition, prevPosition, lastUrl)
- `SitemapUrl` (siteId, url, googleStatus, googleChecked, xrStatus)
- `SiteAudit` (siteId, status, finishedAt, pagesCrawled, summary)
- `Backlink` (siteId, url, title, isAlive, xrStatus)

Safety model: the query runs on a **separate SQLite connection opened read-only at the
engine level** (writes are impossible regardless of query text), only a single
SELECT/WITH statement is accepted, the credential tables (`User`, `Account`, `Session`)
are blocked entirely, results are capped at 500 rows, and rows carrying a `userId`/`siteId`
column are additionally scoped to your own sites.

## 4. Agent skills

The repo ships ready-made skills in [`.agents/skills/`](../.agents/skills/) that orchestrate
these tools into complete workflows:

- `gsc-performance-review` — striking distance + cannibalization → prioritized action plan
- `page-optimization` — decay/CTR → brief → rewrite → deterministic verification
- `seo-production` — demand evidence → approved outline → claim ledger → draft → deterministic verification → package for Content Operations
- `link-prospecting` — Link Monitor mentions → outreach shortlist with pitch angles
- `aeo-visibility-review` — AI-search scoreboard → how to win uncited questions
- `site-triage` — health + indexing + traffic → "is anything on fire?" report

For Claude Code, copy them into your project's `.claude/skills/` (or reference the folder in
your agent's skills configuration). Each skill documents its required inputs, tool sequence,
output format, and guardrails.

## 5. Optimizing a page

The intended flow costs you nothing beyond what you already pay your agent:

1. `get_content_decay` or `get_ctr_benchmark` — find the page worth fixing. Decay means the
   content aged; a CTR gap at a good position means the snippet is wrong, not the article.
2. `get_optimization_brief` with that URL — one call returns its queries, striking-distance
   keywords, CTR gaps, six-month trend, cannibalization conflicts, audit issues and the live
   page as Markdown.
3. **Your agent writes the new version.** It is a language model with the brief in context;
   it does not need OpenGSC to call a second one.
4. `analyze_text` with the original as `source` — deterministic, no model, always the same
   answer. Reports uniqueness, heading-structure drift, and any number or identifier that
   appears in the draft but not the source. That last one is the check that matters: a
   rewrite nobody rereads is exactly how a wrong price gets published.

Reach for `start_rewrite_job` (paid) when you want the app's own pipeline rather than your
agent's prose — its editorial policy, its banned-word list from the AI-Fingerprint Lab, or
Casino RAG grounding. It takes up to 20 URLs and works through them in the background;
`start_generation_job` (paid) runs the full outline/article pipeline the same way. Both
return a job id immediately and are polled with `get_generation_job`.

For articles, drive `start_generation_job` the way the UI does: an `outline` (or
`outline_auto`) job first — with `keyword`, `country`, `language` top-level, and
`keywordIdeas: {}` to run the UI's "load keywords" step server-side (real ideas with
volumes from the user's Ahrefs/Semrush/DataForSEO key, billed against the same monthly
cap as the button) — then a `text` job with `outlineId` set to that job's id — the
server loads the outline itself, with its facts bank, keyword and language, exactly like
the Text generator's structure picker. Passing a raw outline in `payload.outline` also
works (wrapped shapes from `get_generations`/`get_generation_job` are unwrapped), but
anything without `.sections` is rejected instead of silently writing an article from an
empty prompt. The text step's form fields — `language`, `tone`, `sourceMode`,
`promptType` + `custom`, `includeToc`, `targetWordCount`, `temperature`, `bannedWords` —
are top-level arguments with the UI's defaults.

### Why the paid tools never return text directly

Rewriting one page means fetching it, then a model call producing up to 8000 tokens, then a
repair pass when the value audit finds drift. That is minutes of work, and the per-call
ceiling inside OpenGSC is 280 seconds. MCP clients abandon a tool call after 30–60.

The failure that follows is worse than a slow response, and it is why raising a timeout is
not the fix. **When the client gives up, the server does not.** The model call completes, the
credits are spent, and the result is handed back to a caller that stopped listening — so it
is written nowhere. Every abandoned attempt is a rewrite you paid for and cannot read, and
retrying pays again.

So the paid tools persist before anyone asks. `start_rewrite_job` writes each page into the
job row the moment that page finishes, which means a client timeout, a closed laptop, a PM2
restart or a crash costs at most the single page in flight — everything already paid for
stays retrievable:

```text
start_rewrite_job  { urls: [...20 urls], confirm: true }  → jobId, immediately
get_generation_job { jobId }                              → 6 of 20 done, 1 failed, names the current page
get_generation_job { jobId, page: "/pricing" }            → that page's full rewritten text
get_generation_job { jobId, includeContent: true }        → everything finished so far
```

Polling early is expected and returns partial work rather than nothing. Do not start a second
job while one is running — `start_rewrite_job` refuses, precisely because an agent that polls,
sees an unfinished batch and starts again is an easy way to pay twice for the same page.

Long generations are protected from the other direction too. A job silent for 20 minutes is
treated as a dead process and failed, so a genuinely long article risked being reported as
broken while it was still working; jobs now send a heartbeat every 60 seconds, and the sweep
means what it was meant to mean — silence is a crash, not slowness.

## Troubleshooting

**You get an HTML login page, or a 307 to `/api/auth/signin`.** Your instance predates the
request-gate fix — `withAuth` was matching `/api/mcp` and redirecting before the route could
read your `Authorization` header. (The gate lives in `src/proxy.ts`; it was `src/middleware.ts`
until Next.js 16 renamed the convention.) Update and rebuild:

```bash
cd /root/opengsc && git pull && npm install && npx prisma db push && npm run build && pm2 restart opengsc
```

**Claude Desktop says the connector failed, with no detail.** Almost always the token was
put into *Advanced settings* rather than the URL — see the Claude Desktop step above. Those
fields are OAuth client credentials, not a place for this token. Clear them, and put
`?token=ogsc_…` on the end of the URL instead.

**Checking a connection by hand.** `GET https://your-domain.com/api/mcp` returns JSON
describing the server and whether your token was accepted, and `GET /api/mcp/tools` returns
the registry as plain JSON. Neither is part of the MCP protocol — clients POST JSON-RPC to
`/api/mcp` — but they turn "it doesn't work" into a specific answer:

```bash
curl -s https://your-domain.com/api/mcp/tools -H "Authorization: Bearer ogsc_YOUR_TOKEN"
curl -s "https://your-domain.com/api/mcp/tools?token=ogsc_YOUR_TOKEN"   # the Desktop form
```

A 401 means the token is wrong or was rotated; anything else means the URL or the proxy is.
If the header form works and the query form does not, your reverse proxy is stripping the
query string.

**A tool reports the table is not available.** That instance has not run `npx prisma db push`
since the model was added. Tools degrade to an empty result with a note rather than failing
the whole call, so this shows up as a missing module rather than a broken agent.

## Security notes

- The token authorizes access to everything the owning account sees. One token per
  account; rotating invalidates the old one immediately.
- The endpoint is stateless JSON-RPC over HTTPS — no session is stored server-side.
- Paid tools cannot fire by accident: they refuse to run without an explicit
  `confirm: true`, so an agent exploring the registry cannot bill you for a call it made to
  see what came back.
- Keep your instance behind HTTPS (the default VPS install does this via Let's Encrypt);
  never paste the token into untrusted tools.
