# MCP Server (AI Agents)

OpenGSC has a built-in **Model Context Protocol** server at `/api/mcp` with **95 tools**. Claude Code, Claude Desktop, Cursor, Codex CLI or any MCP client can work with your SEO data directly. Ask *"Which keywords on mysite.com are in striking distance, and what should I fix first?"* and the agent reads the answer from your own instance.

## 1. Create a token

**Settings → Integrations → Generate token.** The token (`ogsc_…`) grants access to your workspace data, so treat it like a password. Rotate or revoke it on the same page; rotating invalidates the old one immediately.

A token belongs to a person and inherits their **role**: a viewer's token can't call tools that write, and only Admin/Owner tokens can call paid tools. A suspended member's token stops working on the next call.

## 2. Connect your client

Endpoint: `https://your-domain.com/api/mcp` (Streamable HTTP).

**Claude Code**

```bash
claude mcp add --transport http opengsc https://your-domain.com/api/mcp \
  --header "Authorization: Bearer ogsc_YOUR_TOKEN"
```

**Claude Desktop**: Settings → Connectors → *Add custom connector*. Put the token **in the URL**:

```text
https://your-domain.com/api/mcp?token=ogsc_YOUR_TOKEN
```

**Leave "Advanced settings" empty.** Those fields are OAuth Client ID / Secret. A token pasted there does nothing, and the connector fails without saying why. This is the most common reason Desktop doesn't connect.

If you'd rather keep the token out of the URL, use the `mcp-remote` bridge (Settings → Developer → Edit Config; needs Node.js):

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

**Cursor** (`.cursor/mcp.json`)

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

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.opengsc]
url = "https://your-domain.com/api/mcp"
http_headers = { "Authorization" = "Bearer ogsc_YOUR_TOKEN" }
```

## 3. Cost tiers

Every tool declares what calling it costs. **Call `get_capabilities` first**: it groups tools by tier and reports which modules actually hold data.

| Tier | Meaning | Cost |
|---|---|---|
| **local** | Reads your instance's database | Free, instant: the large majority |
| **quota** | Calls Google on your OAuth (`query_gsc_live`, `inspect_url`, `get_analytics`) | Free, spends Google's daily quota |
| **net** | Fetches a third-party page over HTTP | Free |
| **paid** | Spends your own AI / SERP / metrics credits | **Refuses to run without `confirm: true`** |

Paid tools include `start_rewrite_job`, `start_generation_job`, `research_keywords`, `check_plagiarism`, `serp_index_check`, the paid drops enrichments, `publish_post` with AI respin and geo-grid scans. An agent exploring the tool list can't bill you by accident. Link **purchases** aren't exposed over MCP at all.

## 4. What's available

| Area | Example tools |
|---|---|
| Search performance | `list_sites`, `get_search_performance`, `compare_periods`, `get_striking_distance`, `get_cannibalization`, `get_content_decay`, `get_ctr_benchmark`, `get_content_groups`, `get_engine_performance` |
| Rankings and AI visibility | `get_rank_tracker`, `get_rank_history`, `get_aeo_visibility`, `get_ai_share_of_voice`, `get_brand_mentions`, `get_geo_audits`, `get_yandex_ai_answers` |
| Links and outreach | `get_backlinks`, `get_backlink_profile`, `get_backlink_toxicity`, `get_disavow_file`, `get_link_mentions`, `list_outreach_prospects`, `save_outreach_prospect`, `update_outreach_prospect`, `create_outreach_campaign` |
| Market data | `get_keyword_demand`, `get_keyword_metrics`, `get_competitor_gap`, `get_domain_metrics`, `research_keywords` (paid) |
| Health and indexing | `get_site_health`, `get_uptime`, `get_indexing_status`, `get_index_coverage`, `get_site_audit`, `get_clarity`, `get_indexer_stats`, `get_alerts`, `get_digests`, `inspect_url` (quota) |
| Content | `get_optimization_brief`, `fetch_page_content`, `analyze_text`, `fit_meta`, `get_generations`, `get_generation_job`, `start_rewrite_job`, `start_generation_job` |
| Site memory | `get_site_context`, `update_site_context` |
| Local, trends, reports | `get_local_profile`, `check_nap`, `local_grid_*`, `get_trends`, `get_footprints`, `list_reports`, `list_leads`, `get_source_audit` |
| SERP Monitor, Drops, Publishing | `serpmon_*`, `drops_*`, `glue_*`, `publish_*` |
| Advanced | `execute_sql_query`: a single read-only `SELECT` on a read-only SQLite connection, owner's token only, credential tables and secret columns (tokens, keys, passwords) refused, 500-row cap, scoped to your sites |

The full list with descriptions: [docs/MCP-SETUP.md](https://github.com/fenjo26/OpenGSC/blob/main/docs/MCP-SETUP.md), or `GET /api/mcp/tools` with your token.

## Optimizing a page for free

Your agent is already a language model, so it doesn't need to pay a second one to write.

1. `get_content_decay` or `get_ctr_benchmark` finds a page worth fixing. Decay means the content aged; a CTR gap at a good position means the snippet is wrong.
2. `get_optimization_brief` with that URL returns its queries, striking-distance keywords, CTR gaps, six-month trend, cannibalization conflicts, audit issues and the live page as Markdown, in one call.
3. **The agent writes the new version.**
4. `analyze_text` with the original as `source`: a deterministic check (no model) for uniqueness, heading-structure drift, and any number or identifier that appears in the draft but not the source.

Use `start_rewrite_job` / `start_generation_job` (paid) when you specifically want the app's own pipeline: your editorial policy, banned-word list, Casino RAG. Both are **asynchronous**. They return a job id immediately, save each finished page as it completes, and are polled with `get_generation_job`. A client timeout can't throw away work you've paid for. Don't start a second rewrite while one is running; the tool refuses.

## Agent skills

The repo ships ready-made workflows in [`.agents/skills/`](https://github.com/fenjo26/OpenGSC/tree/main/.agents/skills): `gsc-performance-review`, `page-optimization`, `seo-production`, `keyword-research`, `link-prospecting`, `aeo-visibility-review`, `site-triage`, `drops-research`. For Claude Code, copy them into `.claude/skills/` in your project.

## Troubleshooting

| Symptom | Fix |
|---|---|
| HTML login page or `307` to `/api/auth/signin` | Your instance is too old; update it |
| Claude Desktop "connector failed", no detail | Token was put in *Advanced settings*. Clear them and put `?token=…` on the URL |
| `401` | Wrong or rotated token |
| Header form works, `?token=` form doesn't | Your reverse proxy strips query strings |
| "Table not available" from a tool | The instance hasn't run `npx prisma db push` since that module was added; update |

Check by hand:

```bash
curl -s https://your-domain.com/api/mcp/tools -H "Authorization: Bearer ogsc_YOUR_TOKEN"
curl -s "https://your-domain.com/api/mcp/tools?token=ogsc_YOUR_TOKEN"
```
