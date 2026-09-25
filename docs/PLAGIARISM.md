# Plagiarism check + index estimation via `site:`

Two features, one mechanism: exact queries to a search engine through **any configured SERP
provider** (Serper / DataForSEO / ScrapingRobot / A-Parser — resolved by `getUserSerpCreds`
from `src/lib/rank.ts`). A-Parser is one of the options, not a requirement: its Google proxies
currently catch captchas, which is why the price is always shown before a run and a provider
failure is an error, never a quiet empty result.

Both features bill the user's own key one query at a time. That constraint is the design
(`docs/tasks/wave-nov/CONTRACT.md` §0.5):

- the sample is bounded (plagiarism: ≤ 10 fragments; `site:`: ≤ 200 URLs per call),
- the price is computed and shown **before** the run — `POST /api/seo/plagiarism/estimate`
  and `POST /api/indexing/serp-check` without `confirm` send **no** SERP query,
- nothing spends without an explicit confirm (`spend` capability on the routes,
  `confirm: true` on the MCP tools),
- units are reserved before the first query and the unspent part is released
  (`recordUsage` + `releaseUnusedUnits`, same ledger as the Ahrefs paths).

## A. Plagiarism — `/seo-tools/plagiarism`

Answers "where was this text copied from?" by searching the whole web for exact fragments.

Pipeline (`src/lib/plagiarism/`):

| step | file | what happens |
|---|---|---|
| normalize | `text.ts` | markdown stripped: meta block, headings, tables, code, images, link lists; prose only |
| sample | `sample.ts` | ≤ 10 sentences of 8–25 words, no digits (numbers/dates/prices), no keyword brand tokens, rarest per position bucket ("rare" = word length up, stop-word share down) |
| query | `index.ts` | each fragment → `"<sentence>"` quoted query, `num: 10`, 800 ms apart |
| match | `match.ts` | a result matches when its snippet covers ≥ 70 % of the fragment's words as 4-word shingle runs, **or** the same URL answers for ≥ 2 fragments (snippets truncate) |
| report | `index.ts` | share of matched fragments, sources (URL, fragment count), own-site matches marked and excluded from the score |

The result is **an estimate, not a verdict** — the UI says so next to the score. Quotes,
syndication and boilerplate light up here too.

Cache: `PlagiarismCheck` keyed by sha1 of the normalized text; a re-check of the same text
within **7 days** is free and instant (`queries: 0`, `costUsd: 0`, `cached: true`).

Provider-down: if every query fails, the run returns `provider_failed` with the provider's own
error text — an empty "100 % original" table would be the quiet lie this feature exists to
prevent.

### Routes

| route | access | what |
|---|---|---|
| `POST /api/seo/plagiarism/estimate` | `act` | fragments + provider + price. No SERP call. |
| `POST /api/seo/plagiarism` | `spend` | `confirm: true` runs; without it → 409 with the estimate attached |

### Pricing (`src/lib/plagiarism/price.ts`)

| provider | per query |
|---|---|
| serper | $0.0003 |
| dataforseo | $0.002 |
| scrapingrobot | $0.0009 |
| aparser | free — self-hosted, no per-request cost (`costUsd: null`, never `$0.00`) |
| (unknown) | `costUsd: null`, `unknownPrice: true` — shown as unknown, not as free |

Units: 1 unit = $0.001 (the same rate the demand routes use), recorded under the provider id.

### Where it is called from

- The page `/seo-tools/plagiarism`: paste text or pick a History record; `?history=<id>` loads
  the article directly. Price appears while typing; the run button is disabled until the
  estimate is in.
- History detail (`SeoTextDetail.tsx`) links here — inserted by R (wave integrator), see the
  N6 report for the exact spot.
- MCP: `check_plagiarism` (paid, `confirm`).

## B. Index via `site:` — `src/lib/indexing/serpIndex.ts`

URL Inspection (wave-oct T4) answers only for verified GSC properties. For drops, other
people's sites and PBN domains, `site:` is the reachable signal.

- Query: `site:host` for a homepage, `site:host/path` for a page.
- Verdict:
  - `indexed` — a result carries the same normalized URL (scheme, `www.`, trailing slash and
    tracking params ignored; real content params like `?page=2` kept);
  - `not_indexed` — the provider answered and the URL is not among the results (empty SERP is
    the common case; sibling pages under the same prefix without the exact URL count too);
  - `error` — captcha, auth, network. **A captcha is never "not indexed"** (the same rule SERP
    Monitor runs on).
- Verdicts persist into `SitemapUrl.serpIndexStatus / serpIndexChecked / serpIndexProvider`
  when the URL belongs to one of the workspace's sites; foreign URLs are checked and returned
  only.

### Route

`POST /api/indexing/serp-check { urls[] ≤ 200, confirm }` — `spend`. Without `confirm`: price
only, no query. With `confirm: true`: run + persist. `GET ?siteId=` feeds the panel's table.

### UI — `IndexAutoPanel` (site → Indexing)

A `site:` section with the button **"Check via site:"** and the price before the run (first
click prices, second runs), plus a table column **site:** with per-URL verdicts. The column is
labeled as *an estimate from search results, not Google's own verdict* — it never replaces the
Google Inspection columns next to it. The button targets the URLs Google's quota has not
inspected (the honest "unknown" set); with no Google connection at all, that is every URL.

## Tests

```
src/lib/plagiarism/text.test.ts     normalization, sentence split, offsets
src/lib/plagiarism/sample.test.ts   window 8–25, digits, brand tokens, ceiling 10, spread
src/lib/plagiarism/match.test.ts    shingle coverage, repeat-URL, own site ≠ plagiarism
src/lib/plagiarism/price.test.ts    price table, free ≠ $0.00, unknown ≠ free
src/lib/indexing/serpIndex.test.ts  site: query shape, URL normalization, verdicts incl. captcha ≠ not_indexed
```

All pure `node:test` — no database, no network.
