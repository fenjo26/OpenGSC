---
name: gsc-performance-review
description: "Review a site's Google Search Console performance via the OpenGSC MCP: find striking-distance wins, cannibalization conflicts, and weak pages, and produce a prioritized action plan."
---

# OpenGSC Performance Review

## Goal

Turn a site's synced GSC data into a short, prioritized list of actions: which queries to push onto page 1, which pages to consolidate, and where better titles/meta could unlock clicks.

## Required inputs

- The site (domain). If unknown, call `list_sites` first and ask the user which site to review.
- Optional: lookback window in days (default 90 for opportunity analysis, 28 for the traffic overview).

## OpenGSC MCP tools

- `list_sites`: discover connected sites and their exact identifiers.
- `get_search_performance`: totals + top queries/pages. Run once with `dimension=query` and once with `dimension=page`.
- `get_striking_distance`: queries at positions 4–20 with real impressions — the fastest wins. The default band is right for most reviews; tighten to 4–10 for "almost there" pages only.
- `get_cannibalization`: queries where 2+ of the site's own URLs compete; high-impression conflicts with close positions are consolidation candidates.
- `get_rank_tracker`: tracked-keyword positions with direction (latest vs previous) — cross-reference against GSC average position when both exist.
- `get_ctr_benchmark`: top-10 queries whose real CTR trails the benchmark for that position. Separates "we don't rank" from "we rank and nobody clicks" — two different fixes.
- `get_content_decay`: pages trending down. A decaying page in the striking-distance list is a refresh, not a new piece.
- `get_content_groups`: if the user has defined Content Groups or Topic Clusters, report by section rather than by URL — it is how they think about the site.
- `compare_periods`: winners, losers, new and lost queries versus the previous window.

## Workflow

1. Resolve the site with `list_sites` if needed.
2. Pull the overview: `get_search_performance` with `dimension=query` (28 days), then `dimension=page`.
3. Pull `get_striking_distance` (90 days). Rank opportunities by impressions × closeness to page 1.
4. Pull `get_ctr_benchmark` (90 days). Anything ranking top-10 with a large negative `diff` is a title/meta fix — cheaper and faster than any content work, so it goes near the top of the plan.
5. Pull `get_cannibalization` (90 days). Flag conflicts where the "loser" URL takes a meaningful share of impressions.
6. Pull `get_content_decay`. Pages already sliding need a refresh before they need optimization.
7. If tracked keywords exist, pull `get_rank_tracker` and note keywords moving down.
8. Synthesize a plan. Every recommendation must name a concrete query AND page from the data. For anything that turns into "rewrite this page", hand off to the `page-optimization` skill rather than writing it here.

## Output format

Start with the top 3 actions ("do this first"), each with the expected effect. Then:

| Priority | Action | Query | Page | Evidence |
| -------- | ------ | ----- | ---- | -------- |

Close with anything that needs the user's judgment (e.g. two cannibalizing pages that both serve intent).

## Guardrails

- Do not invent metrics or queries. If a tool returns no data, say so and suggest the user syncs the site in OpenGSC first.
- Positions are averages over the window — call them "avg position", not "rank".
- Do not recommend deleting pages; recommend merge/redirect/differentiate and let the user decide.
