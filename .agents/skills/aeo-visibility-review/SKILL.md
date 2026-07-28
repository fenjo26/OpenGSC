---
name: aeo-visibility-review
description: "Assess how visible a site is in AI answer engines (ChatGPT, Perplexity, Claude, Grok) using OpenGSC's AEO Tracker data, and recommend how to win uncited questions."
---

# OpenGSC AEO Visibility Review

## Goal

Tell the user where they stand in AI search: which tracked questions cite/mention their site per engine, where they're invisible, and what content or authority signals would most plausibly change that.

## Required inputs

- The site (domain). Call `list_sites` if unknown.

## OpenGSC MCP tools

- `get_aeo_visibility`: tracked questions with the latest per-engine cited/not-cited state. Engines using live web search (ChatGPT, Perplexity) signal citation; Claude/Grok signal brand mention.
- `get_search_performance` (`dimension=query`): questions people already find the site with in Google — candidates to add to AEO tracking.
- `get_striking_distance`: pages close to page 1 often correlate with citability — sources AI search tends to pick up.
- `get_geo_audits`: stored GEO audit reports. Where AEO tracks the same questions over time, these are one-off deep audits of a single query — they name which competitors AI search cited and why, which is the "what does a citable source look like here" evidence the scoreboard lacks.
- `fetch_page_content`: pull a page that *did* get cited and read what makes it quotable — direct answers up top, named entities, data points, visible dates.

## Workflow

1. Pull `get_aeo_visibility`. Build a per-engine scoreboard: cited / not cited / never checked.
2. Classify the losses: invisible everywhere (content gap) vs cited by search-grounded engines only (authority/mention gap) vs mentioned but not cited (formatting/source-quality gap).
3. Cross-reference with `get_search_performance`: strong Google queries with zero AI citations are the highest-leverage fixes — the content already ranks, it needs to become quotable (clear answers, data points, named entities, updated dates).
4. Suggest 3–5 new questions worth tracking, phrased the way real users ask assistants.

## Output format

- Scoreboard table: question × engine (✓ cited / ✗ not / — unchecked).
- Diagnosis per losing question (one line each).
- Prioritized fixes: content changes first, then authority plays.
- Suggested new questions to track.

## Guardrails

- An unchecked engine is "no data", not "not cited".
- Engine coverage differs (citation vs mention detection) — do not compare raw counts across engines as if equivalent.
- Do not promise citation outcomes; frame as probability-raising moves.
