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
| **paid** | Spends **your own** AI credits | Refuses to run without `confirm: true` |

The paid tier is two tools (`rewrite_content`, `start_generation_job`). Both refuse to run
unless the agent passes `confirm: true`, and both point at the free path in their own
descriptions — because an agent connected to OpenGSC is itself a language model, and paying a
second one to write text the first could have written is money for nothing. See
[Optimizing a page](#5-optimizing-a-page) for the free workflow.

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

**Claude Desktop** — Settings → Connectors → *Add custom connector*: URL as above, and add the
`Authorization: Bearer ogsc_YOUR_TOKEN` header.

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

## 3. Available tools

### Search performance (local)

| Tool | Returns |
|---|---|
| `get_capabilities` | Instance overview: tool list by cost tier, data freshness, which modules have data — call first |
| `list_sites` | Every connected site across all Google accounts |
| `get_search_performance` | GSC totals + top queries/pages for a date window; `page` param scopes to one page |
| `compare_periods` | Period-over-period deltas: winners, losers, new & lost queries/pages |
| `get_striking_distance` | Queries at positions 4–20 with impressions — fastest wins |
| `get_cannibalization` | Queries where 2+ of the site's own URLs compete |
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
| `rewrite_content` | **paid** | The app's own Content Rewriter: N scored variants, optional refreshed snippet |
| `start_generation_job` | **paid** | The full outline/article pipeline as a background job |

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

Reach for `rewrite_content` (paid) when you want the app's own pipeline rather than your
agent's prose — its editorial policy, its banned-word list from the AI-Fingerprint Lab, or
Casino RAG grounding. `start_generation_job` (paid) runs the full outline/article pipeline in
the background, since it takes minutes; poll it with `get_generation_job`.

## Troubleshooting

**You get an HTML login page, or a 307 to `/api/auth/signin`.** Your instance predates the
middleware fix — `withAuth` was matching `/api/mcp` and redirecting before the route could
read your `Authorization` header. Update and rebuild:

```bash
cd /root/opengsc && git pull && npm install && npx prisma db push && npm run build && pm2 restart opengsc
```

**Checking a connection by hand.** `GET https://your-domain.com/api/mcp` returns JSON
describing the server and whether your token was accepted, and `GET /api/mcp/tools` returns
the registry as plain JSON. Neither is part of the MCP protocol — clients POST JSON-RPC to
`/api/mcp` — but they turn "it doesn't work" into a specific answer:

```bash
curl -s https://your-domain.com/api/mcp/tools -H "Authorization: Bearer ogsc_YOUR_TOKEN"
```

A 401 means the token is wrong or was rotated; anything else means the URL or the proxy is.

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
