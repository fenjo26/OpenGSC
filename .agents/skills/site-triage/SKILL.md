---
name: site-triage
description: "Quick technical & indexing triage of a site via the OpenGSC MCP: health checks (SSL, Safe Browsing, Core Web Vitals), Google index coverage, and what to fix first."
---

# OpenGSC Site Triage

## Goal

A fast "is anything on fire?" pass over one site: security/health status, index coverage, and traffic sanity — ending in a short fix-first list. Ideal as the opening move before any deeper SEO work.

## Required inputs

- The site (domain). Call `list_sites` if unknown.

## OpenGSC MCP tools

- `get_alerts`: what the app's own hourly alert-cron already fired — rank drops, week-over-week click drops, SSL expiry, low audit scores. Deduplicated per occurrence, so it is an incident list rather than a notification stream. **Call this first:** it is the instance's own record of what went wrong and when.
- `get_site_health`: SSL expiry/grade, Google Safe Browsing verdict, VirusTotal reputation, Core Web Vitals (mobile).
- `get_indexing_status`: sitemap URL counts by Google index status + recent URL Inspection results.
- `get_site_audit`: the built-in crawler's latest run — health score and issue counts. Pass an `issue` code to list the affected URLs.
- `get_search_performance`: 28-day totals — a traffic collapse shows here first.
- `get_rank_tracker` / `get_rank_history`: tracked keywords trending down are an early warning; the history tells a one-off SERP wobble from a sustained slide.
- `get_clarity`: if configured, rage and dead clicks. A page that ranks well but frustrates visitors is a UX incident, not an SEO one.

## Workflow

1. `get_alerts` (30 days). Anything here already happened — start from the record rather than rediscovering it.
2. `get_site_health`. Escalate immediately: expiring/invalid SSL, any Safe Browsing threat, VirusTotal malicious flags. These outrank every SEO consideration.
3. `get_indexing_status`. Compare "not indexed"-type counts against the total; list concrete recently-inspected URLs that are excluded.
4. `get_site_audit`. A low health score with `noindex` or broken-link counts explains traffic loss that looks mysterious from GSC alone.
5. `get_search_performance` (28 days) — note totals and whether CTR/position look anomalous.
6. `get_rank_tracker` if available — flag keywords with position drops, then `get_rank_history` on the worst to confirm it is a trend.
7. Rank findings: security > deindexing > crawl/audit errors > vitals > ranking drift.

## Output format

Traffic-light summary (🔴 critical / 🟡 attention / 🟢 fine) per area — security, indexing, vitals, rankings — then a numbered fix-first list with the evidence for each item.

## Guardrails

- "No health data" means the check hasn't been run in OpenGSC — say so, don't guess.
- Sitemap URLs never inspected are unknown, not deindexed.
- Core Web Vitals here are mobile lab/field data as fetched by the app; do not present them as a full CWV audit.
