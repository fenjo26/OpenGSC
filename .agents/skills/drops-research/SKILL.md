---
name: drops-research
description: "Research expired/dropped domains through the OpenGSC MCP: import a list, run the free funnel (DNS pre-filter → registry check), enrich with DR/Wayback, and vet the shortlist with AI history verdicts before anyone spends money or units."
---

# OpenGSC Drops Research

## Goal

Turn a raw list of (possibly dropped) domains into a ranked, vetted shortlist: alive names retired for free, free names corroborated by two sources, link history attached, spam and burn-vetoes applied — ending in a buy/pass table a human can act on.

## Required inputs

- A domain list (pasted text, CSV, or a donor's refdomains). If none given, ask — the funnel is useless without candidates.

## OpenGSC MCP tools

- `drops_ingest`: import the list as a run. Rows are normalised (URLs/`www.` hosts/IPs handled, everything reduced to its registrable apex); the report says what was rejected and why.
- `drops_prefilter`: one bounded slice of DNS resolution. Retires every delegated (alive) domain for free — usually ~90% of the list. **Run this before anything else**; loop while `remaining > 0` and `done: false`.
- `drops_check`: one bounded slice of the registry stage (RDAP → WHOIS, throttled per zone, ~35s per call). Loop while `remaining > 0`. Rules baked into the verdicts: an RDAP 404 is only "free" when WHOIS agrees (`corroborated`), a refusal is never "taken", and zones with no public registry (`.gr` today) come back `uncheckable` — they need a registrar API and cannot be swept.
- `drops_enrich_wayback`: Wayback snapshots for ≤12 domains per call — months archived, first/last seen, days since death. Free.
- `drops_enrich_dr`: Ahrefs DR for ≤60 domains per call via the free public endpoint. Free (needs the free DR key configured). Attribution "Domain Rating by Ahrefs" is mandatory in anything you publish.
- `drops_enrich_refdomains`: **PAID** — Ahrefs refdomains/backlink counts (~100 units per domain). Needs `confirm: true`. Only for shortlisted rows, never for a whole list.
- `drops_history_ai`: **PAID** — the AI history pass for ≤5 hand-picked domains: three Wayback snapshots, the configured LLM decides clean / topic_shift / spam_period / unknown. Needs `confirm: true`.
- `drops_list`: the catalogue view — filters, sort, the score, and the funnel counts.

## Workflow

1. `drops_ingest` the list. Report the rejection reasons — a list that ingests 100% clean usually means the parser was tricked.
2. `drops_prefilter` until done. State the survival rate: from 50 000 rows expect a few thousand.
3. `drops_check` until done. Treat only `available` rows as candidates; `corroborated: false` means "probably free, needs a registrar look before buying". `uncheckable` rows are a registrar-API matter — do not retry them.
4. Enrich survivors: `drops_enrich_wayback` + `drops_enrich_dr` (free, go wide), then — with the user's explicit OK — `drops_enrich_refdomains` for the shortlist only.
5. Vet the finalists with `drops_history_ai`, five at a time. `spam_period` vetoes the row outright; `topic_shift` discounts the links but does not disqualify a donor-glue play.
6. `drops_list` sorted by score for the final table: domain, DR, refdomains, snapshots, verdict, score. Flag every veto explicitly.

## Judgment rules (from the report consensus, baked into the score)

- Score ≤ 0 rows with a named veto (`spam_history`, `idle_over_2y`) are pass — do not talk the user into them.
- DR is a contributor, not a target: a DR40 with a spam interlude loses to a DR15 with a clean, single-topic life.
- The score needs enrichment to mean anything — before step 4 it is mostly a domain-count proxy, and saying so honestly beats quoting it.

## Cost discipline

- DNS, registry checks, Wayback and free DR are free — run them freely.
- Refdomains bill Ahrefs units; the AI pass bills LLM credits. Both are gated behind `confirm: true` and both are meant for shortlists. If the user has not said "go", present the shortlist and ask.
