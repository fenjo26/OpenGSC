---
name: seo-production
description: "Produce a new article end to end through the OpenGSC MCP: demand evidence, an approved outline, a claim ledger, the draft, deterministic verification, and a package ready for Content Operations. For refreshing an existing page use page-optimization instead."
---

# OpenGSC SEO Production

## Goal

Turn a topic into a publishable article that is grounded in this instance's own data, where every
factual claim can be traced to a source the user can open. The deliverable is a content package,
not a wall of prose: brief, outline, draft, claim ledger and the verification output.

Use `page-optimization` instead when the page already exists and underperforms. This skill is for
something new.

## Required inputs

- The site. Call `list_sites` if the user has not named one.
- A topic, a seed keyword, or a target page. Anything vaguer than that, ask.

## OpenGSC MCP tools

- `get_keyword_demand`: **start here.** Research already stored, joined against the site's own GSC
  positions, each row verdicted `reach` / `wrong_page` / `none`. Free.
- `get_competitor_gap`: competitors' keywords bucketed close / weak / missing — what the market
  covers and this site does not.
- `get_search_performance` and `get_striking_distance`: what the site already ranks for. A new
  article that targets an existing strength creates a cannibalization problem instead of traffic.
- `get_cannibalization`: run it before writing, not after. If an existing URL already owns the
  intent, the honest recommendation is to extend that page.
- `get_generations`: what has already been written here, so a "new" article is not a near-duplicate
  of one from three months ago.
- `fetch_page_content`: any competing URL as clean Markdown. This is the sourcing tool.
- `analyze_text`: deterministic check of the finished draft. No model call, same answer every time.
- `research_keywords`: **paid.** Only when demand data is genuinely missing and the user asks.

## Workflow

1. **Task card.** Before any writing, state in five lines: target query, secondary queries, search
   intent, the reader, and what the page must let them do. Get it confirmed. Everything downstream
   is judged against this card.
2. **Demand evidence.** `get_keyword_demand`, then `get_competitor_gap`. If neither shows real
   volume, say so plainly — "no demand data" is a finding, not a reason to invent an audience.
   Missing metrics mean *not measured*, never zero.
3. **Conflict check.** `get_cannibalization` and `get_search_performance` for the target query. An
   existing ranking URL means: recommend extending it and stop, unless the user overrides.
4. **Source pass.** `fetch_page_content` on the two or three URLs currently ranking. Read them for
   what the intent actually demands — sections, depth, format — not for sentences to reuse.
5. **Outline first.** H2/H3 structure, one line per section on what it answers and which source
   backs it. Show the outline and wait. Writing before the outline is agreed wastes the draft.
6. **Claim ledger.** Every number, date, price, statistic or named study in the outline gets a row:
   the claim, its source URL, and the date it was retrieved. A claim with no row does not enter the
   draft. This is what keeps the article defensible later.
7. **Write.** Fill the approved outline. Concrete over decorative; the reader's task over the word
   count. Every ledger claim keeps its number exactly as sourced.
8. **Verify.** `analyze_text` with the draft as `text` and the concatenated sources as `source`.
   Read it as a gate, not a score:
   - `factDrift.severity: danger` — numbers appear in the draft that no source contains. Fix before
     showing anyone. This is the check that stops an invented price from shipping.
   - `structure.ok: false` — the draft drifted from the approved outline.
   - machine tells — fix the specific ones reported, then re-run `analyze_text`. Editing for
     naturalness can silently reintroduce drift, so the last run must be the one you report.
9. **Package.** Hand over title, meta description, slug, the article, the claim ledger and the
   verification output. Content Operations is where the human moves it: queue → approval → review →
   diff → pull request. This skill never opens a PR and never publishes.

## Output format

- The task card, one line per field.
- Demand evidence: query, volume, current position, verdict — as a table.
- The approved outline.
- The article.
- The claim ledger:

| Claim | Source | Retrieved |
| ----- | ------ | --------- |

- The `analyze_text` verdict verbatim: uniqueness, fact drift, structure, tells.
- Open questions: anything you could not source, stated as a question rather than smoothed over.

## Guardrails

- **Never invent experience.** No "when I tested this", no fabricated case studies, no invented
  customer quotes. Fake first-hand experience is the one E-E-A-T signal that turns into a liability
  the moment a reader checks. If the article needs experience it does not have, ask the user for it.
- **Never write around a missing source.** Drop the claim or ask. A sentence engineered to sound
  sourced without being sourced is worse than an obvious gap.
- **Do not optimize for AI detectors.** Detector-dodging rewrites damage the text and prove nothing.
  `analyze_text` reports machine tells so you can fix real habits — em-dash pile-ups, "furthermore",
  "it is important to note" — not so you can game a classifier.
- **Do not call the paid tools without being asked.** `research_keywords`, `start_generation_job`
  and `start_rewrite_job` spend the instance owner's own credits and refuse to run without
  `confirm: true`. Never set that flag to work around the refusal. You have the brief in context —
  writing the draft yourself costs nothing extra.
- **Respect the editorial policy.** The instance owner's style guide and banned-word list live in
  SEO Tools → Editorial Policy. If the user has one, ask for it and apply it; do not invent a
  house style.
- One article per run. Bulk production is what the app's own paid pipeline is for, and that is the
  user's decision to make, not yours.
