---
name: page-optimization
description: "Refresh an underperforming page via the OpenGSC MCP: find it with decay/CTR data, pull a full optimization brief, write the new version, and verify it deterministically before it ships."
---

# OpenGSC Page Optimization

## Goal

Take one page from "it used to do better" to a rewritten draft the user can publish, with evidence for every change and a mechanical check that the rewrite did not invent a fact.

## Required inputs

- The site (domain). Call `list_sites` if unknown.
- Optionally the page. If the user has not named one, find it — that is step 1.

## OpenGSC MCP tools

- `get_content_decay`: pages trending down, with per-bucket history. The usual starting point.
- `get_ctr_benchmark`: top-10 queries whose real CTR trails the benchmark for their position.
- `get_optimization_brief`: **the main call.** Everything known about one URL — its queries, striking-distance keywords, CTR gaps, six-month trend, cannibalization conflicts, technical audit issues, and the live page as Markdown.
- `analyze_text`: deterministic verification of your draft. No model is called; the answer is the same every time.
- `get_generations`: what has already been written for this keyword, so a "refresh" does not become a second competing page.
- `fetch_page_content`: a competitor's page as clean Markdown, when the brief shows you are being outranked and you need to see by what.
- `start_rewrite_job` / `start_generation_job`: **PAID and asynchronous.** They return a job id, not text; poll `get_generation_job`. Only on explicit user request — see Guardrails.

## Workflow

1. **Find the page.** `get_content_decay` for the site (or `get_ctr_benchmark` if the user's complaint is "impressions are fine, nobody clicks"). Pick the highest-impact candidate and confirm it with the user.
2. **Diagnose before writing.** Call `get_optimization_brief` with that URL and read what kind of problem it actually is:
   - Position 4–20 with real impressions → the content is not competitive enough. Rewrite.
   - Top-10 position but a large negative `ctrGap` → the ranking is fine, the snippet is not. Change the title and meta description; leave the body alone.
   - `cannibalization` rows with meaningful impressions → another of the user's own pages is competing. Consolidation first; rewriting either page in isolation makes it worse.
   - `audit` issues like `noindex`, a canonical mismatch, or a 4xx → fix the technical problem. No amount of prose outranks a `noindex`.
3. **Check for existing work.** `get_generations` filtered by the keyword. Extend what exists rather than producing a near-duplicate.
4. **Write it yourself.** You have the brief, the current body, the target queries and the competitors' gaps in context. Keep every number, price and product name from the original unless the brief gives you a reason to change it.
5. **Verify.** `analyze_text` with your draft as `text` and the original body as `source`. Read three things:
   - `factDrift.severity` — `danger` means values appear in your draft that are not in the source. Fix them before showing the user. This is not advisory.
   - `structure.ok` — false means you dropped or added headings. Usually accidental.
   - `uniquenessPercent` — very high on a *refresh* means you rewrote rather than updated, which throws away whatever was already ranking.
6. **Present** the draft with the evidence for each substantive change.

## Output format

- One line on what kind of problem this was (content / snippet / cannibalization / technical).
- Evidence table:

| Change | Why | Evidence from the brief |
| ------ | --- | ----------------------- |

- The draft itself.
- The `analyze_text` verdict, verbatim: uniqueness, fact drift, structure.
- Anything needing the user's judgment — a fact you could not verify, a claim the source made that you could not source.

## Guardrails

- **Do not call the paid tools without being asked.** `start_rewrite_job` and `start_generation_job` spend the instance owner's own AI credits. They refuse to run without `confirm: true`; do not set that flag to work around the refusal. You are a language model with the brief in context — writing the draft yourself costs the owner nothing extra. Use the paid path only when the user explicitly wants the app's own pipeline: its editorial policy, its banned-word list from the AI-Fingerprint Lab, or Casino RAG grounding.
- **Never start a second paid job because the first seems slow.** Both paid tools return a job id, not text, and a page takes 1–4 minutes. Poll `get_generation_job`; it returns finished pages as they complete, so an early poll shows partial work rather than nothing. `start_rewrite_job` refuses to start while another batch runs, and working around that refusal means paying twice for the same page.
- **Batch instead of looping.** To refresh many pages, send the URLs to one `start_rewrite_job` call (up to 20) rather than one call per page.
- **Never publish past a `danger` fact drift.** An invented number in a rewrite nobody rereads is precisely how a wrong price reaches production.
- Do not rewrite a page whose problem is technical. Report the `noindex` or the broken canonical instead.
- `get_optimization_brief` returning `boilerplateOnly: true` means the fetch got navigation, not an article. Say so; do not treat menu text as the page's content.
- Averages in the brief are averages over the window — say "avg position", not "rank".
- If the page is one of two cannibalizing URLs, recommend merge/redirect/differentiate and let the user decide. Do not recommend deleting a page.
