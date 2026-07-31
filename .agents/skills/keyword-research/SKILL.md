---
name: keyword-research
description: "Turn a seed topic into a prioritized keyword plan via the OpenGSC MCP: start from the demand you already have in Search Console, discover the market around it, and separate the terms worth a rewrite from the ones worth a new page."
---

# OpenGSC Keyword Research

## Goal

Produce a short list of keywords the user should act on, each one labelled with what the action
actually is — improve an existing page, fix an intent mismatch, or write something new. Volume
alone is not a plan.

## The free path comes first

Only one tool here spends money, and most research questions are answered without it. Work in
this order and stop as soon as the answer is good enough:

1. **Queries the site already earns.** `get_search_performance`, `get_striking_distance`.
2. **Research already bought.** `get_keyword_demand` — a seed researched in the last 14 days
   comes back at no cost, and with no seed it lists everything already stored.
3. **Metrics already cached.** `get_keyword_metrics` for volume/difficulty on a fixed list.
4. **Only then** `research_keywords`, which is PAID and needs explicit permission.

An agent that opens with the paid tool has skipped three sources of the same information.

## Required inputs

- The site. If unknown, call `list_sites` first and ask which one.
- One or more seed topics, products, or audience problems.
- Optional: market (2-letter country code, default `us`) and language.

If the market would materially change the numbers and the user has not said, ask. A German
market research run against `us` is not a smaller answer, it is a wrong one.

## OpenGSC MCP tools

- `get_striking_distance`: queries at positions 4–20 with real impressions. This is demand the
  site has already proven it can reach — it outranks anything discovery returns.
- `get_keyword_demand`: stored research joined against the site's own GSC positions. Every row
  carries a verdict (see below). Free. Call before anything paid.
- `get_keyword_metrics`: volume, difficulty and CPC for a known keyword list, from the cache the
  UI and CSV imports fill. A keyword missing here has not been loaded — that is not zero volume.
- `research_keywords`: **PAID.** DataForSEO discovery from one seed, verdicted against GSC.
  ~$0.03 per call at the default 150 rows. Requires `confirm: true`.
- `get_competitor_gap`: keywords competitors rank for, bucketed the same way. Free, but only
  returns rows if a competitor has already been pulled in the Competitors screen.
- `get_content_groups`: if the user has Content Groups or Topic Clusters, map findings onto them
  — it is how they already think about the site.
- `get_generations`: what has already been written. Recommending a page that exists wastes the
  user's time and makes the rest of the report look unchecked.

## The three verdicts

Both `get_keyword_demand` and `research_keywords` label every row. The label is the
recommendation; do not re-derive it from position numbers.

| Verdict | What it means | The action |
| --- | --- | --- |
| `reach` | Ranks in the top 30 — the page exists and is findable | Improve that page. `ourUrl` is in the row |
| `wrong_page` | Appears in search but far down | Intent mismatch, not a quality problem. Usually a new page, or a repositioned one |
| `none` | Search Console has never shown the site for this | Net-new content |

`reach` rows are almost always the shortest path to traffic and belong at the top of the plan
regardless of volume.

## Workflow

1. Resolve the site with `list_sites`.
2. Pull `get_striking_distance` (90 days). This is the baseline: existing, provable demand.
3. Call `get_keyword_demand` with no seed to see what research already exists, then with each
   seed the user named.
4. If a seed has no stored research and the user wants the market around it, tell them what it
   will cost and ask. Only then call `research_keywords` with `confirm: true`.
5. Use `mode: "auto"` unless the user wants a specific shape of result: `related` for semantic
   neighbours, `suggestions` for the long tail containing the seed, `ideas` for the same meaning
   in different words. Auto is one billed call; running all three modes is three.
6. Leave `clickstream` off. It doubles the price and only refines volume numbers.
7. Drop branded, off-intent and duplicate terms before presenting anything.
8. Prioritize by opportunity, not volume: verdict first, then intent fit, then difficulty
   against the site's actual standing, then volume.
9. Check `get_generations` before recommending anything as new.

## Output format

Open with the three actions worth doing first and why. Then:

| Priority | Keyword | Verdict | Volume | KD | Intent | Page | Action |
| -------- | ------- | ------- | -----: | -: | ------ | ---- | ------ |

Close with what was spent (`spentUsd` from the tool response, or "nothing — served from cache")
and what the user should decide next.

## Guardrails

- **Never call `research_keywords` without asking.** The gate exists because some MCP clients
  auto-approve; asking is the point of it, not a formality.
- Do not invent metrics. `null` difficulty means the value was not returned — most often because
  the market is served by Google Ads data, which has no difficulty or intent at all. Say
  "unknown", never a guess.
- An empty `get_keyword_demand` means nobody has researched that seed. It is not evidence that
  the market is empty, and must not be reported as one.
- Positions from GSC are averages over the window. Call them "avg position", not "rank".
- For anything that becomes "rewrite this page", hand off to the `page-optimization` skill
  instead of writing the page here.
